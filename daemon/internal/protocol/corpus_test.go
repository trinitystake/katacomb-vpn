package protocol

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// The corpus under testdata/corpus/protocol.json is shared with
// src/main/daemon-protocol-corpus.test.ts. Both sides claim to mirror this wire
// contract byte for byte; this is what makes a drift fail loudly. Same
// arrangement as internal/guard/testdata/corpus, which pins the config
// allow-lists against src/main/config-guard.ts.

type corpus struct {
	Version         int      `json:"version"`
	SocketDir       string   `json:"socketDir"`
	SocketPath      string   `json:"socketPath"`
	MaxMessageBytes int      `json:"maxMessageBytes"`
	Ops             []string `json:"ops"`
	LockFreeOps     []string `json:"lockFreeOps"`
	Requests        []struct {
		Name    string `json:"name"`
		Line    string `json:"line"`
		Outcome string `json:"outcome"`
		ID      int64  `json:"id"`
		Op      string `json:"op"`
	} `json:"requests"`
	Responses []struct {
		Name     string `json:"name"`
		Response struct {
			ID     int64 `json:"id"`
			OK     bool  `json:"ok"`
			Result any   `json:"result"`
			Error  string `json:"error"`
		} `json:"response"`
		Encoded string `json:"encoded"`
	} `json:"responses"`
	UnknownOpPrefix string `json:"unknownOpPrefix"`
}

func loadCorpus(t *testing.T) corpus {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("testdata", "corpus", "protocol.json"))
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	var c corpus
	if err := json.Unmarshal(body, &c); err != nil {
		t.Fatalf("parse corpus: %v", err)
	}
	return c
}

func TestCorpusConstants(t *testing.T) {
	c := loadCorpus(t)
	if Version != c.Version {
		t.Errorf("Version = %d, corpus says %d", Version, c.Version)
	}
	if MaxMessageBytes != c.MaxMessageBytes {
		t.Errorf("MaxMessageBytes = %d, corpus says %d", MaxMessageBytes, c.MaxMessageBytes)
	}
}

// Ops is served on the wire, so it is part of the contract, not a test fixture.
func TestCorpusOpsList(t *testing.T) {
	c := loadCorpus(t)
	if len(Ops) != len(c.Ops) {
		t.Fatalf("Ops has %d entries, corpus has %d", len(Ops), len(c.Ops))
	}
	for i := range Ops {
		if Ops[i] != c.Ops[i] {
			t.Errorf("Ops[%d] = %q, corpus says %q", i, Ops[i], c.Ops[i])
		}
	}
}

func TestCorpusRequestParsing(t *testing.T) {
	for _, tc := range loadCorpus(t).Requests {
		t.Run(tc.Name, func(t *testing.T) {
			req, err := ParseRequest([]byte(tc.Line))
			switch tc.Outcome {
			case "valid":
				if err != nil {
					t.Fatalf("want valid, got error %v", err)
				}
				if req.ID != tc.ID || req.Op != tc.Op {
					t.Fatalf("parsed {id:%d op:%q}, corpus says {id:%d op:%q}", req.ID, req.Op, tc.ID, tc.Op)
				}
			case "invalidJSON":
				var want ErrInvalidJSON
				if !errors.As(err, &want) {
					t.Fatalf("want invalid JSON, got %v", err)
				}
			case "invalidRequest":
				var want ErrInvalidRequest
				if !errors.As(err, &want) {
					t.Fatalf("want invalid request, got %v", err)
				}
			case "blank":
				if !IsBlank(err) {
					t.Fatalf("want blank, got %v", err)
				}
			default:
				t.Fatalf("corpus has unknown outcome %q", tc.Outcome)
			}
		})
	}
}

func TestCorpusResponseEncoding(t *testing.T) {
	for _, tc := range loadCorpus(t).Responses {
		t.Run(tc.Name, func(t *testing.T) {
			got := string(Response{
				ID:     tc.Response.ID,
				OK:     tc.Response.OK,
				Result: tc.Response.Result,
				Error:  tc.Response.Error,
			}.Encode())
			if got != tc.Encoded {
				t.Fatalf("encoded %s, corpus says %s", got, tc.Encoded)
			}
		})
	}
}
