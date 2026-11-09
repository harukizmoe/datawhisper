package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/i18n"
	"datawhisper/desktop/internal/prefs"
	"datawhisper/desktop/internal/preview"
	"datawhisper/desktop/internal/service"
	"datawhisper/desktop/internal/supervisor"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

// reconnectedFor 是「服务已恢复」横幅的停留时长。
const reconnectedFor = 5 * time.Second

// navSettings 是侧边栏的设置项；会话项为 "c<id>"（见 navOf），新对话为 ""。
const navSettings = "settings"

// navKnowledge 与 navSkills 是知识库页与技能页。
const (
	navKnowledge = "knowledge"
	navSkills    = "skills"
)

// onPage 报告侧栏当前选的是不是独立页面（设置、知识库、技能），而不是对话。
func (a *app) onPage() bool {
	return a.nav == navSettings || a.nav == navKnowledge || a.nav == navSkills
}

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
	client    *service.Client // 指向 ready 状态的服务；未就绪时为 nil
	everReady bool
	// recovered：服务停止后又回来了。提示这一点的横幅从 recoveredAt 起显示 reconnectedFor 这么久，
	// 而 recoveredAt 是 UI 时钟上、由第一帧显示该横幅时记下的时间。
	recovered   bool
	recoveredAt time.Time

	nav        string // 侧边栏的选择：""（新对话）、navOf(id) 或 navSettings
	sessions   []service.Session
	listLoaded bool
	listErr    string
	sideSearch string         // 侧栏搜索框里的字：按标题过滤会话
	sess       sessionState   // 会话管理（sessions.go）
	know       knowledgeState // 知识库页（knowledge.go）
	skills     skillsState    // 技能页（skills.go）
	feishu     feishuState    // 设置页的「集成」分区（feishu.go）
	palette    paletteState   // 命令面板（palette.go）
	listGen    int            // 给会话列表的加载排序，避免旧结果覆盖新结果

	conv           int                // 当前显示的会话；0 表示新对话，由它的第一条消息创建
	chat           conversation.State // 该会话复制出的状态
	connected      bool               // 它的订阅已送来 snapshot，且此后没有再断开
	streamErr      string             // 订阅为何断开，或为何无法打开
	streamRetrying bool               // conversation.Follow 在 streamErr 之后会重新订阅；false 表示它放弃了（未知会话）
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
	// rich 是图表与富内容的网页层（图表、HTML 产物、仪表盘），见 richcontent.go。
	rich preview.Pool
	// dash 是仪表盘查看器的界面状态（richcontent.go）。
	dash dashState

	// 界面外壳的偏好与动作（prefs.go、shell.go）：外观、语言、菜单、托盘与文件拖放。
	prefs     prefs.Prefs
	prefsPath string
	prefsErr  string // 最近一次写偏好失败的原因
	// prefsLocked 表示偏好来自 -theme/-lang：这一次运行照它走，但不写回 ui.json。
	prefsLocked bool
	dataDir     string
	version     string // 应用版本（关于对话框）
	// lang 是解析后的界面语言（i18n.EN 或 i18n.ZH）；preferred 是系统语言列表，跟随系统时用。
	lang      string
	preferred []string
	hooks     shellHooks
	menu      *mygo.Menu
	tray      *mygo.Tray
	// theme 缓存解析好的外观（配色、字体、图表主题），见 appearance.go 与 internal/theme。
	theme themeCache
}

// tr 用界面当前的语言说一条文案（internal/i18n）。
func (a *app) tr(key string, args ...string) string {
	return i18n.T(a.lang, key, args...)
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
	a.client = service.New(st.Pipe)
	if a.openOnReady != 0 {
		// -open：启动后直接显示这个会话，只订阅一次。
		a.conv, a.nav = a.openOnReady, navOf(a.openOnReady)
		a.openOnReady = 0
	}
	a.refreshConversations()
	a.follow()
	a.refreshModels()
	a.refreshCommands()
	switch a.nav {
	case navSettings:
		a.loadSettings()
	case navKnowledge:
		a.loadKnowledge()
	case navSkills:
		a.loadSkills()
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

// follow 在 ready 的服务上订阅当前显示的会话。conversation.Follow 在断开后会重新订阅，每次都从新的 snapshot 开始，
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
		err := conversation.Follow(ctx, client, conv, conversation.FollowHandler{
			OnState: func(st conversation.State) { current(func() { a.onChat(st) }) },
			OnDisconnect: func(err error) {
				current(func() { a.connected, a.streamErr, a.streamRetrying = false, err.Error(), true })
			},
		})
		if ctx.Err() == nil {
			current(func() { a.connected, a.streamErr, a.streamRetrying = false, err.Error(), false })
		}
	}()
}

func (a *app) onChat(st conversation.State) {
	finished := a.chat.Busy && !st.Busy && a.chat.Conversation == st.Conversation
	switched := st.Conversation != a.chat.Conversation
	switch {
	case st.Busy && (!a.chat.Busy || switched):
		a.cv.busySince = time.Now()
	case !st.Busy:
		a.cv.busySince = time.Time{}
	}
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
		a.feishu.loaded = false // 关联的群按会话不同，进设置页时重新读取
	case a.nav == navKnowledge:
		a.loadKnowledge()
	case a.nav == navSkills:
		a.loadSkills()
	case strings.HasPrefix(a.nav, "c"):
		if id, err := strconv.Atoi(a.nav[1:]); err == nil && id != a.conv {
			a.show(id)
		}
	}
}

// show 把聊天切到会话 conv；0 表示新对话。
func (a *app) show(conv int) {
	a.conv, a.chat = conv, conversation.State{}
	a.sendErr, a.needModel = "", false
	a.cv.resetConversation()
	// 聊天里的图表与面板里的产物预览都属于上一个会话：切换时把它们的 web view 释放掉，
	// 不留下看不见的页面。
	a.rich.ReleaseChat()
	a.rich.ReleasePanel()
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
	a.cv.followPaused = false // 发出新消息后回到底部看回复
	client, conv := a.client, a.conv
	command, whenBusy := slashCommandName(text, a.cv.commands), a.whenBusy()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if conv == 0 {
			id, err := client.CreateConversation(ctx, service.CreateConversationRequest{})
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
		_, err := client.Submit(ctx, strconv.Itoa(conv), service.SubmitRequest{
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
	case errors.Is(err, service.ErrNoModel):
		a.sendErr, a.needModel = "No model is configured: add a model provider in the settings.", true
	case errors.Is(err, service.ErrModelUnavailable):
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
