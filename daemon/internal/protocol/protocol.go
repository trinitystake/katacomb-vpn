// Package protocol is the wire contract of the daemon socket, byte-compatible with
// the TypeScript client (src/main/daemon-client.ts) and the shape the old
// TypeScript daemon (daemon-core.ts) served: newline-delimited JSON over AF_UNIX,
// version 1, request {id, op, args?}, response {id, ok, result?, error?}.
package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
)

// Version is the protocol version reported by the protocol_version op. Bump only
// on a BREAKING change. It is deliberately not bumped when an op is added, which
// is why it cannot, on its own, detect the skew that actually happens: a daemon
// left running across an upgrade that lacks a newly added op (amneziawg_*,
// openvpn_* were both additive). Ops below is what answers that question.
const Version = 1

// Ops is every op this daemon serves, reported alongside Version so an upgraded
// app can find out what a running daemon can do BEFORE it acts. That ordering
// matters: without it a stale daemon is discovered by `unknown op` from the
// bring-up, which for OpenVPN and AmneziaWG is after the session has been paid
// for. Pinned to testdata/corpus/protocol.json, which the TypeScript side reads
// too. Keep in dispatch order.
var Ops = []string{
	"protocol_version",
	"status",
	"xfrm_policies",
	"wireguard_handshake",
	"wireguard_up",
	"wireguard_down",
	"amneziawg_up",
	"amneziawg_down",
	"openvpn_up",
	"openvpn_down",
	"tun_up",
	"tun_down",
	"killswitch_on",
	"killswitch_off",
	"dns_set",
	"dns_restore",
}

// MaxMessageBytes caps a single buffered request. The TypeScript daemon capped at
// 256 KiB of UTF-16 units; this counts bytes, which no client depends on.
const MaxMessageBytes = 256 * 1024

// Request is one line the client sends.
type Request struct {
	ID   int64           `json:"id"`
	Op   string          `json:"op"`
	Args json.RawMessage `json:"args,omitempty"`
}

// Response is the one line the daemon writes back.
type Response struct {
	ID     int64  `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Encode serialises a response as its JSON line (no trailing newline).
func (r Response) Encode() []byte {
	b, _ := json.Marshal(r)
	return b
}

// Reader frames newline-delimited requests off a connection, enforcing the size
// cap. It reproduces the TypeScript daemon's buffering: bytes accumulate until a
// newline, the cap is on the UNTERMINATED buffer, and pipelined lines in one read
// are each yielded.
type Reader struct {
	r   *bufio.Reader
	buf []byte
}

// NewReader wraps rd.
func NewReader(rd io.Reader) *Reader {
	return &Reader{r: bufio.NewReader(rd)}
}

// ErrTooLarge is returned when the buffered bytes before a newline exceed the cap.
// The server drops the connection with no reply, as the TypeScript daemon did.
type ErrTooLarge struct{}

func (ErrTooLarge) Error() string { return "message too large" }

// ReadLine returns the next newline-terminated line (without the newline), or
// io.EOF at a clean end, or ErrTooLarge when the cap is passed before a newline.
// A trailing line with no newline at EOF is returned if non-empty.
func (rd *Reader) ReadLine() ([]byte, error) {
	for {
		if i := bytes.IndexByte(rd.buf, '\n'); i >= 0 {
			line := rd.buf[:i]
			rd.buf = rd.buf[i+1:]
			out := make([]byte, len(line))
			copy(out, line)
			return out, nil
		}
		if len(rd.buf) > MaxMessageBytes {
			return nil, ErrTooLarge{}
		}
		chunk := make([]byte, 16*1024)
		n, err := rd.r.Read(chunk)
		rd.buf = append(rd.buf, chunk[:n]...)
		if err != nil {
			if err == io.EOF {
				if len(rd.buf) > MaxMessageBytes {
					return nil, ErrTooLarge{}
				}
				if len(rd.buf) > 0 {
					out := rd.buf
					rd.buf = nil
					return out, nil
				}
			}
			return nil, err
		}
	}
}

// ParseRequest decodes one framed line. A non-object, null, or non-numeric-id
// payload is `invalidRequest` (deviation 3: the TypeScript daemon threw inside its
// own catch on these and died); a syntactically broken line is `invalidJSON`. The
// caller maps these to the fixed {"id":0,...} replies and keeps reading.
func ParseRequest(line []byte) (Request, error) {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 {
		return Request{}, errBlank
	}
	// JSON.parse would have thrown: syntax errors and trailing garbage alike.
	if !json.Valid(trimmed) {
		return Request{}, ErrInvalidJSON{}
	}
	// Valid JSON that isn't a request object: `null`, `"x"`, `[]`, `5`, a
	// non-numeric or missing id, a non-string or missing op.
	if trimmed[0] != '{' {
		return Request{}, ErrInvalidRequest{}
	}
	var probe struct {
		ID *json.Number `json:"id"`
		Op *string      `json:"op"`
	}
	if err := json.Unmarshal(trimmed, &probe); err != nil || probe.ID == nil || probe.Op == nil {
		return Request{}, ErrInvalidRequest{}
	}
	if _, err := probe.ID.Int64(); err != nil {
		return Request{}, ErrInvalidRequest{}
	}
	var req Request
	if err := json.Unmarshal(trimmed, &req); err != nil {
		return Request{}, ErrInvalidRequest{}
	}
	return req, nil
}

// ErrInvalidJSON is a syntactically broken line.
type ErrInvalidJSON struct{}

func (ErrInvalidJSON) Error() string { return "invalid JSON" }

// ErrInvalidRequest is well-formed JSON that is not a request object with a
// numeric id and an op.
type ErrInvalidRequest struct{}

func (ErrInvalidRequest) Error() string { return "invalid request" }

// errBlank marks a whitespace-only line the server skips.
type errBlankType struct{}

func (errBlankType) Error() string { return "blank line" }

var errBlank = errBlankType{}

// IsBlank reports whether err means "skip this line".
func IsBlank(err error) bool { return err == errBlank }
