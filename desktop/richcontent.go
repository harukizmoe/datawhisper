package main

// P7.2 图表与富内容：把聊天里的图表、数据面板里的 HTML 产物、仪表盘查看器嵌入原生窗口，
// 并为画布文件提供只读入口。
//
// 网页内容的来源有两种：服务端落盘的图表 HTML（它引用旧网页的 /static/vendor/*），以及
// 产物目录里的文件。两者都经过 dw-preview:// 这个自定义 scheme 交给 web view：同一个
// 页面里 /static/vendor/plotly.min.js 因此能找到随包的静态资源，而文件只通过一次性 token
// 暴露，页面不能凭 URL 读任意路径。
//
// 生命周期：一个 web view 只能挂在一个宿主上，所以聊天、数据面板、弹窗各有自己的实例表；
// 同一 key 重绘时复用同一个实例，切换会话、换预览目标与关闭窗口时销毁。没有窗口的测试
// 通过 previewHost 替身断言创建与销毁，不会真的建 web view。

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"datawhisper/desktop/internal/api"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// debugPreviews 打开 dw-preview:// 的请求日志（DW_PREVIEW_DEBUG=1），定位空白页面用。
var debugPreviews = os.Getenv("DW_PREVIEW_DEBUG") != ""

// previewScheme 是桌面应用自己的网页来源；图表与产物都从这里加载。
const previewScheme = "dw-preview"

// previewBase 是 scheme 的 origin 部分：页面与它的绝对路径资源共用一个 origin。
const previewBase = previewScheme + "://localhost"

// maxChartBytes 是改写图表页面（注入铺满视口的样式）的大小上限。超过它的图表原样从
// 磁盘流给 web view：几十 KB 之外的 HTML 只可能是内联了整个 plotly bundle。
const maxChartBytes = 4 << 20

// previewOwner 是一块网页内容的宿主。
type previewOwner int

const (
	ownerChat previewOwner = iota
	ownerPanel
	ownerModal
	ownerCount
)

// maxPreviews 是每个宿主保留的 web view 上限：聊天里滚过去的图表如果都留着，长会话会攒下
// 几十个页面。超出时释放最久没画的那个，重绘到它时再建。
var maxPreviews = [ownerCount]int{6, 1, 1}

// ---------------------------------------------------------------------------
// 预览宿主：生产用窗口，测试用替身
// ---------------------------------------------------------------------------

// previewHost 创建 web view。生产实现是 windowHost（mygo.Window 的 Content），测试替身
// 只记录创建与销毁。
type previewHost interface {
	// Available 报告这台机器上有没有可用的系统 web view。
	Available() bool
	// New 创建一个加载 url 的 web view；scrollToContainer 让滚轮滚外层原生列表。
	New(url string, scrollToContainer bool) (previewPane, error)
}

// previewPane 是一块已创建的网页内容。
type previewPane interface {
	// Element 返回 ui.WebView 要的原生视图；测试替身返回 nil（没有真实窗口）。
	Element() ui.NativeWebView
	// Failure 报告页面加载失败的原因；空表示没有失败。
	Failure() string
	// Destroy 关闭页面并释放它的资源。
	Destroy()
}

// windowHost 在主窗口的 Content 上建 web view。
type windowHost struct {
	win     *mygo.Window
	changed func(func())
}

func (h windowHost) Available() bool { return h.win != nil && mygo.WebViewAvailable() }

func (h windowHost) New(rawURL string, scrollToContainer bool) (previewPane, error) {
	if h.win == nil {
		return nil, errors.New("no window")
	}
	view, err := h.win.NewWebView(mygo.WebViewOptions{
		URL:  rawURL,
		Page: mygo.PageOptions{Untrusted: true},
		// 图表与产物是 agent 生成的页面：不给它们绑定方法，只当普通网页显示。
		ScrollToContainer: scrollToContainer,
	})
	if err != nil {
		return nil, err
	}
	pane := &htmlPane{view: view, changed: h.changed}
	view.Page().OnDidFailLoad(func(e *mygo.LoadError) { pane.fail(e) })
	return pane, nil
}

// htmlPane 是 mygo.WebView 的包装：把加载失败记下来，让视图改用降级说明。
type htmlPane struct {
	view    *mygo.WebView
	changed func(func())

	mu      sync.Mutex
	failure string
}

func (p *htmlPane) Element() ui.NativeWebView { return p.view }

func (p *htmlPane) Failure() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.failure
}

func (p *htmlPane) Destroy() { p.view.Destroy() }

func (p *htmlPane) fail(e *mygo.LoadError) {
	reason := e.Description
	if reason == "" {
		reason = e.Error()
	}
	p.mu.Lock()
	p.failure = reason
	p.mu.Unlock()
	if p.changed != nil {
		p.changed(func() {}) // 重绘一帧，视图改用降级说明
	}
}

// ---------------------------------------------------------------------------
// 预览状态
// ---------------------------------------------------------------------------

// preview 是一块网页内容的显示状态。pane 为 nil 且 err 非空时视图画降级说明。
type preview struct {
	owner previewOwner
	key   string
	pane  previewPane
	token string
	err   string
	used  int
	known bool // 已登记在这个宿主的表里（forget 用）
}

// failure 返回不能显示这块内容的原因。
func (p *preview) failure() string {
	if p == nil {
		return "The preview is not available."
	}
	if p.err != "" {
		return p.err
	}
	if p.pane != nil {
		return p.pane.Failure()
	}
	return ""
}

// element 返回要放进 ui.WebView 的原生视图；没有时返回 nil。
func (p *preview) element() ui.NativeWebView {
	if p == nil || p.pane == nil {
		return nil
	}
	return p.pane.Element()
}

// ownerPreviews 是一个宿主的实例表。
type ownerPreviews struct {
	views map[string]*preview
	tick  int
}

// richContent 是图表与富内容的网页层。它的零值可用：没有 host 时一律走降级分支，所以
// 没有窗口的测试可以照常构建视图。
type richContent struct {
	host  previewHost
	post  func(func())
	media *mediaServer

	owners [ownerCount]ownerPreviews

	dash       dashState
	canvasOpen bool
}

// mediaServer 懒初始化：它要找到随包的静态资源，在没有窗口的测试里不该发生。
func (r *richContent) mediaServer() *mediaServer {
	if r.media == nil {
		r.media = newMediaServer(findStaticDir())
	}
	return r.media
}

func (r *richContent) removeMedia(token string) {
	if token == "" {
		return
	}
	if r.media != nil {
		r.media.remove(token)
	}
}

// acquire 返回（必要时创建）owner 下 key 对应的预览。同一个 key 复用同一个 web view；
// 创建失败或系统没有 web view 时返回带说明的预览，并由视图画降级说明。
func (r *richContent) acquire(owner previewOwner, key string, scrollToContainer bool, build func(*mediaServer) (token, url string, err error)) *preview {
	set := &r.owners[owner]
	if set.views == nil {
		set.views = map[string]*preview{}
	}
	set.tick++
	if pv, ok := set.views[key]; ok {
		pv.used = set.tick
		return pv
	}
	pv := &preview{owner: owner, key: key, used: set.tick, known: true}
	set.views[key] = pv
	if r.host == nil || !r.host.Available() {
		pv.err = "This build has no system web view (WebKitGTK 4.1), so the page cannot be shown."
		return pv
	}
	token, rawURL, err := build(r.mediaServer())
	if err != nil {
		pv.err = err.Error()
		return pv
	}
	pane, err := r.host.New(rawURL, scrollToContainer)
	if err != nil {
		r.removeMedia(token)
		pv.err = "The web view could not be created: " + err.Error()
		return pv
	}
	pv.pane, pv.token = pane, token
	r.evict(owner)
	return pv
}

// evict 在宿主超过上限时释放最久没画的一个页面；带错误的条目没有页面，不参与。
func (r *richContent) evict(owner previewOwner) {
	set := &r.owners[owner]
	limit := maxPreviews[owner]
	for limit > 0 && len(set.views) > limit {
		oldestKey, oldest := "", 0
		for key, pv := range set.views {
			if pv.pane == nil {
				continue
			}
			if oldestKey == "" || pv.used < oldest {
				oldestKey, oldest = key, pv.used
			}
		}
		if oldestKey == "" {
			return
		}
		r.destroy(set.views[oldestKey])
		delete(set.views, oldestKey)
	}
}

func (r *richContent) destroy(pv *preview) {
	if pv == nil {
		return
	}
	if pv.pane != nil {
		pv.pane.Destroy()
		pv.pane = nil
	}
	r.removeMedia(pv.token)
	pv.token = ""
}

// forget 释放一个预览，下一帧按同一 key 重新创建（加载失败后的 Reload）。
func (r *richContent) forget(pv *preview) {
	if pv == nil || !pv.known {
		return
	}
	set := &r.owners[pv.owner]
	r.destroy(pv)
	delete(set.views, pv.key)
}

// forgetKey 释放宿主下某个 key 的预览（重新导出仪表盘时用）。
func (r *richContent) forgetKey(owner previewOwner, key string) {
	set := &r.owners[owner]
	if pv, ok := set.views[key]; ok {
		r.destroy(pv)
		delete(set.views, key)
	}
}

// releaseOwner 销毁宿主的所有页面。切换会话、关闭弹窗与窗口关闭时调用。
func (r *richContent) releaseOwner(owner previewOwner) {
	set := &r.owners[owner]
	for key, pv := range set.views {
		r.destroy(pv)
		delete(set.views, key)
	}
}

func (r *richContent) releaseChat()  { r.releaseOwner(ownerChat) }
func (r *richContent) releasePanel() { r.releaseOwner(ownerPanel) }
func (r *richContent) releaseModal() { r.releaseOwner(ownerModal) }

// releaseAll 释放所有页面；窗口关闭时调用（窗口本身也会带走它们，这里是显式收尾）。
func (r *richContent) releaseAll() {
	for owner := previewOwner(0); owner < ownerCount; owner++ {
		r.releaseOwner(owner)
	}
}

// keepOnly 释放宿主下除 key 以外的预览：数据面板一次只显示一个产物预览，仪表盘查看器
// 一次只显示一个仪表盘。
func (r *richContent) keepOnly(owner previewOwner, key string) {
	set := &r.owners[owner]
	for k, pv := range set.views {
		if k == key {
			continue
		}
		r.destroy(pv)
		delete(set.views, k)
	}
}

// chartPreview 返回聊天里一张图的预览：同一张图（按 id，其次按文件路径）在重绘之间复用。
func (r *richContent) chartPreview(ch api.Chart) *preview {
	key := ch.ID
	if key == "" {
		key = ch.Path
	}
	if key == "" {
		return &preview{err: "This tool result has no chart to show."}
	}
	return r.acquire(ownerChat, key, true, func(m *mediaServer) (string, string, error) {
		return m.addChart(ch)
	})
}

// artifactPreview 返回数据面板里一个 HTML/SVG 产物的预览。
func (r *richContent) artifactPreview(art api.Artifact) *preview {
	if art.Path == "" {
		return &preview{err: "This artifact has no file path."}
	}
	return r.acquire(ownerPanel, art.Path, false, func(m *mediaServer) (string, string, error) {
		return m.addArtifact(art.Path)
	})
}

// ---------------------------------------------------------------------------
// dw-preview:// 的处理器
// ---------------------------------------------------------------------------

// mediaServer 把图表页面、产物文件与仪表盘导出交给 web view。路径与 token：
//
//	/c/<token>.html          登记过的图表页面（已注入铺满视口的样式）
//	/d/<token>.html          登记过的仪表盘导出
//	/f/<token>               登记过的大文件（原样流式返回）
//	/a/<token>/<name>        产物目录里的文件；同名目录里的样式、图片仍能加载
//	/static/vendor/<name>    随包的 plotly / echarts / d3
type mediaServer struct {
	mu     sync.RWMutex
	docs   map[string]string
	files  map[string]string
	dirs   map[string]string
	static string // 随包的 static 目录；空表示缺失
}

func newMediaServer(static string) *mediaServer {
	return &mediaServer{
		docs:   map[string]string{},
		files:  map[string]string{},
		dirs:   map[string]string{},
		static: static,
	}
}

// vendor 返回随包静态资源目录；缺失时为空。
func (m *mediaServer) vendor() string {
	if m.static == "" {
		return ""
	}
	return filepath.Join(m.static, "vendor")
}

// addChart 登记一张图表。服务端落盘后 details 里给的是 path；旧消息里可能还是内联 html。
func (m *mediaServer) addChart(ch api.Chart) (token, rawURL string, err error) {
	html := ch.HTML
	if html == "" {
		if ch.Path == "" {
			return "", "", errors.New("the chart has no file")
		}
		info, statErr := os.Stat(ch.Path)
		if statErr != nil {
			return "", "", fmt.Errorf("the chart file is missing: %s", ch.Path)
		}
		if info.Size() > maxChartBytes {
			token = newPreviewToken()
			m.mu.Lock()
			m.files[token] = ch.Path
			m.mu.Unlock()
			return token, previewBase + "/f/" + token, nil
		}
		data, readErr := os.ReadFile(ch.Path)
		if readErr != nil {
			return "", "", fmt.Errorf("the chart file could not be read: %v", readErr)
		}
		html = string(data)
	}
	if strings.TrimSpace(html) == "" {
		return "", "", fmt.Errorf("the chart file is empty: %s", ch.Path)
	}
	if m.vendor() == "" && needsVendorAssets(html) {
		return "", "", errors.New("the chart needs the web build's static assets (static/vendor), which this build does not have")
	}
	token = newPreviewToken()
	m.mu.Lock()
	m.docs[token] = chartDocument(html)
	m.mu.Unlock()
	return token, previewBase + "/c/" + token + ".html", nil
}

// addArtifact 登记一个产物的目录，返回该文件的 URL。
func (m *mediaServer) addArtifact(file string) (token, rawURL string, err error) {
	dir := filepath.Dir(file)
	if info, statErr := os.Stat(dir); statErr != nil || !info.IsDir() {
		return "", "", fmt.Errorf("the artifact folder is missing: %s", dir)
	}
	token = newPreviewToken()
	m.mu.Lock()
	m.dirs[token] = dir
	m.mu.Unlock()
	return token, previewBase + "/a/" + token + "/" + url.PathEscape(filepath.Base(file)), nil
}

// addDoc 登记一段 HTML 文档（仪表盘导出）。
func (m *mediaServer) addDoc(kind, html string) (token, rawURL string) {
	token = newPreviewToken()
	m.mu.Lock()
	m.docs[token] = html
	m.mu.Unlock()
	return token, previewBase + "/" + kind + "/" + token + ".html"
}

func (m *mediaServer) remove(token string) {
	m.mu.Lock()
	delete(m.docs, token)
	delete(m.files, token)
	delete(m.dirs, token)
	m.mu.Unlock()
}

func (m *mediaServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if debugPreviews {
		log.Printf("preview: %s %s host=%q path=%q", r.Method, r.URL.String(), r.URL.Host, r.URL.Path)
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := path.Clean("/" + r.URL.Path)
	switch {
	case strings.HasPrefix(p, "/static/"):
		m.serveStatic(w, r, strings.TrimPrefix(p, "/static/"))
	case strings.HasPrefix(p, "/c/"), strings.HasPrefix(p, "/d/"):
		m.serveDoc(w, r, strings.TrimSuffix(path.Base(p), ".html"))
	case strings.HasPrefix(p, "/f/"):
		m.serveFile(w, r, strings.TrimPrefix(p, "/f/"))
	case strings.HasPrefix(p, "/a/"):
		token, name, ok := strings.Cut(strings.TrimPrefix(p, "/a/"), "/")
		if !ok || name == "" {
			http.NotFound(w, r)
			return
		}
		m.serveArtifact(w, r, token, name)
	default:
		http.NotFound(w, r)
	}
}

func (m *mediaServer) serveDoc(w http.ResponseWriter, r *http.Request, token string) {
	m.mu.RLock()
	html, ok := m.docs[token]
	m.mu.RUnlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(html))
}

func (m *mediaServer) serveFile(w http.ResponseWriter, r *http.Request, token string) {
	m.mu.RLock()
	file, ok := m.files[token]
	m.mu.RUnlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	servePreviewFile(w, r, file)
}

func (m *mediaServer) serveArtifact(w http.ResponseWriter, r *http.Request, token, name string) {
	m.mu.RLock()
	dir, ok := m.dirs[token]
	m.mu.RUnlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	file, ok := fileUnder(dir, name)
	if !ok {
		http.NotFound(w, r)
		return
	}
	servePreviewFile(w, r, file)
}

func (m *mediaServer) serveStatic(w http.ResponseWriter, r *http.Request, name string) {
	if m.static == "" {
		http.NotFound(w, r)
		return
	}
	file, ok := fileUnder(m.static, name)
	if !ok {
		http.NotFound(w, r)
		return
	}
	servePreviewFile(w, r, file)
}

// servePreviewFile 流式返回一个文件：产物的报告可能很大，不能整个读进内存。
func servePreviewFile(w http.ResponseWriter, r *http.Request, file string) {
	info, err := os.Stat(file)
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(file)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", mediaType(file))
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

// mediaType 按扩展名给出 Content-Type。Go 的 mime 表在 Linux 上不一定认识 .js，而 WebKit
// 拒绝执行 MIME 不是 JavaScript 的脚本，所以常见类型在这里写死。
func mediaType(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".json":
		return "application/json"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".woff2":
		return "font/woff2"
	case ".woff":
		return "font/woff"
	case ".ttf":
		return "font/ttf"
	}
	if t := mime.TypeByExtension(path.Ext(name)); t != "" {
		return t
	}
	return "application/octet-stream"
}

// fileUnder 把 URL 里的相对路径解析成 dir 下的普通文件；逃出 dir（含经符号链接逃出）
// 的路径一律拒绝。
func fileUnder(dir, rel string) (string, bool) {
	if dir == "" || rel == "" {
		return "", false
	}
	for _, part := range strings.Split(rel, "/") {
		if part == ".." {
			return "", false
		}
	}
	base, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", false
	}
	full, err := filepath.EvalSymlinks(filepath.Join(base, filepath.FromSlash(rel)))
	if err != nil {
		return "", false
	}
	inside, err := filepath.Rel(base, full)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return "", false
	}
	return full, true
}

func newPreviewToken() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("t%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// findStaticDir 找到随包的 static 目录：旧网页把 plotly/echarts/d3 放在 static/vendor，
// 图表 HTML 里的 /static/vendor/... 由它提供。顺序：DW_STATIC_DIR、可执行文件旁（Linux、
// Windows 的 static，macOS 的 Contents/Resources/static），再从可执行文件目录与工作目录
// 向上找仓库里的 static。
func findStaticDir() string {
	if dir := strings.TrimSpace(os.Getenv("DW_STATIC_DIR")); dir != "" {
		if hasVendor(dir) {
			return dir
		}
		if root := filepath.Join(dir, "static"); hasVendor(root) {
			return root
		}
	}
	var roots []string
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		dir := filepath.Dir(exe)
		roots = append(roots, dir, filepath.Join(dir, "..", "Resources"))
	}
	if cwd, err := os.Getwd(); err == nil {
		roots = append(roots, cwd)
	}
	for _, root := range roots {
		dir := root
		for {
			candidate := filepath.Join(dir, "static")
			if hasVendor(candidate) {
				return candidate
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

// hasVendor 报告 dir/vendor 里有没有随包的图表库。
func hasVendor(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "vendor", "plotly.min.js"))
	return err == nil
}

// needsVendorAssets 报告图表页面是否依赖旧网页的 /static/vendor/* 脚本。
func needsVendorAssets(html string) bool {
	return strings.Contains(html, "/static/vendor/")
}

// fileURL 把本地路径变成 file URL，供“用系统浏览器打开”使用。
func fileURL(file string) string {
	if file == "" {
		return ""
	}
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(file)}).String()
}

// chartDocument 让图表铺满 web view：旧网页的外壳给 body 40px 边距、把 Plotly 容器写死成
// 400–1100px 高，直接嵌进消息流只剩滚动条和半张图。只改外观，不动 figure 数据。
func chartDocument(html string) string {
	injection := "<style>" + chartFitStyle + "</style><script>" + chartFitScript + "</script>\n"
	if at := headEndRE.FindStringIndex(html); at != nil {
		return html[:at[0]] + injection + html[at[0]:]
	}
	return injection + html
}

// headEndRE 找 </head>；不用 strings.ToLower 的偏移，Unicode 小写可能改变字节长度。
var headEndRE = regexp.MustCompile(`(?i)</head\s*>`)

// cspMetaRE 找服务端为离线打开注入的 CSP meta。
var cspMetaRE = regexp.MustCompile(`(?i)<meta[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>`)

// chartFitStyle 把图表页压成一屏：图表占满剩余高度，标题与说明留一两行，不出现整页滚动。
const chartFitStyle = `html,body{margin:0!important;padding:0!important;height:100%;overflow:hidden;background:transparent!important;font-family:system-ui,sans-serif}
body{display:flex;flex-direction:column}
body>.chart-wrap{flex:1 1 auto;min-height:0;margin:0!important;padding:12px 14px!important;border-radius:0!important;box-shadow:none!important;background:transparent!important;box-sizing:border-box;display:flex;flex-direction:column}
body>.chart-wrap>h1{font-size:15px;margin:0 0 4px}
body>.chart-wrap>.subtitle{margin:0 0 8px;font-size:11px}
body>.chart-wrap>.js-plotly-plot,body>.chart-wrap>.plotly-graph-div,body>.chart-wrap>div{flex:1 1 auto;min-height:0;width:100%!important;height:auto!important}
body>.desc{flex:0 0 auto;max-height:2.8em;overflow:hidden;margin:0;padding:0 14px 8px;font-size:11px;color:#666}
body img{max-width:100%;height:auto}
`

// chartFitScript 在页面与库就绪后、以及每次尺寸变化后让 Plotly 重新排布；窗口缩放时
// web view 的宽度变了，图表跟着铺开，而不是保持建图时的画布。
const chartFitScript = `(function(){
  function fit(){try{if(window.Plotly&&Plotly.Plots){document.querySelectorAll('.plotly-graph-div').forEach(function(d){Plotly.Plots.resize(d);});}}catch(e){}}
  if(document.readyState!=='loading'){fit();}else{document.addEventListener('DOMContentLoaded',fit);}
  window.addEventListener('resize',fit);
  setTimeout(fit,120);
})();`

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
func (a *app) webPreview(c *ui.Context, pv *preview, height float32, what, filePath string) bool {
	if reason := pv.failure(); reason != "" {
		a.previewFallback(c, what, reason, filePath)
		return false
	}
	element := pv.element()
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
		ui.Text(c, what+" preview is unavailable").FontSize(12).Bold()
		ui.Text(c, reason).FontSize(12).TextColor(t.TextMuted)
		if filePath == "" {
			return
		}
		ui.Text(c, filePath).FontSize(11).TextColor(t.TextMuted).Selectable().SingleLine().Tooltip(filePath)
		if ui.Button(c, "Open in browser").FontSize(11).Tooltip("Open this file with the system's browser").Clicked() {
			c.OpenURL(fileURL(filePath))
		}
	})
}

// chartCard 在聊天里展示一张图表：标题行加 web view。窗口尺寸变化时视图重建，宽度与高度
// 一起更新，Plotly 在新视口里重排。
func (a *app) chartCard(c *ui.Context, ch api.Chart) {
	t := c.Theme()
	pv := a.rich.chartPreview(ch)
	title := ch.Title
	if title == "" {
		title = "Chart"
	}
	ui.Column(c).Gap(6).Padding(8).Radius(8).Background(t.Background).BorderWidth(1).BorderColor(t.Border).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, title).FontSize(12).Bold().SingleLine().Grow(1).MinWidth(0).Tooltip(title)
			if ch.Type != "" {
				ui.Badge(c, ch.Type)
			}
			if pv.failure() != "" {
				if ui.Button(c, "Reload").FontSize(11).Tooltip("Load the chart again").Clicked() {
					a.rich.forget(pv)
				}
			}
		})
		a.webPreview(c, pv, chartHeight(a.chatChartWidth()), "Chart", ch.Path)
	})
}

// artifactPreviewCard 在数据面板里预览一个 HTML/SVG 产物。
func (a *app) artifactPreviewCard(c *ui.Context, art api.Artifact) {
	a.rich.keepOnly(ownerPanel, art.Path)
	pv := a.rich.artifactPreview(art)
	ui.Column(c).Gap(6).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "Preview: "+art.Name).FontSize(12).Bold().SingleLine().Grow(1).MinWidth(0).Tooltip(art.Name)
			if ui.Button(c, "Open").FontSize(11).Tooltip("Open " + art.Name + " in the system's browser").Clicked() {
				c.OpenURL(fileURL(art.Path))
			}
			if pv.failure() != "" {
				if ui.Button(c, "Reload").FontSize(11).Tooltip("Load the preview again").Clicked() {
					a.rich.forget(pv)
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
func (a *app) showHTMLArtifact(art api.Artifact) {
	a.src.artifactName = art.Name
	a.src.artifactText, a.src.artifactErr, a.src.artifactLoaded = "", "", true
	a.rich.forgetKey(ownerPanel, art.Path)
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
	list      []api.Dashboard
	choice    string
	exporting bool
	exportErr string
	html      string
	htmlFor   string
	gen       int
}

// openDashboards 打开仪表盘查看器（数据面板的入口）。
func (a *app) openDashboards() {
	a.rich.dash.open = true
	a.rich.dash.err = ""
	switch {
	case len(a.rich.dash.list) == 0:
		a.loadDashboards()
	case a.rich.dash.choice == "":
		a.showDashboard(a.rich.dash.list[0].ID)
	}
}

// openDashboard 打开某个仪表盘（聊天里 dashboard_id 的入口）。
func (a *app) openDashboard(id string) {
	a.rich.dash.open = true
	a.rich.dash.choice = id
	if len(a.rich.dash.list) == 0 {
		a.loadDashboards()
	}
	a.showDashboard(id)
}

// loadDashboards 拉取仪表盘列表；仪表盘库不属于某个会话。
func (a *app) loadDashboards() {
	client := a.client
	if client == nil {
		a.rich.dash.err = "The agent service is not ready."
		return
	}
	a.rich.dash.loading = true
	a.rich.dash.err = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		list, err := client.Dashboards(ctx)
		a.post(func() {
			if client != a.client {
				return
			}
			a.rich.dash.loading = false
			if err != nil {
				a.rich.dash.err = "Could not load the dashboards: " + err.Error()
				return
			}
			a.rich.dash.list, a.rich.dash.err = list, ""
			if a.rich.dash.choice == "" && len(list) > 0 {
				a.showDashboard(list[0].ID)
			}
		})
	}()
}

// showDashboard 让查看器导出并显示一个仪表盘；旧预览先释放，导出的 HTML 到达后重建。
func (a *app) showDashboard(id string) {
	client := a.client
	if client == nil {
		a.rich.dash.exportErr = "The agent service is not ready."
		return
	}
	a.rich.dash.choice = id
	a.rich.dash.exporting = true
	a.rich.dash.exportErr = ""
	a.rich.dash.gen++
	gen := a.rich.dash.gen
	a.rich.forgetKey(ownerModal, dashPreviewKey(id))
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, html, err := client.DashboardHTML(ctx, id)
		a.post(func() {
			if client != a.client || gen != a.rich.dash.gen {
				return
			}
			a.rich.dash.exporting = false
			if err != nil {
				a.rich.dash.exportErr = sourceErrorText(err)
				return
			}
			a.rich.dash.html, a.rich.dash.htmlFor = html, id
			a.rich.forgetKey(ownerModal, dashPreviewKey(id))
		})
	}()
}

func dashPreviewKey(id string) string { return "dashboard:" + id }

// dashboardPreview 画出导出好的仪表盘。
func (a *app) dashboardPreview(c *ui.Context, id string) {
	d := &a.rich.dash
	a.rich.keepOnly(ownerModal, dashPreviewKey(id))
	if d.exporting || d.htmlFor != id {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Spinner(c)
			ui.Text(c, "Exporting the dashboard…").FontSize(12).TextColor(c.Theme().TextMuted)
		})
		return
	}
	pv := a.rich.acquire(ownerModal, dashPreviewKey(id), true, func(m *mediaServer) (string, string, error) {
		if d.html == "" {
			return "", "", errors.New("the dashboard export is empty")
		}
		token, rawURL := m.addDoc("d", dashboardDocument(d.html))
		return token, rawURL, nil
	})
	a.webPreview(c, pv, documentHeight(720), "Dashboard", "")
}

// dashboardDocument 去掉服务端为“离线单独打开”注入的 CSP：仪表盘里的图表是 srcdoc
// iframe，它们要加载 dw-preview:// 下的 plotly。页面仍然没有绑定方法，也没有网络以外的
// 能力（图表页本来就没有 CSP）。
func dashboardDocument(html string) string {
	return cspMetaRE.ReplaceAllString(html, "")
}

// dashboardsModal 是仪表盘查看器：列表、导出与只读预览。
func (a *app) dashboardsModal(c *ui.Context, t *ui.Theme) {
	d := &a.rich.dash
	if !d.open {
		a.rich.releaseModal()
		return
	}
	ui.Modal(c, &d.open, func() {
		ui.Column(c).Width(764).Gap(10).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, "Dashboards").Bold().FontSize(16)
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
				ui.Text(c, d.err).FontSize(12).TextColor(t.Danger)
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
			if d.exportErr != "" {
				ui.Text(c, d.exportErr).FontSize(12).TextColor(t.Danger)
			}
			if d.choice != "" {
				a.dashboardPreview(c, d.choice)
			}
		})
	})
}

// dashboardLabels 给下拉框一组不会撞车的名字：重名时补上 id，用户才能分清。
func dashboardLabels(list []api.Dashboard) []string {
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
func dashboardLabelOf(list []api.Dashboard, labels []string, id string) string {
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
func (a *app) openCanvas() { a.rich.canvasOpen = true }

// canvasModal 是画布入口。旧界面用内嵌的 draw.io 编辑器渲染画布（static/drawio，147 MB，
// 配旧 Flask 前端的 postMessage 协议，而且画布项目存在那个前端自己的 store 里）；这个服务
// 没有画布 IPC，所以只读入口列出导出到产物的 .drawio/.canvas 文件，交给系统的 draw.io 打开。
func (a *app) canvasModal(c *ui.Context, t *ui.Theme) {
	if !a.rich.canvasOpen {
		return
	}
	ui.Modal(c, &a.rich.canvasOpen, func() {
		ui.Column(c).Width(640).Gap(10).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, "Canvas").Bold().FontSize(16)
				ui.Spacer(c)
				if ui.Button(c, "Close").Clicked() {
					a.rich.canvasOpen = false
				}
			})
			ui.Text(c, "The web build drew canvases with its own draw.io editor and stored them outside the agent service. This build lists the diagram files exported to this chat's artifacts and opens them with the app your system uses for draw.io.").FontSize(12).TextColor(t.TextMuted)
			var files []api.Artifact
			for _, art := range a.src.artifacts {
				if diagramFile(art.Name) {
					files = append(files, art)
				}
			}
			if len(files) == 0 {
				ui.Text(c, "No .drawio or .canvas file in this chat's artifacts.").FontSize(12).TextColor(t.TextMuted)
				return
			}
			for _, art := range files {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(c, art.Name).Grow(1).MinWidth(0).SingleLine().Tooltip(art.Path)
					if ui.Button(c, "Open").FontSize(11).Tooltip("Open " + art.Name + " with the system's draw.io").Clicked() {
						c.OpenURL(fileURL(art.Path))
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
	a.canvasModal(c, t)
}
