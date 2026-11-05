package app

import (
	"strings"
	"testing"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/preview"
	"github.com/egoist/mygo/ui"
)

// TestRunsTabListsAndCancels 断言「运行」标签列出本会话的长任务与团队委派、进行中的有取消按钮，取消发出对应的
// 请求；服务没有工作流功能（method not found）时那一节整体隐藏。
func TestRunsTabListsAndCancels(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 1400, 900)
	openRichChat(t, fs, q, a, tt)
	a.toggleSources()
	a.src.tab = sourcesTabRuns
	q.pump(t, tt, "the runs", func() bool { return a.src.runs.loaded })

	expectTexts(t, tt, []string{"Long tasks", "Quarterly report", "Running", "rendering charts", "profile_data", "Succeeded",
		"Team delegations", "analysts / sql", "Check the joins", "Sub-chat 9"}, []string{"Workflow runs"})
	if got := fs.callsTo("jobs.list"); len(got) == 0 || got[0]["conversationId"] != float64(4) {
		t.Errorf("jobs.list params %v", got)
	}

	// 运行中的长任务与委派各有一个取消按钮；先取消长任务。
	if err := tt.Click("Cancel"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the cancel", func() bool { return len(fs.callsTo("jobs.cancel")) > 0 })
	if got := fs.callsTo("jobs.cancel")[0]; got["id"] != float64(12) {
		t.Errorf("jobs.cancel params %v", got)
	}
}

// TestProvenanceRowUnderAnswers 断言数据类工具之后的回答下方有「出处」：数字归到提供它的工具调用，点一下跳到
// 那张卡片；没有出处的数字单独提示。
func TestProvenanceRowUnderAnswers(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	a.chat.Messages = []conversation.Message{
		{Key: "e1", Role: "user", Text: "各区域销售额？", Done: true},
		{Key: "e2.0", Role: "tool", Done: true, Tool: &conversation.ToolCall{Name: "query_data", Output: "east 270\\nnorth 200", Status: "ok"}},
		{Key: "g1", Role: "assistant", Text: "East 270, north 200, total 610.", Done: true},
	}
	a.list.FollowEnd = true
	tt := ui.NewTester(a.view, 1180, 760)
	expectTexts(t, tt, []string{"Sources", "query_data · 2", "1 without a source"}, nil)
	if err := tt.Click("query_data · 2"); err != nil {
		t.Fatal(err)
	}
	if !a.cv.followPaused {
		t.Error("jumping to the source left the list following the end")
	}

	// 没有数据类工具的回答不核对。
	a.chat.Messages[1].Tool.Name = "workspace_status"
	a.cv.prov = nil
	tt.Frame()
	if strings.Contains(strings.Join(tt.Texts(), "\\n"), "Sources") {
		t.Errorf("an answer without data tools got a sources row; texts %q", tt.Texts())
	}
}

// TestChartFullScreen 断言图表卡片的「全屏」打开弹窗，用弹窗自己的 web view，关闭后释放。
func TestChartFullScreen(t *testing.T) {
	env := newRichTest(t)
	chart := env.chatWithChart(t)
	env.test.Frame()
	if err := env.test.Click("Full screen"); err != nil {
		t.Fatal(err)
	}
	env.test.Frame()
	if !env.app.cv.fullOpen || env.app.cv.fullChart.ID != chart.ID {
		t.Fatalf("full screen state %v %+v", env.app.cv.fullOpen, env.app.cv.fullChart)
	}
	if got := env.app.rich.Len(preview.OwnerModal); got != 1 {
		t.Errorf("%d modal web views, want 1", got)
	}
	expectTexts(t, env.test, []string{"Close", "Open in browser"}, nil)
	if err := env.test.Click("Close"); err != nil {
		t.Fatal(err)
	}
	env.test.Frame()
	if env.app.cv.fullOpen {
		t.Error("the modal did not close")
	}
	if got := env.app.rich.Len(preview.OwnerModal); got != 0 {
		t.Errorf("%d modal web views left after closing", got)
	}
}
