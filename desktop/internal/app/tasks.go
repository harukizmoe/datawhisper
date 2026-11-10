package app

// 任务面板（参考 Tern 的浮动任务面板）：agent 用 task_create / task_update 维护的任务板，在输入框上方显示成
// 一行「任务 2/7 · 当前任务 ›」，点开看全部。任务板不在订阅视图里，所以在任务工具每完成一次时重新读取。

import (
	"context"
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

// finishedTaskCalls 数出已经完成的任务工具调用（task_create、task_update……）。它变了就说明任务板变了。
func finishedTaskCalls(messages []conversation.Message) int {
	n := 0
	for _, m := range messages {
		if m.Tool != nil && m.Done && strings.HasPrefix(m.Tool.Name, "task_") && m.Tool.Name != "task_list" {
			n++
		}
	}
	return n
}

// syncTasks 在聊天状态更新后检查任务板是否该重新读取。
func (a *app) syncTasks() {
	if n := finishedTaskCalls(a.chat.Messages); n != a.cv.taskCalls {
		a.cv.taskCalls = n
		a.loadTasks()
	}
}

func (a *app) loadTasks() {
	client, conv := a.client, a.conv
	if client == nil || conv == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		tasks, err := client.Tasks(ctx, conv)
		a.post(func() {
			// 切了会话或服务，或者读取失败（服务没装配任务板）：保持现状，面板只是不更新。
			if client != a.client || a.conv != conv || err != nil {
				return
			}
			a.cv.tasks = tasks
		})
	}()
}

// taskPanel 画输入框上方的任务行与展开后的清单；没有任务时不画。
func (a *app) taskPanel(c *ui.Context) {
	tasks := a.cv.tasks
	if len(tasks) == 0 {
		return
	}
	t := c.Theme()
	done, current := 0, ""
	for _, task := range tasks {
		switch task.Status {
		case "completed":
			done++
		case "in_progress":
			if current == "" {
				current = task.Title
			}
		}
	}
	chevron := icons.ChevronRight
	if a.cv.tasksOpen {
		chevron = icons.ChevronDown
	}
	label := a.tr("chat.tasks", "done", strconv.Itoa(done), "total", strconv.Itoa(len(tasks)))
	ui.Column(c).Gap(6).Padding(0, 4, 6, 4).Children(func() {
		ui.Row(c).Children(func() {
			if ui.ButtonBase(c).Label(label).Tooltip(a.tr("chat.tasksTip")).Children(func() {
				ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
					ui.Icon(c, icons.ListChecks).TextColor(t.TextMuted)
					ui.Text(c, label).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).SingleLine()
					if current != "" && !a.cv.tasksOpen {
						ui.Text(c, "· "+oneLine(current, 60)).FontSize(a.fs(textCaption)).TextColor(t.Text).SingleLine()
					}
					ui.Icon(c, chevron).TextColor(t.TextMuted)
				})
			}).Clicked() {
				a.cv.tasksOpen = !a.cv.tasksOpen
			}
			ui.Spacer(c)
		})
		if !a.cv.tasksOpen {
			return
		}
		ui.Column(c).Gap(4).Padding(0, 0, 0, 12).BorderWidth(0, 0, 0, 2).BorderColor(t.Border).Children(func() {
			for _, task := range tasks {
				a.taskRow(c, task)
			}
		})
	})
}

func (a *app) taskRow(c *ui.Context, task service.Task) {
	t := c.Theme()
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		color, text := t.TextMuted, t.TextMuted
		switch task.Status {
		case "completed":
			ui.Icon(c, icons.CircleCheck).TextColor(t.Success)
		case "in_progress":
			ui.Spinner(c)
			text = t.Text
		case "blocked":
			ui.Icon(c, icons.CircleX).TextColor(t.Warning)
		default:
			ui.Box(c).Width(10).Height(10).Radius(5).BorderWidth(1).BorderColor(color)
		}
		ui.Text(c, task.Title).FontSize(a.fs(textCaption)).TextColor(text).Grow(1).MinWidth(0).Tooltip(task.Title)
	})
}
