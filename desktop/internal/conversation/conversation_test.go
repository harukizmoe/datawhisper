package conversation

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

	"datawhisper/desktop/internal/service"
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
func newClient(t *testing.T, handler func(*testServer, testRequest)) (*service.Client, *testServer) {
	t.Helper()
	toServiceR, toServiceW := io.Pipe()
	fromServiceR, fromServiceW := io.Pipe()
	s := &testServer{t: t, in: toServiceR, out: fromServiceW}
	go s.run(handler)
	t.Cleanup(func() {
		_ = toServiceW.Close()   // 服务的 stdin：客户端写端 EOF
		_ = fromServiceW.Close() // 服务的 stdout：客户端读到 EOF
	})
	return service.New(pipeConn{r: fromServiceR, w: toServiceW}), s
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
func recorded(t *testing.T) []service.Event {
	t.Helper()
	f, err := os.Open("testdata/stream.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var events []service.Event
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64<<10), 64<<20)
	for scanner.Scan() {
		var rec struct {
			Method string        `json:"method"`
			Params service.Event `json:"params"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &rec); err != nil {
			t.Fatal(err)
		}
		if rec.Method == "conversation.event" {
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
	if st.Model == nil || *st.Model != (service.ModelRef{Provider: "stub", ModelID: "stub-chat"}) || st.ThinkingLevel != "" {
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
	if err := r.Apply(service.Event{Name: "ops", Seq: 1}); !errors.Is(err, ErrSequence) {
		t.Errorf("ops before a snapshot: %v", err)
	}
	_ = r.Apply(service.Event{Name: "snapshot", View: map[string]any{}})
	if err := r.Apply(service.Event{Name: "ops", Seq: 2}); !errors.Is(err, ErrSequence) {
		t.Errorf("seq 2 after 0: %v", err)
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
				s.fail(req.ID, -32000, "conversation not found: 1", "not_found")
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
	if !errors.Is(err, service.ErrNotFound) {
		t.Errorf("follow ended with %v", err)
	}
	if fmt.Sprint(seqs) != "[0 1 0 0]" {
		t.Errorf("states at seqs %v", seqs)
	}
	if len(drops) != 3 || !errors.Is(drops[0], service.ErrEnded) || !errors.Is(drops[1], ErrSequence) || !errors.Is(drops[2], service.ErrEnded) {
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

// TestThinkingUsageAndQueue 覆盖副本从 pi-ai 消息里读出的附加信息：思考块成为回复前的一行 "thinking"
// （被遮蔽的块不显示），用量与时间只挂在一次回复的最后一行上，排队的用户输入带上正文（宿主写入的不算）。
func TestThinkingUsageAndQueue(t *testing.T) {
	r := Replica{Tree: map[string]any{
		"conversation": map[string]any{"id": 7},
		"entries": []any{
			map[string]any{"id": 1, "kind": "pi.user", "model": []any{map[string]any{"role": "user", "content": "看看销量", "timestamp": 1000.0}}},
			map[string]any{"id": 2, "kind": "pi.assistant", "byTaskId": 9, "model": []any{map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "thinking", "thinking": "先查表结构"},
					map[string]any{"type": "thinking", "thinking": "secret", "redacted": true},
					map[string]any{"type": "toolCall", "id": "c1", "name": "query_data", "arguments": map[string]any{"sql": "select 1"}},
				},
				"usage":     map[string]any{"input": 120.0, "output": 30.0, "cacheRead": 5.0, "totalTokens": 155.0, "cost": map[string]any{"total": 0.002}},
				"timestamp": 2000.0, "model": "gw/flash", "durationMs": 1500.0,
			}}},
		},
		"docs": map[string]any{
			"pi.inbox": map[string]any{"items": []any{
				map[string]any{"id": 1, "mode": "followUp", "content": "再画个图"},
				map[string]any{"id": 2, "mode": "write", "entry": map[string]any{}},
			}},
			"pi.live": map[string]any{
				"run":        map[string]any{"taskId": 10},
				"generation": map[string]any{"message": map[string]any{"content": []any{map[string]any{"type": "thinking", "thinking": "正在想"}}}},
			},
		},
	}}
	st := r.State()
	var rows []string
	for _, m := range st.Messages {
		rows = append(rows, fmt.Sprintf("%s:%s:%t", m.Role, m.Key, m.Done))
	}
	want := "user:e1:true thinking:g9.th:true tool:e2.2:true thinking:g10.th:false"
	if strings.Join(rows, " ") != want {
		t.Fatalf("rows %q, want %q", strings.Join(rows, " "), want)
	}
	if st.Messages[1].Text != "先查表结构" {
		t.Errorf("thinking %q", st.Messages[1].Text)
	}
	if st.Messages[0].Time != 1000 {
		t.Errorf("user time %d", st.Messages[0].Time)
	}
	tool := st.Messages[2]
	if tool.Usage == nil || tool.Usage.Input != 120 || tool.Usage.Total != 155 || tool.Usage.Cost != 0.002 || tool.Usage.DurationMS != 1500 || tool.Time != 2000 || tool.Model != "gw/flash" {
		t.Errorf("usage on the last row %+v %+v", tool.Usage, tool)
	}
	if st.Messages[1].Usage != nil {
		t.Error("usage also on the thinking row")
	}
	if st.Queued != 2 || len(st.QueuedInputs) != 1 || st.QueuedInputs[0] != (QueuedInput{Text: "再画个图", Mode: "followUp"}) {
		t.Errorf("queue %d %+v", st.Queued, st.QueuedInputs)
	}
}
