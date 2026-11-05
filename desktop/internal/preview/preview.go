// Package preview 是桌面端的网页内容层：把聊天里的图表、数据面板里的 HTML 产物、仪表盘导出嵌进原生窗口的
// web view。
//
// 网页内容的来源有两种：服务端落盘的图表 HTML（它引用旧网页的 /static/vendor/*），以及产物目录里的文件。
// 两者都经过 dw-preview:// 这个自定义 scheme 交给 web view：同一个页面里 /static/vendor/plotly.min.js 因此
// 能找到随包的静态资源，而文件只通过一次性 token 暴露，页面不能凭 URL 读任意路径。
//
// 生命周期：一个 web view 只能挂在一个宿主上，所以聊天、数据面板、弹窗各有自己的实例表；同一 key 重绘时复用
// 同一个实例，切换会话、换预览目标与关闭窗口时销毁。没有窗口的测试通过 Host 替身断言创建与销毁，不会真的建
// web view。界面（卡片、降级说明、仪表盘弹窗）在 internal/app。
package preview

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
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

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// debugPreviews 打开 dw-preview:// 的请求日志（DW_PREVIEW_DEBUG=1），定位空白页面用。
var debugPreviews = os.Getenv("DW_PREVIEW_DEBUG") != ""

// Scheme 是桌面应用自己的网页来源；图表与产物都从这里加载。
const Scheme = "dw-preview"

// Base 是 scheme 的 origin 部分：页面与它的绝对路径资源共用一个 origin。
const Base = Scheme + "://localhost"

// maxChartBytes 是改写图表页面（注入铺满视口的样式）的大小上限。超过它的图表原样从
// 磁盘流给 web view：几十 KB 之外的 HTML 只可能是内联了整个 plotly bundle。
const maxChartBytes = 4 << 20

// Owner 是一块网页内容的宿主。
type Owner int

const (
	OwnerChat Owner = iota
	OwnerPanel
	OwnerModal
	ownerCount
)

// maxPreviews 是每个宿主保留的 web view 上限：聊天里滚过去的图表如果都留着，长会话会攒下
// 几十个页面。超出时释放最久没画的那个，重绘到它时再建。
var maxPreviews = [ownerCount]int{6, 1, 1}

// ---------------------------------------------------------------------------
// 预览宿主：生产用窗口，测试用替身
// ---------------------------------------------------------------------------

// Host 创建 web view。生产实现是 WindowHost（mygo.Window 的 Content），测试替身
// 只记录创建与销毁。
type Host interface {
	// Available 报告这台机器上有没有可用的系统 web view。
	Available() bool
	// New 创建一个加载 url 的 web view；scrollToContainer 让滚轮滚外层原生列表。
	New(url string, scrollToContainer bool) (Pane, error)
}

// Pane 是一块已创建的网页内容。
type Pane interface {
	// Element 返回 ui.WebView 要的原生视图；测试替身返回 nil（没有真实窗口）。
	Element() ui.NativeWebView
	// Failure 报告页面加载失败的原因；空表示没有失败。
	Failure() string
	// Destroy 关闭页面并释放它的资源。
	Destroy()
	// Eval 在页面里执行一段脚本，不等结果（换主题时用）。
	Eval(js string)
}

// WindowHost 在主窗口的 Content 上建 web view。
type WindowHost struct {
	Win     *mygo.Window
	Changed func(func())
}

func (h WindowHost) Available() bool { return h.Win != nil && mygo.WebViewAvailable() }

func (h WindowHost) New(rawURL string, scrollToContainer bool) (Pane, error) {
	if h.Win == nil {
		return nil, errors.New("no window")
	}
	view, err := h.Win.NewWebView(mygo.WebViewOptions{
		URL:  rawURL,
		Page: mygo.PageOptions{Untrusted: true},
		// 图表与产物是 agent 生成的页面：不给它们绑定方法，只当普通网页显示。
		ScrollToContainer: scrollToContainer,
	})
	if err != nil {
		return nil, err
	}
	pane := &htmlPane{view: view, changed: h.Changed}
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

// Eval 在后台执行脚本：Page.Eval 会等页面回话，不能卡住 UI 线程。页面已销毁或还没加载完时出错，忽略即可，
// 新加载的页面会从 serveDoc 注入的主题开始。
func (p *htmlPane) Eval(js string) {
	view := p.view
	go func() {
		if view.IsDestroyed() {
			return
		}
		_, _ = view.Page().Eval(js)
	}()
}

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

// Preview 是一块网页内容的显示状态。pane 为 nil 且 err 非空时视图画降级说明。
type Preview struct {
	owner Owner
	key   string
	pane  Pane
	token string
	err   string
	used  int
	known bool // 已登记在这个宿主的表里（Forget 用）
}

// Failure 返回不能显示这块内容的原因。
func (p *Preview) Failure() string {
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

// Element 返回要放进 ui.WebView 的原生视图；没有时返回 nil。
func (p *Preview) Element() ui.NativeWebView {
	if p == nil || p.pane == nil {
		return nil
	}
	return p.pane.Element()
}

// ownerPreviews 是一个宿主的实例表。
type ownerPreviews struct {
	views map[string]*Preview
	tick  int
}

// Pool 是图表与富内容的网页层。它的零值可用：没有 host 时一律走降级分支，所以
// 没有窗口的测试可以照常构建视图。
type Pool struct {
	Host  Host
	Post  func(func())
	Media *MediaServer

	owners [ownerCount]ownerPreviews

	// themeJSON 是图表页面当前要用的主题（ApplyTheme 收到的值的 JSON）；MediaServer 建好之前也先记在这里。
	themeJSON string
}

// ApplyTheme 记下新的图表主题，并让已打开的图表页面立刻换上：新加载的页面由 serveDoc 注入。
func (r *Pool) ApplyTheme(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	r.themeJSON = string(data)
	if r.Media != nil {
		r.Media.SetTheme(r.themeJSON)
	}
	js := "window.__dwApplyTheme&&window.__dwApplyTheme(" + r.themeJSON + ")"
	for i := range r.owners {
		for _, pv := range r.owners[i].views {
			if pv != nil && pv.pane != nil {
				pv.pane.Eval(js)
			}
		}
	}
}

// MediaServer 懒初始化：它要找到随包的静态资源，在没有窗口的测试里不该发生。
func (r *Pool) Server() *MediaServer {
	if r.Media == nil {
		r.Media = NewMediaServer(FindStaticDir())
		r.Media.SetTheme(r.themeJSON)
	}
	return r.Media
}

func (r *Pool) RemoveMedia(token string) {
	if token == "" {
		return
	}
	if r.Media != nil {
		r.Media.Remove(token)
	}
}

// Acquire 返回（必要时创建）owner 下 key 对应的预览。同一个 key 复用同一个 web view；
// 创建失败或系统没有 web view 时返回带说明的预览，并由视图画降级说明。
func (r *Pool) Acquire(owner Owner, key string, scrollToContainer bool, build func(*MediaServer) (token, url string, err error)) *Preview {
	set := &r.owners[owner]
	if set.views == nil {
		set.views = map[string]*Preview{}
	}
	set.tick++
	if pv, ok := set.views[key]; ok {
		pv.used = set.tick
		return pv
	}
	pv := &Preview{owner: owner, key: key, used: set.tick, known: true}
	set.views[key] = pv
	if r.Host == nil || !r.Host.Available() {
		pv.err = "This build has no system web view (WebKitGTK 4.1), so the page cannot be shown."
		return pv
	}
	token, rawURL, err := build(r.Server())
	if err != nil {
		pv.err = err.Error()
		return pv
	}
	pane, err := r.Host.New(rawURL, scrollToContainer)
	if err != nil {
		r.RemoveMedia(token)
		pv.err = "The web view could not be created: " + err.Error()
		return pv
	}
	pv.pane, pv.token = pane, token
	r.evict(owner)
	return pv
}

// evict 在宿主超过上限时释放最久没画的一个页面；带错误的条目没有页面，不参与。
func (r *Pool) evict(owner Owner) {
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

func (r *Pool) destroy(pv *Preview) {
	if pv == nil {
		return
	}
	if pv.pane != nil {
		pv.pane.Destroy()
		pv.pane = nil
	}
	r.RemoveMedia(pv.token)
	pv.token = ""
}

// Forget 释放一个预览，下一帧按同一 key 重新创建（加载失败后的 Reload）。
func (r *Pool) Forget(pv *Preview) {
	if pv == nil || !pv.known {
		return
	}
	set := &r.owners[pv.owner]
	r.destroy(pv)
	delete(set.views, pv.key)
}

// ForgetKey 释放宿主下某个 key 的预览（重新导出仪表盘时用）。
func (r *Pool) ForgetKey(owner Owner, key string) {
	set := &r.owners[owner]
	if pv, ok := set.views[key]; ok {
		r.destroy(pv)
		delete(set.views, key)
	}
}

// releaseOwner 销毁宿主的所有页面。切换会话、关闭弹窗与窗口关闭时调用。
func (r *Pool) releaseOwner(owner Owner) {
	set := &r.owners[owner]
	for key, pv := range set.views {
		r.destroy(pv)
		delete(set.views, key)
	}
}

func (r *Pool) ReleaseChat()  { r.releaseOwner(OwnerChat) }
func (r *Pool) ReleasePanel() { r.releaseOwner(OwnerPanel) }
func (r *Pool) ReleaseModal() { r.releaseOwner(OwnerModal) }

// ReleaseAll 释放所有页面；窗口关闭时调用（窗口本身也会带走它们，这里是显式收尾）。
func (r *Pool) ReleaseAll() {
	for owner := Owner(0); owner < ownerCount; owner++ {
		r.releaseOwner(owner)
	}
}

// KeepOnly 释放宿主下除 key 以外的预览：数据面板一次只显示一个产物预览，仪表盘查看器
// 一次只显示一个仪表盘。
func (r *Pool) KeepOnly(owner Owner, key string) {
	set := &r.owners[owner]
	for k, pv := range set.views {
		if k == key {
			continue
		}
		r.destroy(pv)
		delete(set.views, k)
	}
}

// ChartPreview 返回聊天里一张图的预览：同一张图（按 id，其次按文件路径）在重绘之间复用。
func (r *Pool) ChartPreview(ch Chart) *Preview {
	key := ch.ID
	if key == "" {
		key = ch.Path
	}
	if key == "" {
		return &Preview{err: "This tool result has no chart to show."}
	}
	return r.Acquire(OwnerChat, key, true, func(m *MediaServer) (string, string, error) {
		return m.AddChart(ch)
	})
}

// ArtifactPreview 返回数据面板里一个 HTML/SVG 产物的预览。
func (r *Pool) ArtifactPreview(path string) *Preview {
	if path == "" {
		return &Preview{err: "This artifact has no file path."}
	}
	return r.Acquire(OwnerPanel, path, false, func(m *MediaServer) (string, string, error) {
		return m.AddArtifact(path)
	})
}

// ---------------------------------------------------------------------------
// dw-preview:// 的处理器
// ---------------------------------------------------------------------------

// MediaServer 把图表页面、产物文件与仪表盘导出交给 web view。路径与 token：
//
//	/c/<token>.html          登记过的图表页面（已注入铺满视口的样式）
//	/d/<token>.html          登记过的仪表盘导出
//	/f/<token>               登记过的大文件（原样流式返回）
//	/a/<token>/<name>        产物目录里的文件；同名目录里的样式、图片仍能加载
//	/static/vendor/<name>    随包的 plotly / echarts / d3
type MediaServer struct {
	mu     sync.RWMutex
	docs   map[string]string
	files  map[string]string
	dirs   map[string]string
	static string // 随包的 static 目录；空表示缺失
	theme  string // 注入图表页面的主题 JSON；空表示页面保持自己的配色
}

// SetTheme 换掉之后加载的图表页面要用的主题。
func (m *MediaServer) SetTheme(themeJSON string) {
	m.mu.Lock()
	m.theme = themeJSON
	m.mu.Unlock()
}

func NewMediaServer(static string) *MediaServer {
	return &MediaServer{
		docs:   map[string]string{},
		files:  map[string]string{},
		dirs:   map[string]string{},
		static: static,
	}
}

// vendor 返回随包静态资源目录；缺失时为空。
func (m *MediaServer) vendor() string {
	if m.static == "" {
		return ""
	}
	return filepath.Join(m.static, "vendor")
}

// AddChart 登记一张图表。服务端落盘后 details 里给的是 path；旧消息里可能还是内联 html。
func (m *MediaServer) AddChart(ch Chart) (token, rawURL string, err error) {
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
			return token, Base + "/f/" + token, nil
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
	return token, Base + "/c/" + token + ".html", nil
}

// AddArtifact 登记一个产物的目录，返回该文件的 URL。
func (m *MediaServer) AddArtifact(file string) (token, rawURL string, err error) {
	dir := filepath.Dir(file)
	if info, statErr := os.Stat(dir); statErr != nil || !info.IsDir() {
		return "", "", fmt.Errorf("the artifact folder is missing: %s", dir)
	}
	token = newPreviewToken()
	m.mu.Lock()
	m.dirs[token] = dir
	m.mu.Unlock()
	return token, Base + "/a/" + token + "/" + url.PathEscape(filepath.Base(file)), nil
}

// AddDoc 登记一段 HTML 文档（仪表盘导出）。
func (m *MediaServer) AddDoc(kind, html string) (token, rawURL string) {
	token = newPreviewToken()
	m.mu.Lock()
	m.docs[token] = html
	m.mu.Unlock()
	return token, Base + "/" + kind + "/" + token + ".html"
}

func (m *MediaServer) Remove(token string) {
	m.mu.Lock()
	delete(m.docs, token)
	delete(m.files, token)
	delete(m.dirs, token)
	m.mu.Unlock()
}

func (m *MediaServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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

func (m *MediaServer) serveDoc(w http.ResponseWriter, r *http.Request, token string) {
	m.mu.RLock()
	html, ok := m.docs[token]
	theme := m.theme
	m.mu.RUnlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	// 主题在送出页面时才填进去：重新加载的图表用的是此刻的主题，而不是登记时的。
	if theme != "" {
		html = strings.Replace(html, chartThemePlaceholder, theme, 1)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(html))
}

func (m *MediaServer) serveFile(w http.ResponseWriter, r *http.Request, token string) {
	m.mu.RLock()
	file, ok := m.files[token]
	m.mu.RUnlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	servePreviewFile(w, r, file)
}

func (m *MediaServer) serveArtifact(w http.ResponseWriter, r *http.Request, token, name string) {
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

func (m *MediaServer) serveStatic(w http.ResponseWriter, r *http.Request, name string) {
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

// FindStaticDir 找到随包的 static 目录：旧网页把 plotly/echarts/d3 放在 static/vendor，
// 图表 HTML 里的 /static/vendor/... 由它提供。顺序：DW_STATIC_DIR、可执行文件旁（Linux、
// Windows 的 static，macOS 的 Contents/Resources/static），再从可执行文件目录与工作目录
// 向上找仓库里的 static。
func FindStaticDir() string {
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

// FileURL 把本地路径变成 file URL，供“用系统浏览器打开”使用。
func FileURL(file string) string {
	if file == "" {
		return ""
	}
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(file)}).String()
}

// chartDocument 让图表铺满 web view：旧网页的外壳给 body 40px 边距、把 Plotly 容器写死成
// 400–1100px 高，直接嵌进消息流只剩滚动条和半张图。只改外观，不动 figure 数据。
func chartDocument(html string) string {
	injection := "<style>" + chartFitStyle + "</style><script>" + chartFitScript + chartThemeScript + "</script>\n"
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
const chartFitStyle = `html,body{margin:0!important;padding:0!important;height:100%;overflow:hidden;background:transparent!important;font-family:var(--dw-font,system-ui,sans-serif);color:var(--dw-text,inherit)}
body{display:flex;flex-direction:column}
body>.chart-wrap{flex:1 1 auto;min-height:0;margin:0!important;padding:12px 14px!important;border-radius:0!important;box-shadow:none!important;background:transparent!important;box-sizing:border-box;display:flex;flex-direction:column}
body>.chart-wrap>h1{font-size:15px;margin:0 0 4px}
body>.chart-wrap>.subtitle{margin:0 0 8px;font-size:11px}
body>.chart-wrap>.js-plotly-plot,body>.chart-wrap>.plotly-graph-div,body>.chart-wrap>div{flex:1 1 auto;min-height:0;width:100%!important;height:auto!important}
body>.desc{flex:0 0 auto;max-height:2.8em;overflow:hidden;margin:0;padding:0 14px 8px;font-size:11px;color:var(--dw-muted,#666)}
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

// chartThemePlaceholder 是 chartThemeScript 里等 serveDoc 填入主题 JSON 的位置；没有主题时保持 null，页面不改配色。
const chartThemePlaceholder = "/*__DW_THEME__*/null"

// chartThemeScript 让图表跟随应用的配色：页面背景透明、文字与网格用主题色、单色系列按主题色板重新上色
// （服务端模板写死的深蓝在暗色底上看不清）。只改外观，不动数据；色阶（colorscale）与逐点配色保持原样。
// 应用换主题时经 Eval 调 window.__dwApplyTheme。
const chartThemeScript = `
(function(){
  function css(t){var s=document.documentElement.style;s.setProperty('--dw-text',t.text);s.setProperty('--dw-muted',t.muted);s.setProperty('--dw-font',t.font);s.colorScheme=t.dark?'dark':'light';}
  function plotly(t){
    if(!window.Plotly)return;
    document.querySelectorAll('.js-plotly-plot').forEach(function(d){
      if(!d.layout)return;
      var u={paper_bgcolor:t.background,plot_bgcolor:t.background,'font.color':t.text,'font.family':t.font,colorway:t.colorway,'title.font.color':t.text,'legend.font.color':t.text};
      Object.keys(d.layout).forEach(function(k){if(/^[xy]axis\d*$/.test(k)){u[k+'.gridcolor']=t.grid;u[k+'.linecolor']=t.grid;u[k+'.zerolinecolor']=t.grid;u[k+'.tickfont.color']=t.muted;u[k+'.title.font.color']=t.muted;}});
      Plotly.relayout(d,u);
      var n=0;
      (d.data||[]).forEach(function(tr,i){
        var c=t.colorway[n%t.colorway.length],up={},hit=false;
        if(tr.marker&&typeof tr.marker.color==='string'&&!tr.marker.colorscale){up['marker.color']=c;hit=true;}
        if(tr.line&&typeof tr.line.color==='string'){up['line.color']=c;hit=true;}
        if(hit){n++;Plotly.restyle(d,up,[i]);}
      });
    });
  }
  function echart(t){
    if(!window.echarts)return;
    document.querySelectorAll('[_echarts_instance_]').forEach(function(el){
      var c=echarts.getInstanceByDom(el);if(!c)return;
      var o=c.getOption()||{};
      var axis=function(l){return l.map(function(){return{axisLabel:{color:t.muted},axisLine:{lineStyle:{color:t.grid}},splitLine:{lineStyle:{color:t.grid}},nameTextStyle:{color:t.muted}};});};
      var u={backgroundColor:'transparent',color:t.colorway,textStyle:{color:t.text,fontFamily:t.font}};
      if(o.title)u.title=o.title.map(function(){return{textStyle:{color:t.text},subtextStyle:{color:t.muted}};});
      if(o.legend)u.legend=o.legend.map(function(){return{textStyle:{color:t.text}};});
      if(o.xAxis)u.xAxis=axis(o.xAxis);
      if(o.yAxis)u.yAxis=axis(o.yAxis);
      c.setOption(u);
    });
  }
  function apply(t){if(!t)return;window.__dwTheme=t;css(t);try{plotly(t);}catch(e){}try{echart(t);}catch(e){}}
  window.__dwApplyTheme=apply;
  window.__dwTheme=` + chartThemePlaceholder + `;
  function again(){apply(window.__dwTheme);}
  if(window.__dwTheme){css(window.__dwTheme);}
  document.addEventListener('DOMContentLoaded',again);
  window.addEventListener('load',function(){again();setTimeout(again,150);});
})();`

// DashboardDocument 去掉服务端为“离线单独打开”注入的 CSP：仪表盘里的图表是 srcdoc
// iframe，它们要加载 dw-preview:// 下的 plotly。页面仍然没有绑定方法，也没有网络以外的
// 能力（图表页本来就没有 CSP）。
func DashboardDocument(html string) string {
	return cspMetaRE.ReplaceAllString(html, "")
}

// Chart 是一张要显示的图表：服务端落盘的 HTML 文件（Path），或旧消息里内联的 HTML。ID 是复用 web view 的键，
// 为空时用 Path。
type Chart struct {
	ID, Path, HTML string
}

// Len 报告 owner 下现有几块网页内容（测试与诊断用）。
func (r *Pool) Len(owner Owner) int { return len(r.owners[owner].views) }

// Token 返回 owner 下 key 对应的预览登记的 token；没有时为空。
func (r *Pool) Token(owner Owner, key string) string {
	if pv := r.owners[owner].views[key]; pv != nil {
		return pv.token
	}
	return ""
}

// Has 报告 token 是否还登记着一份文档。
func (m *MediaServer) Has(token string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.docs[token]
	return ok
}
