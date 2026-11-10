package app

// 消息列表的分行与「整段折叠」（参考 Tern 的 Fold tool calls）：回答出现之后，一轮里连续的工具调用折成一行
// 「Worked for 7.0s · query_data · get_schema ›」，点开看全部。列表按「行」渲染：一行是一条消息，或一组被折叠的
// 消息；导航轨、跳转与出处仍按消息下标工作，所以这里同时给出消息到行的映射。

import (
	"strconv"
	"strings"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/prefs"
	"github.com/egoist/mygo/ui"
)

// chatRow 是消息列表里的一行：messages[from:to]。folded 为真时它是一组被折叠的工具调用与思考。
type chatRow struct {
	from, to int
	folded   bool
	key      string
}

// foldTool 与 foldThought 判断一条消息能不能并入折叠组。带图表或仪表盘的工具卡片不折：折起来就看不见图了；
// ask_user 是要回答的问题，也不折。思考在「展开」方式下留在原位，所以同样不折。
func foldTool(m conversation.Message) bool {
	t := m.Tool
	return m.Role == "tool" && m.Done && t != nil && t.Ask == nil && len(t.Charts) == 0 && t.DashboardID == ""
}

func foldThought(m conversation.Message, ap prefs.Appearance) bool {
	return m.Role == "thinking" && m.Done && ap.Thinking == prefs.ThinkingCollapsed
}

// chatRows 把消息分成行，并给出 rowOf：每条消息所在的行（被隐藏的思考落在它后面那一行）。
// 一段连续的可折叠消息只有在它后面紧跟着已完成的回答正文时才折叠：还在进行的一轮保持展开，看得到过程。
func chatRows(messages []conversation.Message, ap prefs.Appearance) ([]chatRow, []int) {
	rows := make([]chatRow, 0, len(messages))
	rowOf := make([]int, len(messages))
	hiddenThought := func(m conversation.Message) bool {
		return m.Role == "thinking" && ap.Thinking == prefs.ThinkingHidden
	}
	for i := 0; i < len(messages); {
		m := messages[i]
		if hiddenThought(m) {
			rowOf[i] = len(rows)
			i++
			continue
		}
		if ap.FoldRuns && (foldTool(m) || foldThought(m, ap)) {
			end := i
			for end < len(messages) && (foldTool(messages[end]) || foldThought(messages[end], ap) || hiddenThought(messages[end])) {
				end++
			}
			if end < len(messages) && answered(messages[end]) {
				for j := i; j < end; j++ {
					rowOf[j] = len(rows)
				}
				rows = append(rows, chatRow{from: i, to: end, folded: true, key: "run:" + m.Key})
				i = end
				continue
			}
		}
		rowOf[i] = len(rows)
		rows = append(rows, chatRow{from: i, to: i + 1, key: m.Key})
		i++
	}
	// 末尾被隐藏的思考没有后一行，归到最后一行。
	for i := range rowOf {
		if rowOf[i] >= len(rows) {
			rowOf[i] = len(rows) - 1
		}
	}
	return rows, rowOf
}

// answered 报告这条消息是不是已经写完、有可见文字的回答。
func answered(m conversation.Message) bool {
	return m.Role == "assistant" && m.Done && strings.TrimSpace(visibleText(m.Text)) != ""
}

// foldedRun 画一组被折叠的消息：一行摘要，点开后依次显示组内的消息。
func (a *app) foldedRun(c *ui.Context, row chatRow, msgs []conversation.Message) {
	t := c.Theme()
	if a.cv.openRuns == nil {
		a.cv.openRuns = map[string]bool{}
	}
	open := a.cv.openRuns[row.key]
	chevron := icons.ChevronRight
	if open {
		chevron = icons.ChevronDown
	}
	label, failed := a.runSummary(msgs)
	ui.Column(c).Gap(8).Children(func() {
		ui.Row(c).Children(func() {
			if ui.ButtonBase(c).Label(label).Children(func() {
				ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
					ui.Icon(c, icons.Tool).TextColor(t.TextMuted)
					ui.Text(c, label).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).SingleLine()
					if failed > 0 {
						ui.Text(c, a.tr("chat.runFailed", "count", strconv.Itoa(failed))).FontSize(a.fs(textCaption)).TextColor(t.Danger).SingleLine()
					}
					ui.Icon(c, chevron).TextColor(t.TextMuted)
				})
			}).Clicked() {
				a.cv.openRuns[row.key] = !open
			}
			ui.Spacer(c)
		})
		if open {
			ui.Column(c).Gap(10).Padding(0, 0, 0, 12).BorderWidth(0, 0, 0, 2).BorderColor(t.Border).Children(func() {
				for _, m := range msgs {
					a.message(c, m)
				}
			})
		}
	})
}

// runSummary 是折叠行的文字：「Worked for 7.0s · query_data · get_schema · 1 thought」，以及失败的调用数。
// 耗时是各工具报告的耗时之和；一个都没报告时只写「Worked」。
func (a *app) runSummary(msgs []conversation.Message) (string, int) {
	var total int64
	var names []string
	seen := map[string]bool{}
	thoughts, failed := 0, 0
	for _, m := range msgs {
		switch {
		case m.Role == "thinking":
			thoughts++
		case m.Tool != nil:
			total += m.Tool.DurationMS
			if m.Tool.Status == "error" {
				failed++
			}
			if !seen[m.Tool.Name] {
				seen[m.Tool.Name] = true
				names = append(names, m.Tool.Name)
			}
		}
	}
	parts := []string{a.tr("chat.worked")}
	if total > 0 {
		parts[0] = a.tr("chat.workedFor", "time", formatDuration(total))
	}
	const shown = 3
	for i, name := range names {
		if i == shown {
			parts = append(parts, a.tr("chat.moreTools", "count", strconv.Itoa(len(names)-shown)))
			break
		}
		parts = append(parts, name)
	}
	switch {
	case thoughts == 1:
		parts = append(parts, a.tr("chat.oneThought"))
	case thoughts > 1:
		parts = append(parts, a.tr("chat.thoughts", "count", strconv.Itoa(thoughts)))
	}
	return strings.Join(parts, " · "), failed
}
