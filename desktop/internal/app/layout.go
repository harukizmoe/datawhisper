package app

// 窗口骨架：侧边栏、主区域与数据面板的分栏，以及服务状态横幅。

import (
	"fmt"
	"strings"
	"time"

	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/prefs"
	"datawhisper/desktop/internal/service"
	"datawhisper/desktop/internal/supervisor"
	"github.com/egoist/mygo/ui"
)

// view 构建整个窗口：侧边栏，以及聊天页或设置页；聊天页可以再分出右侧的数据面板。
func (a *app) view(c *ui.Context) {
	// 外观在构建任何东西之前定下来：显式选了浅色或深色时，整帧都用选的那一种。
	a.useTheme(c)
	t := c.Theme()
	root := ui.Row(c).Fill().AlignItems(ui.Stretch)
	if a.islands() {
		root = root.Background(a.tokens().Tok.Canvas).Padding(islandGap).Gap(islandGap)
	}
	root.Children(func() {
		a.sidebar(c)
		main := ui.Column(c).Grow(1).MinWidth(0)
		if a.islands() && !(!a.onPage() && a.src.open) {
			main = a.island(main.Background(t.Background))
		}
		main.Children(func() {
			switch {
			case a.nav == navSettings:
				a.settings(c)
			case a.nav == navKnowledge:
				a.knowledgePage(c)
			case a.nav == navSkills:
				a.skillsPage(c)
			case a.src.open:
				// Islands 下对话与数据面板各是一座岛，分栏的拖动条落在两座岛之间的间隙里。
				ui.SplitPercent(c, &a.src.split, func() {
					chat := ui.Column(c).Grow(1).MinWidth(0)
					if a.islands() {
						chat = a.island(chat.Background(t.Background)).Margin(0, islandGap/2, 0, 0)
					}
					chat.Children(func() { a.chatPage(c) })
				}, func() {
					a.sourcesPanel(c)
				}).Fill()
			default:
				a.chatPage(c)
			}
		})
	})
	// 弹窗画在窗口根上，不被数据面板的分割线裁掉。
	a.paletteShortcuts(c)
	a.paletteModal(c)
	a.sessionModals(c)
	a.chatModals(c)
	a.richModals(c)
	// 菜单项的勾选与可用状态跟着界面走（数据面板是否打开、能不能导入）。
	a.syncMenu()
}

func (a *app) sidebar(c *ui.Context) {
	t := c.Theme()
	tok := a.tokens().Tok
	side := ui.Column(c).Width(248).Shrink(0).Padding(14, 10).Gap(10).Background(tok.Sidebar)
	if a.islands() {
		side = a.island(side)
	} else {
		side = side.BorderWidth(0, 1, 0, 0).BorderColor(t.Border)
	}
	side.Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(2, 8).Children(func() {
			ui.Icon(c, icons.Sparkles).TextColor(t.Accent)
			ui.Text(c, "DataWhisper").Bold().FontSize(a.fs(textSection)).SingleLine()
		})
		// 「New chat」永远是普通聊天；要在某个工作区里开始，点工作区那一行的加号。
		if iconTextButton(c, icons.Plus, a.tr("sidebar.newChat")).Clicked() {
			a.setNewScope("")
			a.newChat()
		}
		if a.ws.err != "" {
			ui.Text(c, a.ws.err).FontSize(a.fs(textCaption)).TextColor(t.Danger).Padding(2, 8)
		}
		ui.SearchField(c, &a.sideSearch).Label(a.tr("sidebar.search")).Placeholder(a.tr("sidebar.search"))
		a.maybeSearch(c)
		groups := a.sessionGroups(c.Now())
		hits := a.bodyHits(groups)
		archived := a.archivedSessions()
		if ui.Sidebar(c, &a.nav, func() {
			// 工作区区在最上面，权重高于时间分组；属于工作区的会话只在这里出现，不再进「今天」。
			a.workspaceSection(c, t)
			for _, g := range groups {
				ui.SidebarSection(c, g.label, nil, func() {
					for _, session := range g.sessions {
						a.sessionItem(c, session)
					}
				})
			}
			if len(hits) > 0 {
				ui.SidebarSection(c, a.tr("sidebar.bodyMatches"), nil, func() {
					for _, h := range hits {
						ui.SidebarItem(c, navOf(h.ID), icons.Search, a.sessionTitleOr(h.ID, h.Title)).Tooltip(h.Snippet)
					}
				})
			}
			if len(archived) > 0 {
				ui.SidebarSection(c, a.tr("sidebar.archived"), nil, func() {
					for _, session := range archived {
						a.sessionItem(c, session)
					}
				})
			}
			switch {
			case a.listErr != "":
				ui.Text(c, a.tr("sidebar.listFailed")).FontSize(a.fs(textCaption)).TextColor(t.Danger).Padding(4, 8)
			case a.listLoaded && len(a.sessions) == 0:
				ui.Text(c, a.tr("sidebar.empty")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Padding(4, 8)
			case a.sideSearch != "" && len(groups) == 0 && len(hits) == 0:
				ui.Text(c, a.tr("sidebar.noMatch")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Padding(4, 8)
			}
		}).Grow(1).Background(tok.Sidebar).Label(a.tr("chat.navigation")).Changed() {
			a.navigate()
		}
		if a.sess.err != "" {
			ui.Text(c, a.sess.err).FontSize(a.fs(textCaption)).TextColor(t.Danger).Padding(2, 8)
		}
		// 应用入口固定在底部：会话多起来时只有上面的会话列表滚动，入口不会被挤出去。两个 Sidebar 共用 a.nav，
		// 选中项按 ID 对上，各管各的键盘导航。
		if ui.Sidebar(c, &a.nav, func() {
			ui.SidebarSection(c, a.tr("sidebar.app"), nil, func() {
				ui.SidebarItem(c, navData, icons.Database, a.tr("sidebar.data"))
				ui.SidebarItem(c, navKnowledge, icons.Knowledge, a.tr("sidebar.knowledge"))
				ui.SidebarItem(c, navSkills, icons.Skill, a.tr("sidebar.skills"))
				ui.SidebarItem(c, navSettings, icons.Settings, a.tr("sidebar.settings"))
			})
		}).Background(tok.Sidebar).Label(a.tr("sidebar.app")).Changed() {
			a.navigate()
		}
	})
}

// statusLabel 返回服务状态的名称，供「服务不可用」与诊断文字使用。
func (a *app) statusLabel() string {
	switch a.service.State {
	case supervisor.StateReady:
		return a.tr("status.ready")
	case supervisor.StateStarting:
		return a.tr("status.starting")
	case supervisor.StateRestarting:
		return a.tr("status.restarting")
	case supervisor.StateFailed:
		return a.tr("status.failed")
	}
	return a.tr("status.stopped")
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

// islandGap 是 Islands 风格下岛与岛、岛与窗口边缘之间的间隙。
const islandGap = 8

// islands 报告当前是不是 Islands 界面风格。
func (a *app) islands() bool { return a.appearance().Layout == prefs.LayoutIslands }

// island 把一个区域画成圆角的岛；内容按圆角裁切，滚动条与分隔线不会画出圆角之外。
func (a *app) island(e ui.Element) ui.Element {
	return e.Radius(radiusCard).Clip()
}

// sessionGroup 是侧栏里的一组会话。
type sessionGroup struct {
	label string // 已翻译的组名
	// workspaceID 非空表示这是某个工作区的分组（可折叠）；时间分组为空。
	workspaceID string
	sessions    []service.Session
}

// sessionGroups 把普通聊天按「置顶 / 今天 / 昨天 / 7 天内 / 更早」分组（服务端已按更新时间倒序），归档的与
// 属于工作区的不显示；搜索框有字时只留标题里包含它的会话（不分大小写）。
func (a *app) sessionGroups(now time.Time) []sessionGroup {
	query := strings.ToLower(strings.TrimSpace(a.sideSearch))
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	buckets := []sessionGroup{{label: a.tr("sidebar.pinned")}, {label: a.tr("sidebar.today")}, {label: a.tr("sidebar.yesterday")}, {label: a.tr("sidebar.week")}, {label: a.tr("sidebar.earlier")}}
	for _, s := range a.sessions {
		if s.Archived {
			continue
		}
		// 属于工作区的会话由 workspaceGroups 单独成组，这里只留普通聊天。
		if a.scopeOf(s.ID) != "" {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(a.sessionTitle(s.ID)), query) {
			continue
		}
		i := 4
		switch {
		case s.Pinned:
			i = 0
		case s.UpdatedAt == nil:
			i = 1 // 还没有消息的新会话放在「今天」
		default:
			at := time.UnixMilli(*s.UpdatedAt)
			switch {
			case !at.Before(day):
				i = 1
			case !at.Before(day.AddDate(0, 0, -1)):
				i = 2
			case !at.Before(day.AddDate(0, 0, -7)):
				i = 3
			}
		}
		buckets[i].sessions = append(buckets[i].sessions, s)
	}
	var out []sessionGroup
	for _, g := range buckets {
		if len(g.sessions) > 0 {
			out = append(out, g)
		}
	}
	return out
}

// sessionItem 是侧栏里的一个会话：右键菜单里有重命名、置顶与归档（服务端没有对应功能时不显示那一项）。
func (a *app) sessionItem(c *ui.Context, s service.Session) {
	id := s.ID
	ui.SidebarItem(c, navOf(id), nil, a.sessionTitle(id)).PopoverMenu(func(m *ui.Menu) {
		if m.Item(a.tr("chat.rename")).Chosen() {
			if a.conv != id {
				a.nav = navOf(id)
				a.navigate()
			}
			a.openRename()
		}
		pin := a.tr("sidebar.pin")
		if s.Pinned {
			pin = a.tr("sidebar.unpin")
		}
		if m.Item(pin).Chosen() {
			a.setSessionFlag(id, "pinned", !s.Pinned)
		}
		archive := a.tr("sidebar.archive")
		if s.Archived {
			archive = a.tr("sidebar.unarchive")
		}
		if m.Item(archive).Chosen() {
			a.setSessionFlag(id, "archived", !s.Archived)
		}
		if m.Item(a.tr("sidebar.export")).Chosen() {
			a.exportSession(id)
		}
		m.Separator()
		if m.Item(a.tr("sidebar.delete")).Chosen() {
			a.askDeleteSession(id)
		}
	})
}
