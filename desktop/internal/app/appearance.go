package app

// 外观的应用：按偏好与系统亮暗解析主题（internal/theme）、缓存到每一帧、切换时通知图表页面。菜单与偏好写入在 shell.go。

import (
	"log"
	"os"

	"datawhisper/desktop/internal/prefs"
	"datawhisper/desktop/internal/theme"
	"github.com/egoist/mygo/ui"
)

// themeCache 缓存解析好的外观：亮、暗各一份，外观偏好或配色目录变化时清空。
type themeCache struct {
	catalog    *theme.Catalog
	fonts      *theme.Fonts
	light      *theme.Resolved
	dark       *theme.Resolved
	current    *theme.Resolved
	lastDark   bool
	everDrawn  bool
	fontFamily func() []ui.FontFamily // 测试换成固定列表；nil 时用 ui.FontFamilies
	families   []ui.FontFamily        // 已安装字体的缓存：第一次读取较慢，外观页与字体解析共用
	listed     bool
}

// invalidateTheme 丢掉缓存，下一帧按新的偏好重新解析。
func (a *app) invalidateTheme() {
	a.theme.light, a.theme.dark, a.theme.current, a.theme.fonts = nil, nil, nil, nil
}

// reloadSchemes 重新读用户配色目录（外观页的「重新加载主题」）。
func (a *app) reloadSchemes() {
	a.theme.catalog = nil
	a.invalidateTheme()
	a.redraw()
}

func (a *app) schemes() theme.Catalog {
	if a.theme.catalog == nil {
		cat := theme.LoadCatalog(theme.UserDir(a.dataDir))
		for _, p := range cat.Problems {
			log.Printf("theme: %s", p)
		}
		a.theme.catalog = &cat
	}
	return *a.theme.catalog
}

// resolvedFonts 对照已安装的字体解析字体偏好。字体列表首次读取较慢（字体多时数十毫秒），只在偏好变化后读一次。
func (a *app) resolvedFonts() theme.Fonts {
	if a.theme.fonts == nil {
		fc := theme.ResolveFonts(a.appearance(), a.fontFamilies())
		if fc.UIMissing != "" || fc.BufferMissing != "" {
			log.Printf("theme: font not installed, using the system font (ui %q, buffer %q)", fc.UIMissing, fc.BufferMissing)
		}
		a.theme.fonts = &fc
	}
	return *a.theme.fonts
}

// appearance 返回校验过的外观偏好：没从 ui.json 读过（版本为 0）时就是默认值。
func (a *app) appearance() prefs.Appearance {
	if a.prefs.Appearance.Version == 0 {
		return prefs.DefaultAppearance()
	}
	return a.prefs.Appearance
}

// themeFor 返回亮或暗的解析结果（缓存）。
func (a *app) themeFor(dark bool) *theme.Resolved {
	slot := &a.theme.light
	ap := a.appearance()
	id := ap.LightScheme
	if dark {
		slot, id = &a.theme.dark, ap.DarkScheme
	}
	if *slot == nil {
		rt := theme.Resolve(a.schemes().Pick(id, dark), dark, ap.Accent, a.resolvedFonts())
		rt.UI.Spacing, rt.UI.Radius = theme.Metrics(ap.Density, ap.Radius)
		*slot = rt
	}
	return *slot
}

// tokens 返回当前帧的外观；还没画过第一帧时按偏好推断亮暗。
func (a *app) tokens() *theme.Resolved {
	if a.theme.current == nil {
		a.theme.current = a.themeFor(a.effectiveDark())
	}
	return a.theme.current
}

// useTheme 在构建一帧之前把外观套到这一帧上：显式选择浅色或深色时用选的那一种，跟随系统时看窗口报告的外观。
// 亮暗变化时通知已打开的图表页面换配色。
func (a *app) useTheme(c *ui.Context) {
	dark := a.effectiveDark()
	if a.prefs.Theme != prefs.ThemeLight && a.prefs.Theme != prefs.ThemeDark && a.hooks.isDark == nil {
		// 没有窗口钩子（测试）时，c.Theme() 在 SetTheme 之前就是系统的外观。
		dark = c.Theme().Dark
	}
	rt := a.themeFor(dark)
	c.SetTheme(rt.UI)
	a.md.Theme = rt.MD
	changed := a.theme.current != rt
	a.theme.current = rt
	if changed && a.theme.everDrawn {
		a.rich.ApplyTheme(rt.Chart)
	}
	a.theme.everDrawn = true
	a.theme.lastDark = dark
}

// effectiveDark 报告界面此刻是不是深色的：显式选择优先，否则问系统。
func (a *app) effectiveDark() bool {
	switch a.prefs.Theme {
	case prefs.ThemeLight:
		return false
	case prefs.ThemeDark:
		return true
	}
	if a.hooks.isDark != nil {
		return a.hooks.isDark()
	}
	return a.theme.lastDark
}

// fontFamilies 返回已安装的字体（缓存）。字体在应用运行中安装的话，重启后才出现，与 ui.FontFamilies 一致。
func (a *app) fontFamilies() []ui.FontFamily {
	if !a.theme.listed {
		list := a.theme.fontFamily
		if list == nil {
			list = ui.FontFamilies
		}
		a.theme.families, a.theme.listed = list(), true
	}
	return a.theme.families
}

// setAppearance 改一项外观偏好并立即生效：校验、保存（-theme/-lang 锁定的运行不写文件）、丢掉主题缓存后重画；
// 主题变了的话，下一帧的 useTheme 会顺带把新配色推给已打开的图表页面。
func (a *app) setAppearance(change func(ap *prefs.Appearance)) {
	ap := a.appearance()
	change(&ap)
	ap = prefs.NormalizeAppearance(ap)
	if ap == a.appearance() {
		return
	}
	a.prefs.Appearance = ap
	a.savePrefs()
	a.invalidateTheme()
	a.redraw()
}

// openThemesDir 打开用户配色目录，没有时先建好，用户才有地方放 .json 文件。
func (a *app) openThemesDir() {
	dir := theme.UserDir(a.dataDir)
	if dir == "" {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("theme: %v", err)
		return
	}
	a.openPath(dir)
}
