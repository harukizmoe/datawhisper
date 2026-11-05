package app

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/service"
	"datawhisper/desktop/internal/supervisor"
	"github.com/egoist/mygo/ui"
)

// uiQueue 代替 Window.Update：goroutine 把函数投递进来，测试在自己的 goroutine 上运行它们，在那里由 Tester
// 构建视图。
type uiQueue struct {
	mu   sync.Mutex
	fns  []func()
	wake chan struct{}
}

func newQueue() *uiQueue { return &uiQueue{wake: make(chan struct{}, 1)} }

func (q *uiQueue) post(fn func()) {
	q.mu.Lock()
	q.fns = append(q.fns, fn)
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// run 运行目前投递进来的函数，并报告是否有东西可运行。
func (q *uiQueue) run() bool {
	q.mu.Lock()
	fns := q.fns
	q.fns = nil
	q.mu.Unlock()
	for _, fn := range fns {
		fn()
	}
	return len(fns) > 0
}

// pump 运行投递进来的函数，每批之后重绘一帧，直到 cond 成立。它那一分钟的上限只是把卡死变成失败：每次等待
// 都是在等应用或服务真正会做的事。
func (q *uiQueue) pump(t *testing.T, tt *ui.Tester, what string, cond func() bool) {
	t.Helper()
	guard := time.NewTimer(time.Minute)
	defer guard.Stop()
	for {
		if q.run() {
			tt.Frame()
		}
		if cond() {
			return
		}
		select {
		case <-q.wake:
		case <-guard.C:
			t.Fatalf("waiting for %s: no progress in a minute; texts %q", what, tt.Texts())
		}
	}
}

func expectTexts(t *testing.T, tt *ui.Tester, present []string, absent []string) {
	t.Helper()
	for _, s := range present {
		if !tt.HasText(s) {
			t.Errorf("no %q on screen; texts %q", s, tt.Texts())
		}
	}
	for _, s := range absent {
		if tt.HasText(s) {
			t.Errorf("%q on screen", s)
		}
	}
}

// fakeService 提供视图测试需要的那部分服务：会话 1 和 2（2 里有一条用户消息和一条回复）、一个由
// conversation.create 创建的会话 3（它的 submit 没有可用模型），以及没有模型可用的列表。每次 ready 都新建
// 一对内存管道，模拟服务的一次启动。
type fakeService struct {
	t       *testing.T
	mu      sync.Mutex
	closers []func()
	calls   []fakeCall
}

// fakeCall 是一次假服务收到的请求，测试据此断言界面发出的参数。
type fakeCall struct {
	Method string
	Params map[string]any
}

// callsTo 返回某个方法的调用参数，按到达顺序。
func (f *fakeService) callsTo(method string) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []map[string]any
	for _, call := range f.calls {
		if call.Method == method {
			out = append(out, call.Params)
		}
	}
	return out
}

func newFakeService(t *testing.T) *fakeService {
	f := &fakeService{t: t}
	t.Cleanup(f.stop)
	return f
}

func (f *fakeService) stop() {
	f.mu.Lock()
	closers := f.closers
	f.closers = nil
	f.mu.Unlock()
	for i := len(closers) - 1; i >= 0; i-- {
		closers[i]()
	}
}

// ready 启动一端的假服务，并返回 supervisor 会给出的 ready 状态。
func (f *fakeService) ready(pid int) supervisor.Status {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan struct{})
	f.mu.Lock()
	f.closers = append(f.closers,
		func() { _ = inW.Close() },
		func() { _ = outW.Close() },
		func() { close(done) },
	)
	f.mu.Unlock()
	go f.serve(inR, outW)
	return supervisor.Status{State: supervisor.StateReady, Pipe: &fakePipe{r: outR, w: inW, done: done}, PID: pid}
}

// fakePipe 是测试里的 supervisor.Pipe。
type fakePipe struct {
	r    io.Reader
	w    io.WriteCloser
	done chan struct{}
}

func (c *fakePipe) Read(p []byte) (int, error)  { return c.r.Read(p) }
func (c *fakePipe) Write(p []byte) (int, error) { return c.w.Write(p) }
func (c *fakePipe) Close() error                { return c.w.Close() }
func (c *fakePipe) Wait() error                 { <-c.done; return nil }
func (c *fakePipe) Done() <-chan struct{}       { return c.done }

// fakeView 是会话 id 的快照视图。
func fakeView(id int) any {
	var entries []any
	if id == 2 {
		entries = []any{
			map[string]any{"id": 5, "conversationId": 2, "kind": "pi.user", "model": []any{
				map[string]any{"role": "user", "content": "hello there", "timestamp": 1},
			}},
			map[string]any{"id": 6, "conversationId": 2, "kind": "pi.assistant", "byTaskId": 9, "model": []any{
				map[string]any{"role": "assistant", "content": []any{
					map[string]any{"type": "text", "text": "## General Kenobi\n\nA **bold** reply."},
				}},
			}},
		}
	}
	if id == 4 {
		entries = []any{
			map[string]any{"id": 20, "conversationId": 4, "kind": "pi.user", "model": []any{
				map[string]any{"role": "user", "content": "Look at my workspace", "timestamp": 1},
			}},
			map[string]any{"id": 21, "conversationId": 4, "kind": "pi.assistant", "byTaskId": 30, "model": []any{
				map[string]any{"role": "assistant", "content": []any{
					map[string]any{"type": "text", "text": "I'll check what is available."},
					map[string]any{"type": "toolCall", "id": "call_ws", "name": "workspace_status", "arguments": map[string]any{}},
				}},
			}},
			map[string]any{"id": 22, "conversationId": 4, "kind": "pi.tool-result", "byTaskId": 30, "model": []any{
				map[string]any{"role": "toolResult", "toolCallId": "call_ws", "toolName": "workspace_status", "isError": false, "durationMs": 41,
					"content": []any{map[string]any{"type": "text", "text": `{"system_workspace":{"roots":["/workspace"],"files":[]}}`}}},
			}},
			map[string]any{"id": 23, "conversationId": 4, "kind": "pi.assistant", "byTaskId": 31, "model": []any{
				map[string]any{"role": "assistant", "content": []any{
					map[string]any{"type": "toolCall", "id": "call_ask", "name": "ask_user", "arguments": map[string]any{
						"question": "Which analysis should I run?",
						"options":  []any{"Profit analysis", "Structure analysis"},
					}},
				}},
			}},
			map[string]any{"id": 24, "conversationId": 4, "kind": "pi.tool-result", "byTaskId": 31, "model": []any{
				map[string]any{"role": "toolResult", "toolCallId": "call_ask", "toolName": "ask_user", "isError": false, "durationMs": 3,
					"content": []any{map[string]any{"type": "text", "text": internalAskInstruction}},
					"details": map[string]any{"tool": "ask_user", "question": "Which analysis should I run?",
						"options": []any{"Profit analysis", "Structure analysis"}, "multi_select": false}},
			}},
		}
	}
	if entries == nil {
		entries = []any{}
	}
	return map[string]any{
		"conversation": map[string]any{"id": id},
		"entries":      entries,
		"docs": map[string]any{
			"pi.agent": map[string]any{"model": map[string]any{"provider": "stub", "modelId": "stub-chat"}},
			"pi.live":  map[string]any{},
			"pi.inbox": map[string]any{"items": []any{}},
		},
	}
}

// serve 在内存管道上响应视图测试用到的 JSON-RPC 方法，并记下请求参数。
func (f *fakeService) serve(in io.Reader, out io.Writer) {
	t := f.t
	var mu sync.Mutex
	write := func(record any) {
		line, err := json.Marshal(record)
		if err != nil {
			t.Errorf("fake service: %v", err)
			return
		}
		mu.Lock()
		_, _ = fmt.Fprintf(out, "%s\n", line)
		mu.Unlock()
	}
	respond := func(id json.RawMessage, result any) {
		write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
	event := func(subscriptionID int, name string, fields map[string]any) {
		params := map[string]any{"subscriptionId": subscriptionID, "event": name}
		for k, v := range fields {
			params[k] = v
		}
		write(map[string]any{"jsonrpc": "2.0", "method": "conversation.event", "params": params})
	}
	br := bufio.NewReader(in)
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return
		}
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal([]byte(strings.TrimSuffix(line, "\n")), &req) != nil || req.Method == "" {
			continue
		}
		var params map[string]any
		_ = json.Unmarshal(req.Params, &params)
		f.mu.Lock()
		f.calls = append(f.calls, fakeCall{Method: req.Method, Params: params})
		f.mu.Unlock()
		conv := fmt.Sprint(params["id"])
		switch req.Method {
		case "conversation.list":
			respond(req.ID, map[string]any{"conversations": []any{
				map[string]any{"id": 2, "root": false, "lastEntryId": 6, "updatedAt": 1},
				map[string]any{"id": 1, "root": true, "lastEntryId": nil, "updatedAt": nil},
			}})
		case "session.list":
			respond(req.ID, map[string]any{"conversations": []any{
				map[string]any{"id": 4, "root": false, "title": "Workspace check", "lastEntryId": 24, "updatedAt": 5},
				map[string]any{"id": 2, "root": false, "title": "Greeting", "lastEntryId": 6, "updatedAt": 1},
				map[string]any{"id": 1, "root": true, "title": "Getting started", "lastEntryId": nil, "updatedAt": nil},
			}})
		case "session.rename":
			respond(req.ID, map[string]any{"id": params["id"], "title": params["title"], "pinned": false, "archived": false})
		case "command.list":
			respond(req.ID, map[string]any{"commands": []any{
				map[string]any{"name": "compact", "description": "Summarize the conversation", "type": "prompt", "aliases": []any{"cp"}, "arguments": "none", "available": true},
				map[string]any{"name": "status", "description": "Show the session status", "type": "local", "aliases": []any{}, "arguments": "none", "available": true},
			}, "diagnostics": []any{}})
		case "conversation.setModel":
			respond(req.ID, map[string]any{"model": params["model"], "thinkingLevel": params["thinkingLevel"]})
		case "conversation.create":
			respond(req.ID, map[string]any{"id": 3})
		case "conversation.subscribe":
			n, err := strconv.Atoi(conv)
			if err != nil || n < 1 || n > 4 {
				write(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{
					"code": -32000, "message": "conversation not found: " + conv, "data": map[string]any{"kind": "not_found"},
				}})
				continue
			}
			// 与真服务一致：先推 snapshot，再回订阅响应。
			event(n, "snapshot", map[string]any{"seq": 0, "view": fakeView(n)})
			respond(req.ID, map[string]any{"subscriptionId": n})
		case "conversation.unsubscribe":
			respond(req.ID, map[string]any{"ok": true})
		case "conversation.abort":
			respond(req.ID, map[string]any{"ok": true})
		case "conversation.submit":
			if conv == "3" {
				write(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{
					"code": -32000, "message": "no model configured", "data": map[string]any{"kind": "no_model"},
				}})
				continue
			}
			respond(req.ID, map[string]any{"submissionId": 1, "status": "queued"})
		case "models.available":
			respond(req.ID, map[string]any{"models": []any{
				map[string]any{"provider": "magpie", "id": "auto/deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash", "thinkingLevels": []any{"off", "low", "high"}},
				map[string]any{"provider": "magpie", "id": "auto/other", "name": "Other", "thinkingLevels": []any{"off", "high"}},
			}})
		case "models.view":
			respond(req.ID, map[string]any{
				"providers": []any{},
				"presets": []any{
					map[string]any{"presetId": "ollama", "name": "Ollama", "baseUrl": "http://localhost:11434/v1", "requiresKey": false},
				},
				"defaultModel":      nil,
				"defaultThinking":   nil,
				"credentialBackend": "file",
			})
		case "usage.summary":
			respond(req.ID, map[string]any{"models": map[string]any{}, "tools": map[string]any{}})
		// 「运行」标签：两个长任务（一个运行中）与一个团队委派；workflow.runs.* 故意不实现，界面应隐藏那一节。
		case "jobs.list":
			respond(req.ID, map[string]any{"jobs": []any{
				map[string]any{"id": 12, "type": "export_report", "label": "Quarterly report", "status": "running", "progress": 40, "message": "rendering charts", "error": nil, "conversationId": 4, "createdAt": "2026-11-05T08:00:00Z", "finishedAt": nil},
				map[string]any{"id": 11, "type": "profile_data", "label": "", "status": "succeeded", "progress": 100, "message": "", "error": nil, "conversationId": 4, "createdAt": "2026-11-05T07:00:00Z", "finishedAt": "2026-11-05T07:01:00Z"},
			}})
		case "jobs.cancel":
			respond(req.ID, map[string]any{"id": 12, "type": "export_report", "label": "Quarterly report", "status": "canceled", "progress": 40, "conversationId": 4, "createdAt": "2026-11-05T08:00:00Z"})
		case "teams.activeDelegations":
			respond(req.ID, map[string]any{"delegations": []any{
				map[string]any{"conversation_id": 9, "team_name": "analysts", "member_name": "sql", "title": "Check the joins"},
			}})
		case "teams.cancelDelegate":
			respond(req.ID, map[string]any{"canceled": 1})
		default:
			write(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{
				"code": -32601, "message": "method not found: " + req.Method,
			}})
		}
	}
}

// newTestApp 返回一个 app，它的更新在测试 pump 时才运行；它的订阅随测试结束而结束。
func newTestApp(t *testing.T, q *uiQueue) *app {
	a := &app{post: q.post, logPath: "/data/logs/service.log", version: "0.1.0"}
	// 测试不读本机字体：没有已安装字体时一律回退到系统字体，结果与机器无关。
	a.theme.fontFamily = func() []ui.FontFamily { return nil }
	t.Cleanup(a.cancelFollow)
	return a
}

func TestBannerFollowsTheServiceState(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := newTestApp(t, q)
	retried := 0
	a.retry = func() { retried++ }
	tt := ui.NewTester(a.view, 1180, 760)
	expectTexts(t, tt, []string{"The agent service is not running.", "Stopped"}, nil)

	a.onService(supervisor.Status{State: supervisor.StateStarting})
	tt.Frame()
	expectTexts(t, tt, []string{"Starting the agent service…", "Starting"}, []string{"not running"})

	a.onService(fs.ready(41))
	q.pump(t, tt, "the conversation list", func() bool { return a.listLoaded })
	expectTexts(t, tt, []string{"Ready", "Greeting", "Getting started", "New chat", "Settings", "What would you like to analyze?"},
		[]string{"Starting the agent service", "Reconnected"})

	a.onService(supervisor.Status{State: supervisor.StateRestarting, Err: errors.New("service exited: signal: killed"), Crashes: 1})
	tt.Frame()
	expectTexts(t, tt, []string{"The agent service stopped (service exited: signal: killed). Restarting it…", "Restarting"}, nil)
	if a.client != nil {
		t.Error("a client of the stopped service")
	}

	a.onService(fs.ready(42))
	tt.Frame()
	expectTexts(t, tt, []string{"Reconnected: the agent service restarted", "Ready"}, []string{"Restarting it…"})
	tt.Advance(reconnectedFor / 2)
	expectTexts(t, tt, []string{"Reconnected"}, nil)
	tt.Advance(reconnectedFor)
	expectTexts(t, tt, nil, []string{"Reconnected"})

	a.onService(supervisor.Status{State: supervisor.StateFailed, Err: errors.New("5 crashes within 2m0s; last: service exited: exit status 1"), Crashes: 5})
	tt.Frame()
	expectTexts(t, tt, []string{"could not be started: 5 crashes within 2m0s", "/data/logs/service.log", "Failed"}, nil)
	if err := tt.Click("Retry"); err != nil || retried != 1 {
		t.Errorf("retry: %v, %d retries", err, retried)
	}
}

func TestConversationsAndTheMissingModel(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := newTestApp(t, q)
	tt := ui.NewTester(a.view, 1180, 760)
	a.onService(fs.ready(41))
	q.pump(t, tt, "the conversation list", func() bool { return a.listLoaded })

	if err := tt.Click("Greeting"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "conversation 2", func() bool { return a.connected && a.chat.Conversation == 2 })
	expectTexts(t, tt, []string{"hello there", "General Kenobi", "bold", "stub/stub-chat"}, []string{"Loading the conversation"})

	// 新对话的第一条消息会创建它的会话；服务对它没有可用的模型。
	if err := tt.Click("New chat"); err != nil {
		t.Fatal(err)
	}
	expectTexts(t, tt, []string{"What would you like to analyze?"}, []string{"hello there"})
	if err := tt.Click("Message"); err != nil {
		t.Fatal(err)
	}
	tt.Type("Plot sales by month")
	if err := tt.Click("Send"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the refused message", func() bool { return a.sendErr != "" })
	expectTexts(t, tt, []string{"No model is configured", "Open settings", "New chat"}, []string{"Chat 3"})
	if a.conv != 3 || a.nav != navOf(3) || a.input != "Plot sales by month" || !a.needModel {
		t.Errorf("conversation %d, nav %q, input %q, needModel %t", a.conv, a.nav, a.input, a.needModel)
	}
	if err := tt.Click("Open settings"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the settings", func() bool { return a.st.loaded && a.st.view != nil })
	expectTexts(t, tt, []string{"Settings", "No provider is configured", "Add provider"}, []string{"Send"})
}

// TestChatShowsTheRecordedStream 像订阅那样把录制好的订阅流经 replica 喂进来，并检查回复是经由
// markdown.Stream 流式出现、最后以 markdown.View 落在同一个列表行里的。
func TestChatShowsTheRecordedStream(t *testing.T) {
	f, err := os.Open("../conversation/testdata/stream.jsonl")
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
	a := &app{post: func(fn func()) { fn() }, conv: 1}
	tt := ui.NewTester(a.view, 1180, 760)
	var replica conversation.Replica
	streamed := map[string]bool{}
	streamingKeys := map[string]bool{}
	running := false
	for _, ev := range events {
		if err := replica.Apply(ev); err != nil {
			t.Fatalf("seq %d: %v", ev.Seq, err)
		}
		a.onChat(replica.State())
		tt.Frame()
		tt.Advance(300 * time.Millisecond)
		for _, m := range a.chat.Messages {
			if m.Role == "tool" && m.Tool != nil && m.Tool.Name == "describe_table" && m.Tool.Status == "running" && tt.HasText("describe_table") {
				running = true
			}
			if m.Role != "assistant" || m.Done {
				continue
			}
			streamingKeys[m.Key] = true
			for _, heading := range []string{"Result", "Hello"} {
				if strings.HasPrefix(m.Text, "## "+heading) && tt.HasText(heading) {
					streamed[heading] = true // 回复还没有写完时，片段已经在屏幕上了
				}
			}
		}
	}
	if !streamed["Result"] || !streamed["Hello"] || !running {
		t.Errorf("partial replies shown %v, running tool shown %t", streamed, running)
	}
	committed := map[string]bool{}
	for _, m := range a.chat.Messages {
		if m.Role == "assistant" && m.Done {
			committed[m.Key] = true
		}
	}
	if len(streamingKeys) != 2 {
		t.Errorf("streaming reply keys %v, want 2", streamingKeys)
	}
	for key := range streamingKeys {
		if !committed[key] {
			t.Errorf("streaming reply %q has no committed row with its key; committed %v", key, committed)
		}
	}
	tt.Advance(2 * time.Second)
	// 工具结果默认折叠：行里只有名字、耗时与状态。
	expectTexts(t, tt, []string{"Describe sales", "describe_table", "Done", "504ms", "Result", "Hello", "streamed", "metric", `print("ok")`, "Copy", "stub/stub-chat"}, nil)
}
