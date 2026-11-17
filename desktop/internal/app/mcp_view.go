package app

// 「集成 → MCP 服务器」分区的视图：服务器列表、连接状态、编辑弹窗。

import (
	"strings"

	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

func (a *app) mcpSection(c *ui.Context, t *ui.Theme) {
	m := &a.mcp
	if !m.loaded && !m.loading {
		a.loadMcp()
	}
	a.settingGroup(c, t, a.tr("settings.mcpTitle"), a.tr("settings.mcpTip"), func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			if m.loading || m.busy {
				ui.Spinner(c)
			}
			if ui.PrimaryButton(c, a.tr("settings.mcpAdd")).Disabled(m.busy).Clicked() {
				a.openMcpEditor(nil)
			}
			if ui.Button(c, a.tr("settings.mcpRefresh")).Disabled(m.busy).Clicked() {
				m.loaded = false
				m.busy = true
				a.reloadMcp()
			}
		})
		if m.err != "" {
			ui.Text(c, m.err).FontSize(a.fs(textCaption)).TextColor(t.Danger).Selectable()
		}
		if m.notice != "" {
			ui.Text(c, m.notice).FontSize(a.fs(textCaption)).TextColor(t.Success)
		}
		if m.loaded && len(m.servers) == 0 {
			ui.Text(c, a.tr("settings.mcpEmpty")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		}
		for i := range m.servers {
			a.mcpRow(c, t, m.servers[i])
		}
	})
}

func (a *app) mcpRow(c *ui.Context, t *ui.Theme, server service.McpServer) {
	m := &a.mcp
	ui.Column(c).Gap(6).Padding(10, 12).BorderWidth(1, 1, 1, 1).BorderColor(t.Border).Radius(10).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, server.Label).Bold().SingleLine().MinWidth(0)
			ui.Badge(c, server.ServerID)
			ui.Spacer(c)
			color, label := mcpStatusText(t, a, server)
			ui.Text(c, "●").TextColor(color).FontSize(a.fs(textCaption))
			a.buffer(ui.Text(c, label)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			if server.Tools > 0 {
				a.buffer(ui.Text(c, a.tr("settings.mcpToolsCount", "count", strconvItoa(server.Tools)))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			}
		})
		if detail := mcpDetail(server); detail != "" {
			a.buffer(ui.Text(c, detail)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).SingleLine().MinWidth(0)
		}
		if server.LastError != "" {
			ui.Text(c, server.LastError).FontSize(a.fs(textCaption)).TextColor(t.Danger).Selectable()
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			enabled := server.Enabled
			if ui.Switch(c, &enabled).Label(a.tr("settings.mcpEnabled")).Changed() {
				a.setMcpEnabled(server, enabled)
			}
			ui.Spacer(c)
			if ui.Button(c, a.tr("settings.mcpEdit")).Disabled(m.busy).Clicked() {
				a.openMcpEditor(&server)
			}
			if ui.Button(c, a.tr("settings.mcpRemove")).Disabled(m.busy).Clicked() {
				a.removeMcp(server.ServerID)
			}
		})
	})
}

func mcpStatusText(t *ui.Theme, a *app, server service.McpServer) (ui.Color, string) {
	if !server.Enabled {
		return t.TextMuted, a.tr("settings.mcpDisabled")
	}
	switch server.Status {
	case "connected":
		return t.Success, a.tr("settings.mcpConnected")
	case "connecting":
		return t.Warning, a.tr("settings.mcpConnecting")
	case "error":
		return t.Danger, a.tr("settings.mcpError")
	default:
		return t.TextMuted, a.tr("settings.mcpDisconnected")
	}
}

func mcpDetail(server service.McpServer) string {
	if server.Transport == "sse" {
		return server.URL
	}
	detail := server.Command
	for _, arg := range server.Args {
		detail += " " + arg
	}
	return detail
}

func strconvItoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}

func (a *app) mcpModal(c *ui.Context, t *ui.Theme) {
	m := &a.mcp
	if !m.open {
		return
	}
	f := &m.form
	ui.Modal(c, &m.open, func() {
		ui.Column(c).Width(560).Gap(10).Children(func() {
			title := a.tr("settings.mcpAddTitle")
			if f.existing {
				title = a.tr("settings.mcpEditTitle")
			}
			ui.Text(c, title).Bold().FontSize(a.fs(textSection))
			ui.Row(c).Gap(12).AlignItems(ui.Start).Children(func() {
				ui.Field(c, a.tr("settings.mcpServerID"), func() {
					ui.TextInput(c, &f.id).Label(a.tr("settings.mcpServerID")).Disabled(f.existing).Placeholder("github")
				}).Grow(1)
				ui.Field(c, a.tr("settings.mcpLabel"), func() {
					ui.TextInput(c, &f.label).Label(a.tr("settings.mcpLabel")).Placeholder("GitHub")
				}).Grow(1)
			})
			ui.Field(c, a.tr("settings.mcpTransport"), func() {
				ui.Segmented(c, &f.transport, "stdio", "SSE").Label(a.tr("settings.mcpTransport"))
			})
			if f.transport == 0 {
				ui.Field(c, a.tr("settings.mcpCommand"), func() {
					ui.TextInput(c, &f.command).Label(a.tr("settings.mcpCommand")).Placeholder("npx")
				})
				ui.Field(c, a.tr("settings.mcpArgs"), func() {
					ui.TextArea(c, &f.args).Label(a.tr("settings.mcpArgs")).Lines(2, 6).MinHeight(0)
				})
				if len(f.savedEnv) > 0 {
					a.buffer(ui.Text(c, a.tr("settings.mcpSavedKeys", "keys", strings.Join(f.savedEnv, ", ")))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
				}
				ui.Text(c, a.tr("settings.mcpEnvHint")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
				ui.Field(c, a.tr("settings.mcpEnv"), func() {
					ui.TextArea(c, &f.env).Label(a.tr("settings.mcpEnv")).Lines(2, 6).MinHeight(0)
				})
			} else {
				ui.Field(c, a.tr("settings.mcpURL"), func() {
					ui.TextInput(c, &f.url).Label(a.tr("settings.mcpURL")).Placeholder("https://example.com/sse")
				})
				if len(f.savedHeaders) > 0 {
					a.buffer(ui.Text(c, a.tr("settings.mcpSavedKeys", "keys", strings.Join(f.savedHeaders, ", ")))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
				}
				ui.Text(c, a.tr("settings.mcpHeadersHint")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
				ui.Field(c, a.tr("settings.mcpHeaders"), func() {
					ui.TextArea(c, &f.headers).Label(a.tr("settings.mcpHeaders")).Lines(2, 6).MinHeight(0)
				})
			}
			ui.Checkbox(c, &f.enabled, a.tr("settings.mcpEnabled"))
			if m.formErr != "" {
				ui.Text(c, m.formErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
			}
			if m.testMsg != "" {
				ui.Text(c, m.testMsg).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Selectable()
			}
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if m.busy {
					ui.Spinner(c)
				}
				if ui.Button(c, a.tr("settings.mcpTest")).Disabled(m.busy).Clicked() {
					a.testMcp()
				}
				if ui.Button(c, a.tr("settings.mcpCancel")).Clicked() {
					m.open = false
				}
				if ui.PrimaryButton(c, a.tr("settings.mcpSave")).Disabled(m.busy).Clicked() {
					a.saveMcp()
				}
			})
		})
	})
}
