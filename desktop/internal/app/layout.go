package app

// 窗口骨架：侧边栏、主区域与数据面板的分栏，以及服务状态横幅。

import (
	"fmt"

	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/supervisor"
	"github.com/egoist/mygo/ui"
)

// view 构建整个窗口：侧边栏，以及聊天页或设置页；聊天页可以再分出右侧的数据面板。
func (a *app) view(c *ui.Context) {
	// 外观在构建任何东西之前定下来：显式选了浅色或深色时，整帧都用选的那一种。
	a.useTheme(c)
	ui.Row(c).Fill().AlignItems(ui.Stretch).Children(func() {
		a.sidebar(c)
		ui.Column(c).Grow(1).MinWidth(0).Children(func() {
			switch {
			case a.nav == navSettings:
				a.settings(c)
			case a.src.open:
				ui.SplitPercent(c, &a.src.split, func() {
					ui.Column(c).Grow(1).MinWidth(0).Children(func() { a.chatPage(c) })
				}, func() {
					a.sourcesPanel(c)
				}).Fill()
			default:
				a.chatPage(c)
			}
		})
	})
	// 弹窗画在窗口根上，不被数据面板的分割线裁掉。
	a.chatModals(c)
	a.richModals(c)
	// 菜单项的勾选与可用状态跟着界面走（数据面板是否打开、能不能导入）。
	a.syncMenu()
}

func (a *app) sidebar(c *ui.Context) {
	t := c.Theme()
	tok := a.tokens().Tok
	ui.Column(c).Width(248).Shrink(0).Padding(14, 10).Gap(10).Background(tok.Sidebar).BorderWidth(0, 1, 0, 0).BorderColor(t.Border).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(2, 8).Children(func() {
			ui.Icon(c, icons.Sparkles).TextColor(t.Accent)
			ui.Text(c, "DataWhisper").Bold().FontSize(a.fs(textSection)).SingleLine()
		})
		ui.Row(c).Children(func() {
			if iconTextButton(c, icons.Plus, a.tr("sidebar.newChat")).Grow(1).Clicked() {
				a.newChat()
			}
		})
		if ui.Sidebar(c, &a.nav, func() {
			ui.SidebarSection(c, a.tr("sidebar.chats"), nil, func() {
				for _, session := range a.sessions {
					title := a.sessionTitle(session.ID)
					ui.SidebarItem(c, navOf(session.ID), nil, title)
				}
				switch {
				case a.listErr != "":
					ui.Text(c, a.tr("sidebar.listFailed")).FontSize(a.fs(textCaption)).TextColor(t.Danger).Padding(4, 8)
				case a.listLoaded && len(a.sessions) == 0:
					ui.Text(c, a.tr("sidebar.empty")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Padding(4, 8)
				}
			})
			ui.SidebarSection(c, a.tr("sidebar.app"), nil, func() {
				ui.SidebarItem(c, navData, icons.Database, a.tr("sidebar.data"))
				ui.SidebarItem(c, navSettings, icons.Settings, a.tr("sidebar.settings"))
			})
		}).Grow(1).Background(tok.Sidebar).Label("Navigation").Changed() {
			a.navigate()
		}
	})
}

// statusLabel 给状态指示器返回服务状态的名称及其颜色。
func (a *app) statusLabel(t *ui.Theme) (string, ui.Color) {
	switch a.service.State {
	case supervisor.StateReady:
		return a.tr("status.ready"), t.Success
	case supervisor.StateStarting:
		return a.tr("status.starting"), t.Warning
	case supervisor.StateRestarting:
		return a.tr("status.restarting"), t.Warning
	case supervisor.StateFailed:
		return a.tr("status.failed"), t.Danger
	}
	return a.tr("status.stopped"), t.TextMuted
}

// banner 在有东西妨碍聊天时说明原因：服务正在启动、重启或已失败，或者会话的订阅断了；另外在重启之后的一小
// 段时间里，提示服务已经回来。
func (a *app) banner(c *ui.Context) {
	t := c.Theme()
	var text string
	var tone ui.Color
	busy, retry := false, false
	switch a.service.State {
	case supervisor.StateStopped:
		text, tone = a.tr("banner.stopped"), t.TextMuted
	case supervisor.StateStarting:
		text, tone, busy = a.tr("banner.starting"), t.Accent, true
	case supervisor.StateRestarting:
		text, tone, busy = a.tr("banner.restarting", "error", fmt.Sprint(a.service.Err)), t.Warning, true
	case supervisor.StateFailed:
		text, tone, retry = a.tr("banner.failed", "error", fmt.Sprint(a.service.Err)), t.Danger, a.retry != nil
		if a.logPath != "" {
			text += a.tr("banner.failedLog", "path", a.logPath)
		}
	case supervisor.StateReady:
		switch {
		case a.streamErr != "" && a.streamRetrying:
			text, tone, busy = a.tr("banner.reconnecting", "error", a.streamErr), t.Warning, true
		case a.streamErr != "":
			text, tone = a.tr("banner.streamFailed", "error", a.streamErr), t.Danger
		case a.recovered:
			now := c.Now()
			if a.recoveredAt.IsZero() {
				a.recoveredAt = now
			}
			if left := reconnectedFor - now.Sub(a.recoveredAt); left > 0 {
				text, tone = a.tr("banner.reconnected"), t.Success
				c.After(left)
			} else {
				a.recovered = false
			}
		}
	}
	if text == "" {
		return
	}
	ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(10, 24).Background(tone.Alpha(0.12)).BorderWidth(0, 0, 1, 0).BorderColor(tone.Alpha(0.35)).Children(func() {
		if busy {
			ui.Spinner(c)
		}
		ui.Text(c, text).Grow(1).MinWidth(0)
		if retry && ui.Button(c, a.tr("banner.retry")).Clicked() {
			a.retry()
		}
	})
}
