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

// ConversationScopeEntry 是 conversation.scopes 里的一行：某个对话属于哪个工作区。
type ConversationScopeEntry struct {
	ConversationID int    `json:"conversationId"`
	WorkspaceID    string `json:"workspace_id"`
}

// ConversationScopes 返回全部工作区对话的归属（普通聊天不列出）。
func (c *Client) ConversationScopes(ctx context.Context) ([]ConversationScopeEntry, error) {
	var out struct {
		Scopes []ConversationScopeEntry `json:"scopes"`
	}
	err := c.callInto(ctx, "conversation.scopes", nil, &out)
	return out.Scopes, err
}

// CreateWorkspace 登记一个目录（已登记过则原样返回），并导入其中的数据文件。
func (c *Client) CreateWorkspace(ctx context.Context, path, name, instructions string) (WorkspaceMount, error) {
	params := map[string]any{"path": path}
	if name != "" {
		params["name"] = name
	}
	if instructions != "" {
		params["instructions"] = instructions
	}
	var out WorkspaceMount
	err := c.callInto(ctx, "workspace.create", params, &out)
	return out, err
}

// MoveToWorkspace 把普通聊天移入工作区；对话已经在工作区里时服务端拒绝。
func (c *Client) MoveToWorkspace(ctx context.Context, conversationID int, workspaceID string) ([]Source, error) {
	var out struct {
		OK      bool     `json:"ok"`
		Sources []Source `json:"sources"`
	}
	err := c.callInto(ctx, "conversation.moveToWorkspace", struct {
		ConversationID int    `json:"conversationId"`
		WorkspaceID    string `json:"workspaceId"`
	}{conversationID, workspaceID}, &out)
	return out.Sources, err
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

// TreeEntry 是 workspace.tree 返回的一项：目录或文件。折叠过单子目录链的目录，Name 是 `a/b/c`，Path 指向最里层。
type TreeEntry struct {
	Name    string  `json:"name"`
	Path    string  `json:"path"`
	Kind    string  `json:"kind"`
	Size    int64   `json:"size"`
	MtimeMs float64 `json:"mtimeMs"`
	Ignored bool    `json:"ignored"`
	Empty   bool    `json:"empty"`
	Data    bool    `json:"data"`
	// ImportState 是数据文件的导入状态：new 没导入过、changed 导入后变了、imported 已导入、none 不是数据文件。
	ImportState string `json:"importState"`
	// Pending 是目录下没导入或已变化的数据文件数。
	Pending int `json:"pending"`
}

// PendingFile 是「Changes」页签里的一项：还没导入或导入后变了的数据文件。
type PendingFile struct {
	Path  string `json:"path"`
	State string `json:"state"`
	Size  int64  `json:"size"`
}

// TreeListing 是工作区里一个目录的一层内容；一层超过上限时 Truncated 为真，Total 是实际项数。
type TreeListing struct {
	Path      string      `json:"path"`
	Entries   []TreeEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
	Total     int         `json:"total"`
}

// WorkspaceTree 读工作区里 path（相对工作区根，空串是根）这一层的子项。
func (c *Client) WorkspaceTree(ctx context.Context, workspaceID, path string) (TreeListing, error) {
	var out TreeListing
	err := c.callInto(ctx, "workspace.tree", map[string]any{"workspaceId": workspaceID, "path": path}, &out)
	return out, err
}

// WorkspacePending 列出工作区里还没导入或已变化的数据文件；Truncated 表示扫描到上限就停了。
func (c *Client) WorkspacePending(ctx context.Context, workspaceID string) ([]PendingFile, bool, error) {
	var out struct {
		Files     []PendingFile `json:"files"`
		Truncated bool          `json:"truncated"`
	}
	err := c.callInto(ctx, "workspace.pending", map[string]any{"workspaceId": workspaceID}, &out)
	return out.Files, out.Truncated, err
}

// ImportWorkspaceFiles 只导入指定的数据文件（相对工作区根的路径），返回导入结果与最新的工作区。
func (c *Client) ImportWorkspaceFiles(ctx context.Context, workspaceID string, paths []string) (WorkspaceMount, error) {
	var out WorkspaceMount
	err := c.callInto(ctx, "workspace.importFiles", map[string]any{"workspaceId": workspaceID, "paths": paths}, &out)
	return out, err
}
