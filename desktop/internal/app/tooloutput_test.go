package app

import (
	"strings"
	"testing"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/prefs"
	"github.com/egoist/mygo/ui"
)

const pandasTable = "region  order_cnt  total_amount\n" +
	"  east          5       50000.0\n" +
	" north          2        1200.5\n" +
	"New York        1         300.0"

// TestClassifyOutput 断言工具输出的形态判断：pandas 的文本表转成 Markdown 表格（数字列右对齐，截断提示单独成行），
// 带标题或表格的是 Markdown，其余（说明文字、单行错误、只有项目符号的清单）仍是纯文本。
func TestClassifyOutput(t *testing.T) {
	kind, md := classifyOutput(pandasTable)
	if kind != outputTable {
		t.Fatalf("kind %v for a pandas table", kind)
	}
	want := "| region | order_cnt | total_amount |\n" +
		"| --- | ---: | ---: |\n" +
		"| east | 5 | 50000.0 |\n" +
		"| north | 2 | 1200.5 |\n" +
		"| New York | 1 | 300.0 |\n"
	if md != want {
		t.Errorf("markdown\n%s\nwant\n%s", md, want)
	}

	_, md = classifyOutput(pandasTable + "\n\n... showing 50 of 120 rows")
	if !strings.HasSuffix(md, "\n_... showing 50 of 120 rows_\n") {
		t.Errorf("the truncation note is lost: %q", md)
	}

	for name, out := range map[string]string{
		"one-line error":    "SQL Error: column  x does not exist",
		"empty result":      "Query returned no results.",
		"bullets only":      "- first\n- second",
		"ragged columns":    "a  b\nc  d  e",
		"prose paragraph":   "The tool finished.\nNothing else to report.",
		"single wide space": "name  value",
	} {
		if kind, _ := classifyOutput(out); kind != outputText {
			t.Errorf("%s: classified as %v", name, kind)
		}
	}

	report := "### Data profile · `orders`\n\n| col | type |\n|---|---|\n| id | int |"
	if kind, md := classifyOutput(report); kind != outputMarkdown || md != report {
		t.Errorf("a markdown report: kind %v, text %q", kind, md)
	}
	if kind, _ := classifyOutput("```sql\nselect 1\n```"); kind != outputMarkdown {
		t.Errorf("a fenced block: kind %v", kind)
	}
	if got := sqlBlock("select '```' as fence"); !strings.HasPrefix(got, "````sql\n") || !strings.HasSuffix(got, "\n````") {
		t.Errorf("a fence inside the SQL needs a longer fence: %q", got)
	}
}

// TestToolCardRendersSQLAndTables 断言 query_data 卡片：SQL 画成带语言标签的代码块、结果文本表画成表格单元格、
// 参数摘要里不再重复 sql；同样的输出在「展开」之外的方式下也按主题渲染。
func TestToolCardRendersSQLAndTables(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	a.prefs = prefs.Default()
	a.prefs.Appearance.FoldRuns = false
	a.prefs.Appearance.ToolOutput = prefs.OutputExpanded
	a.chat.Messages = []conversation.Message{
		{Key: "u", Role: "user", Text: "orders by region", Done: true},
		{Key: "t", Role: "tool", Done: true, Tool: &conversation.ToolCall{
			Name: "query_data", SQL: "select region, count(*) from orders group by 1", Args: "limit=10",
			Output: pandasTable, Status: "ok", DurationMS: 12,
		}},
	}
	tt := ui.NewTester(a.view, 1180, 1000)
	expectTexts(t, tt, []string{"sql", "Copy code", "limit=10", "region", "order_cnt", "total_amount", "east", "50000.0", "New York", "Done"},
		[]string{"sql=select"})
}
