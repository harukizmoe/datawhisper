package service

import (
	"context"
	"encoding/json"
)

// 服务端推来的两条权限通知（server/src/ipc/attach.ts）。
const (
	notifyPermissionRequested = "permission.requested"
	notifyPermissionResolved  = "permission.resolved"
)

// 权限模式（server/src/agent/permission-mode.ts）。
const (
	ModeManual      = "manual"
	ModeAcceptEdits = "accept_edits"
	ModePlan        = "plan"
	ModeAuto        = "auto"
	ModeBypass      = "bypass"
)

// 对待审批请求的回复。AllowChat 表示这次放行，并且本对话里同一个工具以后不再问。
const (
	ReplyAllow     = "allow"
	ReplyAllowChat = "allow_chat"
	ReplyDeny      = "deny"
)

// PermissionRequest 是一个等待用户回复的工具调用：服务端把它挂起，直到回复或中止这一轮。
type PermissionRequest struct {
	RequestID      string `json:"requestId"`
	ConversationID int    `json:"conversationId"`
	Tool           string `json:"tool"`
	// Summary 是一句话说明要做什么；Detail 是命令原文或写入内容的开头，可能为空。
	Summary string `json:"summary"`
	Detail  string `json:"detail"`
	// AllowChat 为 false 时不提供「本对话都允许」（破坏性操作每次都要问）。
	AllowChat bool `json:"allowChat"`
}

// PermissionEvent 是一条权限通知：Request 非 nil 表示出现了新请求；否则 Resolved 非空表示某个请求已撤下。
type PermissionEvent struct {
	Request  *PermissionRequest
	Resolved string
}

// ConversationScope 是 conversation.scope 的结果：Scope 为 "chat" 或 "workspace"；只有工作区对话有 Mode。
type ConversationScope struct {
	Scope        string   `json:"scope"`
	WorkspaceID  string   `json:"workspace_id"`
	Mode         string   `json:"mode"`
	AllowedTools []string `json:"allowed_tools"`
}

// SetPermissionHandler 登记权限通知的处理函数；它在读循环上被调用，必须很快返回、不能阻塞。
func (c *Client) SetPermissionHandler(fn func(PermissionEvent)) {
	c.mu.Lock()
	c.onPermission = fn
	c.mu.Unlock()
}

// dispatchPermission 把权限通知交给登记的处理函数；没有处理函数时丢弃。
func (c *Client) dispatchPermission(method string, params json.RawMessage) {
	c.mu.Lock()
	fn := c.onPermission
	c.mu.Unlock()
	if fn == nil {
		return
	}
	switch method {
	case notifyPermissionRequested:
		var request PermissionRequest
		if json.Unmarshal(params, &request) == nil && request.RequestID != "" {
			fn(PermissionEvent{Request: &request})
		}
	case notifyPermissionResolved:
		var resolved struct {
			RequestID string `json:"requestId"`
		}
		if json.Unmarshal(params, &resolved) == nil && resolved.RequestID != "" {
			fn(PermissionEvent{Resolved: resolved.RequestID})
		}
	}
}

// PendingPermissions 列出某个对话里还在等回复的请求（重连、切换对话后用它补齐界面）。
func (c *Client) PendingPermissions(ctx context.Context, conversationID int) ([]PermissionRequest, error) {
	var out struct {
		Requests []PermissionRequest `json:"requests"`
	}
	err := c.callInto(ctx, "permission.pending", conversationIDParams(conversationID), &out)
	return out.Requests, err
}

// RespondPermission 回复一个待审批请求；decision 取 ReplyAllow、ReplyAllowChat 或 ReplyDeny。
func (c *Client) RespondPermission(ctx context.Context, requestID, decision string) error {
	return c.callInto(ctx, "permission.respond", struct {
		RequestID string `json:"requestId"`
		Decision  string `json:"decision"`
	}{requestID, decision}, nil)
}

// Scope 读对话的范围；工作区对话还带当前权限模式。
func (c *Client) Scope(ctx context.Context, conversationID int) (ConversationScope, error) {
	var out ConversationScope
	err := c.callInto(ctx, "conversation.scope", conversationIDParams(conversationID), &out)
	return out, err
}

// SetPermissionMode 切换工作区对话的权限模式；对话不属于工作区时服务端拒绝。
func (c *Client) SetPermissionMode(ctx context.Context, conversationID int, mode string) (ConversationScope, error) {
	var out ConversationScope
	err := c.callInto(ctx, "conversation.setMode", struct {
		ConversationID int    `json:"conversationId"`
		Mode           string `json:"mode"`
	}{conversationID, mode}, &out)
	return out, err
}
