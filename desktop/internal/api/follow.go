package api

import (
	"context"
	"errors"
	"time"
)

// FollowHandler receives a followed conversation's updates, on the Follow goroutine.
type FollowHandler struct {
	// OnState gets the state after every snapshot and ops event.
	OnState func(State)
	// OnDisconnect gets why a subscription ended, before Follow resubscribes after a backoff.
	OnDisconnect func(error)
}

// Follow keeps conversation conv replicated until ctx ends: it subscribes, applies each event to a replica, and
// after a broken stream, an end event, an idle connection or an out-of-sequence op subscribes again; every
// subscription starts from a fresh snapshot, so the replica then equals the service's view again. The backoff
// between attempts starts at 250 ms and doubles to 5 s, back to the start after a snapshot. Follow returns
// ctx.Err(), or an error wrapping ErrNotFound for an unknown conversation.
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
