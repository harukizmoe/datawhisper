package api

import (
	"context"
	"errors"
	"time"
)

// FollowHandler 接收一个被跟随的会话的更新，回调发生在 Follow 的 goroutine 上。
type FollowHandler struct {
	// OnState 在每次 snapshot 和 ops 事件之后拿到当前状态。
	OnState func(State)
	// OnDisconnect 拿到订阅结束的原因，随后 Follow 会在退避之后重新订阅。
	OnDisconnect func(error)
}

// Follow 一直让会话 conv 保持复制状态，直到 ctx 结束：它发起订阅，把每个事件应用到 replica 上，并且在订阅
// 被服务结束、管道关闭（服务重启）或遇到乱序的 op 之后重新订阅；每次订阅都从新的 snapshot 开始，所以之后
// replica 又和服务端的视图一致了。两次尝试之间的退避从 250 ms 开始翻倍，最多 5 s，收到 snapshot 后回到起点。
// Follow 返回 ctx.Err()，会话未知时返回包装了 ErrNotFound 的错误。
func Follow(ctx context.Context, c *Client, conv string, h FollowHandler) error {
	const first, last = 250 * time.Millisecond, 5 * time.Second
	backoff := first
	for {
		var replica Replica
		err := c.Subscribe(ctx, conv, func(ev Event) error {
			if err := replica.Apply(ev); err != nil {
				return err
			}
			if ev.Name == "snapshot" {
				backoff = first
			}
			if h.OnState != nil {
				h.OnState(replica.State())
			}
			return nil
		})
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, ErrNotFound) {
			return err
		}
		if h.OnDisconnect != nil {
			h.OnDisconnect(err)
		}
		t := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		case <-t.C:
		}
		backoff = min(backoff*2, last)
	}
}
