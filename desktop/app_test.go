package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"datawhisper/desktop/internal/api"
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
// POST /v1/conversations 创建的会话 3（它的 submit 没有可用模型，返回 409），以及没有模型可用的列表。
func fakeService(t *testing.T) (*httptest.Server, int) {
	t.Helper()
	view := func(id int) string {
		entries := `[]`
		if id == 2 {
			entries = `[{"id":5,"conversationId":2,"kind":"pi.user","model":[{"role":"user","content":"hello there","timestamp":1}]},` +
				`{"id":6,"conversationId":2,"kind":"pi.assistant","byTaskId":9,"model":[{"role":"assistant","content":[{"type":"text","text":"## General Kenobi\n\nA **bold** reply."}]}]}]`
		}
		return fmt.Sprintf(`{"seq":0,"view":{"conversation":{"id":%d},"entries":%s,"docs":{"pi.agent":{"model":{"provider":"stub","modelId":"stub-chat"}},"pi.live":{},"pi.inbox":{"items":[]}}}}`, id, entries)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/conversations", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"conversations":[{"id":2,"root":false,"lastEntryId":6,"updatedAt":1},{"id":1,"root":true,"lastEntryId":null,"updatedAt":null}]}`))
	})
	mux.HandleFunc("POST /v1/conversations", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":3}`))
	})
	mux.HandleFunc("GET /v1/conversations/{id}/subscribe", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil || id < 1 || id > 3 {
			http.Error(w, `{"error":"not_found"}`, http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", view(id))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	mux.HandleFunc("POST /v1/conversations/3/submit", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"no_model"}`))
	})
	mux.HandleFunc("GET /v1/models/available", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"models":[]}`))
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(func() {
		srv.CloseClientConnections()
		srv.Close()
	})
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	return srv, port
}

// newTestApp 返回一个 app，它的更新在测试 pump 时才运行；它的订阅随测试结束而结束。
func newTestApp(t *testing.T, q *uiQueue) *app {
	a := &app{post: q.post, token: "tok", logPath: "/data/logs/service.log"}
	t.Cleanup(a.cancelFollow)
	return a
}

func TestBannerFollowsTheServiceState(t *testing.T) {
	_, port := fakeService(t)
	q := newQueue()
	a := newTestApp(t, q)
	retried := 0
	a.retry = func() { retried++ }
	tt := ui.NewTester(a.view, 1180, 760)
	expectTexts(t, tt, []string{"The agent service is not running.", "Stopped"}, nil)

	a.onService(supervisor.Status{State: supervisor.StateStarting})
	tt.Frame()
	expectTexts(t, tt, []string{"Starting the agent service…", "Starting"}, []string{"not running"})

	a.onService(supervisor.Status{State: supervisor.StateReady, Port: port, PID: 41})
	q.pump(t, tt, "the conversation list", func() bool { return a.listLoaded })
	expectTexts(t, tt, []string{"Ready", "Chat 2", "Chat 1", "New chat", "Settings", "Ask a question about your data."},
		[]string{"Starting the agent service", "Reconnected"})

	a.onService(supervisor.Status{State: supervisor.StateRestarting, Err: errors.New("service exited: signal: killed"), Crashes: 1})
	tt.Frame()
	expectTexts(t, tt, []string{"The agent service stopped (service exited: signal: killed). Restarting it…", "Restarting"}, nil)
	if a.client != nil {
		t.Error("a client of the stopped service")
	}

	a.onService(supervisor.Status{State: supervisor.StateReady, Port: port, PID: 42, Crashes: 1})
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
	_, port := fakeService(t)
	q := newQueue()
	a := newTestApp(t, q)
	tt := ui.NewTester(a.view, 1180, 760)
	a.onService(supervisor.Status{State: supervisor.StateReady, Port: port, PID: 41})
	q.pump(t, tt, "the conversation list", func() bool { return a.listLoaded })

	if err := tt.Click("Chat 2"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "conversation 2", func() bool { return a.connected && a.chat.Conversation == 2 })
	expectTexts(t, tt, []string{"hello there", "General Kenobi", "bold", "stub/stub-chat"}, []string{"Loading the conversation"})

	// 新对话的第一条消息会创建它的会话；服务对它没有可用的模型。
	if err := tt.Click("New chat"); err != nil {
		t.Fatal(err)
	}
	expectTexts(t, tt, []string{"Ask a question about your data."}, []string{"hello there"})
	if err := tt.Click("Message"); err != nil {
		t.Fatal(err)
	}
	tt.Type("Plot sales by month")
	if err := tt.Click("Send"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the refused message", func() bool { return a.sendErr != "" })
	expectTexts(t, tt, []string{"No model is configured", "Open settings", "Chat 3"}, nil)
	if a.conv != 3 || a.nav != navOf(3) || a.input != "Plot sales by month" || !a.needModel {
		t.Errorf("conversation %d, nav %q, input %q, needModel %t", a.conv, a.nav, a.input, a.needModel)
	}
	if err := tt.Click("Open settings"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the models", func() bool { return a.modelsLoaded })
	expectTexts(t, tt, []string{"Settings", "No model is available", "Ready: process 41 on 127.0.0.1:" + strconv.Itoa(port)}, []string{"Send"})
}

// TestChatShowsTheRecordedStream 像订阅那样把录制好的订阅流经 replica 喂进来，并检查回复是经由
// markdown.Stream 流式出现、最后以 markdown.View 落在同一个列表行里的。
func TestChatShowsTheRecordedStream(t *testing.T) {
	f, err := os.Open("internal/api/testdata/stream.sse")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var events []api.Event
	if err := api.ReadSSE(f, func(ev api.Event) error { events = append(events, ev); return nil }); err != nil {
		t.Fatal(err)
	}
	a := &app{post: func(fn func()) { fn() }, conv: 1}
	tt := ui.NewTester(a.view, 1180, 760)
	var replica api.Replica
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
			if m.Role == "tool" && strings.HasPrefix(m.Text, "⋯ describe_table running") && tt.HasText("⋯ describe_table running") {
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
	expectTexts(t, tt, []string{"Describe sales", "sales: 42 rows, 7 columns", "Result", "Hello", "streamed", "metric", `print("ok")`, "Copy", "stub/stub-chat"}, nil)
}
