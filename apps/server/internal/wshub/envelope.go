// Package wshub implements the shared WebSocket message envelope
//   { "type": "...", "seq": n, "ts": unix-ms, "payload": {...} }
// plus the server-side PTY session registry with ring-buffer replay.
package wshub

import (
	"encoding/json"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type Envelope struct {
	Type    string          `json:"type"`
	Seq     int64           `json:"seq"`
	TS      int64           `json:"ts"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

func NewEnvelope(typ string, seq int64, payload any) (*Envelope, error) {
	var raw json.RawMessage
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		raw = json.RawMessage(b)
	}
	return &Envelope{Type: typ, Seq: seq, TS: time.Now().UnixMilli(), Payload: raw}, nil
}

// Conn wraps a websocket with serialized writes (gorilla requires single writer).
type Conn struct {
	ws     *websocket.Conn
	wmu    sync.Mutex
	seq    atomic.Int64
	closed bool
	mu     sync.Mutex
}

func Upgrade(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	up := websocket.Upgrader{
		ReadBufferSize:  32 * 1024,
		WriteBufferSize: 32 * 1024,
		CheckOrigin: func(req *http.Request) bool {
			origin := req.Header.Get("Origin")
			if origin == "" {
				return true // non-browser client
			}
			u, err := url.Parse(origin)
			if err != nil {
				return false
			}
			return u.Host == req.Host
		},
	}
	ws, err := up.Upgrade(w, r, nil)
	if err != nil {
		return nil, err
	}
	return &Conn{ws: ws}, nil
}

func (c *Conn) Send(typ string, payload any) error {
	env, err := NewEnvelope(typ, c.seq.Add(1), payload)
	if err != nil {
		return err
	}
	return c.SendRaw(env)
}

// SendRaw preserves an explicit sequence number (used for replay).
func (c *Conn) SendRaw(env *Envelope) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return c.ws.WriteJSON(env)
}

func (c *Conn) Read() (*Envelope, error) {
	var env Envelope
	if err := c.ws.ReadJSON(&env); err != nil {
		return nil, err
	}
	return &env, nil
}

func (c *Conn) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()
	return c.ws.Close()
}

func (c *Conn) RemoteAddr() string { return c.ws.RemoteAddr().String() }
