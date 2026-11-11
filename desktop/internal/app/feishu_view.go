package app

// 设置页「集成」分区：飞书机器人的连接状态、配置表单、测试消息，以及当前会话关联的群。

import (
	"datawhisper/desktop/internal/icons"
	"github.com/egoist/mygo/ui"
)

// integrationSettings 画「集成」分区。
func (a *app) integrationSettings(c *ui.Context, t *ui.Theme) {
	f := &a.feishu
	if a.client == nil {
		a.settingsUnavailable(c, t)
		return
	}
	if !f.loaded && !f.loading {
		a.loadFeishu()
	}
	ui.Scroll(c).Grow(1).MinWidth(0).Children(func() {
		ui.Column(c).Padding(24, 32).Gap(20).MaxWidth(720).Children(func() {
			if f.unavailable {
				ui.Text(c, a.tr("feishu.unavailable")).TextColor(t.TextMuted)
				return
			}
			a.settingGroup(c, t, a.tr("feishu.title"), a.tr("feishu.tip"), func() {
				a.feishuStatusRow(c, t)
			})
			if f.err != "" {
				ui.Text(c, f.err).FontSize(a.fs(textCaption)).TextColor(t.Danger).Selectable()
			}
			if f.notice != "" {
				ui.Text(c, f.notice).FontSize(a.fs(textCaption)).TextColor(t.Success)
			}
			a.settingGroup(c, t, a.tr("feishu.config"), a.tr("feishu.configTip"), func() {
				a.labeledRow(c, t, a.tr("feishu.enabled"), func() {
					ui.Switch(c, &f.enabled).Label(a.tr("feishu.enabled"))
				})
				a.labeledRow(c, t, "App ID", func() {
					ui.TextInput(c, &f.appID).Label("App ID").Grow(1).MinWidth(0)
				})
				a.labeledRow(c, t, "App Secret", func() {
					hint := a.tr("feishu.secretEmpty")
					if f.status.AppSecretConfigured {
						hint = a.tr("feishu.secretKept")
					}
					ui.TextInput(c, &f.appSecret).Label("App Secret").Placeholder(hint).Password().Grow(1).MinWidth(0)
				})
				a.labeledRow(c, t, a.tr("feishu.transport"), func() {
					ui.Segmented(c, &f.transport, a.tr("feishu.longConnection"), "Webhook").Label(a.tr("feishu.transport"))
				})
				if f.transport == 1 {
					a.labeledRow(c, t, a.tr("feishu.token"), func() {
						hint := a.tr("feishu.secretEmpty")
						if f.status.EventVerificationTokenConfigured {
							hint = a.tr("feishu.secretKept")
						}
						ui.TextInput(c, &f.token).Label(a.tr("feishu.token")).Placeholder(hint).Password().Grow(1).MinWidth(0)
					})
				}
				a.labeledRow(c, t, a.tr("feishu.target"), func() {
					ui.Segmented(c, &f.idType, "chat_id", "open_id").Label(a.tr("feishu.targetType"))
					ui.TextInput(c, &f.receiveID).Label(a.tr("feishu.target")).Grow(1).MinWidth(0)
				})
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					if f.busy {
						ui.Spinner(c)
					}
					if ui.PrimaryButton(c, a.tr("feishu.save")).Disabled(f.busy).Clicked() {
						a.saveFeishu()
					}
					if ui.Button(c, a.tr("feishu.test")).Disabled(f.busy || !f.status.Configured).Tooltip(a.tr("feishu.testTip")).Clicked() {
						a.testFeishu()
					}
				})
			})
			a.settingGroup(c, t, a.tr("feishu.chatLink"), a.tr("feishu.chatLinkTip"), func() {
				a.feishuLinkRow(c, t)
			})
		})
	})
}

// feishuStatusRow 是连接状态：一个状态点、状态词与错误原因。
func (a *app) feishuStatusRow(c *ui.Context, t *ui.Theme) {
	st := a.feishu.status
	color, label := t.TextMuted, a.tr("feishu.notConfigured")
	switch st.InboundStatus {
	case "connected":
		color, label = t.Success, a.tr("feishu.connected")
	case "starting", "reconnecting":
		color, label = t.Warning, a.tr("feishu.connecting")
	case "error":
		color, label = t.Danger, a.tr("feishu.error")
	case "webhook":
		color, label = t.Success, a.tr("feishu.webhook")
	case "paused", "disabled":
		label = a.tr("feishu.disabled")
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Text(c, "●").TextColor(color)
		ui.Text(c, label)
		if st.ReceiveIDMasked != "" {
			a.buffer(ui.Text(c, st.ReceiveIDMasked)).TextColor(t.TextMuted)
		}
	})
	if st.InboundError != "" {
		ui.Text(c, st.InboundError).FontSize(a.fs(textCaption)).TextColor(t.Danger).Selectable()
	}
}

// feishuLinkRow 是当前会话与群的关联：已关联时显示群名与解除按钮，否则可以关联到默认目标或从群列表里选。
func (a *app) feishuLinkRow(c *ui.Context, t *ui.Theme) {
	f := &a.feishu
	if a.conv == 0 {
		ui.Text(c, a.tr("feishu.noChat")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		return
	}
	if !f.status.Configured {
		ui.Text(c, a.tr("feishu.configureFirst")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		return
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Text(c, a.tr("feishu.currentChat", "title", a.sessionTitle(a.conv))).SingleLine().Grow(1).MinWidth(0)
		if link := f.status.Link; link != nil && link.ChatID != "" {
			name := link.ChatName
			if name == "" {
				name = link.ChatID
			}
			ui.Badge(c, name)
			if ui.Button(c, a.tr("feishu.unlink")).Disabled(f.busy).Clicked() {
				a.linkFeishu(false, "")
			}
			return
		}
		if ui.Button(c, a.tr("feishu.linkDefault")).Disabled(f.busy).Clicked() {
			a.linkFeishu(true, "")
		}
		if ui.Button(c, a.tr("feishu.listChats")).Disabled(f.busy).Clicked() {
			a.loadFeishuChats()
		}
	})
	for _, chat := range f.chats {
		id, name := chat.ChatID, chat.Name
		ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(4, 8).Children(func() {
			ui.Icon(c, icons.Chat).TextColor(t.TextMuted)
			ui.Text(c, name).SingleLine().Grow(1).MinWidth(0)
			if ui.Button(c, a.tr("feishu.linkHere")).Disabled(f.busy).Clicked() {
				a.linkFeishu(true, id)
			}
		})
	}
}
