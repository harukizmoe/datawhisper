package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"datawhisper/desktop/internal/jsonrpc"
)

// Event 是一条 conversation.event 通知。
type Event struct {
	// SubscriptionID 是这条事件所属的订阅（由 conversation.subscribe 分配）。
	SubscriptionID int `json:"subscriptionId"`
	// Name 是 "snapshot"、"ops" 或 "end"。
	Name string `json:"-"`
	// Seq 对 snapshot 为 0，之后每个 ops 依次为 1、2、……
	Seq int `json:"seq"`
	// View 是 snapshot 的 ConversationView，已解码成 JSON（map、slice、float64、string、bool、nil）。
	View any `json:"view"`
	// Ops 是 ops 事件里的 Chord delta ops。
	Ops []json.RawMessage `json:"ops"`
	// Kind 是 end 事件中 watch 结束的原因：stopped、aborted、ended、listener_error 或 failed。
	Kind string `json:"kind"`
}

// UnmarshalJSON 把通知参数里的 "event" 读到 Name；其余字段与线上形状一致，便于直接解码 params。
func (e *Event) UnmarshalJSON(data []byte) error {
	var raw struct {
		SubscriptionID int               `json:"subscriptionId"`
		Event          string            `json:"event"`
		Seq            int               `json:"seq"`
		View           json.RawMessage   `json:"view"`
		Ops            []json.RawMessage `json:"ops"`
		Kind           string            `json:"kind"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	e.SubscriptionID, e.Name, e.Seq, e.Ops, e.Kind = raw.SubscriptionID, raw.Event, raw.Seq, raw.Ops, raw.Kind
	e.View = nil
	if len(raw.View) > 0 && string(raw.View) != "null" {
		if err := json.Unmarshal(raw.View, &e.View); err != nil {
			return err
		}
	}
	return nil
}

// ErrEnded 在服务用 end 通知结束订阅时由 Subscribe 返回。
var ErrEnded = errors.New("subscription ended by the service")

// notifyConversationEvent 是订阅通知的方法名。
const notifyConversationEvent = "conversation.event"

// unsubscribeTimeout 限制退订请求的等待：调用方的 ctx 可能已经结束，退订仍要发出去。
const unsubscribeTimeout = 5 * time.Second

// subscription 是一个订阅的本地队列。读循环只追加（永不阻塞，否则整条管道都会停住）；Subscribe 在
// 调用者的 goroutine 上逐条取出。
type subscription struct {
	mu    sync.Mutex
	queue []Event
	wake  chan struct{}
}

func (s *subscription) push(ev Event) {
	s.mu.Lock()
	s.queue = append(s.queue, ev)
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *subscription) pop() (Event, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.queue) == 0 {
		return Event{}, false
	}
	ev := s.queue[0]
	s.queue[0] = Event{} // 不要留住 View/Ops 的引用
	s.queue = s.queue[1:]
	return ev, true
}

// attach 登记订阅号并接管它早到的通知（服务先发 snapshot 再回订阅响应）。
func (c *Client) attach(subscriptionID int) *subscription {
	sub := &subscription{wake: make(chan struct{}, 1)}
	c.mu.Lock()
	if early := c.early[subscriptionID]; len(early) > 0 {
		sub.queue = early
		delete(c.early, subscriptionID)
	}
	c.subscriptions[subscriptionID] = sub
	c.mu.Unlock()
	select {
	case sub.wake <- struct{}{}:
	default:
	}
	return sub
}

func (c *Client) detach(subscriptionID int, sub *subscription) {
	c.mu.Lock()
	if c.subscriptions[subscriptionID] == sub {
		delete(c.subscriptions, subscriptionID)
	}
	c.mu.Unlock()
}

func (c *Client) forgetEarly(subscriptionID int) {
	c.mu.Lock()
	delete(c.early, subscriptionID)
	c.mu.Unlock()
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

// unsubscribe 尽力退订。ctx 已经结束时（或连接已断）忽略错误：服务端的 watch 结束时会自己清掉。
func (c *Client) unsubscribe(subscriptionID int) {
	ctx, cancel := context.WithTimeout(context.Background(), unsubscribeTimeout)
	defer cancel()
	_, _ = c.Call(ctx, "conversation.unsubscribe", struct {
		SubscriptionID int `json:"subscriptionId"`
	}{subscriptionID})
}

// Subscribe 把会话 conv（"root" 或数字 id）的事件送给 onEvent，直到 ctx 结束、订阅被服务结束（ErrEnded）、
// 管道关闭（ErrClosed）或 onEvent 返回错误。每次订阅都先收到一份 snapshot，之后是连续的 ops。
// 它不会返回 nil：ctx 结束时是 ctx.Err()，会话未知时是包装了 ErrNotFound 的 *Error。
func (c *Client) Subscribe(ctx context.Context, conv string, onEvent func(Event) error) error {
	_, ch, err := c.rpc.Start("conversation.subscribe", struct {
		ID string `json:"id"`
	}{conv})
	if err != nil {
		return err
	}
	var result struct {
		SubscriptionID int `json:"subscriptionId"`
	}
	select {
	case res := <-ch:
		if res.Err != nil {
			return asServiceError(res.Err)
		}
		if err := json.Unmarshal(res.Result, &result); err != nil {
			return fmt.Errorf("conversation.subscribe: %w", err)
		}
	case <-ctx.Done():
		// 服务可能仍然建好了订阅：等响应到达后把它退掉，免得留下一个没人接收的 watch。
		go c.abandonSubscribe(ch)
		return ctx.Err()
	case <-c.rpc.Done():
		select {
		case res := <-ch:
			if res.Err != nil {
				return asServiceError(res.Err)
			}
			if err := json.Unmarshal(res.Result, &result); err != nil {
				return fmt.Errorf("conversation.subscribe: %w", err)
			}
		default:
			return ErrClosed
		}
	}
	if result.SubscriptionID <= 0 {
		return fmt.Errorf("conversation.subscribe: invalid subscriptionId %d", result.SubscriptionID)
	}
	sub := c.attach(result.SubscriptionID)
	defer c.detach(result.SubscriptionID, sub)

	for {
		ev, ok := sub.pop()
		if !ok {
			select {
			case <-sub.wake:
				continue
			case <-ctx.Done():
				c.unsubscribe(result.SubscriptionID)
				return ctx.Err()
			case <-c.rpc.Done():
				// 退出前把已经排队的通知送完，避免丢掉最后一份 snapshot 或 end。
				if _, ok := sub.pop(); ok {
					continue
				}
				return ErrClosed
			}
		}
		if ev.Name == "end" {
			return fmt.Errorf("%w (%s)", ErrEnded, ev.Kind)
		}
		if err := onEvent(ev); err != nil {
			c.unsubscribe(result.SubscriptionID)
			return err
		}
	}
}

// abandonSubscribe 等一个已经被调用方放弃的订阅响应；拿到订阅号就退订。
func (c *Client) abandonSubscribe(ch <-chan jsonrpc.Response) {
	select {
	case res := <-ch:
		if res.Err != nil {
			return
		}
		var result struct {
			SubscriptionID int `json:"subscriptionId"`
		}
		if json.Unmarshal(res.Result, &result) != nil || result.SubscriptionID <= 0 {
			return
		}
		c.forgetEarly(result.SubscriptionID)
		c.unsubscribe(result.SubscriptionID)
		// 退订返回后 watch 已经停了；再清一次窗口期内到达的通知。
		c.forgetEarly(result.SubscriptionID)
	case <-c.rpc.Done():
	}
}
