package ops

import (
	"context"
	"errors"
	"fmt"
	"os"

	"katacomb.vpn/daemon/internal/guard"
)

// copyPreservingLink is `cp -P src dst`: a symlink is recreated as a symlink (its
// target string copied verbatim, dangling or not), a file is copied with its mode.
func copyPreservingLink(src, dst string) error {
	fi, err := os.Lstat(src)
	if err != nil {
		return err
	}
	removeQuiet(dst)
	if fi.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return os.Symlink(target, dst)
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.WriteFile(dst, data, fi.Mode().Perm()); err != nil {
		return err
	}
	return os.Chmod(dst, fi.Mode().Perm())
}

// DnsSet points the system resolver at ip by replacing /etc/resolv.conf: resolver-
// manager-agnostic (systemd-resolved / resolvconf / NetworkManager) and, unlike a
// `resolvectl` call, guaranteed to route queries to ip rather than a LAN resolver
// the kill switch drops. Used for the tun2socks protocols and OpenVPN; wg-quick
// owns resolv.conf for WireGuard/AmneziaWG.
//
// The prior resolv.conf is snapshotted ONCE per session for an exact restore: the
// file/symlink via cp -P, or a marker file when there was none. The new file is
// written to a temp on the same filesystem and renamed, so there is never a window
// with no /etc/resolv.conf.
func DnsSet(ctx context.Context, e *Env, ip string) error {
	// The allow-list applies in BOTH modes (deviation 5): the app only ever sends
	// these, and a pkexec-authenticated caller must not be able to point every
	// lookup on the machine at a resolver of their choosing.
	if !guard.IsAllowedDnsResolver(ip) {
		return errors.New("DNS resolver not allowed")
	}
	return withLock(ctx, e, func() error {
		if err := ensurePersistDir(e); err != nil {
			return err
		}
		bak, none := e.persistPath("resolv.conf.bak"), e.persistPath("resolv.conf.none")
		resolv, tmp := e.path(resolvConf), e.path(resolvTmp)
		if !lexists(bak) && !fileExists(none) {
			if lexists(resolv) {
				if err := copyPreservingLink(resolv, bak); err != nil {
					return fmt.Errorf("backing up resolv.conf: %w", err)
				}
			} else if err := os.WriteFile(none, nil, 0o644); err != nil {
				return err
			}
		}
		if err := os.WriteFile(tmp, []byte("nameserver "+ip+"\n"), 0o644); err != nil {
			return err
		}
		if err := os.Chmod(tmp, 0o644); err != nil {
			return err
		}
		return os.Rename(tmp, resolv)
	})
}

// DnsRestore puts back the resolv.conf captured by DnsSet — the file/symlink, or
// the no-file state — via a temp + rename so a copy failure never leaves the host
// with no resolver. A no-op when there is nothing to restore. A copy failure is
// reported as a warning, not an error, matching the bash verb's exit 0; the
// backup is kept so a later teardown retries.
func DnsRestore(ctx context.Context, e *Env) error {
	return withLock(ctx, e, func() error {
		bak, none := e.persistPath("resolv.conf.bak"), e.persistPath("resolv.conf.none")
		resolv, tmp := e.path(resolvConf), e.path(resolvTmp)
		switch {
		case lexists(bak):
			if err := copyPreservingLink(bak, tmp); err != nil {
				e.Warn(fmt.Sprintf("could not restore resolv.conf from backup: %v", err))
				return nil
			}
			if err := os.Rename(tmp, resolv); err != nil {
				return err
			}
			removeQuiet(bak)
		case fileExists(none):
			removeQuiet(resolv)
			removeQuiet(none)
		}
		return nil
	})
}
