package ops

import (
	"context"
	"fmt"

	"katacomb.vpn/daemon/internal/guard"
)

const (
	chain4 = "KATACOMB_KILLSWITCH"
	chain6 = "KATACOMB_KILLSWITCH6"
)

// Destinations that stay reachable while the kill switch is armed, so the user
// can still reach their own LAN. Hardcoded HERE on purpose: the app sends one
// boolean and never a range, so nothing a compromised renderer or the
// unauthenticated socket can say turns this into a hole to a public address. An
// ACCEPT in OUTPUT only permits; it does not route, so these cannot pull tunnel
// traffic out of the tunnel. 100.64.0.0/10 (CGNAT, Tailscale) is deliberately
// absent.
var (
	lanRangesV4 = []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "224.0.0.0/4", "255.255.255.255/32"}
	// fe80::/10 also unbreaks neighbour discovery, which the v6 chain drops otherwise.
	lanRangesV6 = []string{"fe80::/10", "fc00::/7", "ff00::/8"}
)

// KillswitchParams is `killswitch-on <iface> <host> [dns] [lan-sharing]`.
type KillswitchParams struct {
	Iface      string
	RemoteHost string
	DnsIp      string // "" = none
	LanSharing bool
}

// The `-w 5` on every call is load-bearing: without it a concurrent xtables-lock
// holder (NetworkManager, ufw, docker) makes a `-D OUTPUT` fail silently and
// leaves the DROP chain jumped from OUTPUT — a stranded kill switch.
func ipt(ctx context.Context, e *Env, bin string, args ...string) error {
	argv := append([]string{bin, "-w", "5"}, args...)
	return run(ctx, e, RunOpt{}, argv...)
}

func iptQuiet(ctx context.Context, e *Env, bin string, args ...string) {
	_ = ipt(ctx, e, bin, args...)
}

func ipv6KillswitchOff(ctx context.Context, e *Env) {
	ip6, err := e.LookPath("ip6tables")
	if err != nil {
		return
	}
	iptQuiet(ctx, e, ip6, "-D", "OUTPUT", "-j", chain6)
	iptQuiet(ctx, e, ip6, "-F", chain6)
	iptQuiet(ctx, e, ip6, "-X", chain6)
}

// The tunnel, the VPN server and the DNS resolver are all IPv4, so the correct
// fail-closed behaviour for IPv6 is to permit it ONLY out loopback and the VPN
// interface (v6 carried inside the tunnel still works) and drop every other v6
// egress. Short-circuited so a partial failure aborts and the caller cleans up.
func ipv6KillswitchOn(ctx context.Context, e *Env, ip6, iface string, lan bool) error {
	ipv6KillswitchOff(ctx, e)
	steps := [][]string{
		{"-N", chain6},
		{"-A", chain6, "-o", "lo", "-j", "ACCEPT"},
		{"-A", chain6, "-o", iface, "-j", "ACCEPT"},
		{"-A", chain6, "-o", iface, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"},
	}
	if lan {
		for _, r := range lanRangesV6 {
			steps = append(steps, []string{"-A", chain6, "-d", r, "-j", "ACCEPT"})
		}
	}
	steps = append(steps, []string{"-A", chain6, "-j", "DROP"}, []string{"-A", "OUTPUT", "-j", chain6})
	for _, s := range steps {
		if err := ipt(ctx, e, ip6, s...); err != nil {
			return err
		}
	}
	return nil
}

// KillswitchOn installs the DROP-all OUTPUT chain with its exceptions, in the
// documented order: loopback, the tunnel interface, the VPN server, DHCP, DNS to
// the chosen resolver through the tunnel only, ESTABLISHED,RELATED scoped to the
// tunnel interface only, the LAN ranges when asked, then DROP. IPv6 is
// best-effort and never aborts the IPv4 chain.
func KillswitchOn(ctx context.Context, e *Env, p KillswitchParams) error {
	if !guard.IsValidInterfaceName(p.Iface) {
		return fmt.Errorf("invalid interface name: %s", p.Iface)
	}
	if !guard.IsIPv4(p.RemoteHost) {
		return fmt.Errorf("invalid IPv4 address: %s", p.RemoteHost)
	}
	// A 0.0.0.0/32 whitelist matches no packet, so the DROP-all rule would swallow
	// the tunnel's own outer traffic: interface up, "connected", nothing gets
	// through. Refuse instead of installing a self-defeating chain.
	if p.RemoteHost == "0.0.0.0" {
		return fmt.Errorf("killswitch remote host 0.0.0.0 whitelists nothing")
	}
	if p.DnsIp != "" && !guard.IsIPv4(p.DnsIp) {
		return fmt.Errorf("invalid IPv4 address: %s", p.DnsIp)
	}
	return withLock(ctx, e, func() error {
		ipt4, err := tool(e, "iptables")
		if err != nil {
			return err
		}
		// Flush an existing chain if present.
		iptQuiet(ctx, e, ipt4, "-D", "OUTPUT", "-j", chain4)
		iptQuiet(ctx, e, ipt4, "-F", chain4)
		iptQuiet(ctx, e, ipt4, "-X", chain4)

		rules := [][]string{
			{"-N", chain4},
			{"-A", chain4, "-o", "lo", "-j", "ACCEPT"},
			{"-A", chain4, "-o", p.Iface, "-j", "ACCEPT"},
			{"-A", chain4, "-d", p.RemoteHost + "/32", "-j", "ACCEPT"},
			{"-A", chain4, "-p", "udp", "--dport", "67:68", "-j", "ACCEPT"},
		}
		if p.DnsIp != "" {
			// Scoped to the VPN interface so plaintext DNS never egresses the
			// physical NIC during a tunnel-down window.
			rules = append(rules,
				[]string{"-A", chain4, "-o", p.Iface, "-d", p.DnsIp + "/32", "-p", "udp", "--dport", "53", "-j", "ACCEPT"},
				[]string{"-A", chain4, "-o", p.Iface, "-d", p.DnsIp + "/32", "-p", "tcp", "--dport", "53", "-j", "ACCEPT"})
		}
		rules = append(rules, []string{"-A", chain4, "-o", p.Iface, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"})
		if p.LanSharing {
			for _, r := range lanRangesV4 {
				rules = append(rules, []string{"-A", chain4, "-d", r, "-j", "ACCEPT"})
			}
		}
		rules = append(rules, []string{"-A", chain4, "-j", "DROP"}, []string{"-A", "OUTPUT", "-j", chain4})
		for _, r := range rules {
			if err := ipt(ctx, e, ipt4, r...); err != nil {
				return err
			}
		}

		// ipv6_available: the binary exists and the tables answer (no -w: a probe).
		if ip6, err := e.LookPath("ip6tables"); err == nil && run(ctx, e, RunOpt{}, ip6, "-S") == nil {
			if err := ipv6KillswitchOn(ctx, e, ip6, p.Iface, p.LanSharing); err != nil {
				ipv6KillswitchOff(ctx, e)
				e.Warn("IPv6 kill switch setup failed; IPv4 kill switch active")
			}
		}
		return writeState(e, killswitchStateName, fmt.Sprintf("%s %s %s\n", p.Iface, p.RemoteHost, p.DnsIp))
	})
}

// KillswitchOff removes both chains unconditionally and idempotently: the v6
// teardown is not gated on ip6tables availability, so it cannot be skipped if
// that flips between connect and disconnect.
func KillswitchOff(ctx context.Context, e *Env) error {
	return withLock(ctx, e, func() error {
		if ipt4, err := e.LookPath("iptables"); err == nil {
			iptQuiet(ctx, e, ipt4, "-D", "OUTPUT", "-j", chain4)
			iptQuiet(ctx, e, ipt4, "-F", chain4)
			iptQuiet(ctx, e, ipt4, "-X", chain4)
		}
		ipv6KillswitchOff(ctx, e)
		removeQuiet(e.runPath(killswitchStateName))
		return nil
	})
}
