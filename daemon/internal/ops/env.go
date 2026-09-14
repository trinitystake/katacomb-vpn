// Package ops implements the twelve privileged verbs natively. It is THE trust
// boundary of the helper: both entry modes (the daemon socket and the pkexec
// one-shot) end here, and every argument is validated here regardless of which
// door it came through, because neither door authenticates the caller as this app.
//
// Each verb is a line-for-line port of the bash helper it replaced
// (resources/linux/privileged/katacomb-vpn-helper.sh, in git history). The exact
// external command lines — iptables rule order, tun2socks routes, openvpn's argv
// after --config, cleanup_wg_rules' scoping — are pinned by
// testdata/transcripts/, captured from the bash helper by
// scripts/capture-helper-transcripts.sh and replayed by transcript_test.go.
//
// Everything that touches the outside world goes through Env, the one seam, so
// the verbs are unit-testable against a recording Env with a temp Root.
package ops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	// ChildPath is the ONLY PATH a child process ever sees (deviation 7): never the
	// caller's, since the caller is a pkexec'd user or an unauthenticated socket.
	ChildPath = "/usr/sbin:/usr/bin:/sbin:/bin"
	// DebBinDir is where the deb installs the SHA-pinned bundled binaries. The
	// daemon only exists on the deb, so daemon mode hardcodes it; one-shot callers
	// pass their own (and the pins are checked either way).
	DebBinDir = "/opt/Katacomb VPN/resources/linux/bin"
	// OpTimeout bounds one verb: the budget the client's request timer and the old
	// daemon's execFileSync both used.
	OpTimeout = 60 * time.Second
)

// RunOpt carries the per-command options a verb can set.
type RunOpt struct {
	// PathPrefix is prepended to ChildPath. awg-up sets it to the verified bindir
	// so awg-quick's bare-name calls to `awg` and `amneziawg-go` find the pinned
	// trio and nothing else.
	PathPrefix string
}

// ExitError is a tool that ran and failed. Error() folds its stderr in VERBATIM:
// the app matches `/resolvconf/i` on the message to offer the DNS-less retry.
type ExitError struct {
	Argv   []string
	Code   int
	Stderr string
}

func (e *ExitError) Error() string {
	name := filepath.Base(e.Argv[0])
	s := strings.TrimSpace(e.Stderr)
	if s == "" {
		return fmt.Sprintf("%s exited with status %d", name, e.Code)
	}
	return fmt.Sprintf("%s: %s", name, s)
}

// Env is the one seam between the verbs and the machine. Production uses
// RealEnv(); tests substitute recorders and a temp Root.
type Env struct {
	// Run executes argv in the foreground under ctx (SIGTERM on cancel) and
	// returns its stdout, stderr and an *ExitError on non-zero exit.
	Run func(ctx context.Context, argv []string, opt RunOpt) (stdout, stderr []byte, err error)
	// Spawn starts argv detached (own session, /dev/null stdio) and returns its pid.
	Spawn func(argv []string, opt RunOpt) (pid int, err error)
	// Kill sends sig to pid (sig 0 probes existence).
	Kill func(pid int, sig syscall.Signal) error
	// Sleep pauses between poll iterations.
	Sleep func(d time.Duration)
	// Root prefixes every absolute path the verbs touch (/run, /var/lib, /etc,
	// /sys, /proc, the openvpn allow-list). "" in production; a temp dir in tests.
	Root string
	// BinDir is where daemon mode finds the pinned bundled binaries (DebBinDir).
	BinDir string
	// LookPath resolves a tool name against ChildPath, never the caller's PATH.
	LookPath func(name string) (string, error)
	// VerifyPin checks a file's SHA-256 against pins.go; fails closed on unknown names.
	VerifyPin func(path, name string) error
	// Executable is this helper's own path (os.Executable): tun-up self-execs it
	// as `_tun2socks`, and the pid-less tun-down fallback matches against it.
	Executable func() (string, error)
	// Warn reports a non-fatal condition (the daemon's log, or stderr one-shot).
	Warn func(msg string)
}

// RealEnv is the production seam.
func RealEnv() *Env {
	return &Env{
		Run:       realRun,
		Spawn:     realSpawn,
		Kill:      syscall.Kill,
		Sleep:     time.Sleep,
		Root:      "",
		BinDir:    DebBinDir,
		LookPath:  lookPathFixed,
		VerifyPin:  VerifyPin,
		Executable: os.Executable,
		Warn:       func(msg string) { fmt.Fprintf(os.Stderr, "Warning: %s\n", msg) },
	}
}

func childEnv(opt RunOpt) []string {
	path := ChildPath
	if opt.PathPrefix != "" {
		path = opt.PathPrefix + ":" + path
	}
	return []string{"PATH=" + path, "HOME=/root"}
}

// realRun: foreground, bounded by ctx. On cancel the child gets SIGTERM (what
// execFileSync's timeout sent), and WaitDelay bounds the wait for a child that
// daemonised and left the pipes open (openvpn --daemon closes them itself; this
// is the belt to that brace).
func realRun(ctx context.Context, argv []string, opt RunOpt) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = childEnv(opt)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	if err == nil {
		return stdout.Bytes(), stderr.Bytes(), nil
	}
	if ctx.Err() != nil {
		return stdout.Bytes(), stderr.Bytes(), fmt.Errorf("%s timed out after %s", filepath.Base(argv[0]), OpTimeout)
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return stdout.Bytes(), stderr.Bytes(), &ExitError{Argv: argv, Code: ee.ExitCode(), Stderr: stderr.String()}
	}
	return stdout.Bytes(), stderr.Bytes(), fmt.Errorf("%s: %w", filepath.Base(argv[0]), err)
}

// realSpawn: detached (own session, /dev/null stdio), and REAPED by a goroutine
// (deviation 9): a long-lived Go daemon that never Waits collects zombies; the
// bash helper never lived long enough to.
func realSpawn(argv []string, opt RunOpt) (int, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = childEnv(opt)
	devnull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return 0, err
	}
	defer devnull.Close()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = devnull, devnull, devnull
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	go func() { _ = cmd.Wait() }()
	return cmd.Process.Pid, nil
}

// lookPathFixed resolves against ChildPath only.
func lookPathFixed(name string) (string, error) {
	for _, dir := range strings.Split(ChildPath, ":") {
		p := filepath.Join(dir, name)
		if isExecutableFile(p) {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s not found in %s", name, ChildPath)
}

func isExecutableFile(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular() && fi.Mode()&0o111 != 0
}

// --- small helpers the verbs share ---------------------------------------------

// run executes and returns the failure (an *ExitError carries the tool's stderr).
func run(ctx context.Context, e *Env, opt RunOpt, argv ...string) error {
	_, _, err := e.Run(ctx, argv, opt)
	return err
}

// runQuiet is bash's `cmd 2>/dev/null || true`.
func runQuiet(ctx context.Context, e *Env, argv ...string) {
	_, _, _ = e.Run(ctx, argv, RunOpt{})
}

// output returns stdout ("" on any failure, like `$(cmd 2>/dev/null)`).
func output(ctx context.Context, e *Env, argv ...string) string {
	out, _, err := e.Run(ctx, argv, RunOpt{})
	if err != nil {
		return ""
	}
	return string(out)
}

// tool resolves a name via the fixed PATH and turns "not there" into the verb's error.
func tool(e *Env, name string) (string, error) {
	p, err := e.LookPath(name)
	if err != nil {
		return "", fmt.Errorf("%s is not installed", name)
	}
	return p, nil
}
