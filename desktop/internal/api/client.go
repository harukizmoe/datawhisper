// Package api 是桌面应用访问 agent 服务 UI 协议的客户端（docs/refactor/ui-protocol.md）：带类型的请求，以及
// 由 snapshot 加 Chord delta ops 复制出来的会话订阅。
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Client 调用某一个正在运行的服务。重启后的服务会监听新端口：要新建一个 Client。
type Client struct {
	// Base 是服务的 origin，形如 http://127.0.0.1:PORT。
	Base  string
	Token string
	// HTTP 默认是一个不设超时的 client（订阅是长连接；普通请求靠各自的 context 控制）。
	HTTP *http.Client
	// IdleTimeout 结束一个这么久什么都没收到的订阅——连心跳注释（每 15 s 一次）都没有。默认 45 s。
	IdleTimeout time.Duration
}

// New 返回一个指向 127.0.0.1:port 上服务的客户端。
func New(port int, token string) *Client {
	return &Client{Base: fmt.Sprintf("http://127.0.0.1:%d", port), Token: token}
}

// Error 表示一个非 2xx 响应；若 JSON body 里有 "error" 字段，Message 就是它。
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("service: %d %s", e.Status, e.Message) }

var (
	// ErrNotFound 匹配（errors.Is）状态码 404 的 Error，例如未知的会话。
	ErrNotFound = errors.New("not found")
	// ErrNoModel 匹配 Submit 的 409 "no_model"：会话没有模型，也没有可用模型。应把用户引到模型设置。
	ErrNoModel = errors.New("no model configured")
	// ErrModelUnavailable 匹配 Submit 的 409 "model_unavailable"：会话的模型属于一个已被移除或停用的提供方。
	// 应把用户引到模型设置，或调用 SetModel。
	ErrModelUnavailable = errors.New("model unavailable")
)

func (e *Error) Is(target error) bool {
	switch target {
	case ErrNotFound:
		return e.Status == http.StatusNotFound
	case ErrNoModel:
		return e.Status == http.StatusConflict && e.Message == "no_model"
	case ErrModelUnavailable:
		return e.Status == http.StatusConflict && e.Message == "model_unavailable"
	}
	return false
}

// Health 是 GET /v1/health 的结果。
type Health struct {
	OK          bool   `json:"ok"`
	Scheduling  string `json:"scheduling"`
	Tasks       int    `json:"tasks"`
	Submissions int    `json:"submissions"`
	ComputePID  *int   `json:"computePid"`
}

// ConversationSummary 是 GET /v1/conversations 中的一项。
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

// SubmitRequest 是 POST /v1/conversations/:id/submit 的 body。
type SubmitRequest struct {
	// RequestID 是幂等键：用同一个键重试会返回同一个 submission。
	RequestID string `json:"requestId"`
	Text      string `json:"text"`
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

// CreateConversationRequest 是 POST /v1/conversations 的可选 body。不给 Model 时服务选自己的默认模型（即
// /v1/models 里的设置）。ThinkingLevel 取 off、minimal、low、medium、high、xhigh、max 之一。
type CreateConversationRequest struct {
	Model         *ModelRef `json:"model,omitempty"`
	ThinkingLevel string    `json:"thinkingLevel,omitempty"`
}

// SetModelRequest 是 PUT /v1/conversations/:id/model 的 body；ThinkingLevel 为 nil 表示清空（用默认值）。
type SetModelRequest struct {
	Model         ModelRef `json:"model"`
	ThinkingLevel *string  `json:"thinkingLevel"`
}

// AgentModelResponse 是会话解析出的模型（没有时为 nil）与生效的 thinking level。
type AgentModelResponse struct {
	Model         *ModelRef `json:"model"`
	ThinkingLevel string    `json:"thinkingLevel"`
}

// AvailableModel 是 GET /v1/models/available 中的一项：一个已启用、且鉴权信息完整的提供方下的聊天模型。
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

// Health 报告服务能否应答，以及它在跑什么。
func (c *Client) Health(ctx context.Context) (Health, error) {
	var out Health
	err := c.do(ctx, http.MethodGet, "/v1/health", nil, &out)
	return out, err
}

// Conversations 列出无属主的会话，最新的在前。
func (c *Client) Conversations(ctx context.Context) ([]ConversationSummary, error) {
	var out struct {
		Conversations []ConversationSummary `json:"conversations"`
	}
	err := c.do(ctx, http.MethodGet, "/v1/conversations", nil, &out)
	return out.Conversations, err
}

// CreateConversation 创建一个空会话并返回其 id；零值请求表示用默认模型。未知模型或不支持的 thinking level
// 会得到 400 *Error。
func (c *Client) CreateConversation(ctx context.Context, req CreateConversationRequest) (int, error) {
	var out struct {
		ID int `json:"id"`
	}
	err := c.do(ctx, http.MethodPost, "/v1/conversations", req, &out)
	return out.ID, err
}

// SetModel 把会话 conv 换成另一个模型和 thinking level，从它下一次模型请求开始生效。
func (c *Client) SetModel(ctx context.Context, conv string, req SetModelRequest) (AgentModelResponse, error) {
	var out AgentModelResponse
	err := c.do(ctx, http.MethodPut, "/v1/conversations/"+url.PathEscape(conv)+"/model", req, &out)
	return out, err
}

// AvailableModels 列出会话现在可以使用的模型。
func (c *Client) AvailableModels(ctx context.Context) ([]AvailableModel, error) {
	var out struct {
		Models []AvailableModel `json:"models"`
	}
	err := c.do(ctx, http.MethodGet, "/v1/models/available", nil, &out)
	return out.Models, err
}

// Submit 把用户输入送进会话 conv（"root" 或数字 id）。ErrNoModel 和 ErrModelUnavailable 匹配它的 409。
func (c *Client) Submit(ctx context.Context, conv string, req SubmitRequest) (SubmitResponse, error) {
	var out SubmitResponse
	err := c.do(ctx, http.MethodPost, "/v1/conversations/"+url.PathEscape(conv)+"/submit", req, &out)
	return out, err
}

// Abort 停止会话正在进行的回复，并撤回已排队的输入。
func (c *Client) Abort(ctx context.Context, conv string) error {
	return c.do(ctx, http.MethodPost, "/v1/conversations/"+url.PathEscape(conv)+"/abort", nil, nil)
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func (c *Client) request(ctx context.Context, method, path string, body any) (*http.Request, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	req, err := c.request(ctx, method, path, body)
	if err != nil {
		return err
	}
	res, err := c.httpClient().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if err := responseError(res); err != nil {
		return err
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, res.Body)
		return nil
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	return nil
}

// responseError 把一个非 2xx 响应变成 *Error；body 里有 JSON 的 "error" 字段时用它的值。
func responseError(res *http.Response) error {
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	var body struct {
		Error string `json:"error"`
	}
	msg := string(bytes.TrimSpace(b))
	if json.Unmarshal(b, &body) == nil && body.Error != "" {
		msg = body.Error
	}
	return &Error{Status: res.StatusCode, Message: msg}
}
