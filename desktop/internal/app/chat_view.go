package app

// 对话页的界面：标题栏、消息列表（用户气泡、旁注、工具调用卡片、ask_user 卡片、回答正文）、输入区与斜杠命令菜单、重命名弹窗。发送、订阅与模型切换在 chat.go。

import (
	"fmt"
	"strconv"
	"strings"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/icons"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

// chatPage 构建聊天页：标题栏、横幅、消息列表、错误行与输入区。
func (a *app) chatPage(c *ui.Context) {
	t := c.Theme()
	a.chatHeader(c)
	a.banner(c)
	if a.cv.modelsErr != "" {
		ui.Text(c, a.cv.modelsErr).FontSize(a.fs(textCaption)).TextColor(t.Danger).Padding(4, 24)
	}
	messages := a.chat.Messages
	a.list.Key = func(i int) any { return messages[i].Key }
	a.list.FollowEnd = true
	ui.List(c, &a.list, len(messages), func(i int) {
		a.message(c, messages[i])
	}).Grow(1).Padding(16, 24).Gap(12).Justify(ui.End).Children(func() {
		if len(messages) == 0 {
			hint := a.tr("chat.empty")
			if a.conv != 0 && !a.connected {
				hint = a.tr("chat.loading")
			}
			ui.Text(c, hint).TextColor(t.TextMuted).Margin(ui.Auto)
		}
	})
	if a.chat.Failure != "" && !a.chat.Busy {
		ui.Text(c, a.tr("chat.lastReplyFailed", "error", a.chat.Failure)).FontSize(a.fs(textCaption)).TextColor(t.Warning).Padding(4, 24)
	}
	if a.sendErr != "" {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(4, 24).Children(func() {
			ui.Text(c, a.sendErr).TextColor(t.Danger).Grow(1).MinWidth(0)
			if a.needModel && ui.Button(c, a.tr("chat.openSettings")).Clicked() {
				a.openSettings()
			}
		})
	}
	a.composer(c)
}

// chatHeader 是聊天页的标题栏：标题单行省略、重命名、模型与思考强度，以及数据面板和服务状态。
func (a *app) chatHeader(c *ui.Context) {
	t := c.Theme()
	a.syncModelControls()
	title := a.tr("menu.newChat")
	if a.conv != 0 {
		title = a.sessionTitle(a.conv)
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(10, 20).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
		// Grow+MinWidth(0) 让它把多余宽度让给右侧控件，SingleLine 在放不下时以省略号结尾。
		ui.Text(c, title).Bold().FontSize(a.fs(textSection)).SingleLine().Grow(1).MinWidth(0).Tooltip(title)
		if a.conv != 0 && iconTextButton(c, icons.Pencil, a.tr("chat.rename")).Tooltip(a.tr("chat.renameTip")).Clicked() {
			a.openRename()
		}
		if options := a.modelOptions(); len(options) > 0 {
			sel := ui.Select(c, &a.cv.modelChoice, options).MaxWidth(240).MinWidth(0)
			if sel.Changed() {
				a.chooseModel(a.cv.modelChoice)
			}
		}
		if options := a.thinkingOptions(); len(options) > 1 {
			sel := ui.Select(c, &a.cv.thinkingChoice, options).MaxWidth(120).MinWidth(0)
			if sel.Changed() {
				a.chooseThinking(a.cv.thinkingChoice)
			}
		}
		label := a.tr("chat.data")
		if a.src.open {
			label = a.tr("chat.hideData")
		}
		if iconTextButton(c, icons.PanelRight, label).Tooltip(a.tr("chat.dataTip")).Clicked() {
			a.toggleSources()
		}
		label2, color := a.statusLabel(t)
		ui.Text(c, "●").FontSize(a.fs(textCaption)).TextColor(color)
		ui.Text(c, label2).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
	})
}

// message 构建一行聊天内容：用户的消息放在右侧气泡里，工具调用是一行可展开的摘要，ask_user 是
// 问题卡片，回复用 Markdown（流式时 markdown.Stream，落定后 markdown.View，同一个列表行）。
func (a *app) message(c *ui.Context, m conversation.Message) {
	t := c.Theme()
	switch {
	case m.Role == "user":
		ui.Row(c).Children(func() {
			ui.Spacer(c)
			ui.Text(c, m.Text).Selectable().Padding(10, 14).Radius(radiusBubble).Background(a.tokens().Tok.UserBubble).MaxWidth(600)
		})
	case m.Role == "note":
		// 宿主写给模型的旁注（质量闸门、系统提醒）：展示成可折叠的灰色提示，不当成用户发言。
		a.noteRow(c, m)
	case m.Role == "tool" && m.Tool != nil && m.Tool.Ask != nil:
		a.askCard(c, m)
	case m.Role == "tool" && m.Tool != nil:
		a.toolRow(c, m)
	case m.Role == "tool":
		ui.Text(c, m.Text).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
	default:
		text := visibleText(m.Text)
		if strings.TrimSpace(text) == "" {
			return
		}
		ui.Column(c).MaxWidth(760).Children(func() {
			if m.Done {
				markdown.View(c, text, &a.md)
			} else {
				markdown.Stream(c, text, &a.md)
			}
		})
	}
}

// noteRow 渲染宿主写进会话的旁注。正文是给模型看的指令，默认折叠；展开后可选可复制，
// 方便用户判断「它为什么又答了一遍」。
func (a *app) noteRow(c *ui.Context, m conversation.Message) {
	t := c.Theme()
	label := m.Text
	if at := strings.IndexByte(label, ']'); at > 0 {
		label = label[:at+1]
	} else if len(label) > 40 {
		label = label[:40]
	}
	if a.cv.openNotes == nil {
		a.cv.openNotes = map[string]bool{}
	}
	key := "note:" + m.Key
	open, seen := a.cv.openNotes[key]
	ui.Column(c).MaxWidth(760).Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			ui.Badge(c, strings.TrimSpace(strings.Trim(label, "[]")))
			ui.Text(c, a.tr("chat.noteHint")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			ui.Spacer(c)
			toggle := a.tr("chat.details")
			if open {
				toggle = a.tr("chat.hide")
			}
			if ui.Button(c, toggle).Clicked() {
				a.cv.openNotes[key] = !open
			}
		})
		if open || seen {
			ui.Column(c).Padding(8, 12).Radius(10).Background(t.Surface).Children(func() {
				ui.Text(c, visibleNote(m.Text)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Selectable().MaxWidth(720)
			})
		}
	})
}

// visibleNote 去掉旁注的标记前缀，只留正文。
func visibleNote(text string) string {
	trimmed := strings.TrimSpace(text)
	for _, prefix := range []string{"[QUALITY GATE]", "[SYSTEM NOTE]"} {
		if strings.HasPrefix(trimmed, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, prefix))
		}
	}
	return trimmed
}

// toolRow 是一次工具调用的一行摘要：名字、参数摘要、耗时与状态；结果默认折叠，点击展开后
// 在限高的滚动区里看全文。参数与结果的原始 JSON 不再进入消息流。
func (a *app) toolRow(c *ui.Context, m conversation.Message) {
	t := c.Theme()
	tool := m.Tool
	open := a.cv.openTools[m.Key]
	// ask_user 的结果正文是给模型的指令（见 internalAskInstruction）；没有可解析的问题时也绝不显示它。
	output := ""
	if tool.Name != "ask_user" {
		output = tool.Output
	}
	tok := a.tokens().Tok
	ui.Column(c).MaxWidth(760).Gap(8).Children(func() {
		// 一次工具调用是一张圆角卡片（参考 Tern）：标题行是图标、工具名（强调色）、参数摘要与状态；
		// 结果展开后在分隔线下方，用 buffer 字体。
		ui.Column(c).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(7, 12).Children(func() {
				ui.Icon(c, icons.Tool).TextColor(t.TextMuted)
				a.buffer(ui.Text(c, tool.Name)).TextColor(t.Accent).Shrink(0)
				if tool.Args != "" {
					a.buffer(ui.Text(c, tool.Args)).TextColor(t.TextMuted).SingleLine().Grow(1).MinWidth(0)
				} else {
					ui.Spacer(c)
				}
				if tool.Status == "running" && !m.Done {
					ui.Spinner(c)
				}
				switch tool.Status {
				case "ok":
					ui.Icon(c, icons.Check).TextColor(t.Success)
				case "error":
					ui.Icon(c, icons.CircleX).TextColor(t.Danger)
				}
				ui.Text(c, toolMeta(tool)).FontSize(a.fs(textCaption)).TextColor(toolStatusColor(t, tool.Status)).Shrink(0)
				if output != "" {
					label, chevron := a.tr("chat.details"), icons.ChevronRight
					if open {
						label, chevron = a.tr("chat.hide"), icons.ChevronDown
					}
					if iconTextButton(c, chevron, label).FontSize(a.fs(textCaption)).Tooltip(a.tr("chat.toolOutputHint")).Clicked() {
						if a.cv.openTools == nil {
							a.cv.openTools = map[string]bool{}
						}
						a.cv.openTools[m.Key] = !open
					}
				}
			})
			if open && output != "" {
				// 长结果限高并滚动：展开后信息不丢，也不会把消息流撑到看不见正文。Scroll 需要一个确定的
				// 高度才会给内容可见的窗口，所以按输出长度估一个高度（上限 240 DIP）。
				ui.Divider(c)
				ui.Scroll(c).Height(outputHeight(output, 240)).Children(func() {
					a.buffer(ui.Text(c, output)).Selectable().Padding(8, 12)
				})
			}
		})
		// 图表与仪表盘：结果里带了就画出来，而不是只留一句 “Chart generated”。图表用
		// ui.WebView（richcontent.go），尺寸随窗口与数据面板变化。
		for _, chart := range tool.Charts {
			a.chartCard(c, chart)
		}
		if tool.DashboardID != "" {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, "Dashboard "+tool.DashboardID).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).SingleLine().Grow(1).MinWidth(0)
				if ui.Button(c, "View dashboard").FontSize(a.fs(textCaption)).Tooltip("Open this chat's dashboard read-only").Clicked() {
					a.openDashboard(tool.DashboardID)
				}
			})
		}
	})
}

// askCard 是 ask_user 的问题卡片：选项来自工具自己的 question/options，点选后通过 conversation.submit
// 以 followUp 提交；也允许在输入框里自由回答。
func (a *app) askCard(c *ui.Context, m conversation.Message) {
	t := c.Theme()
	ask := m.Tool.Ask
	callID := m.Tool.CallID
	if callID == "" {
		callID = m.Key
	}
	st := a.cv.askState(callID)
	tok := a.tokens().Tok
	ui.Column(c).MaxWidth(560).Padding(12, 14).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder).Gap(8).Children(func() {
		ui.Text(c, "Quick question").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		ui.Text(c, ask.Question).Bold()
		if st.sent != "" {
			ui.Text(c, "Answer sent: "+oneLine(st.sent, 80)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			return
		}
		if ask.MultiSelect {
			for _, option := range ask.Options {
				checked := st.checks[option]
				ui.Checkbox(c, &checked, option)
				// Checkbox 在构建时写入它绑定的变量，构建之后收回 map，下一帧才能显示勾选状态。
				if st.checks == nil {
					st.checks = map[string]bool{}
				}
				st.checks[option] = checked
			}
		} else {
			ui.RadioGroup(c, func() {
				for _, option := range ask.Options {
					ui.Radio(c, &st.choice, option, option)
				}
			}).Label(ask.Question)
		}
		free := ui.TextInput(c, &st.free).Label("Your answer").Placeholder("Or type your own answer")
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			if st.busy {
				ui.Spinner(c)
			}
			if ui.PrimaryButton(c, "Send answer").Disabled(st.busy).Tooltip("Send this answer as the next message").Clicked() || free.Submitted() {
				a.answerAsk(callID, ask, st)
			}
			if st.err != "" {
				ui.Text(c, st.err).FontSize(a.fs(textCaption)).TextColor(t.Danger).Grow(1).MinWidth(0)
			}
		})
	})
}

// toolMeta 生成摘要行右侧的「耗时 · 状态」。
func toolMeta(tool *conversation.ToolCall) string {
	parts := make([]string, 0, 2)
	if tool.DurationMS > 0 {
		parts = append(parts, formatDuration(tool.DurationMS))
	}
	switch tool.Status {
	case "ok":
		parts = append(parts, "ok")
	case "error":
		parts = append(parts, "error")
	default:
		parts = append(parts, "running")
	}
	return strings.Join(parts, " · ")
}

// outputHeight 估一段等宽正文在 limit 高度内需要多少 DIP：约 90 个字符折一行、每行 16 DIP。
// 只决定滚动窗口的高度，不参与内容裁剪，估小了仍然能滚动看全。
func outputHeight(text string, limit float32) float32 {
	lines := 0
	for _, line := range strings.Split(text, "\n") {
		lines++
		if extra := len(line) / 90; extra > 0 {
			lines += extra
		}
	}
	h := float32(lines)*16 + 12
	if h > limit {
		h = limit
	}
	if h < 36 {
		h = 36
	}
	return h
}

func formatDuration(ms int64) string {
	if ms < 1000 {
		return fmt.Sprintf("%dms", ms)
	}
	return fmt.Sprintf("%.1fs", float64(ms)/1000)
}

func toolStatusColor(t *ui.Theme, status string) ui.Color {
	switch status {
	case "error":
		return t.Danger
	case "ok":
		return t.TextMuted
	}
	return t.Warning
}

// composer 是输入区：斜杠命令列表、回复进行中的排队/插队选择，以及自适应的输入行。
func (a *app) composer(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).BorderWidth(1, 0, 0, 0).BorderColor(t.Border).Children(func() {
		if a.slashOpen() {
			a.slashMenu(c)
		}
		if a.chat.Busy && a.connected {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(6, 24).Children(func() {
				ui.Text(c, a.tr("chat.busy")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Shrink(0)
				ui.Segmented(c, &a.cv.busyMode, a.tr("chat.queue"), a.tr("chat.steer")).Shrink(0).Label(a.tr("chat.enterMode"))
				hint := a.tr("chat.enterQueues")
				if a.cv.busyMode == 1 {
					hint = a.tr("chat.enterSteers")
				}
				ui.Text(c, hint).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).SingleLine().Grow(1).MinWidth(0)
				if a.chat.Queued > 0 {
					ui.Text(c, a.tr("chat.queued", "count", strconv.Itoa(a.chat.Queued))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Shrink(0)
				}
			})
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(14, 20).Children(func() {
			// MinWidth(0) 让输入框在窄窗口里真的能被压缩，否则按钮会被挤出窗口并裁成 “Sen…”。
			in := ui.TextInput(c, &a.input).Label(a.tr("chat.message")).Placeholder(a.tr("chat.placeholder")).Grow(1).MinWidth(0).AutoFocus()
			if a.chat.Busy && a.connected && iconTextButton(c, icons.Stop, a.tr("chat.stop")).Shrink(0).Tooltip(a.tr("chat.stopTip")).Clicked() {
				a.abort()
			}
			send := primaryIconTextButton(c, icons.Send, a.tr("chat.send")).Shrink(0).Disabled(!a.canSend())
			if send.Clicked() || in.Submitted() {
				// 输入还只是一个 /命令前缀时，Enter 先补全，不直接发送。
				if !a.completeSlash() {
					a.send()
				}
			}
		})
	})
}

// chatModals 画聊天页的弹窗（标题重命名）。
func (a *app) chatModals(c *ui.Context) {
	if !a.cv.renaming {
		return
	}
	t := c.Theme()
	ui.Modal(c, &a.cv.renaming, func() {
		ui.Column(c).WidthPercent(70).MaxWidth(420).MinWidth(260).Gap(10).Children(func() {
			ui.Text(c, "Rename chat").Bold()
			in := ui.TextInput(c, &a.cv.renameText).Label("Chat title").MaxWidth(380).AutoFocus()
			if a.cv.renameErr != "" {
				ui.Text(c, a.cv.renameErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
			}
			ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
				if a.cv.renameBusy {
					ui.Spinner(c)
				}
				if ui.Button(c, "Cancel").Disabled(a.cv.renameBusy).Clicked() {
					a.cv.renaming = false
				}
				if ui.PrimaryButton(c, "Save").Disabled(a.cv.renameBusy).Clicked() || in.Submitted() {
					a.renameSession()
				}
			})
		})
	})
}

// slashMenu 是输入框上方的一行命令列表；点击一项把命令补进输入框。
func (a *app) slashMenu(c *ui.Context) {
	t := c.Theme()
	matches := a.slashMatches()
	ui.Column(c).Padding(6, 24).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
		ui.Text(c, "Commands").FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		// 每项约 30 DIP，最多显示 6 项后滚动。
		menuHeight := float32(30*len(matches) + 8)
		if menuHeight > 180 {
			menuHeight = 180
		}
		ui.Scroll(c).Height(menuHeight).Children(func() {
			for _, command := range matches {
				label := "/" + command.Name
				if command.ArgumentHint != "" {
					label += " " + command.ArgumentHint
				}
				if ui.Button(c, label).Tooltip(command.Description).Clicked() {
					a.input = "/" + command.Name + " "
				}
			}
		})
	})
}
