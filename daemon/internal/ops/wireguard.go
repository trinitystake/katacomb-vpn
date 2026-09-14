package ops

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"katacomb.vpn/daemon/internal/guard"
)

// WireguardUp validates a WireGuard config, writes it to RunDir/sntl0.conf and
// runs `wg-quick up` on it. The interface name is derived by wg-quick from the
// file name, which is why the file is always sntl0.conf.
func WireguardUp(ctx context.Context, e *Env, config []byte) error {
	if err := guard.AssertWireguardConfig(config); err != nil {
		return err
	}
	return withLock(ctx, e, func() error {
		wgQuick, err := tool(e, "wg-quick")
		if err != nil {
			return err
		}
		path, err := writeConfig(e, wgConfName, config)
		if err != nil {
			return err
		}
		return run(ctx, e, RunOpt{}, wgQuick, "up", path)
	})
}

// awk -F'[ :]+' on `ip -o link show` output: field 2 is the interface name.
var reSpaceColon = regexp.MustCompile(`[ :]+`)

// WireguardDown tears down EVERY wireguard-type link (parity with the bash verb;
// aggressive, but the app never runs alongside another kernel WireGuard tunnel by
// design), then repairs wg-quick's leaked policy rules and removes the root-owned
// config (it holds the private key).
func WireguardDown(ctx context.Context, e *Env) error {
	return withLock(ctx, e, func() error {
		ip, err := tool(e, "ip")
		if err != nil {
			return err
		}
		for _, line := range strings.Split(output(ctx, e, ip, "-o", "link", "show", "type", "wireguard"), "\n") {
			f := reSpaceColon.Split(line, -1)
			if len(f) < 2 || f[1] == "" {
				continue
			}
			iface := f[1]
			if !guard.IsValidInterfaceName(iface) {
				return fmt.Errorf("invalid interface name: %s", iface)
			}
			// `wg-quick down` resolves the name against /etc/wireguard, where our
			// config never lives, so this fails on every disconnect and the delete
			// below is the normal path, not the exception.
			wgQuick, lookErr := e.LookPath("wg-quick")
			if lookErr != nil || run(ctx, e, RunOpt{}, wgQuick, "down", iface) != nil {
				runQuiet(ctx, e, ip, "link", "delete", iface)
			}
		}
		cleanupWgRules(ctx, e, ip)
		removeQuiet(e.runPath(wgConfName))
		return nil
	})
}

// wg-quick allocates fwmark tables from 51820 upwards; a table outside this range
// belongs to someone else's VPN and is never touched.
const (
	wgTableMin = 51820
	wgTableMax = 51899
	// Every loop is bounded so a delete that keeps failing can never spin.
	wgRuleLoopMax = 32
)

// wgRuleTables lists the tables named by wg-quick-shaped fwmark rules, in range,
// sorted and unique (the bash `awk … | sort -u`).
func wgRuleTables(ctx context.Context, e *Env, ip, fam string) []string {
	seen := map[string]bool{}
	for _, line := range strings.Split(output(ctx, e, ip, fam, "rule", "show"), "\n") {
		if !strings.Contains(line, "fwmark") {
			continue
		}
		f := strings.Fields(line)
		for i := 0; i+1 < len(f); i++ {
			if f[i] != "lookup" {
				continue
			}
			n, err := strconv.Atoi(f[i+1])
			if err == nil && n >= wgTableMin && n <= wgTableMax {
				seen[f[i+1]] = true
			}
		}
	}
	tables := make([]string, 0, len(seen))
	for t := range seen {
		tables = append(tables, t)
	}
	sort.Strings(tables)
	return tables
}

// cleanupWgRules removes the rule PAIR wg-quick/awg-quick install per bring-up
// (`not from all fwmark 0xca6c lookup 51820` + `from all lookup main
// suppress_prefixlength 0`) and never remove themselves on our teardown path.
// Scoped tightly: only once NO tunnel that could own them is left, only tables in
// wg-quick's own range, every loop bounded.
func cleanupWgRules(ctx context.Context, e *Env, ip string) {
	if strings.TrimSpace(output(ctx, e, ip, "-o", "link", "show", "type", "wireguard")) != "" {
		return
	}
	if linkExists(e, wgIface) {
		return
	}
	for _, fam := range []string{"-4", "-6"} {
		for _, table := range wgRuleTables(ctx, e, ip, fam) {
			for n := 0; n < wgRuleLoopMax && strings.Contains(output(ctx, e, ip, fam, "rule", "show"), "lookup "+table); n++ {
				if run(ctx, e, RunOpt{}, ip, fam, "rule", "delete", "table", table) != nil {
					break
				}
			}
		}
		for n := 0; n < wgRuleLoopMax && strings.Contains(output(ctx, e, ip, fam, "rule", "show"), "suppress_prefixlength 0"); n++ {
			if run(ctx, e, RunOpt{}, ip, fam, "rule", "delete", "table", "main", "suppress_prefixlength", "0") != nil {
				break
			}
		}
	}
}
