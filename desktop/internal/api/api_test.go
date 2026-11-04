package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// recorded reads testdata/stream.sse, a /subscribe stream recorded from the P0.3 spike server: one tool-calling
// prompt and one plain markdown prompt.
func recorded(t *testing.T) []Event {
	t.Helper()
	f, err := os.Open("testdata/stream.sse")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var events []Event
	if err := ReadSSE(f, func(ev Event) error { events = append(events, ev); return nil }); err != nil {
		t.Fatal(err)
	}
	return events
}

func TestReplicaFromRecording(t *testing.T) {
	var r Replica
	streaming := map[string]bool{}
	running := false
	for _, ev := range recorded(t) {
		if err := r.Apply(ev); err != nil {
			t.Fatalf("seq %d: %v", ev.Seq, err)
		}
		for _, m := range r.State().Messages {
			if !m.Done && m.Role == "assistant" {
				streaming[m.Key] = true
			}
			if !m.Done && strings.HasPrefix(m.Text, "⋯ describe_table running") {
				running = true
			}
		}
	}
	st := r.State()
	var got []string
	committed := map[string]bool{}
	for _, m := range st.Messages {
		got = append(got, fmt.Sprintf("%s:%t:%s", m.Role, m.Done, strings.SplitN(m.Text, "\n", 2)[0]))
		committed[m.Key] = true
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
	if len(streaming) != 2 || !running {
		t.Errorf("streaming replies %v, running tool shown %t", streaming, running)
	}
	for key := range streaming {
		if !committed[key] {
			t.Errorf("streaming reply %q has no committed row with its key", key)
		}
	}
	if st.Busy || st.Failure != "" || st.Conversation != 1 || st.Seq == 0 || st.Queued != 0 {
		t.Errorf("state %+v", st)
	}
	if st.Model == nil || *st.Model != (ModelRef{Provider: "stub", ModelID: "stub-chat"}) || st.ThinkingLevel != "" {
		t.Errorf("model %v, thinking %q", st.Model, st.ThinkingLevel)
	}
}

func ops(t *testing.T, list ...string) []json.RawMessage {
	t.Helper()
	var out []json.RawMessage
	for _, s := range list {
		out = append(out, json.RawMessage(s))
	}
	return out
}

func TestApplyOps(t *testing.T) {
	var root any
	_ = json.Unmarshal([]byte(`{"a":{"s":"héllo😀"},"list":[1,2,3],"keep":true}`), &root)
	root, err := ApplyOps(root, ops(t,
		`["s",["a","n"],5]`,        // set
		`["a",["a","s"],"!"]`,      // append text
		`["t",["a","s"],1]`,        // drop one UTF-16 unit from the front
		`["p",["list"],1,1,[7,8]]`, // splice: [1,7,8,3]
		`["m",["list"],[3,2,1,0]]`, // reorder: [3,8,7,1]
		`["d",["list",0]]`,         // delete an index: [8,7,1]
		`["s",["list",3],9]`,       // set at the length appends
		`["d",["keep"]]`,           // delete a key
	))
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(root)
	if string(got) != `{"a":{"n":5,"s":"éllo😀!"},"list":[8,7,1,9]}` {
		t.Errorf("tree %s", got)
	}
	root, err = ApplyOps(root, ops(t, `["r",{"x":1}]`))
	if got, _ := json.Marshal(root); err != nil || string(got) != `{"x":1}` {
		t.Errorf("replace: %s %v", got, err)
	}
	for _, bad := range []string{`[]`, `["p",["x"],0,0,[]]`, `["p",[],5,0,[]]`, `["z",["x"]]`, `["s","x",1]`, `["a",["x"]]`} {
		if _, err := ApplyOps(map[string]any{"x": map[string]any{}}, ops(t, bad)); err == nil {
			t.Errorf("%s: no error", bad)
		}
	}
}

func TestReplicaRejectsOutOfSequenceOps(t *testing.T) {
	var r Replica
	if err := r.Apply(Event{Name: "ops", Seq: 1}); !errors.Is(err, ErrSequence) {
		t.Errorf("ops before a snapshot: %v", err)
	}
	_ = r.Apply(Event{Name: "snapshot", View: map[string]any{}})
	if err := r.Apply(Event{Name: "ops", Seq: 2}); !errors.Is(err, ErrSequence) {
		t.Errorf("seq 2 after 0: %v", err)
	}
}

func TestReadSSESkipsCommentsAndJoinsDataLines(t *testing.T) {
	stream := ": ping\n\nevent: snapshot\nid: 0\ndata: {\"seq\":0,\ndata: \"view\":{\"a\":1}}\n\n: ping\n\nevent: ops\r\ndata: {\"seq\":1,\"ops\":[[\"s\",[\"a\"],2]]}\r\n\r\n"
	var events []Event
	if err := ReadSSE(strings.NewReader(stream), func(ev Event) error { events = append(events, ev); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Name != "snapshot" || events[1].Name != "ops" || len(events[1].Ops) != 1 {
		t.Fatalf("events %+v", events)
	}
	var r Replica
	for _, ev := range events {
		if err := r.Apply(ev); err != nil {
			t.Fatal(err)
		}
	}
	if fmt.Sprint(r.Tree) != "map[a:2]" {
		t.Errorf("tree %v", r.Tree)
	}
}

func TestClientErrorsAndAuth(t *testing.T) {
	var bodies sync.Map // path → raw request body
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		bodies.Store(r.Method+" "+r.URL.Path, string(raw))
		switch {
		case r.Header.Get("Authorization") != "Bearer tok":
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
		case r.URL.Path == "/v1/conversations/9/abort":
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not_found"}`))
		case r.URL.Path == "/v1/conversations/root/submit":
			var req SubmitRequest
			_ = json.Unmarshal(raw, &req)
			_ = json.NewEncoder(w).Encode(SubmitResponse{SubmissionID: len(req.RequestID), Status: req.WhenBusy})
		case r.URL.Path == "/v1/conversations/2/submit":
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"no_model"}`))
		case r.URL.Path == "/v1/conversations/3/submit":
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"model_unavailable"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/conversations":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":7}`))
		case r.Method == http.MethodPut && r.URL.Path == "/v1/conversations/7/model":
			_, _ = w.Write([]byte(`{"model":{"provider":"p","modelId":"m"},"thinkingLevel":"off"}`))
		case r.URL.Path == "/v1/models/available":
			_, _ = w.Write([]byte(`{"models":[{"provider":"p","id":"m","name":"M","contextWindow":8,"maxTokens":4,"reasoning":true,"vision":false,"thinkingLevels":["off","low"]}]}`))
		}
	}))
	defer srv.Close()
	ctx := context.Background()
	bad := &Client{Base: srv.URL, Token: "nope"}
	var apiErr *Error
	if _, err := bad.Health(ctx); !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnauthorized {
		t.Errorf("health without the token: %v", err)
	}
	c := &Client{Base: srv.URL, Token: "tok"}
	if err := c.Abort(ctx, "9"); !errors.Is(err, ErrNotFound) || errors.Is(err, ErrNoModel) {
		t.Errorf("abort of an unknown conversation: %v", err)
	}
	res, err := c.Submit(ctx, "root", SubmitRequest{RequestID: "abc", Text: "x", WhenBusy: "steer"})
	if err != nil || res.SubmissionID != 3 || res.Status != "steer" {
		t.Errorf("submit: %+v %v", res, err)
	}
	if _, err := c.Submit(ctx, "2", SubmitRequest{RequestID: "r", Text: "x"}); !errors.Is(err, ErrNoModel) || errors.Is(err, ErrModelUnavailable) {
		t.Errorf("submit without a model: %v", err)
	}
	if _, err := c.Submit(ctx, "3", SubmitRequest{RequestID: "r", Text: "x"}); !errors.Is(err, ErrModelUnavailable) || errors.Is(err, ErrNoModel) {
		t.Errorf("submit with a removed model: %v", err)
	}

	if id, err := c.CreateConversation(ctx, CreateConversationRequest{}); err != nil || id != 7 {
		t.Errorf("create: %d %v", id, err)
	}
	if body, _ := bodies.Load("POST /v1/conversations"); body != `{}` {
		t.Errorf("create with the default model sent %v", body)
	}
	_, _ = c.CreateConversation(ctx, CreateConversationRequest{Model: &ModelRef{Provider: "p", ModelID: "m"}, ThinkingLevel: "low"})
	if body, _ := bodies.Load("POST /v1/conversations"); body != `{"model":{"provider":"p","modelId":"m"},"thinkingLevel":"low"}` {
		t.Errorf("create with a model sent %v", body)
	}
	agent, err := c.SetModel(ctx, "7", SetModelRequest{Model: ModelRef{Provider: "p", ModelID: "m"}})
	if err != nil || agent.Model == nil || *agent.Model != (ModelRef{Provider: "p", ModelID: "m"}) || agent.ThinkingLevel != "off" {
		t.Errorf("set model: %+v %v", agent, err)
	}
	if body, _ := bodies.Load("PUT /v1/conversations/7/model"); body != `{"model":{"provider":"p","modelId":"m"},"thinkingLevel":null}` {
		t.Errorf("set model sent %v", body)
	}
	models, err := c.AvailableModels(ctx)
	if err != nil || len(models) != 1 || models[0].ID != "m" || !models[0].Reasoning || fmt.Sprint(models[0].ThinkingLevels) != "[off low]" {
		t.Errorf("available models: %+v %v", models, err)
	}
}

// sseServer serves scripted subscriptions: the n-th connection gets script(n, w, flush, gone), where gone closes
// when the client went away.
func sseServer(t *testing.T, script func(n int, w http.ResponseWriter, flush func(), gone <-chan struct{})) *httptest.Server {
	var mu sync.Mutex
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		n++
		i := n
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		script(i, w, w.(http.Flusher).Flush, r.Context().Done())
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSubscribeDetectsAnIdleConnection(t *testing.T) {
	srv := sseServer(t, func(_ int, w http.ResponseWriter, flush func(), gone <-chan struct{}) {
		fmt.Fprint(w, "event: snapshot\ndata: {\"seq\":0,\"view\":{}}\n\n")
		flush()
		<-gone // then silence: no event, no heartbeat
	})
	c := &Client{Base: srv.URL, IdleTimeout: 100 * time.Millisecond}
	var got []string
	err := c.Subscribe(context.Background(), "root", func(ev Event) error { got = append(got, ev.Name); return nil })
	if !errors.Is(err, ErrIdle) || fmt.Sprint(got) != "[snapshot]" {
		t.Errorf("err %v, events %v", err, got)
	}
}

func TestFollowResubscribesFromAFreshSnapshot(t *testing.T) {
	srv := sseServer(t, func(n int, w http.ResponseWriter, flush func(), _ <-chan struct{}) {
		switch n {
		case 1: // a snapshot and one op, then the connection drops
			fmt.Fprint(w, "event: snapshot\ndata: {\"seq\":0,\"view\":{\"conversation\":{\"id\":1},\"n\":1}}\n\n")
			fmt.Fprint(w, "event: ops\ndata: {\"seq\":1,\"ops\":[[\"s\",[\"n\"],2]]}\n\n")
		case 2: // an op out of sequence
			fmt.Fprint(w, "event: snapshot\ndata: {\"seq\":0,\"view\":{\"conversation\":{\"id\":1},\"n\":3}}\n\n")
			fmt.Fprint(w, "event: ops\ndata: {\"seq\":2,\"ops\":[[\"s\",[\"n\"],99]]}\n\n")
		case 3: // the service shuts the watch down
			fmt.Fprint(w, "event: snapshot\ndata: {\"seq\":0,\"view\":{\"conversation\":{\"id\":1},\"n\":4}}\n\n")
			fmt.Fprint(w, "event: end\ndata: {\"kind\":\"ended\"}\n\n")
		default:
			w.WriteHeader(http.StatusNotFound) // the conversation is gone: Follow stops
		}
		flush()
	})
	var seqs []int
	var drops []error
	err := Follow(context.Background(), &Client{Base: srv.URL}, "1", FollowHandler{
		OnState:      func(st State) { seqs = append(seqs, st.Seq) },
		OnDisconnect: func(err error) { drops = append(drops, err) },
	})
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("follow ended with %v", err)
	}
	if fmt.Sprint(seqs) != "[0 1 0 0]" {
		t.Errorf("states at seqs %v", seqs)
	}
	if len(drops) != 3 || !errors.Is(drops[1], ErrSequence) || !errors.Is(drops[2], ErrEnded) {
		t.Errorf("disconnects %v", drops)
	}
}

func TestFollowStopsWithItsContext(t *testing.T) {
	srv := sseServer(t, func(_ int, w http.ResponseWriter, flush func(), gone <-chan struct{}) {
		fmt.Fprint(w, "event: snapshot\ndata: {\"seq\":0,\"view\":{}}\n\n")
		flush()
		<-gone // never sends again: the client's context must end the request
	})
	ctx, cancel := context.WithCancel(context.Background())
	err := Follow(ctx, &Client{Base: srv.URL}, "root", FollowHandler{OnState: func(State) { cancel() }})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("follow ended with %v", err)
	}
}
