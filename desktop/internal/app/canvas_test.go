package app

import (
	"strings"
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

func openEditableCanvas(t *testing.T) (*app, *ui.Tester, *fakeService, *uiQueue) {
	t.Helper()
	fs := newFakeService(t)
	q := newQueue()
	a := newTestApp(t, q)
	tt := ui.NewTester(a.view, 1200, 900)
	a.onService(fs.ready(41))
	q.pump(t, tt, "the service", func() bool { return a.client != nil })
	a.conv = 2
	a.loadCanvases()
	q.pump(t, tt, "the canvas list", func() bool { return len(a.cv.canvases) == 1 })
	a.cv.canvasID, a.cv.canvasOpen = "cv_1", true
	tt.Frame()
	return a, tt, fs, q
}

func canvasPoint(t *testing.T, a *app, tt *ui.Tester, nodeID string) (float32, float32) {
	t.Helper()
	body, ok := tt.Find(a.tr("canvas.surface"))
	if !ok {
		t.Fatalf("canvas surface not found")
	}
	rect, ok := a.cv.canvasGeom.nodeRects[nodeID]
	if !ok {
		t.Fatalf("node %s not rendered", nodeID)
	}
	return body.X + rect.X + rect.W/2, body.Y + rect.Y + rect.H/2
}

func TestCanvasDragMovesAndPersistsNode(t *testing.T) {
	a, tt, fs, q := openEditableCanvas(t)
	x, y := canvasPoint(t, a, tt, "a")
	tt.Move(x, y)
	tt.Press(x, y)
	tt.Move(x+96, y+40)
	tt.Release(x+96, y+40)
	q.pump(t, tt, "canvas save", func() bool { return len(fs.callsTo("canvas.apply")) == 1 && !a.cv.canvasPending })
	node := a.cv.canvases["cv_1"].Nodes[0]
	if node.X == 20 || node.Y == 20 {
		t.Fatalf("node did not move: %+v", node)
	}
	if a.cv.canvases["cv_1"].Revision != 3 {
		t.Fatalf("revision %d", a.cv.canvases["cv_1"].Revision)
	}

	// 重新读取服务端文档，位置仍在。
	a.loadCanvases()
	q.pump(t, tt, "canvas reload", func() bool { return a.cv.canvases["cv_1"].Revision == 3 })
	if a.cv.canvases["cv_1"].Nodes[0].X != node.X {
		t.Fatalf("reloaded x %v, want %v", a.cv.canvases["cv_1"].Nodes[0].X, node.X)
	}
}

func TestCanvasResizeHandleChangesSize(t *testing.T) {
	a, tt, fs, q := openEditableCanvas(t)
	x, y := canvasPoint(t, a, tt, "a")
	tt.ClickAt(x, y)
	tt.Frame()
	body, _ := tt.Find(a.tr("canvas.surface"))
	rect := a.cv.canvasGeom.nodeRects["a"]
	hx, hy := body.X+rect.X+rect.W, body.Y+rect.Y+rect.H
	tt.Move(hx, hy)
	tt.Press(hx, hy)
	tt.Move(hx+72, hy+48)
	tt.Release(hx+72, hy+48)
	q.pump(t, tt, "canvas resize", func() bool { return len(fs.callsTo("canvas.apply")) == 1 && !a.cv.canvasPending })
	node := a.cv.canvases["cv_1"].Nodes[0]
	if node.W <= 120 || node.H <= 60 {
		t.Fatalf("node did not grow: %+v", node)
	}
}

func TestCanvasTextEditCommitsAndGrows(t *testing.T) {
	a, tt, fs, q := openEditableCanvas(t)
	x, y := canvasPoint(t, a, tt, "a")
	tt.ClickAt(x, y)
	tt.ClickAt(x, y)
	tt.Frame()
	if a.cv.canvasEditing != "a" {
		t.Fatalf("double click did not start editing: %q", a.cv.canvasEditing)
	}
	tt.Type(" — a much longer label that wraps")
	tt.Key(ui.Ctrl, ui.KeyEnter)
	q.pump(t, tt, "text save", func() bool { return len(fs.callsTo("canvas.apply")) == 1 && !a.cv.canvasPending })
	node := a.cv.canvases["cv_1"].Nodes[0]
	if !strings.Contains(node.Text, "longer label") {
		t.Fatalf("text not saved: %q", node.Text)
	}
	if node.H <= 60 {
		t.Fatalf("height did not grow: %v", node.H)
	}
	if a.cv.canvasEditing != "" {
		t.Fatal("editor still open")
	}
}

func TestCanvasStyleChangeAndUndo(t *testing.T) {
	a, tt, fs, q := openEditableCanvas(t)
	x, y := canvasPoint(t, a, tt, "a")
	tt.Move(x, y)
	tt.ClickAt(x, y)
	tt.Frame()
	if err := tt.Click(a.tr("canvas.styleRole", "kind", "fill", "role", "warning")); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "style save", func() bool { return len(fs.callsTo("canvas.apply")) == 1 && !a.cv.canvasPending })
	if got := a.cv.canvases["cv_1"].Nodes[0].Style.Fill; got != "warning" {
		t.Fatalf("fill %q", got)
	}
	tt.Frame()
	tt.Key(ui.Ctrl, ui.KeyZ)
	q.pump(t, tt, "undo save", func() bool { return len(fs.callsTo("canvas.apply")) == 2 && !a.cv.canvasPending })
	if got := a.cv.canvases["cv_1"].Nodes[0].Style.Fill; got != "accent" {
		t.Fatalf("undo left fill %q", got)
	}
}

func TestCanvasConflictRollsBackAndShowsMessage(t *testing.T) {
	a, tt, fs, q := openEditableCanvas(t)
	fs.mu.Lock()
	fs.conflict = true
	fs.mu.Unlock()
	x, y := canvasPoint(t, a, tt, "a")
	tt.Move(x, y)
	tt.Press(x, y)
	tt.Move(x+80, y+20)
	tt.Release(x+80, y+20)
	q.pump(t, tt, "conflict", func() bool { return a.cv.canvasErr != "" && !a.cv.canvasPending })
	if !strings.Contains(a.cv.canvasErr, "latest version") {
		t.Fatalf("error %q", a.cv.canvasErr)
	}
	node := a.cv.canvases["cv_1"].Nodes[0]
	if node.X != 20 || node.Y != 20 {
		t.Fatalf("conflict did not roll back: %+v", node)
	}
}

func TestCanvasFontSizeAndEscCancel(t *testing.T) {
	a, tt, fs, q := openEditableCanvas(t)
	x, y := canvasPoint(t, a, tt, "a")
	tt.Move(x, y)
	tt.ClickAt(x, y)
	tt.Frame()
	if err := tt.Click(a.tr("canvas.fontLarger")); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "font save", func() bool { return len(fs.callsTo("canvas.apply")) == 1 && !a.cv.canvasPending })
	if got := a.cv.canvases["cv_1"].Nodes[0].FontSize; got != 16 {
		t.Fatalf("font size %v", got)
	}

	tt.ClickAt(x, y)
	tt.ClickAt(x, y)
	tt.Frame()
	tt.Type("discard me")
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if a.cv.canvasEditing != "" {
		t.Fatal("Escape left the editor open")
	}
	if got := a.cv.canvases["cv_1"].Nodes[0].Text; strings.Contains(got, "discard") {
		t.Fatalf("Escape saved text %q", got)
	}
}

func TestCanvasUndoRedoMove(t *testing.T) {
	a, tt, fs, q := openEditableCanvas(t)
	x, y := canvasPoint(t, a, tt, "a")
	tt.Move(x, y)
	tt.Press(x, y)
	tt.Move(x+96, y+40)
	tt.Release(x+96, y+40)
	q.pump(t, tt, "move save", func() bool { return len(fs.callsTo("canvas.apply")) == 1 && !a.cv.canvasPending })
	moved := a.cv.canvases["cv_1"].Nodes[0]

	tt.Frame()
	tt.Key(ui.Ctrl, ui.KeyZ)
	q.pump(t, tt, "undo move", func() bool { return len(fs.callsTo("canvas.apply")) == 2 && !a.cv.canvasPending })
	if back := a.cv.canvases["cv_1"].Nodes[0]; back.X != 20 || back.Y != 20 {
		t.Fatalf("undo: %+v", back)
	}

	tt.Frame()
	tt.Key(ui.Ctrl|ui.Shift, ui.KeyZ)
	q.pump(t, tt, "redo move", func() bool { return len(fs.callsTo("canvas.apply")) == 3 && !a.cv.canvasPending })
	if again := a.cv.canvases["cv_1"].Nodes[0]; again.X != moved.X || again.Y != moved.Y {
		t.Fatalf("redo: %+v", again)
	}
}

func TestCanvasTextCommitByClickingBlank(t *testing.T) {
	a, tt, fs, q := openEditableCanvas(t)
	x, y := canvasPoint(t, a, tt, "a")
	tt.ClickAt(x, y)
	tt.ClickAt(x, y)
	tt.Frame()
	tt.Type(" via blank")
	body, _ := tt.Find(a.tr("canvas.surface"))
	tt.ClickAt(body.X+20, body.Y+20)
	q.pump(t, tt, "blank save", func() bool { return len(fs.callsTo("canvas.apply")) == 1 && !a.cv.canvasPending })
	if got := a.cv.canvases["cv_1"].Nodes[0].Text; !strings.Contains(got, "via blank") {
		t.Fatalf("blank click did not commit: %q", got)
	}
}
