package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Event 是 GET /v1/conversations/:id/subscribe 中的一个事件。
type Event struct {
	// Name 是 "snapshot"、"ops" 或 "end"。
	Name string `json:"-"`
	// Seq 对 snapshot 为 0，之后每个 ops 依次为 1、2、……
	Seq int `json:"seq"`
	// View 是 snapshot 的 ConversationView，已解码成 JSON（map、slice、float64、string、bool、nil）。
	View any `json:"view"`
	// Ops 是 ops 事件里的 Chord delta ops。
	Ops []json.RawMessage `json:"ops"`
	// Kind 是 end 事件中 watch 结束的原因：stopped、aborted、ended、listener_error 或 failed。
	Kind string `json:"kind"`
}

// ErrEnded 在服务用 end 事件结束流时由 Subscribe 返回。
var ErrEnded = errors.New("subscription ended by the service")

// ErrIdle 在 IdleTimeout 内什么都没收到时由 Subscribe 返回：可以认为连接已经死了。
var ErrIdle = errors.New("subscription idle: no data or heartbeat")

// Subscribe 把会话 conv（"root" 或数字 id）的事件流式送给 onEvent，直到 ctx 结束、流断开，或 onEvent 返回错误。
// 它永远不会返回 nil：可能是 ctx.Err()、ErrEnded、ErrIdle、*Error（会话未知时为 404）、传输层错误，或
// onEvent 返回的错误。
func (c *Client) Subscribe(ctx context.Context, conv string, onEvent func(Event) error) error {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	req, err := c.request(ctx, http.MethodGet, "/v1/conversations/"+url.PathEscape(conv)+"/subscribe", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	idle := c.IdleTimeout
	if idle <= 0 {
		idle = 45 * time.Second
	}
	watchdog := time.AfterFunc(idle, func() { cancel(ErrIdle) })
	defer watchdog.Stop()
	res, err := c.httpClient().Do(req)
	if err != nil {
		return orCause(ctx, err)
	}
	defer res.Body.Close()
	if err := responseError(res); err != nil {
		return err
	}
	body := &idleReader{r: res.Body, timer: watchdog, idle: idle}
	err = ReadSSE(body, func(ev Event) error {
		if ev.Name == "end" {
			return fmt.Errorf("%w (%s)", ErrEnded, ev.Kind)
		}
		return onEvent(ev)
	})
	if err == nil {
		err = io.ErrUnexpectedEOF
	}
	return orCause(ctx, err)
}

// orCause 优先返回取消原因（ErrIdle、调用方的 ctx.Err()），而不是它引发的传输层错误。
func orCause(ctx context.Context, err error) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	return err
}

// idleReader 每收到一些字节就重置空闲看门狗，心跳注释也算。
type idleReader struct {
	r     io.Reader
	timer *time.Timer
	idle  time.Duration
}

func (r *idleReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	if n > 0 {
		r.timer.Reset(r.idle)
	}
	return n, err
}

// ReadSSE 解析由 `event:` 和 `data:` 行组成的 text/event-stream；注释行（`:` 心跳）和 `id:` 会被跳过。到
// EOF 时返回 nil；否则返回 onEvent 或解码的第一个错误。
func ReadSSE(r io.Reader, onEvent func(Event) error) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64<<10), 64<<20)
	var name string
	var data strings.Builder
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		switch {
		case line == "":
			if data.Len() > 0 {
				ev := Event{Name: name}
				if err := json.Unmarshal([]byte(data.String()), &ev); err != nil {
					return fmt.Errorf("event %s: %w", name, err)
				}
				if err := onEvent(ev); err != nil {
					return err
				}
			}
			name = ""
			data.Reset()
		case strings.HasPrefix(line, ":"):
		case strings.HasPrefix(line, "event:"):
			name = strings.TrimSpace(line[len("event:"):])
		case strings.HasPrefix(line, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(line[len("data:"):], " "))
		}
	}
	return scanner.Err()
}
