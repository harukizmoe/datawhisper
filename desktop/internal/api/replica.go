package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ErrSequence 表示某个 ops 事件没有接上 replica 的 seq：需要重新订阅以拿一份新的 snapshot。
var ErrSequence = errors.New("ops out of sequence")

// Replica 是一个会话 ConversationView 的客户端副本，由 snapshot 及其后的一串 ops 构建出来。它不是并发安全的：
// 只在同一个 goroutine 上使用它，对外交出 State 值。
type Replica struct {
	// Tree 是解码成 JSON 的视图；在第一个 snapshot 之前为 nil。
	Tree any
	// Seq 是最后一个已应用事件的 seq。
	Seq int
}

// Apply 折入一个事件。snapshot 会替换整个副本；ops 必须按顺序跟上（否则返回 ErrSequence）。出错之后副本不可
// 用，直到下一个 snapshot。
func (r *Replica) Apply(ev Event) error {
	switch ev.Name {
	case "snapshot":
		r.Tree, r.Seq = ev.View, ev.Seq
	case "ops":
		if r.Tree == nil || ev.Seq != r.Seq+1 {
			return fmt.Errorf("%w: seq %d after %d", ErrSequence, ev.Seq, r.Seq)
		}
		tree, err := ApplyOps(r.Tree, ev.Ops)
		if err != nil {
			r.Tree = nil
			return err
		}
		r.Tree, r.Seq = tree, ev.Seq
	}
	return nil
}

// Message 是聊天里的一行。
type Message struct {
	// Key 在多次更新之间标识这一行；流式回复在它对应的已提交 entry 接替它时沿用同一个 key（"g<generation task id>"）。
	Key  string
	Role string // "user"、"assistant" 或 "tool"
	Text string
	// Done 在行仍在流式变化时为 false：即部分回复或正在运行的 tool。
	Done bool
}

// State 是聊天视图会从 replica 读取的内容：不可变，可以安全地交给 UI 线程。
type State struct {
	Conversation int
	Seq          int
	Messages     []Message
	// Busy 表示有运行正在进行（pi.live.run）。
	Busy bool
	// Failure 说明最新一次运行为何没有答案就结束了（pi.live.runFailure）："reason" 或 "reason: detail"。
	Failure string
	// Queued 是 pi.inbox 中排队的输入数。
	Queued int
	// Model 是会话保存的模型（pi.agent.model）；还没有时为 nil（此时服务会在第一次 submit 时选默认模型）。
	// ThinkingLevel 是保存的级别，未设置时为 ""。
	Model         *ModelRef
	ThinkingLevel string
}

// State 从副本推导出聊天行与运行状态。
func (r *Replica) State() State {
	live := field(r.Tree, "docs", "pi.live")
	st := State{Seq: r.Seq, Messages: r.messages(), Busy: field(live, "run") != nil}
	if id, ok := field(r.Tree, "conversation", "id").(float64); ok {
		st.Conversation = int(id)
	}
	if failure := field(live, "runFailure"); failure != nil {
		st.Failure = fmt.Sprint(field(failure, "reason"))
		if detail, ok := field(failure, "detail").(string); ok && detail != "" {
			st.Failure += ": " + detail
		}
	}
	items, _ := field(r.Tree, "docs", "pi.inbox", "items").([]any)
	st.Queued = len(items)
	agent := field(r.Tree, "docs", "pi.agent")
	provider, _ := field(agent, "model", "provider").(string)
	modelID, _ := field(agent, "model", "modelId").(string)
	if provider != "" && modelID != "" {
		st.Model = &ModelRef{Provider: provider, ModelID: modelID}
	}
	st.ThinkingLevel, _ = field(agent, "thinkingLevel").(string)
	return st
}

func field(node any, path ...string) any {
	for _, p := range path {
		m, ok := node.(map[string]any)
		if !ok {
			return nil
		}
		node = m[p]
	}
	return node
}

// contentText 把 pi-ai 消息内容的文本拼起来（内容是字符串，或是一组 block）。
func contentText(content any) string {
	if s, ok := content.(string); ok {
		return s
	}
	var b strings.Builder
	blocks, _ := content.([]any)
	for _, block := range blocks {
		if field(block, "type") == "text" {
			s, _ := field(block, "text").(string)
			b.WriteString(s)
		}
	}
	return b.String()
}

func toolCalls(content any) []string {
	var calls []string
	blocks, _ := content.([]any)
	for _, block := range blocks {
		if field(block, "type") == "toolCall" {
			args, _ := json.Marshal(field(block, "arguments"))
			calls = append(calls, fmt.Sprintf("→ %v %s", field(block, "name"), args))
		}
	}
	return calls
}

// messages 推导出聊天行：已提交的 entry，然后是正在运行的 tool 槽位和流式回复。
func (r *Replica) messages() []Message {
	var out []Message
	// 回复在 pi.live.generation 里流式生成，同时 pi.live.run.taskId 指明它的 generation task；它最终提交的
	// pi.assistant entry 会把那个 id 记在 byTaskId 上。两边都用它做 key，就能让同一行列表（以及 markdown 视图
	// 的状态）在从流式切到已提交时保持不变，不管 entry 窗口怎么滑动。
	entries, _ := field(r.Tree, "entries").([]any)
	for _, entry := range entries {
		models, _ := field(entry, "model").([]any)
		if len(models) == 0 {
			continue
		}
		m := models[0]
		id := fmt.Sprint(field(entry, "id"))
		switch field(entry, "kind") {
		case "pi.user":
			out = append(out, Message{Key: "e" + id, Role: "user", Text: contentText(field(m, "content")), Done: true})
		case "pi.assistant":
			for i, call := range toolCalls(field(m, "content")) {
				out = append(out, Message{Key: fmt.Sprintf("e%s.%d", id, i), Role: "tool", Text: call, Done: true})
			}
			if text := contentText(field(m, "content")); text != "" {
				out = append(out, Message{Key: fmt.Sprint("g", field(entry, "byTaskId")), Role: "assistant", Text: text, Done: true})
			}
		case "pi.tool-result":
			out = append(out, Message{Key: "e" + id, Role: "tool", Text: "← " + contentText(field(m, "content")), Done: true})
		}
	}
	live := field(r.Tree, "docs", "pi.live")
	slots, _ := field(live, "tools").([]any)
	for _, slot := range slots {
		output, _ := field(slot, "output").(string)
		text := strings.TrimSpace(fmt.Sprintf("⋯ %v %v %s", field(slot, "name"), field(slot, "status"), output))
		out = append(out, Message{Key: fmt.Sprint("t", field(slot, "callId")), Role: "tool", Text: text})
	}
	if text := contentText(field(live, "generation", "message", "content")); text != "" {
		out = append(out, Message{Key: fmt.Sprint("g", field(live, "run", "taskId")), Role: "assistant", Text: text})
	}
	return out
}
