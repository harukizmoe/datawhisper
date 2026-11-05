package preview

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

// fakeHost 记录创建了哪些 web view，但不真的建页面。
type fakeHost struct {
	available bool
	panes     []*fakePane
}

func (h *fakeHost) Available() bool { return h.available }

func (h *fakeHost) New(rawURL string, scrollToContainer bool) (Pane, error) {
	pane := &fakePane{url: rawURL}
	h.panes = append(h.panes, pane)
	return pane, nil
}

// fakePane 是一块假页面：只记录收到的脚本与是否被销毁。
type fakePane struct {
	url       string
	destroyed bool
	evals     []string
}

func (p *fakePane) Element() ui.NativeWebView { return nil }
func (p *fakePane) Failure() string           { return "" }
func (p *fakePane) Destroy()                  { p.destroyed = true }
func (p *fakePane) Eval(js string)            { p.evals = append(p.evals, js) }

// TestChartDocumentFillsTheWebView 断言图表页被压成一屏：注入的样式在 </head> 之前，
// 内嵌的 figure 数据原样保留，窗口尺寸变化时 Plotly 重新排布。
func TestChartDocumentFillsTheWebView(t *testing.T) {
	html := `<html><head><title>t</title></head><body><div class="plotly-graph-div"></div><script>Plotly.newPlot("x",[{"y":[1]}],{})</script></body></html>`
	doc := chartDocument(html)
	style := strings.Index(doc, "body>.chart-wrap{")
	head := strings.Index(doc, "</head>")
	if style < 0 || head < 0 || style > head {
		t.Fatalf("the fit style is not in the head: %d / %d", style, head)
	}
	if !strings.Contains(doc, `Plotly.newPlot("x",[{"y":[1]}],{})`) {
		t.Error("the figure data changed")
	}
	if !strings.Contains(doc, "window.addEventListener('resize'") {
		t.Error("no resize hook")
	}
	// 没有 head 的片段也能注入。
	if doc := chartDocument("<div>hi</div>"); !strings.HasPrefix(doc, "<style>") {
		t.Errorf("fragment: %q", doc[:20])
	}
	// 大小写的 </HEAD> 也算。
	if doc := chartDocument("<html><HEAD></HEAD><body></body></html>"); strings.Index(doc, "<style>") > strings.Index(doc, "</HEAD>") {
		t.Error("the style landed after the head")
	}
}

// TestArtifactPreviewURL 断言产物的预览 URL 可以还原出 token 与文件名，文件名里的空格与
// 非 ASCII 都被转义。
func TestArtifactPreviewURL(t *testing.T) {
	dir := t.TempDir()
	name := "季度 报告.html"
	file := filepath.Join(dir, name)
	if err := os.WriteFile(file, []byte("<html></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	media := NewMediaServer(dir)
	token, raw, err := media.AddArtifact(file)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != Scheme || parsed.Host != "localhost" {
		t.Errorf("url: %q", raw)
	}
	wantPath := "/a/" + token + "/" + name
	if parsed.Path != wantPath {
		t.Errorf("path: %q, want %q", parsed.Path, wantPath)
	}
	if !strings.Contains(parsed.EscapedPath(), "%20") {
		t.Errorf("the name is not escaped: %q", parsed.EscapedPath())
	}
	if _, ok := fileUnder(dir, name); !ok {
		t.Error("the file does not resolve under its folder")
	}
}

// TestMediaServerServesArtifactsAndVendor 断言 dw-preview:// 的处理器：产物按目录流式返回、
// 带正确的 MIME、拒绝越界路径与符号链接，随包的 /static/vendor 也能取到。
func TestMediaServerServesArtifactsAndVendor(t *testing.T) {
	root := t.TempDir()
	artDir := filepath.Join(root, "exports")
	if err := os.MkdirAll(artDir, 0o755); err != nil {
		t.Fatal(err)
	}
	report := filepath.Join(artDir, "report.html")
	if err := os.WriteFile(report, []byte("<html><link rel=stylesheet href=style.css></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(artDir, "style.css"), []byte("body{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(root, "secret.txt")
	if err := os.WriteFile(secret, []byte("top secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(artDir, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	static := filepath.Join(root, "static")
	if err := os.MkdirAll(filepath.Join(static, "vendor"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(static, "vendor", "plotly.min.js"), []byte("/* plotly */"), 0o644); err != nil {
		t.Fatal(err)
	}
	media := NewMediaServer(static)
	token, raw, err := media.AddArtifact(report)
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(raw)

	serve := func(target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		media.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		return rec
	}
	rec := serve(parsed.EscapedPath())
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<html>") {
		t.Fatalf("artifact: %d %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
		t.Errorf("html content type: %q", got)
	}
	if rec := serve("/a/" + token + "/style.css"); !strings.HasSuffix(rec.Header().Get("Content-Type"), "text/css; charset=utf-8") {
		t.Errorf("css content type: %q", rec.Header().Get("Content-Type"))
	}
	if rec := serve("/a/" + token + "/escape.txt"); rec.Code != http.StatusNotFound {
		t.Errorf("a symlink out of the folder was served: %d", rec.Code)
	}
	if rec := serve("/a/" + token + "/../secret.txt"); rec.Code != http.StatusNotFound {
		t.Errorf("a path out of the folder was served: %d", rec.Code)
	}
	if rec := serve("/a/unknown/file.html"); rec.Code != http.StatusNotFound {
		t.Errorf("an unknown token was served: %d", rec.Code)
	}
	if rec := serve("/static/vendor/plotly.min.js"); rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "text/javascript; charset=utf-8" {
		t.Errorf("vendor: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	if rec := serve("/static/vendor/../secret.txt"); rec.Code != http.StatusNotFound {
		t.Errorf("a path out of static was served: %d", rec.Code)
	}
	// 登记项删掉后同一 URL 不再可读。
	media.Remove(token)
	if rec := serve(parsed.EscapedPath()); rec.Code != http.StatusNotFound {
		t.Errorf("a removed artifact was still served: %d", rec.Code)
	}
}

// TestFileURL 断言本地路径变成可打开的 file URL，空格被转义。
func TestFileURL(t *testing.T) {
	got := FileURL("/tmp/my chart.html")
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "file" || parsed.Path != "/tmp/my chart.html" {
		t.Errorf("file url: %q", got)
	}
	if !strings.Contains(got, "%20") {
		t.Errorf("space not escaped: %q", got)
	}
	if FileURL("") != "" {
		t.Error("an empty path made a URL")
	}
}

// TestDashboardDocumentDropsTheOfflineCSP 断言仪表盘导出里的 CSP meta 被去掉，图表 iframe
// 才能加载本地 plotly；其它内容原样保留。
func TestDashboardDocumentDropsTheOfflineCSP(t *testing.T) {
	html := `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><style>body{}</style></head><body>dash</body></html>`
	doc := DashboardDocument(html)
	if strings.Contains(strings.ToLower(doc), "content-security-policy") {
		t.Errorf("the CSP meta survived: %q", doc)
	}
	if !strings.Contains(doc, "<style>body{}</style>") || !strings.Contains(doc, "dash") {
		t.Errorf("content changed: %q", doc)
	}
	if got := DashboardDocument("<html><body>none</body></html>"); got != "<html><body>none</body></html>" {
		t.Errorf("html without CSP changed: %q", got)
	}
}

// TestChartPagesGetTheTheme 验证图表页面拿到主题：登记后加载时注入此刻的主题，换主题时对已打开的页面执行脚本。
func TestChartPagesGetTheTheme(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "chart.html")
	if err := os.WriteFile(file, []byte("<html><head></head><body><div class=\"chart-wrap\"></div></body></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	host := &fakeHost{available: true}
	r := &Pool{Host: host, Post: func(fn func()) { fn() }, Media: NewMediaServer("")}
	light := map[string]any{"dark": false}
	r.ApplyTheme(light)
	pv := r.ChartPreview(Chart{ID: "c1", Path: file})
	if pv.Failure() != "" {
		t.Fatalf("preview failed: %s", pv.Failure())
	}
	body := fetchPreview(t, r.Media, host.panes[0].url)
	if !strings.Contains(body, `"dark":false`) || strings.Contains(body, chartThemePlaceholder) {
		t.Errorf("page does not carry the light theme")
	}

	dark := map[string]any{"dark": true}
	r.ApplyTheme(dark)
	evals := host.panes[0].evals
	if len(evals) != 1 || !strings.Contains(evals[0], "__dwApplyTheme") || !strings.Contains(evals[0], `"dark":true`) {
		t.Errorf("evals %q", evals)
	}
	// 重新加载的页面用的是新主题。
	if body := fetchPreview(t, r.Media, host.panes[0].url); !strings.Contains(body, `"dark":true`) {
		t.Error("a reloaded page kept the old theme")
	}
}

func fetchPreview(t *testing.T, m *MediaServer, rawURL string) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, strings.Replace(rawURL, Base, "http://localhost", 1), nil)
	rec := httptest.NewRecorder()
	m.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s: %d", rawURL, rec.Code)
	}
	return rec.Body.String()
}
