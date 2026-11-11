package app

// 数据面板「运行」标签的界面：长任务、工作流运行与子 agent 委派，各一节；进行中的条目有进度与取消按钮。

import (
	"strconv"
	"time"

	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

// runsTab 画「运行」标签。第一次打开时加载；有运行在进行时按 runsPollInterval 刷新。
func (a *app) runsTab(c *ui.Context, t *ui.Theme) {
	r := &a.src.runs
	if r.conv != a.conv || (!r.loaded && !r.loading) {
		a.loadRuns()
	} else if r.anyActive() && !r.loading {
		if wait := runsPollInterval - c.Now().Sub(r.loadedAt); wait <= 0 {
			a.loadRuns()
		} else {
			c.After(wait)
		}
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Text(c, a.tr("runs.title")).Bold().FontSize(a.fs(textSection))
		if r.loading {
			ui.Spinner(c)
		}
		ui.Spacer(c)
		if ui.Button(c, a.tr("data.refresh")).Disabled(r.loading).Clicked() {
			a.loadRuns()
		}
	})
	ui.Text(c, a.tr("runs.tip")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
	if r.err != "" {
		ui.Text(c, r.err).FontSize(a.fs(textCaption)).TextColor(t.Danger)
	}
	if !r.loaded {
		return
	}
	if !r.noJobs {
		a.runSection(c, t, a.tr("runs.jobs"), len(r.jobs), func() {
			for _, j := range r.jobs {
				a.jobRow(c, t, j)
			}
		})
	}
	if !r.wf.noDefinitions {
		a.workflowDefinitions(c, t)
	}
	if !r.noWorkflows {
		a.runSection(c, t, a.tr("runs.workflows"), len(r.workflows), func() {
			for _, w := range r.workflows {
				a.workflowRow(c, t, w)
			}
		})
	}
	if !r.noTeams {
		a.runSection(c, t, a.tr("runs.delegations"), len(r.delegations), func() {
			for _, d := range r.delegations {
				a.delegationRow(c, t, d)
			}
		})
	}
}

// runSection 是一节：标题加条数，没有条目时一行说明。
func (a *app) runSection(c *ui.Context, t *ui.Theme, title string, n int, rows func()) {
	ui.Column(c).Gap(8).Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			ui.Text(c, title).Bold()
			ui.Text(c, strconv.Itoa(n)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		})
		if n == 0 {
			ui.Text(c, a.tr("runs.none")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			return
		}
		rows()
	})
}

// runCard 是一条运行：标题行（名字、状态、取消按钮）与下面的细节。
func (a *app) runCard(c *ui.Context, t *ui.Theme, title, status string, active bool, cancelKey string, cancel func(), details func()) {
	tok := a.tokens().Tok
	ui.Column(c).Gap(6).Padding(10, 12).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, title).SingleLine().Grow(1).MinWidth(0).Tooltip(title)
			ui.Text(c, a.runStatusLabel(status)).FontSize(a.fs(textCaption)).TextColor(runStatusColor(t, status)).Shrink(0)
			if active && cancel != nil {
				busy := a.src.runs.canceling[cancelKey]
				if busy {
					ui.Spinner(c)
				}
				if iconTextButton(c, icons.Stop, a.tr("runs.cancel")).FontSize(a.fs(textCaption)).Disabled(busy).Shrink(0).Clicked() {
					cancel()
				}
			}
		})
		details()
	})
}

func (a *app) jobRow(c *ui.Context, t *ui.Theme, j service.Job) {
	title := j.Label
	if title == "" {
		title = j.Type
	}
	a.runCard(c, t, title, j.Status, j.Active(), "job:"+strconv.Itoa(j.ID), func() { a.cancelJob(j.ID) }, func() {
		if j.Active() {
			ui.Progress(c, j.Progress/100)
		}
		if j.Message != "" {
			ui.Text(c, j.Message).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		}
		if j.Error != nil && *j.Error != "" {
			ui.Text(c, *j.Error).FontSize(a.fs(textCaption)).TextColor(t.Danger).Selectable()
		}
		a.buffer(ui.Text(c, j.Type+" · #"+strconv.Itoa(j.ID)+" · "+formatWhen(j.CreatedAt))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
	})
}

func (a *app) workflowRow(c *ui.Context, t *ui.Theme, w service.WorkflowRun) {
	a.runCard(c, t, a.src.runs.workflowName(w.WorkflowVersionID), w.Status, w.Active(), "run:"+strconv.Itoa(w.ID), func() { a.cancelWorkflowRun(w.ID) }, func() {
		a.workflowDetails(c, t, w)
	})
}

func (a *app) delegationRow(c *ui.Context, t *ui.Theme, d service.Delegation) {
	title := d.TeamName + " / " + d.MemberName
	a.runCard(c, t, title, "running", true, "team:"+d.TeamName+"/"+d.MemberName, func() { a.cancelDelegation(d) }, func() {
		if d.Title != "" {
			ui.Text(c, d.Title).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
		}
		ui.Text(c, a.tr("runs.subChat", "id", strconv.Itoa(d.ConversationID))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
	})
}

// runStatusLabel 把服务端的状态词翻成界面文案；陌生的状态原样显示。
func (a *app) runStatusLabel(status string) string {
	switch status {
	case "queued":
		return a.tr("runs.queued")
	case "running":
		return a.tr("runs.running")
	case "canceling":
		return a.tr("runs.canceling")
	case "waiting_approval":
		return a.tr("runs.waiting")
	case "paused":
		return a.tr("runs.paused")
	case "succeeded":
		return a.tr("runs.succeeded")
	case "failed":
		return a.tr("runs.failed")
	case "canceled":
		return a.tr("runs.canceled")
	}
	return status
}

func runStatusColor(t *ui.Theme, status string) ui.Color {
	switch status {
	case "succeeded":
		return t.Success
	case "failed":
		return t.Danger
	case "canceled", "canceling":
		return t.TextMuted
	}
	return t.Warning
}

// formatWhen 把服务端的 ISO 8601 时间显示成本地的「月-日 时:分」；解析不了时原样显示。
func formatWhen(iso string) string {
	at, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		return iso
	}
	return at.Local().Format("01-02 15:04")
}
