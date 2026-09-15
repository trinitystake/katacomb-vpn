package ops

import (
	"context"
	"testing"
)

// The tmpl filter is the load-bearing part: without it this reports a VPN on an
// ordinary idle machine, and detectOtherVpn would warn every user every connect.

func TestXfrmPolicyCountIsZeroWithNoIpsec(t *testing.T) {
	f := newFake(t)
	if got := XfrmPolicyCount(context.Background(), f.Env); got != 0 {
		t.Fatalf("got %d, want 0 on a machine with no policies", got)
	}
}

func TestXfrmPolicyCountIgnoresSocketPolicies(t *testing.T) {
	f := newFake(t)
	// What the kernel installs by itself on some systems: no transform template,
	// so not a VPN.
	f.xfrmPolicy = `src 0.0.0.0/0 dst 0.0.0.0/0
	socket in priority 0 ptype main
src 0.0.0.0/0 dst 0.0.0.0/0
	socket out priority 0 ptype main
`
	if got := XfrmPolicyCount(context.Background(), f.Env); got != 0 {
		t.Fatalf("got %d, want 0: socket policies are not a VPN", got)
	}
}

func TestXfrmPolicyCountSeesRealIpsecTunnel(t *testing.T) {
	f := newFake(t)
	// A strongSwan-style tunnel: three directions, each with a template.
	f.xfrmPolicy = `src 10.0.0.0/24 dst 192.168.1.0/24
	dir out priority 375423 ptype main
	tmpl src 203.0.113.5 dst 198.51.100.7
		proto esp reqid 1 mode tunnel
src 192.168.1.0/24 dst 10.0.0.0/24
	dir fwd priority 375423 ptype main
	tmpl src 198.51.100.7 dst 203.0.113.5
		proto esp reqid 1 mode tunnel
src 192.168.1.0/24 dst 10.0.0.0/24
	dir in priority 375423 ptype main
	tmpl src 198.51.100.7 dst 203.0.113.5
		proto esp reqid 1 mode tunnel
`
	if got := XfrmPolicyCount(context.Background(), f.Env); got != 3 {
		t.Fatalf("got %d, want 3 templated policies", got)
	}
}
