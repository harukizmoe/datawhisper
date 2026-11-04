package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// pipeConn 把两对 io.Pipe 拼成一条 Pipe：r 是服务的 stdout，w 是服务的 stdin。
type pipeConn struct {
	r io.Reader
	w io.WriteCloser
}

func (c pipeConn) Read(p []byte) (int, error)  { return c.r.Read(p) }
func (c pipeConn) Write(p []byte) (int, error) { return c.w.Write(p) }
func (c pipeConn) Close() error                { return c.w.Close() }

// testRequest 是一条客户端请求。
type testRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// testServer 是管道另一端的 JSON-RPC 服务：读请求，按 handler 应答；写记录时串行化。
type testServer struct {
	t   *testing.T
	in  *io.PipeReader
	out *io.PipeWriter
	wmu sync.Mutex
}

// newClient 起一个内存管道上的客户端与测试服务。
func newClient(t *testing.T, handler func(*testServer, testRequest)) (*Client, *testServer) {
	t.Helper()
	toServiceR, toServiceW := io.Pipe()
	fromServiceR, fromServiceW := io.Pipe()
	s := &testServer{t: t, in: toServiceR, out: fromServiceW}
	go s.run(handler)
	t.Cleanup(func() {
		_ = toServiceW.Close()   // 服务的 stdin：客户端写端 EOF
		_ = fromServiceW.Close() // 服务的 stdout：客户端读到 EOF
	})
	return New(pipeConn{r: fromServiceR, w: toServiceW}), s
}

func (s *testServer) run(handler func(*testServer, testRequest)) {
	br := bufio.NewReader(s.in)
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return
		}
		var req testRequest
		if json.Unmarshal([]byte(strings.TrimSuffix(line, "\n")), &req) != nil || req.Method == "" {
			continue
		}
		handler(s, req)
	}
}

func (s *testServer) write(record any) {
	line, err := json.Marshal(record)
	if err != nil {
		s.t.Errorf("marshal %v: %v", record, err)
		return
	}
	s.wmu.Lock()
	_, _ = s.out.Write(append(line, '\n'))
	s.wmu.Unlock()
}

func (s *testServer) respond(id json.RawMessage, result any) {
	s.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (s *testServer) fail(id json.RawMessage, code int, message, kind string) {
	e := map[string]any{"code": code, "message": message}
	if kind != "" {
		e["data"] = map[string]any{"kind": kind}
	}
	s.write(map[string]any{"jsonrpc": "2.0", "id": id, "error": e})
}

// event 推一条 conversation.event 通知。
func (s *testServer) event(subscriptionID int, name string, fields map[string]any) {
	params := map[string]any{"subscriptionId": subscriptionID, "event": name}
	for k, v := range fields {
		params[k] = v
	}
	s.write(map[string]any{"jsonrpc": "2.0", "method": "conversation.event", "params": params})
}

func (s *testServer) closeOutput() { _ = s.out.Close() }

// params 把请求参数解码成 map；没有参数时返回空 map。
func (r testRequest) params() map[string]any {
	if len(r.Params) == 0 || string(r.Params) == "null" {
		return map[string]any{}
	}
	var m map[string]any
	_ = json.Unmarshal(r.Params, &m)
	return m
}

// recorded 读取 testdata/stream.jsonl，这是从 P0.3 spike 服务录下来的订阅通知（快照加 ops）：一个会调用
// tool 的提示，和一个纯 markdown 的提示。
func recorded(t *testing.T) []Event {
	t.Helper()
	f, err := os.Open("testdata/stream.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var events []Event
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64<<10), 64<<20)
	for scanner.Scan() {
		var rec struct {
			Method string `json:"method"`
			Params Event  `json:"params"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &rec); err != nil {
			t.Fatal(err)
		}
		if rec.Method == notifyConversationEvent {
			events = append(events, rec.Params)
		}
	}
	if err := scanner.Err(); err != nil {
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
			if !m.Done && m.Tool != nil && m.Tool.Name == "describe_table" && m.Tool.Status == "running" {
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
		`tool:true:describe_table`,
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
	// 调用与结果合并成同一行：参数、结果全文与耗时都在 Tool 里，界面默认只显示一行摘要。
	if st.Messages[1].Tool == nil || st.Messages[1].Tool.Output != "sales: 42 rows, 7 columns" ||
		st.Messages[1].Tool.DurationMS != 504 || st.Messages[1].Tool.Status != "ok" || st.Messages[1].Tool.Args != `table=sales` {
		t.Errorf("tool row %+v", st.Messages[1].Tool)
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
		`["s",["a","n"],5]`,        // 设置
		`["a",["a","s"],"!"]`,      // 追加文本
		`["t",["a","s"],1]`,        // 从前面丢掉一个 UTF-16 unit
		`["p",["list"],1,1,[7,8]]`, // 拼接：[1,7,8,3]
		`["m",["list"],[3,2,1,0]]`, // 重排：[3,8,7,1]
		`["d",["list",0]]`,         // 删掉一个下标：[8,7,1]
		`["s",["list",3],9]`,       // 在下标等于长度处设置即追加
		`["d",["keep"]]`,           // 删掉一个 key
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

func TestClientCallsAndErrors(t *testing.T) {
	var mu sync.Mutex
	bodies := map[string]map[string]any{} // 方法 → 收到的参数
	record := func(req testRequest) map[string]any {
		params := req.params()
		mu.Lock()
		bodies[req.Method] = params
		mu.Unlock()
		return params
	}
	c, _ := newClient(t, func(s *testServer, req testRequest) {
		params := record(req)
		conv, _ := params["id"].(string)
		switch req.Method {
		case "health":
			s.respond(req.ID, map[string]any{"ok": true, "scheduling": "idle", "tasks": 2, "submissions": 1, "computePid": 7})
		case "conversation.list":
			s.respond(req.ID, map[string]any{"conversations": []any{
				map[string]any{"id": 2, "root": false, "lastEntryId": 6, "updatedAt": 1},
				map[string]any{"id": 1, "root": true, "lastEntryId": nil, "updatedAt": nil},
			}})
		case "conversation.create":
			s.respond(req.ID, map[string]any{"id": 7})
		case "conversation.setModel":
			s.respond(req.ID, map[string]any{"model": map[string]any{"provider": "p", "modelId": "m"}, "thinkingLevel": "off"})
		case "conversation.submit":
			switch conv {
			case "root":
				requestID, _ := params["requestId"].(string)
				whenBusy, _ := params["whenBusy"].(string)
				s.respond(req.ID, map[string]any{"submissionId": len(requestID), "status": whenBusy})
			case "2":
				s.fail(req.ID, codeAppError, "no model configured", "no_model")
			case "3":
				s.fail(req.ID, codeAppError, "model unavailable", "model_unavailable")
			default:
				s.fail(req.ID, codeAppError, "not found", "not_found")
			}
		case "conversation.abort":
			if conv == "9" {
				s.fail(req.ID, codeAppError, "not found", "not_found")
				return
			}
			s.respond(req.ID, map[string]any{"ok": true})
		case "models.available":
			s.respond(req.ID, map[string]any{"models": []any{map[string]any{
				"provider": "p", "id": "m", "name": "M", "contextWindow": 8, "maxTokens": 4,
				"reasoning": true, "vision": false, "thinkingLevels": []string{"off", "low"},
			}}})
		default:
			s.fail(req.ID, -32601, "method not found: "+req.Method, "")
		}
	})
	ctx := context.Background()
	h, err := c.Health(ctx)
	if err != nil || !h.OK || h.Tasks != 2 || h.ComputePID == nil || *h.ComputePID != 7 {
		t.Errorf("health: %+v %v", h, err)
	}
	list, err := c.Conversations(ctx)
	if err != nil || len(list) != 2 || list[0].ID != 2 || !list[1].Root {
		t.Errorf("conversations: %+v %v", list, err)
	}
	if err := c.Abort(ctx, "9"); !errors.Is(err, ErrNotFound) || errors.Is(err, ErrNoModel) {
		t.Errorf("abort of an unknown conversation: %v", err)
	}
	var apiErr *Error
	if _, err := c.Call(ctx, "nope", nil); !errors.As(err, &apiErr) || apiErr.Code != -32601 {
		t.Errorf("unknown method: %v", err)
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
	mu.Lock()
	if body := bodies["conversation.create"]; len(body) != 0 {
		t.Errorf("create with the default model sent %v", body)
	}
	mu.Unlock()
	_, _ = c.CreateConversation(ctx, CreateConversationRequest{Model: &ModelRef{Provider: "p", ModelID: "m"}, ThinkingLevel: "low"})
	mu.Lock()
	body := bodies["conversation.create"]
	model, _ := body["model"].(map[string]any)
	if model["provider"] != "p" || model["modelId"] != "m" || body["thinkingLevel"] != "low" {
		t.Errorf("create with a model sent %v", body)
	}
	mu.Unlock()
	agent, err := c.SetModel(ctx, "7", SetModelRequest{Model: ModelRef{Provider: "p", ModelID: "m"}})
	if err != nil || agent.Model == nil || *agent.Model != (ModelRef{Provider: "p", ModelID: "m"}) || agent.ThinkingLevel != "off" {
		t.Errorf("set model: %+v %v", agent, err)
	}
	mu.Lock()
	body = bodies["conversation.setModel"]
	level, present := body["thinkingLevel"]
	if body["id"] != "7" || !present || level != nil {
		t.Errorf("set model sent %v", body)
	}
	mu.Unlock()
	models, err := c.AvailableModels(ctx)
	if err != nil || len(models) != 1 || models[0].ID != "m" || !models[0].Reasoning || fmt.Sprint(models[0].ThinkingLevels) != "[off low]" {
		t.Errorf("available models: %+v %v", models, err)
	}
}

// TestConcurrentCallsKeepTheirOwnResponses 让服务按与请求相反的顺序响应，证明客户端按 id 关联、不依赖顺序。
func TestConcurrentCallsKeepTheirOwnResponses(t *testing.T) {
	const n = 24
	c, _ := newClient(t, func(s *testServer, req testRequest) {
		params := req.params()
		v, _ := params["n"].(float64)
		go func() {
			time.Sleep(time.Duration(n-int(v)) * 2 * time.Millisecond) // 后发的先回
			s.respond(req.ID, map[string]any{"n": int(v)})
		}()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := range n {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			raw, err := c.Call(ctx, "echo", map[string]int{"n": i})
			if err != nil {
				errs <- fmt.Errorf("call %d: %w", i, err)
				return
			}
			var got struct{ N int }
			if err := json.Unmarshal(raw, &got); err != nil || got.N != i {
				errs <- fmt.Errorf("call %d got %s (%v)", i, raw, err)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

func TestSubscribeBuffersEventsBeforeTheResponse(t *testing.T) {
	unsubscribed := make(chan int, 1)
	c, _ := newClient(t, func(s *testServer, req testRequest) {
		switch req.Method {
		case "conversation.subscribe":
			// 服务的顺序：先推 snapshot/ops，再回响应；响应之后还有一条 ops。
			s.event(5, "snapshot", map[string]any{"seq": 0, "view": map[string]any{"conversation": map[string]any{"id": 1}}})
			s.event(5, "ops", map[string]any{"seq": 1, "ops": [][]any{{"s", []any{"a"}, 2}}})
			s.respond(req.ID, map[string]any{"subscriptionId": 5})
			s.event(5, "ops", map[string]any{"seq": 2, "ops": [][]any{{"s", []any{"a"}, 3}}})
		case "conversation.unsubscribe":
			v, _ := req.params()["subscriptionId"].(float64)
			unsubscribed <- int(v)
			s.respond(req.ID, map[string]any{"ok": true})
		default:
			s.fail(req.ID, -32601, "unexpected", "")
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var got []string
	var replica Replica
	err := c.Subscribe(ctx, "1", func(ev Event) error {
		if err := replica.Apply(ev); err != nil {
			return err
		}
		got = append(got, fmt.Sprintf("%s:%d", ev.Name, ev.Seq))
		if ev.Seq == 2 {
			cancel()
		}
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("subscribe ended with %v", err)
	}
	if fmt.Sprint(got) != "[snapshot:0 ops:1 ops:2]" {
		t.Errorf("events %v", got)
	}
	if fmt.Sprint(replica.Tree) != "map[a:3 conversation:map[id:1]]" {
		t.Errorf("replica %v", replica.Tree)
	}
	select {
	case id := <-unsubscribed:
		if id != 5 {
			t.Errorf("unsubscribed %d, want 5", id)
		}
	case <-time.After(5 * time.Second):
		t.Error("no unsubscribe after the context ended")
	}
}

func TestSubscribeEndDoesNotUnsubscribe(t *testing.T) {
	var unsubscribed sync.Mutex
	sawUnsubscribe := false
	c, _ := newClient(t, func(s *testServer, req testRequest) {
		switch req.Method {
		case "conversation.subscribe":
			s.event(3, "snapshot", map[string]any{"seq": 0, "view": map[string]any{}})
			s.event(3, "end", map[string]any{"kind": "stored"})
			s.respond(req.ID, map[string]any{"subscriptionId": 3})
		case "conversation.unsubscribe":
			unsubscribed.Lock()
			sawUnsubscribe = true
			unsubscribed.Unlock()
			s.respond(req.ID, map[string]any{"ok": true})
		}
	})
	var names []string
	err := c.Subscribe(context.Background(), "1", func(ev Event) error {
		names = append(names, ev.Name)
		return nil
	})
	if !errors.Is(err, ErrEnded) || !strings.Contains(err.Error(), "stored") {
		t.Errorf("subscribe ended with %v", err)
	}
	if fmt.Sprint(names) != "[snapshot]" {
		t.Errorf("events %v", names)
	}
	unsubscribed.Lock()
	defer unsubscribed.Unlock()
	if sawUnsubscribe {
		t.Error("unsubscribed after the service ended the subscription")
	}
}

func TestSubscribeCancelBeforeTheResponseStillUnsubscribes(t *testing.T) {
	unsubscribed := make(chan int, 1)
	c, _ := newClient(t, func(s *testServer, req testRequest) {
		switch req.Method {
		case "conversation.subscribe":
			time.Sleep(50 * time.Millisecond)
			s.event(9, "snapshot", map[string]any{"seq": 0, "view": map[string]any{}})
			s.respond(req.ID, map[string]any{"subscriptionId": 9})
		case "conversation.unsubscribe":
			v, _ := req.params()["subscriptionId"].(float64)
			unsubscribed <- int(v)
			s.respond(req.ID, map[string]any{"ok": true})
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := c.Subscribe(ctx, "1", func(Event) error { return nil }); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("subscribe ended with %v", err)
	}
	select {
	case id := <-unsubscribed:
		if id != 9 {
			t.Errorf("unsubscribed %d, want 9", id)
		}
	case <-time.After(5 * time.Second):
		t.Error("the abandoned subscription was never unsubscribed")
	}
}

func TestClientClosesOnEOF(t *testing.T) {
	c, s := newClient(t, func(s *testServer, req testRequest) {
		// 永不响应：连接结束时调用方必须得到 ErrClosed。
	})
	errc := make(chan error, 1)
	go func() {
		_, err := c.Call(context.Background(), "health", nil)
		errc <- err
	}()
	time.Sleep(20 * time.Millisecond)
	s.closeOutput()
	select {
	case err := <-errc:
		if !errors.Is(err, ErrClosed) {
			t.Errorf("pending call ended with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the pending call did not fail when the pipe closed")
	}
	<-c.Done()
	if _, err := c.Call(context.Background(), "health", nil); !errors.Is(err, ErrClosed) {
		t.Errorf("call after close: %v", err)
	}
	if err := c.Subscribe(context.Background(), "root", func(Event) error { return nil }); !errors.Is(err, ErrClosed) {
		t.Errorf("subscribe after close: %v", err)
	}
}

func TestSlowSubscriberDoesNotBlockOtherCalls(t *testing.T) {
	c, _ := newClient(t, func(s *testServer, req testRequest) {
		switch req.Method {
		case "conversation.subscribe":
			// 一次推够事件：reader 必须继续消费，哪怕订阅方还在处理第一个。
			s.event(1, "snapshot", map[string]any{"seq": 0, "view": map[string]any{}})
			for i := 1; i <= 3; i++ {
				s.event(1, "ops", map[string]any{"seq": i, "ops": [][]any{{"s", []any{"n"}, i}}})
			}
			s.respond(req.ID, map[string]any{"subscriptionId": 1})
		case "health":
			s.respond(req.ID, map[string]any{"ok": true})
		case "conversation.unsubscribe":
			s.respond(req.ID, map[string]any{"ok": true})
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{})
	release := make(chan struct{})
	subDone := make(chan error, 1)
	go func() {
		subDone <- c.Subscribe(ctx, "1", func(ev Event) error {
			if ev.Name == "snapshot" {
				close(started)
				<-release // 故意卡住订阅方
			}
			return nil
		})
	}()
	<-started
	// 订阅方卡住时读循环仍在消费，所以别的请求还能得到响应。
	callCtx, callCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer callCancel()
	h, err := c.Health(callCtx)
	if err != nil || !h.OK {
		t.Fatalf("health while the subscriber was blocked: %+v %v", h, err)
	}
	close(release)
	cancel()
	select {
	case err := <-subDone:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("subscribe ended with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("subscribe did not return")
	}
}

func TestFollowResubscribesFromAFreshSnapshot(t *testing.T) {
	var mu sync.Mutex
	n := 0
	c, _ := newClient(t, func(s *testServer, req testRequest) {
		switch req.Method {
		case "conversation.subscribe":
			mu.Lock()
			n++
			i := n
			mu.Unlock()
			subscriptionID := 100 + i
			switch i {
			case 1: // 一个 snapshot 加一个 op，然后服务结束订阅
				s.event(subscriptionID, "snapshot", map[string]any{"seq": 0, "view": map[string]any{"conversation": map[string]any{"id": 1}, "n": 1}})
				s.event(subscriptionID, "ops", map[string]any{"seq": 1, "ops": [][]any{{"s", []any{"n"}, 2}}})
				s.event(subscriptionID, "end", map[string]any{"kind": "stopped"})
			case 2: // 一个乱序的 op
				s.event(subscriptionID, "snapshot", map[string]any{"seq": 0, "view": map[string]any{"conversation": map[string]any{"id": 1}, "n": 3}})
				s.event(subscriptionID, "ops", map[string]any{"seq": 2, "ops": [][]any{{"s", []any{"n"}, 99}}})
			case 3: // 服务把 watch 关掉了
				s.event(subscriptionID, "snapshot", map[string]any{"seq": 0, "view": map[string]any{"conversation": map[string]any{"id": 1}, "n": 4}})
				s.event(subscriptionID, "end", map[string]any{"kind": "ended"})
			default: // 会话已经没了：Follow 会停下
				s.fail(req.ID, codeAppError, "conversation not found: 1", "not_found")
				return
			}
			s.respond(req.ID, map[string]any{"subscriptionId": subscriptionID})
		case "conversation.unsubscribe":
			s.respond(req.ID, map[string]any{"ok": true})
		}
	})
	var seqs []int
	var drops []error
	err := Follow(context.Background(), c, "1", FollowHandler{
		OnState:      func(st State) { seqs = append(seqs, st.Seq) },
		OnDisconnect: func(err error) { drops = append(drops, err) },
	})
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("follow ended with %v", err)
	}
	if fmt.Sprint(seqs) != "[0 1 0 0]" {
		t.Errorf("states at seqs %v", seqs)
	}
	if len(drops) != 3 || !errors.Is(drops[0], ErrEnded) || !errors.Is(drops[1], ErrSequence) || !errors.Is(drops[2], ErrEnded) {
		t.Errorf("disconnects %v", drops)
	}
}

func TestFollowStopsWithItsContext(t *testing.T) {
	c, _ := newClient(t, func(s *testServer, req testRequest) {
		switch req.Method {
		case "conversation.subscribe":
			s.event(1, "snapshot", map[string]any{"seq": 0, "view": map[string]any{}})
			s.respond(req.ID, map[string]any{"subscriptionId": 1})
		case "conversation.unsubscribe":
			s.respond(req.ID, map[string]any{"ok": true})
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	err := Follow(ctx, c, "root", FollowHandler{OnState: func(State) { cancel() }})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("follow ended with %v", err)
	}
}
