package ops

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The native awg-up / awg-down are a behavioural reimplementation of wg-quick(8)
// around the embedded device, not an argv-faithful port of a script, so they get
// an AUTHORED sequence test rather than a golden transcript captured from the bash
// helper: this is the command sequence the design specifies, and the container
// handshake (Phase 3a step 6) is what proves that sequence is sufficient on a real
// kernel. cfgAWG (the guard corpus's clean.conf) carries a v4 and a v6 Address, a
// three-entry DNS list and both /0 AllowedIPs, so every branch is exercised.

// assertSeq compares two command sequences and renders diffLines' side-by-side
// view only on a mismatch (diffLines itself always renders; the parity test guards
// it the same way).
func assertSeq(t *testing.T, what string, want, got []string) {
	t.Helper()
	if strings.Join(want, "\n") != strings.Join(got, "\n") {
		t.Fatalf("%s:\n%s", what, diffLines(want, got))
	}
}

func TestAmneziaWgUpNativeSequence(t *testing.T) {
	f := newFake(t)
	ctx := context.Background()
	// The bindir is accepted and ignored: this one does not exist and would have
	// been refused as "invalid bin dir" before the device was embedded.
	if err := AmneziaWgUp(ctx, f.Env, cfgAWG, "/nonexistent/bindir"); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"ip link delete sntl0",                        // clean slate
		"katacomb-vpn-helper _amneziawg <sntl0.conf>", // the embedded device, self-exec'd
		"ip -4 address add 10.8.0.5/32 dev sntl0",
		"ip -6 address add fd00::5/128 dev sntl0",
		"ip link set mtu 1420 up dev sntl0", // eth0's 1500 - 80; the `up` starts the device
		"resolvconf -a sntl0 -m 0 -x",       // an exec, so /resolvconf/i still holds
		"ip -4 rule add not fwmark 51820 table 51820",
		"ip -4 rule add table main suppress_prefixlength 0",
		"ip -4 route add 0.0.0.0/0 dev sntl0 table 51820",
		"ip -6 rule add not fwmark 51820 table 51820",
		"ip -6 rule add table main suppress_prefixlength 0",
		"ip -6 route add ::/0 dev sntl0 table 51820",
	}
	assertSeq(t, "awg-up command sequence", want, f.takeCmds())
	if !f.hasLink("sntl0") {
		t.Fatal("sntl0 must exist after awg-up")
	}
	if f.wgtype {
		t.Fatal("a userspace AmneziaWG sntl0 must not be kernel wireguard type")
	}
	// The pid the device was spawned with is what awg-down will SIGTERM.
	state, err := os.ReadFile(f.runPath(awgStateName))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(state)); got != strconv.Itoa(f.nextPid) {
		t.Fatalf("awg.state = %q, want the spawned pid %d", got, f.nextPid)
	}
	// resolvconf got exactly wg-quick(8)'s payload: one nameserver line per entry.
	if want := "nameserver 10.8.0.1\nnameserver 1.0.0.1\nnameserver 1.1.1.1\n"; f.resolvconfStdin != want {
		t.Fatalf("resolvconf stdin = %q, want %q", f.resolvconfStdin, want)
	}
	// The one load-bearing piece of awg-quick's firewall: rp_filter must honour
	// the fwmark, or the tunnel's own outer UDP is dropped on strict hosts.
	if b, err := os.ReadFile(filepath.Join(f.root, "proc/sys/net/ipv4/conf/all/src_valid_mark")); err != nil || string(b) != "1\n" {
		t.Fatalf("src_valid_mark = %q, %v; want \"1\\n\"", b, err)
	}
	if fi, err := os.Stat(f.runPath(wgConfName)); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("sntl0.conf must be written 0600, got %v %v", fi, err)
	}
	if len(f.warns) != 0 {
		t.Errorf("no warnings expected, got %q", f.warns)
	}
}

func TestAmneziaWgDownNativeSequence(t *testing.T) {
	f := newFake(t)
	ctx := context.Background()
	if err := AmneziaWgUp(ctx, f.Env, cfgAWG, "-"); err != nil {
		t.Fatal(err)
	}
	pid := f.nextPid
	f.takeCmds()
	f.takeKills()

	if err := AmneziaWgDown(ctx, f.Env); err != nil {
		t.Fatal(err)
	}
	// resolvconf is undone FIRST (while the interface still exists), then the link
	// goes; cleanupWgRules' probes are queries and drop out of the normalised view.
	want := []string{
		"resolvconf -d sntl0 -f",
		"ip link delete sntl0",
	}
	assertSeq(t, "awg-down command sequence", want, f.takeCmds())
	if k := strings.Join(f.takeKills(), ","); !strings.Contains(k, fmt.Sprintf("%d:15", pid)) {
		t.Errorf("awg-down must SIGTERM the pid in awg.state, kills = %q", k)
	}
	if f.hasLink("sntl0") {
		t.Fatal("awg-down must remove sntl0")
	}
	for _, name := range []string{awgStateName, wgConfName} {
		if fileExists(f.runPath(name)) {
			t.Errorf("%s must be removed by awg-down", name)
		}
	}
}

// A failure after the device is up must leave nothing behind (awg-quick's
// `trap 'del_if; exit'`), and a missing resolvconf must still surface as
// `resolvconf` in the error so the app offers the DNS-less retry.
func TestAmneziaWgUpMissingResolvconfTearsDownAndNamesIt(t *testing.T) {
	f := newFake(t)
	ctx := context.Background()
	f.LookPath = func(name string) (string, error) {
		if name == "resolvconf" {
			return "", errors.New("not found")
		}
		return name, nil
	}
	err := AmneziaWgUp(ctx, f.Env, cfgAWG, "-")
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "resolvconf") {
		t.Fatalf("want an error naming resolvconf, got %v", err)
	}
	pid := f.nextPid
	if f.hasLink("sntl0") {
		t.Fatal("a half-built tunnel must be torn down")
	}
	if fileExists(f.runPath(awgStateName)) || fileExists(f.runPath(wgConfName)) {
		t.Fatal("state must not survive a failed bring-up")
	}
	if k := strings.Join(f.takeKills(), ","); !strings.Contains(k, fmt.Sprintf("%d:15", pid)) {
		t.Errorf("the device must be SIGTERMed on failure, kills = %q", k)
	}
}

// The guard is still the trust boundary: a PostUp line is refused before any tool
// runs and before the device is ever started.
func TestAmneziaWgUpRejectsPostUpWithoutRunningAnything(t *testing.T) {
	f := newFake(t)
	cfg := []byte(strings.Replace(string(cfgAWG), "Jc = 4", "PostUp = /bin/sh", 1))
	if err := AmneziaWgUp(context.Background(), f.Env, cfg, "-"); err == nil {
		t.Fatal("PostUp must be refused")
	}
	if cmds := f.takeCmds(); len(cmds) != 0 {
		t.Fatalf("nothing may run for a rejected config, got %q", cmds)
	}
	if f.hasLink("sntl0") {
		t.Fatal("no device may be started for a rejected config")
	}
}

// awg-down with no awg.state (a crash, or an upgrade that wiped /run) falls back
// to a /proc scan that signals ONLY our own `_amneziawg` processes — never a
// process-name match (deviation 4, as tun-down does for `_tun2socks`).
func TestAmneziaWgDownWithoutStateReapsByIdentityOnly(t *testing.T) {
	f := newFake(t)
	ctx := context.Background()
	if err := AmneziaWgUp(ctx, f.Env, cfgAWG, "-"); err != nil {
		t.Fatal(err)
	}
	f.takeCmds()
	f.takeKills()
	removeQuiet(f.runPath(awgStateName))
	self, _ := f.Executable()
	plant := func(pid int, exe string, argv ...string) {
		dir := filepath.Join(f.root, "proc", strconv.Itoa(pid))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "cmdline"), []byte(strings.Join(argv, "\x00")+"\x00"), 0o444); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(exe, filepath.Join(dir, "exe")); err != nil {
			t.Fatal(err)
		}
	}
	plant(900, self, "katacomb-vpn-helper", "_amneziawg", "/run/katacomb-vpn/sntl0.conf")              // ours: kill
	plant(901, filepath.Join(f.root, "usr/sbin/openvpn"), "openvpn", "_amneziawg", "/x")               // wrong executable
	plant(902, self, "katacomb-vpn-helper", "daemon")                                                  // our binary, not the sub-mode
	plant(903, filepath.Join(f.root, "usr/sbin/openvpn"), "bash", "-c", "echo _amneziawg")             // a name match
	plant(904, self+" (deleted)", "katacomb-vpn-helper", "_amneziawg", "/run/katacomb-vpn/sntl0.conf") // from before an upgrade

	if err := AmneziaWgDown(ctx, f.Env); err != nil {
		t.Fatal(err)
	}
	if k := strings.Join(f.takeKills(), ","); k != "900:15,904:15" {
		t.Errorf("must kill exactly our own _amneziawg processes, got %q", k)
	}
}

// MTU falls back through the default route and then to 1500 - 80 when the
// endpoint's route reports nothing usable.
func TestAmneziaWgMTUFallbacks(t *testing.T) {
	f := newFake(t)
	ctx := context.Background()
	// The fake answers `route get` with `dev eth0` and eth0 with mtu 1500.
	if got := awgMTU(ctx, f.Env, "ip", "203.0.113.10"); got != 1420 {
		t.Fatalf("mtu via endpoint route = %d, want 1420", got)
	}
	// No endpoint at all: the default route (also eth0) is consulted instead.
	if got := awgMTU(ctx, f.Env, "ip", ""); got != 1420 {
		t.Fatalf("mtu via default route = %d, want 1420", got)
	}
	// A route line carrying its own mtu wins over the dev lookup.
	if got := routeDevMTU(ctx, f.Env, "ip", "203.0.113.10 via 192.168.1.1 dev ppp0 mtu 1492 src 10.0.0.2"); got != 1492 {
		t.Fatalf("inline mtu = %d, want 1492", got)
	}
}

func TestParseAwgDirectives(t *testing.T) {
	d, err := parseAwgDirectives(cfgAWG)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(d.addresses, ","); got != "10.8.0.5/32,fd00::5/128" {
		t.Errorf("addresses = %q", got)
	}
	if got := strings.Join(d.nameservers, ","); got != "10.8.0.1,1.0.0.1,1.1.1.1" {
		t.Errorf("nameservers = %q", got)
	}
	if len(d.searches) != 0 || d.endpointIP != "203.0.113.10" || !d.hasV4Default || !d.hasV6Default {
		t.Errorf("directives = %+v", d)
	}
	// A DNS entry that is not an address is a search domain (wg-quick(8)).
	d2, err := parseAwgDirectives([]byte(strings.Replace(string(cfgAWG), "DNS = 10.8.0.1,1.0.0.1,1.1.1.1", "DNS = 1.1.1.1,corp.example", 1)))
	if err != nil || strings.Join(d2.nameservers, ",") != "1.1.1.1" || strings.Join(d2.searches, ",") != "corp.example" {
		t.Errorf("search domain handling: %+v %v", d2, err)
	}
	// [v6]:port endpoints lose their brackets and port.
	if h := endpointHost("[2001:db8::1]:51820"); h != "2001:db8::1" {
		t.Errorf("endpointHost v6 = %q", h)
	}
	if _, err := parseAwgDirectives([]byte("[Interface]\nPrivateKey = x\n[Peer]\nEndpoint = 1.2.3.4:1\n")); err == nil {
		t.Error("a config with no Address must be refused")
	}
}

// A config that names its MTU (the 3.1 tier's 1280) gets that, not the path MTU.
func TestAmneziaWgUpHonoursConfigMTU(t *testing.T) {
	f := newFake(t)
	cfg := []byte(strings.Replace(string(cfgAWG), "[Interface]\n", "[Interface]\nMTU = 1280\n", 1))
	if err := AmneziaWgUp(context.Background(), f.Env, cfg, "-"); err != nil {
		t.Fatal(err)
	}
	cmds := strings.Join(f.takeCmds(), "\n")
	if !strings.Contains(cmds, "ip link set mtu 1280 up dev sntl0") || strings.Contains(cmds, "mtu 1420") {
		t.Fatalf("config MTU not honoured:\n%s", cmds)
	}
}
