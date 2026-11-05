// Package jsonrpc 是桌面端进程边界上的 JSON-RPC 2.0 传输：在子进程的 stdin/stdout 上收发记录，一条记录一行
// JSON（docs/refactor/ui-transport.md）。它只负责分帧、按 id 关联请求与响应、把通知交给回调，不认识任何业务
// 方法；agent 服务的方法与订阅在 internal/service。
package jsonrpc

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

// ErrClosed 表示管道已经关闭：对端进程退出了。此后的请求都直接失败，这个 Client 也不能再用；重连由上层
// （supervisor 拉起新进程）负责，之后应改用新连接的 Client。
var ErrClosed = errors.New("the service connection is closed")

// Conn 是对端进程的管道：Read 读 stdout 上的协议记录，Write 写 stdin；Close 关闭 stdin（请求对端退出）。
// supervisor.Conn 实现它；测试里用 io.Pipe 拼一对。
type Conn interface {
	io.Reader
	io.WriteCloser
}

// Error 是一条 JSON-RPC 错误响应。Data 是 error.data 的原文，由上层按自己的约定解读。
type Error struct {
	Code    int
	Message string
	Data    json.RawMessage
}

func (e *Error) Error() string { return fmt.Sprintf("service: %d %s", e.Code, e.Message) }

// Response 是一条响应的结果，或让等待者醒来的错误（*Error、ErrClosed）。
type Response struct {
	Result json.RawMessage
	Err    error
}

// NotifyFunc 处理一条通知。它在读循环的 goroutine 上被调用，必须很快返回、不能阻塞：读端一旦不消费，
// 对端就会在写记录时卡住。
type NotifyFunc func(method string, params json.RawMessage)

// Client 在一条管道上收发 JSON-RPC 记录。请求可并发，响应按 id 关联、允许乱序；读循环一直跑到管道结束，
// 所以请求方不需要额外的消费 goroutine。
type Client struct {
	conn     Conn
	read     *bufio.Reader
	onNotify NotifyFunc

	// writeMu 让一条记录一次写完：并发请求的 JSON 行不会互相穿插（stdin 上的背压也就落在调用方身上）。
	writeMu sync.Mutex

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan Response

	done     chan struct{} // 读循环结束时关闭
	doneOnce sync.Once
}

// New 在 conn 上开始读循环；onNotify 可以为 nil（丢弃通知）。对端退出（管道 EOF）时读循环安静地结束，
// 未完成的请求得到 ErrClosed。
func New(conn Conn, onNotify NotifyFunc) *Client {
	c := &Client{
		conn:     conn,
		read:     bufio.NewReaderSize(conn, 64<<10),
		onNotify: onNotify,
		pending:  map[int64]chan Response{},
		done:     make(chan struct{}),
	}
	go c.readLoop()
	return c
}

// Done 在读循环结束时关闭：对端进程退出，或管道断了。
func (c *Client) Done() <-chan struct{} { return c.done }

// request 是一条发往对端的记录。Params 为 nil 时不带该字段。
type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int64           `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// record 是一条来自对端的记录：响应（有 id，无 method）或通知（有 method）。
type record struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	} `json:"error"`
}

// readLoop 按 LF 切分记录。它不能停：stdout 的读端一旦不消费，对端就会在写记录时阻塞。
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

// handleLine 处理一条完整记录（不含行尾的 LF）。坏记录只丢它自己：与服务的分帧规则一致，后续记录照常处理。
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
		if c.onNotify != nil {
			c.onNotify(rec.Method, rec.Params)
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
	res := Response{Result: rec.Result}
	if rec.Error != nil {
		res.Err = &Error{Code: rec.Error.Code, Message: rec.Error.Message, Data: rec.Error.Data}
	}
	ch <- res // 每个 id 只有一条响应，缓冲区足够
}

// Start 分配 id、登记等待者并写出请求，不等响应。返回的 channel 容量为 1，只会收到一条响应；放弃等待时
// 调 Forget，迟到的响应会被丢掉。需要在等待期间做别的事（例如订阅要先接管早到的通知）时用它，否则用 Call。
func (c *Client) Start(method string, params any) (int64, <-chan Response, error) {
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
	ch := make(chan Response, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	line, err := json.Marshal(request{JSONRPC: "2.0", ID: id, Method: method, Params: raw})
	if err != nil {
		c.Forget(id)
		return 0, nil, err
	}
	line = append(line, '\n')
	c.writeMu.Lock()
	_, err = c.conn.Write(line)
	c.writeMu.Unlock()
	if err != nil {
		c.Forget(id)
		c.close()
		return 0, nil, ErrClosed
	}
	return id, ch, nil
}

// Forget 取消登记：迟到的响应会被读循环丢掉。
func (c *Client) Forget(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// close 结束客户端：叫醒所有等待者，并关闭 Done。
func (c *Client) close() {
	c.doneOnce.Do(func() {
		c.mu.Lock()
		for id, ch := range c.pending {
			ch <- Response{Err: ErrClosed}
			delete(c.pending, id)
		}
		close(c.done)
		c.mu.Unlock()
	})
}

// Call 发一个请求并等它的响应。响应按 id 关联，所以多个 Call 可以并发；ctx 结束只是放弃这次等待
// （对端的响应会被丢弃），管道本身仍然可用。
func (c *Client) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id, ch, err := c.Start(method, params)
	if err != nil {
		return nil, err
	}
	select {
	case res := <-ch:
		return res.Result, res.Err
	case <-ctx.Done():
		c.Forget(id)
		return nil, ctx.Err()
	case <-c.done:
		// close 会把已登记的请求都填上 ErrClosed；再读一次以免和它的时序错开。
		select {
		case res := <-ch:
			return res.Result, res.Err
		default:
			c.Forget(id)
			return nil, ErrClosed
		}
	}
}
