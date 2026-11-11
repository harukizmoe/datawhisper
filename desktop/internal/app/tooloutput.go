package app

// 工具输出的主题渲染：query_data 的结果是 pandas 的定宽文本表，分析与概况类工具的结果是 Markdown，
// SQL 是调用参数。三者都交给 markdown.View 画（表格、标题、代码块用回答正文同一套主题），
// 认不出的输出仍是等宽纯文本。

import (
	"regexp"
	"strings"

	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/markdown"
)

// outputKind 是工具输出的形态。
type outputKind int

const (
	outputText     outputKind = iota // 纯文本：等宽显示
	outputMarkdown                   // Markdown（标题、表格、代码块）
	outputTable                      // pandas 的定宽文本表，转成 Markdown 表格显示
)

var (
	// 列之间至少两个空格：pandas 的 to_string 总是这样分列，而单元格内的单个空格（"New York"）不会被拆开。
	columnGap = regexp.MustCompile(`\s{2,}`)
	// 「... showing 50 of 120 rows」是 format_result 在截断结果后追加的一行。
	rowsTrailer = regexp.MustCompile(`^\.\.\. showing \d+ of \d+ rows$`)
	numberCell  = regexp.MustCompile(`^[-+]?[\d,]*\.?\d+(?:[eE][-+]?\d+)?%?$`)
	// Markdown 的可靠记号：行首的 # 标题、表格分隔行、代码围栏。只有项目符号或星号不算，纯文本输出里也常见。
	markdownSigns = regexp.MustCompile(`(?m)^(?:#{1,6} \S|\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$|` + "```" + `)`)
)

// classifyOutput 判断输出是哪一种形态，并给出要交给 markdown.View 的正文（纯文本时为空）。
func classifyOutput(output string) (outputKind, string) {
	if markdownSigns.MatchString(output) {
		return outputMarkdown, output
	}
	if md, ok := fixedTableMarkdown(output); ok {
		return outputTable, md
	}
	return outputText, ""
}

// fixedTableMarkdown 把 pandas 的定宽文本表转成 Markdown 表格。每一行都要分出与表头相同的列数（至少两列），
// 否则认为这不是表（比如一段说明文字），交回纯文本显示。
func fixedTableMarkdown(output string) (string, bool) {
	lines := strings.Split(strings.TrimRight(output, "\n "), "\n")
	var trailer string
	if n := len(lines); n >= 2 && rowsTrailer.MatchString(strings.TrimSpace(lines[n-1])) {
		trailer = strings.TrimSpace(lines[n-1])
		lines = lines[:n-1]
		for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
			lines = lines[:len(lines)-1]
		}
	}
	if len(lines) < 2 {
		return "", false
	}
	rows := make([][]string, len(lines))
	for i, line := range lines {
		rows[i] = columnGap.Split(strings.TrimSpace(line), -1)
		if len(rows[i]) < 2 || len(rows[i]) != len(rows[0]) {
			return "", false
		}
	}
	cols := len(rows[0])
	cell := func(s string) string { return strings.ReplaceAll(s, "|", `\|`) }
	var b strings.Builder
	writeRow := func(cells []string) {
		b.WriteString("|")
		for _, s := range cells {
			b.WriteString(" " + cell(s) + " |")
		}
		b.WriteString("\n")
	}
	writeRow(rows[0])
	b.WriteString("|")
	for c := range cols {
		numeric := true
		for _, row := range rows[1:] {
			if !numberCell.MatchString(row[c]) {
				numeric = false
				break
			}
		}
		if numeric {
			b.WriteString(" ---: |")
		} else {
			b.WriteString(" --- |")
		}
	}
	b.WriteString("\n")
	for _, row := range rows[1:] {
		writeRow(row)
	}
	if trailer != "" {
		b.WriteString("\n_" + trailer + "_\n")
	}
	return b.String(), true
}

// sqlBlock 是 SQL 的 Markdown 围栏代码块；SQL 里本身有围栏时用更长的围栏。
func sqlBlock(sql string) string {
	fence := "```"
	for strings.Contains(sql, fence) {
		fence += "`"
	}
	return fence + "sql\n" + sql + "\n" + fence
}

// richText 用回答正文的 Markdown 主题画一段文字。
func (a *app) richText(c *ui.Context, md string) {
	markdown.View(c, md, &a.md)
}
