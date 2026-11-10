package app

// 「运行」标签里工作流的界面：保存的定义、运行详情的节点、待批审批（含可编辑的输出）与失败后的重试。

import (
	"encoding/json"
	"strconv"
	"strings"

	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

// workflowDefinitions 画「已保存的工作流」一节：每份定义可以在当前对话里运行或删除。
func (a *app) workflowDefinitions(c *ui.Context, t *ui.Theme) {
	w := &a.src.runs.wf
	tok := a.tokens().Tok
	a.runSection(c, t, a.tr("wf.saved"), len(w.definitions), func() {
		for _, def := range w.definitions {
			ui.Column(c).Gap(4).Padding(10, 12).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder).Children(func() {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(c, def.Name).SingleLine().Grow(1).MinWidth(0).Tooltip(def.Name)
					ui.Badge(c, def.Template)
					starting := w.busy["start:"+def.ID]
					if starting {
						ui.Spinner(c)
					}
					if ui.PrimaryButton(c, a.tr("wf.run")).Disabled(starting || a.conv == 0).Tooltip(a.tr("wf.runTip")).Clicked() {
						a.startWorkflow(def)
					}
					if ui.Button(c, a.tr("wf.delete")).Disabled(w.busy["delete:"+def.ID]).Clicked() {
						d := def
						w.deleting = &d
					}
				})
				if def.Description != "" {
					ui.Text(c, def.Description).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
				}
			})
		}
	})
	if w.deleting != nil {
		open := true
		def := *w.deleting
		ui.Modal(c, &open, func() {
			ui.Column(c).Width(440).Gap(10).Children(func() {
				ui.Text(c, a.tr("wf.deleteTitle")).Bold().FontSize(a.fs(textSection))
				ui.Text(c, a.tr("wf.deleteBody", "name", def.Name)).TextColor(t.TextMuted)
				ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
					if ui.Button(c, a.tr("sidebar.cancel")).Clicked() {
						w.deleting = nil
					}
					if ui.PrimaryButton(c, a.tr("wf.deleteConfirm")).Disabled(w.busy["delete:"+def.ID]).Clicked() {
						a.deleteWorkflow(def)
					}
				})
			})
		})
		if !open {
			w.deleting = nil
		}
	}
}

// workflowDetails 是运行卡片里「工作流」特有的部分：失败信息、重试来源、展开的节点与审批。
func (a *app) workflowDetails(c *ui.Context, t *ui.Theme, w service.WorkflowRun) {
	wf := &a.src.runs.wf
	if w.Failure != nil {
		ui.Text(c, w.Failure.Message).FontSize(a.fs(textCaption)).TextColor(t.Danger).Selectable()
	}
	if w.RetryOf != nil {
		ui.Text(c, a.tr("wf.retryOf", "id", strconv.Itoa(w.RetryOf.RunID), "node", w.RetryOf.NodeID)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		a.buffer(ui.Text(c, "#"+strconv.Itoa(w.ID)+" · "+formatWhen(w.CreatedAt))).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Grow(1)
		label := a.tr("wf.details")
		if wf.open == w.ID {
			label = a.tr("wf.hide")
		}
		if ui.Button(c, label).FontSize(a.fs(textCaption)).Clicked() {
			a.toggleRunDetail(w.ID)
		}
	})
	if wf.open != w.ID {
		return
	}
	if wf.detail == nil || wf.detail.ID != w.ID {
		ui.Spinner(c)
		return
	}
	a.workflowDetail(c, t, *wf.detail)
}

func (a *app) workflowDetail(c *ui.Context, t *ui.Theme, d service.WorkflowRunDetail) {
	ui.Text(c, a.tr("wf.nodes")).Bold().FontSize(a.fs(textCaption))
	for i, n := range d.Nodes {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, n.NodeID).SingleLine().Grow(1).MinWidth(0).Tooltip(n.NodeID)
			if note := a.nodeNote(n); note != "" {
				ui.Text(c, note).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Shrink(0)
			}
			ui.Text(c, a.nodeStatusLabel(n.Status)).FontSize(a.fs(textCaption)).TextColor(nodeStatusColor(t, n.Status)).Shrink(0)
			// 只有失败运行里每个节点最后一次失败的尝试能重试。
			last := i+1 == len(d.Nodes) || d.Nodes[i+1].NodeID != n.NodeID
			if d.Status == "failed" && n.Status == "failed" && n.NodeRunID != nil && last {
				key := "retry:" + strconv.Itoa(d.ID)
				if a.src.runs.wf.busy[key] {
					ui.Spinner(c)
				}
				if ui.Button(c, a.tr("wf.retry")).FontSize(a.fs(textCaption)).Disabled(a.src.runs.wf.busy[key]).
					Tooltip(a.tr("wf.retryTip", "node", n.NodeID)).Clicked() {
					a.retryFrom(d.ID, n)
				}
			}
		})
		if n.Error != "" {
			ui.Text(c, n.Error).FontSize(a.fs(textCaption)).TextColor(t.Danger).Selectable()
		}
	}
	var decided []service.WorkflowApproval
	for _, ap := range d.Approvals {
		if ap.Pending() {
			a.approvalCard(c, t, d.ID, ap)
		} else {
			decided = append(decided, ap)
		}
	}
	for _, ap := range decided {
		line := a.tr("wf.decided", "id", ap.ID, "node", ap.NodeID, "decision", a.decisionLabel(ap.Decision))
		if ap.Comment != "" {
			line += " — " + ap.Comment
		}
		ui.Text(c, line).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Selectable()
	}
}

// nodeNote 是节点行上的小注：第几轮、第几次尝试、沿用了旧输出。
func (a *app) nodeNote(n service.WorkflowNode) string {
	var parts []string
	if n.Iteration > 1 {
		parts = append(parts, a.tr("wf.round", "n", strconv.Itoa(n.Iteration)))
	}
	if n.Attempt > 1 {
		parts = append(parts, a.tr("wf.attempt", "n", strconv.Itoa(n.Attempt)))
	}
	if n.Reused {
		parts = append(parts, a.tr("wf.reused"))
	}
	return strings.Join(parts, " · ")
}

// approvalCard 是一条待批审批：说明、节点输出（key 审批的对象输出可以改）、意见框与决定按钮。
func (a *app) approvalCard(c *ui.Context, t *ui.Theme, run int, ap service.WorkflowApproval) {
	w := &a.src.runs.wf
	in := w.input(ap)
	tok := a.tokens().Tok
	var probe map[string]json.RawMessage
	editable := ap.Kind == "key_approval" && json.Unmarshal(ap.Output, &probe) == nil
	busy := w.busy["decide:"+ap.ID]
	ui.Column(c).Gap(6).Padding(10, 12).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(t.Warning).Children(func() {
		ui.Text(c, a.approvalReason(ap)).Bold().FontSize(a.fs(textCaption))
		switch {
		case editable:
			ui.Text(c, a.tr("wf.outputEdit")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			a.buffer(ui.TextArea(c, &in.output).Label(a.tr("wf.output")).Lines(3, 12).MinHeight(0))
		case ap.Kind == "exception_review":
			ui.Text(c, a.tr("wf.error")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			a.buffer(ui.Text(c, prettyJSON(ap.Output))).FontSize(a.fs(textCaption)).TextColor(t.Danger).Selectable()
		default:
			ui.Text(c, a.tr("wf.output")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			a.buffer(ui.Text(c, prettyJSON(ap.Output))).FontSize(a.fs(textCaption)).Selectable()
		}
		ui.TextInput(c, &in.comment).Label(a.tr("wf.comment")).Placeholder(a.tr("wf.commentHint"))
		if in.err != "" {
			ui.Text(c, in.err).FontSize(a.fs(textCaption)).TextColor(t.Danger)
		}
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			if busy {
				ui.Spinner(c)
			}
			if ap.Kind == "key_approval" {
				if ui.PrimaryButton(c, a.tr("wf.approve")).Disabled(busy).Tooltip(a.tr("wf.approveTip")).Clicked() {
					a.decideApproval(run, ap, service.DecisionApprove)
				}
			}
			if editable {
				if ui.Button(c, a.tr("wf.applyEdits")).Disabled(busy).Tooltip(a.tr("wf.applyEditsTip")).Clicked() {
					a.decideApproval(run, ap, service.DecisionWithChanges)
				}
			}
			if ui.Button(c, a.tr("wf.rework")).Disabled(busy).Tooltip(a.tr("wf.reworkTip")).Clicked() {
				a.decideApproval(run, ap, service.DecisionRetry)
			}
			if ui.Button(c, a.tr("wf.stop")).Disabled(busy).Tooltip(a.tr("wf.stopTip")).Clicked() {
				a.decideApproval(run, ap, service.DecisionStop)
			}
		})
	})
}

// approvalReason 按审批的来由给出界面语言的说明；服务端的 reason 是英文固定句，这里不用。
func (a *app) approvalReason(ap service.WorkflowApproval) string {
	switch ap.Kind {
	case "exception_review":
		return a.tr("wf.reasonException", "node", ap.NodeID)
	case "escalation":
		return a.tr("wf.reasonEscalation", "node", ap.NodeID)
	}
	return a.tr("wf.reasonKey", "node", ap.NodeID)
}

func (a *app) decisionLabel(decision string) string {
	switch decision {
	case service.DecisionApprove:
		return a.tr("wf.decApprove")
	case service.DecisionWithChanges:
		return a.tr("wf.decWithChanges")
	case service.DecisionRetry:
		return a.tr("wf.decRetry")
	case service.DecisionStop:
		return a.tr("wf.decStop")
	}
	return decision
}

// nodeStatusLabel 把节点状态翻成界面文案；节点特有的 pending、skipped 之外与运行状态共用词。
func (a *app) nodeStatusLabel(status string) string {
	switch status {
	case "pending":
		return a.tr("wf.pending")
	case "skipped":
		return a.tr("wf.skipped")
	}
	return a.runStatusLabel(status)
}

func nodeStatusColor(t *ui.Theme, status string) ui.Color {
	switch status {
	case "pending", "skipped":
		return t.TextMuted
	}
	return runStatusColor(t, status)
}
