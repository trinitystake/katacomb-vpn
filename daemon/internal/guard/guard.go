// Package guard holds the root-side validators for everything a client can hand
// the privileged helper: the three tunnel configs (WireGuard, AmneziaWG, OpenVPN)
// that wg-quick / awg-quick / openvpn execute as root, and the scalar arguments
// (addresses, interface names, CIDRs, DNS resolvers) that reach `ip`, `iptables`
// and /etc/resolv.conf.
//
// It is a line-for-line port of the allow-lists in src/main/config-guard.ts, and
// the two must accept and reject exactly the same inputs: testdata/corpus/ is the
// shared fixture set, read by guard_test.go here and by
// src/main/config-guard-corpus.test.ts on the TypeScript side. Change a rule in
// one, and the other side's test goes red until it is mirrored.
//
// Why the client's validator is not enough: the socket is unauthenticated and the
// one-shot is reachable by any polkit-authenticated user, so a request can come
// from something that is not this app. A wg-quick config carrying `PostUp = …` is
// a root shell; the allow-list here is what stops it.
//
// Error messages carry a LINE NUMBER and a reason word, never the offending
// content. In one-shot mode the config comes from a caller-supplied path, and a
// message that echoed the line would turn the validator into a root file-read
// oracle. The reason vocabulary (not allowed, repeated, missing, malformed,
// unterminated, outside any section) is what the corpus headers name.
package guard

import (
	"encoding/base64"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// LanSharingArg is the trailing sentinel `killswitch-on` takes to add the LAN
// ACCEPT rules. The app hardcodes the same literal (config-guard.ts LAN_SHARING_ARG).
const LanSharingArg = "lan-sharing"

// --- WireGuard ---------------------------------------------------------------

// Keys we accept. Anything else — notably the script-executing PostUp/PreUp/
// PostDown/PreDown, plus Table/SaveConfig/FwMark — is rejected by omission.
var (
	wgInterfaceKeys = set("privatekey", "address", "dns", "mtu", "listenport")
	wgPeerKeys      = set("publickey", "presharedkey", "allowedips", "endpoint", "persistentkeepalive")

	// Value shapes for the allow-listed keys: format hardening behind the key
	// allow-list, lenient enough to never reject an SDK-generated config.
	reWgHostOrCIDR = regexp.MustCompile(`^\[?[A-Za-z0-9.:_-]+\]?(/\d{1,3})?$`)
	reWgEndpoint   = regexp.MustCompile(`^\[?[A-Za-z0-9.:_-]+\]?:\d{1,5}$`)
	reWgKey        = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`)
	reWgUint       = regexp.MustCompile(`^\d{1,7}$`)
	reSection      = regexp.MustCompile(`^\[(.+)\]$`)
)

func set(items ...string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, s := range items {
		m[s] = true
	}
	return m
}

func wgListValueOK(value string) bool {
	for _, raw := range strings.Split(value, ",") {
		item := strings.TrimSpace(raw)
		if item == "" {
			continue
		}
		if !reWgHostOrCIDR.MatchString(item) {
			return false
		}
	}
	return true
}

// wgValueOK mirrors assertSafeWireguardValue: false when an allow-listed key's
// value is malformed.
func wgValueOK(key, value string) bool {
	v := strings.TrimSpace(value)
	switch key {
	case "mtu", "listenport", "persistentkeepalive":
		return reWgUint.MatchString(v)
	case "privatekey", "publickey", "presharedkey":
		return reWgKey.MatchString(v)
	case "endpoint":
		return reWgEndpoint.MatchString(v)
	case "address", "allowedips", "dns":
		return wgListValueOK(value)
	}
	return true
}

// AssertWireguardConfig returns nil when every directive of a WireGuard INI is on
// the allow-list with a well-formed value.
func AssertWireguardConfig(config []byte) error {
	return assertIni("WireGuard", config, wgInterfaceKeys, wgValueOK)
}

// --- AmneziaWG ---------------------------------------------------------------

// The WireGuard set plus AmneziaWG's obfuscation keys. awg-quick is a wg-quick
// fork, so PostUp/PreUp execute as root identically and are rejected the same way.
var (
	awgInterfaceKeys = set(
		"privatekey", "address", "dns", "mtu", "listenport",
		"jc", "jmin", "jmax",
		"s1", "s2", "s3", "s4",
		"h1", "h2", "h3", "h4",
		"i1", "i2", "i3", "i4", "i5",
		// The AmneziaWG 3.1 tier a dvpnd node offers on request.
		"headerprotectionkey", "randomtrailers", "contentpaddingaddition",
	)
	awgUint16Keys = set("jc", "jmin", "jmax", "s1", "s2", "s3", "s4")
	awgUint32Keys = set("h1", "h2", "h3", "h4")
	awgIKeys      = set("i1", "i2", "i3", "i4", "i5")
	reAwgUint16   = regexp.MustCompile(`^\d{1,5}$`)
	reAwgUint32   = regexp.MustCompile(`^\d{1,10}$`)
	// awg signature-packet tag grammar.
	reAwgITags    = regexp.MustCompile(`^(<b 0x[0-9a-fA-F]+>|<r \d{1,5}>|<rd \d{1,5}>|<rc \d{1,5}>|<t>)+$`)
	awgIMaxLength = 4096
	// The 3.1 tier's values: wg-quick's on/off, and the engine's "min-max" range.
	reAwgOnOff = regexp.MustCompile(`^(on|off)$`)
	reAwgRange = regexp.MustCompile(`^\d{1,5}(-\d{1,5})?$`)
)

func awgValueOK(key, value string) bool {
	v := strings.TrimSpace(value)
	switch {
	case awgUint16Keys[key]:
		if !reAwgUint16.MatchString(v) {
			return false
		}
		n, _ := strconv.ParseUint(v, 10, 64)
		return n <= 65535
	case awgUint32Keys[key]:
		if !reAwgUint32.MatchString(v) {
			return false
		}
		n, _ := strconv.ParseUint(v, 10, 64)
		return n <= 4294967295
	case awgIKeys[key]:
		return len(v) <= awgIMaxLength && reAwgITags.MatchString(v)
	case key == "headerprotectionkey":
		// A wrong-length key is only refused by the device at bring-up, after the
		// session is paid for; refuse it here like the builder does.
		if !reWgKey.MatchString(v) {
			return false
		}
		raw, err := base64.StdEncoding.DecodeString(v)
		return err == nil && len(raw) == 32
	case key == "randomtrailers":
		return reAwgOnOff.MatchString(v)
	case key == "contentpaddingaddition":
		return reAwgRange.MatchString(v)
	}
	return wgValueOK(key, value)
}

// AssertAmneziaWgConfig is AssertWireguardConfig with the AmneziaWG [Interface]
// keys added. Kept separate so the plain-WireGuard allow-list never loosens.
func AssertAmneziaWgConfig(config []byte) error {
	return assertIni("AmneziaWG", config, awgInterfaceKeys, awgValueOK)
}

// assertIni is the shared [Interface]/[Peer] scanner. `interfaceKeys` is the
// per-protocol [Interface] allow-list; [Peer] is the same for both.
func assertIni(proto string, config []byte, interfaceKeys map[string]bool, valueOK func(key, value string) bool) error {
	section := ""
	for i, raw := range strings.Split(string(config), "\n") {
		n := i + 1
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if m := reSection.FindStringSubmatch(line); m != nil {
			name := strings.ToLower(strings.TrimSpace(m[1]))
			if name != "interface" && name != "peer" {
				return fmt.Errorf("%s config: line %d: section is not allowed", proto, n)
			}
			section = name
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq == -1 {
			return fmt.Errorf("%s config: line %d: malformed line is not allowed", proto, n)
		}
		key := strings.ToLower(strings.TrimSpace(line[:eq]))
		if section == "" {
			return fmt.Errorf("%s config: line %d: key outside any section is not allowed", proto, n)
		}
		allowed := wgPeerKeys
		if section == "interface" {
			allowed = interfaceKeys
		}
		if !allowed[key] {
			return fmt.Errorf("%s config: line %d: key in [%s] is not allowed", proto, n, section)
		}
		if !valueOK(key, strings.TrimSpace(line[eq+1:])) {
			return fmt.Errorf("%s config: line %d: value of a [%s] key is malformed", proto, n, section)
		}
	}
	return nil
}

// --- OpenVPN -----------------------------------------------------------------

// OpenVPN's grammar is space-separated directives plus inline <tag>…</tag> PKI
// blocks. The root-exec surface is larger than wg-quick's: up/down/route-up/
// ipchange/client-connect/tls-verify/auth-user-pass-verify/learn-address/plugin
// all run code as root and script-security would re-enable them; every one is
// rejected by omission. Operational flags the helper itself needs (--daemon,
// --writepid, --log, --script-security 0, --dev) are deliberately NOT allowed in
// the file: ops passes them on the command line after --config (openvpn is
// last-one-wins), so they can only ever come from us.
const ovpnIfaceName = "sntl-ovpn"

// directive -> validator for its argument (an empty-string match when it takes none).
var ovpnDirectives = map[string]*regexp.Regexp{
	"client":                regexp.MustCompile(`^$`),
	"dev":                   regexp.MustCompile(`^` + ovpnIfaceName + `$`),
	"dev-type":              regexp.MustCompile(`^tun$`),
	"proto":                 regexp.MustCompile(`^(tcp|udp)$`),
	"remote":                regexp.MustCompile(`^\[?[A-Za-z0-9.:_-]+\]?[ \t]+\d{1,5}$`),
	"nobind":                regexp.MustCompile(`^$`),
	"auth-nocache":          regexp.MustCompile(`^$`),
	"auth":                  regexp.MustCompile(`^[A-Za-z0-9-]{1,32}$`),
	"data-ciphers":          regexp.MustCompile(`^[A-Za-z0-9:-]{1,128}$`),
	"data-ciphers-fallback": regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`),
	"tls-cipher":            regexp.MustCompile(`^[A-Za-z0-9:-]{1,128}$`),
	"tls-client":            regexp.MustCompile(`^$`),
	"tls-version-min":       regexp.MustCompile(`^1\.[23]$`),
	"remote-cert-tls":       regexp.MustCompile(`^server$`),
	"redirect-gateway":      regexp.MustCompile(`^[A-Za-z0-9 \t-]{0,64}$`), // def1 ipv6 bypass-dhcp
	"topology":              regexp.MustCompile(`^subnet$`),
	"explicit-exit-notify":  regexp.MustCompile(`^[1-3]$`),
	"persist-key":           regexp.MustCompile(`^$`),
	"persist-tun":           regexp.MustCompile(`^$`),
}

var (
	ovpnInlineTags = []string{"ca", "cert", "key", "tls-crypt"}
	// PEM armor or its base64/hex body. The app decodes and re-armors every node
	// blob, so nothing else can legitimately appear inside a block.
	reOvpnPemLine = regexp.MustCompile(`^(-----(BEGIN|END) [A-Za-z0-9 ]{1,48}-----|[A-Za-z0-9+/]+={0,2})$`)
	reOvpnOpening = regexp.MustCompile(`^<([A-Za-z0-9-]+)>$`)
	reOvpnSplit   = regexp.MustCompile(`[ \t]`)
	// Without these the tunnel would either not be a client tunnel or would drop
	// the tls-crypt channel wrapper.
	ovpnRequired = []string{"client", "dev", "proto", "remote"}
)

func isOvpnInlineTag(tag string) bool {
	for _, t := range ovpnInlineTags {
		if t == tag {
			return true
		}
	}
	return false
}

// AssertOpenVpnConfig returns nil when every directive is on the allow-list with
// a well-formed value, every inline block is a known PKI block seen once, nothing
// is repeated, no block is left open, and the client essentials are present.
func AssertOpenVpnConfig(config []byte) error {
	openBlock := ""
	seenBlocks := map[string]bool{}
	seenDirectives := map[string]bool{}

	for i, raw := range strings.Split(string(config), "\n") {
		n := i + 1
		line := strings.TrimSpace(raw)

		if openBlock != "" {
			if line == "</"+openBlock+">" {
				openBlock = ""
				continue
			}
			if line == "" {
				continue
			}
			if !reOvpnPemLine.MatchString(line) {
				return fmt.Errorf("OpenVPN config: line %d: inline block line is malformed (non-PEM)", n)
			}
			continue
		}

		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}

		if m := reOvpnOpening.FindStringSubmatch(line); m != nil {
			tag := strings.ToLower(m[1])
			if !isOvpnInlineTag(tag) {
				return fmt.Errorf("OpenVPN config: line %d: inline block is not allowed", n)
			}
			if seenBlocks[tag] {
				return fmt.Errorf("OpenVPN config: line %d: inline block is repeated", n)
			}
			seenBlocks[tag] = true
			openBlock = tag
			continue
		}
		if strings.HasPrefix(line, "<") {
			return fmt.Errorf("OpenVPN config: line %d: stray tag is not allowed", n)
		}

		directive, value := line, ""
		if loc := reOvpnSplit.FindStringIndex(line); loc != nil {
			directive = line[:loc[0]]
			value = strings.TrimSpace(line[loc[0]+1:])
		}
		directive = strings.ToLower(directive)

		validator, ok := ovpnDirectives[directive]
		if !ok {
			return fmt.Errorf("OpenVPN config: line %d: directive is not allowed", n)
		}
		if seenDirectives[directive] {
			// e.g. a second `remote` (failover) that the kill switch wouldn't whitelist.
			return fmt.Errorf("OpenVPN config: line %d: directive is repeated", n)
		}
		seenDirectives[directive] = true
		if !validator.MatchString(value) {
			return fmt.Errorf("OpenVPN config: line %d: directive has a malformed value", n)
		}
	}

	if openBlock != "" {
		return fmt.Errorf("OpenVPN config: inline block is unterminated")
	}
	for _, tag := range ovpnInlineTags {
		if !seenBlocks[tag] {
			return fmt.Errorf("OpenVPN config: inline block is missing")
		}
	}
	for _, d := range ovpnRequired {
		if !seenDirectives[d] {
			return fmt.Errorf("OpenVPN config: directive is missing")
		}
	}
	return nil
}

// --- scalars -----------------------------------------------------------------

var (
	reIPv4      = regexp.MustCompile(`^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$`)
	reIface     = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,15}$`)
	reSocksAddr = regexp.MustCompile(`^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$`)
	reCIDR      = regexp.MustCompile(`^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})$`)
)

// IsIPv4 is a strict dotted-quad literal check (octets 0-255).
func IsIPv4(s string) bool {
	m := reIPv4.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	for _, o := range m[1:] {
		if n, _ := strconv.Atoi(o); n > 255 {
			return false
		}
	}
	return true
}

// IsValidInterfaceName: alphanumeric/underscore/hyphen, 1-15 chars.
func IsValidInterfaceName(s string) bool { return reIface.MatchString(s) }

// IsValidSocksAddr: `ipv4:port`, port 1-65535.
func IsValidSocksAddr(s string) bool {
	m := reSocksAddr.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	port, err := strconv.Atoi(m[2])
	if err != nil {
		return false
	}
	return IsIPv4(m[1]) && port > 0 && port <= 65535
}

// IsAllowedBypassCidr: a well-formed IPv4 CIDR safe to install as a split-tunnel
// bypass route. Rejects the default-route swallow vectors (`/0`, `0.0.0.0/x`) and
// out-of-range octets/prefixes.
func IsAllowedBypassCidr(cidr string) bool {
	m := reCIDR.FindStringSubmatch(strings.TrimSpace(cidr))
	if m == nil {
		return false
	}
	allZero := true
	for _, o := range m[1:5] {
		n, _ := strconv.Atoi(o)
		if n > 255 {
			return false
		}
		if n != 0 {
			allZero = false
		}
	}
	prefix, _ := strconv.Atoi(m[5])
	if prefix < 1 || prefix > 32 {
		return false
	}
	return !allZero // 0.0.0.0/x — would bypass the whole tunnel
}

// DNS resolvers the app may switch the system to. Re-checked here because a
// socket client is untrusted: a local attacker must not be able to point DNS at
// their own resolver.
var allowedDnsResolvers = set("1.1.1.1", "1.0.0.1", "8.8.8.8", "9.9.9.9", "45.90.28.0")

// IsAllowedDnsResolver reports whether ip is on the resolver allow-list.
func IsAllowedDnsResolver(ip string) bool { return allowedDnsResolvers[ip] }
