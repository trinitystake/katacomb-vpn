package ops

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
)

// SHA-256 pins of the bundled binaries root ever executes. The same values live
// in src/main/binary-integrity.ts (the app checks them before sending a request);
// pins_test.go parses that file and fails if the two drift. Update both when a
// vendored binary is replaced.
//
// Unlike the TypeScript table, an UNKNOWN name fails closed here: root has no
// business running a binary nobody pinned.
var pins = map[string]string{
	"amneziawg-go": "0462bc5fb229e90096ed4c5f46cff2c829e1b12d93b282c82fcd4aa955e44d7f",
	"awg":          "b069282e01b1cbaa3814be16e763af65cdb61fc4b613470216a59e8a26fa8188",
	"awg-quick":    "f4bb0f5d63665ade87f0cb9f2185c43515cff09868637eb311f98f65a318722c",
}

// VerifyPin hashes the file at path and compares it with the pin for name.
func VerifyPin(path, name string) error {
	want, ok := pins[name]
	if !ok {
		return fmt.Errorf("%s has no integrity pin", name)
	}
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("%s not found", name)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Errorf("%s could not be read", name)
	}
	if hex.EncodeToString(h.Sum(nil)) != want {
		return fmt.Errorf("%s failed SHA-256 integrity check", name)
	}
	return nil
}
