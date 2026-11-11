package app

// 聊天界面的用例：工具摘要与展开、ask_user 卡片提交、标题省略、模型切换参数、斜杠命令补全，
// 以及窄窗口下发送按钮不被裁切。它们都用 app_test.go 里的假服务（真实 JSON-RPC 形状）。

import (
	"fmt"
	"strings"
	"testing"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/prefs"
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

// TestToolCallsRenderAsCards 断言工具调用画成一张卡片（参考 Tern）：标题是工具名，卡片里是参数摘要与输出，
// 底部是状态与耗时；ask_user 的内部指令和旧版的箭头记号都不进入可见文本。
func TestToolCallsRenderAsCards(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 1180, 760)
	openRichChat(t, fs, q, a, tt)

	expectTexts(t, tt, []string{
		"Look at my workspace",
		"workspace_status",
		`{"system_workspace":{"roots":["/workspace"],"files":[]}}`,
		"Done",
		"41ms",
		"Quick question",
		"Which analysis should I run?",
		"Profit analysis",
		"Structure analysis",
	}, []string{
		internalAskInstruction,
		"→",
		"←",
	})
}

// TestLongToolOutputIsTruncated 断言长输出默认只显示末尾几行，「前面还有 N 行」展开全文、「收起」收回；
// 失败的调用一直完整展开。
func TestLongToolOutputIsTruncated(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	var lines []string
	for i := 1; i <= 20; i++ {
		lines = append(lines, fmt.Sprintf("row %02d", i))
	}
	output := strings.Join(lines, "\n")
	a.chat.Messages = []conversation.Message{
		{Key: "e1", Role: "user", Text: "list rows", Done: true},
		{Key: "e2.0", Role: "tool", Text: "query_data", Done: true, Tool: &conversation.ToolCall{CallID: "c1", Name: "query_data", Args: "sql=select *", Output: output, Status: "ok", DurationMS: 1200}},
	}
	tt := ui.NewTester(a.view, 1180, 900)
	expectTexts(t, tt, []string{"query_data", "sql=select *", "14 earlier lines", "Done", "1.2s"}, []string{"row 01"})
	if !strings.Contains(strings.Join(tt.Texts(), "\n"), "row 20") {
		t.Errorf("the tail is not shown; texts %q", tt.Texts())
	}
	if err := tt.Click("14 earlier lines"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !strings.Contains(strings.Join(tt.Texts(), "\n"), "row 01") {
		t.Errorf("the expanded output lacks its first line; texts %q", tt.Texts())
	}
	if err := tt.Click("Show less"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"14 earlier lines"}, nil)

	// 失败的调用：全文展开，没有收起。
	a.chat.Messages[1].Tool.Status = "error"
	tt.Frame()
	expectTexts(t, tt, []string{"Failed"}, []string{"14 earlier lines", "Show less"})
}

// TestAskUserOptionsSubmit 断言 ask_user 的选项来自工具参数，点一下选项就以 followUp 提交，且自由输入也能回答。
func TestAskUserOptionsSubmit(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 1180, 760)
	openRichChat(t, fs, q, a, tt)

	if err := tt.Click("Profit analysis"); err != nil {
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
	// 命令目录是异步拉的（先告知服务语言，再 command.list）；等它到了再输入。
	q.pump(t, tt, "the command catalog", func() bool { return len(a.cv.commands) > 0 })

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

// TestThinkingTurnMetaAndNavRail 覆盖 P1 的几件事：思考默认折叠成「Thought」、点开显示全文；一轮末尾有
// 「时间 · 输入 · 输出 · 缓存 · 费用」与复制按钮（还在进行中的轮次不画）；两条以上提问时出现导航轨。
func TestThinkingTurnMetaAndNavRail(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	usage := &conversation.Usage{Input: 1200, Output: 300, CacheRead: 4000, Total: 5500, Cost: 0.0125, DurationMS: 3000}
	a.chat.Messages = []conversation.Message{
		{Key: "e1", Role: "user", Text: "first question", Done: true},
		{Key: "g9.th", Role: "thinking", Text: "consider the schema first", Done: true},
		{Key: "g9", Role: "assistant", Text: "first answer", Done: true, Usage: usage},
		{Key: "e3", Role: "user", Text: "second question", Done: true},
		{Key: "g10", Role: "assistant", Text: "partial", Done: false},
	}
	a.chat.Busy = true
	a.prefs = prefs.Default()
	a.prefs.Appearance.FoldRuns = false // 检查单独的「Thought」行；折叠成组的情形见 chat_fold_test.go
	tt := ui.NewTester(a.view, 1180, 900)
	expectTexts(t, tt, []string{"Thought", "first answer", "in 1.2k", "out 300", "cache 4k", "$0.0125", "100 tok/s", "Copy", "Jump to this question"},
		[]string{"consider the schema first"})
	if err := tt.Click("Thought"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"consider the schema first"}, nil)

	// 进行中的第二轮没有元数据：只有第一轮那一份。
	metas := 0
	for _, s := range tt.Texts() {
		if strings.Contains(s, "out ") {
			metas++
		}
	}
	if metas != 1 {
		t.Errorf("%d turn summaries, want 1; texts %q", metas, tt.Texts())
	}
	if err := tt.Click("Copy"); err != nil {
		t.Fatal(err)
	}
	if got := tt.Clipboard(); got != "first answer" {
		t.Errorf("copied %q", got)
	}
}

// TestHomeSuggestionsFillTheComposer 断言首页的示例问题点一下就填进输入框（不直接发送）。
func TestHomeSuggestionsFillTheComposer(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	tt := ui.NewTester(a.view, 1180, 760)
	suggestion := "Chart monthly sales as a line chart"
	if err := tt.Click(suggestion); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.input != suggestion {
		t.Errorf("input %q", a.input)
	}
}
