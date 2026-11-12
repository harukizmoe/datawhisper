package app

// 输入区的折叠（参考 Tern）：没有焦点、也没有草稿时，输入卡片收成一行——上一条提问的第一行加本会话的花费；
// 点一下展开并取得焦点。回复进行中折叠行里留一个停止按钮。

import (
	"strings"
	"time"

	"datawhisper/desktop/internal/icons"
	"github.com/egoist/mygo/ui"
)

// composerGrace 是输入区失去焦点后多久才折叠。
const composerGrace = 400 * time.Millisecond

// sessionCost 是这个会话到目前为止各次回复的费用之和。
func (a *app) sessionCost() float64 {
	var total float64
	for _, m := range a.chat.Messages {
		if m.Usage != nil {
			total += m.Usage.Cost
		}
	}
	return total
}

// menuShown 由芯片菜单的 build 回调调用：告诉输入区此刻有菜单开着，别折叠。
func (a *app) menuShown() { a.cv.menuOpen = true }

// collapsedComposer 画折叠成一行的输入区。
func (a *app) collapsedComposer(c *ui.Context, busy bool) {
	t := c.Theme()
	hint := a.tr("chat.placeholder")
	for i := len(a.chat.Messages) - 1; i >= 0; i-- {
		if m := a.chat.Messages[i]; m.Role == "user" && strings.TrimSpace(m.Text) != "" {
			hint = oneLine(m.Text, 120)
			break
		}
	}
	frosted(ui.Row(c).Gap(6).AlignItems(ui.Center).Radius(composerRadius).BorderWidth(1).BorderColor(t.Border), t.Surface, composerRadius).Padding(6, 10).Children(func() {
		if ui.ButtonBase(c).Label(a.tr("chat.expandComposer")).Grow(1).MinWidth(0).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(6, 6).Children(func() {
				ui.Text(c, hint).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Italic().SingleLine().Grow(1).MinWidth(0)
				if cost := a.sessionCost(); cost > 0 {
					a.buffer(ui.Text(c, formatCost(cost))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Shrink(0)
				}
			})
		}).Clicked() {
			a.cv.composerSeen, a.cv.wantFocus, a.cv.blurSince = false, true, time.Time{}
		}
		if busy {
			if iconButton(c, icons.Stop, a.tr("chat.stop")).Radius(999).Tooltip(a.tr("chat.stopTip")).Shrink(0).Clicked() {
				a.abort()
			}
		}
	})
}
