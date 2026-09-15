// Package server is daemon mode: the AF_UNIX listener at
// /run/katacomb-vpn/daemon.sock, one goroutine per connection, protocol v1
// framing, and one mutex that serialises every state-changing op (status and
// protocol_version run concurrently). systemd runs it as root
// (`katacomb-vpn-helper daemon`); the app talks to it over the socket so
// connect/disconnect never prompt for a password.
package server

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/protocol"
)

const (
	// SocketPath is fixed by the client (daemon-client.ts DAEMON_SOCKET_PATH).
	SocketPath = ops.RunDir + "/daemon.sock"
	// SocketGroup: only its members may drive the socket (mode 0660). The deb's
	// postinstall creates it and adds the installing user.
	SocketGroup = "katacomb-vpn"
)

// Server serves protocol v1 for one Env.
type Server struct {
	env  *ops.Env
	logf func(format string, args ...any)
	mu   sync.Mutex
}

// New builds a server; logf receives every line the daemon logs.
func New(e *ops.Env, logf func(format string, args ...any)) *Server {
	return &Server{env: e, logf: logf}
}

func logStderr(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[katacomb-daemon] "+format+"\n", args...)
}

// Run is the `daemon` entry: refuses to run unprivileged (deviation 1: an
// unprivileged daemon used to bind a 0666 socket and then fail every op),
// binds the socket under umask 077 (deviation 2: no window at the default mode
// between listen and chmod), sets the group permissions, serves until SIGTERM/
// SIGINT, and unlinks the socket on the way out.
func Run(e *ops.Env) int {
	if os.Geteuid() != 0 {
		logStderr("daemon mode requires root (euid 0); refusing to start")
		return 1
	}
	e.Warn = func(msg string) { logStderr("warning: %s", msg) }
	s := New(e, logStderr)

	if err := os.MkdirAll(ops.RunDir, 0o755); err != nil {
		logStderr("cannot create %s: %v", ops.RunDir, err)
		return 1
	}
	_ = os.Remove(SocketPath) // stale socket from a previous instance
	old := syscall.Umask(0o077)
	ln, err := net.Listen("unix", SocketPath)
	syscall.Umask(old)
	if err != nil {
		logStderr("cannot listen on %s: %v", SocketPath, err)
		return 1
	}
	s.securePermissions(SocketPath, 0)
	logStderr("listening on %s (protocol v%d)", SocketPath, protocol.Version)

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigs
		ln.Close()
		_ = os.Remove(SocketPath)
		os.Exit(0)
	}()
	s.Serve(ln)
	_ = os.Remove(SocketPath)
	return 0
}

// lookupGid resolves the group through `getent` (NSS-aware), not os/user, which
// is pure-Go parsing of /etc/group in a static binary.
func (s *Server) lookupGid(group string) (int, bool) {
	getent, err := s.env.LookPath("getent")
	if err != nil {
		return 0, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), ops.OpTimeout)
	defer cancel()
	out, _, err := s.env.Run(ctx, []string{getent, "group", group}, ops.RunOpt{})
	if err != nil {
		return 0, false
	}
	f := strings.Split(strings.TrimSpace(string(out)), ":") // name:x:gid:members
	if len(f) < 3 {
		return 0, false
	}
	gid, err := strconv.Atoi(f[2])
	if err != nil {
		return 0, false
	}
	return gid, true
}

// securePermissions locks the socket to uid:SocketGroup 0660 when the group
// exists, else falls back to 0666 (dev / unpackaged, where the group is absent
// and the app uses pkexec anyway) with the same log line the old daemon wrote.
func (s *Server) securePermissions(path string, uid int) {
	if gid, ok := s.lookupGid(SocketGroup); ok {
		if err := os.Chown(path, uid, gid); err == nil {
			if err := os.Chmod(path, 0o660); err == nil {
				return
			}
		} else {
			s.logf("could not group-restrict socket, falling back to 0666: %v", err)
		}
	}
	_ = os.Chmod(path, 0o666)
}

// Serve accepts connections until the listener closes.
func (s *Server) Serve(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			s.logf("accept: %v", err)
			continue
		}
		go s.handle(conn)
	}
}

// handle runs the per-connection loop. The server never closes a connection on
// its own except on a framing overflow (no reply, as before); pipelined
// requests are answered in order.
func (s *Server) handle(conn net.Conn) {
	defer conn.Close()
	rd := protocol.NewReader(conn)
	write := func(res protocol.Response) bool {
		_, err := conn.Write(append(res.Encode(), '\n'))
		return err == nil
	}
	for {
		line, err := rd.ReadLine()
		if err != nil {
			return // EOF, transport error, or the 256 KiB cap: drop silently
		}
		req, perr := protocol.ParseRequest(line)
		if perr != nil {
			if protocol.IsBlank(perr) {
				continue
			}
			if !write(protocol.Response{ID: 0, OK: false, Error: perr.Error()}) {
				return
			}
			continue
		}
		res := s.serve(req)
		if !res.OK {
			// Never the config body: the error strings carry line numbers and
			// reasons, and the log is the journal.
			s.logf("op %s rejected: %s", req.Op, res.Error)
		}
		if !write(res) {
			return
		}
	}
}

// lockedOp reports whether an op changes state and must therefore serialise on
// the server mutex. Only the two read-only ops are exempt. Named rather than
// inlined so corpus_test.go can pin it against the shared protocol corpus, which
// is also what tells the TypeScript side which ops are safe to issue concurrently.
func lockedOp(op string) bool {
	switch op {
	case "status", "protocol_version", "xfrm_policies":
		return false
	}
	return true
}

// serve applies the mutex (read-only ops exempt) and the per-op budget.
func (s *Server) serve(req protocol.Request) protocol.Response {
	if lockedOp(req.Op) {
		s.mu.Lock()
		defer s.mu.Unlock()
	}
	ctx, cancel := context.WithTimeout(context.Background(), ops.OpTimeout)
	defer cancel()
	return Dispatch(ctx, req, s.env)
}
