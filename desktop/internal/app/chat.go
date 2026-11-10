package app

// 聊天页的渲染：标题、消息流（Markdown 正文、工具调用摘要、ask_user 卡片）、模型与思考强度选择、
// 输入框与斜杠命令。app.go 只保留服务状态、导航与会话切换。

import (
	"context"
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/i18n"
	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

// chatView 是聊天页自己的界面状态。它只由 UI 线程读写；切换会话时 resetConversation 清掉与会话
// 相关的部分，模型目录与命令目录保留（它们与具体会话无关）。
type chatView struct {
	// openTools 记住哪些工具行被展开；默认全部折叠，只显示一行摘要。
	openTools map[string]bool
	// openNotes 记住哪些宿主旁注（质量闸门、系统提醒）被展开；默认折叠。
	openNotes map[string]bool
	// asks 按工具调用 id 记住 ask_user 卡片的本地编辑状态。
	asks map[string]*askUI

	// 重命名弹窗。
	renaming   bool
	renameText string
	renameErr  string
	renameBusy bool

	// 模型与思考强度。
	models      []service.AvailableModel
	modelsErr   string
	modelChoice string
	// thinkingChoice 是思考强度下拉框的值；thinkingDefault 表示未设置。
	thinkingChoice string
	// modelsTouched：用户已经改了模型、服务端还没确认。这段时间不把下拉框拨回旧值，避免闪回。
	modelsTouched bool

	// 斜杠命令目录（command.list）。
	commands []service.Command

	// busyMode 是回复进行中按下 Enter 的行为：0 排队（followUp），1 插队（steer）。
	busyMode int

	// openThinking 记住哪些思考行被点过：「折叠」方式下点开，「展开」方式下不用（那时没有切换）。
	openThinking map[string]bool
	// openOutputs 记住哪些工具卡片的输出被点过，相对「工具输出」方式的默认状态翻转一次：预览/折叠 → 全文，
	// 展开 → 预览（失败的卡片始终是全文）。
	openOutputs map[string]bool
	// openRuns 记住哪些折叠的工具调用组被点开（键是组内第一条消息的 key）。
	openRuns map[string]bool
	// rows 与 rowOf 是这一帧的消息行划分（chat_fold.go）：rowOf[i] 是消息 i 所在的行，导航与跳转据此换算。
	rows  []chatRow
	rowOf []int
	// tasks 是 agent 任务板的最近一次读取结果（tasks.go），tasksOpen 是任务行是否展开，taskCalls 是读取时
	// 已完成的任务工具调用数：变了就重新读取。
	tasks     []service.Task
	tasksOpen bool
	taskCalls int
	// cardRef 绑在输入卡片上，据它判断焦点是否还在输入区内（含卡片里的模型选择与发送按钮）。composerSeen 记下
	// 卡片获得过焦点：刚建出来的那一帧焦点还没生效，不能因此折叠。wantFocus 是点击折叠条后让输入框重新取得焦点。
	cardRef      ui.Handle
	composerSeen bool
	wantFocus    bool
	blurSince    time.Time
	// dockRef 绑在悬浮的输入区整体上；消息列最后一行据它上一帧的高度留白。
	dockRef ui.Handle
	// fullChart 与 fullOpen 是全屏查看的图表（richcontent.go）。
	fullChart conversation.Chart
	fullOpen  bool
	// prov 缓存每条回答的数字出处（键是消息 key）；回答文本或之前的消息变了就重算。
	prov map[string]provEntry
	// followPaused：用户跳到了某条提问或出处，消息列表暂时不跟随底部；jumpedAt 是跳转的时刻。
	followPaused bool
	jumpedAt     time.Time
	// busySince 是当前这次回复开始的时刻，状态行据此显示已用时；不在回复中时为零值。
	busySince time.Time
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
	v.openThinking, v.openOutputs, v.openRuns, v.prov = nil, nil, nil, nil
	v.tasks, v.tasksOpen, v.taskCalls = nil, false, 0
	v.composerSeen, v.wantFocus, v.blurSince = false, false, time.Time{}
	v.followPaused, v.fullOpen = false, false
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
// sessionTitleOr 是会话的标题；会话列表里还没有它（例如只在搜索结果里）时用 fallback。
func (a *app) sessionTitleOr(id int, fallback string) string {
	for _, s := range a.sessions {
		if s.ID == id {
			return a.sessionTitle(id)
		}
	}
	if strings.TrimSpace(fallback) != "" {
		return fallback
	}
	return a.sessionTitle(id)
}

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
	return a.tr("menu.newChat")
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

// openRename 打开标题编辑弹窗，预填当前标题。
func (a *app) openRename() {
	if a.conv == 0 {
		return
	}
	a.cv.renaming = true
	a.cv.renameText = a.sessionTitle(a.conv)
	a.cv.renameErr = ""
}

// renameSession 把新标题写到会话库（session.rename），成功后同步列表与标题栏。
func (a *app) renameSession() {
	title := strings.TrimSpace(a.cv.renameText)
	if title == "" {
		a.cv.renameErr = a.tr("chat.titleEmpty")
		return
	}
	if a.client == nil || a.conv == 0 {
		a.cv.renameErr = a.tr("chat.notConnected")
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
				a.cv.renameErr = a.tr("chat.renameFailed", "error", err.Error())
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
func (a *app) answerAsk(callID string, ask *conversation.AskRequest, st *askUI) {
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
		st.err = a.tr("chat.askChoose")
		return
	}
	client, conv := a.client, a.conv
	if client == nil || conv == 0 {
		st.err = a.tr("chat.notConnected")
		return
	}
	st.busy, st.err = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, err := client.Submit(ctx, strconv.Itoa(conv), service.SubmitRequest{
			RequestID: newRequestID(),
			Text:      text,
			WhenBusy:  "followUp",
		})
		a.post(func() {
			st.busy = false
			if err != nil {
				st.err = a.tr("chat.askFailed", "error", err.Error())
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
func (a *app) slashMatches() []service.Command {
	prefix, ok := a.slashPrefix()
	if !ok {
		return nil
	}
	var matches []service.Command
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
func slashCommandName(text string, commands []service.Command) string {
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
				a.cv.modelsErr = a.tr("chat.modelsFailed", "error", err.Error())
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

// syncLanguage 把界面语言告诉服务（app.setLanguage），之后重新拉命令目录：命令说明由服务按语言给出。
// 设置语言失败时服务沿用上一次的语言，目录照样拉，界面本身不受影响。
// 服务只认 "en" 与 "zh"，界面里的中文标记是 i18n.ZH（zh-Hans），在这里换算。
func (a *app) syncLanguage() {
	client, lang := a.client, "en"
	if a.lang == i18n.ZH {
		lang = "zh"
	}
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = client.SetLanguage(ctx, lang)
		a.post(func() {
			if client == a.client {
				a.refreshCommands()
			}
		})
	}()
}

// modelLabel 是模型在设置与下拉框里的唯一名字：提供方/模型 id。
func refLabel(ref *service.ModelRef) string {
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
	var ref service.ModelRef
	found := false
	for _, m := range a.cv.models {
		if m.Provider+"/"+m.ID == label {
			ref, found = service.ModelRef{Provider: m.Provider, ModelID: m.ID}, true
			break
		}
	}
	if !found {
		a.cv.modelsErr = a.tr("chat.modelUnavailable", "label", label)
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
	var ref service.ModelRef
	found := false
	for _, m := range a.cv.models {
		if m.Provider+"/"+m.ID == a.cv.modelChoice {
			ref, found = service.ModelRef{Provider: m.Provider, ModelID: m.ID}, true
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
func (a *app) setModel(ref service.ModelRef, level string) {
	if a.client == nil || a.conv == 0 {
		a.cv.modelsErr = a.tr("chat.modelNeedChat")
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
		resp, err := client.SetModel(ctx, strconv.Itoa(conv), service.SetModelRequest{Model: ref, ThinkingLevel: thinking})
		a.post(func() {
			if client != a.client || conv != a.conv {
				return
			}
			a.cv.modelsTouched = false
			if err != nil {
				a.cv.modelsErr = a.tr("chat.modelSwitchFailed", "error", err.Error())
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
