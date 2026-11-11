// Package service 是桌面应用访问 agent 服务的客户端（docs/refactor/ui-protocol.md）：在 internal/jsonrpc 的
// 传输之上提供带类型的方法（会话、模型、数据源、工作区、产物、仪表盘）与会话订阅。订阅送来的 snapshot 与
// ops 由 internal/conversation 还原成会话状态。
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"datawhisper/desktop/internal/jsonrpc"
)

// ErrClosed 表示管道已经关闭：服务进程退出了。此后的请求都直接失败，这个 Client 也不能再用；重连由
// supervisor 触发，上层应改用新连接的 Client。
var ErrClosed = jsonrpc.ErrClosed

// Conn 是服务进程的管道（见 jsonrpc.Conn）；supervisor.Conn 实现它。
type Conn = jsonrpc.Conn

// Client 是一个运行中的 agent 服务的客户端。请求可并发；订阅通知由传输层的读循环交给 notify，按订阅号
// 排进各自的队列。
type Client struct {
	rpc *jsonrpc.Client

	mu sync.Mutex
	// subscriptions 是已经拿到 subscriptionId 的订阅队列。
	subscriptions map[int]*subscription
	// early 缓存订阅响应之前就到达的通知：服务先发 snapshot（以及可能的 ops）再回响应，这些通知不能丢。
	early map[int][]Event
	// onPermission 处理权限通知（见 permissions.go）；没登记时丢弃。
	onPermission func(PermissionEvent)
}

// New 在 conn 上建客户端。服务退出（管道 EOF）时未完成的请求得到 ErrClosed，Done 关闭。
func New(conn Conn) *Client {
	c := &Client{
		subscriptions: map[int]*subscription{},
		early:         map[int][]Event{},
	}
	c.rpc = jsonrpc.New(conn, c.notify)
	return c
}

// Done 在管道结束时关闭：服务进程退出，或管道断了。
func (c *Client) Done() <-chan struct{} { return c.rpc.Done() }

// notify 处理服务的通知：订阅事件与权限请求。它在读循环上运行，不能阻塞。
func (c *Client) notify(method string, params json.RawMessage) {
	switch method {
	case notifyConversationEvent:
		c.publish(params)
	case notifyPermissionRequested, notifyPermissionResolved:
		c.dispatchPermission(method, params)
	}
}

// Error 是服务返回的一条错误响应。Kind 是 error.data.kind（业务错误的细分，如 "not_found"），Reason 是
// error.data.reason（更细的原因，如上传被拒时的 "file_too_large"），没有时为空。
type Error struct {
	Code    int
	Message string
	Kind    string
	Reason  string
}

func (e *Error) Error() string { return fmt.Sprintf("service: %d %s", e.Code, e.Message) }

var (
	// ErrNotFound 匹配（errors.Is）业务错误 kind 为 "not_found" 的 Error，例如未知的会话。
	ErrNotFound = errors.New("not found")
	// ErrNoModel 匹配 Submit 的 "no_model"：会话没有模型，也没有可用模型。应把用户引到模型设置。
	ErrNoModel = errors.New("no model configured")
	// ErrModelUnavailable 匹配 Submit 的 "model_unavailable"：会话的模型属于一个已被移除或停用的提供方。
	// 应把用户引到模型设置，或调用 SetModel。
	ErrModelUnavailable = errors.New("model unavailable")
)

// 服务端使用的错误码（server/src/ipc/errors.ts）。
const codeAppError = -32000

func (e *Error) Is(target error) bool {
	switch target {
	case ErrNotFound:
		return e.Code == codeAppError && e.Kind == "not_found"
	case ErrNoModel:
		return e.Code == codeAppError && e.Kind == "no_model"
	case ErrModelUnavailable:
		return e.Code == codeAppError && e.Kind == "model_unavailable"
	}
	return false
}

// Health 是 health 方法的结果。
type Health struct {
	OK          bool   `json:"ok"`
	Scheduling  string `json:"scheduling"`
	Tasks       int    `json:"tasks"`
	Submissions int    `json:"submissions"`
	ComputePID  *int   `json:"computePid"`
}

// ConversationSummary 是 conversation.list 中的一项。
type ConversationSummary struct {
	ID     int  `json:"id"`
	Root   bool `json:"root"`
	Parent *struct {
		ConversationID int `json:"conversationId"`
		At             int `json:"at"`
	} `json:"parent,omitempty"`
	// LastEntryID 在会话还没有 entry 时为 nil。
	LastEntryID *int `json:"lastEntryId"`
	// UpdatedAt 是最新 entry 中消息的 epoch 毫秒；没有消息时为 nil。
	UpdatedAt *int64 `json:"updatedAt"`
}

// SubmitRequest 是 conversation.submit 的参数。
type SubmitRequest struct {
	// RequestID 是幂等键：用同一个键重试会返回同一个 submission。
	RequestID string `json:"requestId"`
	Text      string `json:"text"`
	// Command 是斜杠命令名（可选）。
	Command string `json:"command,omitempty"`
	// WhenBusy 取 "steer"（并入正在进行的回复）或 "followUp"（默认：排在后面执行）。
	WhenBusy string `json:"whenBusy,omitempty"`
}

// SubmitResponse 报告 submission 的 id 及其 pi-durable 状态：queued、placed、done 或 unanswered。
type SubmitResponse struct {
	SubmissionID int    `json:"submissionId"`
	Status       string `json:"status"`
}

// ModelRef 指定一个模型：提供方 id 加该提供方下的模型 id（即 pi-durable 的 ModelRef）。
type ModelRef struct {
	Provider string `json:"provider"`
	ModelID  string `json:"modelId"`
}

// CreateConversationRequest 是 conversation.create 的可选参数。不给 Model 时服务选自己的默认模型（即
// models.view 里的设置）。ThinkingLevel 取 off、minimal、low、medium、high、xhigh、max 之一。
type CreateConversationRequest struct {
	Model         *ModelRef `json:"model,omitempty"`
	ThinkingLevel string    `json:"thinkingLevel,omitempty"`
}

// SetModelRequest 是 conversation.setModel 的参数；ThinkingLevel 为 nil 表示清空（用默认值）。
type SetModelRequest struct {
	Model         ModelRef `json:"model"`
	ThinkingLevel *string  `json:"thinkingLevel"`
}

// AgentModelResponse 是会话解析出的模型（没有时为 nil）与生效的 thinking level。
type AgentModelResponse struct {
	Model         *ModelRef `json:"model"`
	ThinkingLevel string    `json:"thinkingLevel"`
}

// AvailableModel 是 models.available 中的一项：一个已启用、且鉴权信息完整的提供方下的聊天模型。
type AvailableModel struct {
	Provider       string   `json:"provider"`
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	ContextWindow  int      `json:"contextWindow"`
	MaxTokens      int      `json:"maxTokens"`
	Reasoning      bool     `json:"reasoning"`
	Vision         bool     `json:"vision"`
	ThinkingLevels []string `json:"thinkingLevels"`
}

// asServiceError 把传输层的错误响应换成 *Error，解出 error.data 里的 kind 与 reason；其余错误原样返回。
func asServiceError(err error) error {
	var rpcErr *jsonrpc.Error
	if !errors.As(err, &rpcErr) {
		return err
	}
	out := &Error{Code: rpcErr.Code, Message: rpcErr.Message}
	if len(rpcErr.Data) > 0 {
		var data struct {
			Kind   string `json:"kind"`
			Reason string `json:"reason"`
		}
		if json.Unmarshal(rpcErr.Data, &data) == nil {
			out.Kind, out.Reason = data.Kind, data.Reason
		}
	}
	return out
}

// Call 发一个请求并等它的响应；错误响应是 *Error。多个 Call 可以并发；ctx 结束只是放弃这次等待。
func (c *Client) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	raw, err := c.rpc.Call(ctx, method, params)
	return raw, asServiceError(err)
}

// callInto 调用方法并把结果解码进 out（out 为 nil 时只等成功）。
func (c *Client) callInto(ctx context.Context, method string, params, out any) error {
	raw, err := c.Call(ctx, method, params)
	if err != nil {
		return err
	}
	if out == nil || len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	return nil
}

// Health 报告服务能否应答，以及它在跑什么。
func (c *Client) Health(ctx context.Context) (Health, error) {
	var out Health
	err := c.callInto(ctx, "health", nil, &out)
	return out, err
}

// SetLanguage 告诉服务界面当前的语言（"en" 或 "zh"），服务与计算进程里面向用户和模型的文案随之切换。
func (c *Client) SetLanguage(ctx context.Context, lang string) error {
	_, err := c.Call(ctx, "app.setLanguage", map[string]string{"lang": lang})
	return err
}

// Conversations 列出无属主的会话，最新的在前。
func (c *Client) Conversations(ctx context.Context) ([]ConversationSummary, error) {
	var out struct {
		Conversations []ConversationSummary `json:"conversations"`
	}
	err := c.callInto(ctx, "conversation.list", nil, &out)
	return out.Conversations, err
}

// CreateConversation 创建一个空会话并返回其 id；零值请求表示用默认模型。未知模型或不支持的 thinking level
// 会得到 *Error（参数错误）。
func (c *Client) CreateConversation(ctx context.Context, req CreateConversationRequest) (int, error) {
	// 只带非零字段：零值请求就是 `{}`，与旧的 HTTP 版本一致。
	params := map[string]any{}
	if req.Model != nil {
		params["model"] = req.Model
	}
	if req.ThinkingLevel != "" {
		params["thinkingLevel"] = req.ThinkingLevel
	}
	var out struct {
		ID int `json:"id"`
	}
	err := c.callInto(ctx, "conversation.create", params, &out)
	return out.ID, err
}

// SetModel 把会话 conv 换成另一个模型和 thinking level，从它下一次模型请求开始生效。
func (c *Client) SetModel(ctx context.Context, conv string, req SetModelRequest) (AgentModelResponse, error) {
	var out AgentModelResponse
	err := c.callInto(ctx, "conversation.setModel", struct {
		ID            string   `json:"id"`
		Model         ModelRef `json:"model"`
		ThinkingLevel *string  `json:"thinkingLevel"`
	}{conv, req.Model, req.ThinkingLevel}, &out)
	return out, err
}

// AvailableModels 列出会话现在可以使用的模型。
func (c *Client) AvailableModels(ctx context.Context) ([]AvailableModel, error) {
	var out struct {
		Models []AvailableModel `json:"models"`
	}
	err := c.callInto(ctx, "models.available", nil, &out)
	return out.Models, err
}

// Submit 把用户输入送进会话 conv（"root" 或数字 id）。ErrNoModel 和 ErrModelUnavailable 匹配业务错误。
func (c *Client) Submit(ctx context.Context, conv string, req SubmitRequest) (SubmitResponse, error) {
	var out SubmitResponse
	err := c.callInto(ctx, "conversation.submit", struct {
		ID        string `json:"id"`
		RequestID string `json:"requestId"`
		Text      string `json:"text"`
		Command   string `json:"command,omitempty"`
		WhenBusy  string `json:"whenBusy,omitempty"`
	}{conv, req.RequestID, req.Text, req.Command, req.WhenBusy}, &out)
	return out, err
}

// Abort 停止会话正在进行的回复，并撤回已排队的输入。
func (c *Client) Abort(ctx context.Context, conv string) error {
	return c.callInto(ctx, "conversation.abort", struct {
		ID string `json:"id"`
	}{conv}, nil)
}
