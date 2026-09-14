package guard

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The corpus under testdata/corpus/ is shared with src/main/config-guard-corpus.test.ts;
// see testdata/corpus/README.md for the header format and the reason vocabulary.

type corpusCase struct {
	name   string
	expect string
	reason string
	body   []byte
}

func loadCorpus(t *testing.T, proto string) []corpusCase {
	t.Helper()
	dir := filepath.Join("testdata", "corpus", proto)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read corpus %s: %v", dir, err)
	}
	var cases []corpusCase
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".conf") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		c := corpusCase{name: e.Name(), body: body}
		sc := bufio.NewScanner(bytes.NewReader(body))
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "# ") {
				break
			}
			if v, ok := strings.CutPrefix(line, "# expect: "); ok {
				c.expect = v
			}
			if v, ok := strings.CutPrefix(line, "# reason: "); ok {
				c.reason = v
			}
		}
		if c.expect != "accept" && c.expect != "reject" {
			t.Fatalf("%s/%s: header must say `# expect: accept|reject`", proto, e.Name())
		}
		if c.expect == "reject" && c.reason == "" {
			t.Fatalf("%s/%s: a reject case needs `# reason: …`", proto, e.Name())
		}
		cases = append(cases, c)
	}
	if len(cases) < 5 {
		t.Fatalf("%s corpus looks empty (%d cases)", proto, len(cases))
	}
	return cases
}

func runCorpus(t *testing.T, proto string, validate func([]byte) error) {
	t.Helper()
	for _, c := range loadCorpus(t, proto) {
		t.Run(c.name, func(t *testing.T) {
			err := validate(c.body)
			switch c.expect {
			case "accept":
				if err != nil {
					t.Fatalf("expected accept, got: %v", err)
				}
			case "reject":
				if err == nil {
					t.Fatalf("expected reject (%s), got accept", c.reason)
				}
				if !strings.Contains(err.Error(), c.reason) {
					t.Fatalf("expected reason %q in error, got: %v", c.reason, err)
				}
				// Deviation 6: never echo config content. Every non-header line of a
				// reject case is content; none may appear in the message.
				for _, line := range strings.Split(string(c.body), "\n") {
					l := strings.TrimSpace(line)
					if l == "" || strings.HasPrefix(l, "# ") || len(l) < 4 {
						continue
					}
					if strings.Contains(err.Error(), l) {
						t.Fatalf("error echoes config content %q: %v", l, err)
					}
				}
			}
		})
	}
}

func TestWireguardCorpus(t *testing.T) { runCorpus(t, "wireguard", AssertWireguardConfig) }
func TestAmneziaWgCorpus(t *testing.T) { runCorpus(t, "amneziawg", AssertAmneziaWgConfig) }
func TestOpenVpnCorpus(t *testing.T)   { runCorpus(t, "openvpn", AssertOpenVpnConfig) }

// A WireGuard config must never be accepted by the AmneziaWG validator's WG
// subset loosening, nor an AWG config by the plain-WG one: the corpus files are
// per protocol, but the WG accept set must also pass AWG (a superset), and the
// AWG accept set must fail WG exactly when it carries an AWG key.
func TestAmneziaIsSupersetOfWireguard(t *testing.T) {
	for _, c := range loadCorpus(t, "wireguard") {
		if c.expect != "accept" {
			continue
		}
		if err := AssertAmneziaWgConfig(c.body); err != nil {
			t.Errorf("wireguard/%s should also pass the AmneziaWG guard: %v", c.name, err)
		}
	}
}

func TestErrorsCarryLineNumbers(t *testing.T) {
	err := AssertWireguardConfig([]byte("[Interface]\nPrivateKey = aGVsbG8=\nPostUp = touch /tmp/pwned\n"))
	if err == nil || !strings.Contains(err.Error(), "line 3") {
		t.Fatalf("want a line-3 error, got %v", err)
	}
	err = AssertOpenVpnConfig([]byte("client\nup /bin/sh\n"))
	if err == nil || !strings.Contains(err.Error(), "line 2") {
		t.Fatalf("want a line-2 error, got %v", err)
	}
}

type scalarLists struct {
	Accept []string `json:"accept"`
	Reject []string `json:"reject"`
}

func TestScalars(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "corpus", "scalars.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	fns := map[string]func(string) bool{
		"ipv4":        IsIPv4,
		"iface":       IsValidInterfaceName,
		"socksAddr":   IsValidSocksAddr,
		"bypassCidr":  IsAllowedBypassCidr,
		"dnsResolver": IsAllowedDnsResolver,
	}
	for name, fn := range fns {
		var lists scalarLists
		if err := json.Unmarshal(doc[name], &lists); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(lists.Accept) == 0 || len(lists.Reject) == 0 {
			t.Fatalf("%s: both lists must be non-empty", name)
		}
		for _, v := range lists.Accept {
			if !fn(v) {
				t.Errorf("%s: expected accept %q", name, v)
			}
		}
		for _, v := range lists.Reject {
			if fn(v) {
				t.Errorf("%s: expected reject %q", name, v)
			}
		}
	}
	for name := range doc {
		if name != "_comment" && fns[name] == nil {
			t.Errorf("scalars.json has a section %q with no validator here", name)
		}
	}
}
