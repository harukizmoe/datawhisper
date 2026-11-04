// Package api 是桌面应用访问 agent 服务的客户端（docs/refactor/ui-transport.md）：在服务子进程的
// stdin/stdout 上收发 JSON-RPC 2.0，一条记录一行 JSON。除带类型的请求外，它还提供由 snapshot 加
// Chord delta ops 复制出来的会话订阅。
package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
)

// ErrClosed 表示管道已经关闭：服务进程退出了。此后的请求都直接失败，这个 Client 也不能再用；重连由
// supervisor 触发，上层应改用新连接的 Client。
var ErrClosed = errors.New("the service connection is closed")

// Conn 是服务进程的管道：Read 读 stdout 上的协议记录，Write 写 stdin；Close 关闭 stdin（请求服务退出）。
// supervisor.Conn 实现它；测试里用 io.Pipe 拼一对。
type Conn interface {
	io.Reader
	io.WriteCloser
}

// Client 在一个运行中的服务管道上收发 JSON-RPC 记录。请求可并发，响应按 id 关联、允许乱序；读循环一直
// 跑到管道结束，所以请求方不需要额外的消费 goroutine。
type Client struct {
	conn Conn
	read *bufio.Reader

	// writeMu 让一条记录一次写完：并发请求的 JSON 行不会互相穿插（stdin 上的背压也就落在调用方身上）。
	writeMu sync.Mutex

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan response
	// subscriptions 是已经拿到 subscriptionId 的订阅队列。
	subscriptions map[int]*subscription
	// early 缓存订阅响应之前就到达的通知：服务先发 snapshot（以及可能的 ops）再回响应，这些通知不能丢。
	early map[int][]Event

	done     chan struct{} // 读循环结束时关闭
	doneOnce sync.Once
}

// New 在 conn 上开始读循环。服务退出（管道 EOF）时读循环安静地结束，未完成的请求得到 ErrClosed。
func New(conn Conn) *Client {
	c := &Client{
		conn:          conn,
		read:          bufio.NewReaderSize(conn, 64<<10),
		pending:       map[int64]chan response{},
		subscriptions: map[int]*subscription{},
		early:         map[int][]Event{},
		done:          make(chan struct{}),
	}
	go c.readLoop()
	return c
}

// Done 在读循环结束时关闭：服务进程退出，或管道断了。
func (c *Client) Done() <-chan struct{} { return c.done }

// Error 是一条 JSON-RPC 错误响应。Kind 是 error.data.kind（业务错误的细分，如 "not_found"），没有时为空。
type Error struct {
	Code    int
	Message string
	Kind    string
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

// request 是一条发往服务的记录。Params 为 nil 时不带该字段。
type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int64           `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// record 是一条来自服务的记录：响应（有 id，无 method）或通知（有 method）。
type record struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func (e *rpcError) toError() *Error {
	err := &Error{Code: e.Code, Message: e.Message}
	if len(e.Data) > 0 {
		var data struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(e.Data, &data) == nil {
			err.Kind = data.Kind
		}
	}
	return err
}

// response 是一条响应的结果，或让等待者醒来的错误。
type response struct {
	result json.RawMessage
	err    error
}

// readLoop 按 LF 切分记录。它不能停：stdout 的读端一旦不消费，服务就会在写记录时阻塞。
// 进程退出时管道结束，这是正常的收尾，不是错误。
func (c *Client) readLoop() {
	for {
		line, err := c.read.ReadString('\n')
		if len(line) > 0 && line[len(line)-1] == '\n' {
			c.handleLine(line[:len(line)-1])
		}
		if err != nil {
			c.close()
			return
		}
	}
}

// handleLine 处理一条完整记录（不含行尾的 LF）。坏记录只丢它自己：与服务的分帧规则一致，
// 后续记录照常处理。
func (c *Client) handleLine(line string) {
	line = strings.TrimSuffix(line, "\r")
	if line == "" {
		return
	}
	var rec record
	if err := json.Unmarshal([]byte(line), &rec); err != nil {
		return
	}
	if rec.Method != "" {
		if rec.Method == notifyConversationEvent {
			c.publish(rec.Params)
		}
		return
	}
	var id int64
	if len(rec.ID) == 0 || json.Unmarshal(rec.ID, &id) != nil {
		return
	}
	c.mu.Lock()
	ch := c.pending[id]
	delete(c.pending, id)
	c.mu.Unlock()
	if ch == nil {
		return // 已经超时或取消的请求：丢弃迟到的响应
	}
	res := response{result: rec.Result}
	if rec.Error != nil {
		res.err = rec.Error.toError()
	}
	ch <- res // 每个 id 只有一条响应，缓冲区足够
}

// publish 把一条 conversation.event 通知交给对应的订阅。订阅响应之前到达的通知先按 subscriptionId
// 缓存，等 Subscribe 拿到 id 后按顺序补交。
func (c *Client) publish(params json.RawMessage) {
	var ev Event
	if err := json.Unmarshal(params, &ev); err != nil || ev.SubscriptionID <= 0 {
		return
	}
	c.mu.Lock()
	if sub := c.subscriptions[ev.SubscriptionID]; sub != nil {
		sub.push(ev)
	} else {
		c.early[ev.SubscriptionID] = append(c.early[ev.SubscriptionID], ev)
	}
	c.mu.Unlock()
}

// start 分配 id、登记等待者并写出请求。返回的 channel 容量为 1，只会收到一条响应。
func (c *Client) start(method string, params any) (int64, <-chan response, error) {
	var raw json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return 0, nil, err
		}
		raw = b
	}
	c.mu.Lock()
	select {
	case <-c.done:
		c.mu.Unlock()
		return 0, nil, ErrClosed
	default:
	}
	c.nextID++
	id := c.nextID
	ch := make(chan response, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	line, err := json.Marshal(request{JSONRPC: "2.0", ID: id, Method: method, Params: raw})
	if err != nil {
		c.forget(id)
		return 0, nil, err
	}
	line = append(line, '\n')
	c.writeMu.Lock()
	_, err = c.conn.Write(line)
	c.writeMu.Unlock()
	if err != nil {
		c.forget(id)
		c.close()
		return 0, nil, ErrClosed
	}
	return id, ch, nil
}

// forget 取消登记：迟到的响应会被读循环丢掉。
func (c *Client) forget(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// close 结束客户端：叫醒所有等待者，并关闭 Done。
func (c *Client) close() {
	c.doneOnce.Do(func() {
		c.mu.Lock()
		for id, ch := range c.pending {
			ch <- response{err: ErrClosed}
			delete(c.pending, id)
		}
		close(c.done)
		c.mu.Unlock()
	})
}

// Call 发一个请求并等它的响应。响应按 id 关联，所以多个 Call 可以并发；ctx 结束只是放弃这次等待
// （服务端的响应会被丢弃），管道本身仍然可用。
func (c *Client) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id, ch, err := c.start(method, params)
	if err != nil {
		return nil, err
	}
	select {
	case res := <-ch:
		return res.result, res.err
	case <-ctx.Done():
		c.forget(id)
		return nil, ctx.Err()
	case <-c.done:
		// close 会把已登记的请求都填上 ErrClosed；再读一次以免和它的时序错开。
		select {
		case res := <-ch:
			return res.result, res.err
		default:
			c.forget(id)
			return nil, ErrClosed
		}
	}
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
