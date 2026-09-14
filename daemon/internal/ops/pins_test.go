package ops

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// The app (src/main/binary-integrity.ts) and root (pins.go) must agree on every
// hash root executes, or the app sends a request root then refuses. This parses
// the TypeScript table rather than trusting anyone to update both.
func TestPinsMatchBinaryIntegrityTs(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "src", "main", "binary-integrity.ts"))
	if err != nil {
		t.Skipf("binary-integrity.ts not found (running outside the repo?): %v", err)
	}
	re := regexp.MustCompile(`(?m)^\s*'?([A-Za-z0-9-]+)'?:\s*'([0-9a-f]{64})',`)
	ts := map[string]string{}
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		ts[m[1]] = m[2]
	}
	if len(ts) == 0 {
		t.Fatal("parsed no pins out of binary-integrity.ts; the regex or the file layout changed")
	}
	for name, want := range pins {
		got, ok := ts[name]
		if !ok {
			t.Errorf("pins.go pins %q but binary-integrity.ts does not", name)
			continue
		}
		if got != want {
			t.Errorf("%s: pins.go has %s, binary-integrity.ts has %s", name, want, got)
		}
	}
}

// The vendored binaries in the tree must hash to the pins (the same check the
// build of the deb relies on).
func TestVendoredBinariesMatchPins(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "resources", "linux", "bin")
	if _, err := os.Stat(dir); err != nil {
		t.Skip("resources/linux/bin not present")
	}
	for name := range pins {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s: not vendored at %s", name, p)
			continue
		}
		if err := VerifyPin(p, name); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestVerifyPinFailsClosed(t *testing.T) {
	f := filepath.Join(t.TempDir(), "x")
	if err := os.WriteFile(f, []byte("hello"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := VerifyPin(f, "not-a-pinned-name"); err == nil {
		t.Fatal("an unpinned name must fail")
	}
	if err := VerifyPin(f, "tun2socks"); err == nil {
		t.Fatal("a wrong hash must fail")
	}
	if err := VerifyPin(filepath.Join(t.TempDir(), "missing"), "tun2socks"); err == nil {
		t.Fatal("a missing file must fail")
	}
	sum := sha256.Sum256([]byte("hello"))
	if hex.EncodeToString(sum[:]) == pins["tun2socks"] {
		t.Fatal("test fixture collides with a real pin")
	}
}
