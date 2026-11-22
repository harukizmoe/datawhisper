package app

import (
	"testing"

	"datawhisper/desktop/internal/conversation"
	"github.com/egoist/mygo/ui"
)

// 画布不在订阅视图里：切换会话后必须自己用 canvas.list 读取。
func TestCanvasListLoadsWhenAConversationOpens(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := newTestApp(t, q)
	tt := ui.NewTester(a.view, 1180, 760)
	a.onService(fs.ready(41))
	q.pump(t, tt, "the conversation list", func() bool { return a.listLoaded })
	if err := tt.Click("Greeting"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the canvas list", func() bool { return len(a.cv.canvases) == 1 })
	canvas := a.cv.canvases["cv_1"]
	if canvas.Title != "Signup flow" || canvas.Revision != 2 || len(canvas.Nodes) != 2 || len(canvas.Edges) != 1 {
		t.Fatalf("unexpected canvas: %+v", canvas)
	}
}

// 画布工具结果应当在对话里显示卡片，点 Open 打开只读弹窗。
func TestCanvasCardOpensReadOnlyModal(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	ref := conversation.CanvasRef{ID: "cv_1", Title: "注册流程", Revision: 1}
	a.chat = conversation.State{
		Conversation: 1,
		Messages: []conversation.Message{{
			Key: "e1", Role: "tool", Done: true,
			Tool: &conversation.ToolCall{
				CallID: "c1", Name: "canvas_create", Status: "ok",
				Output: `{"canvas_id":"cv_1","title":"注册流程","revision":1}`,
				Canvas: &ref,
			},
		}},
	}
	a.cv.canvases = map[string]conversation.Canvas{
		"cv_1": {
			ID: "cv_1", Title: "注册流程", Revision: 1,
			Nodes: []conversation.CanvasNode{
				{ID: "start", Kind: "round", X: 40, Y: 40, W: 160, H: 80, Text: "开始"},
				{ID: "end", Kind: "round", X: 320, Y: 40, W: 160, H: 80, Text: "完成"},
			},
			Edges: []conversation.CanvasEdge{{ID: "e", From: "start", To: "end", Route: "straight", Arrow: "end"}},
		},
	}
	tt := ui.NewTester(a.view, 1200, 900)
	tt.Frame()
	if !tt.HasText("注册流程") {
		t.Fatalf("canvas card title missing; texts: %v", tt.Texts())
	}
	if err := tt.Click("Open"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !tt.HasText("Revision 1") {
		t.Fatalf("canvas modal revision missing; texts: %v", tt.Texts())
	}
}
