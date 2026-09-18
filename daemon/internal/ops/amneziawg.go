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

	"katacomb.vpn/daemon/internal/amneziawg"
	"katacomb.vpn/daemon/internal/guard"
)

// awgFwmark is the table AND fwmark the embedded device marks its UDP socket with
// (set in the engine's IpcSet, see internal/amneziawg). 51820 is the first table
// wg-quick(8) tries and the bottom of the range cleanupWgRules already owns, so a
// leaked table is still ours to remove. amneziawg.Fwmark must equal wgTableMin.
var awgFwmark = strconv.Itoa(amneziawg.Fwmark)

func init() {
	if amneziawg.Fwmark != wgTableMin {
		panic("amneziawg.Fwmark must equal wgTableMin")
	}
}

// AmneziaWgUp brings up an AmneziaWG tunnel WITHOUT the vendored trio: the device
// is compiled into this helper and self-exec'd (`<self> _amneziawg <config>`), and
// the addressing/MTU/DNS/routing that awg-quick(8) did around it is reimplemented
// here from wg-quick(8) and the WireGuard cross-platform UAPI spec — a behavioural
// reimplementation, never a port of GPL-2.0 amneziawg-tools.
//
// The `binDir` argument is ACCEPTED AND IGNORED (the tun-up `<bin>` precedent): the
// three binaries are gone, and the slot stays only so old and new apps share one
// argv contract for a release. There is no bindir to verify and no pins to check;
// the config is the only untrusted input and guard.AssertAmneziaWgConfig is still
// the trust boundary.
//
// Deviations from awg-quick, each deliberate: the kernel `amneziawg` module is never
// tried (the userspace device is the only path the app has ever used); the fwmark is
// set once by the engine, not by a post-up `awg set`, so no UAPI socket is opened;
// the anti-spoof nft/iptables firewall is NOT installed (our tun2socks path never had
// one either, and reproducing amneziawg-tools' ruleset text would cross the licence
// line — the load-bearing `src_valid_mark=1` IS kept); IPv6 default routing is
// best-effort, so a host without IPv6 gets a working v4 tunnel rather than a failed
// bring-up.
func AmneziaWgUp(ctx context.Context, e *Env, config []byte, binDir string) error {
	if err := guard.AssertAmneziaWgConfig(config); err != nil {
		return err
	}
	_ = binDir // accepted and ignored; see the doc comment
	return withLock(ctx, e, func() error {
		ip, err := tool(e, "ip")
		if err != nil {
			return err
		}
		self, err := selfExecutable(e)
		if err != nil {
			return err
		}
		d, err := parseAwgDirectives(config)
		if err != nil {
			return err
		}
		path, err := writeConfig(e, wgConfName, config)
		if err != nil {
			return err
		}

		// Clean slate: a stale sntl0 from a crash would make the poll below pass
		// against the wrong device.
		runQuiet(ctx, e, ip, "link", "delete", wgIface)

		pid, err := e.Spawn([]string{self, "_amneziawg", path}, RunOpt{})
		if err != nil {
			return fmt.Errorf("could not start the AmneziaWG device: %v", err)
		}
		for i := 0; i < tunPollTries && !linkExists(e, wgIface); i++ {
			e.Sleep(tunPollInterval)
		}
		if !linkExists(e, wgIface) {
			_ = e.Kill(pid, syscall.SIGTERM)
			return errors.New("AmneziaWG interface did not appear")
		}

		// From here every failure tears the half-built tunnel down (awg-quick's
		// `trap 'del_if; exit'`) so a failed bring-up never leaks a device or rules.
		fail := func(err error) error {
			_ = e.Kill(pid, syscall.SIGTERM)
			runQuiet(ctx, e, ip, "link", "delete", wgIface)
			cleanupWgRules(ctx, e, ip)
			removeQuiet(e.runPath(wgConfName))
			removeQuiet(e.runPath(awgStateName))
			return err
		}

		for _, addr := range d.addresses {
			fam := "-4"
			if strings.Contains(addr, ":") {
				fam = "-6"
			}
			if err := run(ctx, e, RunOpt{}, ip, fam, "address", "add", addr, "dev", wgIface); err != nil {
				return fail(err)
			}
		}

		// MTU = what the config names (the 3.1 tier says 1280: its prefixes, trailers
		// and padding take room out of every packet), else the path MTU to the endpoint
		// minus WireGuard's 80-byte overhead; and the `up` that starts the device (the
		// userspace device goes UP on the OS link event, exactly as it does under
		// awg-quick's own `ip link set … up`).
		mtu := d.mtu
		if mtu == 0 {
			mtu = awgMTU(ctx, e, ip, d.endpointIP)
		}
		if err := run(ctx, e, RunOpt{}, ip, "link", "set", "mtu", strconv.Itoa(mtu), "up", "dev", wgIface); err != nil {
			return fail(err)
		}

		// DNS via resolvconf, exactly as awg-quick did: an exec whose stderr folds
		// verbatim into the error (ExitError), so a missing resolvconf still surfaces
		// as `/resolvconf/i` and the app offers the DNS-less retry.
		if len(d.nameservers) > 0 {
			resolvconf, lookErr := e.LookPath("resolvconf")
			if lookErr != nil {
				return fail(&ExitError{Argv: []string{"resolvconf"}, Code: 127, Stderr: "resolvconf: command not found"})
			}
			var stdin strings.Builder
			for _, ns := range d.nameservers {
				stdin.WriteString("nameserver " + ns + "\n")
			}
			if len(d.searches) > 0 {
				stdin.WriteString("search " + strings.Join(d.searches, " ") + "\n")
			}
			if err := run(ctx, e, RunOpt{Stdin: []byte(stdin.String())}, resolvconf, "-a", wgIface, "-m", "0", "-x"); err != nil {
				return fail(err)
			}
		}

		// Full-tunnel policy routing: everything into table 51820 via the /0 route,
		// with the tunnel's own fwmarked UDP suppressed back to the main table.
		if d.hasV4Default {
			if err := addAwgDefault(ctx, e, ip, "-4", "0.0.0.0/0"); err != nil {
				return fail(err)
			}
			// Without this, strict rp_filter drops the fwmarked outer UDP that must
			// egress the physical NIC. One sysctl; the only piece of awg-quick's
			// firewall that is load-bearing for a client. Written to /proc directly
			// (e.Root-relative, so tests see it) rather than via the sysctl binary.
			if err := writeProcSysctl(e, "net/ipv4/conf/all/src_valid_mark", "1"); err != nil {
				return fail(err)
			}
		}
		if d.hasV6Default {
			// Best-effort: a v6-less host still gets a working v4 tunnel.
			_ = addAwgDefaultQuiet(ctx, e, ip, "-6", "::/0")
		}

		return writeState(e, awgStateName, fmt.Sprintf("%d\n", pid))
	})
}

// addAwgDefault installs the wg-quick rule PAIR and the /0 route into table 51820
// for one family. cleanupWgRules removes the same pair on teardown.
func addAwgDefault(ctx context.Context, e *Env, ip, fam, cidr string) error {
	if err := run(ctx, e, RunOpt{}, ip, fam, "rule", "add", "not", "fwmark", awgFwmark, "table", awgFwmark); err != nil {
		return err
	}
	if err := run(ctx, e, RunOpt{}, ip, fam, "rule", "add", "table", "main", "suppress_prefixlength", "0"); err != nil {
		return err
	}
	return run(ctx, e, RunOpt{}, ip, fam, "route", "add", cidr, "dev", wgIface, "table", awgFwmark)
}

func addAwgDefaultQuiet(ctx context.Context, e *Env, ip, fam, cidr string) error {
	runQuiet(ctx, e, ip, fam, "rule", "add", "not", "fwmark", awgFwmark, "table", awgFwmark)
	runQuiet(ctx, e, ip, fam, "rule", "add", "table", "main", "suppress_prefixlength", "0")
	runQuiet(ctx, e, ip, fam, "route", "add", cidr, "dev", wgIface, "table", awgFwmark)
	return nil
}

// AmneziaWgDown restores DNS, stops the device (by the pid in awg.state, else a
// /proc scan matching our own `_amneziawg` process), deletes the link, repairs the
// leaked rule pair, and removes the config and state. Deleting the link alone makes
// the device exit; the SIGTERM is the belt to that brace, as tun-down does.
func AmneziaWgDown(ctx context.Context, e *Env) error {
	return withLock(ctx, e, func() error {
		ip, err := tool(e, "ip")
		if err != nil {
			return err
		}
		if resolvconf, lookErr := e.LookPath("resolvconf"); lookErr == nil {
			runQuiet(ctx, e, resolvconf, "-d", wgIface, "-f")
		}
		state := e.runPath(awgStateName)
		if b, err := os.ReadFile(state); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 0 {
				_ = e.Kill(pid, syscall.SIGTERM)
			}
			removeQuiet(state)
		} else {
			reapStrayAmneziaWg(e)
		}
		runQuiet(ctx, e, ip, "link", "delete", wgIface)
		cleanupWgRules(ctx, e, ip)
		removeQuiet(e.runPath(wgConfName))
		return nil
	})
}

// reapStrayAmneziaWg is the pid-less fallback (deviation 4): signal only a process
// whose /proc/<pid>/exe IS this helper and whose argv[1] is `_amneziawg`, never a
// name match. Mirrors reapStrayTun2socks.
func reapStrayAmneziaWg(e *Env) {
	self, err := selfExecutable(e)
	if err != nil {
		return
	}
	entries, err := os.ReadDir(e.path("/proc"))
	if err != nil {
		return
	}
	for _, dirent := range entries {
		pid, err := strconv.Atoi(dirent.Name())
		if err != nil || pid <= 0 {
			continue
		}
		argv := procArgv(e, pid)
		if len(argv) < 2 || argv[1] != "_amneziawg" {
			continue
		}
		exe, err := os.Readlink(e.path(fmt.Sprintf("/proc/%d/exe", pid)))
		if err != nil || strings.TrimSuffix(exe, " (deleted)") != self {
			continue
		}
		_ = e.Kill(pid, syscall.SIGTERM)
	}
}

// awgDirectives are the wg-quick(8) [Interface]/[Peer] directives ops needs — the
// ones the device itself does not consume (Address/DNS/Endpoint/AllowedIPs).
type awgDirectives struct {
	addresses    []string
	nameservers  []string
	searches     []string
	endpointIP   string
	mtu          int // 0 when the config names none
	hasV4Default bool
	hasV6Default bool
}

var reIPish = regexp.MustCompile(`^[0-9a-fA-F:.]+$`)

// parseAwgDirectives extracts what ops needs from the already-validated config.
// It is extraction, not validation (guard ran first); an obviously broken shape
// (no addresses, no endpoint) is still refused so a bad bring-up fails early.
func parseAwgDirectives(config []byte) (awgDirectives, error) {
	var d awgDirectives
	section := ""
	for _, raw := range strings.Split(string(config), "\n") {
		text := strings.TrimSpace(raw)
		if i := strings.IndexByte(text, '#'); i >= 0 {
			text = strings.TrimSpace(text[:i])
		}
		if text == "" {
			continue
		}
		if strings.HasPrefix(text, "[") {
			section = strings.ToLower(text)
			continue
		}
		key, value, ok := strings.Cut(text, "=")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		switch {
		case section == "[interface]" && key == "address":
			for _, a := range strings.Split(value, ",") {
				if a = strings.TrimSpace(a); a != "" {
					d.addresses = append(d.addresses, a)
				}
			}
		case section == "[interface]" && key == "dns":
			for _, v := range strings.Split(value, ",") {
				v = strings.TrimSpace(v)
				if v == "" {
					continue
				}
				if reIPish.MatchString(v) {
					d.nameservers = append(d.nameservers, v)
				} else {
					d.searches = append(d.searches, v)
				}
			}
		case section == "[interface]" && key == "mtu":
			// guard has already checked the value is digits.
			d.mtu, _ = strconv.Atoi(value)
		case section == "[peer]" && key == "endpoint":
			d.endpointIP = endpointHost(value)
		case section == "[peer]" && key == "allowedips":
			for _, c := range strings.Split(value, ",") {
				switch strings.TrimSpace(c) {
				case "0.0.0.0/0":
					d.hasV4Default = true
				case "::/0":
					d.hasV6Default = true
				}
			}
		}
	}
	if len(d.addresses) == 0 {
		return d, errors.New("AmneziaWG config has no Address")
	}
	if d.endpointIP == "" {
		return d, errors.New("AmneziaWG config has no Endpoint")
	}
	return d, nil
}

// endpointHost strips the port (and IPv6 brackets) from a wg Endpoint. Our endpoints
// are IPv4-pinned, so this is host:port; the [v6]:port form is handled defensively.
func endpointHost(endpoint string) string {
	if strings.HasPrefix(endpoint, "[") {
		if i := strings.LastIndex(endpoint, "]"); i > 0 {
			return endpoint[1:i]
		}
	}
	if i := strings.LastIndex(endpoint, ":"); i >= 0 {
		return endpoint[:i]
	}
	return endpoint
}

var (
	reMTU = regexp.MustCompile(`\bmtu (\d+)`)
	reDev = regexp.MustCompile(`\bdev (\S+)`)
)

// awgMTU reproduces awg-quick's set_mtu_up: the MTU of the route to the endpoint
// (falling back to the default route, then 1500) minus WireGuard's 80-byte header.
func awgMTU(ctx context.Context, e *Env, ip, endpointIP string) int {
	base := 0
	if endpointIP != "" {
		base = routeDevMTU(ctx, e, ip, output(ctx, e, ip, "route", "get", endpointIP))
	}
	if base == 0 {
		base = routeDevMTU(ctx, e, ip, output(ctx, e, ip, "route", "show", "default"))
	}
	if base == 0 {
		base = 1500
	}
	return base - 80
}

// routeDevMTU pulls the MTU out of an `ip route` line: the `mtu N` on the line if
// present, else the MTU of the line's `dev`.
func routeDevMTU(ctx context.Context, e *Env, ip, routeLine string) int {
	if m := reMTU.FindStringSubmatch(routeLine); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil {
			return n
		}
	}
	if m := reDev.FindStringSubmatch(routeLine); m != nil {
		if lm := reMTU.FindStringSubmatch(output(ctx, e, ip, "link", "show", "dev", m[1])); lm != nil {
			if n, err := strconv.Atoi(lm[1]); err == nil {
				return n
			}
		}
	}
	return 0
}

// writeProcSysctl sets a /proc/sys knob (e.Root-relative for tests). Idempotent: a
// knob already at the wanted value is left alone, which is also what lets a
// NET_ADMIN-only container that was started with `--sysctl` (read-only /proc/sys)
// bring the tunnel up. The parent dirs exist on a real system; MkdirAll makes the
// test's temp tree work.
func writeProcSysctl(e *Env, key, value string) error {
	p := e.path("/proc/sys/" + key)
	if cur, err := os.ReadFile(p); err == nil && strings.TrimSpace(string(cur)) == value {
		return nil
	}
	if e.Root != "" {
		_ = os.MkdirAll(e.path("/proc/sys/"+key[:strings.LastIndex(key, "/")]), 0o755)
	}
	return os.WriteFile(p, []byte(value+"\n"), 0o644)
}
