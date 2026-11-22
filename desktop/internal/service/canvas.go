package service

import "context"

// CanvasStyle 是节点/连线的语义色角色；界面按当前主题解析成颜色。
type CanvasStyle struct {
	Fill   string `json:"fill"`
	Border string `json:"border"`
	Text   string `json:"text"`
}

// CanvasNode 是画布上的一个节点，坐标与尺寸使用画布文档坐标。
type CanvasNode struct {
	ID       string      `json:"id"`
	Kind     string      `json:"kind"`
	X        float64     `json:"x"`
	Y        float64     `json:"y"`
	W        float64     `json:"w"`
	H        float64     `json:"h"`
	Text     string      `json:"text"`
	Parent   string      `json:"parent"`
	Pinned   bool        `json:"pinned"`
	Style    CanvasStyle `json:"style"`
	FontSize float64     `json:"fontSize"`
}

// CanvasEdge 是两个节点之间的连线。
type CanvasEdge struct {
	ID     string      `json:"id"`
	From   string      `json:"from"`
	To     string      `json:"to"`
	Route  string      `json:"route"`
	Arrow  string      `json:"arrow"`
	Dashed bool        `json:"dashed"`
	Label  string      `json:"label"`
	Style  CanvasStyle `json:"style"`
}

// Canvas 是会话里的一张完整画布文档。
type Canvas struct {
	ID         string       `json:"id"`
	Title      string       `json:"title"`
	Revision   int          `json:"revision"`
	TemplateID string       `json:"template_id"`
	Nodes      []CanvasNode `json:"nodes"`
	Edges      []CanvasEdge `json:"edges"`
	UpdatedAt  string       `json:"updated_at"`
}

// Canvases 读出会话 conv 的全部画布。画布不在订阅视图里，所以切换会话与画布工具完成后重新读取。
func (c *Client) Canvases(ctx context.Context, conv int) ([]Canvas, error) {
	var out struct {
		Canvases []Canvas `json:"canvases"`
	}
	err := c.callInto(ctx, "canvas.list", map[string]any{"conversationId": conv}, &out)
	return out.Canvases, err
}

// ApplyCanvas 原子提交一批画布操作；baseRevision 过期时返回匹配 ErrCanvasConflict 的错误。
func (c *Client) ApplyCanvas(ctx context.Context, conv int, canvasID string, baseRevision int, ops []map[string]any) (Canvas, error) {
	var out struct {
		Canvas Canvas `json:"canvas"`
	}
	err := c.callInto(ctx, "canvas.apply", map[string]any{
		"conversationId": conv,
		"canvasId":       canvasID,
		"baseRevision":   baseRevision,
		"ops":            ops,
	}, &out)
	return out.Canvas, err
}
