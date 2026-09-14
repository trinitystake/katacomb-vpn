// Package tun2socks is the hidden `_tun2socks` sub-mode: the tun2socks engine
// (github.com/xjasonlyu/tun2socks/v2, the same v2.6.0 that used to ship as a
// separate 10 MB executable) linked into the helper. `tun-up` self-execs
// `katacomb-vpn-helper _tun2socks …` detached, so root runs a binary at a real
// filesystem path (/usr/local/bin) instead of one it is handed — which on the
// AppImage was a path on a FUSE mount root cannot read, and left V2Ray/XRAY/
// Hysteria2 tunnel mode broken there.
//
// Every engine field is HARDCODED here except the SOCKS address. Key.TUNPreUp /
// Key.TUNPostUp are shell hooks the engine would run as root, and Key.RestAPI
// opens a listener; none is ever populated, no config file is read, and the
// engine's own flag set is never invoked on our argv. The device/mtu/loglevel
// flags are still carried on the argv (see ops.TunUp) so the process reads
// sensibly in `ps` and the pid-less tun-down fallback can key on the
// `tun://sntl-tun` entry.
package tun2socks

import (
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	_ "github.com/xjasonlyu/tun2socks/v2/dns" // routes the engine's own lookups through its dialer, as the upstream CLI does
	"github.com/xjasonlyu/tun2socks/v2/engine"

	"katacomb.vpn/daemon/internal/guard"
)

const (
	device = "tun://sntl-tun"
	// tun2socks terminates TCP in a userspace netstack and advertises MSS =
	// MTU-40; 1400 keeps large TLS ClientHellos inside the proxy-wrapped path.
	mtu = 1400
)

// ProxyArg extracts and validates the one variable the sub-mode takes, the
// `-proxy socks5://<ipv4>:<port>` pair, from argv. Exposed for the test; the
// engine itself needs root and a TUN device.
func ProxyArg(args []string) (string, error) {
	proxy := ""
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-proxy" {
			proxy = args[i+1]
		}
	}
	addr, ok := strings.CutPrefix(proxy, "socks5://")
	if !ok || !guard.IsValidSocksAddr(addr) {
		return "", fmt.Errorf("_tun2socks: -proxy must be socks5://<ipv4>:<port>")
	}
	return proxy, nil
}

// Run starts the engine on sntl-tun and blocks until SIGTERM/SIGINT, then stops
// it. Returns the process exit code.
func Run(args []string, stderr io.Writer) int {
	proxy, err := ProxyArg(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	engine.Insert(&engine.Key{
		Device:   device,
		Proxy:    proxy,
		MTU:      mtu,
		LogLevel: "silent",
	})
	engine.Start() // log.Fatalf (exit 1) on failure; tun-up then sees no interface
	defer engine.Stop()

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	<-sigs
	return 0
}
