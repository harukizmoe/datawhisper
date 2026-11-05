package app

// 聊天界面的用例：工具摘要与展开、ask_user 卡片提交、标题省略、模型切换参数、斜杠命令补全，
// 以及窄窗口下发送按钮不被裁切。它们都用 app_test.go 里的假服务（真实 JSON-RPC 形状）。

import (
	"strings"
	"testing"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

// openRichChat 打开假服务里的会话 4：它带一次 workspace_status 调用和一张 ask_user 卡片。
func openRichChat(t *testing.T, fs *fakeService, q *uiQueue, a *app, tt *ui.Tester) {
	t.Helper()
	a.onService(fs.ready(41))
	q.pump(t, tt, "the session list", func() bool { return a.listLoaded })
	if err := tt.Click("Workspace check"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "conversation 4", func() bool { return a.connected && a.chat.Conversation == 4 })
}

// TestToolCallsRenderAsSummaries 断言工具调用只画一行摘要：参数与结果的原始 JSON 不进入消息流，
// 结果默认折叠，展开后能看到全文；ask_user 的内部指令也从可见文本里消失。
func TestToolCallsRenderAsSummaries(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 1180, 760)
	openRichChat(t, fs, q, a, tt)

	expectTexts(t, tt, []string{
		"Look at my workspace",
		"workspace_status",
		"41ms · ok",
		"Quick question",
		"Which analysis should I run?",
		"Profit analysis",
		"Structure analysis",
	}, []string{
		`{"system_workspace"`,
		internalAskInstruction,
		"→",
		"←",
	})

	// 折叠时结果不显示；点击 Details 展开后能看到完整文本，再点 Hide 收回。
	if err := tt.Click("Details"); err != nil {
		t.Fatal(err)
	}
	raw := `{"system_workspace":{"roots":["/workspace"],"files":[]}}`
	if rect, ok := tt.Find(raw); !ok || rect.H < 10 || rect.W < 100 {
		t.Fatalf("expanded tool output is not visible: %v, %t; texts %q", rect, ok, tt.Texts())
	}
	if err := tt.Click("Hide"); err != nil {
		t.Fatal(err)
	}
	expectTexts(t, tt, nil, []string{`{"system_workspace"`})
}

// TestAskUserOptionsSubmit 断言 ask_user 的选项来自工具参数，点选后以 followUp 提交，且自由输入也能回答。
func TestAskUserOptionsSubmit(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 1180, 760)
	openRichChat(t, fs, q, a, tt)

	if err := tt.Click("Profit analysis"); err != nil {
		t.Fatal(err)
	}
	if err := tt.Click("Send answer"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the submitted answer", func() bool { return len(fs.callsTo("conversation.submit")) > 0 })
	calls := fs.callsTo("conversation.submit")
	last := calls[len(calls)-1]
	if last["text"] != "Profit analysis" || last["whenBusy"] != "followUp" {
		t.Errorf("submit params %v", last)
	}
	expectTexts(t, tt, []string{"Answer sent: Profit analysis"}, nil)

	// 自由输入优先于选项，同样按 followUp 提交；换一个 app 让卡片回到未回答状态。
	fs2 := newFakeService(t)
	q2 := newQueue()
	a2 := &app{post: q2.post}
	tt2 := ui.NewTester(a2.view, 1180, 760)
	openRichChat(t, fs2, q2, a2, tt2)
	if err := tt2.Click("Your answer"); err != nil {
		t.Fatal(err)
	}
	tt2.Type("Compare both")
	if err := tt2.Click("Send answer"); err != nil {
		t.Fatal(err)
	}
	q2.pump(t, tt2, "the free answer", func() bool { return len(fs2.callsTo("conversation.submit")) > 0 })
	call := fs2.callsTo("conversation.submit")[0]
	if call["text"] != "Compare both" || call["whenBusy"] != "followUp" {
		t.Errorf("free answer params %v", call)
	}
}

// TestHeaderTitleIsSingleLine 断言标题来自会话库（不是 Chat <id>），并且长标题只占一行。
func TestHeaderTitleIsSingleLine(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 1180, 760)
	openRichChat(t, fs, q, a, tt)

	expectTexts(t, tt, []string{"Workspace check"}, []string{"Chat 4"})

	if got := oneLine("a\nb   c", 80); got != "a b c" {
		t.Errorf("oneLine folded %q", got)
	}
	if got := oneLine("abcdef", 4); got != "abc…" {
		t.Errorf("oneLine truncated %q", got)
	}

	// 服务端的占位标题不算标题：先退回首条用户消息，最后才回退到 New chat。
	a.sessions[0].Title = "未命名会话"
	if got := a.sessionTitle(4); got != "Look at my workspace" {
		t.Errorf("placeholder title fell back to %q", got)
	}
	a.chat.Messages = nil
	if got := a.sessionTitle(4); got != "New chat" {
		t.Errorf("empty chat fell back to %q", got)
	}
	a.sessions[0].Title = "Workspace check"
	a.chat.Messages = []conversation.Message{{Role: "user", Text: "Look at my workspace"}}

	// 只留标题栏里的这份文本：清空会话列表，把当前会话的首条用户消息换成一条很长的消息，
	// 标题因此来自本地兜底并压成一行。没有 SingleLine 时 80 个字符会在标题栏里折成两行。
	a.sessions = nil
	a.chat.Messages[0].Text = strings.Repeat("Quarterly revenue by region ", 6)
	tt.Frame()
	title := a.sessionTitle(a.conv)
	rect, ok := tt.Find(title)
	if !ok {
		t.Fatalf("the long title is not on screen; texts %q", tt.Texts())
	}
	if rect.H > 30 {
		t.Errorf("the title wraps: %v", rect)
	}
	if !strings.HasSuffix(title, "…") {
		t.Errorf("the title is not truncated: %q", title)
	}
}

// TestRenameSession 断言 Rename 弹窗把新标题写到 session.rename，并立刻更新标题栏与会话列表。
func TestRenameSession(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 1180, 760)
	openRichChat(t, fs, q, a, tt)

	if err := tt.Click("Rename"); err != nil {
		t.Fatal(err)
	}
	if err := tt.Click("Chat title"); err != nil {
		t.Fatal(err)
	}
	tt.Command("selectAll")
	tt.Type("Revenue analysis")
	if err := tt.Click("Save"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the rename", func() bool { return len(fs.callsTo("session.rename")) > 0 })
	call := fs.callsTo("session.rename")[0]
	if id, _ := call["id"].(float64); int(id) != 4 || call["title"] != "Revenue analysis" {
		t.Errorf("rename params %v", call)
	}
	expectTexts(t, tt, []string{"Revenue analysis"}, []string{"Workspace check"})
	if a.sessionTitle(4) != "Revenue analysis" {
		t.Errorf("title %q", a.sessionTitle(4))
	}
}

// TestModelSwitchSendsParameters 断言下拉框里的模型与思考强度切换走 conversation.setModel。
func TestModelSwitchSendsParameters(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 1180, 760)
	openRichChat(t, fs, q, a, tt)

	// 当前模型来自会话视图，即使不在目录里也能显示；先切到目录里的另一个模型。
	if err := tt.Click("stub/stub-chat"); err != nil {
		t.Fatal(err)
	}
	if err := tt.Click("magpie/auto/other"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "setModel", func() bool { return len(fs.callsTo("conversation.setModel")) > 0 })
	call := fs.callsTo("conversation.setModel")[0]
	model, _ := call["model"].(map[string]any)
	if model["provider"] != "magpie" || model["modelId"] != "auto/other" {
		t.Errorf("model params %v", call)
	}

	// 思考强度随另一个模型变成 Default/off/high；选中 high 后保持同一个模型再提交一次。
	if err := tt.Click("Default"); err != nil {
		t.Fatal(err)
	}
	if err := tt.Click("high"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the thinking level", func() bool { return len(fs.callsTo("conversation.setModel")) > 1 })
	call = fs.callsTo("conversation.setModel")[1]
	model, _ = call["model"].(map[string]any)
	if model["provider"] != "magpie" || model["modelId"] != "auto/other" || call["thinkingLevel"] != "high" {
		t.Errorf("thinking params %v", call)
	}
}

// TestComposerFitsNarrowWindow 断言窄窗口下发送按钮仍在窗口内、有完整宽度，输入框也能收缩。
func TestComposerFitsNarrowWindow(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 700, 640)
	openRichChat(t, fs, q, a, tt)

	rect, ok := tt.Find("Send")
	if !ok {
		t.Fatal("no Send button")
	}
	// 宽窗口里 "Send" 的文本宽约 34 DIP；被裁成 "Sen…" 时元素会比这更窄。
	if rect.W < 30 {
		t.Errorf("the Send button is clipped: %v", rect)
	}
	if rect.X < 0 || rect.X+rect.W > 700 || rect.Y+rect.H > 640 {
		t.Errorf("the Send button is outside the window: %v", rect)
	}
	if input, ok := tt.Find("Message"); !ok || input.W < 80 {
		t.Errorf("the message input is unusable: %v, %t", input, ok)
	}
	// 按钮唯一：确认没有被裁成 “Sen…”。
	expectTexts(t, tt, []string{"Send"}, []string{"Sen…"})
}

// TestSlashCommandsCompleteBeforeSending 断言输入 /前缀 时列出命令，Enter 先补全而不是发送。
func TestSlashCommandsCompleteBeforeSending(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 1180, 760)
	openRichChat(t, fs, q, a, tt)

	if err := tt.Click("Message"); err != nil {
		t.Fatal(err)
	}
	tt.Type("/")
	tt.Frame()
	expectTexts(t, tt, []string{"Commands", "/compact", "/status"}, nil)
	if rect, ok := tt.Find("/status"); !ok || rect.H < 10 {
		t.Fatalf("the command list is not visible: %v, %t", rect, ok)
	}
	tt.Type("co")
	tt.Frame()
	expectTexts(t, tt, []string{"Commands", "/compact"}, []string{"/status"})

	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if a.input != "/compact " {
		t.Fatalf("Enter completed to %q", a.input)
	}
	if calls := fs.callsTo("conversation.submit"); len(calls) != 0 {
		t.Fatalf("Enter sent the command: %v", calls)
	}

	tt.Key(0, ui.KeyEnter)
	q.pump(t, tt, "the command submission", func() bool { return len(fs.callsTo("conversation.submit")) > 0 })
	call := fs.callsTo("conversation.submit")[0]
	if call["command"] != "compact" || call["text"] != "/compact" {
		t.Errorf("submit params %v", call)
	}
}

// TestWhenBusyChoice 断言回复进行中发送时，Queue 与 Steer 分别给出 followUp 与 steer。
func TestWhenBusyChoice(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 1180, 760)
	openRichChat(t, fs, q, a, tt)

	// 直接进入“正在回复”的界面状态：订阅的增量事件由别的用例覆盖，这里只关心发送参数。
	a.chat.Busy = true
	tt.Frame()
	expectTexts(t, tt, []string{"Queue", "Steer", "Stop"}, nil)
	if err := tt.Click("Message"); err != nil {
		t.Fatal(err)
	}
	tt.Type("Also check the schema")
	if err := tt.Click("Send"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the queued message", func() bool { return len(fs.callsTo("conversation.submit")) > 0 })
	if call := fs.callsTo("conversation.submit")[0]; call["whenBusy"] != "followUp" {
		t.Errorf("queued params %v", call)
	}

	a.chat.Busy = true
	if err := tt.Click("Steer"); err != nil {
		t.Fatal(err)
	}
	if err := tt.Click("Message"); err != nil {
		t.Fatal(err)
	}
	tt.Type("And the row count")
	if err := tt.Click("Send"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the steered message", func() bool { return len(fs.callsTo("conversation.submit")) > 1 })
	if call := fs.callsTo("conversation.submit")[1]; call["whenBusy"] != "steer" {
		t.Errorf("steered params %v", call)
	}
}

// TestStopAbortsTheReply 断言回复进行中按 Stop 会调用 conversation.abort。
func TestStopAbortsTheReply(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 1180, 760)
	openRichChat(t, fs, q, a, tt)

	a.chat.Busy = true
	tt.Frame()
	if err := tt.Click("Stop"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the abort", func() bool { return len(fs.callsTo("conversation.abort")) > 0 })
	if call := fs.callsTo("conversation.abort")[0]; call["id"] != "4" {
		t.Errorf("abort params %v", call)
	}
}

// TestToolCallPairing 是 replica 的单元用例：调用与结果按 toolCallId 合并成一行，ask_user 的选项从
// details 里取，而不是自己编造。
func TestToolCallPairing(t *testing.T) {
	view := fakeView(4)
	r := &conversation.Replica{}
	if err := r.Apply(service.Event{Name: "snapshot", Seq: 0, View: view}); err != nil {
		t.Fatal(err)
	}
	var tools []conversation.Message
	for _, m := range r.State().Messages {
		if m.Role == "tool" {
			tools = append(tools, m)
		}
	}
	if len(tools) != 2 {
		t.Fatalf("tool rows %d: %+v", len(tools), tools)
	}
	ws := tools[0].Tool
	if ws.Name != "workspace_status" || ws.Status != "ok" || ws.DurationMS != 41 || !strings.Contains(ws.Output, "system_workspace") {
		t.Errorf("workspace_status row %+v", ws)
	}
	ask := tools[1].Tool
	if ask.Ask == nil || ask.Ask.Question != "Which analysis should I run?" ||
		strings.Join(ask.Ask.Options, "|") != "Profit analysis|Structure analysis" {
		t.Errorf("ask row %+v", ask)
	}
	// 结果正文仍然保留在数据里（模型指令不该丢），由界面负责不显示它。
	if ask.Output != internalAskInstruction {
		t.Errorf("ask output %q", ask.Output)
	}
}
