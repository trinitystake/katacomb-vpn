package ops

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"katacomb.vpn/daemon/internal/guard"
)

// TunUpParams is `tun-up <bin> <socks> <remote> <gw> <if> [bypass…]`. The
// `<bin>` slot is accepted and IGNORED: the tun2socks engine is compiled into
// this helper (internal/tun2socks) and tun-up self-execs it, so root never runs
// a binary it was handed. The slot stays so old and new apps share one argv
// contract (the new app passes `-`).
type TunUpParams struct {
	SocksAddr  string
	RemoteHost string
	Gateway    string
	Iface      string
	// BypassRoutes are split-tunnel CIDRs, passed through RAW. Filtering happens
	// in TunUp, which is the trust boundary: both doors reach it, and a caller's
	// own filtering is never the one that counts.
	BypassRoutes []string
}

// MaxBypassRoutes bounds the split-tunnel list. Each entry becomes an `ip route
// add` as root, and the list was previously unbounded — a caller could make the
// helper issue arbitrarily many. The app's own UI cannot produce anything near
// this many, so exceeding it means a bug or a hostile caller, and refusing says
// so rather than working slowly and silently.
const MaxBypassRoutes = 64

const (
	tunPollTries    = 50
	tunPollInterval = 100 * time.Millisecond
)

// selfExecutable is this helper's path, which tun-up execs as `_tun2socks`. If
// the binary was replaced underneath a running daemon (an upgrade), /proc/self/exe
// reads `… (deleted)`: the file at the plain path is the new helper, which has the
// same sub-mode, so use that.
func selfExecutable(e *Env) (string, error) {
	p, err := e.Executable()
	if err != nil {
		return "", fmt.Errorf("cannot locate the helper executable: %v", err)
	}
	return strings.TrimSuffix(p, " (deleted)"), nil
}

// TunUp spawns the embedded tun2socks detached (`<self> _tun2socks …`) and
// installs the routing around it: a /32 to the node via the real gateway (so the
// proxy's own traffic bypasses the tunnel), the two /1 halves (more specific
// than the default route, so everything else enters the TUN), then the bypass
// routes. Returns the engine's pid, which is also recorded in tun.state for
// TunDown.
func TunUp(ctx context.Context, e *Env, p TunUpParams) (int, error) {
	if !guard.IsValidSocksAddr(p.SocksAddr) {
		return 0, fmt.Errorf("invalid SOCKS address: %s", p.SocksAddr)
	}
	if !guard.IsIPv4(p.RemoteHost) {
		return 0, fmt.Errorf("invalid IPv4 address: %s", p.RemoteHost)
	}
	if !guard.IsIPv4(p.Gateway) {
		return 0, fmt.Errorf("invalid IPv4 address: %s", p.Gateway)
	}
	if !guard.IsValidInterfaceName(p.Iface) {
		return 0, fmt.Errorf("invalid interface name: %s", p.Iface)
	}
	self, err := selfExecutable(e)
	if err != nil {
		return 0, err
	}
	if len(p.BypassRoutes) > MaxBypassRoutes {
		return 0, fmt.Errorf("too many bypass routes: %d, max %d", len(p.BypassRoutes), MaxBypassRoutes)
	}
	var bypass []string
	var dropped int
	for _, r := range p.BypassRoutes {
		if guard.IsAllowedBypassCidr(r) {
			bypass = append(bypass, strings.TrimSpace(r))
		} else {
			dropped++
		}
	}
	// Report the COUNT, never the entries: these are caller-supplied strings and
	// the guard's own rule is that a refusal names a reason, not content. Silently
	// dropping them was the old behaviour and it made a half-applied split tunnel
	// indistinguishable from a working one.
	if dropped > 0 {
		e.Warn(fmt.Sprintf("tun-up: ignored %d invalid bypass route(s) of %d", dropped, len(p.BypassRoutes)))
	}

	var pid int
	err = withLock(ctx, e, func() error {
		ip, err := tool(e, "ip")
		if err != nil {
			return err
		}
		// Clean up any previous state.
		runQuiet(ctx, e, ip, "link", "delete", tunIface)

		// The engine hardcodes device/mtu/loglevel; they ride on the argv so the
		// process reads sensibly in `ps` and the pid-less fallback below can key
		// on the `tun://sntl-tun` entry. -proxy is the one value it reads.
		var spawnErr error
		pid, spawnErr = e.Spawn([]string{self, "_tun2socks",
			"-device", "tun://" + tunIface,
			"-proxy", "socks5://" + p.SocksAddr,
			"-mtu", tunMTU, "-loglevel", "silent"}, RunOpt{})
		if spawnErr != nil {
			return fmt.Errorf("could not start tun2socks: %v", spawnErr)
		}

		for i := 0; i < tunPollTries && !linkExists(e, tunIface); i++ {
			e.Sleep(tunPollInterval)
		}
		if !linkExists(e, tunIface) {
			_ = e.Kill(pid, syscall.SIGTERM)
			return fmt.Errorf("TUN interface did not appear")
		}

		// Direct route for the node via the real gateway (bypasses the tunnel).
		runQuiet(ctx, e, ip, "route", "add", p.RemoteHost+"/32", "via", p.Gateway, "dev", p.Iface)
		runQuiet(ctx, e, ip, "addr", "add", tunAddr, "dev", tunIface)
		if err := run(ctx, e, RunOpt{}, ip, "link", "set", tunIface, "up"); err != nil {
			return err
		}
		// Split-route: two half-ranges more specific than the default route.
		if err := run(ctx, e, RunOpt{}, ip, "route", "add", "0.0.0.0/1", "dev", tunIface); err != nil {
			return err
		}
		if err := run(ctx, e, RunOpt{}, ip, "route", "add", "128.0.0.0/1", "dev", tunIface); err != nil {
			return err
		}
		for _, cidr := range bypass {
			runQuiet(ctx, e, ip, "route", "add", cidr, "via", p.Gateway, "dev", p.Iface)
		}
		return writeState(e, tunStateName, fmt.Sprintf("%d %s %s\n", pid, p.RemoteHost, strings.Join(bypass, ",")))
	})
	return pid, err
}

// The bash tun-down's own (looser) CIDR shape for the routes it removes; the
// state file is root-owned, so this is parsing, not validation.
var reLooseCidr = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$`)

// TunDown kills tun2socks (pid from tun.state), removes the routes and the TUN.
func TunDown(ctx context.Context, e *Env) error {
	return withLock(ctx, e, func() error {
		ip, err := tool(e, "ip")
		if err != nil {
			return err
		}
		remote := ""
		var bypass []string
		state := e.runPath(tunStateName)
		if b, err := os.ReadFile(state); err == nil {
			// `read -r PID HOST BYPASS`: whitespace-split, the last var takes the rest.
			f := strings.Fields(strings.SplitN(string(b), "\n", 2)[0])
			if len(f) >= 1 {
				if pid, err := strconv.Atoi(f[0]); err == nil && pid > 0 {
					_ = e.Kill(pid, syscall.SIGTERM)
				}
			}
			if len(f) >= 2 {
				remote = f[1]
			}
			if len(f) >= 3 {
				bypass = strings.Split(strings.Join(f[2:], " "), ",")
			}
			removeQuiet(state)
		} else {
			reapStrayTun2socks(e)
		}

		runQuiet(ctx, e, ip, "route", "del", "0.0.0.0/1", "dev", tunIface)
		runQuiet(ctx, e, ip, "route", "del", "128.0.0.0/1", "dev", tunIface)
		runQuiet(ctx, e, ip, "link", "delete", tunIface)
		if remote != "" {
			runQuiet(ctx, e, ip, "route", "del", remote+"/32")
		}
		for _, cidr := range bypass {
			cidr = strings.Join(strings.Fields(cidr), "")
			if reLooseCidr.MatchString(cidr) {
				runQuiet(ctx, e, ip, "route", "del", cidr)
			}
		}
		return nil
	})
}

// reapStrayTun2socks is the pid-less fallback when tun.state is gone (a crash, or
// an upgrade that wiped /run). The bash helper did `pkill -f tun://sntl-tun`, a
// match on process NAME that CLAUDE.md forbids everywhere else. Deviation 4: a
// process is signalled only if its executable IS this helper, its argv[1] is
// `_tun2socks` and its argv carries `tun://sntl-tun` as a WHOLE entry, so an
// unrelated process that merely mentions the string in an argument is never
// touched.
func reapStrayTun2socks(e *Env) {
	self, err := selfExecutable(e)
	if err != nil {
		return
	}
	entries, err := os.ReadDir(e.path("/proc"))
	if err != nil {
		return
	}
	for _, d := range entries {
		pid, err := strconv.Atoi(d.Name())
		if err != nil || pid <= 0 {
			continue
		}
		argv := procArgv(e, pid)
		if len(argv) < 2 || argv[1] != "_tun2socks" || !argvHas(argv, "tun://"+tunIface) {
			continue
		}
		exe, err := os.Readlink(e.path(fmt.Sprintf("/proc/%d/exe", pid)))
		if err != nil || strings.TrimSuffix(exe, " (deleted)") != self {
			continue
		}
		_ = e.Kill(pid, syscall.SIGTERM)
	}
}

// procArgv reads /proc/<pid>/cmdline as its NUL-separated argv.
func procArgv(e *Env, pid int) []string {
	b, err := os.ReadFile(e.path(fmt.Sprintf("/proc/%d/cmdline", pid)))
	if err != nil || len(b) == 0 {
		return nil
	}
	return strings.Split(strings.TrimRight(string(b), "\x00"), "\x00")
}

func argvHas(argv []string, entry string) bool {
	for _, a := range argv {
		if a == entry {
			return true
		}
	}
	return false
}
