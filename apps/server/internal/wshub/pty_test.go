package wshub

import (
	"strings"
	"testing"
)

func TestRingBufferReplayAndTruncation(t *testing.T) {
	s := NewPtySession("t1", 1, "alice")
	defer s.Close()
	// push more than ring capacity in small chunks
	chunk := strings.Repeat("x", 64*1024)
	for i := 0; i < 20; i++ {
		s.Write([]byte(chunk))
	}
	s.mu.RLock()
	total := s.totalBytes()
	first := s.firstSeq
	last := s.lastSeq
	s.mu.RUnlock()
	if total > s.ringSize {
		t.Fatalf("ring exceeded cap: %d > %d", total, s.ringSize)
	}
	if last-first+1 != int64(len(s.ring)) {
		t.Fatal("seq/ring desync")
	}

	// replay from 0 → truncated
	truncated := first > 1
	if !truncated {
		t.Fatal("expected truncation after overflow")
	}

	// replay from a recent seq returns the tail only
	var got []*Envelope
	s.mu.RLock()
	for _, c := range s.ring {
		if c.Seq >= last-2 {
			e, _ := NewEnvelope("pty.out", c.Seq, map[string]string{"data": string(c.Data)})
			got = append(got, e)
		}
	}
	s.mu.RUnlock()
	if len(got) != 3 || got[0].Seq != last-2 {
		t.Fatalf("replay tail wrong: %d envelopes", len(got))
	}
}

func TestRegistryLifecycle(t *testing.T) {
	r := NewRegistry(nil)
	s := NewPtySession("t2", 7, "bob")
	r.Add(s)
	if got, ok := r.Get("t2"); !ok || got.HostID != 7 {
		t.Fatal("registry get failed")
	}
	if len(r.ByHost(7)) != 1 || len(r.ByHost(8)) != 0 {
		t.Fatal("ByHost filter wrong")
	}
	r.Remove("t2")
	if _, ok := r.Get("t2"); ok {
		t.Fatal("remove failed")
	}
	s.Close()
}

func TestSlowConsumerDropNotBlock(t *testing.T) {
	s := NewPtySession("t3", 1, "c")
	defer s.Close()
	// no subscriber attached — Write must not panic or block
	for i := 0; i < 100; i++ {
		s.Write([]byte("data"))
	}
}
