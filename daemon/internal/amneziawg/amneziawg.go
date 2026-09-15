// Package amneziawg is the hidden `_amneziawg` sub-mode: the AmneziaWG userspace
// device (github.com/amnezia-vpn/amneziawg-go, at the exact commit sentinel-dvpnx
// pins — AmneziaWG 2.0, the protocol every Sentinel node speaks) linked into the
// helper. `awg-up` self-execs `katacomb-vpn-helper _amneziawg <config>` detached, so
// root runs a binary at a real filesystem path (/usr/local/bin) instead of the three
// vendored executables it used to be handed — which on the AppImage was a bindir on
// a FUSE mount root cannot read, and left AmneziaWG broken there.
//
// This replaces BOTH `amneziawg-go` (the device: run in-process here) and `awg` (the
// config tool: `awg setconf` translates the wg(8) INI into the WireGuard UAPI, which
// ToUAPI does and hands straight to device.IpcSet). awg-quick's remaining work —
// addresses, MTU, routes, the fwmark rule pair, resolvconf, the anti-spoof firewall —
// lives in internal/ops as a behavioural reimplementation of wg-quick(8), never a
// port: amneziawg-tools is GPL-2.0-only and this app is GPL-3.0-or-later, so the
// tools' code cannot be translated into it. ToUAPI is written from the UAPI
// cross-platform spec and checked against the device's own parser (device/uapi.go),
// which is MIT like the rest of amneziawg-go.
//
// Everything is hardcoded except the config path: the interface is sntl0, the log
// level silent, the fwmark 51820 (the first table wg-quick(8) tries, and the bottom
// of the range ops.cleanupWgRules already treats as ours), and no UAPI socket is ever
// opened. The device is configured once, here, and is driven UP by the OS link state
// when ops runs `ip link set … up` — the same event awg-quick's own `ip link set`
// produces. Every value awg-quick would have read back over the socket (fwmark,
// endpoints, allowed-ips) ops already knows from the config it validated.
package amneziawg

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/amnezia-vpn/amneziawg-go/conn"
	"github.com/amnezia-vpn/amneziawg-go/device"
	"github.com/amnezia-vpn/amneziawg-go/tun"
)

const (
	// Iface is the tunnel interface, shared with kernel WireGuard: a userspace
	// AmneziaWG sntl0 is `type tun`, not `type wireguard`, which is what the app's
	// sntl0IsKernelWireGuard() discriminates on.
	Iface = "sntl0"
	// Fwmark is set on the device's UDP socket so the `not fwmark 51820 table 51820`
	// rule ops installs steers the tunnel's own traffic around the tunnel.
	Fwmark = 51820
	// keyLen is a Curve25519 key: 32 bytes, 44 base64 chars, 64 hex chars.
	keyLen = 32
)

// UAPI lines the translator injects; exported so ops and the tests share them.
var (
	FwmarkLine = fmt.Sprintf("fwmark=%d", Fwmark)
)

var errNoPrivateKey = errors.New("no PrivateKey in [Interface]")

// deviceKeys maps the wg(8) [Interface] directives that ARE device keys to their
// UAPI names. Address, DNS, MTU and Table are wg-quick(8) directives, handled by
// ops, and are skipped (not rejected) here; anything else is refused.
var deviceKeys = map[string]string{
	"privatekey": "private_key",
	"listenport": "listen_port",
	"jc":         "jc",
	"jmin":       "jmin",
	"jmax":       "jmax",
	"s1":         "s1",
	"s2":         "s2",
	"s3":         "s3",
	"s4":         "s4",
	"h1":         "h1",
	"h2":         "h2",
	"h3":         "h3",
	"h4":         "h4",
	"i1":         "i1",
	"i2":         "i2",
	"i3":         "i3",
	"i4":         "i4",
	"i5":         "i5",
}

var skippedInterfaceKeys = map[string]bool{
	"address": true, "dns": true, "mtu": true, "table": true,
}

// keyValued are the INI keys whose value is a base64 key that becomes hex.
var keyValued = map[string]bool{"privatekey": true, "publickey": true, "presharedkey": true}

// numeric are the INI keys whose value must parse as an unsigned decimal. The
// device enforces its own ranges (device/uapi.go); this only refuses non-numbers
// early so a malformed line fails here, by line, rather than inside IpcSet.
var numeric = map[string]bool{
	"listenport": true, "jc": true, "jmin": true, "jmax": true,
	"s1": true, "s2": true, "s3": true, "s4": true,
	"h1": true, "h2": true, "h3": true, "h4": true,
	"persistentkeepalive": true,
}

var peerKeys = map[string]string{
	"publickey":           "public_key",
	"presharedkey":        "preshared_key",
	"endpoint":            "endpoint",
	"persistentkeepalive": "persistent_keepalive_interval",
	// allowedips is expanded to one allowed_ip line per entry.
}

type peer struct {
	publicKey string // hex; "" until the PublicKey line is seen
	lines     []string
	startLine int
}

// ToUAPI translates a wg(8)-format INI — what buildAmneziaWgConfig emits and
// guard.AssertAmneziaWgConfig admits — into the `key=value\n` text device.IpcSet
// consumes. Device lines come first (in the INI's order, wherever [Interface]
// sections appear), then FwmarkLine and `replace_peers=true`, then each peer as
// `public_key=…`, `replace_allowed_ips=true`, and its remaining lines.
//
// Fails closed: an unknown key, section or malformed value is an error naming the
// line and the reason, never the value — the file is root-owned and ours, so a
// failure here is a bug to surface, and the engine's stderr must stay free of key
// material even though Spawn points it at /dev/null.
func ToUAPI(ini []byte) (string, error) {
	var (
		dev     []string
		peers   []*peer
		cur     *peer
		section string
		sawKey  bool
	)
	for n, raw := range strings.Split(string(ini), "\n") {
		line := n + 1
		text := strings.TrimSpace(raw)
		if i := strings.IndexByte(text, '#'); i >= 0 {
			text = strings.TrimSpace(text[:i])
		}
		if text == "" {
			continue
		}
		if strings.HasPrefix(text, "[") {
			switch strings.ToLower(text) {
			case "[interface]":
				section, cur = "interface", nil
			case "[peer]":
				section = "peer"
				cur = &peer{startLine: line}
				peers = append(peers, cur)
			default:
				return "", fmt.Errorf("line %d: unknown section", line)
			}
			continue
		}
		key, value, ok := strings.Cut(text, "=")
		if !ok {
			return "", fmt.Errorf("line %d: not a key = value line", line)
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		if value == "" {
			return "", fmt.Errorf("line %d: empty value", line)
		}
		switch section {
		case "interface":
			if skippedInterfaceKeys[key] {
				continue
			}
			uapiKey, known := deviceKeys[key]
			if !known {
				return "", fmt.Errorf("line %d: unknown [Interface] key", line)
			}
			v, err := translateValue(key, value)
			if err != nil {
				return "", fmt.Errorf("line %d: %w", line, err)
			}
			if key == "privatekey" {
				sawKey = true
			}
			dev = append(dev, uapiKey+"="+v)
		case "peer":
			if key == "allowedips" {
				for _, cidr := range strings.Split(value, ",") {
					cidr = strings.TrimSpace(cidr)
					if cidr == "" {
						return "", fmt.Errorf("line %d: empty AllowedIPs entry", line)
					}
					cur.lines = append(cur.lines, "allowed_ip="+cidr)
				}
				continue
			}
			uapiKey, known := peerKeys[key]
			if !known {
				return "", fmt.Errorf("line %d: unknown [Peer] key", line)
			}
			v, err := translateValue(key, value)
			if err != nil {
				return "", fmt.Errorf("line %d: %w", line, err)
			}
			if key == "publickey" {
				if cur.publicKey != "" {
					return "", fmt.Errorf("line %d: second PublicKey in one [Peer]", line)
				}
				cur.publicKey = v
				continue
			}
			cur.lines = append(cur.lines, uapiKey+"="+v)
		default:
			return "", fmt.Errorf("line %d: key before any section", line)
		}
	}
	if !sawKey {
		return "", errNoPrivateKey
	}
	var b strings.Builder
	for _, l := range dev {
		b.WriteString(l)
		b.WriteByte('\n')
	}
	b.WriteString(FwmarkLine)
	b.WriteByte('\n')
	b.WriteString("replace_peers=true\n")
	for _, p := range peers {
		if p.publicKey == "" {
			return "", fmt.Errorf("line %d: [Peer] without a PublicKey", p.startLine)
		}
		b.WriteString("public_key=" + p.publicKey + "\n")
		b.WriteString("replace_allowed_ips=true\n")
		for _, l := range p.lines {
			b.WriteString(l)
			b.WriteByte('\n')
		}
	}
	return b.String(), nil
}

// translateValue converts one INI value to its UAPI form: base64 keys become hex,
// numerics are checked to be unsigned decimals and passed through, everything
// else (endpoints, the I1–I5 signature tag chains) passes through verbatim.
func translateValue(key, value string) (string, error) {
	switch {
	case keyValued[key]:
		raw, err := base64.StdEncoding.DecodeString(value)
		if err != nil || len(raw) != keyLen {
			return "", errors.New("malformed key")
		}
		return hex.EncodeToString(raw), nil
	case numeric[key]:
		if _, err := strconv.ParseUint(value, 10, 32); err != nil {
			return "", errors.New("not an unsigned decimal")
		}
		return value, nil
	default:
		return value, nil
	}
}

// Run is the sub-mode: read the root-owned config at args[0], translate it, create
// the TUN, configure the device, and block until SIGTERM/SIGINT or until the device
// itself stops (ops deleting the link on awg-down). Returns the exit code. Needs
// root and /dev/net/tun; the translator is what the unit tests cover.
func Run(args []string, stderr io.Writer) int {
	if len(args) != 1 || args[0] == "" {
		fmt.Fprintln(stderr, "_amneziawg: usage: _amneziawg <config-path>")
		return 2
	}
	ini, err := os.ReadFile(args[0])
	if err != nil {
		fmt.Fprintf(stderr, "_amneziawg: reading config: %v\n", err)
		return 1
	}
	uapi, err := ToUAPI(ini)
	if err != nil {
		fmt.Fprintf(stderr, "_amneziawg: %v\n", err)
		return 1
	}
	tdev, err := tun.CreateTUN(Iface, device.DefaultMTU)
	if err != nil {
		fmt.Fprintf(stderr, "_amneziawg: creating %s: %v\n", Iface, err)
		return 1
	}
	dev := device.NewDevice(tdev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	if err := dev.IpcSet(uapi); err != nil {
		dev.Close()
		fmt.Fprintf(stderr, "_amneziawg: configuring device: %v\n", err)
		return 1
	}

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-sigs:
	case <-dev.Wait():
	}
	dev.Close()
	return 0
}
