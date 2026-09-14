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

// TunUpParams is `tun-up <bin> <socks> <remote> <gw> <if> [bypass…]`.
type TunUpParams struct {
	// Bin is the tun2socks executable; it must hash to the compiled-in pin in
	// BOTH modes (deviation 5), so a polkit-authenticated caller cannot make root
	// run an arbitrary binary through this verb.
	Bin        string
	SocksAddr  string
	RemoteHost string
	Gateway    string
	Iface      string
	// BypassRoutes are split-tunnel CIDRs; invalid entries are dropped silently
	// (the daemon always did; the app sanitises before sending).
	BypassRoutes []string
}

const (
	tunPollTries    = 50
	tunPollInterval = 100 * time.Millisecond
)

// TunUp spawns tun2socks detached and installs the routing around it: a /32 to
// the node via the real gateway (so the proxy's own traffic bypasses the tunnel),
// the two /1 halves (more specific than the default route, so everything else
// enters the TUN), then the bypass routes. Returns tun2socks' pid, which is also
// recorded in tun.state for TunDown.
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
	if !isExecutableFile(p.Bin) {
		return 0, fmt.Errorf("tun2socks binary not found or not executable: %s", p.Bin)
	}
	if err := e.VerifyPin(p.Bin, "tun2socks"); err != nil {
		return 0, err
	}
	var bypass []string
	for _, r := range p.BypassRoutes {
		if guard.IsAllowedBypassCidr(r) {
			bypass = append(bypass, strings.TrimSpace(r))
		}
	}

	var pid int
	err := withLock(ctx, e, func() error {
		ip, err := tool(e, "ip")
		if err != nil {
			return err
		}
		// Clean up any previous state.
		runQuiet(ctx, e, ip, "link", "delete", tunIface)

		// -mtu is set at startup so the netstack advertises a proxy-safe MSS.
		var spawnErr error
		pid, spawnErr = e.Spawn([]string{p.Bin,
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
// process is signalled only if its argv carries `tun://sntl-tun` as a WHOLE entry
// AND its executable hashes to the tun2socks pin, so an unrelated process that
// merely mentions the string in an argument is never touched.
func reapStrayTun2socks(e *Env) {
	entries, err := os.ReadDir(e.path("/proc"))
	if err != nil {
		return
	}
	for _, d := range entries {
		pid, err := strconv.Atoi(d.Name())
		if err != nil || pid <= 0 {
			continue
		}
		if !procArgvHas(e, pid, "tun://"+tunIface) {
			continue
		}
		if e.VerifyPin(e.path(fmt.Sprintf("/proc/%d/exe", pid)), "tun2socks") != nil {
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

func procArgvHas(e *Env, pid int, entry string) bool {
	for _, a := range procArgv(e, pid) {
		if a == entry {
			return true
		}
	}
	return false
}
