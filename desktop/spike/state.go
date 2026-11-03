package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// message is one row of the chat, derived from the replicated ConversationView.
type message struct {
	key  string // list key; an assistant reply keeps "g<generation task id>" from Stream to View
	role string // "user", "assistant", "tool"
	text string
	done bool
}

// conversation is the client replica of the server's ConversationView.
type conversation struct {
	tree any
	seq  int
}

// apply folds one /subscribe event into the replica. A snapshot replaces it; ops must follow in sequence.
func (cv *conversation) apply(ev event) error {
	switch ev.Name {
	case "snapshot":
		cv.tree, cv.seq = ev.View, ev.Seq
	case "ops":
		if ev.Seq != cv.seq+1 {
			return fmt.Errorf("ops seq %d after %d: resubscribe", ev.Seq, cv.seq)
		}
		tree, err := applyOps(cv.tree, ev.Ops)
		if err != nil {
			return err
		}
		cv.tree, cv.seq = tree, ev.Seq
	}
	return nil
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

// messages derives chat rows: committed entries, then the live tool slots and streaming reply.
func (cv *conversation) messages() []message {
	var out []message
	// A reply streams in pi.live.generation while pi.live.run.taskId names its generation task; the
	// pi.assistant entry it commits carries that id as byTaskId. Keying both by it keeps one list row (and
	// the markdown view's state) across the switch from Stream to View, however the entry window slides.
	entries, _ := field(cv.tree, "entries").([]any)
	for _, entry := range entries {
		models, _ := field(entry, "model").([]any)
		if len(models) == 0 {
			continue
		}
		m := models[0]
		id := fmt.Sprint(field(entry, "id"))
		switch field(entry, "kind") {
		case "pi.user":
			out = append(out, message{key: "e" + id, role: "user", text: contentText(field(m, "content")), done: true})
		case "pi.assistant":
			for i, call := range toolCalls(field(m, "content")) {
				out = append(out, message{key: fmt.Sprintf("e%s.%d", id, i), role: "tool", text: call, done: true})
			}
			if text := contentText(field(m, "content")); text != "" {
				out = append(out, message{key: fmt.Sprint("g", field(entry, "byTaskId")), role: "assistant", text: text, done: true})
			}
		case "pi.tool-result":
			out = append(out, message{key: "e" + id, role: "tool", text: "← " + contentText(field(m, "content")), done: true})
		}
	}
	live := field(cv.tree, "docs", "pi.live")
	slots, _ := field(live, "tools").([]any)
	for _, slot := range slots {
		output, _ := field(slot, "output").(string)
		out = append(out, message{key: fmt.Sprint("t", field(slot, "callId")), role: "tool", text: strings.TrimSpace(fmt.Sprintf("⋯ %v %v %s", field(slot, "name"), field(slot, "status"), output)), done: false})
	}
	if text := contentText(field(live, "generation", "message", "content")); text != "" {
		out = append(out, message{key: fmt.Sprint("g", field(live, "run", "taskId")), role: "assistant", text: text, done: false})
	}
	return out
}
