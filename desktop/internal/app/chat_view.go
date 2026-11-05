package app

// 对话页的界面（docs/refactor/ui-redesign.md §3.3、§3.7，参考 Tern 的会话面板）：标题栏、居中的消息列
// （用户气泡、思考行、工具调用卡片、ask_user 卡片、回答正文、每轮末尾的元数据）、右侧的用户消息导航轨、
// 首页空状态，以及输入区（状态行、上下文用量、排队的消息、多行输入与底部的模型标签）。发送、订阅与模型切换
// 在 chat.go。

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/prefs"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

// chatColumnWidth 返回对话列的最大宽度（外观里的「对话宽度」）：标准 760 时正文一行最好读，宽窗口里两侧
// 留白而不是把行拉长；「铺满」不设上限。
func (a *app) chatColumnWidth() float32 {
	switch a.appearance().ChatWidth {
	case prefs.ChatWidthNarrow:
		return 640
	case prefs.ChatWidthWide:
		return 960
	case prefs.ChatWidthFull:
		return 100000
	}
	return 760
}

// toolPreviewLines 是工具卡片默认显示的输出行数（末尾几行）；更早的行折叠成「前面还有 N 行」。
const toolPreviewLines = 6

// chatPage 构建对话页：标题栏、横幅、消息列与导航轨、错误提示和输入区。
func (a *app) chatPage(c *ui.Context) {
	t := c.Theme()
	a.chatHeader(c)
	a.banner(c)
	if a.cv.modelsErr != "" {
		ui.Text(c, a.cv.modelsErr).FontSize(a.fs(textCaption)).TextColor(t.Danger).Padding(4, 24)
	}
	messages := a.chat.Messages
	if len(messages) == 0 {
		a.homeView(c)
	} else {
		turns := turnEnds(messages, a.chat.Busy)
		ui.Row(c).Grow(1).MinHeight(0).AlignItems(ui.Stretch).Children(func() {
			a.list.Key = func(i int) any { return messages[i].Key }
			// 跳到某条提问或某个出处之后暂停跟随底部，否则下一帧又被拉回去；回到底部后恢复（见 jumpTo）。
			if a.cv.followPaused && a.list.AtEnd() && c.Now().Sub(a.cv.jumpedAt) > 500*time.Millisecond {
				a.cv.followPaused = false
			}
			a.list.FollowEnd = !a.cv.followPaused
			ui.List(c, &a.list, len(messages), func(i int) {
				a.centered(c, func() {
					a.message(c, messages[i])
					if m := messages[i]; m.Role == "assistant" && m.Done {
						a.provenanceRow(c, messages, i)
					}
					if meta, ok := turns[i]; ok {
						a.turnMeta(c, meta)
					}
				})
			}).Grow(1).MinWidth(0).Padding(20, 24).Gap(14).Justify(ui.End)
			a.navRail(c, messages)
		})
	}
	if a.chat.Failure != "" && !a.chat.Busy {
		a.centered(c, func() {
			ui.Text(c, a.tr("chat.lastReplyFailed", "error", a.chat.Failure)).FontSize(a.fs(textCaption)).TextColor(t.Warning).Padding(4, 0)
		})
	}
	if a.sendErr != "" {
		a.centered(c, func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(4, 0).Children(func() {
				ui.Text(c, a.sendErr).TextColor(t.Danger).Grow(1).MinWidth(0)
				if a.needModel && ui.Button(c, a.tr("chat.openSettings")).Clicked() {
					a.openSettings()
				}
			})
		})
	}
	a.composer(c)
}

// centered 把一段内容放进居中、限宽的对话列。
func (a *app) centered(c *ui.Context, fn func()) {
	width := a.chatColumnWidth()
	ui.Row(c).Justify(ui.Center).Children(func() {
		ui.Column(c).Grow(1).MinWidth(0).MaxWidth(width).Gap(10).Children(fn)
	})
}

// homeView 是还没有消息时的首页：问候、提示、几条示例问题（点一下填进输入框）与打开数据面板的入口。
// 正在加载已有会话时只显示加载提示。
func (a *app) homeView(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Grow(1).MinHeight(0).Justify(ui.Center).Padding(24).Children(func() {
		a.centered(c, func() {
			if a.conv != 0 && !a.connected {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Justify(ui.Center).Children(func() {
					ui.Spinner(c)
					ui.Text(c, a.tr("chat.loading")).TextColor(t.TextMuted)
				})
				return
			}
			ui.Icon(c, icons.Sparkles).FontSize(a.fs(textHero)).TextColor(t.Accent)
			ui.Text(c, a.tr("chat.homeTitle")).Bold().FontSize(a.fs(textHero))
			ui.Text(c, a.tr("chat.homeHint")).TextColor(t.TextMuted)
			ui.Text(c, a.tr("chat.suggestions")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Margin(12, 0, 0, 0)
			for _, text := range []string{a.tr("chat.suggest1"), a.tr("chat.suggest2"), a.tr("chat.suggest3"), a.tr("chat.suggest4")} {
				if ui.Button(c, "").Label(text).Justify(ui.Start).Children(func() {
					ui.Icon(c, icons.ChevronRight).TextColor(t.TextMuted)
					ui.Text(c, text).SingleLine().MinWidth(0)
				}).Clicked() {
					a.input = text
				}
			}
			ui.Row(c).Margin(8, 0, 0, 0).Children(func() {
				if iconTextButton(c, icons.Database, a.tr("chat.openData")).Clicked() && !a.src.open {
					a.toggleSources()
				}
			})
		})
	})
}

// chatHeader 是对话页的标题栏：标题单行省略，右侧是重命名与数据面板开关。模型与思考强度在输入区。
func (a *app) chatHeader(c *ui.Context) {
	t := c.Theme()
	a.syncModelControls()
	title := a.tr("menu.newChat")
	if a.conv != 0 {
		title = a.sessionTitle(a.conv)
	}
	ui.Row(c).Gap(6).AlignItems(ui.Center).Padding(10, 20).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
		// Grow+MinWidth(0) 让它把多余宽度让给右侧控件，SingleLine 在放不下时以省略号结尾。
		ui.Text(c, title).Bold().FontSize(a.fs(textSection)).SingleLine().Grow(1).MinWidth(0).Tooltip(title)
		ui.Toolbar(c, func() {
			if a.conv != 0 && iconTextButton(c, icons.Pencil, a.tr("chat.rename")).Tooltip(a.tr("chat.renameTip")).Clicked() {
				a.openRename()
			}
			label := a.tr("chat.data")
			if a.src.open {
				label = a.tr("chat.hideData")
			}
			if iconTextButton(c, icons.PanelRight, label).Tooltip(a.tr("chat.dataTip")).Clicked() {
				a.toggleSources()
			}
		}).Label(a.tr("chat.toolbar")).Shrink(0)
	})
}

// message 构建一行聊天内容。
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
	case m.Role == "thinking":
		a.thinkingRow(c, m)
	case m.Role == "tool" && m.Tool != nil && m.Tool.Ask != nil:
		a.askCard(c, m)
	case m.Role == "tool" && m.Tool != nil:
		a.toolCard(c, m)
	case m.Role == "tool":
		ui.Text(c, m.Text).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
	default:
		text := visibleText(m.Text)
		if strings.TrimSpace(text) == "" {
			return
		}
		if m.Done {
			markdown.View(c, text, &a.md)
		} else {
			markdown.Stream(c, text, &a.md)
		}
	}
}

// thinkingRow 是回复前的思考：默认折叠成一行斜体灰字「思考 ›」，点开显示全文。思考仍在流式生成时显示
// 「思考中…」与转圈。
func (a *app) thinkingRow(c *ui.Context, m conversation.Message) {
	t := c.Theme()
	if a.cv.openThinking == nil {
		a.cv.openThinking = map[string]bool{}
	}
	open := a.cv.openThinking[m.Key]
	label, chevron := a.tr("chat.thought"), icons.ChevronRight
	if !m.Done {
		label = a.tr("chat.thinking")
	}
	if open {
		chevron = icons.ChevronDown
	}
	ui.Column(c).Gap(6).Children(func() {
		// 外面套一行并以 Spacer 收尾：按钮只占自己的宽度，靠左，而不是在对话列里居中。
		ui.Row(c).Children(func() {
			toggle := ui.ButtonBase(c).Label(label).Children(func() {
				ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
					if !m.Done {
						ui.Spinner(c)
					}
					ui.Text(c, label).Italic().TextColor(t.TextMuted)
					ui.Icon(c, chevron).TextColor(t.TextMuted)
				})
			})
			if toggle.Clicked() {
				a.cv.openThinking[m.Key] = !open
			}
			ui.Spacer(c)
		})
		if open {
			ui.Text(c, m.Text).Italic().TextColor(t.TextMuted).Selectable().Padding(0, 0, 0, 12).BorderWidth(0, 0, 0, 2).BorderColor(t.Border)
		}
	})
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
	open := a.cv.openNotes[key]
	ui.Column(c).Gap(6).Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, icons.Info).TextColor(t.TextMuted)
			ui.Text(c, strings.TrimSpace(strings.Trim(label, "[]"))).FontSize(a.fs(textCaption)).Bold().TextColor(t.TextMuted)
			ui.Text(c, a.tr("chat.noteHint")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).SingleLine().Grow(1).MinWidth(0)
			toggle := a.tr("chat.details")
			if open {
				toggle = a.tr("chat.hide")
			}
			if ui.Button(c, toggle).FontSize(a.fs(textCaption)).Clicked() {
				a.cv.openNotes[key] = !open
			}
		})
		if open {
			a.buffer(ui.Text(c, visibleNote(m.Text))).TextColor(t.TextMuted).Selectable().Padding(8, 12).Radius(radiusCard).Background(a.tokens().Tok.Card)
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

// toolCard 是一次工具调用（参考 Tern）：卡片外是「图标 + 工具名 + 参数摘要」的标题行；卡片里上半是调用
// 参数，下半是输出。输出默认只显示末尾几行，更早的行折叠成「前面还有 N 行」，点开看全文；失败的调用默认
// 完整展开。卡片底部是状态与耗时。
func (a *app) toolCard(c *ui.Context, m conversation.Message) {
	t := c.Theme()
	tok := a.tokens().Tok
	tool := m.Tool
	// ask_user 的结果正文是给模型的指令（见 internalAskInstruction）；没有可解析的问题时也绝不显示它。
	output := ""
	if tool.Name != "ask_user" {
		output = strings.TrimRight(tool.Output, "\n")
	}
	running := tool.Status == "running" && !m.Done
	failed := tool.Status == "error"
	if a.cv.openOutputs == nil {
		a.cv.openOutputs = map[string]bool{}
	}
	expanded := a.cv.openOutputs[m.Key] || failed
	ui.Column(c).Gap(6).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, icons.Tool).TextColor(t.TextMuted)
			a.buffer(ui.Text(c, tool.Name)).TextColor(t.Accent).Shrink(0)
		})
		ui.Column(c).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder).Clip().Children(func() {
			if tool.Args != "" {
				a.buffer(ui.Text(c, tool.Args)).Selectable().Padding(10, 14)
			}
			if output != "" {
				if tool.Args != "" {
					ui.Divider(c)
				}
				a.toolOutput(c, m.Key, output, expanded, failed)
			}
			if tool.Args != "" || output != "" {
				ui.Divider(c)
			}
			ui.Row(c).Gap(6).AlignItems(ui.Center).Padding(7, 14).Children(func() {
				switch {
				case running:
					ui.Spinner(c)
					ui.Text(c, a.tr("chat.toolRunning")).FontSize(a.fs(textCaption)).TextColor(t.Warning)
				case failed:
					ui.Icon(c, icons.CircleX).TextColor(t.Danger)
					ui.Text(c, a.tr("chat.toolFailed")).FontSize(a.fs(textCaption)).TextColor(t.Danger)
				default:
					ui.Icon(c, icons.Check).TextColor(t.Success)
					ui.Text(c, a.tr("chat.toolDone")).FontSize(a.fs(textCaption)).TextColor(t.Success)
				}
				if tool.DurationMS > 0 {
					ui.Text(c, formatDuration(tool.DurationMS)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
				}
			})
		})
		// 图表与仪表盘：结果里带了就画出来，而不是只留一句 “Chart generated”。图表用
		// ui.WebView（richcontent.go），尺寸随窗口与数据面板变化。
		for _, chart := range tool.Charts {
			a.chartCard(c, chart)
		}
		if tool.DashboardID != "" {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Icon(c, icons.Dashboard).TextColor(t.TextMuted)
				ui.Text(c, "Dashboard "+tool.DashboardID).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).SingleLine().Grow(1).MinWidth(0)
				if ui.Button(c, "View dashboard").FontSize(a.fs(textCaption)).Tooltip("Open this chat's dashboard read-only").Clicked() {
					a.openDashboard(tool.DashboardID)
				}
			})
		}
	})
}

// toolOutput 画工具卡片里的输出。折叠时只画末尾 toolPreviewLines 行，上方一行「前面还有 N 行 ⌃」展开；
// 展开后全文放进限高的滚动区，末尾一行「收起」（失败的调用一直展开，不给收起）。
func (a *app) toolOutput(c *ui.Context, key, output string, expanded, failed bool) {
	t := c.Theme()
	lines := strings.Split(output, "\n")
	hidden := len(lines) - toolPreviewLines
	toggle := func(label string, icon *ui.SVG) {
		ui.Row(c).Children(func() {
			if ui.ButtonBase(c).Label(label).Tooltip(a.tr("chat.toolOutputHint")).Children(func() {
				ui.Row(c).Gap(4).AlignItems(ui.Center).Padding(6, 14, 0, 14).Children(func() {
					ui.Text(c, label).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
					ui.Icon(c, icon).TextColor(t.TextMuted)
				})
			}).Clicked() {
				a.cv.openOutputs[key] = !a.cv.openOutputs[key]
			}
			ui.Spacer(c)
		})
	}
	switch {
	case hidden <= 0:
		a.buffer(ui.Text(c, output)).Selectable().Padding(8, 14)
	case !expanded:
		toggle(a.tr("chat.earlierLines", "count", strconv.Itoa(hidden)), icons.ChevronUp)
		a.buffer(ui.Text(c, strings.Join(lines[hidden:], "\n"))).Selectable().Padding(4, 14, 8, 14)
	default:
		// Scroll 需要一个确定的高度才会给内容可见的窗口，所以按输出长度估一个高度（上限 320 DIP）。
		ui.Scroll(c).Height(outputHeight(output, 320)).Children(func() {
			a.buffer(ui.Text(c, output)).Selectable().Padding(8, 14)
		})
		if !failed {
			toggle(a.tr("chat.showLess"), icons.ChevronDown)
		}
	}
}

// askCard 是 ask_user 的问题卡片：单选时每个选项是一行按钮，点一下就作为回答发出；多选时勾选后发送。
// 也可以在下方自己输入回答。回答发出后卡片收起为「已回答：…」，问题保留。
func (a *app) askCard(c *ui.Context, m conversation.Message) {
	t := c.Theme()
	tok := a.tokens().Tok
	ask := m.Tool.Ask
	callID := m.Tool.CallID
	if callID == "" {
		callID = m.Key
	}
	st := a.cv.askState(callID)
	ui.Column(c).MaxWidth(600).Padding(14, 16).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder).Gap(8).Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, icons.ListChecks).TextColor(t.Accent)
			ui.Text(c, a.tr("chat.askTitle")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		})
		ui.Text(c, ask.Question).Bold()
		if st.sent != "" {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				ui.Icon(c, icons.Check).TextColor(t.Success)
				ui.Text(c, a.tr("chat.askSent", "answer", oneLine(st.sent, 80))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			})
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
			for i, option := range ask.Options {
				if ui.Button(c, "").Label(option).Justify(ui.Start).Disabled(st.busy).Children(func() {
					ui.Text(c, strconv.Itoa(i+1)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Shrink(0)
					ui.Text(c, option).MinWidth(0)
				}).Clicked() {
					st.choice, st.free = option, ""
					a.answerAsk(callID, ask, st)
				}
			}
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			free := ui.TextInput(c, &st.free).Label(a.tr("chat.askLabel")).Placeholder(a.tr("chat.askOther")).Grow(1).MinWidth(0)
			if st.busy {
				ui.Spinner(c)
			}
			if ui.PrimaryButton(c, a.tr("chat.askSend")).Disabled(st.busy).Tooltip(a.tr("chat.askSendTip")).Shrink(0).Clicked() || free.Submitted() {
				a.answerAsk(callID, ask, st)
			}
		})
		if st.err != "" {
			ui.Text(c, st.err).FontSize(a.fs(textCaption)).TextColor(t.Danger)
		}
	})
}

// turnInfo 是一轮对话（一条用户消息到下一条之间）的汇总，画在这一轮最后一行的下方。
type turnInfo struct {
	usage    conversation.Usage
	hasUsage bool
	end      int64  // 最后一次回复的时间（epoch 毫秒）
	text     string // 这一轮的回答正文，复制用
}

// turnEnds 找出每一轮的最后一行（下标）并汇总它的用量、时间与回答正文。还在进行中的最后一轮不画。
func turnEnds(messages []conversation.Message, busy bool) map[int]turnInfo {
	out := map[int]turnInfo{}
	var cur turnInfo
	last := -1
	flush := func() {
		if last >= 0 && (cur.hasUsage || cur.text != "") {
			out[last] = cur
		}
		cur, last = turnInfo{}, -1
	}
	for i, m := range messages {
		if m.Role == "user" {
			flush()
			continue
		}
		last = i
		if m.Usage != nil {
			cur.usage.Add(*m.Usage)
			cur.hasUsage = true
		}
		if m.Time > cur.end {
			cur.end = m.Time
		}
		if m.Role == "assistant" && m.Done {
			if text := strings.TrimSpace(visibleText(m.Text)); text != "" {
				if cur.text != "" {
					cur.text += "\n\n"
				}
				cur.text += text
			}
		}
	}
	if !busy {
		flush()
	}
	return out
}

// turnMeta 是一轮末尾的一行灰色小字：时间、输入/输出/缓存 token 与费用，右侧是复制这一轮回答的按钮。
func (a *app) turnMeta(c *ui.Context, info turnInfo) {
	t := c.Theme()
	var parts []string
	if info.end > 0 {
		parts = append(parts, time.UnixMilli(info.end).Format("15:04"))
	}
	if info.hasUsage {
		u := info.usage
		parts = append(parts, a.tr("chat.metaIn", "count", formatCount(u.Input)), a.tr("chat.metaOut", "count", formatCount(u.Output)))
		if u.CacheRead > 0 {
			parts = append(parts, a.tr("chat.metaCache", "count", formatCount(u.CacheRead)))
		}
		if u.Cost > 0 {
			parts = append(parts, formatCost(u.Cost))
		}
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		a.buffer(ui.Text(c, strings.Join(parts, " · "))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).SingleLine().Grow(1).MinWidth(0)
		if info.text != "" {
			ui.Toolbar(c, func() {
				if iconButton(c, icons.Copy, a.tr("chat.copy")).Clicked() {
					c.WriteClipboard(info.text)
					c.Toast(a.tr("chat.copied"))
				}
			}).Label(a.tr("chat.copy"))
		}
	})
}

// navRail 是对话列右侧的导航轨（参考 Tern）：每条用户消息一道短横，按它在对话中的位置排布；视口所在的那条
// 用强调色。点一道横线跳到那条提问，悬停时显示提问的第一行。少于两条提问时不画。
func (a *app) navRail(c *ui.Context, messages []conversation.Message) {
	var users []int
	for i, m := range messages {
		if m.Role == "user" {
			users = append(users, i)
		}
	}
	if len(users) < 2 {
		return
	}
	t := c.Theme()
	first, _ := a.list.Visible()
	current := users[0]
	for _, i := range users {
		if i <= first {
			current = i
		}
	}
	n := float32(len(messages))
	ui.Column(c).Width(18).Shrink(0).Margin(20, 6, 20, 0).Padding(10, 0).Radius(9).Background(a.tokens().Tok.Card).AlignItems(ui.Center).Children(func() {
		prev := float32(0)
		for _, i := range users {
			// 横线之间的空白按消息下标的比例分配：开头几条连续的提问就叠成紧挨的几道。
			gap := float32(i)/n - prev
			prev = float32(i) / n
			if gap > 0 {
				ui.Spacer(c).Grow(gap)
			}
			color := t.TextMuted.Alpha(0.6)
			if i == current {
				color = t.Accent
			}
			idx := i
			if ui.ButtonBase(c).Label(a.tr("chat.jumpTo")).Tooltip(oneLine(messages[i].Text, 80)).Padding(3, 3).Children(func() {
				ui.Box(c).Width(8).Height(2).Radius(1).Background(color)
			}).Clicked() {
				a.jumpTo(c, idx)
			}
		}
		ui.Spacer(c).Grow(1 - prev)
	})
}

// composer 是输入区（参考 Tern）：上方是状态行（处理中与已用时）、上下文用量与排队的消息；下方是一张圆角
// 卡片，里面是随内容长高的多行输入，以及模型、思考强度、回复中的 Enter 行为和圆形的发送/停止按钮。
// Enter 发送，Shift+Enter 换行；输入还只是 /命令前缀时 Enter 先补全。
func (a *app) composer(c *ui.Context) {
	t := c.Theme()
	busy := a.chat.Busy && a.connected
	ui.Column(c).Padding(4, 24, 16, 24).Children(func() {
		a.centered(c, func() {
			if a.slashOpen() {
				a.slashMenu(c)
			}
			if busy || len(a.chat.QueuedInputs) > 0 {
				a.statusLine(c, busy)
			}
			a.contextMeter(c)
			ui.Column(c).Radius(radiusBubble).Background(t.Surface).BorderWidth(1).BorderColor(t.Border).Padding(10, 12, 8, 12).Gap(6).Children(func() {
				ui.TextArea(c, &a.input).Label(a.tr("chat.message")).Placeholder(a.tr("chat.placeholder")).Lines(1, 8).MinHeight(0).
					BorderWidth(0).Background(t.Surface).AutoFocus().OnTextKey(func(k ui.TextKey) bool {
					if k.Key != ui.KeyEnter || k.Mods != 0 {
						return false // Shift+Enter 换行
					}
					a.input = k.Text()
					if !a.completeSlash() {
						if a.canSend() {
							a.send()
						}
					}
					k.SetText(a.input)
					return true
				})
				ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
					if options := a.modelOptions(); len(options) > 0 {
						sel := ui.Select(c, &a.cv.modelChoice, options).MaxWidth(240).MinWidth(0).FontSize(a.fs(textCaption))
						if sel.Changed() {
							a.chooseModel(a.cv.modelChoice)
						}
					}
					if options := a.thinkingOptions(); len(options) > 1 {
						sel := ui.Select(c, &a.cv.thinkingChoice, options).MaxWidth(120).MinWidth(0).FontSize(a.fs(textCaption))
						if sel.Changed() {
							a.chooseThinking(a.cv.thinkingChoice)
						}
					}
					if busy {
						ui.Segmented(c, &a.cv.busyMode, a.tr("chat.queue"), a.tr("chat.steer")).Shrink(0).Label(a.tr("chat.enterMode")).FontSize(a.fs(textCaption))
					}
					ui.Spacer(c)
					if busy {
						if iconButton(c, icons.Stop, a.tr("chat.stop")).Radius(999).Tooltip(a.tr("chat.stopTip")).Shrink(0).Clicked() {
							a.abort()
						}
					}
					if primaryIconButton(c, icons.Send, a.tr("chat.send")).Radius(999).Shrink(0).Disabled(!a.canSend()).Clicked() {
						if !a.completeSlash() {
							a.send()
						}
					}
				})
			})
		})
	})
}

// statusLine 是输入框上方的一行：回复进行中时显示「处理中 │ 已用时」，右侧是排队等待的消息（每条一个
// 小标签，悬停看全文与它是排队还是引导）。
func (a *app) statusLine(c *ui.Context, busy bool) {
	t := c.Theme()
	ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(0, 4).Children(func() {
		if busy {
			ui.Spinner(c)
			ui.Text(c, a.tr("chat.working")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			if !a.cv.busySince.IsZero() {
				elapsed := c.Now().Sub(a.cv.busySince)
				if elapsed < 0 {
					elapsed = 0
				}
				ui.Text(c, "│").FontSize(a.fs(textCaption)).TextColor(t.Border)
				a.buffer(ui.Text(c, formatElapsed(elapsed))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
				c.After(time.Second - elapsed%time.Second)
			}
		}
		ui.Spacer(c)
		for _, q := range a.chat.QueuedInputs {
			tip := a.tr("chat.queuedTip")
			if q.Mode == "steer" {
				tip = a.tr("chat.steerTip")
			}
			ui.Text(c, oneLine(q.Text, 28)).FontSize(a.fs(textCaption)).Padding(3, 10).Radius(999).Background(a.tokens().Tok.Card).
				BorderWidth(1).BorderColor(t.Border).Tooltip(tip + "\n" + q.Text).Shrink(1).MinWidth(0).SingleLine()
		}
	})
}

// contextMeter 是输入框上方的一条细进度条：最近一次回复用掉的上下文占当前模型上下文窗口的比例。
// 不知道模型的上下文窗口、还没有回复，或用量不到 1% 时不画。
func (a *app) contextMeter(c *ui.Context) {
	window := a.contextWindow()
	if window <= 0 {
		return
	}
	used := 0
	for i := len(a.chat.Messages) - 1; i >= 0; i-- {
		if u := a.chat.Messages[i].Usage; u != nil {
			used = u.Input + u.CacheRead + u.CacheWrite + u.Output
			break
		}
	}
	if used <= 0 {
		return
	}
	t := c.Theme()
	frac := float32(used) / float32(window)
	if frac < 0.01 {
		return // 不到 1% 时一条空进度条加「0%」没有信息量
	}
	if frac > 1 {
		frac = 1
	}
	pct := fmt.Sprintf("%.0f%%", frac*100)
	color := t.Accent
	if frac > 0.8 {
		color = t.Warning
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(0, 4, 4, 4).Tooltip(a.tr("chat.context", "percent", pct, "window", formatCount(window))).Children(func() {
		ui.Row(c).Grow(1).Height(3).Radius(2).Background(t.Border).Clip().Children(func() {
			ui.Box(c).WidthPercent(frac * 100).Height(3).Background(color)
		})
		a.buffer(ui.Text(c, pct)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Shrink(0)
	})
}

// contextWindow 返回会话当前模型的上下文窗口（token）；不知道时为 0。
func (a *app) contextWindow() int {
	ref := a.chat.Model
	if ref == nil {
		return 0
	}
	for _, m := range a.cv.models {
		if m.Provider == ref.Provider && m.ID == ref.ModelID {
			return m.ContextWindow
		}
	}
	return 0
}

// formatElapsed 把已用时写成 12s、3m 05s。
func formatElapsed(d time.Duration) string {
	s := int(d / time.Second)
	if s < 60 {
		return fmt.Sprintf("%ds", s)
	}
	return fmt.Sprintf("%dm %02ds", s/60, s%60)
}

// outputHeight 估一段等宽正文在 limit 高度内需要多少 DIP：约 90 个字符折一行、每行 18 DIP。
// 只决定滚动窗口的高度，不参与内容裁剪，估小了仍然能滚动看全。
func outputHeight(text string, limit float32) float32 {
	lines := 0
	for _, line := range strings.Split(text, "\n") {
		lines++
		if extra := len(line) / 90; extra > 0 {
			lines += extra
		}
	}
	h := float32(lines)*18 + 16
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

// slashMenu 是输入框上方的命令列表；点击一项把命令补进输入框。
func (a *app) slashMenu(c *ui.Context) {
	t := c.Theme()
	matches := a.slashMatches()
	ui.Column(c).Padding(6, 8).Radius(radiusCard).Background(a.tokens().Tok.Card).BorderWidth(1).BorderColor(t.Border).Children(func() {
		ui.Text(c, "Commands").FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Padding(0, 6)
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
				if ui.Button(c, label).Tooltip(command.Description).Justify(ui.Start).Clicked() {
					a.input = "/" + command.Name + " "
				}
			}
		})
	})
}

// provEntry 是一条回答的数字出处缓存：消息条数与回答长度不变时结果不变。
type provEntry struct {
	messages, textLen int
	p                 conversation.Provenance
	ok                bool
}

// provenanceOf 返回 messages[i] 的数字出处（缓存）。
func (a *app) provenanceOf(messages []conversation.Message, i int) (conversation.Provenance, bool) {
	if a.cv.prov == nil {
		a.cv.prov = map[string]provEntry{}
	}
	m := messages[i]
	if e, ok := a.cv.prov[m.Key]; ok && e.messages == i && e.textLen == len(m.Text) {
		return e.p, e.ok
	}
	p, ok := conversation.ProvenanceOf(messages, i)
	a.cv.prov[m.Key] = provEntry{messages: i, textLen: len(m.Text), p: p, ok: ok}
	return p, ok
}

// provenanceRow 是回答下方的一行「出处」：回答里的数据类数字来自哪些工具调用（点一下跳到那张工具卡片），以及
// 在工具结果里找不到出处的数字。规则与服务端的质量闸门一致（conversation.ProvenanceOf）。这一轮没有数据类
// 工具、或回答里没有数据类数字时不画。
func (a *app) provenanceRow(c *ui.Context, messages []conversation.Message, i int) {
	p, ok := a.provenanceOf(messages, i)
	if !ok || p.Checked == 0 {
		return
	}
	t := c.Theme()
	tok := a.tokens().Tok
	ui.Row(c).Gap(6).AlignItems(ui.Center).Wrap().Children(func() {
		ui.Icon(c, icons.Verified).TextColor(t.TextMuted)
		ui.Text(c, a.tr("chat.sources")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		for _, src := range p.Sources {
			label := a.tr("chat.sourceNumbers", "tool", src.Tool, "count", strconv.Itoa(len(src.Numbers)))
			index := src.Index
			if ui.ButtonBase(c).Label(label).Tooltip(strings.Join(src.Numbers, ", ")).Children(func() {
				a.buffer(ui.Text(c, label)).FontSize(a.fs(textCaption)).TextColor(t.Accent).
					Padding(2, 8).Radius(999).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder)
			}).Clicked() {
				a.jumpTo(c, index)
			}
		}
		if n := len(p.Unsupported); n > 0 {
			label := a.tr("chat.unsupported", "count", strconv.Itoa(n))
			ui.Row(c).Gap(4).AlignItems(ui.Center).Padding(2, 8).Radius(999).Background(t.Warning.Alpha(0.12)).
				Tooltip(a.tr("chat.unsupportedTip") + "\n" + strings.Join(p.Unsupported, ", ")).Children(func() {
				ui.Icon(c, icons.Info).TextColor(t.Warning)
				ui.Text(c, label).FontSize(a.fs(textCaption)).TextColor(t.Warning)
			})
		}
	})
}

// jumpTo 把消息列表滚到第 i 行（提问或工具卡片），并暂停跟随底部，直到用户滚回底部、发出新消息或换会话。
func (a *app) jumpTo(c *ui.Context, i int) {
	a.cv.followPaused, a.cv.jumpedAt = true, c.Now()
	a.list.FollowEnd = false
	a.list.ScrollTo(i, ui.Start)
}
