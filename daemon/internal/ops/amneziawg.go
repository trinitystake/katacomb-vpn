package ops

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"katacomb.vpn/daemon/internal/guard"
)

var awgTrio = []string{"awg", "awg-quick", "amneziawg-go"}

// verifyAwgBinDir accepts a directory only if it holds all three executables AND
// each matches its pin. Root-run binaries fail closed: there is no system-PATH
// fallback for AmneziaWG anywhere in the app.
func verifyAwgBinDir(e *Env, dir string) error {
	if dir == "" {
		return errors.New("invalid bin dir")
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return errors.New("invalid bin dir")
	}
	for _, b := range awgTrio {
		p := filepath.Join(dir, b)
		if !isExecutableFile(p) {
			return fmt.Errorf("%s missing from bin dir", b)
		}
		if err := e.VerifyPin(p, b); err != nil {
			return err
		}
	}
	return nil
}

// AmneziaWgUp validates an AmneziaWG config, writes it to RunDir/sntl0.conf (the
// same file as WireGuard: one tunnel at a time) and runs the bundled awg-quick on
// it with the bindir first on PATH, so its bare-name calls to `awg` and
// `amneziawg-go` resolve to the pinned trio and nothing else.
func AmneziaWgUp(ctx context.Context, e *Env, config []byte, binDir string) error {
	if err := guard.AssertAmneziaWgConfig(config); err != nil {
		return err
	}
	if err := verifyAwgBinDir(e, binDir); err != nil {
		return err
	}
	return withLock(ctx, e, func() error {
		path, err := writeConfig(e, wgConfName, config)
		if err != nil {
			return err
		}
		return run(ctx, e, RunOpt{PathPrefix: binDir}, filepath.Join(binDir, "awg-quick"), "up", path)
	})
}

// AmneziaWgDown deletes the link (amneziawg-go exits when its TUN goes), repairs
// the rule pair awg-quick leaked exactly like wg-quick, and removes the config.
func AmneziaWgDown(ctx context.Context, e *Env) error {
	return withLock(ctx, e, func() error {
		ip, err := tool(e, "ip")
		if err != nil {
			return err
		}
		runQuiet(ctx, e, ip, "link", "delete", wgIface)
		cleanupWgRules(ctx, e, ip)
		removeQuiet(e.runPath(wgConfName))
		return nil
	})
}
