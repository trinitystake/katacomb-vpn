package ops

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"katacomb.vpn/daemon/internal/guard"
)

// openvpn is a distro package (its OpenSSL gets security updates), resolved from
// an absolute allow-list — never $PATH under root, never a caller-supplied path.
var openvpnCandidates = []string{"/usr/sbin/openvpn", "/sbin/openvpn", "/usr/bin/openvpn"}

func resolveOpenVpn(e *Env) (string, error) {
	for _, c := range openvpnCandidates {
		if isExecutableFile(e.path(c)) {
			return e.path(c), nil
		}
	}
	return "", errors.New("openvpn is not installed")
}

var reDigits = regexp.MustCompile(`^[0-9]+$`)

// readPid returns the numeric pid in a pidfile, or 0.
func readPid(p string) int {
	b, err := os.ReadFile(p)
	if err != nil {
		return 0
	}
	s := strings.TrimSpace(string(b))
	if !reDigits.MatchString(s) {
		return 0
	}
	n, _ := strconv.Atoi(s)
	return n
}

const (
	ovpnPollTries    = 125 // 25 s ≈ two connect attempts, inside the 60 s op budget
	ovpnPollInterval = 200 * time.Millisecond
	ovpnKillTries    = 25
)

// OpenVpnUp validates the config, writes it to RunDir/openvpn.conf and daemonises
// openvpn on it. Every security-critical and operational flag is passed HERE,
// after --config, so it wins (openvpn is last-one-wins) and can never come from a
// node: --script-security 0 (no --up/--down/--plugin can execute, ever),
// --dev/--dev-type (the interface the kill switch and stats expect), --connect-*
// (bounded bring-up). openvpn stays resident, so this then waits for proof: the
// interface present AND "Initialization Sequence Completed" in the log.
func OpenVpnUp(ctx context.Context, e *Env, config []byte) error {
	if err := guard.AssertOpenVpnConfig(config); err != nil {
		return err
	}
	bin, err := resolveOpenVpn(e)
	if err != nil {
		return err
	}
	return withLock(ctx, e, func() error {
		ip, err := tool(e, "ip")
		if err != nil {
			return err
		}
		if err := ensureRunDir(e); err != nil {
			return err
		}
		pidFile, logFile := e.runPath(ovpnPidName), e.runPath(ovpnLogName)
		// Clean up any previous tunnel/state so a stale pid can't be killed later.
		if fileExists(pidFile) {
			if old := readPid(pidFile); old > 0 {
				_ = e.Kill(old, syscall.SIGTERM)
			}
			removeQuiet(pidFile)
		}
		runQuiet(ctx, e, ip, "link", "delete", ovpnIface)
		removeQuiet(logFile)

		path, err := writeConfig(e, ovpnConfName, config)
		if err != nil {
			return err
		}
		if err := run(ctx, e, RunOpt{}, bin, "--config", path,
			"--dev", ovpnIface, "--dev-type", "tun",
			"--script-security", "0",
			"--connect-timeout", "10", "--connect-retry-max", "2",
			"--verb", "3", "--log", logFile,
			"--writepid", pidFile, "--daemon", "katacomb-ovpn"); err != nil {
			return err
		}
		_ = os.Chmod(logFile, 0o600)

		ready := false
		for i := 0; i < ovpnPollTries; i++ {
			if linkExists(e, ovpnIface) && logContains(logFile, "Initialization Sequence Completed") {
				ready = true
				break
			}
			e.Sleep(ovpnPollInterval)
		}
		if ready {
			return nil
		}
		if pid := readPid(pidFile); pid > 0 {
			_ = e.Kill(pid, syscall.SIGTERM)
		}
		runQuiet(ctx, e, ip, "link", "delete", ovpnIface)
		removeQuiet(pidFile)
		// Surface the real reason (auth failure, TLS error, unreachable node) instead
		// of a bare timeout — this text reaches the connect modal.
		return fmt.Errorf("OpenVPN did not come up: %s", logTail(logFile, 5))
	})
}

func logContains(p, needle string) bool {
	b, err := os.ReadFile(p)
	return err == nil && strings.Contains(string(b), needle)
}

// logTail is `tail -n N f | tr '\n' ' '`: the last N lines, each followed by a space.
func logTail(p string, n int) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	var sb strings.Builder
	for _, l := range lines {
		sb.WriteString(l)
		sb.WriteByte(' ')
	}
	return sb.String()
}

// OpenVpnDown signals the pid in the pidfile, gives openvpn 5 s to remove its own
// routes and interface, then SIGKILLs and deletes the link belt-and-braces. The
// config embeds the client private key, so it goes too.
func OpenVpnDown(ctx context.Context, e *Env) error {
	return withLock(ctx, e, func() error {
		ip, err := tool(e, "ip")
		if err != nil {
			return err
		}
		pidFile := e.runPath(ovpnPidName)
		if fileExists(pidFile) {
			if pid := readPid(pidFile); pid > 0 {
				_ = e.Kill(pid, syscall.SIGTERM)
				for i := 0; i < ovpnKillTries; i++ {
					if e.Kill(pid, 0) != nil {
						break
					}
					e.Sleep(ovpnPollInterval)
				}
				_ = e.Kill(pid, syscall.SIGKILL)
			}
			removeQuiet(pidFile)
		}
		runQuiet(ctx, e, ip, "link", "delete", ovpnIface)
		removeQuiet(e.runPath(ovpnLogName))
		removeQuiet(e.runPath(ovpnConfName))
		return nil
	})
}
