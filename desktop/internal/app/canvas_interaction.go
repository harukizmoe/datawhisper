package app

// 画布编辑的几何、手势与持久化。绘制区只负责显示；这里把指针位置映射回文档坐标，
// 每次手势结束才提交一次 update_node，拖动过程只改本地副本。

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

// canvasGeom 是一帧的文档→屏幕映射。nodeRects 与文档坐标一起缓存，供命中测试复用。
type canvasGeom struct {
	ok         bool
	scale      float32
	minX, minY float64
	originX    float32
	originY    float32
	nodeRects  map[string]ui.Rect
	body       ui.Rect
}

type canvasDrag struct {
	kind   string // move / resize
	handle string // nw, n, ne, e, se, s, sw, w
	id     string
	before conversation.CanvasNode
	startX float32
	startY float32
	moved  bool
}

type canvasHistory struct {
	id     string
	before conversation.CanvasNode
	after  conversation.CanvasNode
}

func canvasGeometry(r ui.Rect, canvas conversation.Canvas, padding float32) canvasGeom {
	g := canvasGeom{nodeRects: map[string]ui.Rect{}, body: r}
	if len(canvas.Nodes) == 0 || r.W <= 2*padding || r.H <= 2*padding {
		return g
	}
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, node := range canvas.Nodes {
		minX = math.Min(minX, node.X)
		minY = math.Min(minY, node.Y)
		maxX = math.Max(maxX, node.X+node.W)
		maxY = math.Max(maxY, node.Y+node.H)
	}
	if !isFiniteRect(minX, minY, maxX, maxY) || maxX <= minX || maxY <= minY {
		return g
	}
	scale := math.Min(
		float64(r.W-2*padding)/math.Max(1, maxX-minX),
		float64(r.H-2*padding)/math.Max(1, maxY-minY),
	)
	if scale <= 0 || math.IsInf(scale, 0) || math.IsNaN(scale) {
		return g
	}
	g.ok = true
	g.scale = float32(scale)
	g.minX, g.minY = minX, minY
	g.originX = r.X + padding + float32((float64(r.W-2*padding)-(maxX-minX)*scale)/2)
	g.originY = r.Y + padding + float32((float64(r.H-2*padding)-(maxY-minY)*scale)/2)
	for _, node := range canvas.Nodes {
		g.nodeRects[node.ID] = ui.Rect{
			X: g.originX + float32((node.X-minX)*scale),
			Y: g.originY + float32((node.Y-minY)*scale),
			W: float32(node.W) * g.scale,
			H: float32(node.H) * g.scale,
		}
	}
	return g
}

func (g canvasGeom) at(x, y float32) (float64, float64) {
	return g.minX + float64((x-g.originX)/g.scale), g.minY + float64((y-g.originY)/g.scale)
}

// nodeAt 从上往下找命中的节点（后画的在上）。
func (g canvasGeom) nodeAt(canvas conversation.Canvas, x, y float32) (conversation.CanvasNode, bool) {
	for i := len(canvas.Nodes) - 1; i >= 0; i-- {
		node := canvas.Nodes[i]
		if rect := g.nodeRects[node.ID]; pointInRect(rect, x, y) {
			return node, true
		}
	}
	return conversation.CanvasNode{}, false
}

func pointInRect(r ui.Rect, x, y float32) bool {
	return x >= r.X && x <= r.X+r.W && y >= r.Y && y <= r.Y+r.H
}

// handleRects 返回八个缩放手柄；只有单选时可用。
func handleRects(r ui.Rect) map[string]ui.Rect {
	const size float32 = 8
	out := map[string]ui.Rect{}
	add := func(name string, x, y float32) { out[name] = ui.Rect{X: x - size/2, Y: y - size/2, W: size, H: size} }
	add("nw", r.X, r.Y)
	add("n", r.X+r.W/2, r.Y)
	add("ne", r.X+r.W, r.Y)
	add("e", r.X+r.W, r.Y+r.H/2)
	add("se", r.X+r.W, r.Y+r.H)
	add("s", r.X+r.W/2, r.Y+r.H)
	add("sw", r.X, r.Y+r.H)
	add("w", r.X, r.Y+r.H/2)
	return out
}

func handleAt(r ui.Rect, x, y float32) (string, bool) {
	for name, h := range handleRects(r) {
		if pointInRect(h, x, y) {
			return name, true
		}
	}
	return "", false
}

func snap(value float64, enabled bool) float64 {
	if !enabled {
		return math.Round(value)
	}
	return math.Round(value/8) * 8
}

func clamped(value, low, high float64) float64 {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func (a *app) selectedCanvas() (conversation.Canvas, conversation.CanvasNode, bool) {
	canvas, ok := a.cv.canvases[a.cv.canvasID]
	if !ok {
		return conversation.Canvas{}, conversation.CanvasNode{}, false
	}
	for _, node := range canvas.Nodes {
		if node.ID == a.cv.canvasSel {
			return canvas, node, true
		}
	}
	return canvas, conversation.CanvasNode{}, false
}

func (a *app) startCanvasEdit() {
	_, node, ok := a.selectedCanvas()
	if !ok {
		return
	}
	a.cv.canvasEditing, a.cv.canvasDraft = node.ID, node.Text
}

func (a *app) cancelCanvasEdit() {
	a.cv.canvasEditing, a.cv.canvasDraft = "", ""
}

func (a *app) commitCanvasEdit() {
	if a.cv.canvasEditing == "" {
		return
	}
	_, node, ok := a.selectedCanvas()
	if !ok {
		a.cancelCanvasEdit()
		return
	}
	text := a.cv.canvasDraft
	if text != node.Text {
		after := node
		after.Text = text
		after.H = math.Max(node.H, float64(canvasTextHeight(text, node.W, node.FontSize)))
		a.updateCanvasNode(node, after, func(canvasID string) {
			a.pushCanvasHistory(canvasID, canvasHistory{id: node.ID, before: node, after: after}, false)
			delete(a.cv.canvasRedo, canvasID)
		})
	}
	a.cancelCanvasEdit()
}

// canvasTextHeight 粗略估算换行后的高度；只用于让节点随文字增长，不追求逐像素排版。
func canvasTextHeight(text string, width, fontSize float64) float32 {
	if width <= 0 || fontSize <= 0 {
		return 24
	}
	lines := 0
	for _, line := range strings.Split(text, "\n") {
		runes := []rune(line)
		used, count := 0.0, 1
		for _, r := range runes {
			advance := fontSize * 0.55
			if r > 0x2e80 {
				advance = fontSize
			}
			if used+advance > width-16 && used > 0 {
				count++
				used = 0
			}
			used += advance
		}
		lines += count
	}
	return float32(float64(lines)*fontSize*1.35 + 16)
}

func canvasNodePatch(node conversation.CanvasNode) map[string]any {
	return map[string]any{
		"x": node.X, "y": node.Y, "w": node.W, "h": node.H,
		"text": node.Text, "parent": node.Parent, "pinned": node.Pinned,
		"fontSize": node.FontSize,
		"style":    map[string]any{"fill": node.Style.Fill, "border": node.Style.Border, "text": node.Style.Text},
	}
}

// setCanvasNodeLocal 只改本地副本；服务端确认前界面先看到结果。
func (a *app) setCanvasNodeLocal(id string, node conversation.CanvasNode) {
	canvas, ok := a.cv.canvases[a.cv.canvasID]
	if !ok {
		return
	}
	for i := range canvas.Nodes {
		if canvas.Nodes[i].ID == id {
			canvas.Nodes[i] = node
			a.cv.canvases[a.cv.canvasID] = canvas
			return
		}
	}
}

// updateCanvasNode 乐观更新并提交一次；成功后替换为服务端返回的文档，失败时回滚。
func (a *app) updateCanvasNode(before, after conversation.CanvasNode, record func(canvasID string)) {
	canvas, ok := a.cv.canvases[a.cv.canvasID]
	if !ok || a.cv.canvasPending {
		return
	}
	a.setCanvasNodeLocal(after.ID, after)
	a.saveCanvasNode(canvas.ID, canvas.Revision, before, after, record)
}

func (a *app) saveCanvasNode(canvasID string, baseRevision int, before, after conversation.CanvasNode, record func(canvasID string)) {
	client, conv := a.client, a.conv
	if client == nil || conv == 0 {
		a.setCanvasNodeLocal(before.ID, before)
		return
	}
	a.cv.canvasPending, a.cv.canvasErr = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		updated, err := client.ApplyCanvas(ctx, conv, canvasID, baseRevision, []map[string]any{
			{"op": "update_node", "id": after.ID, "patch": canvasNodePatch(after)},
		})
		a.post(func() {
			if client != a.client || a.conv != conv {
				return
			}
			a.cv.canvasPending = false
			if err != nil {
				a.setCanvasNodeLocal(before.ID, before)
				if errors.Is(err, service.ErrCanvasConflict) {
					a.cv.canvasErr = a.tr("canvas.conflict")
					a.loadCanvases() // 服务端快照覆盖本地视图
				} else {
					a.cv.canvasErr = a.tr("canvas.saveFailed")
				}
				return
			}
			a.cv.canvasErr = ""
			if record != nil {
				record(canvasID)
			}
			a.mergeCanvas(updated)
		})
	}()
}

// mergeCanvas 把服务端返回的单张画布放回列表，保留其它画布。
func (a *app) mergeCanvas(updated service.Canvas) {
	if a.cv.canvases == nil {
		a.cv.canvases = map[string]conversation.Canvas{}
	}
	a.cv.canvases[updated.ID] = canvasFromService(updated)
}

// pushCanvasHistory 在提交成功后记一步；撤销/重做只保留当前会话内存。
func (a *app) pushCanvasHistory(canvasID string, entry canvasHistory, redo bool) {
	if a.cv.canvasUndo == nil {
		a.cv.canvasUndo, a.cv.canvasRedo = map[string][]canvasHistory{}, map[string][]canvasHistory{}
	}
	if redo {
		a.cv.canvasRedo[canvasID] = append(a.cv.canvasRedo[canvasID], entry)
		if len(a.cv.canvasRedo[canvasID]) > 50 {
			a.cv.canvasRedo[canvasID] = a.cv.canvasRedo[canvasID][1:]
		}
		return
	}
	a.cv.canvasUndo[canvasID] = append(a.cv.canvasUndo[canvasID], entry)
	if len(a.cv.canvasUndo[canvasID]) > 50 {
		a.cv.canvasUndo[canvasID] = a.cv.canvasUndo[canvasID][1:]
	}
}

func (a *app) undoCanvas() {
	canvasID := a.cv.canvasID
	stack := a.cv.canvasUndo[canvasID]
	if len(stack) == 0 || a.cv.canvasPending {
		return
	}
	entry := stack[len(stack)-1]
	a.setCanvasNodeLocal(entry.id, entry.before)
	a.saveCanvasNode(canvasID, a.cv.canvases[canvasID].Revision, entry.after, entry.before, func(savedID string) {
		a.cv.canvasUndo[savedID] = stack[:len(stack)-1]
		a.pushCanvasHistory(savedID, entry, true)
		a.cv.canvasSel = entry.id
	})
}

func (a *app) redoCanvas() {
	canvasID := a.cv.canvasID
	stack := a.cv.canvasRedo[canvasID]
	if len(stack) == 0 || a.cv.canvasPending {
		return
	}
	entry := stack[len(stack)-1]
	a.setCanvasNodeLocal(entry.id, entry.after)
	a.saveCanvasNode(canvasID, a.cv.canvases[canvasID].Revision, entry.before, entry.after, func(savedID string) {
		a.cv.canvasRedo[savedID] = stack[:len(stack)-1]
		a.pushCanvasHistory(savedID, entry, false)
		a.cv.canvasSel = entry.id
	})
}

func canvasFromService(item service.Canvas) conversation.Canvas {
	canvas := conversation.Canvas{
		ID: item.ID, Title: item.Title, TemplateID: item.TemplateID, UpdatedAt: item.UpdatedAt,
		Revision: item.Revision,
	}
	for _, node := range item.Nodes {
		canvas.Nodes = append(canvas.Nodes, conversation.CanvasNode{
			ID: node.ID, Kind: node.Kind, Text: node.Text, Parent: node.Parent,
			X: node.X, Y: node.Y, W: node.W, H: node.H, FontSize: node.FontSize, Pinned: node.Pinned,
			Style: conversation.CanvasStyle{Fill: node.Style.Fill, Border: node.Style.Border, Text: node.Style.Text},
		})
	}
	for _, edge := range item.Edges {
		canvas.Edges = append(canvas.Edges, conversation.CanvasEdge{
			ID: edge.ID, From: edge.From, To: edge.To, Route: edge.Route, Arrow: edge.Arrow,
			Dashed: edge.Dashed, Label: edge.Label,
			Style: conversation.CanvasStyle{Fill: edge.Style.Fill, Border: edge.Style.Border, Text: edge.Style.Text},
		})
	}
	return canvas
}

const canvasRoles = "default accent success warning danger muted"

// canvasStyleBar 是选中节点的语义样式条：只提供主题角色，不接受任意颜色。
func (a *app) canvasStyleBar(c *ui.Context, t *ui.Theme) {
	_, node, ok := a.selectedCanvas()
	if !ok {
		// 固定高度：选中时插入按钮不能改变绘制区位置，否则指针捕获会在重建时丢失。
		ui.Column(c).Height(92).Children(func() {
			ui.Text(c, a.tr("canvas.noSelection")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		})
		return
	}
	roleButton := func(kind, role string, child func()) {
		label := a.tr("canvas.styleRole", "kind", kind, "role", role)
		if ui.Button(c, "").Label(label).Tooltip(label).Children(child).Clicked() {
			a.setCanvasStyle(node, kind, role)
		}
	}
	ui.Column(c).Height(92).Gap(4).Children(func() {
		ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
			ui.Text(c, a.tr("canvas.fill")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Width(44)
			for _, role := range strings.Fields(canvasRoles) {
				roleButton("fill", role, func() {
					ui.Box(c).Width(14).Height(14).Radius(7).Background(roleColor(role, t)).BorderWidth(1).BorderColor(t.Border)
				})
			}
		})
		ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
			ui.Text(c, a.tr("canvas.border")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Width(44)
			for _, role := range strings.Fields(canvasRoles) {
				roleButton("border", role, func() {
					ui.Box(c).Width(14).Height(14).Radius(2).BorderWidth(2).BorderColor(roleColor(role, t))
				})
			}
		})
		ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
			ui.Text(c, a.tr("canvas.text")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Width(44)
			for _, role := range strings.Fields(canvasRoles) {
				roleButton("text", role, func() {
					ui.Text(c, "A").FontSize(a.fs(textCaption)).TextColor(roleColor(role, t))
				})
			}
			ui.Text(c, a.tr("canvas.fontSize", "size", itoa(int(node.FontSize)))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Padding(0, 6)
			if ui.Button(c, "A−").Label(a.tr("canvas.fontSmaller")).Tooltip(a.tr("canvas.fontSmaller")).Clicked() {
				a.setCanvasFontSize(node, math.Max(8, node.FontSize-2))
			}
			if ui.Button(c, "A+").Label(a.tr("canvas.fontLarger")).Tooltip(a.tr("canvas.fontLarger")).Clicked() {
				a.setCanvasFontSize(node, math.Min(48, node.FontSize+2))
			}
		})
	})
}

func (a *app) setCanvasStyle(node conversation.CanvasNode, kind, role string) {
	after := node
	switch kind {
	case "fill":
		after.Style.Fill = role
	case "border":
		after.Style.Border = role
	case "text":
		after.Style.Text = role
	}
	if after.Style == node.Style {
		return
	}
	a.commitCanvasNode(node, after)
}

func (a *app) setCanvasFontSize(node conversation.CanvasNode, size float64) {
	after := node
	after.FontSize = size
	a.commitCanvasNode(node, after)
}

func (a *app) commitCanvasNode(before, after conversation.CanvasNode) {
	a.updateCanvasNode(before, after, func(canvasID string) {
		a.pushCanvasHistory(canvasID, canvasHistory{id: after.ID, before: before, after: after}, false)
		delete(a.cv.canvasRedo, canvasID)
	})
}

// canvasInput 处理绘制区的指针与键盘。拖动过程只改本地副本，释放时才提交。
func (a *app) canvasInput(ev ui.InputEvent) bool {
	if ev.Kind == ui.InputKeyDown && a.cv.canvasEditing == "" {
		if ev.Mods&(ui.Ctrl|ui.Super) != 0 && ev.Key == ui.KeyZ {
			if ev.Mods&ui.Shift != 0 {
				a.redoCanvas()
			} else {
				a.undoCanvas()
			}
			return true
		}
	}
	canvas, ok := a.cv.canvases[a.cv.canvasID]
	if !ok {
		return false
	}
	switch ev.Kind {
	case ui.InputPointerDown:
		if a.cv.canvasEditing != "" {
			a.commitCanvasEdit()
			a.redraw()
		}
		if a.cv.canvasPending || !a.cv.canvasGeom.ok {
			return false
		}
		if a.cv.canvasSel != "" {
			if rect, exists := a.cv.canvasGeom.nodeRects[a.cv.canvasSel]; exists {
				if handle, hit := handleAt(rect, ev.X, ev.Y); hit {
					for _, node := range canvas.Nodes {
						if node.ID == a.cv.canvasSel {
							a.cv.canvasDrag = &canvasDrag{kind: "resize", handle: handle, id: node.ID, before: node, startX: ev.X, startY: ev.Y}
							return true
						}
					}
				}
			}
		}
		node, hit := a.cv.canvasGeom.nodeAt(canvas, ev.X, ev.Y)
		if !hit {
			a.cv.canvasSel = ""
			return false
		}
		a.cv.canvasSel = node.ID
		if ev.Clicks >= 2 {
			a.startCanvasEdit()
			a.redraw()
			return true
		}
		if !a.cv.canvasPending {
			a.cv.canvasDrag = &canvasDrag{kind: "move", id: node.ID, before: node, startX: ev.X, startY: ev.Y}
		}
		return true
	case ui.InputPointerMove:
		if a.cv.canvasDrag == nil {
			return false
		}
		a.dragCanvasNode(ev)
		return true
	case ui.InputPointerUp:
		if a.cv.canvasDrag == nil {
			return false
		}
		drag := *a.cv.canvasDrag
		a.cv.canvasDrag = nil
		if drag.moved {
			_, after, found := a.selectedCanvas()
			if found && after.ID == drag.id {
				a.commitCanvasNode(drag.before, after)
			}
		}
		return true
	}
	return false
}

func (a *app) dragCanvasNode(ev ui.InputEvent) {
	drag := a.cv.canvasDrag
	geom := a.cv.canvasGeom
	if drag == nil || !geom.ok {
		return
	}
	dx := float64((ev.X - drag.startX) / geom.scale)
	dy := float64((ev.Y - drag.startY) / geom.scale)
	if math.Abs(dx) < 0.01 && math.Abs(dy) < 0.01 {
		return
	}
	drag.moved = true
	alt := ev.Mods&ui.Alt != 0
	node := drag.before
	if drag.kind == "move" {
		node.X = snap(drag.before.X+dx, !alt)
		node.Y = snap(drag.before.Y+dy, !alt)
	} else {
		left, top := drag.before.X, drag.before.Y
		right, bottom := drag.before.X+drag.before.W, drag.before.Y+drag.before.H
		if strings.Contains(drag.handle, "w") {
			left = snap(left+dx, !alt)
		}
		if strings.Contains(drag.handle, "e") {
			right = snap(right+dx, !alt)
		}
		if strings.Contains(drag.handle, "n") {
			top = snap(top+dy, !alt)
		}
		if strings.Contains(drag.handle, "s") {
			bottom = snap(bottom+dy, !alt)
		}
		const minimum = 40.0
		if right-left < minimum {
			if strings.Contains(drag.handle, "w") {
				left = right - minimum
			} else {
				right = left + minimum
			}
		}
		if bottom-top < minimum {
			if strings.Contains(drag.handle, "n") {
				top = bottom - minimum
			} else {
				bottom = top + minimum
			}
		}
		node.X, node.Y, node.W, node.H = left, top, right-left, bottom-top
	}
	a.setCanvasNodeLocal(node.ID, node)
	a.redraw()
}

// canvasTextOverlay 把现有文本输入叠在节点上；光标与输入法由控件负责。
func (a *app) canvasTextOverlay(c *ui.Context, t *ui.Theme) {
	_, node, ok := a.selectedCanvas()
	if !ok || node.ID != a.cv.canvasEditing {
		return
	}
	rect, exists := a.cv.canvasGeom.nodeRects[node.ID]
	if !exists {
		return
	}
	ui.Column(c).Absolute().Left(rect.X).Top(rect.Y).Width(rect.W).Children(func() {
		ui.TextArea(c, &a.cv.canvasDraft).
			Label(a.tr("canvas.textEditor")).
			Lines(1, 8).
			MinHeight(rect.H).
			FontSize(clampF(float32(node.FontSize)*a.cv.canvasGeom.scale, 8, 24)).
			Background(t.Surface).
			BorderWidth(1).
			BorderColor(t.Accent).
			Focus().
			OnTextKey(func(k ui.TextKey) bool {
				switch {
				case k.Key == ui.KeyEscape:
					a.cancelCanvasEdit()
					a.redraw()
					return true
				case k.Key == ui.KeyEnter && k.Mods&(ui.Ctrl|ui.Super) != 0:
					a.cv.canvasDraft = k.Text()
					a.commitCanvasEdit()
					a.redraw()
					return true
				}
				return false
			})
	})
}
