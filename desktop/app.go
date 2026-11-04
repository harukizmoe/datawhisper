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
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

// reconnectedFor 是「服务已恢复」横幅的停留时长。
const reconnectedFor = 5 * time.Second

// navSettings 是侧边栏的设置项；会话项为 "c<id>"（见 navOf），新对话为 ""。
const navSettings = "settings"

// navData 是侧边栏的数据入口：它不是页面，选中后展开右侧数据面板并回到聊天页。
const navData = "data"

// app 是窗口的状态。只有 UI 线程会改它：构建视图时，以及在 post 上排队的函数里。
type app struct {
	// post 在 UI 线程上运行 fn 并触发重绘：应用中它是 Window.Update，测试中是一个队列。
	post func(fn func())
	// retry 重启启动失败的服务（为 nil 时不显示 Retry 按钮）。
	retry   func()
	logPath string

	service   supervisor.Status
	client    *api.Client // 指向 ready 状态的服务；未就绪时为 nil
	everReady bool
	// recovered：服务停止后又回来了。提示这一点的横幅从 recoveredAt 起显示 reconnectedFor 这么久，
	// 而 recoveredAt 是 UI 时钟上、由第一帧显示该横幅时记下的时间。
	recovered   bool
	recoveredAt time.Time

	nav        string // 侧边栏的选择：""（新对话）、navOf(id) 或 navSettings
	sessions   []api.Session
	listLoaded bool
	listErr    string
	listGen    int // 给会话列表的加载排序，避免旧结果覆盖新结果

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

	// st 是模型与提供商设置页的数据与编辑状态（settings.go）。
	st settingsState
	// src 是右侧数据面板（数据源、工作区、产物）的数据与编辑状态（sources.go）。
	src sourcesState
	// cv 是聊天页自己的界面状态（输入、工具折叠、ask_user 选择、模型选择），见 chat.go。
	cv chatView
	// openOnReady 在服务就绪后打开这个会话（-open 启动参数）；0 表示停在新对话上。
	openOnReady int

	list ui.ListState
	md   markdown.Options

	// win 是主窗口。没有窗口（测试）时内容宽度用默认值，图表按它定高度。
	win *mygo.Window
	// rich 是图表与富内容的网页层（图表、HTML 产物、仪表盘、画布），见 richcontent.go。
	rich richContent

	// 界面外壳的偏好与动作（prefs.go、shell.go）：外观、语言、菜单、托盘与文件拖放。
	prefs     uiPrefs
	prefsPath string
	prefsErr  string // 最近一次写偏好失败的原因
	// prefsLocked 表示偏好来自 -theme/-lang：这一次运行照它走，但不写回 ui.json。
	prefsLocked bool
	dataDir     string
	// lang 是解析后的界面语言（langEN 或 langZH）；preferred 是系统语言列表，跟随系统时用。
	lang      string
	preferred []string
	hooks     shellHooks
	menu      *mygo.Menu
	tray      *mygo.Tray
	// lightTheme 与 darkTheme 是缓存的 ui 主题，每帧复用同一份。
	lightTheme *ui.Theme
	darkTheme  *ui.Theme
}

// pendingSend 保存一条消息的 requestId 直到它被受理：失败后重发同样的文本会复用它，这样服务在失败前已经
// 受理的消息不会被受理两次。
type pendingSend struct{ requestID, text string }

func navOf(conv int) string { return "c" + strconv.Itoa(conv) }

// contentWidth 返回窗口内容区宽度；没有窗口（测试、服务未就绪）时用默认窗口宽度。
func (a *app) contentWidth() float32 {
	if a.win != nil {
		if width, _ := a.win.ContentSize(); width > 0 {
			return float32(width)
		}
	}
	return 1180
}

func newRequestID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b) // crypto/rand.Read 不会失败
	return "ui-" + hex.EncodeToString(b)
}

// onService 应用 supervisor 的一次状态变化：ready 的服务会换上新 client（每次启动都是新的管道）、重新拉
// 会话列表，并订阅当前显示的会话；其他状态则把这些都丢掉。
func (a *app) onService(st supervisor.Status) {
	wasReady := a.service.State == supervisor.StateReady
	a.service = st
	if st.State != supervisor.StateReady || st.Pipe == nil {
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
	a.client = api.New(st.Pipe)
	if a.openOnReady != 0 {
		// -open：启动后直接显示这个会话，只订阅一次。
		a.conv, a.nav = a.openOnReady, navOf(a.openOnReady)
		a.openOnReady = 0
	}
	a.refreshConversations()
	a.follow()
	a.refreshModels()
	a.refreshCommands()
	if a.nav == navSettings {
		a.loadSettings()
	}
	a.sourcesReady()
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
	switched := st.Conversation != a.chat.Conversation
	a.chat, a.connected, a.streamErr = st, true, ""
	a.syncFromState(switched)
	if finished {
		a.refreshConversations() // 它的最新条目变了（服务端据此更新兜底标题）
	}
}

// navigate 跟上侧边栏的新选择。
func (a *app) navigate() {
	switch {
	case a.nav == navData:
		// 数据面板依附于聊天页：打开它，然后把侧边栏的选择还给当前会话。
		if !a.src.open {
			a.toggleSources()
		}
		if a.conv == 0 {
			a.nav = ""
		} else {
			a.nav = navOf(a.conv)
		}
	case a.nav == navSettings:
		a.loadSettings()
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
	a.cv.resetConversation()
	// 聊天里的图表与面板里的产物预览都属于上一个会话：切换时把它们的 web view 释放掉，
	// 不留下看不见的页面。
	a.rich.releaseChat()
	a.rich.releasePanel()
	a.sourcesConversationChanged()
	a.follow()
}

func (a *app) newChat() {
	a.nav = ""
	a.show(0)
}

func (a *app) openSettings() {
	a.nav = navSettings
	a.loadSettings()
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
	command, whenBusy := slashCommandName(text, a.cv.commands), a.whenBusy()
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
		_, err := client.Submit(ctx, strconv.Itoa(conv), api.SubmitRequest{
			RequestID: p.requestID,
			Text:      p.text,
			Command:   command,
			WhenBusy:  whenBusy,
		})
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
		list, err := client.Sessions(ctx)
		a.post(func() {
			if client != a.client || gen != a.listGen {
				return // 服务重启了，或者有更新的加载正在进行
			}
			if err != nil {
				a.listErr = err.Error()
				return
			}
			a.sessions, a.listLoaded, a.listErr = list, true, ""
		})
	}()
}

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
	ui.Column(c).Width(240).Shrink(0).PaddingY(12).Gap(8).Background(t.Surface).BorderWidth(0, 1, 0, 0).BorderColor(t.Border).Children(func() {
		ui.Text(c, "DataWhisper").Bold().Padding(0, 16)
		ui.Row(c).Padding(0, 12).Children(func() {
			if ui.Button(c, a.tr("sidebar.newChat")).Grow(1).Clicked() {
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
					ui.Text(c, a.tr("sidebar.listFailed")).FontSize(12).TextColor(t.Danger).Padding(4, 8)
				case a.listLoaded && len(a.sessions) == 0:
					ui.Text(c, a.tr("sidebar.empty")).FontSize(12).TextColor(t.TextMuted).Padding(4, 8)
				}
			})
			ui.SidebarSection(c, a.tr("sidebar.app"), nil, func() {
				ui.SidebarItem(c, navData, nil, a.tr("sidebar.data"))
				ui.SidebarItem(c, navSettings, nil, a.tr("sidebar.settings"))
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
