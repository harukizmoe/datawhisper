package app

// 工作流在「运行」标签里的状态与动作：保存的定义（运行、删除）、运行详情里的节点、待批审批的决定，以及失败运行的
// 重试。工作流的图不在界面里编辑，由助手按模板创建；人在这里做的只有启动、审批、重试。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sort"
	"strconv"
	"time"

	"datawhisper/desktop/internal/service"
)

// approvalInput 是一条待批审批的输入框内容。它按审批 id 存在状态里，轮询刷新时不会被冲掉。
type approvalInput struct {
	comment string
	// output 是节点输出的 JSON 文本，人可以改其中的值再选「Apply edits」。
	output string
	err    string
}

type workflowState struct {
	definitions   []service.WorkflowDefinition
	noDefinitions bool
	// open 是展开了详情的运行 id（0 表示都没展开）；detail 是它最近一次拉到的详情。
	open   int
	detail *service.WorkflowRunDetail
	inputs map[string]*approvalInput
	// busy 记住正在进行的动作（"decide:ap_1"、"retry:7"、"start:wf_ab"、"delete:wf_ab"），按钮显示转圈并禁用。
	busy map[string]bool
	// deleting 是等待确认删除的定义。
	deleting *service.WorkflowDefinition
}

// workflowName 把运行里的定义 id 换成定义的名字；定义已被删除时显示 id。
func (r *runsState) workflowName(id string) string {
	for _, d := range r.wf.definitions {
		if d.ID == id {
			return d.Name
		}
	}
	return id
}

// sortWorkflowRuns 把等人决定的运行排到最前，其余保持服务端给的顺序（新的在前）。
func sortWorkflowRuns(runs []service.WorkflowRun) {
	sort.SliceStable(runs, func(i, j int) bool {
		return runs[i].Status == "waiting_approval" && runs[j].Status != "waiting_approval"
	})
}

// toggleRunDetail 展开或收起一次运行的详情。
func (a *app) toggleRunDetail(id int) {
	w := &a.src.runs.wf
	if w.open == id {
		w.open, w.detail = 0, nil
		return
	}
	w.open, w.detail = id, nil
	a.loadRuns()
}

// input 返回审批 ap 的输入框内容；第一次见到时用节点输出预填。
func (w *workflowState) input(ap service.WorkflowApproval) *approvalInput {
	if w.inputs == nil {
		w.inputs = map[string]*approvalInput{}
	}
	in := w.inputs[ap.ID]
	if in == nil {
		in = &approvalInput{output: prettyJSON(ap.Output)}
		w.inputs[ap.ID] = in
	}
	return in
}

// prettyJSON 把 JSON 缩进显示；字符串显示原文（失败节点的输出是错误信息），解析不了时原样返回。
func prettyJSON(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var out bytes.Buffer
	if json.Indent(&out, raw, "", "  ") != nil {
		return string(raw)
	}
	return out.String()
}

// editedOutput 比较人改过的输出文本和原输出，返回要提交的改动（只含改过或新增的键）。
// 输出必须仍是 JSON 对象、原有的键一个不少；什么都没改也算错，免得把「Apply edits」当成「Approve」。
func editedOutput(original json.RawMessage, edited string) (map[string]any, error) {
	var before, after map[string]any
	if err := json.Unmarshal(original, &before); err != nil {
		return nil, errNotObject
	}
	if err := json.Unmarshal([]byte(edited), &after); err != nil {
		return nil, errNotObject
	}
	changes := map[string]any{}
	for key := range before {
		if _, ok := after[key]; !ok {
			return nil, errKeyRemoved
		}
	}
	for key, value := range after {
		if old, ok := before[key]; !ok || !reflect.DeepEqual(old, value) {
			changes[key] = value
		}
	}
	if len(changes) == 0 {
		return nil, errUnchanged
	}
	return changes, nil
}

var (
	errNotObject  = errors.New("not a JSON object")
	errKeyRemoved = errors.New("key removed")
	errUnchanged  = errors.New("unchanged")
)

// decisionError 把输出文本的校验错误翻成界面文案。
func (a *app) decisionError(err error) string {
	switch {
	case errors.Is(err, errKeyRemoved):
		return a.tr("wf.errKeys")
	case errors.Is(err, errUnchanged):
		return a.tr("wf.errUnchanged")
	}
	return a.tr("wf.errNotJSON")
}

// workflowAction 在后台跑一个工作流动作：key 标记忙，完成后在界面线程里回调 done，并重新拉取列表。
func (a *app) workflowAction(key string, do func(ctx context.Context, client *service.Client) error, done func(err error)) {
	client := a.client
	if client == nil {
		return
	}
	w := &a.src.runs.wf
	if w.busy == nil {
		w.busy = map[string]bool{}
	}
	if w.busy[key] {
		return
	}
	w.busy[key] = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		err := do(ctx, client)
		a.post(func() {
			delete(a.src.runs.wf.busy, key)
			done(err)
			a.loadRuns()
		})
	}()
}

// decideApproval 对运行 run 的待批审批 ap 做决定。「Apply edits」先在本地校验改动。
func (a *app) decideApproval(run int, ap service.WorkflowApproval, decision string) {
	in := a.src.runs.wf.input(ap)
	in.err = ""
	var changes map[string]any
	if decision == service.DecisionWithChanges {
		var err error
		if changes, err = editedOutput(ap.Output, in.output); err != nil {
			in.err = a.decisionError(err)
			return
		}
	}
	comment := in.comment
	a.workflowAction("decide:"+ap.ID, func(ctx context.Context, c *service.Client) error {
		return c.DecideWorkflowApproval(ctx, run, ap.ID, decision, comment, changes)
	}, func(err error) {
		if err != nil {
			in.err = a.sourceErr(err)
			return
		}
		delete(a.src.runs.wf.inputs, ap.ID)
	})
}

// retryFrom 从失败运行 run 的失败节点 node 重试；成功后展开新运行。
func (a *app) retryFrom(run int, node service.WorkflowNode) {
	if node.NodeRunID == nil {
		return
	}
	nodeRun := *node.NodeRunID
	a.workflowAction("retry:"+strconv.Itoa(run), func(ctx context.Context, c *service.Client) error {
		id, err := c.RetryWorkflowRun(ctx, run, nodeRun)
		if err == nil {
			a.post(func() { a.src.runs.wf.open, a.src.runs.wf.detail = id, nil })
		}
		return err
	}, func(err error) {
		if err != nil {
			a.src.runs.err = a.sourceErr(err)
		}
	})
}

// startWorkflow 在当前对话里从定义 def 启动一次运行，并展开它。
func (a *app) startWorkflow(def service.WorkflowDefinition) {
	conv := a.conv
	a.workflowAction("start:"+def.ID, func(ctx context.Context, c *service.Client) error {
		id, err := c.StartWorkflow(ctx, def.ID, conv)
		if err == nil {
			a.post(func() { a.src.runs.wf.open, a.src.runs.wf.detail = id, nil })
		}
		return err
	}, func(err error) {
		if err != nil {
			a.src.runs.err = a.sourceErr(err)
		}
	})
}

// deleteWorkflow 删除定义 def；历史运行带着图的快照，不受影响。
func (a *app) deleteWorkflow(def service.WorkflowDefinition) {
	a.workflowAction("delete:"+def.ID, func(ctx context.Context, c *service.Client) error {
		return c.RemoveWorkflowDefinition(ctx, def.ID)
	}, func(err error) {
		a.src.runs.wf.deleting = nil
		if err != nil {
			a.src.runs.err = a.sourceErr(err)
		}
	})
}
