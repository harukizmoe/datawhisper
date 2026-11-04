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

// Event is one event of GET /v1/conversations/:id/subscribe.
type Event struct {
	// Name is "snapshot", "ops" or "end".
	Name string `json:"-"`
	// Seq is 0 for the snapshot, then 1, 2, … for ops.
	Seq int `json:"seq"`
	// View is the snapshot's ConversationView, decoded as JSON (maps, slices, float64, string, bool, nil).
	View any `json:"view"`
	// Ops are the Chord delta ops of an ops event.
	Ops []json.RawMessage `json:"ops"`
	// Kind is why an end event's watch ended: stopped, aborted, ended, listener_error or failed.
	Kind string `json:"kind"`
}

// ErrEnded is returned by Subscribe when the service ended the stream with an end event.
var ErrEnded = errors.New("subscription ended by the service")

// ErrIdle is returned by Subscribe when nothing arrived for IdleTimeout: the connection is presumed dead.
var ErrIdle = errors.New("subscription idle: no data or heartbeat")

// Subscribe streams the events of conversation conv ("root" or a numeric id) to onEvent until ctx ends, the stream
// breaks, or onEvent returns an error. It never returns nil: ctx.Err(), ErrEnded, ErrIdle, an *Error (404 for an
// unknown conversation), a transport error, or onEvent's error.
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

// orCause prefers the cancellation cause (ErrIdle, the caller's ctx.Err()) over the transport error it caused.
func orCause(ctx context.Context, err error) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	return err
}

// idleReader restarts the idle watchdog whenever bytes arrive, heartbeat comments included.
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

// ReadSSE parses a text/event-stream of `event:` and `data:` lines; comment lines (`:` heartbeats) and `id:` are
// skipped. It returns nil at EOF, or the first error of onEvent or of decoding.
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
