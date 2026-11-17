package app

import (
	"testing"
	"time"

	"datawhisper/desktop/internal/conversation"
)

// 首字延迟按“提交被受理 → 第一段助手输出”计算；空壳消息不算，已有的助手消息不算。
func TestFirstTokenLatency(t *testing.T) {
	a, _, tt := openChat(t, newSourceFake(t))
	a.cv.ttftSeen = map[string]bool{"u1": true}
	a.cv.ttftStart = time.Now().Add(-1500 * time.Millisecond)

	a.recordTTFT(conversation.State{Messages: []conversation.Message{
		{Key: "u1", Role: "user", Text: "hi", Done: true},
		{Key: "a1", Role: "assistant", Text: ""},
	}})
	if a.cv.ttft != 0 || a.cv.ttftStart.IsZero() {
		t.Fatalf("an empty assistant shell must not count as the first token: ttft=%v", a.cv.ttft)
	}

	a.recordTTFT(conversation.State{Messages: []conversation.Message{
		{Key: "a1", Role: "assistant", Text: "hello"},
	}})
	if a.cv.ttft < 1400*time.Millisecond || a.cv.ttft > 2*time.Second {
		t.Fatalf("ttft = %v, want about 1.5s", a.cv.ttft)
	}
	if !a.cv.ttftStart.IsZero() {
		t.Error("the timer keeps running after the first token")
	}
	if got := formatTTFT(a.cv.ttft); got != "1.5s" {
		t.Errorf("formatTTFT = %q", got)
	}

	// 状态行在回复中显示首字延迟。
	a.chat.Busy = true
	a.connected = true
	a.cv.busySince = time.Now().Add(-2 * time.Second)
	tt.Frame()
	expectTexts(t, tt, []string{"first token 1.5s"}, nil)
}
