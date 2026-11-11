package app

import (
	"testing"

	"datawhisper/desktop/internal/conversation"
	"github.com/egoist/mygo/ui"
)

// TestTaskPanelShowsTheBoard 断言任务板读回来后，输入框上方有一行「任务 完成数/总数」并带着正在做的任务，
// 点开列出全部任务。
func TestTaskPanelShowsTheBoard(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 1180, 900)
	openRichChat(t, fs, q, a, tt)
	expectTexts(t, tt, nil, []string{"Tasks 1/3"})

	a.loadTasks()
	q.pump(t, tt, "the task board", func() bool { return len(a.cv.tasks) == 3 })
	expectTexts(t, tt, []string{"Tasks 1/3", "· Build the revenue chart"}, []string{"Write the summary"})

	if err := tt.Click("Tasks 1/3"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"Profile the data", "Build the revenue chart", "Write the summary"}, nil)
}

// TestFinishedTaskCalls 断言只有已完成的任务板写入类工具调用才让界面重新读取任务板。
func TestFinishedTaskCalls(t *testing.T) {
	call := func(name string, done bool) conversation.Message {
		return conversation.Message{Role: "tool", Done: done, Tool: &conversation.ToolCall{Name: name}}
	}
	messages := []conversation.Message{
		call("task_create", true), call("task_update", true), call("task_update", false),
		call("task_list", true), call("query_data", true), {Role: "assistant", Text: "task_create", Done: true},
	}
	if got := finishedTaskCalls(messages); got != 2 {
		t.Errorf("finished task calls = %d, want 2", got)
	}
}
