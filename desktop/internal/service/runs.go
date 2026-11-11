package service

// 会话里的后台运行：长任务（jobs.*）、工作流运行（workflow.runs.*）与子 agent 委派（teams.*）。界面的
// 「运行」标签据此显示进度并提供取消。服务端没装配某一类时，对应方法返回 method not found（见 IsUnavailable）。

import (
	"context"
	"encoding/json"
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
	// RetryOf 是手动重试产生的运行：来自哪个失败的运行、从哪个节点重来。
	RetryOf *struct {
		RunID  int    `json:"runId"`
		NodeID string `json:"nodeId"`
	} `json:"retryOf"`
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

// WorkflowDefinition 是保存下来的工作流定义（`workflow.definitions.list`）；图本身界面不编辑，不解析。
type WorkflowDefinition struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Template    string `json:"template"` // analysis、insight、report、cleaning_approval 或 custom
	CreatedAt   string `json:"createdAt"`
}

// WorkflowDefinitions 列出保存的工作流定义。
func (c *Client) WorkflowDefinitions(ctx context.Context) ([]WorkflowDefinition, error) {
	var out struct {
		Workflows []WorkflowDefinition `json:"workflows"`
	}
	err := c.callInto(ctx, "workflow.definitions.list", nil, &out)
	return out.Workflows, err
}

// RemoveWorkflowDefinition 删除一份定义；历史运行带着图的快照，不受影响。
func (c *Client) RemoveWorkflowDefinition(ctx context.Context, id string) error {
	return c.callInto(ctx, "workflow.definitions.remove", map[string]any{"id": id}, nil)
}

// StartWorkflow 在会话 conv 里从定义 id 启动一次运行，返回运行 id。节点复用该会话打开的数据源。
func (c *Client) StartWorkflow(ctx context.Context, id string, conv int) (int, error) {
	var out struct {
		ID int `json:"id"`
	}
	err := c.callInto(ctx, "workflow.start", map[string]any{"workflowId": id, "conversationId": conv}, &out)
	return out.ID, err
}

// WorkflowNode 是运行详情里的一个节点（服务端的 WorkflowNodeView，只取界面用到的字段）。
type WorkflowNode struct {
	NodeID    string          `json:"nodeId"`
	NodeRunID *int            `json:"nodeRunId"` // 没派发过（或重试时沿用旧输出）的节点没有
	Status    string          `json:"status"`
	Iteration int             `json:"iteration"`
	Attempt   int             `json:"attempt"`
	Output    json.RawMessage `json:"output"`
	Error     string          `json:"error"`
	Reused    bool            `json:"reused"`
}

// WorkflowApproval 是一条审批记录。Decision 为空表示待批。
type WorkflowApproval struct {
	ID       string          `json:"id"`
	NodeID   string          `json:"nodeId"`
	Kind     string          `json:"kind"` // key_approval、exception_review、escalation
	Reason   string          `json:"reason"`
	Output   json.RawMessage `json:"output"`
	Decision string          `json:"decision"`
	Comment  string          `json:"comment"`
}

// Pending 报告审批是否还在等人决定。
func (a WorkflowApproval) Pending() bool { return a.Decision == "" }

// WorkflowRunDetail 是一次运行的详情：摘要加节点与审批。
type WorkflowRunDetail struct {
	WorkflowRun
	Nodes     []WorkflowNode     `json:"nodes"`
	Approvals []WorkflowApproval `json:"approvals"`
}

// WorkflowRunDetail 读一次运行的详情。
func (c *Client) WorkflowRunDetail(ctx context.Context, id int) (WorkflowRunDetail, error) {
	var out WorkflowRunDetail
	err := c.callInto(ctx, "workflow.runs.get", map[string]any{"id": id}, &out)
	return out, err
}

// 审批的四种决定。
const (
	DecisionApprove     = "approve"
	DecisionWithChanges = "approve_with_changes"
	DecisionRetry       = "reject_and_retry"
	DecisionStop        = "reject_and_stop"
)

// DecideWorkflowApproval 对运行 runID 的一条待批审批做决定。changes 只在 DecisionWithChanges 时有意义。
func (c *Client) DecideWorkflowApproval(ctx context.Context, runID int, approvalID, decision, comment string, changes map[string]any) error {
	params := map[string]any{"id": runID, "approvalId": approvalID, "decision": decision, "comment": comment}
	if changes != nil {
		params["changes"] = changes
	}
	return c.callInto(ctx, "workflow.runs.approve", params, nil)
}

// RetryWorkflowRun 从失败的节点任务 nodeRunID 重试：另起一个运行，返回新运行的 id。
func (c *Client) RetryWorkflowRun(ctx context.Context, runID, nodeRunID int) (int, error) {
	var out struct {
		ID int `json:"id"`
	}
	err := c.callInto(ctx, "workflow.runs.retry", map[string]any{"id": runID, "nodeRunId": nodeRunID}, &out)
	return out.ID, err
}
