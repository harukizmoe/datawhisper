package main

// 聊天页的渲染：标题、消息流（Markdown 正文、工具调用摘要、ask_user 卡片）、模型与思考强度选择、
// 输入框与斜杠命令。app.go 只保留服务状态、导航与会话切换。

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/api"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

// chatView 是聊天页自己的界面状态。它只由 UI 线程读写；切换会话时 resetConversation 清掉与会话
// 相关的部分，模型目录与命令目录保留（它们与具体会话无关）。
type chatView struct {
	// openTools 记住哪些工具行被展开；默认全部折叠，只显示一行摘要。
	openTools map[string]bool
	// asks 按工具调用 id 记住 ask_user 卡片的本地编辑状态。
	asks map[string]*askUI

	// 重命名弹窗。
	renaming   bool
	renameText string
	renameErr  string
	renameBusy bool

	// 模型与思考强度。
	models      []api.AvailableModel
	modelsErr   string
	modelChoice string
	// thinkingChoice 是思考强度下拉框的值；thinkingDefault 表示未设置。
	thinkingChoice string
	// modelsTouched：用户已经改了模型、服务端还没确认。这段时间不把下拉框拨回旧值，避免闪回。
	modelsTouched bool

	// 斜杠命令目录（command.list）。
	commands []api.Command

	// busyMode 是回复进行中按下 Enter 的行为：0 排队（followUp），1 插队（steer）。
	busyMode int
}

// askUI 是一张 ask_user 卡片的本地状态：单选、多选、自由输入以及是否已经发送。
type askUI struct {
	choice string
	checks map[string]bool
	free   string
	sent   string
	busy   bool
	err    string
}

// modelDefault 是“会话还没有模型”时下拉框显示的值；它不对应任何真实模型，选中它不会调用 setModel。
const modelDefault = "Default model"

// thinkingDefault 表示思考强度未设置；服务端用 ThinkingLevel=nil 清空。
const thinkingDefault = "Default"

// internalAskInstruction 是服务端写在 ask_user 工具结果正文里的内部指令
// （server/src/tools/app/interaction.ts：`问题已展示给用户，等待用户回答后继续。请不要输出任何文字。`）。
// 它是给模型的指令，不是内容；模型有时会把它原样复述进回复，所以从可见文本里删掉。
// ask_user 的结果正文整体不显示（卡片已经表达了问题与选项），其他工具的正文只在展开时才出现。
const internalAskInstruction = "问题已展示给用户，等待用户回答后继续。请不要输出任何文字。"

// placeholderTitles 是服务端在会话既没有 session_meta 标题、也没有首条用户消息时给出的占位文案
// （server/src/library/sessions.ts 的 “默认会话” / “未命名会话”）。它们不是用户起的名字，按无标题处理。
var placeholderTitles = map[string]bool{"默认会话": true, "未命名会话": true}

func (v *chatView) resetConversation() {
	v.openTools = nil
	v.asks = nil
	v.renaming, v.renameText, v.renameErr, v.renameBusy = false, "", "", false
	v.modelChoice, v.thinkingChoice = "", ""
	v.modelsTouched = false
}

func (v *chatView) askState(callID string) *askUI {
	if v.asks == nil {
		v.asks = map[string]*askUI{}
	}
	st, ok := v.asks[callID]
	if !ok {
		st = &askUI{}
		v.asks[callID] = st
	}
	return st
}

// sessionTitle 是侧边栏与标题栏共用的会话名：优先会话库里的标题（服务端已经用首条用户消息兜底），
// 当前会话还没有列表项时用本地副本里的首条用户消息，最后才回退到 New chat。
func (a *app) sessionTitle(id int) string {
	for _, session := range a.sessions {
		if session.ID != id {
			continue
		}
		if title := strings.TrimSpace(session.Title); title != "" && !placeholderTitles[title] {
			return title
		}
		break
	}
	if id == a.conv {
		for _, m := range a.chat.Messages {
			if m.Role != "user" {
				continue
			}
			if text := strings.TrimSpace(visibleText(m.Text)); text != "" {
				return oneLine(text, 80)
			}
		}
	}
	return "New chat"
}

// oneLine 把一段文本压成单行并限长：列表行与标题栏都只显示一行，换行会把布局撑成两行。
func oneLine(s string, limit int) string {
	s = strings.Join(strings.Fields(s), " ")
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	if limit <= 1 {
		return "…"
	}
	return string(runes[:limit-1]) + "…"
}

// visibleText 去掉只写给模型的内部指令；其余文本原样保留。
func visibleText(s string) string {
	if !strings.Contains(s, internalAskInstruction) {
		return s
	}
	return strings.TrimSpace(strings.ReplaceAll(s, internalAskInstruction, ""))
}

// chatPage 构建聊天页：标题栏、横幅、消息列表、错误行与输入区。
func (a *app) chatPage(c *ui.Context) {
	t := c.Theme()
	a.chatHeader(c)
	a.banner(c)
	if a.cv.modelsErr != "" {
		ui.Text(c, a.cv.modelsErr).FontSize(12).TextColor(t.Danger).Padding(4, 24)
	}
	messages := a.chat.Messages
	a.list.Key = func(i int) any { return messages[i].Key }
	a.list.FollowEnd = true
	ui.List(c, &a.list, len(messages), func(i int) {
		a.message(c, messages[i])
	}).Grow(1).Padding(16, 24).Gap(12).Justify(ui.End).Children(func() {
		if len(messages) == 0 {
			hint := "Ask a question about your data."
			if a.conv != 0 && !a.connected {
				hint = "Loading the conversation…"
			}
			ui.Text(c, hint).TextColor(t.TextMuted).Margin(ui.Auto)
		}
	})
	if a.chat.Failure != "" && !a.chat.Busy {
		ui.Text(c, "The last reply did not finish: "+a.chat.Failure).FontSize(12).TextColor(t.Warning).Padding(4, 24)
	}
	if a.sendErr != "" {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(4, 24).Children(func() {
			ui.Text(c, a.sendErr).TextColor(t.Danger).Grow(1).MinWidth(0)
			if a.needModel && ui.Button(c, "Open settings").Clicked() {
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
	title := "New chat"
	if a.conv != 0 {
		title = a.sessionTitle(a.conv)
	}
	ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(10, 24).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
		// Grow+MinWidth(0) 让它把多余宽度让给右侧控件，SingleLine 在放不下时以省略号结尾。
		ui.Text(c, title).Bold().SingleLine().Grow(1).MinWidth(0).Tooltip(title)
		if a.conv != 0 && ui.Button(c, "Rename").Tooltip("Rename this chat").Clicked() {
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
		label := "Data"
		if a.src.open {
			label = "Hide data"
		}
		if ui.Button(c, label).Tooltip("Data sources, workspace and artifacts of this chat").Clicked() {
			a.toggleSources()
		}
		label2, color := a.statusLabel(t)
		ui.Text(c, "●").TextColor(color)
		ui.Text(c, label2).TextColor(t.TextMuted)
	})
}

// message 构建一行聊天内容：用户的消息放在右侧气泡里，工具调用是一行可展开的摘要，ask_user 是
// 问题卡片，回复用 Markdown（流式时 markdown.Stream，落定后 markdown.View，同一个列表行）。
func (a *app) message(c *ui.Context, m api.Message) {
	t := c.Theme()
	switch {
	case m.Role == "user":
		ui.Row(c).Children(func() {
			ui.Spacer(c)
			ui.Text(c, m.Text).Selectable().Padding(8, 12).Radius(14).Background(t.Surface).MaxWidth(560)
		})
	case m.Role == "tool" && m.Tool != nil && m.Tool.Ask != nil:
		a.askCard(c, m)
	case m.Role == "tool" && m.Tool != nil:
		a.toolRow(c, m)
	case m.Role == "tool":
		ui.Text(c, m.Text).FontSize(12).TextColor(t.TextMuted)
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

// toolRow 是一次工具调用的一行摘要：名字、参数摘要、耗时与状态；结果默认折叠，点击展开后
// 在限高的滚动区里看全文。参数与结果的原始 JSON 不再进入消息流。
func (a *app) toolRow(c *ui.Context, m api.Message) {
	t := c.Theme()
	tool := m.Tool
	open := a.cv.openTools[m.Key]
	// ask_user 的结果正文是给模型的指令（见 internalAskInstruction）；没有可解析的问题时也绝不显示它。
	output := ""
	if tool.Name != "ask_user" {
		output = tool.Output
	}
	ui.Column(c).MaxWidth(760).Padding(4, 8).Radius(8).Background(t.Surface).BorderWidth(0, 0, 0, 2).BorderColor(t.Border).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, tool.Name).FontSize(12)
			if tool.Args != "" {
				ui.Text(c, tool.Args).FontSize(11).TextColor(t.TextMuted).SingleLine().Grow(1).MinWidth(0)
			} else {
				ui.Spacer(c)
			}
			if tool.Status == "running" && !m.Done {
				ui.Spinner(c)
			}
			ui.Text(c, toolMeta(tool)).FontSize(11).TextColor(toolStatusColor(t, tool.Status))
			if output != "" {
				label := "Details"
				if open {
					label = "Hide"
				}
				if ui.Button(c, label).FontSize(11).Tooltip("Show the full tool output").Clicked() {
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
			ui.Scroll(c).Height(outputHeight(output, 240)).Children(func() {
				ui.Text(c, output).FontSize(12).Selectable()
			})
		}
	})
}

// askCard 是 ask_user 的问题卡片：选项来自工具自己的 question/options，点选后通过 conversation.submit
// 以 followUp 提交；也允许在输入框里自由回答。
func (a *app) askCard(c *ui.Context, m api.Message) {
	t := c.Theme()
	ask := m.Tool.Ask
	callID := m.Tool.CallID
	if callID == "" {
		callID = m.Key
	}
	st := a.cv.askState(callID)
	ui.Column(c).MaxWidth(560).Padding(12, 14).Radius(12).Background(t.Surface).Gap(8).Children(func() {
		ui.Text(c, "Quick question").FontSize(11).TextColor(t.TextMuted)
		ui.Text(c, ask.Question).Bold()
		if st.sent != "" {
			ui.Text(c, "Answer sent: "+oneLine(st.sent, 80)).FontSize(12).TextColor(t.TextMuted)
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
				ui.Text(c, st.err).FontSize(12).TextColor(t.Danger).Grow(1).MinWidth(0)
			}
		})
	})
}

// toolMeta 生成摘要行右侧的「耗时 · 状态」。
func toolMeta(tool *api.ToolCall) string {
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
				ui.Text(c, "The reply is still running.").FontSize(12).TextColor(t.TextMuted).Shrink(0)
				ui.Segmented(c, &a.cv.busyMode, "Queue", "Steer").Shrink(0).Label("What Enter does while the reply runs")
				hint := "Enter queues this message for after the reply."
				if a.cv.busyMode == 1 {
					hint = "Enter adds this message to the running reply."
				}
				ui.Text(c, hint).FontSize(11).TextColor(t.TextMuted).SingleLine().Grow(1).MinWidth(0)
				if a.chat.Queued > 0 {
					ui.Text(c, fmt.Sprintf("%d queued", a.chat.Queued)).FontSize(11).TextColor(t.TextMuted).Shrink(0)
				}
			})
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(12, 24).Children(func() {
			// MinWidth(0) 让输入框在窄窗口里真的能被压缩，否则按钮会被挤出窗口并裁成 “Sen…”。
			in := ui.TextInput(c, &a.input).Label("Message").Placeholder("Ask about your data").Grow(1).MinWidth(0).AutoFocus()
			if a.chat.Busy && a.connected && ui.Button(c, "Stop").Shrink(0).Tooltip("Stop the reply and withdraw queued messages").Clicked() {
				a.abort()
			}
			send := ui.PrimaryButton(c, "Send").Shrink(0).Disabled(!a.canSend())
			if send.Clicked() || in.Submitted() {
				// 输入还只是一个 /命令前缀时，Enter 先补全，不直接发送。
				if !a.completeSlash() {
					a.send()
				}
			}
		})
	})
}

// openRename 打开标题编辑弹窗，预填当前标题。
func (a *app) openRename() {
	if a.conv == 0 {
		return
	}
	a.cv.renaming = true
	a.cv.renameText = a.sessionTitle(a.conv)
	a.cv.renameErr = ""
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
				ui.Text(c, a.cv.renameErr).FontSize(12).TextColor(t.Danger)
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

// renameSession 把新标题写到会话库（session.rename），成功后同步列表与标题栏。
func (a *app) renameSession() {
	title := strings.TrimSpace(a.cv.renameText)
	if title == "" {
		a.cv.renameErr = "The title cannot be empty."
		return
	}
	if a.client == nil || a.conv == 0 {
		a.cv.renameErr = "The chat is not connected."
		return
	}
	client, conv := a.client, a.conv
	a.cv.renameBusy, a.cv.renameErr = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		saved, err := client.RenameSession(ctx, conv, title)
		a.post(func() {
			if client != a.client || conv != a.conv {
				return
			}
			a.cv.renameBusy = false
			if err != nil {
				a.cv.renameErr = "Could not rename the chat: " + err.Error()
				return
			}
			for i := range a.sessions {
				if a.sessions[i].ID == conv {
					a.sessions[i].Title = saved
				}
			}
			a.cv.renaming = false
		})
	}()
}

// answerAsk 提交 ask_user 的回答：优先自由输入，其次多选，最后单选。答案按 followUp 提交，
// 这样即使模型还在收尾，它也会在下一轮拿到回答。
func (a *app) answerAsk(callID string, ask *api.AskRequest, st *askUI) {
	if st.busy {
		return
	}
	text := strings.TrimSpace(st.free)
	if text == "" {
		if ask.MultiSelect {
			var picked []string
			for _, option := range ask.Options {
				if st.checks[option] {
					picked = append(picked, option)
				}
			}
			text = strings.Join(picked, ", ")
		} else {
			text = st.choice
		}
	}
	if text == "" {
		st.err = "Choose an option or type an answer."
		return
	}
	client, conv := a.client, a.conv
	if client == nil || conv == 0 {
		st.err = "The chat is not connected."
		return
	}
	st.busy, st.err = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, err := client.Submit(ctx, strconv.Itoa(conv), api.SubmitRequest{
			RequestID: newRequestID(),
			Text:      text,
			WhenBusy:  "followUp",
		})
		a.post(func() {
			st.busy = false
			if err != nil {
				st.err = "Could not send the answer: " + err.Error()
				return
			}
			st.sent = text
		})
	}()
}

// whenBusy 返回提交时使用的 whenBusy：没有回合在跑时留空（服务端默认 followUp）。
func (a *app) whenBusy() string {
	if !a.chat.Busy {
		return ""
	}
	if a.cv.busyMode == 1 {
		return "steer"
	}
	return "followUp"
}

// slashPrefix 返回输入框里正在补全的命令前缀；只有 “/前缀” 这种还没写参数的形式才算。
func (a *app) slashPrefix() (string, bool) {
	text := a.input
	if !strings.HasPrefix(text, "/") {
		return "", false
	}
	rest := text[1:]
	if strings.ContainsAny(rest, " \t\n") {
		return "", false
	}
	// 只有一个 “/” 时列出全部命令；写了参数就不再补全。
	return strings.ToLower(rest), true
}

// slashMatches 是当前前缀能补全的命令。
func (a *app) slashMatches() []api.Command {
	prefix, ok := a.slashPrefix()
	if !ok {
		return nil
	}
	var matches []api.Command
	for _, command := range a.cv.commands {
		if command.Available == false && command.Unavailable != "" {
			continue
		}
		if strings.HasPrefix(strings.ToLower(command.Name), prefix) {
			matches = append(matches, command)
			continue
		}
		for _, alias := range command.Aliases {
			if strings.HasPrefix(strings.ToLower(alias), prefix) {
				matches = append(matches, command)
				break
			}
		}
	}
	return matches
}

func (a *app) slashOpen() bool {
	return !a.sending && len(a.slashMatches()) > 0
}

// slashMenu 是输入框上方的一行命令列表；点击一项把命令补进输入框。
func (a *app) slashMenu(c *ui.Context) {
	t := c.Theme()
	matches := a.slashMatches()
	ui.Column(c).Padding(6, 24).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
		ui.Text(c, "Commands").FontSize(11).TextColor(t.TextMuted)
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

// completeSlash 在 Enter 时把唯一的候选命令补全进输入框，并报告是否消化了这次 Enter。
// 有多个候选时只维持列表，让用户继续输入或点击，也不会把半截命令发出去。
func (a *app) completeSlash() bool {
	matches := a.slashMatches()
	if len(matches) != 1 {
		// 一个候选也没有时不算命令，交给调用方正常发送（例如 “/” 本身是普通文本）。
		return len(matches) > 0
	}
	a.input = "/" + matches[0].Name + " "
	return true
}

// slashCommandName 把 “/name args” 里的命令名解析出来（大小写不敏感，接受别名）；不是命令时为空。
func slashCommandName(text string, commands []api.Command) string {
	if !strings.HasPrefix(text, "/") {
		return ""
	}
	fields := strings.Fields(text[1:])
	if len(fields) == 0 {
		return ""
	}
	name := strings.ToLower(fields[0])
	for _, command := range commands {
		if strings.ToLower(command.Name) == name {
			return command.Name
		}
		for _, alias := range command.Aliases {
			if strings.ToLower(alias) == name {
				return command.Name
			}
		}
	}
	return ""
}

// refreshModels 拉取可用于切换的模型目录（models.available）。
func (a *app) refreshModels() {
	client := a.client
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		models, err := client.AvailableModels(ctx)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				a.cv.modelsErr = "Could not load the models: " + err.Error()
				return
			}
			a.cv.models, a.cv.modelsErr = models, ""
		})
	}()
}

// refreshCommands 拉取斜杠命令目录（command.list）。
func (a *app) refreshCommands() {
	client := a.client
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		commands, err := client.Commands(ctx)
		a.post(func() {
			if client != a.client {
				return
			}
			if err != nil {
				return // 目录加载失败时输入框就不提供补全，不影响普通消息
			}
			a.cv.commands = commands
		})
	}()
}

// modelLabel 是模型在设置与下拉框里的唯一名字：提供方/模型 id。
func refLabel(ref *api.ModelRef) string {
	if ref == nil {
		return ""
	}
	return ref.Provider + "/" + ref.ModelID
}

func thinkingLabel(level string) string {
	if level == "" {
		return thinkingDefault
	}
	return level
}

// modelOptions 是模型下拉框的选项。会话当前的模型即使不在目录里（提供方被停用）也保留一项，
// 否则下拉框会显示成空；会话还没有模型时用 Default model 表示“服务端选择默认模型”。
func (a *app) modelOptions() []string {
	var options []string
	if a.chat.Model == nil {
		options = append(options, modelDefault)
	}
	for _, m := range a.cv.models {
		options = append(options, m.Provider+"/"+m.ID)
	}
	current := refLabel(a.chat.Model)
	if current != "" && !hasString(options, current) {
		options = append(options, current)
	}
	return options
}

// thinkingOptions 是当前模型的思考强度选项；模型不支持思考时返回 nil（界面不显示这个下拉框）。
func (a *app) thinkingOptions() []string {
	levels := a.thinkingLevels()
	if len(levels) == 0 {
		return nil
	}
	return append([]string{thinkingDefault}, levels...)
}

func (a *app) thinkingLevels() []string {
	label := a.cv.modelChoice
	for _, m := range a.cv.models {
		if modelLabel(m) == label {
			return m.ThinkingLevels
		}
	}
	return nil
}

// syncModelControls 把下拉框拨到会话的真实模型与思考强度；用户已经改过、服务端还没确认时不覆盖。
func (a *app) syncModelControls() {
	if a.cv.modelsTouched {
		return
	}
	choice := refLabel(a.chat.Model)
	if a.chat.Model == nil {
		choice = modelDefault
	}
	if a.cv.modelChoice != choice {
		a.cv.modelChoice = choice
	}
	if options := a.thinkingOptions(); len(options) > 1 {
		want := thinkingLabel(a.chat.ThinkingLevel)
		if !hasString(options, want) {
			want = thinkingDefault
		}
		if a.cv.thinkingChoice != want {
			a.cv.thinkingChoice = want
		}
	}
}

// syncFromState 在订阅送来新状态后同步模型控件；切换会话时连思考强度一起重置。
func (a *app) syncFromState(switched bool) {
	if switched {
		a.cv.modelChoice, a.cv.thinkingChoice = "", ""
		a.cv.modelsTouched = false
	}
	a.syncModelControls()
}

// chooseModel 处理下拉框的新选择，调用 conversation.setModel。
func (a *app) chooseModel(label string) {
	if label == "" || label == modelDefault {
		return
	}
	var ref api.ModelRef
	found := false
	for _, m := range a.cv.models {
		if m.Provider+"/"+m.ID == label {
			ref, found = api.ModelRef{Provider: m.Provider, ModelID: m.ID}, true
			break
		}
	}
	if !found {
		a.cv.modelsErr = "That model is not available: " + label
		a.cv.modelsTouched = false
		return
	}
	level := a.chat.ThinkingLevel
	if !hasString(a.thinkingLevels(), level) {
		level = ""
	}
	a.setModel(ref, level)
}

// chooseThinking 保持模型不变，只切换思考强度。
func (a *app) chooseThinking(label string) {
	var ref api.ModelRef
	found := false
	for _, m := range a.cv.models {
		if m.Provider+"/"+m.ID == a.cv.modelChoice {
			ref, found = api.ModelRef{Provider: m.Provider, ModelID: m.ID}, true
			break
		}
	}
	if !found {
		return
	}
	level := ""
	if label != thinkingDefault {
		level = label
	}
	a.setModel(ref, level)
}

// setModel 把模型与思考强度写到会话；下一次模型请求开始生效。
func (a *app) setModel(ref api.ModelRef, level string) {
	if a.client == nil || a.conv == 0 {
		a.cv.modelsErr = "Open a chat before choosing a model."
		a.cv.modelsTouched = false
		return
	}
	client, conv := a.client, a.conv
	var thinking *string
	if level != "" {
		thinking = &level
	}
	a.cv.modelsTouched, a.cv.modelsErr = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		resp, err := client.SetModel(ctx, strconv.Itoa(conv), api.SetModelRequest{Model: ref, ThinkingLevel: thinking})
		a.post(func() {
			if client != a.client || conv != a.conv {
				return
			}
			a.cv.modelsTouched = false
			if err != nil {
				a.cv.modelsErr = "Could not switch the model: " + err.Error()
				return
			}
			a.chat.Model = resp.Model
			a.chat.ThinkingLevel = resp.ThinkingLevel
			a.cv.modelChoice = refLabel(resp.Model)
			a.cv.thinkingChoice = thinkingLabel(resp.ThinkingLevel)
		})
	}()
}

func hasString(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}
