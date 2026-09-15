package ops

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// Every path, name and constant the bash helper hardcoded. Byte-compatible on
// purpose: the app reads none of the state files, but an upgrade can leave an
// old helper's files for a new helper's `down`, and vice versa.
const (
	// RunDir holds per-boot state; systemd owns it in daemon mode
	// (RuntimeDirectory=, preserved across restarts), the first one-shot verb
	// creates it otherwise.
	RunDir = "/run/katacomb-vpn"
	// PersistDir survives a reboot: only the resolv.conf backup lives here, so DNS
	// can be restored after a crash-while-connected.
	PersistDir = "/var/lib/katacomb-vpn"

	resolvConf = "/etc/resolv.conf"
	// Same filesystem as resolv.conf, so the final rename is atomic.
	resolvTmp = "/etc/.resolv.conf.sntl-tmp"

	wgIface   = "sntl0"
	tunIface  = "sntl-tun"
	ovpnIface = "sntl-ovpn"

	// tun2socks terminates TCP in a userspace netstack and advertises MSS = MTU-40;
	// 1400 keeps large TLS ClientHellos inside the proxy-wrapped path. Set at
	// startup because the netstack caches it at creation.
	tunMTU  = "1400"
	tunAddr = "198.18.0.1/15"

	wgConfName          = "sntl0.conf"
	ovpnConfName        = "openvpn.conf"
	tunStateName        = "tun.state"
	awgStateName        = "awg.state" // the embedded AmneziaWG device's pid, for awg-down
	ovpnPidName         = "openvpn.pid"
	ovpnLogName         = "openvpn.log"
	killswitchStateName = "killswitch.state"
	lockName            = ".lock"
)

func (e *Env) path(p string) string        { return filepath.Join(e.Root, p) }
func (e *Env) runPath(name string) string  { return e.path(filepath.Join(RunDir, name)) }
func (e *Env) persistPath(n string) string { return e.path(filepath.Join(PersistDir, n)) }

// ensureDir is the bash ensure_run_dir / ensure_persist_dir: create 0700 when
// absent, leave an existing directory (systemd's 0755 RunDir) alone.
func ensureDir(dir string) error {
	if _, err := os.Stat(dir); err == nil {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.Chmod(dir, 0o700)
}

func ensureRunDir(e *Env) error     { return ensureDir(e.path(RunDir)) }
func ensurePersistDir(e *Env) error { return ensureDir(e.path(PersistDir)) }

// writeConfig puts an already-validated config at RunDir/<name>, 0600, and
// returns the path the tool is handed. Both modes converge here (deviation 6):
// the daemon never sees a client path, and the one-shot hands wg-quick our copy
// of the bytes it validated, not the caller's file.
func writeConfig(e *Env, name string, content []byte) (string, error) {
	if err := ensureRunDir(e); err != nil {
		return "", err
	}
	p := e.runPath(name)
	if err := os.WriteFile(p, content, 0o600); err != nil {
		return "", err
	}
	if err := os.Chmod(p, 0o600); err != nil {
		return "", err
	}
	return p, nil
}

// writeState writes a state file 0600 (the bash `echo … > f; chmod 600 f`).
func writeState(e *Env, name, content string) error {
	if err := ensureRunDir(e); err != nil {
		return err
	}
	p := e.runPath(name)
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Chmod(p, 0o600)
}

func removeQuiet(p string) { _ = os.Remove(p) }

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// lexists is bash's `-e f || -L f`: true for a dangling symlink too.
func lexists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// linkExists reads the kernel's view directly (deviation 10): the same "does the
// interface exist" answer `ip link show` gives, without a spawn per poll.
func linkExists(e *Env, iface string) bool {
	return lexists(e.path(filepath.Join("/sys/class/net", iface)))
}

// withLock serialises state-changing verbs across BOTH modes (deviation 8): the
// daemon's in-process mutex cannot see a one-shot invocation (postrm's teardown,
// or a pkexec fallback racing a daemon op after a stale-socket ECONNREFUSED).
// Bounded by ctx, so a stuck holder surfaces as an error, not a hang. The lock
// fd is CLOEXEC, so a resident child (openvpn, tun2socks) never inherits it.
func withLock(ctx context.Context, e *Env, fn func() error) error {
	if err := ensureRunDir(e); err != nil {
		return err
	}
	f, err := os.OpenFile(e.runPath(lockName), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("lock: %w", err)
	}
	defer f.Close()
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if err != syscall.EWOULDBLOCK {
			return fmt.Errorf("lock: %w", err)
		}
		select {
		case <-ctx.Done():
			return errors.New("another privileged operation is still running")
		case <-time.After(50 * time.Millisecond):
		}
	}
	defer func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }()
	return fn()
}
