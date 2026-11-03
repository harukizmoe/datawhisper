package main

import (
	"context"
	"encoding/json"
	"fmt"
	"image/png"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// replay reads the recorded /subscribe stream (testdata/stream.sse, recorded from the spike4 server by
// server/spike/scripts/record-stream.sh: one tool-calling prompt and one plain markdown prompt).
func replay(t *testing.T) []event {
	t.Helper()
	f, err := os.Open("testdata/stream.sse")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var events []event
	if err := readSSE(f, func(ev event) { events = append(events, ev) }); err != nil {
		t.Fatal(err)
	}
	return events
}

// TestReplica applies the recorded snapshot + ops and checks the derived chat rows.
func TestReplica(t *testing.T) {
	var cv conversation
	for _, ev := range replay(t) {
		if err := cv.apply(ev); err != nil {
			t.Fatalf("seq %d: %v", ev.Seq, err)
		}
	}
	var got []string
	for _, m := range cv.messages() {
		got = append(got, fmt.Sprintf("%s:%t:%s", m.role, m.done, strings.SplitN(m.text, "\n", 2)[0]))
	}
	want := []string{
		`user:true:Describe sales CALL:describe_table{"table":"sales"}`,
		`tool:true:→ describe_table {"table":"sales"}`,
		`tool:true:← sales: 42 rows, 7 columns`,
		`assistant:true:## Result`,
		`user:true:Summarize the data`,
		`assistant:true:## Hello`,
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("rows:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// TestMarkdownStreaming runs the view without a window, feeding the recorded events one by one as the
// subscription goroutine would through Window.Update, and checks the reply streams in through
// markdown.Stream and ends as markdown.View in the same list row (same key).
func TestMarkdownStreaming(t *testing.T) {
	app := &chat{}
	tt := ui.NewTester(app.view, 1280, 800)
	streamed := map[string]bool{}
	running := false
	streamingKeys := map[string]bool{}
	for _, ev := range replay(t) {
		app.onEvent(ev)
		tt.Frame()
		tt.Advance(300 * time.Millisecond)
		for _, m := range app.rows {
			if m.role == "tool" && strings.HasPrefix(m.text, "⋯ describe_table running") && tt.HasText("⋯ describe_table running") {
				running = true
			}
			if m.role != "assistant" || m.done {
				continue
			}
			streamingKeys[m.key] = true
			// A partial reply: its heading is on screen before the reply is complete.
			for _, heading := range []string{"Result", "Hello"} {
				if strings.HasPrefix(m.text, "## "+heading) && tt.HasText(heading) {
					streamed[heading] = true
				}
			}
		}
	}
	if !streamed["Result"] || !streamed["Hello"] {
		t.Errorf("partial replies not shown while streaming: %v", streamed)
	}
	if !running {
		t.Error("running tool slot never shown")
	}
	committed := map[string]bool{}
	for _, m := range app.rows {
		if m.role == "assistant" && m.done {
			committed[m.key] = true
		}
	}
	if len(streamingKeys) != 2 {
		t.Errorf("streaming reply keys %v, want 2 replies", streamingKeys)
	}
	for key := range streamingKeys {
		if !committed[key] {
			t.Errorf("streaming reply %q has no committed row with the same key; committed %v", key, committed)
		}
	}
	tt.Advance(2 * time.Second)
	for _, s := range []string{"Describe sales", "sales: 42 rows, 7 columns", "Result", "Hello", "streamed", "metric", "42", "print(\"ok\")", "Copy"} {
		if !tt.HasText(s) {
			t.Errorf("final frame lacks %q; texts %q", s, tt.Texts())
		}
	}
	if os.Getenv("SPIKE_WRITE_PNG") != "" {
		f, err := os.Create("headless-view.png")
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if err := png.Encode(f, tt.Image()); err != nil {
			t.Fatal(err)
		}
	}
}

// TestLiveProtocol (needs a running spike4 server: SPIKE_URL, SPIKE_TOKEN) subscribes, submits a prompt,
// applies ops until the run ends, then resubscribes and checks the fresh snapshot equals the replica.
func TestLiveProtocol(t *testing.T) {
	cl := client{base: os.Getenv("SPIKE_URL"), token: os.Getenv("SPIKE_TOKEN")}
	if cl.base == "" {
		t.Skip("SPIKE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var cv conversation
	events := make(chan event, 1024)
	go func() { _ = cl.subscribe(ctx, func(ev event) { events <- ev }) }()
	if err := cv.apply(<-events); err != nil {
		t.Fatal(err)
	}
	before := len(cv.messages())
	id, err := cl.submit(ctx, fmt.Sprintf("live-%d", time.Now().UnixNano()), `Live test CALL:describe_table{"table":"live"}`)
	if err != nil {
		t.Fatal(err)
	}
	opsSeen := 0
	for {
		ev := <-events
		if err := cv.apply(ev); err != nil {
			t.Fatal(err)
		}
		opsSeen++
		rows := cv.messages()
		if field(cv.tree, "docs", "pi.live", "run") == nil && len(rows) > before && rows[len(rows)-1].role == "assistant" && rows[len(rows)-1].done {
			break
		}
	}
	cancel()
	fresh := make(chan event, 1)
	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	go func() { _ = cl.subscribe(ctx2, func(ev event) { fresh <- ev }) }()
	snapshot := <-fresh
	replica, _ := json.Marshal(cv.tree)
	server, _ := json.Marshal(snapshot.View)
	if string(replica) != string(server) {
		t.Errorf("replica after %d ops differs from a fresh snapshot\nreplica: %.400s\nserver:  %.400s", opsSeen, replica, server)
	}
	t.Logf("submission %d; %d ops applied; replica == fresh snapshot (%d bytes)", id, opsSeen, len(server))
}
