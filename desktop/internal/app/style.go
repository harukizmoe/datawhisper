package app

// 界面的排版层级与常用控件组合。字号都相对 UI 字号（外观里的「字号」）计算，用户调大字号时层级整体放大；
// 颜色与字体只经由 a.tokens()（appearance.go，解析见 internal/theme）取。

import (
	"datawhisper/desktop/internal/prefs"
	"github.com/egoist/mygo/ui"
)

// textRole 是一段文字在层级里的位置。
type textRole int

const (
	textCaption textRole = iota // 辅助说明、元数据、徽标
	textSmall                   // 次要正文、列表里的第二行
	textBody                    // 正文
	textSection                 // 区块标题
	textTitle                   // 页面标题
	textHero                    // 首页问候
)

// roleOffsets 是各层级相对 UI 字号的差（默认 14 时为 12 / 13 / 14 / 16 / 20 / 28）。
var roleOffsets = [...]float32{-2, -1, 0, 2, 6, 14}

// fs 返回某个层级的字号。
func (a *app) fs(r textRole) float32 {
	base := a.tokens().Fonts.UISize
	if base <= 0 {
		base = prefs.DefaultUIFontSize
	}
	return base + roleOffsets[r]
}

// 圆角：控件用主题自己的 Radius，卡片与气泡更圆（参考 Tern 的大圆角卡片）。
const (
	radiusCard   = 12
	radiusBubble = 16
)

// buffer 把一段文字换成 buffer 字体（代码、SQL、schema、数据表、工具输出）。
func (a *app) buffer(e ui.Element) ui.Element {
	f := a.tokens().Fonts
	if f.BufferSize > 0 {
		e = e.FontSize(f.BufferSize)
	}
	return e.Font(f.Buffer)
}

// iconButton 是只有图标的按钮；Label 让辅助技术与测试按名字找到它，Tooltip 告诉鼠标用户它是什么。
func iconButton(c *ui.Context, icon *ui.SVG, label string) ui.Element {
	return ui.Button(c, "").Label(label).Tooltip(label).Children(func() {
		ui.Icon(c, icon)
	})
}

// ghostIconButton 是侧栏里用的轻量图标按钮：平时只有一个淡色图标，悬停才出底色，不抢名字的权重。
// label 同时是辅助技术的名字与悬停提示。
func ghostIconButton(c *ui.Context, icon *ui.SVG, label string) ui.Element {
	t := c.Theme()
	b := ui.ButtonBase(c).Label(label).Tooltip(label).Padding(6).Radius(6).Shrink(0)
	if b.Hovered() {
		b = b.Background(t.Border.Alpha(0.6))
	}
	return b.Children(func() {
		ui.Icon(c, icon).TextColor(t.TextMuted)
	})
}

// iconTextButton 是图标加文字的按钮。
func iconTextButton(c *ui.Context, icon *ui.SVG, label string) ui.Element {
	return ui.Button(c, "").Label(label).Children(func() {
		ui.Icon(c, icon)
		ui.Text(c, label).SingleLine()
	})
}

// primaryIconButton 是强调色的图标按钮（发送）。
func primaryIconButton(c *ui.Context, icon *ui.SVG, label string) ui.Element {
	return ui.PrimaryButton(c, "").Label(label).Tooltip(label).Children(func() {
		ui.Icon(c, icon)
	})
}

// primaryIconTextButton 是强调色的图标加文字按钮。
func primaryIconTextButton(c *ui.Context, icon *ui.SVG, label string) ui.Element {
	return ui.PrimaryButton(c, "").Label(label).Children(func() {
		ui.Icon(c, icon)
		ui.Text(c, label).SingleLine()
	})
}
