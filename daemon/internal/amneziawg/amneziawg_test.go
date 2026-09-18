package amneziawg

import (
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
)

// testKey is a deterministic 32-byte key as the INI carries it (base64) and as the
// UAPI wants it (hex), so the test asserts the exact transform with no fixture.
func testKey(seed byte) (b64, hexs string) {
	raw := make([]byte, keyLen)
	for i := range raw {
		raw[i] = seed + byte(i)
	}
	return base64.StdEncoding.EncodeToString(raw), hex.EncodeToString(raw)
}

// fullConfig is byte-for-byte the shape buildAmneziaWgConfig emits (see
// src/main/amneziawg-config.ts), with the values seen live on 2026-09-14.
func fullConfig(priv, pub string) string {
	return strings.Join([]string{
		"[Interface]",
		"Address = 10.155.181.6/32",
		"PrivateKey = " + priv,
		"DNS = 10.8.0.1,1.0.0.1,1.1.1.1",
		"Jc = 6",
		"Jmin = 80",
		"Jmax = 801",
		"S1 = 6",
		"S2 = 34",
		"S3 = 29",
		"S4 = 25",
		"H1 = 1946110278",
		"H2 = 1482572505",
		"H3 = 1589193487",
		"H4 = 2767998800",
		"I1 = <b 0xdeadbeef><r 16><t>",
		"",
		"[Peer]",
		"PublicKey = " + pub,
		"AllowedIPs = 0.0.0.0/0,::/0",
		"Endpoint = 23.94.214.210:17358",
		"PersistentKeepalive = 15",
		"",
	}, "\n")
}

func TestToUAPIFullConfigIsExact(t *testing.T) {
	priv64, privHex := testKey(1)
	pub64, pubHex := testKey(100)
	got, err := ToUAPI([]byte(fullConfig(priv64, pub64)))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{
		"private_key=" + privHex,
		"jc=6",
		"jmin=80",
		"jmax=801",
		"s1=6",
		"s2=34",
		"s3=29",
		"s4=25",
		"h1=1946110278",
		"h2=1482572505",
		"h3=1589193487",
		"h4=2767998800",
		"i1=<b 0xdeadbeef><r 16><t>",
		"fwmark=51820",
		"replace_peers=true",
		"public_key=" + pubHex,
		"replace_allowed_ips=true",
		"allowed_ip=0.0.0.0/0",
		"allowed_ip=::/0",
		"endpoint=23.94.214.210:17358",
		"persistent_keepalive_interval=15",
		"",
	}, "\n")
	if got != want {
		t.Fatalf("UAPI mismatch\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
	// The one non-trivial transform: 44 base64 chars in, 64 hex chars out.
	if len(privHex) != 64 || !strings.Contains(got, "private_key="+privHex) {
		t.Fatalf("private key not hex-encoded: %q", privHex)
	}
}

// Address and DNS are wg-quick(8) directives ops consumes; they must never reach
// the device. Whatever the app did to the DNS line — kept the node's list, replaced
// it (replaceDnsLines), or stripped it (the DNS-less retry) — the UAPI is identical.
func TestToUAPIIgnoresAddressAndDNS(t *testing.T) {
	priv64, _ := testKey(1)
	pub64, _ := testKey(100)
	base := fullConfig(priv64, pub64)
	variants := map[string]string{
		"node list": base,
		"replaced":  strings.Replace(base, "DNS = 10.8.0.1,1.0.0.1,1.1.1.1", "DNS = 1.1.1.1", 1),
		"stripped":  strings.Replace(base, "DNS = 10.8.0.1,1.0.0.1,1.1.1.1\n", "", 1),
		"two addrs": strings.Replace(base, "Address = 10.155.181.6/32", "Address = 10.155.181.6/32,fd00::6/128", 1),
	}
	want, err := ToUAPI([]byte(base))
	if err != nil {
		t.Fatal(err)
	}
	for name, cfg := range variants {
		got, err := ToUAPI([]byte(cfg))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got != want {
			t.Fatalf("%s: DNS/Address leaked into the UAPI\n%s", name, got)
		}
		if strings.Contains(got, "10.8.0.1") || strings.Contains(got, "10.155.181.6") {
			t.Fatalf("%s: address or DNS value in UAPI", name)
		}
	}
}

func TestToUAPIWithoutSignaturePackets(t *testing.T) {
	priv64, _ := testKey(1)
	pub64, _ := testKey(100)
	cfg := strings.Replace(fullConfig(priv64, pub64), "I1 = <b 0xdeadbeef><r 16><t>\n", "", 1)
	got, err := ToUAPI([]byte(cfg))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "i1=") {
		t.Fatalf("i1 emitted with no I1 in the config:\n%s", got)
	}
}

// Device lines precede the first peer, and replace_allowed_ips sits immediately
// after public_key so a stale allowed-ip can never survive a reconfigure.
func TestToUAPIOrdering(t *testing.T) {
	priv64, _ := testKey(1)
	pub64, pubHex := testKey(100)
	got, err := ToUAPI([]byte(fullConfig(priv64, pub64)))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(got, "\n"), "\n")
	firstPeer := -1
	for i, l := range lines {
		if strings.HasPrefix(l, "public_key=") {
			firstPeer = i
			break
		}
	}
	if firstPeer < 0 {
		t.Fatal("no public_key line")
	}
	for _, l := range lines[:firstPeer] {
		k, _, _ := strings.Cut(l, "=")
		switch k {
		case "allowed_ip", "endpoint", "persistent_keepalive_interval", "replace_allowed_ips", "preshared_key":
			t.Fatalf("peer key %q before the first public_key", k)
		}
	}
	if lines[firstPeer] != "public_key="+pubHex || lines[firstPeer+1] != "replace_allowed_ips=true" {
		t.Fatalf("replace_allowed_ips must directly follow public_key, got %q then %q", lines[firstPeer], lines[firstPeer+1])
	}
	if lines[firstPeer-1] != "replace_peers=true" || lines[firstPeer-2] != FwmarkLine {
		t.Fatalf("fwmark + replace_peers must close the device section, got %q, %q", lines[firstPeer-2], lines[firstPeer-1])
	}
}

// The optional wg(8) keys our config never emits are still translated correctly,
// keys are case-insensitive, and comments / blank lines are ignored.
func TestToUAPIOptionalKeysAndSyntax(t *testing.T) {
	priv64, privHex := testKey(1)
	pub64, pubHex := testKey(100)
	psk64, pskHex := testKey(200)
	cfg := strings.Join([]string{
		"# leading comment",
		"[interface]",
		"privatekey = " + priv64 + "   # trailing comment",
		"LISTENPORT = 51000",
		"",
		"[PEER]",
		"publickey=" + pub64,
		"PresharedKey = " + psk64,
		"AllowedIPs = 10.0.0.0/8 , 192.168.0.0/16",
		"Endpoint = [2001:db8::1]:51820",
	}, "\n")
	got, err := ToUAPI([]byte(cfg))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"private_key=" + privHex,
		"listen_port=51000",
		"public_key=" + pubHex,
		"preshared_key=" + pskHex,
		"allowed_ip=10.0.0.0/8",
		"allowed_ip=192.168.0.0/16",
		"endpoint=[2001:db8::1]:51820",
	} {
		if !strings.Contains(got, want+"\n") {
			t.Fatalf("missing %q in\n%s", want, got)
		}
	}
}

func TestToUAPIRejects(t *testing.T) {
	priv64, _ := testKey(1)
	pub64, _ := testKey(100)
	good := fullConfig(priv64, pub64)
	short := base64.StdEncoding.EncodeToString(make([]byte, keyLen-1))
	cases := map[string]string{
		"empty":                  "",
		"no PrivateKey":          strings.Replace(good, "PrivateKey = "+priv64+"\n", "", 1),
		"bad base64 key":         strings.Replace(good, priv64, "not*base64*at*all", 1),
		"31-byte key":            strings.Replace(good, priv64, short, 1),
		"PostUp (root shell)":    strings.Replace(good, "Jc = 6", "PostUp = /bin/sh", 1),
		"FwMark in Interface":    strings.Replace(good, "Jc = 6", "FwMark = 1", 1),
		"unknown peer key":       strings.Replace(good, "PersistentKeepalive = 15", "PostDown = x", 1),
		"peer without PublicKey": strings.Replace(good, "PublicKey = "+pub64+"\n", "", 1),
		"key before section":     "PrivateKey = " + priv64 + "\n" + good,
		"unknown section":        strings.Replace(good, "[Peer]", "[Route]", 1),
		"non-numeric jc":         strings.Replace(good, "Jc = 6", "Jc = six", 1),
		"empty value":            strings.Replace(good, "Jc = 6", "Jc =", 1),
		"no equals":              strings.Replace(good, "Jc = 6", "Jc 6", 1),
		"second PublicKey":       strings.Replace(good, "Endpoint =", "PublicKey = "+pub64+"\nEndpoint =", 1),
	}
	for name, cfg := range cases {
		_, err := ToUAPI([]byte(cfg))
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		// Never a value in the error: the engine runs as root and key material
		// must not be able to reach any log or stderr through a message.
		for _, secret := range []string{priv64, pub64, short} {
			if strings.Contains(err.Error(), secret) {
				t.Errorf("%s: error echoes a key: %v", name, err)
			}
		}
	}
}

// A malformed line is reported by line number, so a bug is locatable without the
// content ever being printed.
func TestToUAPIErrorsCarryLineNumbers(t *testing.T) {
	priv64, _ := testKey(1)
	pub64, _ := testKey(100)
	cfg := strings.Replace(fullConfig(priv64, pub64), "S3 = 29", "S3 = twenty-nine", 1)
	_, err := ToUAPI([]byte(cfg))
	if err == nil || !strings.HasPrefix(err.Error(), "line 10:") {
		t.Fatalf("want a 'line 10:' error, got %v", err)
	}
}

// tierThreeConfig is fullConfig with the 3.1 tier's keys, as the builder emits
// them for a node that answered awg_version 3.
func tierThreeConfig(priv, pub, header string) string {
	return strings.Replace(fullConfig(priv, pub), "I1 = <b 0xdeadbeef><r 16><t>\n",
		"I1 = <b 0xdeadbeef><r 16><t>\nMTU = 1280\nHeaderProtectionKey = "+header+
			"\nRandomTrailers = on\nContentPaddingAddition = 0-32\n", 1)
}

func TestToUAPITierThreeKeys(t *testing.T) {
	priv64, _ := testKey(1)
	pub64, _ := testKey(100)
	header64, headerHex := testKey(200)
	got, err := ToUAPI([]byte(tierThreeConfig(priv64, pub64, header64)))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"header_protection_key=" + headerHex + "\n",
		"random_trailers=true\n",
		"content_padding_addition=0-32\n",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in\n%s", want, got)
		}
	}
	// MTU stays with ops, and the key must have become hex.
	if strings.Contains(got, "mtu") || strings.Contains(got, header64) {
		t.Fatalf("MTU or base64 key leaked into the UAPI:\n%s", got)
	}
	if strings.Index(got, "i1=") > strings.Index(got, "header_protection_key=") {
		t.Fatalf("device lines must keep the INI's order:\n%s", got)
	}
}

func TestToUAPIRejectsMalformedTierThreeValues(t *testing.T) {
	priv64, _ := testKey(1)
	pub64, _ := testKey(100)
	header64, _ := testKey(200)
	base := tierThreeConfig(priv64, pub64, header64)
	for name, cfg := range map[string]string{
		"short header key": strings.Replace(base, header64, base64.StdEncoding.EncodeToString(make([]byte, 31)), 1),
		"trailers word":    strings.Replace(base, "RandomTrailers = on", "RandomTrailers = maybe", 1),
		"padding shape":    strings.Replace(base, "ContentPaddingAddition = 0-32", "ContentPaddingAddition = 32-", 1),
		"padding words":    strings.Replace(base, "ContentPaddingAddition = 0-32", "ContentPaddingAddition = lots", 1),
	} {
		if _, err := ToUAPI([]byte(cfg)); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
}
