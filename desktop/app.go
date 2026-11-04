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

// reconnectedFor is how long the banner saying the service came back stays.
const reconnectedFor = 5 * time.Second

// navSettings is the sidebar's settings entry; conversations are "c<id>" (navOf), a new chat "".
const navSettings = "settings"

// app is the window's state. Only the UI thread changes it: the view, and the functions handed to post.
type app struct {
	// post runs fn on the UI thread and redraws: Window.Update in the app, a queue in tests.
	post func(fn func())
	// token authorizes every request to the service; retry restarts a failed service (nil: no Retry button).
	token   string
	retry   func()
	logPath string

	service   supervisor.Status
	client    *api.Client // of the ready service; nil while it is not ready
	everReady bool
	// recovered: the service came back after it stopped. The banner saying so shows for reconnectedFor from
	// recoveredAt, a time of the UI's clock taken by the first frame that shows it.
	recovered   bool
	recoveredAt time.Time

	nav           string // the sidebar's choice: "" (a new chat), navOf(id) or navSettings
	conversations []api.ConversationSummary
	listLoaded    bool
	listErr       string
	listGen       int // orders list loads, so an older answer never replaces a newer one

	conv           int       // the conversation shown; 0 for a new chat, which its first message creates
	chat           api.State // its replicated state
	connected      bool      // its subscription delivered a snapshot and has not dropped since
	streamErr      string    // why the subscription dropped, or why it could not be opened
	streamRetrying bool      // api.Follow resubscribes after streamErr; false: it gave up (unknown conversation)
	stopFollow     context.CancelFunc
	followGen      int // tells the updates of the current subscription from those of earlier ones

	input     string
	pending   *pendingSend // the message being sent, with its request id, until the service admits it
	sending   bool
	sendErr   string
	needModel bool // the service has no usable model for the conversation: offer the settings

	models       []api.AvailableModel
	modelsLoaded bool
	modelsErr    string

	list ui.ListState
	md   markdown.Options
}

// pendingSend keeps the request id of a message until it is admitted: sending the same text again after a failure
// reuses it, so a message the service admitted before the failure is not admitted twice.
type pendingSend struct{ requestID, text string }

func navOf(conv int) string { return "c" + strconv.Itoa(conv) }

// conversationTitle names a conversation until titles exist (P3.5).
func conversationTitle(id int) string { return "Chat " + strconv.Itoa(id) }

func newRequestID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b) // crypto/rand.Read does not fail
	return "ui-" + hex.EncodeToString(b)
}

// onService applies a state change of the supervisor: a ready service gets a new client (its port changes with
// every start), the conversation list, and the shown conversation's subscription; any other state drops them.
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

// follow subscribes to the shown conversation on the ready service. api.Follow resubscribes after a drop, each
// time from a fresh snapshot, so the replica matches the service again once a snapshot arrives.
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
		a.refreshConversations() // its newest entry changed
	}
}

// navigate follows a new choice of the sidebar.
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

// show switches the chat to conversation conv; 0 is a new chat.
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

// send submits the input to the shown conversation, creating it first for a new chat. While a reply runs, the
// service queues the message as a follow-up.
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
				if a.conv == 0 { // still on the new chat: show the conversation its message created
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

// sendFailed puts an unsent message back into an empty input; a model problem offers the settings.
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

// abort stops the running reply and withdraws the queued messages.
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
				return // the service restarted, or a newer load is under way
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

// view builds the window: the sidebar, and the chat or the settings page.
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

// statusLabel names the service state and its color for the status indicator.
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

// banner shows what keeps the chat from working, if anything: the service starting, restarting or failed, or the
// conversation's subscription down; and for a while after a restart, that the service is back.
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

// message builds one chat row: the user's in a bubble on the right, a tool step in small print, a reply as
// Markdown: markdown.Stream while it streams, markdown.View once committed, in the same list row (same key).
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

// settings is a placeholder page until P7.4: the service's state, and the models conversations can use.
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
