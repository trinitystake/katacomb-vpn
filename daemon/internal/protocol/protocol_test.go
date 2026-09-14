package protocol

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func readAll(t *testing.T, rd *Reader) ([]string, error) {
	t.Helper()
	var lines []string
	for {
		l, err := rd.ReadLine()
		if err != nil {
			return lines, err
		}
		lines = append(lines, string(l))
	}
}

func TestReadLineFramesPipelinedRequests(t *testing.T) {
	rd := NewReader(strings.NewReader(`{"id":1,"op":"a"}` + "\n" + `{"id":2,"op":"b"}` + "\n\n" + `{"id":3,"op":"c"}` + "\n"))
	lines, err := readAll(t, rd)
	if err != io.EOF {
		t.Fatalf("want EOF, got %v", err)
	}
	if len(lines) != 4 || lines[2] != "" || lines[3] != `{"id":3,"op":"c"}` {
		t.Fatalf("got %q", lines)
	}
}

func TestReadLineReturnsUnterminatedTailAtEOF(t *testing.T) {
	rd := NewReader(strings.NewReader(`{"id":1,"op":"a"}`))
	lines, err := readAll(t, rd)
	if err != io.EOF || len(lines) != 1 {
		t.Fatalf("got %q, %v", lines, err)
	}
}

func TestReadLineCapsUnterminatedBuffer(t *testing.T) {
	big := bytes.Repeat([]byte("x"), MaxMessageBytes+1)
	rd := NewReader(bytes.NewReader(big))
	_, err := rd.ReadLine()
	var tooLarge ErrTooLarge
	if !errors.As(err, &tooLarge) {
		t.Fatalf("want ErrTooLarge, got %v", err)
	}
	// Exactly at the cap with a newline is fine.
	ok := append(bytes.Repeat([]byte("y"), MaxMessageBytes), '\n')
	rd = NewReader(bytes.NewReader(ok))
	if l, err := rd.ReadLine(); err != nil || len(l) != MaxMessageBytes {
		t.Fatalf("a line at the cap must be delivered: %v", err)
	}
}

func TestParseRequest(t *testing.T) {
	req, err := ParseRequest([]byte(`{"id":7,"op":"dns_set","args":{"dnsIp":"1.1.1.1"}}`))
	if err != nil || req.ID != 7 || req.Op != "dns_set" || string(req.Args) != `{"dnsIp":"1.1.1.1"}` {
		t.Fatalf("got %+v, %v", req, err)
	}
	if _, err := ParseRequest([]byte(`{"id":1,"op":"status"}`)); err != nil {
		t.Fatalf("args are optional: %v", err)
	}

	for _, bad := range []string{`not json`, `{"id":1,`, `{"id":1,"op":"x"} trailing`} {
		if _, err := ParseRequest([]byte(bad)); !errors.As(err, &ErrInvalidJSON{}) {
			t.Errorf("%q: want invalid JSON, got %v", bad, err)
		}
	}
	// Deviation 3: these killed the TypeScript daemon; here they are a reply.
	for _, bad := range []string{`null`, `"x"`, `[]`, `5`, `true`, `{"op":"x"}`, `{"id":"1","op":"x"}`, `{"id":1.5,"op":"x"}`, `{"id":1}`, `{"id":1,"op":5}`} {
		if _, err := ParseRequest([]byte(bad)); !errors.As(err, &ErrInvalidRequest{}) {
			t.Errorf("%q: want invalid request, got %v", bad, err)
		}
	}
	if _, err := ParseRequest([]byte("   \t ")); !IsBlank(err) {
		t.Errorf("whitespace: want blank, got %v", err)
	}
}

func TestResponseEncoding(t *testing.T) {
	cases := map[string]Response{
		`{"id":1,"ok":true}`:                                {ID: 1, OK: true},
		`{"id":2,"ok":true,"result":{"version":1}}`:         {ID: 2, OK: true, Result: map[string]int{"version": 1}},
		`{"id":3,"ok":false,"error":"unknown op: frob"}`:    {ID: 3, OK: false, Error: "unknown op: frob"},
		`{"id":0,"ok":false,"error":"invalid JSON"}`:        {ID: 0, OK: false, Error: "invalid JSON"},
		`{"id":4,"ok":true,"result":{"wgUp":true,"tunUp":false,"ovpnUp":false}}`: {ID: 4, OK: true, Result: struct {
			WgUp   bool `json:"wgUp"`
			TunUp  bool `json:"tunUp"`
			OvpnUp bool `json:"ovpnUp"`
		}{true, false, false}},
	}
	for want, r := range cases {
		if got := string(r.Encode()); got != want {
			t.Errorf("want %s, got %s", want, got)
		}
	}
}
