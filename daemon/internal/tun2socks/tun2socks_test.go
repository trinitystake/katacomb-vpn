package tun2socks

import "testing"

func TestProxyArg(t *testing.T) {
	good := []string{"-device", "tun://sntl-tun", "-proxy", "socks5://127.0.0.1:1080", "-mtu", "1400", "-loglevel", "silent"}
	if p, err := ProxyArg(good); err != nil || p != "socks5://127.0.0.1:1080" {
		t.Fatalf("got %q, %v", p, err)
	}
	for _, bad := range [][]string{
		{},
		{"-proxy"},
		{"-proxy", "socks5://localhost:1080"},
		{"-proxy", "http://127.0.0.1:1080"},
		{"-proxy", "socks5://127.0.0.1:0"},
		{"-proxy", "socks5://127.0.0.1:1080;x"},
		{"-device", "tun://evil", "-proxy", "socks5://127.0.0.1:1080", "-tun-post-up", "sh -c id"},
	} {
		// The last case is accepted by ProxyArg (only -proxy is read) — the point
		// is that no other flag is parsed at all, so a hook cannot be smuggled in.
		if _, err := ProxyArg(bad); err != nil && len(bad) == 6 {
			t.Fatalf("%v: only -proxy is read, other flags are inert: %v", bad, err)
		}
		if _, err := ProxyArg(bad); err == nil && len(bad) != 6 {
			t.Errorf("%v: want an error", bad)
		}
	}
}
