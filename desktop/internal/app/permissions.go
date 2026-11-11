package app

import (
	"context"
	"time"

	"datawhisper/desktop/internal/service"
)

// permState 是当前对话的权限状态：范围与模式、等着用户回复的工具调用。
// 普通聊天没有模式；工作区对话的模式记在对话上（服务端），这里只是它的副本。
type permState struct {
	scope service.ConversationScope
	// requests 是当前对话里被挂起、等用户回复的工具调用，按到达顺序。
	requests []service.PermissionRequest
	// busy 记着已经发出回复、还没得到确认的请求，卡片上的按钮据此禁用。
	busy map[string]bool
	// dropped 记着本对话里已撤下的请求：拉取状态的响应可能晚于 resolved 通知到达，不能让已撤下的卡片复活。
	dropped map[string]bool
	err     string
	// gen 丢弃过期的响应：切换对话或重新加载后，旧请求的结果不能覆盖新状态。
	gen int
}

// permissionModes 是模式选择里的顺序，与 Claude Code 一致。
var permissionModes = []string{
	service.ModeManual,
	service.ModeAcceptEdits,
	service.ModePlan,
	service.ModeAuto,
	service.ModeBypass,
}

// modeLabel 是模式在芯片与菜单里的名字。
func (a *app) modeLabel(mode string) string {
	switch mode {
	case service.ModeAcceptEdits:
		return a.tr("perm.mode.accept_edits")
	case service.ModePlan:
		return a.tr("perm.mode.plan")
	case service.ModeAuto:
		return a.tr("perm.mode.auto")
	case service.ModeBypass:
		return a.tr("perm.mode.bypass")
	default:
		return a.tr("perm.mode.manual")
	}
}

// modeDescription 是模式的一句话说明，放在菜单项里名字的后面。
func (a *app) modeDescription(mode string) string {
	switch mode {
	case service.ModeAcceptEdits:
		return a.tr("perm.desc.accept_edits")
	case service.ModePlan:
		return a.tr("perm.desc.plan")
	case service.ModeAuto:
		return a.tr("perm.desc.auto")
	case service.ModeBypass:
		return a.tr("perm.desc.bypass")
	default:
		return a.tr("perm.desc.manual")
	}
}

// permissionsConversationChanged 在聊天切到另一个对话时丢掉上一个对话的权限状态并重新拉取。
func (a *app) permissionsConversationChanged() {
	a.perm = permState{gen: a.perm.gen + 1}
	a.loadPermissions()
}

// loadPermissions 拉取当前对话的范围与模式，以及重连前就已经挂起的审批请求。
func (a *app) loadPermissions() {
	client, conv := a.client, a.conv
	if client == nil || conv == 0 {
		return
	}
	a.perm.gen++
	gen := a.perm.gen
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		scope, scopeErr := client.Scope(ctx, conv)
		requests, requestsErr := client.PendingPermissions(ctx, conv)
		a.post(func() {
			if client != a.client || gen != a.perm.gen || conv != a.conv {
				return
			}
			if scopeErr == nil {
				a.perm.scope = scope
			}
			if requestsErr == nil {
				a.perm.requests = a.perm.requests[:0:0]
				for _, request := range requests {
					if !a.perm.dropped[request.RequestID] {
						a.perm.requests = append(a.perm.requests, request)
					}
				}
			}
		})
	}()
}

// onPermission 应用服务推来的权限通知：别的对话的请求不在这里显示，切过去时由 loadPermissions 补齐。
func (a *app) onPermission(ev service.PermissionEvent) {
	if ev.Request != nil {
		if ev.Request.ConversationID != a.conv {
			return
		}
		for _, existing := range a.perm.requests {
			if existing.RequestID == ev.Request.RequestID {
				return
			}
		}
		a.perm.requests = append(a.perm.requests, *ev.Request)
		return
	}
	a.dropPermission(ev.Resolved)
}

func (a *app) dropPermission(requestID string) {
	kept := a.perm.requests[:0]
	for _, request := range a.perm.requests {
		if request.RequestID != requestID {
			kept = append(kept, request)
		}
	}
	a.perm.requests = kept
	delete(a.perm.busy, requestID)
	if a.perm.dropped == nil {
		a.perm.dropped = map[string]bool{}
	}
	a.perm.dropped[requestID] = true
}

// respondPermission 回复一个待审批请求。回复被接受后服务端会推 permission.resolved，这里也先撤下卡片。
func (a *app) respondPermission(requestID, decision string) {
	client := a.client
	if client == nil || a.perm.busy[requestID] {
		return
	}
	if a.perm.busy == nil {
		a.perm.busy = map[string]bool{}
	}
	a.perm.busy[requestID], a.perm.err = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		err := client.RespondPermission(ctx, requestID, decision)
		a.post(func() {
			if client != a.client {
				return
			}
			delete(a.perm.busy, requestID)
			if err != nil {
				// 请求已经不在等回复了（这一轮被中止或已被回复）：卡片留着没有意义。
				a.dropPermission(requestID)
				a.perm.err = a.tr("perm.respondFailed", "error", a.sourceErr(err))
				return
			}
			a.dropPermission(requestID)
		})
	}()
}

// setPermissionMode 切换当前工作区对话的模式；下一次工具调用起生效。
func (a *app) setPermissionMode(mode string) {
	client, conv := a.client, a.conv
	if client == nil || conv == 0 || mode == a.perm.scope.Mode {
		return
	}
	a.perm.err = ""
	gen := a.perm.gen
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		scope, err := client.SetPermissionMode(ctx, conv, mode)
		a.post(func() {
			if client != a.client || gen != a.perm.gen || conv != a.conv {
				return
			}
			if err != nil {
				a.perm.err = a.tr("perm.modeFailed", "error", a.sourceErr(err))
				return
			}
			a.perm.scope = scope
		})
	}()
}
