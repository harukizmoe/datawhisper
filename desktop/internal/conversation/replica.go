// Package conversation 把 agent 服务的会话订阅（一份 snapshot 加连续的 Chord delta ops）还原成界面要的会话状态：
// 消息、工具调用、图表、ask_user 问题与忙碌状态。Follow 在断线、服务重启后重新订阅，保持状态与服务端一致。
package conversation

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"datawhisper/desktop/internal/service"
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
func (r *Replica) Apply(ev service.Event) error {
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
	Key string
	// Role 取 "user"、"assistant"、"tool"、"thinking"（回复前的思考，Text 是思考全文）或 "note"（宿主旁注）。
	Role string
	Text string
	// Done 在行仍在流式变化时为 false：即部分回复或正在运行的 tool。
	Done bool
	// Time 是消息的时间戳（epoch 毫秒）；未知时为 0。
	Time int64
	// Usage 只挂在一次模型回复生成的最后一行上（正文，或回复只有工具调用时的最后一个工具行），
	// 这样界面把一轮里各行的 Usage 相加就是这一轮的用量，不会重复计算。Model 是那次回复用的模型。
	Usage *Usage
	Model string
	// Tool 在 Role == "tool" 时给出结构化的一次调用：参数、结果、耗时和 ask_user 的问题。界面据它
	// 画一行摘要（结果默认折叠），而不是把参数和结果的原始 JSON 灌进消息流。
	Tool *ToolCall
}

// ToolCall 是一次工具调用及其结果。调用 entry 与结果 entry 按 CallID 合并成同一行。
type ToolCall struct {
	CallID string
	Name   string
	// Args 是调用参数的紧凑摘要（键值对，已截断），给界面显示用，例如 `table=sales`。
	Args string
	// SQL 是调用参数里的 sql 全文（query_data、run_analysis 等都叫这个名字）。它不进 Args 摘要：摘要截断成一行，
	// 看不全一条查询；界面把它画成带语法高亮的代码块。
	SQL string
	// Output 是工具结果的全文；界面默认只显示一行状态，展开后才显示它。
	Output string
	// Status 取 "running"、"ok" 或 "error"。
	Status string
	// DurationMS 是工具报告的执行耗时；未知时为 0。
	DurationMS int64
	// Ask 是 ask_user 的参数（优先取工具结果里的规范化 details，其次取调用参数）。
	Ask *AskRequest
	// Charts 是工具结果里的图表（compute 的 generate_chart 与 profile_data）。界面用 web view
	// 画它们，而不是只留一句“Chart generated”。
	Charts []Chart
	// DashboardID 是工具新建的仪表盘 id（dashboard_id）；界面据此提供查看入口。
	DashboardID string
}

// Usage 是一次模型回复的 token 用量与费用（pi-ai 的 Usage）。DurationMS 是这次回复从发出请求到结束的耗时
// （消息的 durationMs，用来算输出速度）；未知时为 0。
type Usage struct {
	Input, Output, CacheRead, CacheWrite, Total int
	Cost                                        float64
	DurationMS                                  int64
}

// Add 把另一次回复的用量累加进来（界面按轮次汇总）。
func (u *Usage) Add(o Usage) {
	u.Input += o.Input
	u.Output += o.Output
	u.DurationMS += o.DurationMS
	u.CacheRead += o.CacheRead
	u.CacheWrite += o.CacheWrite
	u.Total += o.Total
	u.Cost += o.Cost
}

// QueuedInput 是排在 pi.inbox 里、还没进入会话的一条输入。Mode 取 "steer"（并入正在进行的回复）或
// "followUp"（排在后面）。
type QueuedInput struct {
	Text string
	Mode string
}

// Chart 是工具结果里的一张图表。服务端把图表 HTML 落盘后，details 里给的是 path；
// 落盘失败或旧消息里还可能是内联的 html，两者都保留，界面优先用 path。
type Chart struct {
	ID    string
	Title string
	Type  string
	Path  string
	HTML  string
}

// AskRequest 是 ask_user 交给界面展示的问题；选项来自工具本身，界面不自行编造。
type AskRequest struct {
	Question    string
	Options     []string
	MultiSelect bool
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
	// Queued 是 pi.inbox 中排队的输入数；QueuedInputs 是其中用户输入的正文（宿主写入的条目不算）。
	Queued       int
	QueuedInputs []QueuedInput
	// Model 是会话保存的模型（pi.agent.model）；还没有时为 nil（此时服务会在第一次 submit 时选默认模型）。
	// ThinkingLevel 是保存的级别，未设置时为 ""。
	Model         *service.ModelRef
	ThinkingLevel string
}

// State 从副本推导出聊天行与运行状态。
func (r *Replica) State() State {
	live := field(r.Tree, "docs", "pi.live")
	st := State{Seq: r.Seq, Messages: r.messages(), Busy: field(live, "run") != nil}
	if id := numberOf(field(r.Tree, "conversation", "id")); id > 0 {
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
	for _, item := range items {
		mode, _ := field(item, "mode").(string)
		if mode == "write" {
			continue
		}
		if text := contentText(field(item, "content")); text != "" {
			st.QueuedInputs = append(st.QueuedInputs, QueuedInput{Text: text, Mode: mode})
		}
	}
	agent := field(r.Tree, "docs", "pi.agent")
	provider, _ := field(agent, "model", "provider").(string)
	modelID, _ := field(agent, "model", "modelId").(string)
	if provider != "" && modelID != "" {
		st.Model = &service.ModelRef{Provider: provider, ModelID: modelID}
	}
	st.ThinkingLevel, _ = field(agent, "thinkingLevel").(string)
	return st
}

// numberOf 读一个数字：JSON 解码后是 float64，而直接构造的视图（测试、内部快照）可能是整数。
func numberOf(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case float32:
		return float64(n)
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return 0
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
// systemNotePrefixes 与 `server/src/agent/policies.ts` 里的标记保持同步。
var systemNotePrefixes = []string{"[QUALITY GATE]", "[SYSTEM NOTE]"}

// isSystemNote 报告这条用户消息其实是宿主写下的旁注，而不是用户自己打的字。
func isSystemNote(text string) bool {
	trimmed := strings.TrimSpace(text)
	for _, prefix := range systemNotePrefixes {
		if strings.HasPrefix(trimmed, prefix) {
			return true
		}
	}
	return false
}

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

// thinkingText 拼出回复里的思考块；被安全过滤器遮蔽（redacted）的块没有可读内容，跳过。
func thinkingText(content any) string {
	blocks, _ := content.([]any)
	var parts []string
	for _, block := range blocks {
		if field(block, "type") != "thinking" {
			continue
		}
		if redacted, _ := field(block, "redacted").(bool); redacted {
			continue
		}
		if s, _ := field(block, "thinking").(string); strings.TrimSpace(s) != "" {
			parts = append(parts, strings.TrimSpace(s))
		}
	}
	return strings.Join(parts, "\n\n")
}

// usageOf 读出一条 assistant 消息的 usage；没有时返回 nil。
func usageOf(m any) *Usage {
	u := field(m, "usage")
	if u == nil {
		return nil
	}
	return &Usage{
		Input:      int(numberOf(field(u, "input"))),
		Output:     int(numberOf(field(u, "output"))),
		CacheRead:  int(numberOf(field(u, "cacheRead"))),
		CacheWrite: int(numberOf(field(u, "cacheWrite"))),
		Total:      int(numberOf(field(u, "totalTokens"))),
		Cost:       numberOf(field(u, "cost", "total")),
		DurationMS: int64(numberOf(field(m, "durationMs"))),
	}
}

// argSummary 把调用参数压成一行键值对，例如 `table=sales, limit=10`；不是对象的参数退化成紧凑 JSON。
// 键按名字排序，界面在两次更新之间才不会因为 map 顺序抖动。
func argSummary(args any) string {
	obj, ok := args.(map[string]any)
	if !ok {
		if args == nil {
			return ""
		}
		return truncateJSON(args, 120)
	}
	keys := make([]string, 0, len(obj))
	for key := range obj {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+formatArg(obj[key], 60))
	}
	line := strings.Join(parts, ", ")
	if len(line) > 120 {
		line = line[:120] + "…" // 参数摘要只用于一行预览，全文在展开的结果里
	}
	return line
}

// formatArg 让参数摘要里的字符串显示原文（table=sales），其他值用紧凑 JSON。
func formatArg(v any, limit int) string {
	if s, ok := v.(string); ok {
		if len(s) > limit {
			return s[:limit] + "…"
		}
		return s
	}
	return truncateJSON(v, limit)
}

func truncateJSON(v any, limit int) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	s := string(raw)
	if len(s) > limit {
		s = s[:limit] + "…"
	}
	return s
}

// askRequestOf 从工具参数或结果 details 里读出 ask_user 的问题；两者都没有时返回 nil。
// 选项优先取 details（服务端已规范化：去空、去重、最多 6 个），没有 details 时退回调用参数。
func askRequestOf(node any) *AskRequest {
	m, ok := node.(map[string]any)
	if !ok {
		return nil
	}
	if tool, has := m["tool"].(string); has && tool != "ask_user" {
		return nil
	}
	question, _ := m["question"].(string)
	question = strings.TrimSpace(question)
	var options []string
	switch raw := m["options"].(type) {
	case []any:
		for _, item := range raw {
			text, _ := item.(string)
			if text == "" {
				// 与服务的 normalize_ask_user_args 一致：对象形式的选项读常见字段名。
				for _, key := range []string{"label", "text", "title", "name", "value"} {
					if v, ok := field(item, key).(string); ok && strings.TrimSpace(v) != "" {
						text = v
						break
					}
				}
			}
			if strings.TrimSpace(text) != "" {
				options = append(options, strings.TrimSpace(text))
			}
		}
	case []string:
		options = append(options, raw...)
	}
	if question == "" || len(options) == 0 {
		return nil
	}
	multi, _ := m["multi_select"].(bool)
	return &AskRequest{Question: question, Options: options, MultiSelect: multi}
}

// chartsOf 从工具结果的 details 里读出图表记录。每张图有 id、标题、类型，以及落盘后的
// path（或旧消息里内联的 html）；两者都没有的记录跳过，界面不画空图。
func chartsOf(details any) []Chart {
	m, ok := details.(map[string]any)
	if !ok {
		return nil
	}
	items, _ := m["charts"].([]any)
	if len(items) == 0 {
		return nil
	}
	out := make([]Chart, 0, len(items))
	for _, item := range items {
		chart := Chart{}
		chart.ID, _ = field(item, "id").(string)
		if chart.ID == "" {
			chart.ID, _ = field(item, "chart_id").(string)
		}
		chart.Title, _ = field(item, "title").(string)
		chart.Type, _ = field(item, "chart_type").(string)
		chart.Path, _ = field(item, "path").(string)
		chart.HTML, _ = field(item, "html").(string)
		if chart.Path == "" && chart.HTML == "" {
			continue
		}
		out = append(out, chart)
	}
	return out
}

// dashboardIDOf 读出工具结果里的仪表盘 id（compute 的 generate_dashboard 会带上它）。
func dashboardIDOf(details any) string {
	m, ok := details.(map[string]any)
	if !ok {
		return ""
	}
	id, _ := m["dashboard_id"].(string)
	return id
}

// callOf 把一个 toolCall block 变成工具行，参数摘要与 ask_user 问题都从这里取。
func callOf(block any) *ToolCall {
	name, _ := field(block, "name").(string)
	if name == "" {
		return nil
	}
	args := field(block, "arguments")
	sql, _ := field(args, "sql").(string)
	return &ToolCall{
		CallID: fmt.Sprint(field(block, "id")),
		Name:   name,
		Args:   argSummary(withoutKey(args, "sql")),
		SQL:    strings.TrimSpace(sql),
		Status: "running",
		Ask:    askRequestOf(args),
	}
}

// withoutKey 返回去掉一个键的参数副本；参数不是对象时原样返回。
func withoutKey(args any, key string) any {
	obj, ok := args.(map[string]any)
	if !ok {
		return args
	}
	rest := make(map[string]any, len(obj))
	for k, v := range obj {
		if k != key {
			rest[k] = v
		}
	}
	if len(rest) == 0 {
		return nil
	}
	return rest
}

// mergeResult 把工具结果折进对应的调用行；返回 false 表示结果没有配对的调用（entry 窗口滑动时可能发生）。
func mergeResult(out []Message, index map[string]int, callID, output string, durationMS int64, failed bool, details any) bool {
	i, ok := index[callID]
	if !ok {
		return false
	}
	tool := out[i].Tool
	tool.Output, tool.DurationMS = output, durationMS
	tool.Status = "ok"
	if failed {
		tool.Status = "error"
	}
	if ask := askRequestOf(details); ask != nil {
		tool.Ask = ask
	}
	tool.Charts = chartsOf(details)
	tool.DashboardID = dashboardIDOf(details)
	return true
}

// messages 推导出聊天行：已提交的 entry，然后是正在运行的 tool 槽位和流式回复。
func (r *Replica) messages() []Message {
	var out []Message
	// 回复在 pi.live.generation 里流式生成，同时 pi.live.run.taskId 指明它的 generation task；它最终提交的
	// pi.assistant entry 会把那个 id 记在 byTaskId 上。两边都用它做 key，就能让同一行列表（以及 markdown 视图
	// 的状态）在从流式切到已提交时保持不变，不管 entry 窗口怎么滑动。
	//
	// 一次工具调用由两条 entry 组成（pi.assistant 里的 toolCall，及随后的 pi.tool-result），它们在这里按
	// toolCallId 合并成同一行：调用参数给摘要，结果给全文与耗时，界面因此能只画一行并可展开。
	entries, _ := field(r.Tree, "entries").([]any)
	index := map[string]int{} // toolCallId → out 的下标
	for _, entry := range entries {
		models, _ := field(entry, "model").([]any)
		if len(models) == 0 {
			continue
		}
		m := models[0]
		id := fmt.Sprint(field(entry, "id"))
		switch field(entry, "kind") {
		case "pi.user":
			text := contentText(field(m, "content"))
			// 质量闸门与系统提醒是宿主写进会话的「给模型看的」消息（用户角色，模型才肯照做），
			// 但对人来说它们是诊断信息，不能冒充用户发言：渲染成旁注。
			role := "user"
			if isSystemNote(text) {
				role = "note"
			}
			out = append(out, Message{Key: "e" + id, Role: role, Text: text, Done: true, Time: int64(numberOf(field(m, "timestamp")))})
		case "pi.assistant":
			blocks, _ := field(m, "content").([]any)
			text := contentText(field(m, "content"))
			taskKey := fmt.Sprint("g", field(entry, "byTaskId"))
			first := len(out)
			if thought := thinkingText(field(m, "content")); thought != "" {
				out = append(out, Message{Key: taskKey + ".th", Role: "thinking", Text: thought, Done: true})
			}
			// 模型可能在调用工具前后都写正文；正文行只有一行，所以按第一段正文与第一个工具调用的先后
			// 决定这一行放在工具行之前还是之后。常见形状 [text, toolCall] 因此先显示正文再显示工具。
			firstText, firstTool := -1, -1
			for i, block := range blocks {
				switch field(block, "type") {
				case "text":
					if firstText < 0 {
						firstText = i
					}
				case "toolCall":
					if firstTool < 0 {
						firstTool = i
					}
				}
			}
			addText := func() {
				if text != "" {
					out = append(out, Message{Key: taskKey, Role: "assistant", Text: text, Done: true})
					text = ""
				}
			}
			if firstText >= 0 && (firstTool < 0 || firstText < firstTool) {
				addText()
			}
			for i, block := range blocks {
				if field(block, "type") != "toolCall" {
					continue
				}
				call := callOf(block)
				if call == nil {
					continue
				}
				if call.CallID != "" {
					index[call.CallID] = len(out)
				}
				out = append(out, Message{Key: fmt.Sprintf("e%s.%d", id, i), Role: "tool", Text: call.Name, Done: true, Tool: call})
			}
			addText()
			// 用量与时间挂在这次回复的最后一行上（见 Message.Usage）。
			if last := len(out) - 1; last >= first {
				out[last].Usage = usageOf(m)
				out[last].Time = int64(numberOf(field(m, "timestamp")))
				out[last].Model, _ = field(m, "model").(string)
			}
		case "pi.tool-result":
			callID, _ := field(m, "toolCallId").(string)
			duration := numberOf(field(m, "durationMs"))
			failed, _ := field(m, "isError").(bool)
			output := contentText(field(m, "content"))
			details := field(m, "details")
			if mergeResult(out, index, callID, output, int64(duration), failed, details) {
				continue
			}
			// 没有配对的调用（订阅从中间开始）：仍然画一行，名字取结果的 toolName。
			name, _ := field(m, "toolName").(string)
			if name == "" {
				name = "tool"
			}
			status := "ok"
			if failed {
				status = "error"
			}
			call := &ToolCall{CallID: callID, Name: name, Output: output, DurationMS: int64(duration), Status: status, Ask: askRequestOf(details), Charts: chartsOf(details), DashboardID: dashboardIDOf(details)}
			out = append(out, Message{Key: "e" + id, Role: "tool", Text: name, Done: true, Tool: call})
			if callID != "" {
				index[callID] = len(out) - 1
			}
		}
	}
	live := field(r.Tree, "docs", "pi.live")
	slots, _ := field(live, "tools").([]any)
	for _, slot := range slots {
		callID := fmt.Sprint(field(slot, "callId"))
		name, _ := field(slot, "name").(string)
		if name == "" {
			name = "tool"
		}
		output, _ := field(slot, "output").(string)
		status, _ := field(slot, "status").(string)
		if i, ok := index[callID]; ok {
			// 已提交的结果优先：entry 是最终值，槽位只是它的进行时影子。
			if out[i].Tool.Status == "running" && status != "done" {
				out[i].Tool.Status = "running"
				out[i].Tool.Output = output
				out[i].Done = false
			}
			continue
		}
		call := &ToolCall{CallID: callID, Name: name, Output: output, Status: "running", Ask: askRequestOf(field(slot, "details"))}
		out = append(out, Message{Key: "t" + callID, Role: "tool", Text: name, Done: false, Tool: call})
	}
	// 流式回复：先是正在生成的思考，再是正文。key 与提交后的行一致（"g<task id>" 与 "g<task id>.th"）。
	content := field(live, "generation", "message", "content")
	key := fmt.Sprint("g", field(live, "run", "taskId"))
	if thought := thinkingText(content); thought != "" {
		out = append(out, Message{Key: key + ".th", Role: "thinking", Text: thought})
	}
	if text := contentText(content); text != "" {
		out = append(out, Message{Key: key, Role: "assistant", Text: text})
	}
	return out
}
