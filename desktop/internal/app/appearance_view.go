package app

// 设置页的「外观」分区（docs/refactor/ui-redesign.md §5）：左边是选项，右边是实时预览。所有改动立即生效并
// 保存，界面本身就是预览；右边的迷你对话让人在设置页里也能看到消息、工具卡片与代码块的样子。

import (
	"fmt"
	"sort"
	"strings"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/prefs"
	"github.com/egoist/mygo/ui"
)

// appearanceSettings 画外观分区。
func (a *app) appearanceSettings(c *ui.Context, t *ui.Theme) {
	a.showNotice(c)
	ui.Row(c).Grow(1).MinHeight(0).AlignItems(ui.Stretch).Children(func() {
		ui.Scroll(c).Grow(1).MinWidth(0).Children(func() {
			ui.Column(c).Padding(24, 32).Gap(22).MaxWidth(640).Children(func() {
				a.modeSection(c, t)
				a.schemeSection(c, t)
				a.accentSection(c, t)
				a.layoutSection(c, t)
				a.fontSection(c, t)
				a.themeFilesSection(c, t)
				if a.prefsErr != "" {
					ui.Text(c, a.tr("settings.saveFailed", "error", a.prefsErr)).FontSize(a.fs(textCaption)).TextColor(t.Danger)
				}
				ui.Row(c).Children(func() {
					if ui.Button(c, a.tr("settings.resetAppearance")).Clicked() {
						a.setAppearance(func(ap *prefs.Appearance) { *ap = prefs.DefaultAppearance() })
					}
				})
			})
		})
		a.appearancePreview(c, t)
	})
}

// settingGroup 是一组设置：标题、一行说明（可空）与控件。
func (a *app) settingGroup(c *ui.Context, t *ui.Theme, title, tip string, fn func()) {
	ui.Column(c).Gap(8).Children(func() {
		ui.Text(c, title).Bold().FontSize(a.fs(textSection))
		if tip != "" {
			ui.Text(c, tip).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		}
		fn()
	})
}

// labeledRow 是「标签 + 控件」的一行，标签宽度固定，几行的控件左边对齐。
func (a *app) labeledRow(c *ui.Context, t *ui.Theme, label string, fn func()) {
	ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
		ui.Text(c, label).TextColor(t.TextMuted).Width(120).Shrink(0)
		fn()
	})
}

// segmentedChoice 用分段控件选 values 里的一项；labels 与 values 一一对应。
func (a *app) segmentedChoice(c *ui.Context, label string, current string, values, labels []string, set func(string)) {
	choice := 0
	for i, v := range values {
		if v == current {
			choice = i
		}
	}
	if ui.Segmented(c, &choice, labels...).Label(label).Changed() {
		set(values[choice])
	}
}

// modeSection 是外观模式：跟随系统、亮、暗。
func (a *app) modeSection(c *ui.Context, t *ui.Theme) {
	a.settingGroup(c, t, a.tr("settings.mode"), a.tr("settings.themeTip"), func() {
		a.segmentedChoice(c, a.tr("settings.mode"), a.prefs.Theme,
			[]string{prefs.ThemeSystem, prefs.ThemeLight, prefs.ThemeDark},
			[]string{a.tr("settings.system"), a.tr("settings.light"), a.tr("settings.dark")},
			a.setTheme)
	})
}

// schemeSection 选亮色与暗色各用哪套配色。
func (a *app) schemeSection(c *ui.Context, t *ui.Theme) {
	ap := a.appearance()
	cat := a.schemes()
	a.settingGroup(c, t, a.tr("settings.scheme"), a.tr("settings.schemeTip"), func() {
		for _, dark := range []bool{false, true} {
			list := cat.List(dark)
			names := make([]string, len(list))
			current := ""
			id := ap.LightScheme
			label := a.tr("settings.lightScheme")
			if dark {
				id, label = ap.DarkScheme, a.tr("settings.darkScheme")
			}
			if picked := cat.Pick(id, dark); picked != nil {
				current = picked.Name
			}
			for i, s := range list {
				names[i] = s.Name
			}
			a.labeledRow(c, t, label, func() {
				choice := current
				if ui.Select(c, &choice, names).Label(label).MinWidth(220).Changed() {
					for _, s := range list {
						if s.Name == choice {
							picked, isDark := s.ID, dark
							a.setAppearance(func(ap *prefs.Appearance) {
								if isDark {
									ap.DarkScheme = picked
								} else {
									ap.LightScheme = picked
								}
							})
						}
					}
				}
			})
		}
	})
}

// accentSection 选强调色：配色自带的，配色调色板里的某个颜色（亮暗各取同名色），或自定义。
func (a *app) accentSection(c *ui.Context, t *ui.Theme) {
	ap := a.appearance()
	scheme := a.tokens().Scheme
	a.settingGroup(c, t, a.tr("settings.accent"), a.tr("settings.accentTip"), func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Wrap().Children(func() {
			if ui.Button(c, a.tr("settings.accentDefault")).Disabled(ap.Accent == "").Clicked() {
				a.setAppearance(func(ap *prefs.Appearance) { ap.Accent = "" })
			}
			if scheme != nil {
				for _, name := range scheme.Accents {
					color, ok := scheme.Color(name)
					if !ok {
						continue
					}
					a.swatch(c, t, name, color, ap.Accent == name, func() {
						picked := name
						a.setAppearance(func(ap *prefs.Appearance) { ap.Accent = picked })
					})
				}
			}
			a.customAccent(c, t, ap.Accent)
		})
	})
}

// swatch 是一个圆形色块按钮；选中的那个外面有一圈文字色的描边。
func (a *app) swatch(c *ui.Context, t *ui.Theme, name string, color ui.Color, selected bool, pick func()) {
	ring := t.Background
	if selected {
		ring = t.Text
	}
	if ui.ButtonBase(c).Label(name).Tooltip(name).Children(func() {
		ui.Box(c).Width(22).Height(22).Radius(11).Background(color).Border(2, ring)
	}).Clicked() {
		pick()
	}
}

// customAccent 是「自定义…」：弹出取色器，选定的颜色以 #hex 保存。
func (a *app) customAccent(c *ui.Context, t *ui.Theme, current string) {
	label := a.tr("settings.accentCustom")
	if strings.HasPrefix(current, "#") {
		label = current
	}
	anchor := ui.Button(c, label)
	if anchor.Clicked() {
		a.st.accentOpen = !a.st.accentOpen
		a.st.accentPick = t.Accent
	}
	ui.Popover(c, anchor, &a.st.accentOpen, func() {
		if ui.ColorPicker(c, &a.st.accentPick).Changed() {
			hex := fmt.Sprintf("#%02x%02x%02x", a.st.accentPick.R, a.st.accentPick.G, a.st.accentPick.B)
			a.setAppearance(func(ap *prefs.Appearance) { ap.Accent = hex })
		}
	})
}

// layoutSection 是界面风格、密度、圆角与对话宽度。
func (a *app) layoutSection(c *ui.Context, t *ui.Theme) {
	ap := a.appearance()
	a.settingGroup(c, t, a.tr("settings.layout"), a.tr("settings.layoutTip"), func() {
		a.labeledRow(c, t, a.tr("settings.layoutStyle"), func() {
			a.segmentedChoice(c, a.tr("settings.layoutStyle"), ap.Layout, prefs.Layouts,
				[]string{a.tr("settings.layoutCompact"), a.tr("settings.layoutIslands")},
				func(v string) { a.setAppearance(func(ap *prefs.Appearance) { ap.Layout = v }) })
		})
		a.labeledRow(c, t, a.tr("settings.density"), func() {
			a.segmentedChoice(c, a.tr("settings.density"), ap.Density, prefs.Densities,
				[]string{a.tr("settings.densityCompact"), a.tr("settings.densityStandard"), a.tr("settings.densityComfortable")},
				func(v string) { a.setAppearance(func(ap *prefs.Appearance) { ap.Density = v }) })
		})
		a.labeledRow(c, t, a.tr("settings.radius"), func() {
			a.segmentedChoice(c, a.tr("settings.radius"), ap.Radius, prefs.Radii,
				[]string{a.tr("settings.radiusSquare"), a.tr("settings.radiusStandard"), a.tr("settings.radiusRound")},
				func(v string) { a.setAppearance(func(ap *prefs.Appearance) { ap.Radius = v }) })
		})
		a.labeledRow(c, t, a.tr("settings.chatWidth"), func() {
			a.segmentedChoice(c, a.tr("settings.chatWidth"), ap.ChatWidth, prefs.ChatWidths,
				[]string{a.tr("settings.widthNarrow"), a.tr("settings.widthStandard"), a.tr("settings.widthWide"), a.tr("settings.widthFull")},
				func(v string) { a.setAppearance(func(ap *prefs.Appearance) { ap.ChatWidth = v }) })
		})
	})
}

// fontSection 是界面字体、buffer 字体与回答正文跟哪一种。字体列表是已安装的字体（可搜索），第一项是
// 系统字体；选的字体没装时说明正在用系统字体。
func (a *app) fontSection(c *ui.Context, t *ui.Theme) {
	ap := a.appearance()
	fonts := a.resolvedFonts()
	system := a.tr("settings.systemFont")
	all, mono := []string{system}, []string{system}
	seen := map[string]bool{}
	for _, f := range a.fontFamilies() {
		if seen[f.Name] {
			continue
		}
		seen[f.Name] = true
		all = append(all, f.Name)
		if f.Monospaced {
			mono = append(mono, f.Name)
		}
	}
	sort.Strings(all[1:])
	sort.Strings(mono[1:])
	// buffer 字体先列等宽字体，再列其余：代码与表格多半要等宽，但不强求。
	bufferOptions := append([]string(nil), mono...)
	for _, name := range all[1:] {
		if !hasString(mono, name) {
			bufferOptions = append(bufferOptions, name)
		}
	}
	shown := func(family string, options *[]string) string {
		if family == "" {
			return system
		}
		if !hasString(*options, family) {
			*options = append(*options, family) // 没装的字体也要能显示当前选择
		}
		return family
	}
	fontRow := func(label, tip string, pref prefs.Font, options []string, missing string, minSize, maxSize float64, set func(ap *prefs.Appearance, f prefs.Font)) {
		a.settingGroup(c, t, label, tip, func() {
			a.labeledRow(c, t, a.tr("settings.fontFamily"), func() {
				choice := shown(pref.Family, &options)
				if ui.Combobox(c, &choice, options).Label(label).MinWidth(260).Changed() {
					f := pref
					f.Family = choice
					if choice == system {
						f.Family = ""
					}
					a.setAppearance(func(ap *prefs.Appearance) { set(ap, f) })
				}
			})
			a.labeledRow(c, t, a.tr("settings.fontSize"), func() {
				size := float64(pref.Size)
				if ui.NumberInput(c, &size, minSize, maxSize, 1).Label(label + " " + a.tr("settings.fontSize")).Width(120).Changed() {
					f := pref
					f.Size = float32(size)
					a.setAppearance(func(ap *prefs.Appearance) { set(ap, f) })
				}
			})
			if missing != "" {
				ui.Text(c, a.tr("settings.fontMissing", "font", missing)).FontSize(a.fs(textCaption)).TextColor(t.Warning)
			}
		})
	}
	fontRow(a.tr("settings.uiFont"), a.tr("settings.uiFontTip"), ap.UIFont, all, fonts.UIMissing, 12, 18,
		func(ap *prefs.Appearance, f prefs.Font) { ap.UIFont = f })
	fontRow(a.tr("settings.bufferFont"), a.tr("settings.bufferFontTip"), ap.BufferFont, bufferOptions, fonts.BufferMissing, 11, 18,
		func(ap *prefs.Appearance, f prefs.Font) { ap.BufferFont = f })
	a.settingGroup(c, t, a.tr("settings.bodyFont"), a.tr("settings.bodyFontTip"), func() {
		a.segmentedChoice(c, a.tr("settings.bodyFont"), ap.BodyFont,
			[]string{prefs.BodyFontBuffer, prefs.BodyFontUI},
			[]string{a.tr("settings.bodyBuffer"), a.tr("settings.bodyUI")},
			func(v string) { a.setAppearance(func(ap *prefs.Appearance) { ap.BodyFont = v }) })
	})
}

// themeFilesSection 是用户配色目录：打开它、重新读取，以及读不了的文件和原因。
func (a *app) themeFilesSection(c *ui.Context, t *ui.Theme) {
	a.settingGroup(c, t, a.tr("settings.themeFiles"), a.tr("settings.themeFilesTip"), func() {
		ui.Row(c).Gap(8).Children(func() {
			if ui.Button(c, a.tr("settings.openThemes")).Disabled(a.dataDir == "").Clicked() {
				a.openThemesDir()
			}
			if ui.Button(c, a.tr("settings.reloadThemes")).Clicked() {
				a.reloadSchemes()
			}
		})
		if problems := a.schemes().Problems; len(problems) > 0 {
			ui.Text(c, a.tr("settings.themeProblems")).FontSize(a.fs(textCaption)).TextColor(t.Warning)
			for _, p := range problems {
				a.buffer(ui.Text(c, p)).TextColor(t.TextMuted).Selectable()
			}
		}
	})
}

// appearancePreview 是右侧的迷你对话：用户气泡、思考、工具卡片与带表格和代码的回答，用的是真正的消息组件。
func (a *app) appearancePreview(c *ui.Context, t *ui.Theme) {
	messages := []conversation.Message{
		{Key: "preview:q", Role: "user", Text: a.tr("settings.previewQuestion"), Done: true},
		{Key: "preview:th", Role: "thinking", Text: a.tr("settings.previewThinking"), Done: true},
		{Key: "preview:tool", Role: "tool", Done: true, Tool: &conversation.ToolCall{
			Name: "query_data", Args: "sql=SELECT region, SUM(amount) FROM sales GROUP BY 1",
			Output: "华东  270\n华北  200\n华南  140", Status: "ok", DurationMS: 412,
		}},
		{Key: "preview:a", Role: "assistant", Text: a.tr("settings.previewAnswer"), Done: true},
	}
	panel := ui.Column(c).Width(400).Shrink(0).Padding(20).Gap(12).Background(a.tokens().Tok.Sidebar)
	if !a.islands() {
		panel = panel.BorderWidth(0, 0, 0, 1).BorderColor(t.Border)
	}
	panel.Children(func() {
		ui.Text(c, a.tr("settings.preview")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		ui.Scroll(c).Grow(1).MinHeight(0).Children(func() {
			ui.Column(c).Gap(12).Padding(16).Radius(radiusCard).Background(t.Background).BorderWidth(1).BorderColor(t.Border).Children(func() {
				for _, m := range messages {
					a.message(c, m)
				}
			})
		})
	})
}
