package app

// 应用外壳：菜单栏、快捷键、托盘、文件拖放，以及外壳自己的动作（打开日志、打开数据目录、文档、反馈）。
// 主题与语言的偏好存在 ui.json（prefs.go），界面文案在 i18n.go。这里所有外部动作都经 shellHooks：
// 真实窗口接上 MyGo 的接口，测试换成记录器，因此菜单项的动作可以在没有窗口的情况下被验证。

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"log"
	"strings"

	"datawhisper/desktop/internal/i18n"
	"datawhisper/desktop/internal/prefs"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// shellHooks 是只有真实窗口才能提供的动作；nil 表示这个动作当前不做（测试里就是这样）。
type shellHooks struct {
	openURL   func(url string) error
	openPath  func(path string) error
	message   func(title, body string)
	setTheme  func(mygo.ThemeSource)
	setLocale func(locale string)
	isDark    func() bool
	show      func()
	hide      func()
	setMenu   func(*mygo.Menu)
	preferred func() []string
}

// 菜单项的 ID：界面据此同步勾选状态，测试据此找到要触发的动作。
const (
	menuIDAbout         = "app.about"
	menuIDSettings      = "app.settings"
	menuIDQuit          = "app.quit"
	menuIDNewChat       = "file.new-chat"
	menuIDImport        = "file.import"
	menuIDCloseWindow   = "file.close"
	menuIDDataPanel     = "view.data-panel"
	menuIDToggleTheme   = "view.toggle-theme"
	menuIDReload        = "view.reload"
	menuIDServiceLog    = "view.service-log"
	menuIDDocumentation = "help.docs"
	menuIDReportIssue   = "help.issue"
)

const (
	// repoURL 是源码仓库；Documentation 与 Report an Issue 都指向这里。
	repoURL   = "https://github.com/Zafer-Liu/Data-Analysis-Agent"
	issuesURL = repoURL + "/issues/new"
)

// appVersion 是关于对话框显示的版本，来自 Options.Version（mygo.json）。
func (a *app) appVersion() string { return a.version }

// --- 主题 ---

// themeSource 把偏好换成 MyGo 的外观来源：菜单、窗口按钮这些原生部分跟着它走。
func themeSource(pref string) mygo.ThemeSource {
	switch pref {
	case prefs.ThemeLight:
		return mygo.ThemeLight
	case prefs.ThemeDark:
		return mygo.ThemeDark
	}
	return mygo.ThemeSystem
}

// setTheme 记下外观偏好并立即生效：原生部分随 SetSource 重画，内容由 redraw 重绘。
func (a *app) setTheme(pref string) {
	if !prefs.ValidTheme(pref) || pref == a.prefs.Theme {
		return
	}
	a.prefs.Theme = pref
	a.savePrefs()
	if a.hooks.setTheme != nil {
		a.hooks.setTheme(themeSource(pref))
	}
	a.redraw()
}

// toggleTheme 在浅色与深色之间切换；跟随系统时取当前生效的那一种的相反值，然后变成显式选择。
func (a *app) toggleTheme() {
	if a.effectiveDark() {
		a.setTheme(prefs.ThemeLight)
		return
	}
	a.setTheme(prefs.ThemeDark)
}

// themeColor 把界面外壳的角色换成主题里的颜色。外壳自身只经由它取色，因此深色模式下不会残留浅色常量。
func themeColor(t *ui.Theme, role string) ui.Color {
	switch role {
	case "background":
		return t.Background
	case "surface":
		return t.Surface
	case "border":
		return t.Border
	case "text":
		return t.Text
	case "muted":
		return t.TextMuted
	case "accent":
		return t.Accent
	case "danger":
		return t.Danger
	case "success":
		return t.Success
	case "warning":
		return t.Warning
	}
	return t.Text
}

// --- 语言 ---

// systemLanguages 返回用户读的语言，跟随系统时据此选界面语言。
func (a *app) systemLanguages() []string {
	if a.hooks.preferred != nil {
		return a.hooks.preferred()
	}
	return a.preferred
}

// appLocale 把界面语言换成传给 MyGo 的标签；跟随系统时传空串，让 MyGo 自己按系统语言挑。
func appLocale(pref string) string {
	switch pref {
	case i18n.EN:
		return i18n.EN
	case i18n.ZH:
		return i18n.ZH
	}
	return ""
}

// setLanguage 记下语言偏好并立即生效：界面文案每帧重建，菜单栏整份重建。
func (a *app) setLanguage(pref string) {
	if !i18n.Valid(pref) || pref == a.prefs.Language {
		return
	}
	a.prefs.Language = pref
	a.lang = i18n.Resolve(pref, a.systemLanguages())
	a.savePrefs()
	if a.hooks.setLocale != nil {
		a.hooks.setLocale(appLocale(pref))
	}
	a.syncLanguage()
	a.rebuildMenu()
	a.redraw()
}

// followLocale 在系统语言变化时跟上（只在偏好是「跟随系统」时换语言）。
func (a *app) followLocale() {
	if a.prefs.Language != i18n.System {
		return
	}
	if lang := i18n.Resolve(i18n.System, a.systemLanguages()); lang != a.lang {
		a.lang = lang
		a.syncLanguage()
		a.rebuildMenu()
	}
}

// redraw 请求重绘一帧。
func (a *app) redraw() {
	if a.post != nil {
		a.post(func() {})
	}
}

// --- 菜单 ---

// buildMenu 造出应用菜单栏。
func (a *app) buildMenu() *mygo.Menu {
	return mygo.NewMenu(a.menuTemplate())
}

// rebuildMenu 在语言变化后重建菜单栏；测试里没有菜单（a.menu 为 nil）时什么也不做。
func (a *app) rebuildMenu() {
	if a.menu == nil {
		return
	}
	a.menu = a.buildMenu()
	if a.hooks.setMenu != nil {
		a.hooks.setMenu(a.menu)
	}
}

// menuTemplate 返回菜单栏模板。文案按当前语言取；Edit 菜单用 MyGo 的标准角色，撤销、剪切、复制、粘贴、
// 全选与各自的快捷键都由它实现。没有动作的项不放，或者像 Import 那样在不能导入时禁用。
func (a *app) menuTemplate() []*mygo.MenuItem {
	return []*mygo.MenuItem{
		{Label: "DataWhisper", Submenu: []*mygo.MenuItem{
			{ID: menuIDAbout, Label: a.tr("menu.about", "name", "DataWhisper"),
				Click: func(*mygo.MenuItem, *mygo.Window) { a.about() }},
			{ID: menuIDSettings, Label: a.tr("menu.settings"), Accelerator: "CmdOrCtrl+,",
				Click: func(*mygo.MenuItem, *mygo.Window) { a.openSettings() }},
			mygo.Separator(),
			// 这三项只在 macOS 出现，给的是系统的标准位置。
			{Role: mygo.RoleHide},
			{Role: mygo.RoleHideOthers},
			{Role: mygo.RoleUnhide},
			mygo.Separator(),
			{ID: menuIDQuit, Label: a.tr("menu.quit", "name", "DataWhisper"), Role: mygo.RoleQuit},
		}},
		{Label: a.tr("menu.file"), Submenu: []*mygo.MenuItem{
			{ID: menuIDNewChat, Label: a.tr("menu.newChat"), Accelerator: "CmdOrCtrl+N",
				Click: func(*mygo.MenuItem, *mygo.Window) { a.newChat() }},
			{ID: menuIDImport, Label: a.tr("menu.import"), Accelerator: "CmdOrCtrl+O",
				ToolTip: a.tr("menu.importTip"), Disabled: a.src.conv == 0,
				Click: func(*mygo.MenuItem, *mygo.Window) { a.pickFile() }},
			mygo.Separator(),
			{ID: menuIDCloseWindow, Label: a.tr("menu.closeWindow"), Role: mygo.RoleClose},
		}},
		{Label: a.tr("menu.edit"), Role: mygo.RoleEditMenu},
		{Label: a.tr("menu.view"), Submenu: []*mygo.MenuItem{
			{ID: menuIDDataPanel, Label: a.tr("menu.toggleDataPanel"), Accelerator: "CmdOrCtrl+D",
				Type: mygo.MenuItemCheckbox, Checked: a.src.open,
				Click: func(*mygo.MenuItem, *mygo.Window) { a.toggleDataPanel() }},
			{ID: menuIDToggleTheme, Label: a.tr("menu.toggleTheme"), Accelerator: "CmdOrCtrl+Shift+T",
				Click: func(*mygo.MenuItem, *mygo.Window) { a.toggleTheme() }},
			mygo.Separator(),
			{ID: menuIDReload, Label: a.tr("menu.reload"), Accelerator: "CmdOrCtrl+R",
				Click: func(*mygo.MenuItem, *mygo.Window) { a.reload() }},
			{Role: mygo.RoleToggleFullScreen},
			mygo.Separator(),
			{Label: a.tr("menu.developer"), Submenu: []*mygo.MenuItem{
				{ID: menuIDServiceLog, Label: a.tr("menu.openServiceLog"),
					Click: func(*mygo.MenuItem, *mygo.Window) { a.openServiceLog() }},
				// 原生界面的检查器由 MyGo 提供。
				{Role: mygo.RoleToggleDevTools},
			}},
		}},
		{Label: a.tr("menu.help"), Submenu: []*mygo.MenuItem{
			{ID: menuIDDocumentation, Label: a.tr("menu.documentation"),
				Click: func(*mygo.MenuItem, *mygo.Window) { a.openURL(repoURL) }},
			{ID: menuIDReportIssue, Label: a.tr("menu.reportIssue"),
				Click: func(*mygo.MenuItem, *mygo.Window) { a.openURL(issuesURL) }},
		}},
	}
}

// syncMenu 让菜单项的勾选与可用状态跟上界面；只在真的变了的时候动原生菜单。
func (a *app) syncMenu() {
	if a.menu == nil {
		return
	}
	if item := a.menu.ItemByID(menuIDDataPanel); item != nil && item.IsChecked() != a.src.open {
		item.SetChecked(a.src.open)
	}
	if item := a.menu.ItemByID(menuIDImport); item != nil && item.IsEnabled() != (a.src.conv != 0) {
		item.SetEnabled(a.src.conv != 0)
	}
}

// toggleDataPanel 展开或收起数据面板。面板依附于聊天页，所以在设置、知识库、技能页时先回到聊天页，否则打开了也看不见。
func (a *app) toggleDataPanel() {
	if !a.src.open && a.onPage() {
		if a.conv == 0 {
			a.nav = ""
		} else {
			a.nav = navOf(a.conv)
		}
	}
	a.toggleSources()
}

// --- 托盘 ---

// trayMenuTemplate 是托盘的最小菜单：显示/隐藏窗口、新对话、退出。
func (a *app) trayMenuTemplate() []*mygo.MenuItem {
	return []*mygo.MenuItem{
		{Label: a.tr("tray.show"), Click: func(*mygo.MenuItem, *mygo.Window) { a.showWindow() }},
		{Label: a.tr("tray.hide"), Click: func(*mygo.MenuItem, *mygo.Window) { a.hideWindow() }},
		mygo.Separator(),
		{Label: a.tr("tray.newChat"), Click: func(*mygo.MenuItem, *mygo.Window) {
			a.newChat()
			a.showWindow()
		}},
		mygo.Separator(),
		{Role: mygo.RoleQuit},
	}
}

// trayIconPNG 画托盘图标：32×32 的黑色柱状图。它是模板图标，macOS 按菜单栏的深浅给它上色。
func trayIconPNG() []byte {
	const size = 32
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	ink := &image.Uniform{C: color.RGBA{A: 0xff}}
	for i, h := range []int{9, 16, 23} {
		x := 5 + i*8
		draw.Draw(img, image.Rect(x, size-7-h, x+5, size-7), ink, image.Point{}, draw.Src)
	}
	draw.Draw(img, image.Rect(4, size-6, size-4, size-4), ink, image.Point{}, draw.Src)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}

// --- 外壳动作 ---

// attachShell 把窗口接到应用外壳：菜单栏、托盘、文件拖放，以及系统语言与外观变化时的重画。
func (a *app) attachShell(win *mygo.Window) {
	a.hooks.show = win.Show
	a.hooks.hide = win.Hide
	a.hooks.isDark = mygo.Theme.IsDark
	a.hooks.setTheme = mygo.Theme.SetSource
	a.hooks.setLocale = mygo.App.SetLocale
	a.hooks.setMenu = mygo.App.SetMenu
	a.hooks.openURL = mygo.Shell.OpenExternal
	a.hooks.openPath = mygo.Shell.OpenPath
	a.hooks.preferred = mygo.App.PreferredLanguages
	a.hooks.message = func(title, body string) {
		// 对话框会阻塞到用户关掉它：放到别的 goroutine 里，主线程继续画界面。
		go func() {
			if _, err := mygo.Dialog.Message(mygo.MessageOptions{Title: title, Message: body}); err != nil {
				log.Printf("about dialog: %v", err)
			}
		}()
	}

	a.menu = a.buildMenu()
	mygo.App.SetMenu(a.menu)
	mygo.Theme.OnUpdated(func() { a.redraw() })
	mygo.App.OnLocaleChanged(func(string) { a.post(func() { a.followLocale() }) })
	// 从别的应用拖进来的文件走数据面板已有的三段式导入。
	win.OnFileDrop(func(e *mygo.FileDropEvent) { a.enqueueImport(e.Paths) })

	tray, err := mygo.NewTray(mygo.TrayOptions{
		ID:             "main",
		Icon:           trayIconPNG(),
		IconIsTemplate: true,
		ToolTip:        "DataWhisper",
		Menu:           mygo.NewMenu(a.trayMenuTemplate()),
	})
	if err != nil {
		// Linux 上没有 AppIndicator 时托盘建不起来，应用照常运行。
		log.Printf("tray: %v", err)
		return
	}
	a.tray = tray
}

// showWindow 显示并聚焦窗口。
func (a *app) showWindow() {
	if a.hooks.show != nil {
		a.hooks.show()
	}
}

// hideWindow 隐藏窗口；应用与托盘图标继续运行。
func (a *app) hideWindow() {
	if a.hooks.hide != nil {
		a.hooks.hide()
	}
}

// openURL 用默认程序打开链接。
func (a *app) openURL(url string) {
	if a.hooks.openURL != nil {
		_ = a.hooks.openURL(url)
	}
}

// openPath 用默认程序打开文件或目录。
func (a *app) openPath(path string) {
	if a.hooks.openPath != nil && path != "" {
		_ = a.hooks.openPath(path)
	}
}

// openServiceLog 打开服务的日志文件；没有日志路径时什么也不做。
func (a *app) openServiceLog() {
	a.openPath(a.logPath)
}

// openDataDir 打开数据目录。
func (a *app) openDataDir() {
	a.openPath(a.dataDir)
}

// about 显示应用名、版本与仓库地址。
func (a *app) about() {
	if a.hooks.message == nil {
		return
	}
	body := a.tr("menu.aboutBody", "name", "DataWhisper", "version", a.appVersion(), "url", repoURL)
	// 第三方声明：内置配色的出处与许可证；图标是 Lucide（ISC）。
	credits := append([]string{"Lucide icons: ISC, https://lucide.dev"}, a.schemes().Credits()...)
	body += "\n\n" + a.tr("menu.aboutCredits") + "\n" + strings.Join(credits, "\n")
	a.hooks.message("DataWhisper", body)
}

// reload 重新拉取当前页面的数据：会话列表、打开着的数据面板，以及已经加载过的设置。
func (a *app) reload() {
	a.refreshConversations()
	a.loadWorkspaces()
	if a.src.open {
		a.loadSources()
	}
	if a.st.loaded {
		a.loadSettings()
	}
}

// --- 文件拖放 ---

// enqueueImport 把拖进来的路径排进导入队列。一次只导入一个：服务端的上传票据与进度都是按单个文件显示的。
func (a *app) enqueueImport(paths []string) {
	if len(paths) == 0 {
		return
	}
	a.src.queue = append(a.src.queue, paths...)
	a.startImport()
}

// startImport 在前一个文件结束后接着导入下一个。uploadFile 自己会处理坏路径与不支持的文件，因此这里不必
// 先过滤。
func (a *app) startImport() {
	for len(a.src.queue) > 0 && !a.src.uploading {
		path := a.src.queue[0]
		a.src.queue = a.src.queue[1:]
		a.uploadFile(path)
	}
}

// savePrefs 保存当前偏好；失败时把原因留在界面上，界面仍然照用户的选择走。-theme/-lang 只对一次运行
// 有效（prefsLocked），这时不写回文件。
func (a *app) savePrefs() {
	if a.prefsLocked {
		return
	}
	if err := prefs.Save(a.prefsPath, a.prefs); err != nil {
		a.prefsErr = err.Error()
		return
	}
	a.prefsErr = ""
}
