package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/api"
	"datawhisper/desktop/internal/supervisor"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

// reconnectedFor 是「服务已恢复」横幅的停留时长。
const reconnectedFor = 5 * time.Second

// navSettings 是侧边栏的设置项；会话项为 "c<id>"（见 navOf），新对话为 ""。
const navSettings = "settings"

// app 是窗口的状态。只有 UI 线程会改它：构建视图时，以及在 post 上排队的函数里。
type app struct {
	// post 在 UI 线程上运行 fn 并触发重绘：应用中它是 Window.Update，测试中是一个队列。
	post func(fn func())
	// token 为每个发往服务的请求做鉴权；retry 重启启动失败的服务（为 nil 时不显示 Retry 按钮）。
	token   string
	retry   func()
	logPath string

	service   supervisor.Status
	client    *api.Client // 指向 ready 状态的服务；未就绪时为 nil
	everReady bool
	// recovered：服务停止后又回来了。提示这一点的横幅从 recoveredAt 起显示 reconnectedFor 这么久，
	// 而 recoveredAt 是 UI 时钟上、由第一帧显示该横幅时记下的时间。
	recovered   bool
	recoveredAt time.Time

	nav           string // 侧边栏的选择：""（新对话）、navOf(id) 或 navSettings
	conversations []api.ConversationSummary
	listLoaded    bool
	listErr       string
	listGen       int // 给会话列表的加载排序，避免旧结果覆盖新结果

	conv           int       // 当前显示的会话；0 表示新对话，由它的第一条消息创建
	chat           api.State // 该会话复制出的状态
	connected      bool      // 它的订阅已送来 snapshot，且此后没有再断开
	streamErr      string    // 订阅为何断开，或为何无法打开
	streamRetrying bool      // api.Follow 在 streamErr 之后会重新订阅；false 表示它放弃了（未知会话）
	stopFollow     context.CancelFunc
	followGen      int // 用来区分当前订阅的更新与更早订阅的更新

	input     string
	pending   *pendingSend // 正在发送的消息及其 requestId，直到服务受理为止
	sending   bool
	sendErr   string
	needModel bool // 服务没有可用于该会话的模型：引导用户去设置

	models       []api.AvailableModel
	modelsLoaded bool
	modelsErr    string

	list ui.ListState
	md   markdown.Options
}

// pendingSend 保存一条消息的 requestId 直到它被受理：失败后重发同样的文本会复用它，这样服务在失败前已经
// 受理的消息不会被受理两次。
type pendingSend struct{ requestID, text string }

func navOf(conv int) string { return "c" + strconv.Itoa(conv) }

// conversationTitle 给会话起个名字，直到有真正的标题（P3.5）。
func conversationTitle(id int) string { return "Chat " + strconv.Itoa(id) }

func newRequestID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b) // crypto/rand.Read 不会失败
	return "ui-" + hex.EncodeToString(b)
}

// onService 应用 supervisor 的一次状态变化：ready 的服务会换上新 client（端口在每次启动时都不同）、重新拉
// 会话列表，并订阅当前显示的会话；其他状态则把这些都丢掉。
func (a *app) onService(st supervisor.Status) {
	wasReady := a.service.State == supervisor.StateReady
	a.service = st
	if st.State != supervisor.StateReady {
		a.client, a.recovered = nil, false
		a.cancelFollow()
		a.connected, a.streamErr = false, ""
		return
	}
	if wasReady && a.client != nil {
		return
	}
	a.recovered, a.recoveredAt = a.everReady, time.Time{}
	a.everReady = true
	a.client = api.New(st.Port, a.token)
	a.refreshConversations()
	a.follow()
	if a.nav == navSettings {
		a.loadModels()
	}
}

func (a *app) cancelFollow() {
	if a.stopFollow != nil {
		a.stopFollow()
		a.stopFollow = nil
	}
	a.followGen++
}

// follow 在 ready 的服务上订阅当前显示的会话。api.Follow 在断开后会重新订阅，每次都从新的 snapshot 开始，
// 所以只要 snapshot 到达，副本就又能和服务对上。
func (a *app) follow() {
	a.cancelFollow()
	a.connected, a.streamErr = false, ""
	if a.client == nil || a.conv == 0 {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.stopFollow = cancel
	gen, client, conv := a.followGen, a.client, strconv.Itoa(a.conv)
	current := func(fn func()) {
		a.post(func() {
			if gen == a.followGen {
				fn()
			}
		})
	}
	go func() {
		err := api.Follow(ctx, client, conv, api.FollowHandler{
			OnState: func(st api.State) { current(func() { a.onChat(st) }) },
			OnDisconnect: func(err error) {
				current(func() { a.connected, a.streamErr, a.streamRetrying = false, err.Error(), true })
			},
		})
		if ctx.Err() == nil {
			current(func() { a.connected, a.streamErr, a.streamRetrying = false, err.Error(), false })
		}
	}()
}

func (a *app) onChat(st api.State) {
	finished := a.chat.Busy && !st.Busy && a.chat.Conversation == st.Conversation
	a.chat, a.connected, a.streamErr = st, true, ""
	if finished {
		a.refreshConversations() // 它的最新条目变了
	}
}

// navigate 跟上侧边栏的新选择。
func (a *app) navigate() {
	switch {
	case a.nav == navSettings:
		a.loadModels()
	case strings.HasPrefix(a.nav, "c"):
		if id, err := strconv.Atoi(a.nav[1:]); err == nil && id != a.conv {
			a.show(id)
		}
	}
}

// show 把聊天切到会话 conv；0 表示新对话。
func (a *app) show(conv int) {
	a.conv, a.chat = conv, api.State{}
	a.sendErr, a.needModel = "", false
	a.follow()
}

func (a *app) newChat() {
	a.nav = ""
	a.show(0)
}

func (a *app) openSettings() {
	a.nav = navSettings
	a.loadModels()
}

func (a *app) canSend() bool {
	return a.client != nil && !a.sending && strings.TrimSpace(a.input) != ""
}

// send 把输入框的内容提交到当前显示的会话，新对话则先创建会话。回复进行中时，服务会把消息排成后续消息。
func (a *app) send() {
	if !a.canSend() {
		return
	}
	text := strings.TrimSpace(a.input)
	if a.pending == nil || a.pending.text != text {
		a.pending = &pendingSend{requestID: newRequestID(), text: text}
	}
	p := *a.pending
	a.input, a.sending, a.sendErr, a.needModel = "", true, "", false
	client, conv := a.client, a.conv
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if conv == 0 {
			id, err := client.CreateConversation(ctx, api.CreateConversationRequest{})
			if err != nil {
				a.post(func() { a.sendFailed(p, "Could not start the conversation: ", err) })
				return
			}
			conv = id
			a.post(func() {
				if a.conv == 0 { // 仍停在新对话上：显示这条消息创建出来的会话
					a.nav = navOf(id)
					a.show(id)
				}
				a.refreshConversations()
			})
		}
		_, err := client.Submit(ctx, strconv.Itoa(conv), api.SubmitRequest{RequestID: p.requestID, Text: p.text})
		a.post(func() {
			if err != nil {
				a.sendFailed(p, "Could not send: ", err)
				return
			}
			a.sending = false
			if a.pending != nil && a.pending.requestID == p.requestID {
				a.pending = nil
			}
		})
	}()
}

// sendFailed 把没发出去的消息放回输入框（输入框为空时）；模型方面的问题则引导用户去设置。
func (a *app) sendFailed(p pendingSend, what string, err error) {
	a.sending = false
	if a.input == "" {
		a.input = p.text
	}
	switch {
	case errors.Is(err, api.ErrNoModel):
		a.sendErr, a.needModel = "No model is configured: add a model provider in the settings.", true
	case errors.Is(err, api.ErrModelUnavailable):
		a.sendErr, a.needModel = "This conversation's model is no longer available: choose another in the settings.", true
	default:
		a.sendErr = what + err.Error()
	}
}

// abort 停止正在进行的回复，并撤回已排队的消息。
func (a *app) abort() {
	if a.client == nil || a.conv == 0 {
		return
	}
	client, conv := a.client, strconv.Itoa(a.conv)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := client.Abort(ctx, conv); err != nil {
			a.post(func() { a.sendErr = "Could not stop the reply: " + err.Error() })
		}
	}()
}

func (a *app) refreshConversations() {
	client := a.client
	if client == nil {
		return
	}
	a.listGen++
	gen := a.listGen
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		list, err := client.Conversations(ctx)
		a.post(func() {
			if client != a.client || gen != a.listGen {
				return // 服务重启了，或者有更新的加载正在进行
			}
			if err != nil {
				a.listErr = err.Error()
				return
			}
			a.conversations, a.listLoaded, a.listErr = list, true, ""
		})
	}()
}

func (a *app) loadModels() {
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
			a.models, a.modelsErr, a.modelsLoaded = models, "", true
			if err != nil {
				a.models, a.modelsErr = nil, err.Error()
			}
		})
	}()
}

// view 构建整个窗口：侧边栏，以及聊天页或设置页。
func (a *app) view(c *ui.Context) {
	ui.Row(c).Fill().AlignItems(ui.Stretch).Children(func() {
		a.sidebar(c)
		ui.Column(c).Grow(1).MinWidth(0).Children(func() {
			if a.nav == navSettings {
				a.settings(c)
			} else {
				a.chatPage(c)
			}
		})
	})
}

func (a *app) sidebar(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Width(240).Shrink(0).PaddingY(12).Gap(8).Background(t.Surface).BorderWidth(0, 1, 0, 0).BorderColor(t.Border).Children(func() {
		ui.Text(c, "DataWhisper").Bold().Padding(0, 16)
		ui.Row(c).Padding(0, 12).Children(func() {
			if ui.Button(c, "New chat").Grow(1).Clicked() {
				a.newChat()
			}
		})
		if ui.Sidebar(c, &a.nav, func() {
			ui.SidebarSection(c, "Chats", nil, func() {
				for _, conv := range a.conversations {
					ui.SidebarItem(c, navOf(conv.ID), nil, conversationTitle(conv.ID))
				}
				switch {
				case a.listErr != "":
					ui.Text(c, "Could not load the conversations").FontSize(12).TextColor(t.Danger).Padding(4, 8)
				case a.listLoaded && len(a.conversations) == 0:
					ui.Text(c, "No conversations yet").FontSize(12).TextColor(t.TextMuted).Padding(4, 8)
				}
			})
			ui.SidebarSection(c, "App", nil, func() {
				ui.SidebarItem(c, navSettings, nil, "Settings")
			})
		}).Grow(1).Label("Navigation").Changed() {
			a.navigate()
		}
	})
}

// statusLabel 给状态指示器返回服务状态的名称及其颜色。
func (a *app) statusLabel(t *ui.Theme) (string, ui.Color) {
	switch a.service.State {
	case supervisor.StateReady:
		return "Ready", t.Success
	case supervisor.StateStarting:
		return "Starting", t.Warning
	case supervisor.StateRestarting:
		return "Restarting", t.Warning
	case supervisor.StateFailed:
		return "Failed", t.Danger
	}
	return "Stopped", t.TextMuted
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
		text, tone = "The agent service is not running.", t.TextMuted
	case supervisor.StateStarting:
		text, tone, busy = "Starting the agent service…", t.Accent, true
	case supervisor.StateRestarting:
		text, tone, busy = fmt.Sprintf("The agent service stopped (%v). Restarting it…", a.service.Err), t.Warning, true
	case supervisor.StateFailed:
		text, tone, retry = fmt.Sprintf("The agent service could not be started: %v.", a.service.Err), t.Danger, a.retry != nil
		if a.logPath != "" {
			text += " Its log is " + a.logPath + "."
		}
	case supervisor.StateReady:
		switch {
		case a.streamErr != "" && a.streamRetrying:
			text, tone, busy = "Reconnecting to the conversation… ("+a.streamErr+")", t.Warning, true
		case a.streamErr != "":
			text, tone = "The conversation could not be opened: "+a.streamErr, t.Danger
		case a.recovered:
			now := c.Now()
			if a.recoveredAt.IsZero() {
				a.recoveredAt = now
			}
			if left := reconnectedFor - now.Sub(a.recoveredAt); left > 0 {
				text, tone = "Reconnected: the agent service restarted and the conversation is up to date.", t.Success
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
		if retry && ui.Button(c, "Retry").Clicked() {
			a.retry()
		}
	})
}

func (a *app) chatPage(c *ui.Context) {
	t := c.Theme()
	ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(10, 24).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
		if a.conv == 0 {
			ui.Text(c, "New chat").Bold()
		} else {
			ui.Text(c, conversationTitle(a.conv)).Bold()
		}
		if a.chat.Model != nil {
			ui.Badge(c, a.chat.Model.Provider+"/"+a.chat.Model.ModelID)
		}
		ui.Spacer(c)
		label, color := a.statusLabel(t)
		ui.Text(c, "●").TextColor(color)
		ui.Text(c, label).TextColor(t.TextMuted)
	})
	a.banner(c)
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
	ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(12, 24).BorderWidth(1, 0, 0, 0).BorderColor(t.Border).Children(func() {
		in := ui.TextInput(c, &a.input).Label("Message").Placeholder("Ask about your data").Grow(1).AutoFocus()
		if a.chat.Busy && a.connected && ui.Button(c, "Stop").Clicked() {
			a.abort()
		}
		send := ui.PrimaryButton(c, "Send").Disabled(!a.canSend())
		if send.Clicked() || in.Submitted() {
			a.send()
		}
	})
}

// message 构建一行聊天内容：用户的消息放在右侧气泡里，tool 步骤用小号字，回复则用 Markdown：流式时用
// markdown.Stream，落定后用 markdown.View，且都放在同一个列表行里（同一个 key）。
func (a *app) message(c *ui.Context, m api.Message) {
	t := c.Theme()
	switch m.Role {
	case "user":
		ui.Row(c).Children(func() {
			ui.Spacer(c)
			ui.Text(c, m.Text).Selectable().Padding(8, 12).Radius(14).Background(t.Surface).MaxWidth(560)
		})
	case "tool":
		ui.Text(c, m.Text).FontSize(12).TextColor(t.TextMuted)
	default:
		ui.Column(c).MaxWidth(760).Children(func() {
			if m.Done {
				markdown.View(c, m.Text, &a.md)
			} else {
				markdown.Stream(c, m.Text, &a.md)
			}
		})
	}
}

// settings 在 P7.4 之前只是一个占位页：显示服务状态，以及会话可用的模型。
func (a *app) settings(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Grow(1).MinWidth(0).Padding(24, 32).Gap(10).Children(func() {
		ui.Text(c, "Settings").Bold().FontSize(20)
		ui.Text(c, "Model providers, API keys and the other settings arrive with P7.4.").TextColor(t.TextMuted)
		ui.Text(c, "Agent service").Bold().Margin(12, 0, 0, 0)
		label, _ := a.statusLabel(t)
		if a.service.State == supervisor.StateReady {
			ui.Textf(c, "%s: process %d on 127.0.0.1:%d", label, a.service.PID, a.service.Port)
		} else {
			ui.Text(c, label)
		}
		if a.logPath != "" {
			ui.Text(c, "Log: "+a.logPath).FontSize(12).TextColor(t.TextMuted).Selectable()
		}
		ui.Text(c, "Models").Bold().Margin(12, 0, 0, 0)
		switch {
		case a.client == nil:
			ui.Text(c, "Available once the service is ready.").TextColor(t.TextMuted)
		case a.modelsErr != "":
			ui.Text(c, "Could not load the models: "+a.modelsErr).TextColor(t.Danger)
		case !a.modelsLoaded:
			ui.Text(c, "Loading…").TextColor(t.TextMuted)
		case len(a.models) == 0:
			ui.Text(c, "No model is available: no provider is enabled with a key.").TextColor(t.TextMuted)
		default:
			for _, m := range a.models {
				ui.Textf(c, "%s/%s · %s", m.Provider, m.ID, m.Name)
			}
		}
		if a.client != nil && ui.Button(c, "Refresh").Clicked() {
			a.loadModels()
		}
	})
}
