// Package oneshot is the pkexec entry: `katacomb-vpn-helper <verb> <args…>`, the
// exact argv contract the bash helper had, mapped onto the ops package. Used by
// the AppImage and `npm run dev` (no daemon), by postrm's teardown, and by the
// app's fallback when the daemon socket is unreachable.
//
// The only thing this layer adds over the socket is how a config arrives: as a
// PATH the caller owns, not content. That path is read ONCE, safely, and the
// bytes go through the same ops call the daemon uses (deviation 6): open with
// O_NOFOLLOW, fstat (a regular file, owned by the pkexec caller when PKEXEC_UID
// is set, under the size cap), read, validate, and let ops write them to the
// root-owned /run/katacomb-vpn copy the tool is then handed. The bash helper
// validated the caller's path and then let wg-quick re-open it — a TOCTOU, and
// with a validator that echoed the offending line, a symlink to /etc/shadow was
// a root file-read oracle on stderr. Neither survives here.
package oneshot

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"katacomb.vpn/daemon/internal/guard"
	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/protocol"
)

// Usage is the bash helper's line, verbatim: postrm and humans rely on it.
const Usage = "Usage: katacomb-vpn-helper {up <config>|down|awg-up <config> <bindir>|awg-down|ovpn-up <config>|ovpn-down|tun-up <bin> <socks> <remote> <gw> <if>|tun-down|killswitch-on <iface> <host> [dns] [lan-sharing]|killswitch-off|dns-set <ip>|dns-restore}"

// Run executes one verb and returns the process exit code. Failures print
// `Error: <reason>` on stderr and return 1, as before.
func Run(args []string, e *ops.Env, stdout, stderr io.Writer) int {
	ctx, cancel := context.WithTimeout(context.Background(), ops.OpTimeout)
	defer cancel()
	arg := func(i int) string {
		if i < len(args) {
			return args[i]
		}
		return ""
	}
	verb := arg(0)

	var err error
	switch verb {
	case "up":
		var cfg []byte
		if cfg, err = readConfig(arg(1), "sntl0"); err == nil {
			err = ops.WireguardUp(ctx, e, cfg)
		}
	case "down":
		err = ops.WireguardDown(ctx, e)
	case "awg-up":
		var cfg []byte
		if cfg, err = readConfig(arg(1), "sntl0"); err == nil {
			err = ops.AmneziaWgUp(ctx, e, cfg, arg(2))
		}
	case "awg-down":
		err = ops.AmneziaWgDown(ctx, e)
	case "ovpn-up":
		var cfg []byte
		if cfg, err = readConfig(arg(1), ""); err == nil {
			err = ops.OpenVpnUp(ctx, e, cfg)
		}
	case "ovpn-down":
		err = ops.OpenVpnDown(ctx, e)
	case "tun-up":
		// $2 used to be the tun2socks binary and is IGNORED (the engine is embedded;
		// the slot stays so old and new apps share one argv contract), $3 = SOCKS
		// addr, $4 = remote server IP, $5 = gateway, $6 = interface, $7 = bypass
		// routes (optional CSV)
		socks := arg(2)
		if socks == "" {
			socks = "127.0.0.1:1080"
		}
		var bypass []string
		if csv := arg(6); csv != "" {
			bypass = strings.Split(csv, ",")
		}
		var pid int
		pid, err = ops.TunUp(ctx, e, ops.TunUpParams{
			SocksAddr: socks, RemoteHost: arg(3), Gateway: arg(4), Iface: arg(5), BypassRoutes: bypass,
		})
		if err == nil {
			fmt.Fprintln(stdout, pid)
		}
	case "tun-down":
		err = ops.TunDown(ctx, e)
	case "killswitch-on":
		// $2 = VPN interface, $3 = remote server IP, $4 = DNS IP (optional). The LAN
		// flag is a TRAILING sentinel, so the two positional shapes keep their
		// meaning; it can collide with neither an interface name nor an IPv4.
		p := ops.KillswitchParams{Iface: arg(1), RemoteHost: arg(2), DnsIp: arg(3)}
		if args[len(args)-1] == guard.LanSharingArg {
			p.LanSharing = true
			if p.DnsIp == guard.LanSharingArg {
				p.DnsIp = ""
			}
		}
		err = ops.KillswitchOn(ctx, e, p)
	case "killswitch-off":
		err = ops.KillswitchOff(ctx, e)
	case "dns-set":
		err = ops.DnsSet(ctx, e, arg(1))
	case "dns-restore":
		err = ops.DnsRestore(ctx, e)
	default:
		fmt.Fprintln(stderr, Usage)
		return 1
	}
	if err != nil {
		fmt.Fprintf(stderr, "Error: %s\n", err)
		return 1
	}
	return 0
}

var errInvalidPath = errors.New("invalid config path")

// readConfig reads a caller-supplied config path once, safely (see the package
// comment). requiredIface, when set, is the interface the file name must encode
// (`sntl0.conf`): wg-quick derives the interface from it, and awg-up keeps the same
// contract since Phase 3 embedded the device (which hardcodes sntl0), so a caller
// that names the file anything else is confused about what it is configuring.
func readConfig(path, requiredIface string) ([]byte, error) {
	if path == "" || !strings.HasSuffix(path, ".conf") {
		return nil, errInvalidPath
	}
	if requiredIface != "" {
		if got := strings.TrimSuffix(filepath.Base(path), ".conf"); got != requiredIface {
			return nil, fmt.Errorf("interface must be %s, got %s", requiredIface, got)
		}
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, errInvalidPath
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return nil, errInvalidPath
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return nil, errInvalidPath
	}
	if st.Size > protocol.MaxMessageBytes {
		return nil, errors.New("config file too large")
	}
	if uidStr := os.Getenv("PKEXEC_UID"); uidStr != "" {
		uid, err := strconv.ParseUint(uidStr, 10, 32)
		if err != nil || uint32(uid) != st.Uid {
			return nil, errors.New("config file must be owned by the invoking user")
		}
	}
	return io.ReadAll(io.LimitReader(f, protocol.MaxMessageBytes+1))
}
