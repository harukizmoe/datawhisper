package app

import (
	"testing"
	"time"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/prefs"
	"github.com/egoist/mygo/ui"
)

// TestComposerCollapsesWhenUnfocused 断言输入区的折叠：失去焦点一小会儿后收成一行，点它又展开；
// 有草稿时不折叠；失焦的瞬间（比如刚在下拉框里选了一项）不折叠。
func TestComposerCollapsesWhenUnfocused(t *testing.T) {
	open := func() (*app, *ui.Tester) {
		q := newQueue()
		a := newTestApp(t, q)
		a.prefs = prefs.Default()
		a.prefs.Appearance.FoldRuns = false
		a.chat.Messages = []conversation.Message{
			{Key: "u", Role: "user", Text: "question u", Done: true},
			{Key: "th", Role: "thinking", Text: "thinking about it", Done: true},
			{Key: "g", Role: "assistant", Text: "the answer", Done: true},
		}
		tt := ui.NewTester(a.view, 1180, 900)
		tt.Frame() // 输入框的自动聚焦要等第二帧才生效；之前点走焦点，输入区就没有「得到过焦点」
		return a, tt
	}

	a, tt := open()
	expectTexts(t, tt, []string{"Send"}, []string{"Write a message"})
	if err := tt.Click("Search chats"); err != nil { // 点到别的输入框：焦点离开输入区
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"Send"}, []string{"Write a message"})
	tt.Advance(composerGrace + 100*time.Millisecond)
	tt.Frame()
	expectTexts(t, tt, []string{"Write a message"}, []string{"Send"})

	if err := tt.Click("Write a message"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"Send"}, []string{"Write a message"})

	// 有草稿时即使没有焦点也不折叠。
	a, tt = open()
	a.input = "a draft"
	tt.Frame()
	if err := tt.Click("Search chats"); err != nil {
		t.Fatal(err)
	}
	tt.Advance(composerGrace + 100*time.Millisecond)
	tt.Frame()
	expectTexts(t, tt, []string{"Send"}, []string{"Write a message"})
}
