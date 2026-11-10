package app

import (
	"bytes"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"datawhisper/desktop/internal/i18n"
	"datawhisper/desktop/internal/prefs"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// findMenuItem 在菜单模板（含子菜单）里找 ID 对应的项。
func findMenuItem(items []*mygo.MenuItem, id string) *mygo.MenuItem {
	for _, item := range items {
		if item.ID == id {
			return item
		}
		if found := findMenuItem(item.Submenu, id); found != nil {
			return found
		}
	}
	return nil
}

// clickMenuItem 按 ID 触发菜单项的动作，就像用户选了它。
func clickMenuItem(t *testing.T, items []*mygo.MenuItem, id string) {
	t.Helper()
	item := findMenuItem(items, id)
	if item == nil {
		t.Fatalf("no menu item %q", id)
	}
	if item.Click == nil {
		t.Fatalf("menu item %q does nothing", id)
	}
	item.Click(item, nil)
}

// trKeyPattern 抓出代码里用到的文案键，用来核对两份资源是否齐全。
var trKeyPattern = regexp.MustCompile(`\btr\("([^"]+)"`)

func TestTranslationResourcesCoverEveryKey(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	used := map[string]bool{}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range trKeyPattern.FindAllStringSubmatch(string(src), -1) {
			used[match[1]] = true
		}
	}
	if len(used) < 40 {
		t.Fatalf("only %d keys found: the scan is not reading the sources", len(used))
	}
	for key := range used {
		if !i18n.Has(i18n.EN, key) {
			t.Errorf("no English text for %q", key)
		}
		if !i18n.Has(i18n.ZH, key) {
			t.Errorf("no Chinese text for %q", key)
		}
	}
	// 资源里的死文案也要发现：每个键都得有地方用。
	for _, key := range i18n.Keys() {
		if !used[key] {
			t.Errorf("%q is in the resources but nothing says it", key)
		}
	}
}

func TestMenuActionsReachTheApp(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	a.logPath = "/data/logs/service.log"
	a.dataDir = "/data"
	var opened []string
	var dialogs []string
	var shown, hidden int
	var themes []mygo.ThemeSource
	a.hooks.openURL = func(url string) error { opened = append(opened, url); return nil }
	a.hooks.openPath = func(path string) error { opened = append(opened, path); return nil }
	a.hooks.message = func(title, body string) { dialogs = append(dialogs, title+"\n"+body) }
	a.hooks.show = func() { shown++ }
	a.hooks.hide = func() { hidden++ }
	a.hooks.setTheme = func(s mygo.ThemeSource) { themes = append(themes, s) }

	items := a.menuTemplate()
	a.show(7)
	a.nav = navOf(7)

	clickMenuItem(t, items, menuIDSettings)
	if a.nav != navSettings {
		t.Errorf("Settings… left nav at %q", a.nav)
	}
	clickMenuItem(t, items, menuIDNewChat)
	if a.nav != "" || a.conv != 0 {
		t.Errorf("New chat left nav %q, conversation %d", a.nav, a.conv)
	}

	clickMenuItem(t, items, menuIDDataPanel)
	if !a.src.open {
		t.Error("Toggle Data Panel did not open the panel")
	}
	clickMenuItem(t, items, menuIDDataPanel)
	if a.src.open {
		t.Error("Toggle Data Panel did not close the panel")
	}
	// 在设置页展开面板时先回到聊天页，否则面板开了也看不见。
	a.conv, a.nav = 7, navSettings
	clickMenuItem(t, items, menuIDDataPanel)
	if a.nav != navOf(7) || !a.src.open {
		t.Errorf("Toggle Data Panel on the settings page: nav %q, open %v", a.nav, a.src.open)
	}
	a.src.open = false

	clickMenuItem(t, items, menuIDToggleTheme)
	if a.prefs.Theme != prefs.ThemeDark || len(themes) != 1 || themes[0] != mygo.ThemeDark {
		t.Errorf("Toggle Theme: pref %q, sources %v", a.prefs.Theme, themes)
	}
	clickMenuItem(t, items, menuIDToggleTheme)
	if a.prefs.Theme != prefs.ThemeLight || themes[len(themes)-1] != mygo.ThemeLight {
		t.Errorf("Toggle Theme again: pref %q, sources %v", a.prefs.Theme, themes)
	}

	clickMenuItem(t, items, menuIDServiceLog)
	clickMenuItem(t, items, menuIDDocumentation)
	clickMenuItem(t, items, menuIDReportIssue)
	want := []string{a.logPath, repoURL, issuesURL}
	if strings.Join(opened, " ") != strings.Join(want, " ") {
		t.Errorf("opened %v, want %v", opened, want)
	}

	clickMenuItem(t, items, menuIDAbout)
	if len(dialogs) != 1 || !strings.Contains(dialogs[0], a.appVersion()) || !strings.Contains(dialogs[0], repoURL) {
		t.Errorf("About showed %q", dialogs)
	}
	if a.appVersion() == "" {
		t.Error("mygo.json has no version")
	}

	// 退出交给 MyGo 的 RoleQuit：它走正常的退出流程（服务由 main 在 Run 返回后停掉）。
	if item := findMenuItem(items, menuIDQuit); item == nil || item.Role != mygo.RoleQuit {
		t.Errorf("Quit is not MyGo's quit role: %+v", item)
	}

	// Import 只在有会话时可用：没有会话时禁用，有了才让点。
	if item := findMenuItem(items, menuIDImport); item == nil || !item.Disabled {
		t.Error("Import Data… is enabled without a conversation")
	}
	a.src.conv, a.conv = 3, 3
	if item := findMenuItem(a.menuTemplate(), menuIDImport); item == nil || item.Disabled {
		t.Error("Import Data… is disabled with a conversation")
	}

	// 托盘菜单也是真的接到动作上：显示、隐藏、新对话、退出。
	tray := a.trayMenuTemplate()
	for _, item := range tray {
		if item.Click != nil && item.Label != "" {
			item.Click(item, nil)
		}
	}
	if shown != 2 { // Show Window 与 New Chat 都会显示窗口
		t.Errorf("tray showed the window %d times", shown)
	}
	if hidden != 1 {
		t.Errorf("tray hid the window %d times", hidden)
	}
	if tray[len(tray)-1].Role != mygo.RoleQuit {
		t.Errorf("the tray has no quit item: %+v", tray[len(tray)-1])
	}
}

func TestLanguageSwitchUpdatesPages(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	tt := ui.NewTester(a.view, 1180, 760)
	expectTexts(t, tt, []string{"New chat", "Search chats", "Settings", "What would you like to analyze?"}, nil)

	a.setLanguage(i18n.ZH)
	q.run()
	tt.Frame()
	// 聊天页与侧边栏都换成了中文。
	expectTexts(t, tt, []string{"新建对话", "搜索会话", "设置", "数据", "今天想分析什么？"},
		[]string{"New chat", "Search chats", "What would you like to analyze?"})

	if err := tt.Click("设置"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"设置", "模型", "通用", "智能体服务就绪后才能设置模型。"}, nil)

	if err := tt.Click("通用"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"外观", "跟随系统", "语言", "数据目录", "服务日志", "未设置"}, nil)
	if err := tt.Click("外观"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"模式", "跟随系统", "浅色", "深色", "配色", "亮色配色", "强调色", "界面风格", "界面字体", "预览"}, nil)

	// 再切回英文，同一个页面的文案跟着回来。
	a.setLanguage(i18n.EN)
	q.run()
	tt.Frame()
	expectTexts(t, tt, []string{"Appearance", "Mode", "System", "Light", "Dark", "Color scheme", "Interface font", "Preview"},
		[]string{"外观", "模式"})
}

// pixelAt 返回最后一帧在 (x, y) 的颜色，忽略透明度。
func pixelAt(tt *ui.Tester, x, y int) ui.Color {
	img := tt.Image()
	if img == nil || x < 0 || y < 0 || x >= img.Bounds().Dx() || y >= img.Bounds().Dy() {
		return ui.Color{}
	}
	c := img.RGBAAt(x, y)
	return ui.Color{R: c.R, G: c.G, B: c.B, A: c.A}
}

func TestThemePreferenceReachesTheFrame(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	a.prefsPath = filepath.Join(t.TempDir(), "ui.json")
	tt := ui.NewTester(a.view, 1180, 760)
	// 系统是深色的；显式选了浅色时界面仍应是浅色。
	tt.SetDark(true)

	a.setTheme(prefs.ThemeLight)
	q.run()
	tt.Frame()
	if got, want := pixelAt(tt, 10, 300), a.themeFor(false).Tok.Sidebar; got != want {
		t.Errorf("light preference drew the sidebar %v, want %v", got, want)
	}

	a.setTheme(prefs.ThemeDark)
	q.run()
	tt.Frame()
	if got, want := pixelAt(tt, 10, 300), a.themeFor(true).Tok.Sidebar; got != want {
		t.Errorf("dark preference drew the sidebar %v, want %v", got, want)
	}

	// 选择写进了磁盘，重启后读回来还是深色。
	if saved := prefs.Load(a.prefsPath); saved.Theme != prefs.ThemeDark {
		t.Errorf("saved theme %q, want %q", saved.Theme, prefs.ThemeDark)
	}
	// -theme 锁定的一次运行不写文件。
	a.prefsLocked = true
	a.setTheme(prefs.ThemeLight)
	if saved := prefs.Load(a.prefsPath); saved.Theme != prefs.ThemeDark {
		t.Errorf("a locked run saved %q", saved.Theme)
	}
}

func TestDarkThemeIsActuallyDark(t *testing.T) {
	light, dark := ui.LightTheme(), ui.DarkTheme()
	if !dark.Dark || light.Dark {
		t.Fatalf("the themes do not report their appearance: light %v dark %v", light.Dark, dark.Dark)
	}
	for _, role := range []string{"background", "surface", "border", "text", "muted"} {
		l, d := themeColor(light, role), themeColor(dark, role)
		if l == d {
			t.Errorf("%s is the same color in both themes", role)
		}
	}
	// 深色的底与浅色的底相差一个数量级的亮度。
	lum := func(c ui.Color) int { return int(c.R) + int(c.G) + int(c.B) }
	if lum(themeColor(dark, "background")) > 200 || lum(themeColor(light, "background")) < 600 {
		t.Errorf("backgrounds are not dark/light: %v, %v",
			themeColor(dark, "background"), themeColor(light, "background"))
	}
}

// TestPagesUseOnlyThemeColors 保证界面没有写死颜色与字体：浅色的底在深色模式下就是那个「残留的浅色背景」，
// 写死的字体名会绕过用户的字体设置。配色推导在 internal/theme，不在这个包里；shell.go 的托盘图标用 image/color 画像素，不算界面颜色。
func TestPagesUseOnlyThemeColors(t *testing.T) {
	literals := []string{"ui.RGB(", "ui.RGBA(", "ui.Hex(", "ui.Color{", `.Font("`}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		for _, literal := range literals {
			if bytes.Contains(src, []byte(literal)) {
				t.Errorf("%s hardcodes a color with %s; take it from the theme", name, literal)
			}
		}
	}
}

func TestThemeSourcesAndAppearance(t *testing.T) {
	cases := []struct {
		pref string
		want mygo.ThemeSource
	}{
		{prefs.ThemeSystem, mygo.ThemeSystem},
		{prefs.ThemeLight, mygo.ThemeLight},
		{prefs.ThemeDark, mygo.ThemeDark},
		{"", mygo.ThemeSystem},
	}
	for _, c := range cases {
		if got := themeSource(c.pref); got != c.want {
			t.Errorf("themeSource(%q) = %q, want %q", c.pref, got, c.want)
		}
	}

	a := newTestApp(t, newQueue())
	dark := true
	a.hooks.isDark = func() bool { return dark }
	a.prefs.Theme = prefs.ThemeSystem
	if !a.effectiveDark() {
		t.Error("following a dark system is not dark")
	}
	a.toggleTheme()
	if a.prefs.Theme != prefs.ThemeLight {
		t.Errorf("toggling from a dark system chose %q", a.prefs.Theme)
	}
	dark = false
	a.prefs.Theme = prefs.ThemeSystem
	a.toggleTheme()
	if a.prefs.Theme != prefs.ThemeDark {
		t.Errorf("toggling from a light system chose %q", a.prefs.Theme)
	}
}

// TestAppLocale 核对传给 MyGo 的语言标签：跟随系统用空串（语言匹配本身见 internal/i18n 的测试）。
func TestAppLocale(t *testing.T) {
	if got := appLocale(i18n.System); got != "" {
		t.Errorf("appLocale(system) = %q", got)
	}
	if got := appLocale(i18n.ZH); got != i18n.ZH {
		t.Errorf("appLocale(zh-Hans) = %q", got)
	}
}

func TestTrayIconIsAPNG(t *testing.T) {
	data := trayIconPNG()
	if len(data) == 0 {
		t.Fatal("no tray icon")
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if bounds := img.Bounds(); bounds.Dx() != 32 || bounds.Dy() != 32 {
		t.Errorf("tray icon is %v, want 32×32", bounds)
	}
	ink := false
	for y := range 32 {
		for x := range 32 {
			if _, _, _, a := img.At(x, y).RGBA(); a > 0 {
				ink = true
			}
		}
	}
	if !ink {
		t.Error("the tray icon is empty")
	}
}

func TestDroppedFilesGoThroughTheImporter(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	// 没有服务、也没有会话：导入器给每条路径报同一个原因，但队列必须走完，不能卡在 uploading。
	first := filepath.Join(t.TempDir(), "a.csv")
	second := filepath.Join(t.TempDir(), "b.csv")
	for _, path := range []string{first, second} {
		if err := os.WriteFile(path, []byte("a,b\n1,2\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	a.enqueueImport([]string{first, second})
	if len(a.src.queue) != 0 {
		t.Errorf("queue still holds %v", a.src.queue)
	}
	if a.src.uploading {
		t.Error("the importer is stuck uploading")
	}
	if a.src.uploadErr != "Open a chat before importing a file." {
		t.Errorf("upload error %q", a.src.uploadErr)
	}

	// 有会话、没有服务时也一样走完队列。
	a.src.conv, a.conv = 3, 3
	a.enqueueImport([]string{first, second})
	if len(a.src.queue) != 0 || a.src.uploading {
		t.Errorf("queue %v, uploading %v", a.src.queue, a.src.uploading)
	}
}

// countCalls 数假服务收到的某个方法被调了几次。
func countCalls(methods []string, method string) int {
	n := 0
	for _, m := range methods {
		if m == method {
			n++
		}
	}
	return n
}

// TestImportQueueFeedsTheThreeStageUpload 用假服务看整条导入链：拖入两个文件时，一个接一个地开票、写盘、
// 打开，第二个在前一个结束后才开始。
func TestImportQueueFeedsTheThreeStageUpload(t *testing.T) {
	f := newSourceFake(t)
	a, q, tt := openDataPanel(t, f, 1400, 1100)

	dir := t.TempDir()
	var paths []string
	for _, name := range []string{"one.csv", "two.csv"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("a,b\n1,2\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, path)
	}

	// 拖放走的就是这条路：窗口的 OnFileDrop 交给 enqueueImport。
	a.enqueueImport(paths)
	q.pump(t, tt, "both imports", func() bool {
		return countCalls(f.methods(), "source.upload.begin") == 2 && !a.src.uploading && len(a.src.queue) == 0
	})
	if a.src.uploadErr != "" {
		t.Errorf("upload error %q", a.src.uploadErr)
	}

	// 两个文件依次导入：第一次打开在第二次开票之前。
	var order []string
	for _, m := range f.methods() {
		if m == "source.upload.begin" || m == "source.open" {
			order = append(order, m)
		}
	}
	want := []string{"source.upload.begin", "source.open", "source.upload.begin", "source.open"}
	if strings.Join(order, " ") != strings.Join(want, " ") {
		t.Errorf("import order %v, want %v", order, want)
	}
}

// TestSettingsControlsChangeThemeAndLanguage 点设置页里的三选一：主题与会话语言立即生效，并写进 ui.json。
func TestSettingsControlsChangeThemeAndLanguage(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	a.prefsPath = filepath.Join(t.TempDir(), "ui.json")
	tt := ui.NewTester(a.view, 1180, 760)

	if err := tt.Click("Settings"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("Appearance"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()

	if err := tt.Click("Dark"); err != nil {
		t.Fatal(err)
	}
	q.run()
	tt.Frame()
	if a.prefs.Theme != prefs.ThemeDark {
		t.Errorf("clicking Dark left the theme %q", a.prefs.Theme)
	}
	if got := prefs.Load(a.prefsPath).Theme; got != prefs.ThemeDark {
		t.Errorf("saved theme %q", got)
	}
	if got, want := pixelAt(tt, 10, 200), a.themeFor(true).Tok.Sidebar; got != want {
		t.Errorf("the sidebar is %v after clicking Dark, want %v", got, want)
	}

	if err := tt.Click("General"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("简体中文"); err != nil {
		t.Fatal(err)
	}
	q.run()
	tt.Frame()
	if a.lang != i18n.ZH || a.prefs.Language != i18n.ZH {
		t.Errorf("clicking 简体中文 left lang %q, preference %q", a.lang, a.prefs.Language)
	}
	if got := prefs.Load(a.prefsPath).Language; got != i18n.ZH {
		t.Errorf("saved language %q", got)
	}
	expectTexts(t, tt, []string{"外观", "语言", "数据目录", "服务日志"}, []string{"Appearance", "Data folder"})
}

// 服务里的错误文案、命令说明跟着界面语言：连上时告诉服务当前语言，切换后再告诉一次，并重拉命令目录。
func TestServiceLearnsTheInterfaceLanguage(t *testing.T) {
	fs := newFakeService(t)
	q := newQueue()
	a := newTestApp(t, q)
	// 真实启动时 run.go 已把偏好解析成具体语言；测试应用不经过它，这里补上。
	a.lang = i18n.EN
	tt := ui.NewTester(a.view, 1180, 760)

	languages := func() []any {
		var out []any
		for _, call := range fs.callsTo("app.setLanguage") {
			out = append(out, call["lang"])
		}
		return out
	}

	a.onService(fs.ready(41))
	q.pump(t, tt, "the first language call", func() bool { return len(languages()) == 1 && len(fs.callsTo("command.list")) == 1 })
	if got := languages(); got[0] != "en" {
		t.Fatalf("languages on connect: %v", got)
	}

	a.setLanguage(i18n.ZH)
	q.pump(t, tt, "the switch to Chinese", func() bool { return len(languages()) == 2 && len(fs.callsTo("command.list")) == 2 })
	if got := languages(); got[1] != "zh" {
		t.Fatalf("languages after the switch: %v", got)
	}

	// 偏好没有变化时不重复通知服务。
	a.setLanguage(i18n.ZH)
	q.run()
	if got := languages(); len(got) != 2 {
		t.Errorf("an unchanged language notified the service again: %v", got)
	}
}
