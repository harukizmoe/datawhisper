package jsonrpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"testing"
	"time"
)

type pipeConn struct {
	r *io.PipeReader
	w *io.PipeWriter
}

func (c pipeConn) Read(p []byte) (int, error)  { return c.r.Read(p) }
func (c pipeConn) Write(p []byte) (int, error) { return c.w.Write(p) }
func (c pipeConn) Close() error                { return c.w.Close() }

// TestCallsNotificationsAndClose 覆盖传输层的三件事：响应按 id 关联（对端倒序回答也各得其所）、
// 错误响应变成 *Error 并保留 data 原文、通知交给回调；对端关闭 stdout 后请求得到 ErrClosed。
func TestCallsNotificationsAndClose(t *testing.T) {
	toPeerR, toPeerW := io.Pipe()
	fromPeerR, fromPeerW := io.Pipe()
	notified := make(chan string, 1)
	c := New(pipeConn{r: fromPeerR, w: toPeerW}, func(method string, params json.RawMessage) {
		notified <- method + " " + string(params)
	})

	// 对端：收齐两个请求后倒序回答，第二个回错误，再推一条通知。
	go func() {
		br := bufio.NewReader(toPeerR)
		var ids []json.RawMessage
		for len(ids) < 2 {
			line, err := br.ReadBytes('\n')
			if err != nil {
				return
			}
			var req struct {
				ID json.RawMessage `json:"id"`
			}
			_ = json.Unmarshal(line, &req)
			ids = append(ids, req.ID)
		}
		write := func(v any) {
			b, _ := json.Marshal(v)
			_, _ = fromPeerW.Write(append(b, '\n'))
		}
		write(map[string]any{"jsonrpc": "2.0", "id": ids[1], "error": map[string]any{"code": -32000, "message": "nope", "data": map[string]any{"kind": "not_found"}}})
		write(map[string]any{"jsonrpc": "2.0", "id": ids[0], "result": "first"})
		write(map[string]any{"jsonrpc": "2.0", "method": "ping", "params": map[string]any{"n": 1}})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type result struct {
		raw json.RawMessage
		err error
	}
	first, second := make(chan result, 1), make(chan result, 1)
	go func() { raw, err := c.Call(ctx, "a", nil); first <- result{raw, err} }()
	time.Sleep(20 * time.Millisecond) // 让 a 先写出，对端据此排定 id 的先后
	go func() { raw, err := c.Call(ctx, "b", map[string]int{"x": 1}); second <- result{raw, err} }()

	if r := <-first; r.err != nil || string(r.raw) != `"first"` {
		t.Errorf("a = %s, %v", r.raw, r.err)
	}
	r := <-second
	var rpcErr *Error
	if !errors.As(r.err, &rpcErr) || rpcErr.Code != -32000 || string(rpcErr.Data) != `{"kind":"not_found"}` {
		t.Errorf("b error %v", r.err)
	}
	select {
	case got := <-notified:
		if got != `ping {"n":1}` {
			t.Errorf("notification %q", got)
		}
	case <-ctx.Done():
		t.Fatal("no notification")
	}

	_ = fromPeerW.Close()
	select {
	case <-c.Done():
	case <-ctx.Done():
		t.Fatal("Done did not close after EOF")
	}
	if _, err := c.Call(ctx, "c", nil); !errors.Is(err, ErrClosed) {
		t.Errorf("call after close: %v", err)
	}
}
