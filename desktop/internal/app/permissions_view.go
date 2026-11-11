package app

import (
	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/service"

	"github.com/egoist/mygo/ui"
)

// modeChip 是输入框底栏里的权限模式芯片（参考 Claude Code）：点开是五档模式的菜单，当前的一档带单选标记。
// 只在工作区对话里出现——普通聊天没有会改文件的工具，也就没有模式。
func (a *app) modeChip(c *ui.Context) {
	t := c.Theme()
	mode := a.perm.scope.Mode
	chip := ui.PopoverMenuButton(c, a.modeLabel(mode), func(m *ui.Menu) {
		for _, option := range permissionModes {
			option := option
			if m.Item(a.modeLabel(option) + "  ·  " + a.modeDescription(option)).Radio(option == mode).Chosen() {
				a.setPermissionMode(option)
			}
		}
	}).FontSize(a.fs(textCaption)).Shrink(0).Tooltip(a.tr("perm.modeTip"))
	// 跳过确认的那一档用警告色，一眼能看出这个对话不会再问。
	if mode == service.ModeBypass {
		chip.TextColor(t.Warning)
	}
}

// permissionCards 把等着用户回复的工具调用画在输入框上方，一个请求一张卡片。
func (a *app) permissionCards(c *ui.Context) {
	for _, request := range a.perm.requests {
		a.permissionCard(c, request)
	}
	if a.perm.err != "" {
		ui.Text(c, a.perm.err).FontSize(a.fs(textCaption)).TextColor(c.Theme().Danger).Padding(4, 0)
	}
}

// permissionCard 是一次待审批的改动：标题行（说明加工具名徽标）、一句话说明、命令或内容的开头，以及放行/拒绝的按钮。
// 放行的按钮靠左、拒绝靠右隔开，免得顺手点错；预览用等宽字体并限高，长内容不会把输入框顶出屏幕。
func (a *app) permissionCard(c *ui.Context, request service.PermissionRequest) {
	t := c.Theme()
	tok := a.tokens().Tok
	busy := a.perm.busy[request.RequestID]
	ui.Column(c).Padding(14, 16).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(t.Warning.Alpha(0.4)).Gap(10).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, icons.Tool).TextColor(t.Warning)
			ui.Text(c, a.tr("perm.title")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Grow(1).MinWidth(0).SingleLine()
			ui.Badge(c, request.Tool)
		})
		ui.Text(c, request.Summary).Bold().Selectable()
		if request.Detail != "" {
			a.buffer(ui.Text(c, request.Detail)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Selectable().Padding(8, 10).Radius(8).Background(t.Surface).MaxHeight(132).Clip()
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			if ui.PrimaryButton(c, a.tr("perm.allow")).Disabled(busy).Tooltip(a.tr("perm.allowTip")).Shrink(0).Clicked() {
				a.respondPermission(request.RequestID, service.ReplyAllow)
			}
			if request.AllowChat {
				if ui.Button(c, a.tr("perm.allowChat")).Disabled(busy).Tooltip(a.tr("perm.allowChatTip", "tool", request.Tool)).Shrink(0).Clicked() {
					a.respondPermission(request.RequestID, service.ReplyAllowChat)
				}
			}
			if busy {
				ui.Spinner(c)
			}
			ui.Spacer(c)
			if ui.Button(c, a.tr("perm.deny")).Disabled(busy).Tooltip(a.tr("perm.denyTip")).Shrink(0).Clicked() {
				a.respondPermission(request.RequestID, service.ReplyDeny)
			}
		})
	})
}
