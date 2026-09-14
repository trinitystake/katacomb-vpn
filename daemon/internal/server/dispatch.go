package server

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"

	"katacomb.vpn/daemon/internal/guard"
	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/protocol"
)

// Dispatch maps one protocol request onto the ops package. The fail() strings
// are the ones the TypeScript daemon produced, verbatim: the app matches on
// `unknown op` to detect a stale daemon after an upgrade, and dispatch_test.go
// pins the rest against the twenty cases daemon-core.test.ts used to hold.
//
// Argument checks here are the type/shape checks the socket layer owes its
// callers (a JSON string where a string is expected, and so on); ops validates
// the values again, because ops is the boundary and this is one of two doors.
func Dispatch(ctx context.Context, req protocol.Request, e *ops.Env) protocol.Response {
	reply := func(result any) protocol.Response {
		return protocol.Response{ID: req.ID, OK: true, Result: result}
	}
	fail := func(msg string) protocol.Response {
		return protocol.Response{ID: req.ID, OK: false, Error: msg}
	}
	failErr := func(err error) protocol.Response { return fail(err.Error()) }
	args := parseArgs(req.Args)

	switch req.Op {
	case "protocol_version":
		return reply(map[string]int{"version": protocol.Version})

	case "status":
		return reply(ops.Status(e))

	case "wireguard_up":
		cfg, ok := args.str("configString")
		if !ok {
			return fail("wireguard_up: configString required")
		}
		if err := ops.WireguardUp(ctx, e, []byte(cfg)); err != nil {
			return failErr(err)
		}
		return reply(nil)

	case "wireguard_down":
		if err := ops.WireguardDown(ctx, e); err != nil {
			return failErr(err)
		}
		return reply(nil)

	case "amneziawg_up":
		cfg, ok := args.str("configString")
		if !ok {
			return fail("amneziawg_up: configString required")
		}
		// The pinned trio from the daemon's own bin dir; a client-supplied path is ignored.
		if err := ops.AmneziaWgUp(ctx, e, []byte(cfg), e.BinDir); err != nil {
			return failErr(err)
		}
		return reply(nil)

	case "amneziawg_down":
		if err := ops.AmneziaWgDown(ctx, e); err != nil {
			return failErr(err)
		}
		return reply(nil)

	case "openvpn_up":
		cfg, ok := args.str("configString")
		if !ok {
			return fail("openvpn_up: configString required")
		}
		if err := ops.OpenVpnUp(ctx, e, []byte(cfg)); err != nil {
			return failErr(err)
		}
		return reply(nil)

	case "openvpn_down":
		if err := ops.OpenVpnDown(ctx, e); err != nil {
			return failErr(err)
		}
		return reply(nil)

	case "tun_up":
		socks, ok := args.str("socksAddr")
		if !ok || !guard.IsValidSocksAddr(socks) {
			return fail("tun_up: invalid socksAddr")
		}
		remote, ok := args.str("remoteHost")
		if !ok || !guard.IsIPv4(remote) {
			return fail("tun_up: invalid remoteHost")
		}
		gw, ok := args.str("gateway")
		if !ok || !guard.IsIPv4(gw) {
			return fail("tun_up: invalid gateway")
		}
		iface, ok := args.str("iface")
		if !ok || !guard.IsValidInterfaceName(iface) {
			return fail("tun_up: invalid iface")
		}
		var bypass []string
		for _, r := range args.strs("bypassRoutes") {
			if guard.IsAllowedBypassCidr(r) {
				bypass = append(bypass, r)
			}
		}
		// The pinned bundled tun2socks; any client-supplied path is ignored.
		p := ops.TunUpParams{Bin: filepath.Join(e.BinDir, "tun2socks"), SocksAddr: socks, RemoteHost: remote, Gateway: gw, Iface: iface, BypassRoutes: bypass}
		if _, err := ops.TunUp(ctx, e, p); err != nil {
			return failErr(err)
		}
		return reply(nil)

	case "tun_down":
		if err := ops.TunDown(ctx, e); err != nil {
			return failErr(err)
		}
		return reply(nil)

	case "killswitch_on":
		iface, ok := args.str("iface")
		if !ok || !guard.IsValidInterfaceName(iface) {
			return fail("killswitch_on: invalid iface")
		}
		remote, ok := args.str("remoteHost")
		if !ok || !guard.IsIPv4(remote) {
			return fail("killswitch_on: invalid remoteHost")
		}
		// 0.0.0.0/32 whitelists nothing, so arming with it blackholes the very
		// tunnel the chain is meant to protect.
		if remote == "0.0.0.0" {
			return fail("killswitch_on: remoteHost 0.0.0.0 whitelists nothing")
		}
		lan := false
		if raw, present := args.present("lanSharing"); present {
			b, ok := asBool(raw)
			if !ok {
				return fail("killswitch_on: invalid lanSharing")
			}
			lan = b
		}
		dns := ""
		if raw, present := args.present("dnsIp"); present && string(raw) != "null" {
			s, ok := asString(raw)
			if !ok || !guard.IsIPv4(s) {
				return fail("killswitch_on: invalid dnsIp")
			}
			dns = s
		}
		if err := ops.KillswitchOn(ctx, e, ops.KillswitchParams{Iface: iface, RemoteHost: remote, DnsIp: dns, LanSharing: lan}); err != nil {
			return failErr(err)
		}
		return reply(nil)

	case "killswitch_off":
		if err := ops.KillswitchOff(ctx, e); err != nil {
			return failErr(err)
		}
		return reply(nil)

	case "dns_set":
		ip, ok := args.str("dnsIp")
		if !ok || !guard.IsAllowedDnsResolver(ip) {
			return fail("dns_set: DNS resolver not allowed")
		}
		if err := ops.DnsSet(ctx, e, ip); err != nil {
			return failErr(err)
		}
		return reply(nil)

	case "dns_restore":
		if err := ops.DnsRestore(ctx, e); err != nil {
			return failErr(err)
		}
		return reply(nil)
	}
	return fail("unknown op: " + req.Op)
}

// argMap is the request's args object; anything that is not an object reads as
// empty, as `(req && req.args) || {}` did.
type argMap map[string]json.RawMessage

func parseArgs(raw json.RawMessage) argMap {
	var m argMap
	if len(raw) == 0 || json.Unmarshal(raw, &m) != nil || m == nil {
		return argMap{}
	}
	return m
}

func (a argMap) present(key string) (json.RawMessage, bool) {
	raw, ok := a[key]
	return raw, ok
}

// asString is `typeof x === 'string'`: JSON null unmarshals into a Go string
// without error, so the literal is checked, not just the decode.
func asString(raw json.RawMessage) (string, bool) {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || t[0] != '"' {
		return "", false
	}
	var s string
	if err := json.Unmarshal(t, &s); err != nil {
		return "", false
	}
	return s, true
}

// asBool is `typeof x === 'boolean'`, with the same null caveat.
func asBool(raw json.RawMessage) (bool, bool) {
	switch string(bytes.TrimSpace(raw)) {
	case "true":
		return true, true
	case "false":
		return false, true
	}
	return false, false
}

func (a argMap) str(key string) (string, bool) {
	raw, ok := a[key]
	if !ok {
		return "", false
	}
	return asString(raw)
}

// strs returns the string elements of an array-valued arg (non-strings dropped,
// non-arrays read as empty), as `Array.isArray(x) ? x.filter(isString) : []` did.
func (a argMap) strs(key string) []string {
	raw, ok := a[key]
	if !ok {
		return nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil
	}
	var out []string
	for _, it := range items {
		if s, ok := asString(it); ok {
			out = append(out, s)
		}
	}
	return out
}
