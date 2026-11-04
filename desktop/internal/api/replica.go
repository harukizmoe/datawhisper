package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ErrSequence means an ops event did not follow the replica's seq: resubscribe for a fresh snapshot.
var ErrSequence = errors.New("ops out of sequence")

// Replica is the client copy of one conversation's ConversationView, built from a snapshot and its ops. It is not
// safe for concurrent use: keep it on one goroutine and hand out State values.
type Replica struct {
	// Tree is the view as decoded JSON; nil before the first snapshot.
	Tree any
	// Seq is the seq of the last event applied.
	Seq int
}

// Apply folds one event in. A snapshot replaces the replica; ops must follow in sequence (ErrSequence otherwise).
// After an error the replica is unusable until the next snapshot.
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

// Message is one row of the chat.
type Message struct {
	// Key identifies the row across updates; a streaming reply keeps its key ("g<generation task id>") when its
	// committed entry replaces it.
	Key  string
	Role string // "user", "assistant" or "tool"
	Text string
	// Done is false while the row streams: a partial reply or a running tool.
	Done bool
}

// State is what the chat view shows of a replica: immutable, safe to hand to the UI thread.
type State struct {
	Conversation int
	Seq          int
	Messages     []Message
	// Busy while a run is in progress (pi.live.run).
	Busy bool
	// Failure says why the newest run ended without an answer (pi.live.runFailure): "reason" or "reason: detail".
	Failure string
	// Queued counts inputs waiting in pi.inbox.
	Queued int
	// Model is the conversation's stored model (pi.agent.model); nil until it has one (the service then picks
	// the default model at the first submit). ThinkingLevel is the stored level, "" when unset.
	Model         *ModelRef
	ThinkingLevel string
}

// State derives the chat rows and run status.
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

// contentText joins the text of a pi-ai message content (a string, or blocks).
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

// messages derives chat rows: committed entries, then the live tool slots and the streaming reply.
func (r *Replica) messages() []Message {
	var out []Message
	// A reply streams in pi.live.generation while pi.live.run.taskId names its generation task; the pi.assistant
	// entry it commits carries that id as byTaskId. Keying both by it keeps one list row (and the markdown view's
	// state) across the switch from streaming to committed, however the entry window slides.
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
