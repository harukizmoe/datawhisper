package service

// 会话里的后台运行：长任务（jobs.*）、工作流运行（workflow.runs.*）与子 agent 委派（teams.*）。界面的
// 「运行」标签据此显示进度并提供取消。服务端没装配某一类时，对应方法返回 method not found（见 IsUnavailable）。

import (
	"context"
	"errors"
)

// Job 是一个长任务（服务端的 JobView）。时间是 ISO 8601（UTC）字符串，界面只做显示。
type Job struct {
	ID             int     `json:"id"`
	Type           string  `json:"type"`
	Label          string  `json:"label"`
	Status         string  `json:"status"` // queued、running、canceling、succeeded、failed、canceled
	Progress       float64 `json:"progress"`
	Message        string  `json:"message"`
	Error          *string `json:"error"`
	ConversationID int     `json:"conversationId"`
	CreatedAt      string  `json:"createdAt"`
	FinishedAt     *string `json:"finishedAt"`
}

// Active 报告任务是否还没结束。
func (j Job) Active() bool {
	return j.Status == "queued" || j.Status == "running" || j.Status == "canceling"
}

// WorkflowRun 是一次工作流运行的摘要（服务端的 WorkflowRunSummary）。
type WorkflowRun struct {
	ID                int     `json:"id"`
	WorkflowVersionID string  `json:"workflowVersionId"`
	ConversationID    int     `json:"conversationId"`
	Status            string  `json:"status"` // running、waiting_approval、paused、canceling、canceled、succeeded、failed
	CreatedAt         string  `json:"createdAt"`
	EndedAt           *string `json:"endedAt"`
	Failure           *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"failure"`
}

// Active 报告运行是否还没结束。
func (r WorkflowRun) Active() bool {
	switch r.Status {
	case "running", "waiting_approval", "paused", "canceling":
		return true
	}
	return false
}

// Delegation 是一个正在进行的子 agent 委派：团队成员在自己的子会话里干活。
type Delegation struct {
	ConversationID int    `json:"conversation_id"`
	TeamName       string `json:"team_name"`
	MemberName     string `json:"member_name"`
	Title          string `json:"title"`
}

// codeMethodNotFound 是 JSON-RPC 的 method not found。
const codeMethodNotFound = -32601

// IsUnavailable 报告错误是不是「服务没有这类功能」（没装配 jobs、workflows 或 teams）。
func IsUnavailable(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == codeMethodNotFound
}

// Jobs 列出会话 conv 的长任务，新的在前。
func (c *Client) Jobs(ctx context.Context, conv int) ([]Job, error) {
	var out struct {
		Jobs []Job `json:"jobs"`
	}
	err := c.callInto(ctx, "jobs.list", map[string]any{"conversationId": conv, "limit": 50}, &out)
	return out.Jobs, err
}

// CancelJob 取消一个长任务，返回它取消后的状态。
func (c *Client) CancelJob(ctx context.Context, id int) (Job, error) {
	var out Job
	err := c.callInto(ctx, "jobs.cancel", map[string]any{"id": id}, &out)
	return out, err
}

// WorkflowRuns 列出会话 conv 的工作流运行，新的在前。
func (c *Client) WorkflowRuns(ctx context.Context, conv int) ([]WorkflowRun, error) {
	var out struct {
		Runs []WorkflowRun `json:"runs"`
	}
	err := c.callInto(ctx, "workflow.runs.list", map[string]any{"conversationId": conv, "limit": 50}, &out)
	return out.Runs, err
}

// CancelWorkflowRun 取消一次工作流运行。
func (c *Client) CancelWorkflowRun(ctx context.Context, id int) error {
	return c.callInto(ctx, "workflow.runs.cancel", map[string]any{"id": id}, nil)
}

// ActiveDelegations 列出正在进行的子 agent 委派（所有会话的）。
func (c *Client) ActiveDelegations(ctx context.Context) ([]Delegation, error) {
	var out struct {
		Delegations []Delegation `json:"delegations"`
	}
	err := c.callInto(ctx, "teams.activeDelegations", nil, &out)
	return out.Delegations, err
}

// CancelDelegation 停止某个团队（member 为空时是整个团队）正在进行的委派，返回停掉的个数。
func (c *Client) CancelDelegation(ctx context.Context, team, member string) (int, error) {
	params := map[string]any{"teamName": team}
	if member != "" {
		params["memberName"] = member
	}
	var out struct {
		Canceled int `json:"canceled"`
	}
	err := c.callInto(ctx, "teams.cancelDelegate", params, &out)
	return out.Canceled, err
}
