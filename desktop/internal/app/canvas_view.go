package app

// 原生画布的只读展示：对话里的画布卡片、缩略图与全屏弹窗。
// 第一阶段只画文档，不接收编辑；绘制代码与文档坐标解耦，后续编辑沿用同一套渲染。

import (
	"context"
	"math"
	"strings"
	"time"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/icons"
	"github.com/egoist/mygo/ui"
)

// finishedCanvasCalls 数出已经完成的画布工具调用。它变了就说明画布文档可能变了。
func finishedCanvasCalls(messages []conversation.Message) int {
	n := 0
	for _, m := range messages {
		if m.Tool != nil && m.Done && (m.Tool.Name == "canvas_create" || m.Tool.Name == "canvas_get") {
			n++
		}
	}
	return n
}

// syncCanvases 在聊天状态更新后检查画布是否该重新读取。切换会话时 canvasCalls 复位成 -1，
// 因此即使还没跑过画布工具，也会读取一次已有的画布。
func (a *app) syncCanvases() {
	// 本地有未提交的手势或文字时，订阅/工具结果不能覆盖正在编辑的视图。
	if a.cv.canvasPending || a.cv.canvasDrag != nil || a.cv.canvasEditing != "" {
		return
	}
	if n := finishedCanvasCalls(a.chat.Messages); n != a.cv.canvasCalls {
		a.cv.canvasCalls = n
		a.loadCanvases()
	}
}

func (a *app) loadCanvases() {
	client, conv := a.client, a.conv
	if client == nil || conv == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		list, err := client.Canvases(ctx, conv)
		a.post(func() {
			if client != a.client || a.conv != conv || err != nil {
				return
			}
			canvases := make(map[string]conversation.Canvas, len(list))
			for _, item := range list {
				canvas := canvasFromService(item)
				canvases[canvas.ID] = canvas
			}
			a.cv.canvases = canvases
		})
	}()
}

// openCanvas 打开只读画布弹窗；文档还没到达时也先记下 id，等下一次状态更新。
func (a *app) openCanvas(ref conversation.CanvasRef) {
	a.cv.canvasID = ref.ID
	a.cv.canvasOpen = true
	a.cv.canvasSel, a.cv.canvasEditing, a.cv.canvasDraft = "", "", ""
	a.cv.canvasDrag, a.cv.canvasErr = nil, ""
}

// canvasCard 是对话工具结果下方的画布卡片：标题、缩略图与打开入口。
func (a *app) canvasCard(c *ui.Context, ref conversation.CanvasRef) {
	t := c.Theme()
	tok := a.tokens().Tok
	title := strings.TrimSpace(ref.Title)
	if title == "" {
		title = a.tr("canvas.untitled")
	}
	canvas, ok := a.cv.canvases[ref.ID]
	ui.Column(c).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder).Clip().Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(10, 12).Children(func() {
			ui.Icon(c, icons.Chart).TextColor(t.Accent)
			a.buffer(ui.Text(c, title)).Bold().SingleLine().Grow(1).MinWidth(0).Tooltip(title)
			if ui.Button(c, a.tr("canvas.open")).FontSize(a.fs(textCaption)).Clicked() {
				a.openCanvas(ref)
			}
		})
		preview := ui.Column(c).Height(170).Clip().Background(t.Background)
		if !ok {
			preview.Children(func() {
				ui.Spacer(c)
				ui.Text(c, a.tr("canvas.loading")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			})
		} else if len(canvas.Nodes) == 0 {
			preview.Children(func() {
				ui.Spacer(c)
				ui.Text(c, a.tr("canvas.empty")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			})
		} else {
			preview.Draw(func(p *ui.Painter, r ui.Rect) {
				drawCanvas(p, r, canvas, t, 8)
			})
		}
		ui.Row(c).Gap(6).AlignItems(ui.Center).Padding(7, 12).Children(func() {
			ui.Text(c, a.tr("canvas.meta", "nodes", itoa(len(canvas.Nodes)), "edges", itoa(len(canvas.Edges)), "revision", itoa(ref.Revision))).
				FontSize(a.fs(textCaption)).TextColor(t.TextMuted).SingleLine()
		})
	})
}

// canvasModal 是全屏画布：标题、样式条、可编辑的绘制区与错误提示。
func (a *app) canvasModal(c *ui.Context, t *ui.Theme) {
	if !a.cv.canvasOpen {
		return
	}
	canvas, ok := a.cv.canvases[a.cv.canvasID]
	title := canvas.Title
	if title == "" {
		title = a.tr("canvas.untitled")
	}
	width := a.contentWidth() * 0.9
	if width < 720 {
		width = 720
	}
	height := clampF(a.contentWidth()*0.55, 420, 760)
	ui.Modal(c, &a.cv.canvasOpen, func() {
		ui.Column(c).Width(width).Gap(8).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Icon(c, icons.Chart).TextColor(t.Accent)
				ui.Text(c, title).Bold().SingleLine().Grow(1).MinWidth(0).Tooltip(title)
				ui.Text(c, a.tr("canvas.revision", "revision", itoa(canvas.Revision))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
				if iconButton(c, icons.Close, a.tr("chat.close")).Clicked() {
					a.cv.canvasOpen = false
				}
			})
			if a.cv.canvasErr != "" {
				ui.Text(c, a.cv.canvasErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
			}
			a.canvasStyleBar(c, t)
			body := ui.Column(c).Height(height).Clip().Background(t.Background).BorderWidth(1).BorderColor(t.Border).Label(a.tr("canvas.surface")).Focusable().FocusRing(false)
			if a.cv.canvasEditing == "" {
				body.Focus()
			}
			switch {
			case !ok:
				body.Children(func() {
					ui.Spacer(c)
					ui.Text(c, a.tr("canvas.loading")).TextColor(t.TextMuted)
				})
			case len(canvas.Nodes) == 0:
				body.Children(func() {
					ui.Spacer(c)
					ui.Text(c, a.tr("canvas.empty")).TextColor(t.TextMuted)
				})
			default:
				body.Draw(func(p *ui.Painter, r ui.Rect) {
					geom := canvasGeometry(r, canvas, 24)
					if a.cv.canvasDrag != nil && a.cv.canvasGeom.ok {
						geom = a.cv.canvasGeom
					}
					a.cv.canvasGeom = geom
					drawCanvasScene(p, canvas, t, geom, a.cv.canvasSel)
				})
				body.HandleInput(a.canvasInput)
				if a.cv.canvasEditing != "" {
					a.canvasTextOverlay(c, t)
				}
			}
		})
	})
}

// drawCanvas 把文档按内容边界等比缩放后画进 r（缩略图用）。
func drawCanvas(p *ui.Painter, r ui.Rect, canvas conversation.Canvas, t *ui.Theme, padding float32) {
	drawCanvasScene(p, canvas, t, canvasGeometry(r, canvas, padding), "")
}

// drawCanvasScene 用给定的几何画连线与节点；选中框与手柄单独画在最上层。
func drawCanvasScene(p *ui.Painter, canvas conversation.Canvas, t *ui.Theme, g canvasGeom, selected string) {
	if !g.ok {
		return
	}
	byID := make(map[string]conversation.CanvasNode, len(canvas.Nodes))
	for _, node := range canvas.Nodes {
		byID[node.ID] = node
	}
	center := func(node conversation.CanvasNode) (float32, float32) {
		rect := g.nodeRects[node.ID]
		return rect.X + rect.W/2, rect.Y + rect.H/2
	}
	// 先画连线，节点覆盖在端点上。
	for _, edge := range canvas.Edges {
		from, okFrom := byID[edge.From]
		to, okTo := byID[edge.To]
		if !okFrom || !okTo {
			continue
		}
		x0, y0 := center(from)
		x1, y1 := center(to)
		width := float32(1.2)
		color := t.TextMuted
		if edge.Style.Border != "" && edge.Style.Border != "default" {
			color = roleColor(edge.Style.Border, t)
			width = 1.6
		}
		p.Line(x0, y0, x1, y1, width, color)
		if edge.Label != "" && g.scale > 0.45 {
			p.Text((x0+x1)/2, (y0+y1)/2-4, edge.Label, clampF(11*g.scale, 8, 13), t.TextMuted)
		}
	}
	for _, node := range canvas.Nodes {
		rect, ok := g.nodeRects[node.ID]
		if !ok || rect.W < 2 || rect.H < 2 {
			continue
		}
		fill, border := canvasColors(node.Style, t)
		switch node.Kind {
		case "ellipse":
			p.Fill(rect, fill, minF(rect.W, rect.H)/2)
			p.Stroke(rect, border, minF(rect.W, rect.H)/2, 1)
		case "diamond":
			var path ui.Path
			path.MoveTo(rect.X+rect.W/2, rect.Y).LineTo(rect.X+rect.W, rect.Y+rect.H/2).LineTo(rect.X+rect.W/2, rect.Y+rect.H).LineTo(rect.X, rect.Y+rect.H/2).Close()
			p.FillPath(&path, fill)
			p.StrokePath(&path, 1, border)
		default:
			radius := radiusCard * g.scale
			if node.Kind == "rect" {
				radius = 2
			}
			p.Fill(rect, fill, radius)
			p.Stroke(rect, border, radius, 1)
		}
		if node.Text != "" && g.scale > 0.35 {
			drawCanvasNodeText(p, rect, node, g.scale, t)
		}
	}
	if selected != "" {
		if rect, ok := g.nodeRects[selected]; ok {
			drawCanvasSelection(p, rect, t)
		}
	}
}

func drawCanvasNodeText(p *ui.Painter, rect ui.Rect, node conversation.CanvasNode, scale float32, t *ui.Theme) {
	size := float32(node.FontSize)
	if size <= 0 {
		size = 14
	}
	size = clampF(size*scale, 6, 24)
	lineHeight := size * 1.3
	x := rect.X + 7*scale
	y := rect.Y + size + 6*scale
	lines := wrapCanvasText(node.Text, rect.W-14*scale, size)
	for _, line := range lines {
		if y > rect.Y+rect.H-size/2 {
			break
		}
		p.Text(x, y, line, size, textColor(node.Style, t))
		y += lineHeight
	}
}

// wrapCanvasText 按字号粗略断行；CJK 字符按一个字号宽，其余按半宽。
func wrapCanvasText(text string, width, size float32) []string {
	if width <= 0 || size <= 0 {
		return nil
	}
	var out []string
	for _, raw := range strings.Split(text, "\n") {
		line, used := "", float32(0)
		for _, r := range raw {
			advance := size * 0.55
			if r > 0x2e80 {
				advance = size
			}
			if used+advance > width && line != "" {
				out = append(out, line)
				line, used = "", 0
			}
			line += string(r)
			used += advance
		}
		out = append(out, line)
	}
	return out
}

func drawCanvasSelection(p *ui.Painter, rect ui.Rect, t *ui.Theme) {
	p.Stroke(rect, t.Accent, 2, 1.5)
	handleFill := t.Background
	for _, handle := range handleRects(rect) {
		p.Fill(handle, handleFill, 0)
		p.Stroke(handle, t.Accent, 0, 1)
	}
}

func roleColor(role string, t *ui.Theme) ui.Color {
	switch role {
	case "accent":
		return t.Accent
	case "success":
		return t.Success
	case "warning":
		return t.Warning
	case "danger":
		return t.Danger
	case "muted":
		return t.TextMuted
	default:
		return t.Border
	}
}

func canvasColors(style conversation.CanvasStyle, t *ui.Theme) (ui.Color, ui.Color) {
	fillRole := func(role string) ui.Color {
		switch role {
		case "accent":
			return t.Accent
		case "success":
			return t.Success
		case "warning":
			return t.Warning
		case "danger":
			return t.Danger
		case "muted":
			return t.TextMuted
		default:
			return t.Surface
		}
	}
	borderRole := func(role string) ui.Color {
		switch role {
		case "accent", "success", "warning", "danger", "muted":
			return fillRole(role)
		default:
			return t.Border
		}
	}
	fill := fillRole(style.Fill)
	if style.Fill == "default" || style.Fill == "" {
		fill = t.Surface
	} else {
		fill = fill.Alpha(0.18)
	}
	return fill, borderRole(style.Border)
}

func textColor(style conversation.CanvasStyle, t *ui.Theme) ui.Color {
	switch style.Text {
	case "accent":
		return t.Accent
	case "success":
		return t.Success
	case "warning":
		return t.Warning
	case "danger":
		return t.Danger
	case "muted":
		return t.TextMuted
	default:
		return t.Text
	}
}

func truncateText(text string, width, size float32) string {
	// 粗略估算：CJK 按一个字号宽，ASCII 按 0.55；只用于缩略/弹窗，编辑阶段会换成真正的排版。
	runes := []rune(strings.ReplaceAll(text, "\n", " "))
	max := float32(math.Max(1, float64(width-12)))
	used := float32(0)
	for i, r := range runes {
		advance := size * 0.55
		if r > 0x2e80 {
			advance = size
		}
		if used+advance > max {
			return string(runes[:i]) + "…"
		}
		used += advance
	}
	return string(runes)
}

func isFiniteRect(minX, minY, maxX, maxY float64) bool {
	return !math.IsNaN(minX) && !math.IsNaN(minY) && !math.IsNaN(maxX) && !math.IsNaN(maxY) && !math.IsInf(minX, 0) && !math.IsInf(maxX, 0)
}

func minF(a, b float32) float32 {
	if a < b {
		return a
	}
	return b
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var digits [20]byte
	i := len(digits)
	for value > 0 {
		i--
		digits[i] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		i--
		digits[i] = '-'
	}
	return string(digits[i:])
}
