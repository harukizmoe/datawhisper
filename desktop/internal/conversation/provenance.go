package conversation

// 数字出处：回答里的数据类数字来自哪次工具调用。规则与服务端的质量闸门一致（server/src/agent/number-audit.ts）：
// 百分比、带量级后缀的值（万、亿、倍）、范围、年份、小于 100 的整数与小于 3 的小数都不算数据类数字；一个数字
// 写在工具结果里（去掉千分位后原样出现、数值相等、按回答里的小数位四舍五入后相等，或是两个结果数字的和差）
// 就算有出处。用户写下的数字与 agent 写进工具参数的数字（SQL 阈值）也算有出处，但不归到某次工具调用。
// 服务端在模型回答之后审计并要求修正；界面这里只是把同样的判断展示给人看。

import (
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

// EvidenceTools 是会产出数据的工具；一轮里有它们成功返回，回答才需要核对数字出处。与服务端
// NUMBER_EVIDENCE_TOOLS 保持同步。
var EvidenceTools = map[string]bool{
	"query_data":             true,
	"run_analysis":           true,
	"create_analysis_table":  true,
	"profile_data":           true,
	"fetch_table":            true,
	"browser_extract_tables": true,
	"generate_chart":         true,
}

var (
	rangeRE  = regexp.MustCompile(`\d[\d.,]*\s*[-–—~～]\s*\d[\d.,]*`)
	numberRE = regexp.MustCompile(`\p{Nd}{1,3}(?:,\p{Nd}{3})+(?:\.\p{Nd}+)?|\p{Nd}+(?:\.\p{Nd}+)?`)
	yearRE   = regexp.MustCompile(`^(19|20)\d{2}$`)
)

// skipSuffixes 是紧跟在数字后面、说明它不是数据原值的字符。
const skipSuffixes = "%％‰万亿倍"

// maxEvidenceChars 是每段证据读取的上限，与服务端一致。
const maxEvidenceChars = 60000

// dec 是精确的非负十进制数：值 = n / 10^scale，规范形式不带末尾的小数零。
type dec struct {
	n     *big.Int
	scale int
}

func (d dec) key() string { return d.n.String() + "e" + strconv.Itoa(d.scale) }

func canonical(n *big.Int, scale int) dec {
	n = new(big.Int).Set(n)
	ten := big.NewInt(10)
	r := new(big.Int)
	for scale > 0 {
		q, m := new(big.Int).QuoRem(n, ten, r)
		if m.Sign() != 0 {
			break
		}
		n, scale = q, scale-1
	}
	return dec{n, scale}
}

func pow10(n int) *big.Int { return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil) }

func (d dec) rat() *big.Rat { return new(big.Rat).SetFrac(d.n, pow10(d.scale)) }

// asciiDigits 把全角数字（０-９）换成 ASCII，与服务端 NFKC 之后只读 ASCII 数字的行为一致；其他文种的数字
// 保持原样，随后解析失败而被忽略。
func asciiDigits(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= '０' && r <= '９' {
			return '0' + (r - '０')
		}
		return r
	}, s)
}

// parseDec 解析一个数字记号，返回值与原样书写的小数位数（"1500.00" 为 2 位）。
func parseDec(raw string) (dec, int, bool) {
	cleaned := asciiDigits(strings.ReplaceAll(raw, ",", ""))
	whole, frac, _ := strings.Cut(cleaned, ".")
	if whole == "" || strings.Trim(whole+frac, "0123456789") != "" {
		return dec{}, 0, false
	}
	n, ok := new(big.Int).SetString(whole+frac, 10)
	if !ok {
		return dec{}, 0, false
	}
	return canonical(n, len(frac)), len(frac), true
}

// quantize 是 ROUND_HALF_UP 地保留 decimals 位小数。
func quantize(d dec, decimals int) dec {
	if d.scale <= decimals {
		return canonical(new(big.Int).Mul(d.n, pow10(decimals-d.scale)), decimals)
	}
	div := pow10(d.scale - decimals)
	q, r := new(big.Int).QuoRem(d.n, div, new(big.Int))
	if new(big.Int).Mul(r, big.NewInt(2)).Cmp(div) >= 0 {
		q.Add(q, big.NewInt(1))
	}
	return canonical(q, decimals)
}

// numberTokens 找出文本里的数字记号，以及紧跟其后的几个字符（判断百分号、万亿这类后缀）。前面紧挨字母、
// 数字、下划线、点或中点的记号是标识符的一部分（PM2.5、v1.3），跳过。
func numberTokens(text string) (raws, tails []string) {
	for _, loc := range numberRE.FindAllStringIndex(text, -1) {
		if loc[0] > 0 {
			prev := text[:loc[0]]
			r := []rune(prev)
			last := r[len(r)-1]
			if last == '_' || last == '.' || last == '·' || ('a' <= last && last <= 'z') || ('A' <= last && last <= 'Z') || ('0' <= last && last <= '9') {
				continue
			}
		}
		raws = append(raws, text[loc[0]:loc[1]])
		tail := strings.TrimLeft(text[loc[1]:min(loc[1]+8, len(text))], " \t")
		tails = append(tails, tail)
	}
	return raws, tails
}

// reportNumber 是回答里的一个数据类数字。
type reportNumber struct {
	key      string // 去掉千分位的原文
	value    dec
	decimals int
}

var (
	minInt     = big.NewInt(100)
	minDecimal = big.NewRat(3, 1)
)

// reportNumbers 挑出回答里需要出处的数字，按首次出现去重。
func reportNumbers(text string) []reportNumber {
	masked := rangeRE.ReplaceAllString(text, " ")
	raws, tails := numberTokens(masked)
	seen := map[string]bool{}
	var out []reportNumber
	for i, raw := range raws {
		if tail := []rune(tails[i]); len(tail) > 0 && strings.ContainsRune(skipSuffixes, tail[0]) {
			continue
		}
		value, decimals, ok := parseDec(raw)
		if !ok {
			continue
		}
		if decimals == 0 {
			if value.n.Cmp(minInt) < 0 || yearRE.MatchString(asciiDigits(strings.ReplaceAll(raw, ",", ""))) {
				continue
			}
		} else if value.rat().Cmp(minDecimal) < 0 {
			continue
		}
		key := strings.ReplaceAll(raw, ",", "")
		if !seen[key] {
			seen[key] = true
			out = append(out, reportNumber{key, value, decimals})
		}
	}
	return out
}

// corpus 是一段证据：去掉千分位的全文，以及其中的全部数值。
type corpus struct {
	blob   string
	values map[string]dec
}

func newCorpus(texts ...string) corpus {
	c := corpus{values: map[string]dec{}}
	var parts []string
	for _, t := range texts {
		if t == "" {
			continue
		}
		if len(t) > maxEvidenceChars {
			t = t[:maxEvidenceChars]
		}
		parts = append(parts, strings.ReplaceAll(t, ",", ""))
		raws, _ := numberTokens(t)
		for _, raw := range raws {
			if v, _, ok := parseDec(raw); ok {
				c.values[v.key()] = v
			}
		}
	}
	c.blob = strings.Join(parts, " ")
	return c
}

// supports 报告这段证据能不能支撑数字 n：原样出现、数值相等、按 n 的小数位四舍五入后相等，或（整数）是两个
// 不小于 100 的证据数字的和或差。
func (c corpus) supports(n reportNumber) bool {
	if strings.Contains(c.blob, n.key) {
		return true
	}
	target := n.value.key()
	if _, ok := c.values[target]; ok {
		return true
	}
	for _, v := range c.values {
		if quantize(v, n.decimals).key() == target {
			return true
		}
	}
	if n.decimals != 0 {
		return false
	}
	x := n.value.rat()
	hundred := big.NewRat(100, 1)
	for _, a := range c.values {
		ar := a.rat()
		if ar.Cmp(hundred) < 0 {
			continue
		}
		for _, partner := range []*big.Rat{new(big.Rat).Sub(x, ar), new(big.Rat).Sub(ar, x)} {
			if partner.Cmp(hundred) < 0 {
				continue
			}
			for _, b := range c.values {
				if b.rat().Cmp(partner) == 0 {
					return true
				}
			}
		}
	}
	return false
}

// Provenance 是一段回答的数字出处。
type Provenance struct {
	// Sources 是给回答提供了数字的工具调用：消息下标与它支撑的数字（按回答里的顺序）。
	Sources []NumberSource
	// Unsupported 是在工具结果、用户消息和工具参数里都找不到出处的数字。
	Unsupported []string
	// Checked 是核对过的数据类数字个数。
	Checked int
}

// NumberSource 是一次工具调用支撑的数字。
type NumberSource struct {
	Index   int // 工具调用在消息列表里的下标
	Tool    string
	Numbers []string
}

// ProvenanceOf 核对 messages[answer]（一条已完成的回答）里的数字出处。证据是它之前的全部工具结果；越近的
// 工具调用优先认领一个数字。回答所在的这一轮没有成功的数据类工具调用时返回 false：服务端也不审计这样的回答。
func ProvenanceOf(messages []Message, answer int) (Provenance, bool) {
	if answer < 0 || answer >= len(messages) || messages[answer].Role != "assistant" {
		return Provenance{}, false
	}
	evidenceTurn := false
	for i := answer - 1; i >= 0 && messages[i].Role != "user"; i-- {
		if t := messages[i].Tool; t != nil && t.Status == "ok" && EvidenceTools[t.Name] {
			evidenceTurn = true
		}
	}
	if !evidenceTurn {
		return Provenance{}, false
	}
	numbers := reportNumbers(messages[answer].Text)
	var p Provenance
	p.Checked = len(numbers)
	if len(numbers) == 0 {
		return p, true
	}
	var tools []int
	var context []string
	for i := 0; i < answer; i++ {
		m := messages[i]
		switch {
		case m.Role == "user":
			context = append(context, m.Text)
		case m.Tool != nil && m.Tool.Output != "":
			tools = append(tools, i)
			context = append(context, m.Tool.Args)
		}
	}
	corpora := make(map[int]corpus, len(tools))
	var outputs []string
	for _, i := range tools {
		corpora[i] = newCorpus(messages[i].Tool.Output)
		outputs = append(outputs, messages[i].Tool.Output)
	}
	// 有没有出处用全部证据一起判断（与服务端相同：和差可以跨两次工具调用）；归到哪次调用逐个查，只用于展示。
	all := newCorpus(append(outputs, context...)...)
	bySource := map[int]int{} // 消息下标 → p.Sources 里的位置
	for _, n := range numbers {
		claimed := false
		for k := len(tools) - 1; k >= 0; k-- {
			i := tools[k]
			if !corpora[i].supports(n) {
				continue
			}
			at, ok := bySource[i]
			if !ok {
				at = len(p.Sources)
				bySource[i] = at
				p.Sources = append(p.Sources, NumberSource{Index: i, Tool: messages[i].Tool.Name})
			}
			p.Sources[at].Numbers = append(p.Sources[at].Numbers, n.key)
			claimed = true
			break
		}
		if !claimed && !all.supports(n) {
			p.Unsupported = append(p.Unsupported, n.key)
		}
	}
	return p, true
}

// unsupportedNumbers 是服务端 auditReportNumbers 的对应物（不截断）：回答里在证据与上下文中都找不到出处的数字。
// 只给测试拿 golden 用例核对与服务端一致。
func unsupportedNumbers(report string, evidence, context []string) []string {
	all := newCorpus(append(append([]string(nil), evidence...), context...)...)
	var out []string
	for _, n := range reportNumbers(report) {
		if !all.supports(n) {
			out = append(out, n.key)
		}
	}
	return out
}
