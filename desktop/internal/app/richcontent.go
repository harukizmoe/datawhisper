package app

// 图表与富内容的界面：聊天里的图表卡片、数据面板里的 HTML 产物预览、仪表盘查看器与画布入口。网页内容本身
// （web view 池、dw-preview:// 媒体服务、图表主题注入）在 internal/preview。

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/preview"
	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

// previewChart 把会话里的图表换成网页层要的参数。
func previewChart(ch conversation.Chart) preview.Chart {
	return preview.Chart{ID: ch.ID, Path: ch.Path, HTML: ch.HTML}
}

// chartHeight 给图表一个随宽度变化的高度（16:10 加一行说明，夹在 260–500 DIP）。web view
// 的宽度由容器拉伸，高度只能在这里算：旧图表页自己的高度是给网页写的固定值。
func chartHeight(width float32) float32 {
	if width <= 0 {
		width = 760
	}
	return roundDIP(clampF(width*0.68, 260, 500))
}

// documentHeight 给文档型页面（产物预览、仪表盘）一个更高一些的高度（4:3）。
func documentHeight(width float32) float32 {
	if width <= 0 {
		width = 720
	}
	return roundDIP(clampF(width*0.75, 280, 520))
}

func clampF(v, lo, hi float32) float32 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// roundDIP 把高度对齐到 8 DIP：布局里的半像素在这类整块元素上没有好处。
func roundDIP(v float32) float32 {
	return float32(int(v/8)) * 8
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

// webPreview 把一块网页内容画进当前布局，高度由调用方按可用宽度算。不可用时画降级说明
// （原因、文件路径、用系统浏览器打开的按钮），返回是否画出了 web view。
func (a *app) webPreview(c *ui.Context, pv *preview.Preview, height float32, what, filePath string) bool {
	if reason := pv.Failure(); reason != "" {
		a.previewFallback(c, what, reason, filePath)
		return false
	}
	element := pv.Element()
	if element == nil {
		return false
	}
	t := c.Theme()
	ui.WebView(c, element).Height(height).Radius(8).Border(1, t.Border)
	return true
}

// previewFallback 是网页内容不可用时的一行说明：为什么不能显示、文件在哪、怎么打开。
func (a *app) previewFallback(c *ui.Context, what, reason, filePath string) {
	t := c.Theme()
	ui.Column(c).Gap(6).Padding(10).Radius(8).Background(t.Surface).BorderWidth(1).BorderColor(t.Border).Children(func() {
		ui.Text(c, what+" preview is unavailable").FontSize(a.fs(textCaption)).Bold()
		ui.Text(c, reason).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		if filePath == "" {
			return
		}
		ui.Text(c, filePath).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Selectable().SingleLine().Tooltip(filePath)
		if ui.Button(c, "Open in browser").FontSize(a.fs(textCaption)).Tooltip("Open this file with the system's browser").Clicked() {
			c.OpenURL(preview.FileURL(filePath))
		}
	})
}

// chartCard 在聊天里展示一张图表：标题行加 web view。窗口尺寸变化时视图重建，宽度与高度
// 一起更新，Plotly 在新视口里重排。
func (a *app) chartCard(c *ui.Context, ch conversation.Chart) {
	t := c.Theme()
	pv := a.rich.ChartPreview(previewChart(ch))
	title := ch.Title
	if title == "" {
		title = "Chart"
	}
	tok := a.tokens().Tok
	ui.Column(c).Gap(6).Padding(10).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, icons.Chart).TextColor(t.TextMuted)
			ui.Text(c, title).FontSize(a.fs(textCaption)).Bold().SingleLine().Grow(1).MinWidth(0).Tooltip(title)
			if ch.Type != "" {
				ui.Badge(c, ch.Type)
			}
			if pv.Failure() != "" {
				if ui.Button(c, "Reload").FontSize(a.fs(textCaption)).Tooltip("Load the chart again").Clicked() {
					a.rich.Forget(pv)
				}
			}
			if iconButton(c, icons.Maximize, a.tr("chat.fullScreen")).Clicked() {
				a.openFullChart(ch)
			}
		})
		a.webPreview(c, pv, chartHeight(a.chatChartWidth()), "Chart", ch.Path)
	})
}

// artifactPreviewCard 在数据面板里预览一个 HTML/SVG 产物。
func (a *app) artifactPreviewCard(c *ui.Context, art service.Artifact) {
	a.rich.KeepOnly(preview.OwnerPanel, art.Path)
	pv := a.rich.ArtifactPreview(art.Path)
	ui.Column(c).Gap(6).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "Preview: "+art.Name).FontSize(a.fs(textCaption)).Bold().SingleLine().Grow(1).MinWidth(0).Tooltip(art.Name)
			if ui.Button(c, "Open").FontSize(a.fs(textCaption)).Tooltip("Open " + art.Name + " in the system's browser").Clicked() {
				c.OpenURL(preview.FileURL(art.Path))
			}
			if pv.Failure() != "" {
				if ui.Button(c, "Reload").FontSize(a.fs(textCaption)).Tooltip("Load the preview again").Clicked() {
					a.rich.Forget(pv)
				}
			}
		})
		a.webPreview(c, pv, documentHeight(a.panelWidth()), "Artifact", art.Path)
	})
}

// htmlArtifact 判断产物是否能交给 web view 显示（HTML 与 SVG）。
func htmlArtifact(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".html", ".htm", ".svg":
		return true
	}
	return false
}

// showHTMLArtifact 让数据面板用 web view 预览一个 HTML/SVG 产物；重新点击会重新加载，
// 因为文件可能已经被 agent 改写。
func (a *app) showHTMLArtifact(art service.Artifact) {
	a.src.artifactName = art.Name
	a.src.artifactText, a.src.artifactErr, a.src.artifactLoaded = "", "", true
	a.rich.ForgetKey(preview.OwnerPanel, art.Path)
}

// diagramFile 判断产物是不是 drawio 的图（.drawio 与 .canvas）。
func diagramFile(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".drawio", ".canvas":
		return true
	}
	return false
}

// chatChartWidth 是消息流里图表可用的宽度：窗口内容宽度减去侧边栏与消息列表内边距，
// 数据面板展开时再按分割比例扣掉它，最后受消息行 760 DIP 的上限约束。它只用来定高度，
// web view 本身横向拉伸。
func (a *app) chatChartWidth() float32 {
	width := a.contentWidth() - 240
	if a.src.open {
		split := a.src.split
		if split <= 0 {
			split = 38
		}
		width = width * (100 - split) / 100
	}
	return clampF(width-48-16, 280, 760)
}

// panelWidth 是数据面板里的可用宽度：按分割比例算，扣掉面板内边距。
func (a *app) panelWidth() float32 {
	split := a.src.split
	if split <= 0 {
		split = 38
	}
	width := (a.contentWidth() - 240) * split / 100
	return clampF(width-32, 240, 720)
}

// ---------------------------------------------------------------------------
// 仪表盘查看器
// ---------------------------------------------------------------------------

// dashState 是仪表盘查看器的界面状态。
type dashState struct {
	open      bool
	loading   bool
	err       string
	list      []service.Dashboard
	choice    string
	exporting bool
	exportErr string
	html      string
	htmlFor   string
	gen       int

	// 重命名：renaming 时标题行换成输入框。
	renaming   bool
	renameText string
}

// openDashboards 打开仪表盘查看器（数据面板的入口）。
func (a *app) openDashboards() {
	a.dash.open = true
	a.dash.err = ""
	switch {
	case len(a.dash.list) == 0:
		a.loadDashboards()
	case a.dash.choice == "":
		a.showDashboard(a.dash.list[0].ID)
	}
}

// openDashboard 打开某个仪表盘（聊天里 dashboard_id 的入口）。
func (a *app) openDashboard(id string) {
	a.dash.open = true
	a.dash.choice = id
	if len(a.dash.list) == 0 {
		a.loadDashboards()
	}
	a.showDashboard(id)
}

// loadDashboards 拉取仪表盘列表；仪表盘库不属于某个会话。
func (a *app) loadDashboards() {
	client := a.client
	if client == nil {
		a.dash.err = "The agent service is not ready."
		return
	}
	a.dash.loading = true
	a.dash.err = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		list, err := client.Dashboards(ctx)
		a.post(func() {
			if client != a.client {
				return
			}
			a.dash.loading = false
			if err != nil {
				a.dash.err = "Could not load the dashboards: " + err.Error()
				return
			}
			a.dash.list, a.dash.err = list, ""
			if a.dash.choice == "" && len(list) > 0 {
				a.showDashboard(list[0].ID)
			}
		})
	}()
}

// showDashboard 让查看器导出并显示一个仪表盘；旧预览先释放，导出的 HTML 到达后重建。
func (a *app) showDashboard(id string) {
	client := a.client
	if client == nil {
		a.dash.exportErr = "The agent service is not ready."
		return
	}
	a.dash.choice = id
	a.dash.exporting = true
	a.dash.exportErr = ""
	a.dash.gen++
	gen := a.dash.gen
	a.rich.ForgetKey(preview.OwnerModal, dashPreviewKey(id))
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, html, err := client.DashboardHTML(ctx, id)
		a.post(func() {
			if client != a.client || gen != a.dash.gen {
				return
			}
			a.dash.exporting = false
			if err != nil {
				a.dash.exportErr = sourceErrorText(err)
				return
			}
			a.dash.html, a.dash.htmlFor = html, id
			a.rich.ForgetKey(preview.OwnerModal, dashPreviewKey(id))
		})
	}()
}

func dashPreviewKey(id string) string { return "dashboard:" + id }

// dashboardPreview 画出导出好的仪表盘。
func (a *app) dashboardPreview(c *ui.Context, id string) {
	d := &a.dash
	a.rich.KeepOnly(preview.OwnerModal, dashPreviewKey(id))
	if d.exporting || d.htmlFor != id {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Spinner(c)
			ui.Text(c, "Exporting the dashboard…").FontSize(a.fs(textCaption)).TextColor(c.Theme().TextMuted)
		})
		return
	}
	pv := a.rich.Acquire(preview.OwnerModal, dashPreviewKey(id), true, func(m *preview.MediaServer) (string, string, error) {
		if d.html == "" {
			return "", "", errors.New("the dashboard export is empty")
		}
		token, rawURL := m.AddDoc("d", preview.DashboardDocument(d.html))
		return token, rawURL, nil
	})
	a.webPreview(c, pv, documentHeight(720), "Dashboard", "")
}

// dashboardsModal 是仪表盘查看器：列表、导出与只读预览。
func (a *app) dashboardsModal(c *ui.Context, t *ui.Theme) {
	d := &a.dash
	if !d.open {
		return // 弹窗的 web view 由 richModals 统一释放：全屏图表也用同一个宿主
	}
	ui.Modal(c, &d.open, func() {
		ui.Column(c).Width(764).Gap(10).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, "Dashboards").Bold().FontSize(a.fs(textSection))
				ui.Spacer(c)
				if d.loading || d.exporting {
					ui.Spinner(c)
				}
				if ui.Button(c, "Refresh").Tooltip("Reload the dashboard list").Clicked() {
					a.loadDashboards()
				}
				if ui.Button(c, "Close").Clicked() {
					d.open = false
				}
			})
			if d.err != "" {
				ui.Text(c, d.err).FontSize(a.fs(textCaption)).TextColor(t.Danger)
			}
			if len(d.list) == 0 {
				if !d.loading {
					ui.Text(c, "No dashboards yet: ask the agent to build one.").TextColor(t.TextMuted)
				}
				return
			}
			ui.Field(c, "Dashboard", func() {
				labels := dashboardLabels(d.list)
				choice := dashboardLabelOf(d.list, labels, d.choice)
				if ui.Select(c, &choice, labels).Label("Dashboard to view").Changed() {
					for i := range d.list {
						if labels[i] == choice {
							a.showDashboard(d.list[i].ID)
							return
						}
					}
				}
			})
			if d.choice != "" {
				a.dashboardActions(c, t)
			}
			if d.exportErr != "" {
				ui.Text(c, d.exportErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
			}
			if d.choice != "" {
				a.dashboardPreview(c, d.choice)
			}
		})
	})
}

// dashboardLabels 给下拉框一组不会撞车的名字：重名时补上 id，用户才能分清。
func dashboardLabels(list []service.Dashboard) []string {
	labels := make([]string, len(list))
	seen := map[string]int{}
	for i := range list {
		name := oneLine(strings.TrimSpace(list[i].Name), 48)
		if name == "" {
			name = list[i].ID
		}
		labels[i] = name
		seen[name]++
	}
	for i := range labels {
		if seen[labels[i]] > 1 {
			labels[i] += " (" + list[i].ID + ")"
		}
	}
	return labels
}

// dashboardLabelOf 返回当前选中的仪表盘在 labels 里的名字；没选中时返回空串。
func dashboardLabelOf(list []service.Dashboard, labels []string, id string) string {
	for i := range list {
		if list[i].ID == id {
			return labels[i]
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// 画布
// ---------------------------------------------------------------------------

// openCanvas 打开画布的只读入口：列出本会话产物里的 drawio 图。
func (a *app) openCanvas() { a.canvasOpen = true }

// canvasModal 是画布入口。旧界面用内嵌的 draw.io 编辑器渲染画布（static/drawio，147 MB，
// 配旧 Flask 前端的 postMessage 协议，而且画布项目存在那个前端自己的 store 里）；这个服务
// 没有画布 IPC，所以只读入口列出导出到产物的 .drawio/.canvas 文件，交给系统的 draw.io 打开。
func (a *app) canvasModal(c *ui.Context, t *ui.Theme) {
	if !a.canvasOpen {
		return
	}
	ui.Modal(c, &a.canvasOpen, func() {
		ui.Column(c).Width(640).Gap(10).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, "Canvas").Bold().FontSize(a.fs(textSection))
				ui.Spacer(c)
				if ui.Button(c, "Close").Clicked() {
					a.canvasOpen = false
				}
			})
			ui.Text(c, "The web build drew canvases with its own draw.io editor and stored them outside the agent service. This build lists the diagram files exported to this chat's artifacts and opens them with the app your system uses for draw.io.").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			var files []service.Artifact
			for _, art := range a.src.artifacts {
				if diagramFile(art.Name) {
					files = append(files, art)
				}
			}
			if len(files) == 0 {
				ui.Text(c, "No .drawio or .canvas file in this chat's artifacts.").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
				return
			}
			for _, art := range files {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(c, art.Name).Grow(1).MinWidth(0).SingleLine().Tooltip(art.Path)
					if ui.Button(c, "Open").FontSize(a.fs(textCaption)).Tooltip("Open " + art.Name + " with the system's draw.io").Clicked() {
						c.OpenURL(preview.FileURL(art.Path))
					}
				})
			}
		})
	})
}

// richModals 画图表与富内容自己的弹窗；与聊天弹窗并列画在窗口根上。
func (a *app) richModals(c *ui.Context) {
	t := c.Theme()
	a.dashboardsModal(c, t)
	a.fullChartModal(c, t)
	a.canvasModal(c, t)
	if !a.dash.open && !a.cv.fullOpen {
		a.rich.ReleaseModal()
	}
}

// openFullChart 全屏查看一张图表。
func (a *app) openFullChart(ch conversation.Chart) {
	a.dash.open = false
	a.cv.fullChart, a.cv.fullOpen = ch, true
}

// fullChartModal 是全屏图表：占窗口大部分的弹窗，图表可交互；同样提供在浏览器里打开原文件。
func (a *app) fullChartModal(c *ui.Context, t *ui.Theme) {
	if !a.cv.fullOpen {
		return
	}
	ch := a.cv.fullChart
	width := a.contentWidth() * 0.85
	if width < 480 {
		width = 480
	}
	height := roundDIP(clampF(width*0.6, 360, 820))
	title := ch.Title
	if title == "" {
		title = a.tr("chat.chart")
	}
	ui.Modal(c, &a.cv.fullOpen, func() {
		ui.Column(c).Width(width).Gap(10).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Icon(c, icons.Chart).TextColor(t.TextMuted)
				ui.Text(c, title).Bold().SingleLine().Grow(1).MinWidth(0).Tooltip(title)
				if ch.Path != "" && ui.Button(c, a.tr("chat.openInBrowser")).Clicked() {
					c.OpenURL(preview.FileURL(ch.Path))
				}
				if iconButton(c, icons.Close, a.tr("chat.close")).Clicked() {
					a.cv.fullOpen = false
				}
			})
			a.webPreview(c, a.rich.FullChartPreview(previewChart(ch)), height, "Chart", ch.Path)
		})
	})
}

// dashboardActions 是选中仪表盘的操作：重命名与删除（删除的是仪表盘文件，不影响它引用的数据）。
func (a *app) dashboardActions(c *ui.Context, t *ui.Theme) {
	d := &a.dash
	id := d.choice
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		if d.renaming {
			in := ui.TextInput(c, &d.renameText).Label(a.tr("dash.name")).AutoFocus().Grow(1).MinWidth(0)
			if ui.PrimaryButton(c, a.tr("know.save")).Clicked() || in.Submitted() {
				a.dashboardCall(func(ctx context.Context, cl *service.Client) error {
					return cl.RenameDashboard(ctx, id, strings.TrimSpace(d.renameText))
				})
				d.renaming = false
			}
			if ui.Button(c, a.tr("sidebar.cancel")).Clicked() {
				d.renaming = false
			}
			return
		}
		ui.Spacer(c)
		if iconTextButton(c, icons.Pencil, a.tr("chat.rename")).Clicked() {
			d.renaming = true
			for _, item := range d.list {
				if item.ID == id {
					d.renameText = item.Name
				}
			}
		}
		if iconTextButton(c, icons.Trash, a.tr("sidebar.delete")).Clicked() {
			a.dashboardCall(func(ctx context.Context, cl *service.Client) error {
				return cl.RemoveDashboard(ctx, id)
			})
			d.choice = ""
			a.rich.ReleaseModal()
		}
	})
}

// dashboardCall 在后台改一个仪表盘，完成后重新加载列表。
func (a *app) dashboardCall(fn func(ctx context.Context, c *service.Client) error) {
	client := a.client
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		err := fn(ctx, client)
		a.post(func() {
			if err != nil {
				a.dash.err = sourceErrorText(err)
				return
			}
			a.loadDashboards()
		})
	}()
}
