package app

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/prefs"
	"github.com/egoist/mygo/ui"
)

func toolMsg(key, name, output string, ms int64, status string) conversation.Message {
	return conversation.Message{Key: key, Role: "tool", Done: true,
		Tool: &conversation.ToolCall{CallID: key, Name: name, Output: output, Status: status, DurationMS: ms}}
}

func thoughtMsg(key string, done bool) conversation.Message {
	return conversation.Message{Key: key, Role: "thinking", Text: "thinking about " + key, Done: done}
}

func answerMsg(key string) conversation.Message {
	return conversation.Message{Key: key, Role: "assistant", Text: "the answer " + key, Done: true}
}

func userMsg(key string) conversation.Message {
	return conversation.Message{Key: key, Role: "user", Text: "question " + key, Done: true}
}

// TestChatRowsFoldOnlyFinishedRuns 断言哪些消息会并进折叠组：只有后面紧跟着已写完的回答、且本身已完成的工具调用与
// 折叠方式下的思考才折；带图表、仪表盘或问题的工具卡片、「展开」方式下的思考、还在进行的一轮都留在原位。
func TestChatRowsFoldOnlyFinishedRuns(t *testing.T) {
	def := prefs.DefaultAppearance()
	dash := toolMsg("d", "generate_dashboard", "ok", 5, "ok")
	dash.Tool.DashboardID = "dash_1"
	ask := toolMsg("a", "ask_user", "", 0, "ok")
	ask.Tool.Ask = &conversation.AskRequest{Question: "which?"}
	running := toolMsg("r", "query_data", "", 0, "running")
	running.Done = false

	cases := []struct {
		name string
		msgs []conversation.Message
		ap   func(*prefs.Appearance)
		want string // 每行一个字符：F 折叠组，m 单条消息
	}{
		{"a run before the answer folds", []conversation.Message{userMsg("u"), thoughtMsg("t", true), toolMsg("1", "q", "x", 1, "ok"), toolMsg("2", "q", "x", 1, "ok"), answerMsg("g")}, nil, "mFm"},
		{"a run still in progress stays open", []conversation.Message{userMsg("u"), toolMsg("1", "q", "x", 1, "ok"), running}, nil, "mmm"},
		{"a run with no answer after it stays open", []conversation.Message{userMsg("u"), toolMsg("1", "q", "x", 1, "ok")}, nil, "mm"},
		{"a dashboard ends the run it interrupts; only the run next to the answer folds", []conversation.Message{userMsg("u"), toolMsg("1", "q", "x", 1, "ok"), dash, toolMsg("2", "q", "x", 1, "ok"), answerMsg("g")}, nil, "mmmFm"},
		{"a question ends the run before it, which then has no answer next to it", []conversation.Message{userMsg("u"), toolMsg("1", "q", "x", 1, "ok"), ask, answerMsg("g")}, nil, "mmmm"},
		{"folding off", []conversation.Message{userMsg("u"), toolMsg("1", "q", "x", 1, "ok"), answerMsg("g")}, func(ap *prefs.Appearance) { ap.FoldRuns = false }, "mmm"},
		{"expanded thoughts stay in place", []conversation.Message{userMsg("u"), thoughtMsg("t", true), toolMsg("1", "q", "x", 1, "ok"), answerMsg("g")}, func(ap *prefs.Appearance) { ap.Thinking = prefs.ThinkingExpanded }, "mmFm"},
		{"hidden thoughts leave no row and do not break the run", []conversation.Message{userMsg("u"), toolMsg("1", "q", "x", 1, "ok"), thoughtMsg("t", true), toolMsg("2", "q", "x", 1, "ok"), answerMsg("g")}, func(ap *prefs.Appearance) { ap.Thinking = prefs.ThinkingHidden }, "mFm"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ap := def
			if tc.ap != nil {
				tc.ap(&ap)
			}
			rows, rowOf := chatRows(tc.msgs, ap)
			var got strings.Builder
			for _, r := range rows {
				if r.folded {
					got.WriteByte('F')
				} else {
					got.WriteByte('m')
				}
			}
			if got.String() != tc.want {
				t.Errorf("rows %q, want %q (%+v)", got.String(), tc.want, rows)
			}
			// 每条消息都映射到一个存在的行，且那一行包含它（隐藏的思考除外）。
			for i, ri := range rowOf {
				if ri < 0 || ri >= len(rows) {
					t.Fatalf("message %d maps to row %d of %d", i, ri, len(rows))
				}
				if m := tc.msgs[i]; !(m.Role == "thinking" && ap.Thinking == prefs.ThinkingHidden) && (i < rows[ri].from || i >= rows[ri].to) {
					t.Errorf("message %d is not in its row %+v", i, rows[ri])
				}
			}
		})
	}
}

// TestFoldedRunSummaryAndExpand 断言折叠行写出耗时、工具名与思考数，点开显示组内的卡片，再点收起；
// 失败的调用在摘要上有标记。
func TestFoldedRunSummaryAndExpand(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	a.chat.Messages = []conversation.Message{
		userMsg("u"),
		thoughtMsg("t", true),
		toolMsg("1", "get_schema", "sales: 42 rows", 400, "ok"),
		toolMsg("2", "query_data", "boom", 600, "error"),
		toolMsg("3", "get_schema", "again", 0, "ok"),
		answerMsg("g"),
	}
	tt := ui.NewTester(a.view, 1180, 900)
	expectTexts(t, tt, []string{"Worked for 1.0s · get_schema · query_data · 1 thought", "1 failed", "the answer g"},
		[]string{"sales: 42 rows", "boom"})

	if err := tt.Click("Worked for 1.0s · get_schema · query_data · 1 thought"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"sales: 42 rows", "boom"}, nil)
	if err := tt.Click("Worked for 1.0s · get_schema · query_data · 1 thought"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, nil, []string{"sales: 42 rows"})
}

// TestJumpingToAFoldedToolOpensTheRun 断言点回答下方的出处会把藏着那张工具卡片的折叠组点开。
func TestJumpingToAFoldedToolOpensTheRun(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	a.chat.Messages = []conversation.Message{
		userMsg("u"),
		{Key: "e2.0", Role: "tool", Done: true, Tool: &conversation.ToolCall{Name: "query_data", Output: "east 270\nnorth 200", Status: "ok"}},
		{Key: "g1", Role: "assistant", Text: "East 270, north 200, total 610.", Done: true},
	}
	a.list.FollowEnd = true
	tt := ui.NewTester(a.view, 1180, 760)
	expectTexts(t, tt, []string{"Sources"}, []string{"east 270"})
	if err := tt.Click("query_data · 2"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !a.cv.openRuns["run:e2.0"] {
		t.Errorf("the folded run did not open; open %v", a.cv.openRuns)
	}
}

func longOutput() string {
	var lines []string
	for i := 1; i <= 10; i++ {
		lines = append(lines, fmt.Sprintf("row-%02d", i))
	}
	return strings.Join(lines, "\n")
}

// TestToolOutputModes 断言「工具输出」的四种方式：预览只显示末尾几行，折叠只有一行入口，展开是全文，隐藏不显示输出；
// 点一下相对默认翻转；失败的调用在任何方式下都显示完整错误。
func TestToolOutputModes(t *testing.T) {
	open := func(mode string, msgs ...conversation.Message) (*app, *ui.Tester) {
		q := newQueue()
		a := newTestApp(t, q)
		a.prefs = prefs.Default()
		a.prefs.Appearance.FoldRuns = false
		a.prefs.Appearance.ToolOutput = mode
		a.chat.Messages = append([]conversation.Message{userMsg("u")}, msgs...)
		return a, ui.NewTester(a.view, 1180, 1100)
	}
	ok := toolMsg("1", "query_data", longOutput(), 12, "ok")

	_, tt := open(prefs.OutputPreview, ok)
	expectTexts(t, tt, []string{"4 earlier lines"}, nil)
	if tt.HasText("row-01") || !tt.HasText("row-10") {
		t.Errorf("preview should show only the tail; texts %q", tt.Texts())
	}

	a, tt := open(prefs.OutputCollapsed, ok)
	expectTexts(t, tt, []string{"Show output · 10 lines", "query_data"}, []string{"row-10"})
	if err := tt.Click("Show output · 10 lines"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"row-01", "row-10", "Show less"}, nil)
	if err := tt.Click("Show less"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"Show output · 10 lines"}, []string{"row-10"})
	_ = a

	_, tt = open(prefs.OutputExpanded, ok)
	expectTexts(t, tt, []string{"row-01", "row-10", "Show less"}, []string{"earlier lines"})
	if err := tt.Click("Show less"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"4 earlier lines"}, nil)

	_, tt = open(prefs.OutputHidden, ok)
	expectTexts(t, tt, []string{"query_data", "Done"}, []string{"row-10", "earlier lines", "Show output"})

	// 失败的调用：隐藏与折叠都不能把错误藏起来。
	bad := toolMsg("2", "query_data", longOutput(), 12, "error")
	for _, mode := range []string{prefs.OutputHidden, prefs.OutputCollapsed} {
		_, tt = open(mode, bad)
		expectTexts(t, tt, []string{"row-01", "row-10", "Failed"}, nil)
	}
}

// TestThinkingModes 断言「思考」的三种方式：折叠是一行「Thought」，展开直接显示全文且没有折叠行，隐藏什么都不显示；
// 展开方式下仍在进行的思考保留「Thinking…」。
func TestThinkingModes(t *testing.T) {
	open := func(mode string, thought conversation.Message) *ui.Tester {
		q := newQueue()
		a := newTestApp(t, q)
		a.prefs = prefs.Default()
		a.prefs.Appearance.FoldRuns = false
		a.prefs.Appearance.Thinking = mode
		a.chat.Messages = []conversation.Message{userMsg("u"), thought, answerMsg("g")}
		return ui.NewTester(a.view, 1180, 900)
	}
	done := thoughtMsg("t", true)

	expectTexts(t, open(prefs.ThinkingCollapsed, done), []string{"Thought", "the answer g"}, []string{"thinking about t"})
	expectTexts(t, open(prefs.ThinkingExpanded, done), []string{"thinking about t", "the answer g"}, []string{"Thought"})
	expectTexts(t, open(prefs.ThinkingHidden, done), []string{"the answer g"}, []string{"Thought", "thinking about t"})

	live := thoughtMsg("t", false)
	expectTexts(t, open(prefs.ThinkingExpanded, live), []string{"Thinking…", "thinking about t"}, nil)
}

// TestTranscriptSettings 断言设置页有这一组、改动立即生效并写进 ui.json，「恢复默认外观」退回默认。
func TestTranscriptSettings(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	a.prefs = prefs.Default()
	a.prefsPath = filepath.Join(t.TempDir(), "ui.json")
	tt := ui.NewTester(a.view, 1280, 2000)
	openAppearance(t, tt)
	expectTexts(t, tt, []string{"Conversation content", "Fold tool calls", "Thinking", "Tool output", "Preview", "Collapsed", "Expanded", "Hidden"}, nil)

	// 同一个词在「思考」与「工具输出」两行各有一份；设置页里思考在前，所以第一份属于思考。
	if err := tt.Click("Hidden"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if got := a.appearance().Thinking; got != prefs.ThinkingHidden {
		t.Fatalf("thinking %q", got)
	}
	if err := tt.Click("Preview"); err != nil { // 「Preview」只在工具输出里有
		t.Fatal(err)
	}
	a.setAppearance(func(ap *prefs.Appearance) { ap.ToolOutput, ap.FoldRuns = prefs.OutputCollapsed, false })
	saved := prefs.Load(a.prefsPath).Appearance
	if saved.Thinking != prefs.ThinkingHidden || saved.ToolOutput != prefs.OutputCollapsed || saved.FoldRuns {
		t.Errorf("saved %+v", saved)
	}

	if err := tt.Click("Reset appearance"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.appearance() != prefs.DefaultAppearance() {
		t.Errorf("reset left %+v", a.appearance())
	}
}
