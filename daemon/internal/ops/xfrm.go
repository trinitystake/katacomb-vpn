package ops

import (
	"context"
	"strings"
)

// XfrmPolicyCount reports how many IPsec policies with a transform template are
// installed. It exists because detectOtherVpn (vpn-manager.ts) shells out to
// `ip link show` and therefore cannot see an IPsec/XFRM VPN at all: strongSwan,
// libreswan and most corporate clients install no interface, only policies, and
// reading them needs CAP_NET_ADMIN. That is the whole reason this lives here
// rather than in the app — the helper is already root.
//
// Counting only policies that carry a `tmpl` line is deliberate. The kernel
// installs per-socket policies of its own on some systems, which have no template
// and are not a VPN; a template is what binds a policy to an actual security
// association. Without that filter this reports a VPN on an idle machine.
//
// Read-only, so it takes no lock and changes nothing. detectOtherVpn is a
// warn-with-override and must never become a gate, so a wrong answer here costs a
// misleading warning, never a refused connect.
func XfrmPolicyCount(ctx context.Context, e *Env) int {
	ip, err := tool(e, "ip")
	if err != nil {
		return 0
	}
	var n int
	for _, line := range strings.Split(output(ctx, e, ip, "xfrm", "policy"), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "tmpl ") {
			n++
		}
	}
	return n
}
