package service

import "context"

// Dashboard 是 dashboard.list 中的一项：仪表盘库（<数据目录>/outputs/Dashboard/*.json）里的
// id、名字、时间与 widget 数。查看器用 dashboard.exportHtml 拿到可离线打开的自包含 HTML。
type Dashboard struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
	WidgetCount int    `json:"widget_count"`
}

// Dashboards 列出本机的仪表盘；仪表盘库不属于某个会话。
func (c *Client) Dashboards(ctx context.Context) ([]Dashboard, error) {
	var out struct {
		Dashboards []Dashboard `json:"dashboards"`
	}
	err := c.callInto(ctx, "dashboard.list", nil, &out)
	return out.Dashboards, err
}

// DashboardHTML 由 compute 导出仪表盘 HTML，服务端已把外链资源去掉并注入 CSP，结果可离线打开。
// 返回文件名与 HTML 正文（几十 KB 量级）。
func (c *Client) DashboardHTML(ctx context.Context, id string) (name, html string, err error) {
	var out struct {
		Filename string `json:"filename"`
		HTML     string `json:"html"`
	}
	err = c.callInto(ctx, "dashboard.exportHtml", map[string]any{"id": id}, &out)
	return out.Filename, out.HTML, err
}

// RenameDashboard 改仪表盘的名字。
func (c *Client) RenameDashboard(ctx context.Context, id, name string) error {
	return c.callInto(ctx, "dashboard.update", map[string]any{"id": id, "name": name}, nil)
}

// RemoveDashboard 删除仪表盘文件；已经不存在时也不报错。
func (c *Client) RemoveDashboard(ctx context.Context, id string) error {
	return c.callInto(ctx, "dashboard.remove", map[string]any{"id": id}, nil)
}
