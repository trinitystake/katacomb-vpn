// katacomb-vpn-helper: the ONE privileged binary of Katacomb VPN.
//
//	katacomb-vpn-helper daemon          systemd ExecStart; serves protocol v1 on the socket
//	katacomb-vpn-helper <verb> <args…>  pkexec one-shot; the argv contract the bash helper had
//	katacomb-vpn-helper --version       the package version it was built for
//	katacomb-vpn-helper _tun2socks …    hidden: the embedded tun2socks engine, self-exec'd by tun-up
//	katacomb-vpn-helper _amneziawg …    hidden: the embedded AmneziaWG device, self-exec'd by awg-up
//
// Both entry modes end in the same internal/ops package, which is the trust
// boundary: the socket is unauthenticated (any member of the katacomb-vpn group)
// and the one-shot is reachable by any polkit-authenticated user, so every
// argument is validated in ops regardless of how it arrived.
package main

import (
	"fmt"
	"os"

	"katacomb.vpn/daemon/internal/amneziawg"
	"katacomb.vpn/daemon/internal/oneshot"
	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/server"
	"katacomb.vpn/daemon/internal/tun2socks"
)

func main() {
	args := os.Args[1:]
	switch {
	case len(args) == 1 && args[0] == "--version":
		fmt.Println(version)
	case len(args) == 1 && args[0] == "daemon":
		os.Exit(server.Run(ops.RealEnv()))
	case len(args) >= 1 && args[0] == "_tun2socks":
		os.Exit(tun2socks.Run(args[1:], os.Stderr))
	case len(args) >= 1 && args[0] == "_amneziawg":
		os.Exit(amneziawg.Run(args[1:], os.Stderr))
	default:
		os.Exit(oneshot.Run(args, ops.RealEnv(), os.Stdout, os.Stderr))
	}
}
