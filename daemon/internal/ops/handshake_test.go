package ops

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// The tri-state is the load-bearing part. "Cannot know" (Kernel false) and "never
// handshaked" (-1) both have to stay distinct from a real age, because the app
// turns a real age into a stand-down and the other two into nothing.

func kernelWg(t *testing.T) *fakeEnv {
	t.Helper()
	f := newFake(t)
	f.addLink("sntl0")
	f.wgtype = true
	return f
}

func TestWgHandshakeAbstainsWhenSntl0IsAmneziaWg(t *testing.T) {
	f := newFake(t)
	// The embedded AmneziaWG device: sntl0 exists but is a `type tun` link, and
	// internal/amneziawg never opens a UAPI socket, so wg(8) has no way in. This
	// case is the whole reason the Kernel field exists.
	f.addLink("sntl0")
	f.wgtype = false
	f.wgHandshakes = fmt.Sprintf("peerkey=\t%d\n", time.Now().Unix())
	if got := WgHandshake(context.Background(), f.Env); got.Kernel {
		t.Fatalf("got %+v, want Kernel=false for a userspace sntl0", got)
	}
}

func TestWgHandshakeAbstainsWhenThereIsNoSntl0(t *testing.T) {
	f := newFake(t)
	if got := WgHandshake(context.Background(), f.Env); got.Kernel {
		t.Fatalf("got %+v, want Kernel=false with no interface", got)
	}
}

func TestWgHandshakeAbstainsWhenWgIsNotInstalled(t *testing.T) {
	f := kernelWg(t)
	f.Env.LookPath = func(string) (string, error) { return "", errors.New("not found") }
	if got := WgHandshake(context.Background(), f.Env); got.Kernel {
		t.Fatalf("got %+v, want Kernel=false without wg(8)", got)
	}
}

func TestWgHandshakeReportsNeverWhenNoPeerHasHandshaked(t *testing.T) {
	f := kernelWg(t)
	// wg prints 0 for a peer that has never completed a handshake. Read naively
	// that is 1970 and decades stale, which would end a session seconds after
	// bring-up, before the first handshake has had a chance to land.
	f.wgHandshakes = "peerkey=\t0\n"
	got := WgHandshake(context.Background(), f.Env)
	if !got.Kernel || got.AgeSeconds != -1 {
		t.Fatalf("got %+v, want {Kernel:true AgeSeconds:-1}", got)
	}
}

func TestWgHandshakeReportsTheMostRecentPeer(t *testing.T) {
	f := kernelWg(t)
	now := time.Now().Unix()
	// Two peers, the older one listed first: the max must win, not the first line.
	f.wgHandshakes = fmt.Sprintf("oldpeer=\t%d\nnewpeer=\t%d\n", now-300, now-30)
	got := WgHandshake(context.Background(), f.Env)
	if !got.Kernel || got.AgeSeconds < 25 || got.AgeSeconds > 35 {
		t.Fatalf("got %+v, want Kernel=true and an age of about 30s", got)
	}
}

func TestWgHandshakeClampsABackwardsClock(t *testing.T) {
	f := kernelWg(t)
	// A stamp in the future (the wall clock stepped back after the handshake) must
	// read as fresh, never as a negative age.
	f.wgHandshakes = fmt.Sprintf("peerkey=\t%d\n", time.Now().Unix()+60)
	got := WgHandshake(context.Background(), f.Env)
	if !got.Kernel || got.AgeSeconds != 0 {
		t.Fatalf("got %+v, want {Kernel:true AgeSeconds:0}", got)
	}
}
