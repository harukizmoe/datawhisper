package app

// 命令面板（Ctrl+K，macOS 上 Cmd+K）：一个搜索框加一列结果，覆盖常用动作与会话跳转。↑/↓ 选择，Enter 执行，
// Esc 关闭；鼠标点一项也执行。动作与菜单栏的条目对应，菜单栏隐藏时这里是键盘用户的主要入口。

import (
	"runtime"
	"strings"

	"datawhisper/desktop/internal/icons"
	"github.com/egoist/mygo/ui"
)

// primaryMod 是平台的主修饰键：macOS 是 Command，其他平台是 Ctrl。
var primaryMod = func() ui.Modifiers {
	if runtime.GOOS == "darwin" {
		return ui.Super
	}
	return ui.Ctrl
}()

// paletteMax 是一次最多列出的结果数。
const paletteMax = 12

type paletteState struct {
	open  bool
	query string
	sel   int
}

// paletteItem 是一条结果：文字、右侧的提示（快捷键或「会话」），以及选中后要做的事。
type paletteItem struct {
	label string
	hint  string
	icon  *ui.SVG
	run   func()
}

// openPalette 打开命令面板，清空上次的输入。
func (a *app) openPalette() {
	a.palette = paletteState{open: true}
}

// paletteItems 列出当前可用的动作与会话，按输入过滤（不分大小写的包含匹配），动作在前。
func (a *app) paletteItems() []paletteItem {
	actions := []paletteItem{
		{a.tr("sidebar.newChat"), shortcutHint("N"), icons.Plus, a.newChat},
		{a.tr("palette.toggleData"), shortcutHint("D"), icons.PanelRight, a.toggleDataPanel},
		{a.tr("palette.runs"), "", icons.ListChecks, func() {
			if !a.src.open {
				a.toggleSources()
			}
			a.src.tab = sourcesTabRuns
		}},
		{a.tr("palette.artifacts"), "", icons.Chart, func() {
			if !a.src.open {
				a.toggleSources()
			}
			a.src.tab = sourcesTabArtifacts
		}},
		{a.tr("sidebar.settings"), shortcutHint(","), icons.Settings, a.openSettings},
		{a.tr("palette.appearance"), "", icons.Sparkles, func() {
			a.openSettings()
			a.st.tab = settingsTabAppearance
		}},
		{a.tr("palette.toggleTheme"), shortcutHint("Shift+T"), icons.Moon, a.toggleTheme},
	}
	query := strings.ToLower(strings.TrimSpace(a.palette.query))
	var out []paletteItem
	for _, it := range actions {
		if query == "" || strings.Contains(strings.ToLower(it.label), query) {
			out = append(out, it)
		}
	}
	for _, s := range a.sessions {
		if s.Archived {
			continue
		}
		title := a.sessionTitle(s.ID)
		if query != "" && !strings.Contains(strings.ToLower(title), query) {
			continue
		}
		id := s.ID
		out = append(out, paletteItem{title, a.tr("palette.chat"), icons.Chat, func() {
			a.nav = navOf(id)
			a.navigate()
		}})
	}
	if len(out) > paletteMax {
		out = out[:paletteMax]
	}
	return out
}

// shortcutHint 把一个按键写成平台的快捷键提示（Ctrl+N、⌘N）。
func shortcutHint(key string) string {
	if runtime.GOOS == "darwin" {
		return "⌘" + strings.ReplaceAll(key, "Shift+", "⇧")
	}
	return "Ctrl+" + key
}

// runPaletteItem 执行一条结果并关闭面板。
func (a *app) runPaletteItem(it paletteItem) {
	a.palette.open = false
	it.run()
}

// paletteShortcuts 注册打开命令面板的快捷键；在窗口根上调用，任何页面都有效。
func (a *app) paletteShortcuts(c *ui.Context) {
	c.OnShortcut(primaryMod, ui.KeyK, a.openPalette)
}

// paletteModal 画命令面板。
func (a *app) paletteModal(c *ui.Context) {
	if !a.palette.open {
		return
	}
	t := c.Theme()
	items := a.paletteItems()
	if a.palette.sel >= len(items) {
		a.palette.sel = len(items) - 1
	}
	if a.palette.sel < 0 {
		a.palette.sel = 0
	}
	ui.Modal(c, &a.palette.open, func() {
		ui.Column(c).Width(560).Gap(4).AlignItems(ui.Stretch).Children(func() {
			ui.SearchField(c, &a.palette.query).Label(a.tr("palette.label")).Placeholder(a.tr("palette.placeholder")).AutoFocus().
				OnTextKey(func(k ui.TextKey) bool {
					switch {
					case k.Key == ui.KeyDown && k.Mods == 0:
						if a.palette.sel < len(items)-1 {
							a.palette.sel++
						}
						return true
					case k.Key == ui.KeyUp && k.Mods == 0:
						if a.palette.sel > 0 {
							a.palette.sel--
						}
						return true
					case k.Key == ui.KeyEnter && k.Mods == 0:
						if len(items) > 0 {
							a.runPaletteItem(items[a.palette.sel])
						}
						return true
					}
					return false
				})
			if len(items) == 0 {
				ui.Text(c, a.tr("palette.none")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Padding(6, 8)
				return
			}
			for i, it := range items {
				selected := i == a.palette.sel
				row := ui.ButtonBase(c).Label(it.label).Grow(1).Children(func() {
					bg := t.Background
					if selected {
						bg = t.SurfaceHover
					}
					ui.Row(c).Grow(1).Gap(10).AlignItems(ui.Center).Padding(7, 10).Radius(t.Radius).Background(bg).Children(func() {
						ui.Icon(c, it.icon).TextColor(t.TextMuted)
						ui.Text(c, it.label).SingleLine().Grow(1).MinWidth(0)
						if it.hint != "" {
							a.buffer(ui.Text(c, it.hint)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Shrink(0)
						}
					})
				})
				if row.Clicked() {
					a.runPaletteItem(it)
				}
			}
		})
	})
}
