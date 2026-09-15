package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"katacomb.vpn/daemon/internal/protocol"
)

// Shared with src/main/daemon-protocol-corpus.test.ts via
// internal/protocol/testdata/corpus/protocol.json. internal/protocol's own
// corpus_test.go pins the framing and encoding; this pins the OP LIST, which is
// the half that actually drifts — an op added to the TypeScript union with no
// dispatch case here (or the reverse) is otherwise only discovered at runtime,
// as an `unknown op` the app reports as a stale daemon.

type opsCorpus struct {
	Ops             []string `json:"ops"`
	LockFreeOps     []string `json:"lockFreeOps"`
	UnknownOpPrefix string   `json:"unknownOpPrefix"`
}

func loadOpsCorpus(t *testing.T) opsCorpus {
	t.Helper()
	path := filepath.Join("..", "protocol", "testdata", "corpus", "protocol.json")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	var c opsCorpus
	if err := json.Unmarshal(body, &c); err != nil {
		t.Fatalf("parse corpus: %v", err)
	}
	return c
}

// Every op the corpus lists must dispatch to something. We assert only that the
// reply is not the unknown-op refusal: an op can legitimately fail here (missing
// args), it just must not be unrecognised.
func TestCorpusOpsAllDispatch(t *testing.T) {
	c := loadOpsCorpus(t)
	r := newRec(t)
	for _, op := range c.Ops {
		t.Run(op, func(t *testing.T) {
			res := Dispatch(context.Background(), protocol.Request{ID: 1, Op: op}, r.Env)
			if !res.OK && strings.HasPrefix(res.Error, c.UnknownOpPrefix) {
				t.Fatalf("op %q is in the corpus but this daemon does not implement it (%q)", op, res.Error)
			}
		})
	}
}

// The capability probe must actually carry the op list, or the client silently
// falls back to post-hoc `unknown op` detection and the pre-purchase check that
// this exists for never fires.
func TestProtocolVersionReportsOps(t *testing.T) {
	c := loadOpsCorpus(t)
	r := newRec(t)
	res := Dispatch(context.Background(), protocol.Request{ID: 1, Op: "protocol_version"}, r.Env)
	if !res.OK {
		t.Fatalf("protocol_version failed: %q", res.Error)
	}
	m, ok := res.Result.(map[string]any)
	if !ok {
		t.Fatalf("result is %T, want a map", res.Result)
	}
	got, ok := m["ops"].([]string)
	if !ok {
		t.Fatalf("result has no ops list (%T)", m["ops"])
	}
	if len(got) != len(c.Ops) {
		t.Fatalf("reported %d ops, corpus has %d", len(got), len(c.Ops))
	}
	for i := range got {
		if got[i] != c.Ops[i] {
			t.Errorf("reported ops[%d] = %q, corpus says %q", i, got[i], c.Ops[i])
		}
	}
}

func TestCorpusUnknownOpStillRefused(t *testing.T) {
	c := loadOpsCorpus(t)
	r := newRec(t)
	res := Dispatch(context.Background(), protocol.Request{ID: 1, Op: "definitely_not_an_op"}, r.Env)
	if res.OK || res.Error != c.UnknownOpPrefix+"definitely_not_an_op" {
		t.Fatalf("got ok=%v error=%q, want the corpus unknown-op refusal", res.OK, res.Error)
	}
}

func TestCorpusLockFreeOps(t *testing.T) {
	c := loadOpsCorpus(t)
	for _, op := range c.LockFreeOps {
		if lockedOp(op) {
			t.Errorf("corpus says %q runs lock-free but the server takes the mutex for it", op)
		}
	}
	for _, op := range c.Ops {
		lockFree := false
		for _, f := range c.LockFreeOps {
			if f == op {
				lockFree = true
			}
		}
		if !lockFree && !lockedOp(op) {
			t.Errorf("op %q takes no lock but the corpus does not list it as lock-free", op)
		}
	}
}
