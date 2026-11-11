package app

// 图表与富内容的用例：从工具结果里认出图表与仪表盘、图表页的样式与高度、预览实例的复用
// 与隔离、切换会话与关闭窗口时释放、web view 不可用与文件缺失时的降级，以及
// dw-preview:// 处理器的路径与 MIME 规则。web view 本身不能在没有窗口的测试里创建，
// 所以用 preview.Host 替身隔离。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/preview"
	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

// fakeHost 记录创建了哪些 web view，但不真的建页面。
type fakeHost struct {
	available bool
	urls      []string
	scroll    []bool
	panes     []*fakePane
	err       error
}

func (h *fakeHost) Available() bool { return h.available }

func (h *fakeHost) New(rawURL string, scrollToContainer bool) (preview.Pane, error) {
	h.urls = append(h.urls, rawURL)
	h.scroll = append(h.scroll, scrollToContainer)
	if h.err != nil {
		return nil, h.err
	}
	pane := &fakePane{url: rawURL}
	h.panes = append(h.panes, pane)
	return pane, nil
}

// fakePane 是一块假页面：Element 永远返回 nil（没有真实窗口），只记录是否被销毁。
type fakePane struct {
	url       string
	failure   string
	destroyed bool
	evals     []string
}

func (p *fakePane) Element() ui.NativeWebView { return nil }
func (p *fakePane) Failure() string           { return p.failure }
func (p *fakePane) Destroy()                  { p.destroyed = true }
func (p *fakePane) Eval(js string)            { p.evals = append(p.evals, js) }

// richTestEnv 搭一个带替身宿主的 app 与媒体服务；vendor 是一个有 plotly 的假静态目录。
type richTestEnv struct {
	app   *app
	queue *uiQueue
	test  *ui.Tester
	host  *fakeHost
	media *preview.MediaServer
	dir   string
}

func newRichTest(t *testing.T) *richTestEnv {
	t.Helper()
	q := newQueue()
	a := newTestApp(t, q)
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "vendor"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "vendor", "plotly.min.js"), []byte("/* plotly */"), 0o644); err != nil {
		t.Fatal(err)
	}
	host := &fakeHost{available: true}
	a.rich.Host = host
	a.rich.Media = preview.NewMediaServer(dir)
	a.rich.Post = q.post
	tt := ui.NewTester(a.view, 1180, 760)
	return &richTestEnv{app: a, queue: q, test: tt, host: host, media: a.rich.Media, dir: dir}
}

// chartFile 写一个像 compute 落盘的图表页（引用旧网页的 /static/vendor）。
func chartFile(t *testing.T, dir, name string) string {
	t.Helper()
	file := filepath.Join(dir, name)
	html := `<!DOCTYPE html><html><head><title>Sales</title></head><body>` +
		`<div class="chart-wrap"><h1>Sales</h1><div class="plotly-graph-div" style="height:620px;width:100%"></div>` +
		`<script src='/static/vendor/plotly.min.js'></script><script>Plotly.newPlot("x",[{"x":["A"],"y":[1]}],{});</script>` +
		`</div><div class="desc"><strong>说明：</strong>按区域汇总</div></body></html>`
	if err := os.WriteFile(file, []byte(html), 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

// chatWithChart 让聊天里有一条带图表的工具结果。
func (e *richTestEnv) chatWithChart(t *testing.T) conversation.Chart {
	t.Helper()
	chart := conversation.Chart{ID: "chart-1", Title: "Sales by region", Type: "Bar_Chart", Path: chartFile(t, e.dir, "chart-1.html")}
	e.app.conv, e.app.nav = 1, navOf(1)
	e.app.chat = conversation.State{Conversation: 1, Messages: []conversation.Message{{
		Key: "m1", Role: "tool", Done: true,
		Tool: &conversation.ToolCall{CallID: "call_1", Name: "generate_chart", Args: `title=Sales`, Output: "Chart generated: Sales (Bar_Chart).", Status: "ok", Charts: []conversation.Chart{chart}},
	}}}
	return chart
}

// showArtifact 让数据面板显示「产物」页签并预览一个文件。面板只在服务就绪后出现，所以这里
// 给一个空的客户端（本用例不会发起请求）。
func (e *richTestEnv) showArtifact(art service.Artifact) {
	e.app.client = &service.Client{}
	e.app.src.open, e.app.src.split = true, 38
	e.app.src.tab = sourcesTabArtifacts
	e.app.src.conv, e.app.src.loaded = 1, true
	e.app.src.artifacts = []service.Artifact{art}
	e.app.src.artifactName = art.Name
	e.app.src.artifactLoaded = true
}

// TestToolResultExposesCharts 断言图表与仪表盘从工具结果的 details 里读出来：服务端把图表的
// HTML 落盘后 details 里给的是 path，旧消息里的内联 html 也保留。
func TestToolResultExposesCharts(t *testing.T) {
	tree := map[string]any{
		"conversation": map[string]any{"id": 7},
		"entries": []any{
			map[string]any{"id": 1, "kind": "pi.assistant", "byTaskId": 5, "model": []any{
				map[string]any{"role": "assistant", "content": []any{
					map[string]any{"type": "toolCall", "id": "call_chart", "name": "generate_chart", "arguments": map[string]any{"title": "Sales"}},
					map[string]any{"type": "toolCall", "id": "call_dash", "name": "generate_dashboard", "arguments": map[string]any{"name": "Ops"}},
				}},
			}},
			map[string]any{"id": 2, "kind": "pi.tool-result", "model": []any{
				map[string]any{"role": "toolResult", "toolCallId": "call_chart", "toolName": "generate_chart", "isError": false, "durationMs": 900,
					"content": []any{map[string]any{"type": "text", "text": "Chart generated: Sales (Bar_Chart)."}},
					"details": map[string]any{"tool": "generate_chart", "charts": []any{
						map[string]any{"id": "abc123", "title": "Sales", "chart_type": "Bar_Chart", "path": "/data/outputs/charts/abc123.html"},
					}}},
			}},
			map[string]any{"id": 3, "kind": "pi.tool-result", "model": []any{
				map[string]any{"role": "toolResult", "toolCallId": "call_dash", "toolName": "generate_dashboard", "isError": false, "durationMs": 120,
					"content": []any{map[string]any{"type": "text", "text": "Dashboard created."}},
					"details": map[string]any{"tool": "generate_dashboard", "dashboard_id": "dash-1"}},
			}},
		},
		"docs": map[string]any{"pi.live": map[string]any{}},
	}
	replica := &conversation.Replica{Tree: tree, Seq: 1}
	state := replica.State()
	if len(state.Messages) != 2 {
		t.Fatalf("rows: %d, want 2", len(state.Messages))
	}
	chart := state.Messages[0].Tool
	if len(chart.Charts) != 1 {
		t.Fatalf("charts: %+v", chart.Charts)
	}
	got := chart.Charts[0]
	if got.ID != "abc123" || got.Title != "Sales" || got.Type != "Bar_Chart" || got.Path != "/data/outputs/charts/abc123.html" {
		t.Errorf("chart: %+v", got)
	}
	if dash := state.Messages[1].Tool.DashboardID; dash != "dash-1" {
		t.Errorf("dashboard id: %q", dash)
	}

	// 内联 html（落盘失败或旧消息）也认。
	tree["entries"].([]any)[1].(map[string]any)["model"].([]any)[0].(map[string]any)["details"] = map[string]any{
		"charts": []any{map[string]any{"chart_id": "old", "title": "Legacy", "html": "<html></html>"}},
	}
	inline := (&conversation.Replica{Tree: tree, Seq: 1}).State().Messages[0].Tool.Charts
	if len(inline) != 1 || inline[0].HTML != "<html></html>" || inline[0].ID != "old" {
		t.Errorf("inline chart: %+v", inline)
	}
}

// TestChartHeightFollowsTheWidth 断言图表高度随可用宽度变化并有上下限；窗口变宽时图表不会
// 还是建图时的小画布。
func TestChartHeightFollowsTheWidth(t *testing.T) {
	narrow := chartHeight(400)
	wide := chartHeight(900)
	if wide <= narrow {
		t.Errorf("wide %v is not taller than narrow %v", wide, narrow)
	}
	if chartHeight(10) < 240 || chartHeight(5000) > 500 {
		t.Errorf("clamped heights: %v / %v", chartHeight(10), chartHeight(5000))
	}
	if chartHeight(5000) != roundDIP(chartHeight(5000)) || chartHeight(10) != roundDIP(chartHeight(10)) {
		t.Errorf("heights are not aligned to 8 DIP: %v / %v", chartHeight(10), chartHeight(5000))
	}
	if documentHeight(700) < chartHeight(700) {
		t.Error("a document preview should get at least a chart's height")
	}
}

// TestUnitChartIgnoresTheDataPanelWidth 断言数据面板展开时图表按剩下的宽度算高度。
func TestChatChartWidthAccountsForThePanel(t *testing.T) {
	a := &app{}
	full := a.chatChartWidth()
	a.src.open, a.src.split = true, 38
	half := a.chatChartWidth()
	if half >= full {
		t.Errorf("panel width %v is not narrower than %v", half, full)
	}
	if full > 760 {
		t.Errorf("chart width %v exceeds the message row", full)
	}
}

// TestChartPreviewIsReusedAcrossFrames 断言同一条消息重绘时复用同一个 web view，而不是每帧新建。
func TestChartPreviewIsReusedAcrossFrames(t *testing.T) {
	env := newRichTest(t)
	chart := env.chatWithChart(t)

	env.test.Frame()
	env.test.Frame()
	env.test.Frame()
	if len(env.host.urls) != 1 {
		t.Fatalf("web views: %d, want 1 (%v)", len(env.host.urls), env.host.urls)
	}
	if !strings.HasPrefix(env.host.urls[0], preview.Base+"/c/") {
		t.Errorf("chart url: %q", env.host.urls[0])
	}
	if !env.host.scroll[0] {
		t.Error("a chart in the message flow should scroll the conversation")
	}
	expectTexts(t, env.test, []string{"Sales by region", "Bar_Chart"}, nil)

	// 内容变化（标题变了）也还是同一个实例。
	env.app.chat.Messages[0].Tool.Charts = []conversation.Chart{{ID: chart.ID, Title: "Sales by region (v2)", Path: chart.Path}}
	env.test.Frame()
	if len(env.host.urls) != 1 {
		t.Fatalf("a redraw rebuilt the web view: %v", env.host.urls)
	}
}

// TestChatAndPanelGetTheirOwnWebViews 断言聊天与数据面板不共用实例（一个页面只能有一个宿主）。
func TestChatAndPanelGetTheirOwnWebViews(t *testing.T) {
	env := newRichTest(t)
	chart := env.chatWithChart(t)
	art := service.Artifact{Name: "chart-1.html", Path: chart.Path, Root: "exports"}

	env.test.Frame()
	if len(env.host.urls) != 1 {
		t.Fatalf("chat web views: %d", len(env.host.urls))
	}
	env.showArtifact(art)
	env.test.Frame()

	if len(env.host.urls) != 2 {
		t.Fatalf("the panel reused the chat's web view: %v", env.host.urls)
	}
	if !strings.HasPrefix(env.host.urls[1], preview.Base+"/a/") {
		t.Errorf("artifact url: %q", env.host.urls[1])
	}
	if env.app.rich.Len(preview.OwnerChat) != 1 || env.app.rich.Len(preview.OwnerPanel) != 1 {
		t.Errorf("owners: chat %d, panel %d", env.app.rich.Len(preview.OwnerChat), env.app.rich.Len(preview.OwnerPanel))
	}
}

// TestSessionSwitchReleasesWebViews 断言切换会话时聊天与面板的 web view 都被销毁，媒体登记项
// 也一起删掉。
func TestSessionSwitchReleasesWebViews(t *testing.T) {
	env := newRichTest(t)
	chart := env.chatWithChart(t)
	art := service.Artifact{Name: "chart-1.html", Path: chart.Path}

	env.test.Frame()
	env.showArtifact(art)
	env.test.Frame()
	if len(env.host.panes) != 2 {
		t.Fatalf("web views: %d, want 2", len(env.host.panes))
	}
	token := env.app.rich.Token(preview.OwnerChat, chart.ID)
	if token == "" {
		t.Fatal("the chat preview has no media token")
	}

	// 切会话会收起上一个会话的数据；这里不重新拉列表（客户端是替身），只看预览是否释放。
	env.app.src.open = false
	env.app.client = nil
	env.app.show(2)
	for i, pane := range env.host.panes {
		if !pane.destroyed {
			t.Errorf("web view %d survived the session switch: %s", i, pane.url)
		}
	}
	if env.app.rich.Len(preview.OwnerChat) != 0 || env.app.rich.Len(preview.OwnerPanel) != 0 {
		t.Errorf("previews left: chat %d, panel %d", env.app.rich.Len(preview.OwnerChat), env.app.rich.Len(preview.OwnerPanel))
	}
	kept := env.media.Has(token)
	if kept {
		t.Error("the chart document stayed registered after the switch")
	}
}

// TestCloseReleasesEverything 断言窗口关闭时释放所有预览（窗口本身也会带走它们，这里要的是
// 显式收尾：销毁 + 删除媒体登记项）。
func TestCloseReleasesEverything(t *testing.T) {
	env := newRichTest(t)
	chart := env.chatWithChart(t)
	env.test.Frame()
	env.app.rich.ReleaseAll()
	if len(env.host.panes) != 1 || !env.host.panes[0].destroyed {
		t.Errorf("panes after releaseAll: %+v", env.host.panes)
	}
	if env.app.rich.Len(preview.OwnerChat) != 0 {
		t.Errorf("chat previews: %d", env.app.rich.Len(preview.OwnerChat))
	}
	_ = chart
}

// TestChartWithoutWebViewDegrades 断言没有系统 web view 时图表降级成可读说明：原因、文件
// 路径，以及用系统浏览器打开的按钮。
func TestChartWithoutWebViewDegrades(t *testing.T) {
	env := newRichTest(t)
	env.host.available = false
	chart := env.chatWithChart(t)

	env.test.Frame()
	if len(env.host.urls) != 0 {
		t.Fatalf("a web view was created without an available system web view: %v", env.host.urls)
	}
	expectTexts(t, env.test, []string{"Chart preview is unavailable", "no system web view", chart.Path}, nil)
	if err := env.test.Click("Open in browser"); err != nil {
		t.Fatal(err)
	}
	opened := env.test.OpenedURLs()
	if len(opened) != 1 || opened[0] != preview.FileURL(chart.Path) {
		t.Errorf("opened %v, want %q", opened, preview.FileURL(chart.Path))
	}
}

// TestMissingChartFileDegrades 断言图表文件被删掉时不建 web view，而是说明文件缺失并给出路径。
func TestMissingChartFileDegrades(t *testing.T) {
	env := newRichTest(t)
	chart := env.chatWithChart(t)
	if err := os.Remove(chart.Path); err != nil {
		t.Fatal(err)
	}

	env.test.Frame()
	if len(env.host.urls) != 0 {
		t.Fatalf("web views: %v", env.host.urls)
	}
	expectTexts(t, env.test, []string{"Chart preview is unavailable", "the chart file is missing: " + chart.Path}, nil)
}

// TestChartNeedsTheBundledVendor 断言图表引用的 /static/vendor 不在时（没有随包静态资源）
// 走降级而不是显示一张空白页。
func TestChartNeedsTheBundledVendor(t *testing.T) {
	env := newRichTest(t)
	env.app.rich.Media = preview.NewMediaServer("") // 没有 static
	env.chatWithChart(t)

	env.test.Frame()
	if len(env.host.urls) != 0 {
		t.Fatalf("web views: %v", env.host.urls)
	}
	expectTexts(t, env.test, []string{"Chart preview is unavailable", "static/vendor"}, nil)
}

// TestLoadFailureFallsBack 断言页面加载失败后视图改成降级说明，而不是一直空着。
func TestLoadFailureFallsBack(t *testing.T) {
	env := newRichTest(t)
	env.chatWithChart(t)
	env.test.Frame()
	if len(env.host.panes) != 1 {
		t.Fatalf("web views: %d", len(env.host.panes))
	}
	env.host.panes[0].failure = "The page could not be loaded."
	env.test.Frame()
	expectTexts(t, env.test, []string{"Chart preview is unavailable", "The page could not be loaded."}, nil)
	// 点 Reload 重新建一个。
	if err := env.test.Click("Reload"); err != nil {
		t.Fatal(err)
	}
	env.test.Frame()
	if len(env.host.panes) != 2 {
		t.Errorf("reload created %d web views, want 2", len(env.host.panes))
	}
}

// TestDashboardLabelsStayDistinct 断言重名的仪表盘在下拉框里能分清。
func TestDashboardLabelsStayDistinct(t *testing.T) {
	list := []service.Dashboard{{ID: "d1", Name: "Sales"}, {ID: "d2", Name: "Sales"}, {ID: "d3", Name: "Ops"}}
	labels := dashboardLabels(list)
	if labels[0] == labels[1] {
		t.Errorf("duplicate labels: %v", labels)
	}
	if labels[2] != "Ops" {
		t.Errorf("unique labels changed: %v", labels)
	}
	if dashboardLabelOf(list, labels, "d2") != labels[1] {
		t.Error("the selected dashboard does not map to its label")
	}
	if dashboardLabelOf(list, labels, "") != "" {
		t.Error("no selection should map to an empty label")
	}
}

// TestArtifactPreviewFallsBackWhenTheFolderIsGone 断言产物目录消失时面板给出说明与路径，
// 而不是空白预览。
func TestArtifactPreviewFallsBackWhenTheFolderIsGone(t *testing.T) {
	env := newRichTest(t)
	dir := t.TempDir()
	file := filepath.Join(dir, "report.html")
	if err := os.WriteFile(file, []byte("<html>report</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	art := service.Artifact{Name: "report.html", Path: file, Root: "exports"}
	env.showArtifact(art)
	env.test.Frame()
	if len(env.host.urls) != 1 {
		t.Fatalf("artifact web views: %d", len(env.host.urls))
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	env.app.rich.ForgetKey(preview.OwnerPanel, file)
	env.test.Frame()
	expectTexts(t, env.test, []string{"Artifact preview is unavailable", "the artifact folder is missing"}, nil)
}
