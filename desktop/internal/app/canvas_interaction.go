package app

// 画布编辑的几何、手势与持久化。绘制区只负责显示；这里把指针位置映射回文档坐标，
// 每次手势结束才提交一次批量操作，拖动过程只改本地副本。

import (
	"context"
	"errors"
	"fmt"
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
	kind   string // move / resize / marquee
	handle string // nw, n, ne, e, se, s, sw, w
	ids    []string
	before map[string]conversation.CanvasNode
	startX float32
	startY float32
	moved  bool
}

type canvasNodeChange struct {
	before conversation.CanvasNode
	after  conversation.CanvasNode
}

type canvasHistory struct {
	changes []canvasNodeChange
}

// canvasClipboard 是应用内剪贴板；粘贴在目标画布上重新生成 id，所以可以跨画布。
type canvasClipboard struct {
	nodes  []conversation.CanvasNode
	edges  []conversation.CanvasEdge
	pastes int
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

func rectsIntersect(a, b ui.Rect) bool {
	return a.X < b.X+b.W && a.X+a.W > b.X && a.Y < b.Y+b.H && a.Y+a.H > b.Y
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

func (a *app) isSelected(id string) bool {
	return a.cv.canvasSel != nil && a.cv.canvasSel[id]
}

func (a *app) selectOnly(id string) {
	a.cv.canvasSel = map[string]bool{id: true}
}

func (a *app) toggleSelected(id string) {
	if a.cv.canvasSel == nil {
		a.cv.canvasSel = map[string]bool{}
	}
	if a.cv.canvasSel[id] {
		delete(a.cv.canvasSel, id)
	} else {
		a.cv.canvasSel[id] = true
	}
}

// selectedIDs 按文档顺序返回选中节点，保证批量操作与历史记录稳定。
func (a *app) selectedIDs() []string {
	canvas, ok := a.cv.canvases[a.cv.canvasID]
	if !ok {
		return nil
	}
	var ids []string
	for _, node := range canvas.Nodes {
		if a.isSelected(node.ID) {
			ids = append(ids, node.ID)
		}
	}
	return ids
}

func (a *app) selectedNodes() []conversation.CanvasNode {
	canvas, ok := a.cv.canvases[a.cv.canvasID]
	if !ok {
		return nil
	}
	var nodes []conversation.CanvasNode
	for _, node := range canvas.Nodes {
		if a.isSelected(node.ID) {
			nodes = append(nodes, node)
		}
	}
	return nodes
}

func (a *app) selectedCanvas() (conversation.Canvas, conversation.CanvasNode, bool) {
	canvas, ok := a.cv.canvases[a.cv.canvasID]
	if !ok || len(a.cv.canvasSel) != 1 {
		return conversation.Canvas{}, conversation.CanvasNode{}, false
	}
	for _, node := range canvas.Nodes {
		if a.isSelected(node.ID) {
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
		a.commitCanvasNode(node, after)
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
	return canvasNodeObject(node)
}

func canvasNodeObject(node conversation.CanvasNode) map[string]any {
	return map[string]any{
		"id": node.ID, "kind": node.Kind,
		"x": node.X, "y": node.Y, "w": node.W, "h": node.H,
		"text": node.Text, "parent": node.Parent, "pinned": node.Pinned,
		"fontSize": node.FontSize,
		"style":    map[string]any{"fill": node.Style.Fill, "border": node.Style.Border, "text": node.Style.Text},
	}
}

func canvasEdgeObject(edge conversation.CanvasEdge) map[string]any {
	return map[string]any{
		"id": edge.ID, "from": edge.From, "to": edge.To,
		"route": edge.Route, "arrow": edge.Arrow, "dashed": edge.Dashed, "label": edge.Label,
		"style": map[string]any{"fill": edge.Style.Fill, "border": edge.Style.Border, "text": edge.Style.Text},
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

func (a *app) setCanvasNodesLocal(changes []canvasNodeChange, before bool) {
	for _, change := range changes {
		if before {
			a.setCanvasNodeLocal(change.before.ID, change.before)
		} else {
			a.setCanvasNodeLocal(change.after.ID, change.after)
		}
	}
}

func (a *app) nodeUpdateOps(changes []canvasNodeChange) []map[string]any {
	ops := make([]map[string]any, 0, len(changes))
	for _, change := range changes {
		ops = append(ops, map[string]any{"op": "update_node", "id": change.after.ID, "patch": canvasNodePatch(change.after)})
	}
	return ops
}

// updateCanvasNodes 乐观更新并提交一批 update_node；成功后替换为服务端文档，失败回滚。
func (a *app) updateCanvasNodes(changes []canvasNodeChange, record func(canvasID string)) {
	canvas, ok := a.cv.canvases[a.cv.canvasID]
	if !ok || len(changes) == 0 || a.cv.canvasPending {
		return
	}
	a.setCanvasNodesLocal(changes, false)
	a.saveCanvasOps(canvas.ID, canvas.Revision, a.nodeUpdateOps(changes), func(canvasID string) {
		if record != nil {
			record(canvasID)
		}
	}, func() { a.setCanvasNodesLocal(changes, true) })
}

func (a *app) updateCanvasNode(before, after conversation.CanvasNode, record func(canvasID string)) {
	a.updateCanvasNodes([]canvasNodeChange{{before: before, after: after}}, record)
}

func (a *app) commitCanvasNode(before, after conversation.CanvasNode) {
	a.updateCanvasNode(before, after, func(canvasID string) {
		a.pushCanvasHistory(canvasID, canvasHistory{changes: []canvasNodeChange{{before: before, after: after}}}, false)
		delete(a.cv.canvasRedo, canvasID)
	})
}

// saveCanvasOps 提交一批操作；onFailure 把本地乐观修改恢复，冲突时重新读取服务端快照。
func (a *app) saveCanvasOps(canvasID string, baseRevision int, ops []map[string]any, onSuccess func(canvasID string), onFailure func()) {
	client, conv := a.client, a.conv
	if client == nil || conv == 0 {
		if onFailure != nil {
			onFailure()
		}
		return
	}
	a.cv.canvasPending, a.cv.canvasErr = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		updated, err := client.ApplyCanvas(ctx, conv, canvasID, baseRevision, ops)
		a.post(func() {
			if client != a.client || a.conv != conv {
				return
			}
			a.cv.canvasPending = false
			if err != nil {
				if onFailure != nil {
					onFailure()
				}
				if errors.Is(err, service.ErrCanvasConflict) {
					a.cv.canvasErr = a.tr("canvas.conflict")
					a.loadCanvases()
				} else {
					a.cv.canvasErr = a.tr("canvas.saveFailed")
				}
				return
			}
			a.cv.canvasErr = ""
			if onSuccess != nil {
				onSuccess(canvasID)
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

func (a *app) pushCanvasHistory(canvasID string, entry canvasHistory, redo bool) {
	if a.cv.canvasUndo == nil {
		a.cv.canvasUndo, a.cv.canvasRedo = map[string][]canvasHistory{}, map[string][]canvasHistory{}
	}
	target := &a.cv.canvasUndo
	if redo {
		target = &a.cv.canvasRedo
	}
	(*target)[canvasID] = append((*target)[canvasID], entry)
	if len((*target)[canvasID]) > 50 {
		(*target)[canvasID] = (*target)[canvasID][1:]
	}
}

func (a *app) undoCanvas() {
	canvasID := a.cv.canvasID
	stack := a.cv.canvasUndo[canvasID]
	if len(stack) == 0 || a.cv.canvasPending {
		return
	}
	entry := stack[len(stack)-1]
	reverse := make([]canvasNodeChange, 0, len(entry.changes))
	for _, change := range entry.changes {
		reverse = append(reverse, canvasNodeChange{before: change.after, after: change.before})
	}
	a.setCanvasNodesLocal(reverse, false)
	a.cv.canvasSel = map[string]bool{}
	for _, change := range entry.changes {
		a.cv.canvasSel[change.after.ID] = true
	}
	a.saveCanvasOps(canvasID, a.cv.canvases[canvasID].Revision, a.nodeUpdateOps(reverse), func(savedID string) {
		a.cv.canvasUndo[savedID] = stack[:len(stack)-1]
		a.pushCanvasHistory(savedID, entry, true)
	}, func() { a.setCanvasNodesLocal(reverse, true) })
}

func (a *app) redoCanvas() {
	canvasID := a.cv.canvasID
	stack := a.cv.canvasRedo[canvasID]
	if len(stack) == 0 || a.cv.canvasPending {
		return
	}
	entry := stack[len(stack)-1]
	a.setCanvasNodesLocal(entry.changes, false)
	a.cv.canvasSel = map[string]bool{}
	for _, change := range entry.changes {
		a.cv.canvasSel[change.after.ID] = true
	}
	a.saveCanvasOps(canvasID, a.cv.canvases[canvasID].Revision, a.nodeUpdateOps(entry.changes), func(savedID string) {
		a.cv.canvasRedo[savedID] = stack[:len(stack)-1]
		a.pushCanvasHistory(savedID, entry, false)
	}, func() { a.setCanvasNodesLocal(entry.changes, true) })
}

// copyCanvasSelection 把选中节点与两端都在选区内的连线放进应用内剪贴板。
func (a *app) copyCanvasSelection() {
	canvas, ok := a.cv.canvases[a.cv.canvasID]
	if !ok {
		return
	}
	ids := a.selectedIDs()
	if len(ids) == 0 {
		return
	}
	selected := map[string]bool{}
	clip := &canvasClipboard{}
	for _, node := range canvas.Nodes {
		if a.isSelected(node.ID) {
			selected[node.ID] = true
			clip.nodes = append(clip.nodes, node)
		}
	}
	for _, edge := range canvas.Edges {
		if selected[edge.From] && selected[edge.To] {
			clip.edges = append(clip.edges, edge)
		}
	}
	if len(clip.nodes) > 0 {
		a.cv.canvasClipboard = clip
	}
}

func (a *app) pasteCanvasClipboard() {
	clip := a.cv.canvasClipboard
	canvas, ok := a.cv.canvases[a.cv.canvasID]
	if clip == nil || len(clip.nodes) == 0 || !ok || a.cv.canvasPending {
		return
	}
	clip.pastes++
	offset := float64(16 * clip.pastes)
	suffix := time.Now().UnixNano()
	used := map[string]bool{}
	for _, node := range canvas.Nodes {
		used[node.ID] = true
	}
	remap := map[string]string{}
	for i, node := range clip.nodes {
		id := fmt.Sprintf("n_%d_%d", suffix, i)
		for used[id] {
			suffix++
			id = fmt.Sprintf("n_%d_%d", suffix, i)
		}
		used[id] = true
		remap[node.ID] = id
	}
	var newNodes []conversation.CanvasNode
	ops := make([]map[string]any, 0, len(clip.nodes)+len(clip.edges))
	for _, node := range clip.nodes {
		copy := node
		copy.ID = remap[node.ID]
		copy.X += offset
		copy.Y += offset
		if node.Parent != "" {
			copy.Parent = remap[node.Parent]
		} else {
			copy.Parent = ""
		}
		newNodes = append(newNodes, copy)
		ops = append(ops, map[string]any{"op": "add_node", "node": canvasNodeObject(copy)})
	}
	var newEdges []conversation.CanvasEdge
	edgeIDs := map[string]bool{}
	for _, edge := range canvas.Edges {
		edgeIDs[edge.ID] = true
	}
	for i, edge := range clip.edges {
		id := fmt.Sprintf("e_%d_%d", suffix, i)
		for edgeIDs[id] {
			suffix++
			id = fmt.Sprintf("e_%d_%d", suffix, i)
		}
		edgeIDs[id] = true
		copy := edge
		copy.ID = id
		copy.From = remap[edge.From]
		copy.To = remap[edge.To]
		if copy.From == "" || copy.To == "" {
			continue
		}
		newEdges = append(newEdges, copy)
		ops = append(ops, map[string]any{"op": "add_edge", "edge": canvasEdgeObject(copy)})
	}
	// 先本地预览，id 与服务端提交的一致；失败就重新读取。
	canvas.Nodes = append(canvas.Nodes, newNodes...)
	canvas.Edges = append(canvas.Edges, newEdges...)
	a.cv.canvases[canvas.ID] = canvas
	a.cv.canvasSel = map[string]bool{}
	for _, node := range newNodes {
		a.cv.canvasSel[node.ID] = true
	}
	a.saveCanvasOps(canvas.ID, canvas.Revision, ops, nil, func() { a.loadCanvases() })
}

func (a *app) duplicateCanvasSelection() {
	a.copyCanvasSelection()
	a.pasteCanvasClipboard()
}

// alignCanvasSelection 把对齐/分布作为一次批量提交。
func (a *app) alignCanvasSelection(mode string) {
	nodes := a.selectedNodes()
	if len(nodes) < 2 || a.cv.canvasPending {
		return
	}
	if (mode == "hdistribute" || mode == "vdistribute") && len(nodes) < 3 {
		return
	}
	after := make([]conversation.CanvasNode, len(nodes))
	copy(after, nodes)
	switch mode {
	case "left":
		minX := nodes[0].X
		for _, node := range nodes[1:] {
			minX = math.Min(minX, node.X)
		}
		for i := range after {
			after[i].X = minX
		}
	case "right":
		maxRight := nodes[0].X + nodes[0].W
		for _, node := range nodes[1:] {
			maxRight = math.Max(maxRight, node.X+node.W)
		}
		for i := range after {
			after[i].X = maxRight - after[i].W
		}
	case "hcenter":
		sum := 0.0
		for _, node := range nodes {
			sum += node.X + node.W/2
		}
		center := sum / float64(len(nodes))
		for i := range after {
			after[i].X = center - after[i].W/2
		}
	case "top":
		minY := nodes[0].Y
		for _, node := range nodes[1:] {
			minY = math.Min(minY, node.Y)
		}
		for i := range after {
			after[i].Y = minY
		}
	case "bottom":
		maxBottom := nodes[0].Y + nodes[0].H
		for _, node := range nodes[1:] {
			maxBottom = math.Max(maxBottom, node.Y+node.H)
		}
		for i := range after {
			after[i].Y = maxBottom - after[i].H
		}
	case "vcenter":
		sum := 0.0
		for _, node := range nodes {
			sum += node.Y + node.H/2
		}
		center := sum / float64(len(nodes))
		for i := range after {
			after[i].Y = center - after[i].H/2
		}
	case "hdistribute":
		sortNodesBy(after, true)
		minLeft, maxRight, total := after[0].X, after[0].X+after[0].W, 0.0
		for _, node := range after {
			minLeft = math.Min(minLeft, node.X)
			maxRight = math.Max(maxRight, node.X+node.W)
			total += node.W
		}
		gap := (maxRight - minLeft - total) / float64(len(after)-1)
		cursor := minLeft
		for i := range after {
			after[i].X = cursor
			cursor += after[i].W + gap
		}
	case "vdistribute":
		sortNodesBy(after, false)
		minTop, maxBottom, total := after[0].Y, after[0].Y+after[0].H, 0.0
		for _, node := range after {
			minTop = math.Min(minTop, node.Y)
			maxBottom = math.Max(maxBottom, node.Y+node.H)
			total += node.H
		}
		gap := (maxBottom - minTop - total) / float64(len(after)-1)
		cursor := minTop
		for i := range after {
			after[i].Y = cursor
			cursor += after[i].H + gap
		}
	default:
		return
	}
	changes := make([]canvasNodeChange, 0, len(nodes))
	for i := range nodes {
		if nodes[i].X != after[i].X || nodes[i].Y != after[i].Y {
			changes = append(changes, canvasNodeChange{before: nodes[i], after: after[i]})
		}
	}
	a.updateCanvasNodes(changes, func(canvasID string) {
		a.pushCanvasHistory(canvasID, canvasHistory{changes: changes}, false)
		delete(a.cv.canvasRedo, canvasID)
	})
}

func sortNodesBy(nodes []conversation.CanvasNode, horizontal bool) {
	for i := 1; i < len(nodes); i++ {
		for j := i; j > 0; j-- {
			less := nodes[j].X < nodes[j-1].X
			if !horizontal {
				less = nodes[j].Y < nodes[j-1].Y
			}
			if !less {
				break
			}
			nodes[j], nodes[j-1] = nodes[j-1], nodes[j]
		}
	}
}

func (a *app) nudgeCanvasSelection(dx, dy float64) {
	nodes := a.selectedNodes()
	if len(nodes) == 0 || a.cv.canvasPending {
		return
	}
	changes := make([]canvasNodeChange, 0, len(nodes))
	for _, node := range nodes {
		after := node
		after.X += dx
		after.Y += dy
		changes = append(changes, canvasNodeChange{before: node, after: after})
	}
	a.updateCanvasNodes(changes, func(canvasID string) {
		a.pushCanvasHistory(canvasID, canvasHistory{changes: changes}, false)
		delete(a.cv.canvasRedo, canvasID)
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

// canvasStyleBar 是选中节点的语义样式条；多选时显示对齐/分布。
func (a *app) canvasStyleBar(c *ui.Context, t *ui.Theme) {
	nodes := a.selectedNodes()
	if len(nodes) == 0 {
		// 固定高度：选中时插入按钮不能改变绘制区位置，否则指针捕获会在重建时丢失。
		ui.Column(c).Height(92).Children(func() {
			ui.Text(c, a.tr("canvas.noSelection")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		})
		return
	}
	if len(nodes) > 1 {
		a.canvasMultiToolbar(c, t, nodes)
		return
	}
	node := nodes[0]
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

func (a *app) canvasMultiToolbar(c *ui.Context, t *ui.Theme, nodes []conversation.CanvasNode) {
	align := func(label string, mode string) {
		if ui.Button(c, "").Label(label).Tooltip(label).Clicked() {
			a.alignCanvasSelection(mode)
		}
	}
	ui.Column(c).Height(92).Gap(4).Children(func() {
		ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
			ui.Text(c, a.tr("canvas.selectedCount", "count", itoa(len(nodes)))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Width(64)
			align(a.tr("canvas.alignLeft"), "left")
			align(a.tr("canvas.alignRight"), "right")
			align(a.tr("canvas.alignCenterH"), "hcenter")
			align(a.tr("canvas.alignTop"), "top")
			align(a.tr("canvas.alignBottom"), "bottom")
			align(a.tr("canvas.alignCenterV"), "vcenter")
		})
		ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
			align(a.tr("canvas.distributeH"), "hdistribute")
			align(a.tr("canvas.distributeV"), "vdistribute")
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

// canvasInput 处理绘制区的指针与键盘。拖动过程只改本地副本，释放时才提交。
func (a *app) canvasInput(ev ui.InputEvent) bool {
	if ev.Kind == ui.InputKeyDown && a.cv.canvasEditing == "" {
		command := ev.Mods&(ui.Ctrl|ui.Super) != 0
		switch {
		case command && ev.Key == ui.KeyZ:
			if ev.Mods&ui.Shift != 0 {
				a.redoCanvas()
			} else {
				a.undoCanvas()
			}
			return true
		case command && ev.Key == ui.KeyC:
			a.copyCanvasSelection()
			return true
		case command && ev.Key == ui.KeyV:
			a.pasteCanvasClipboard()
			return true
		case command && ev.Key == ui.KeyD:
			a.duplicateCanvasSelection()
			return true
		case ev.Key == ui.KeyLeft || ev.Key == ui.KeyRight || ev.Key == ui.KeyUp || ev.Key == ui.KeyDown:
			step := 1.0
			if ev.Mods&ui.Shift != 0 {
				step = 10
			}
			switch ev.Key {
			case ui.KeyLeft:
				a.nudgeCanvasSelection(-step, 0)
			case ui.KeyRight:
				a.nudgeCanvasSelection(step, 0)
			case ui.KeyUp:
				a.nudgeCanvasSelection(0, -step)
			case ui.KeyDown:
				a.nudgeCanvasSelection(0, step)
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
		if len(a.cv.canvasSel) == 1 {
			_, node, single := a.selectedCanvas()
			if single {
				if rect, exists := a.cv.canvasGeom.nodeRects[node.ID]; exists {
					if handle, hit := handleAt(rect, ev.X, ev.Y); hit {
						a.cv.canvasDrag = &canvasDrag{
							kind: "resize", handle: handle, ids: []string{node.ID},
							before: map[string]conversation.CanvasNode{node.ID: node},
							startX: ev.X, startY: ev.Y,
						}
						return true
					}
				}
			}
		}
		node, hit := a.cv.canvasGeom.nodeAt(canvas, ev.X, ev.Y)
		if !hit {
			if ev.Mods&ui.Shift == 0 {
				a.cv.canvasSel = nil
			}
			a.cv.canvasDrag = &canvasDrag{kind: "marquee", startX: ev.X, startY: ev.Y}
			a.cv.canvasMarquee = &ui.Rect{X: ev.X, Y: ev.Y}
			return true
		}
		if ev.Mods&ui.Shift != 0 {
			a.toggleSelected(node.ID)
			return true
		}
		if !a.isSelected(node.ID) {
			a.selectOnly(node.ID)
		}
		if ev.Clicks >= 2 && len(a.cv.canvasSel) == 1 {
			a.startCanvasEdit()
			a.redraw()
			return true
		}
		ids := a.selectedIDs()
		before := map[string]conversation.CanvasNode{}
		for _, item := range canvas.Nodes {
			if a.isSelected(item.ID) {
				before[item.ID] = item
			}
		}
		a.cv.canvasDrag = &canvasDrag{kind: "move", ids: ids, before: before, startX: ev.X, startY: ev.Y}
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
		a.cv.canvasMarquee = nil
		if drag.kind == "marquee" {
			return true
		}
		if drag.moved {
			changes := make([]canvasNodeChange, 0, len(drag.ids))
			for _, id := range drag.ids {
				_, after, found := a.canvasNode(id)
				if found && drag.before[id].ID != "" {
					changes = append(changes, canvasNodeChange{before: drag.before[id], after: after})
				}
			}
			a.updateCanvasNodes(changes, func(canvasID string) {
				a.pushCanvasHistory(canvasID, canvasHistory{changes: changes}, false)
				delete(a.cv.canvasRedo, canvasID)
			})
		}
		return true
	}
	return false
}

func (a *app) canvasNode(id string) (conversation.Canvas, conversation.CanvasNode, bool) {
	canvas, ok := a.cv.canvases[a.cv.canvasID]
	if !ok {
		return conversation.Canvas{}, conversation.CanvasNode{}, false
	}
	for _, node := range canvas.Nodes {
		if node.ID == id {
			return canvas, node, true
		}
	}
	return canvas, conversation.CanvasNode{}, false
}

func (a *app) dragCanvasNode(ev ui.InputEvent) {
	drag := a.cv.canvasDrag
	geom := a.cv.canvasGeom
	if drag == nil || !geom.ok {
		return
	}
	if drag.kind == "marquee" {
		x0, y0 := drag.startX, drag.startY
		rect := ui.Rect{X: minF(x0, ev.X), Y: minF(y0, ev.Y), W: float32(math.Abs(float64(ev.X - x0))), H: float32(math.Abs(float64(ev.Y - y0)))}
		a.cv.canvasMarquee = &rect
		a.cv.canvasSel = map[string]bool{}
		for id, r := range geom.nodeRects {
			if rectsIntersect(rect, r) {
				a.cv.canvasSel[id] = true
			}
		}
		a.redraw()
		return
	}
	dx := float64((ev.X - drag.startX) / geom.scale)
	dy := float64((ev.Y - drag.startY) / geom.scale)
	if math.Abs(dx) < 0.01 && math.Abs(dy) < 0.01 {
		return
	}
	drag.moved = true
	alt := ev.Mods&ui.Alt != 0
	if drag.kind == "move" {
		first := drag.before[drag.ids[0]]
		// 以主节点吸附，其余节点用同一位移，保持相对位置。
		targetX := snap(first.X+dx, !alt)
		targetY := snap(first.Y+dy, !alt)
		shiftX, shiftY := targetX-first.X, targetY-first.Y
		for _, id := range drag.ids {
			node := drag.before[id]
			node.X += shiftX
			node.Y += shiftY
			a.setCanvasNodeLocal(id, node)
		}
	} else {
		node := drag.before[drag.ids[0]]
		left, top := node.X, node.Y
		right, bottom := node.X+node.W, node.Y+node.H
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
		a.setCanvasNodeLocal(node.ID, node)
	}
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
