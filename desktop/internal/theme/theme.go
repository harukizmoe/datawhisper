// Package theme 是桌面端的外观体系：配色（color scheme）是数据，不是代码。内置配色在 themes/*.json，用户配色放在
// <dataDir>/themes/*.json，两者是同一种格式（docs/refactor/ui-redesign.md §5.2）。
//
// 流程：外观偏好（模式、亮/暗配色 id、强调色、字体）+ 配色 JSON → Resolve → 一份 Resolved，里面有 MyGo 原生
// 控件的 ui.Theme、回答正文的 markdown.Theme、本应用自己的扩展 token，以及注入图表 web view 的 ChartTheme。
// 界面只经由它取颜色与字体，切换外观时整窗同步。
package theme

import (
	"embed"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"datawhisper/desktop/internal/prefs"
	"github.com/egoist/mygo/ui"
	"github.com/egoist/mygo/ui/editor"
	"github.com/egoist/mygo/ui/markdown"
)

//go:embed themes/*.json
var builtinThemeFiles embed.FS

// Scheme 是一份配色文件。palette 照抄上游的调色板名称，roles 把界面角色映射到调色板名称或 #hex。
type Scheme struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Family     string            `json:"family"`
	Appearance string            `json:"appearance"` // "light" 或 "dark"
	License    string            `json:"license,omitempty"`
	Source     string            `json:"source,omitempty"`
	Palette    map[string]string `json:"palette"`
	Accents    []string          `json:"accents,omitempty"`
	Roles      map[string]string `json:"roles"`
	Syntax     map[string]string `json:"syntax,omitempty"`
	Chart      []string          `json:"chart,omitempty"`
	// builtin 表示随应用分发；用户目录里同 id 的文件会覆盖它。
	builtin bool
}

// requiredRoles 是一份配色至少要给的角色，其余都能从它们推导。
var requiredRoles = []string{"background", "surface", "border", "text", "textMuted", "accent"}

// knownRoles 是 roles 里允许出现的键；拼错的键在解析时报错，而不是被静默忽略。
var knownRoles = map[string]bool{
	"background": true, "sidebar": true, "inspector": true,
	"surface": true, "surfaceHover": true, "surfacePressed": true,
	"border": true, "text": true, "textMuted": true,
	"accent": true, "accentHover": true, "accentPressed": true, "accentText": true,
	"link": true, "focus": true, "selection": true,
	"success": true, "warning": true, "danger": true,
	"inverse": true, "inverseText": true, "scrollbar": true,
	"userBubble": true, "codeBackground": true, "card": true, "cardBorder": true,
	"canvas": true,
}

// syntaxTokens 把配色文件里 syntax 的键映射到代码高亮的 token 种类。
var syntaxTokens = map[string]editor.TokenKind{
	"keyword":     editor.TokenKeyword,
	"type":        editor.TokenType,
	"function":    editor.TokenFunction,
	"variable":    editor.TokenVariable,
	"property":    editor.TokenProperty,
	"constant":    editor.TokenConstant,
	"number":      editor.TokenNumber,
	"string":      editor.TokenString,
	"escape":      editor.TokenEscape,
	"regexp":      editor.TokenRegexp,
	"comment":     editor.TokenComment,
	"operator":    editor.TokenOperator,
	"punctuation": editor.TokenPunctuation,
	"tag":         editor.TokenTag,
	"attribute":   editor.TokenAttribute,
	"meta":        editor.TokenMeta,
}

// parseScheme 解析并校验一份配色：所有引用都必须解析得到颜色，必需的角色必须存在。
func parseScheme(data []byte) (*Scheme, error) {
	var s Scheme
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	if !prefs.ValidSchemeID(s.ID) {
		return nil, fmt.Errorf("invalid scheme id %q", s.ID)
	}
	if s.Appearance != "light" && s.Appearance != "dark" {
		return nil, fmt.Errorf("scheme %s: appearance must be light or dark", s.ID)
	}
	if s.Name == "" {
		s.Name = s.ID
	}
	for name, value := range s.Palette {
		if _, ok := parseHexColor(value); !ok {
			return nil, fmt.Errorf("scheme %s: palette %s is not a #hex color: %q", s.ID, name, value)
		}
	}
	for _, role := range requiredRoles {
		if s.Roles[role] == "" {
			return nil, fmt.Errorf("scheme %s: missing role %s", s.ID, role)
		}
	}
	for role, ref := range s.Roles {
		if !knownRoles[role] {
			return nil, fmt.Errorf("scheme %s: unknown role %s", s.ID, role)
		}
		if _, ok := s.color(ref); !ok {
			return nil, fmt.Errorf("scheme %s: role %s refers to %q", s.ID, role, ref)
		}
	}
	for key, ref := range s.Syntax {
		if _, ok := syntaxTokens[key]; !ok {
			return nil, fmt.Errorf("scheme %s: unknown syntax token %s", s.ID, key)
		}
		if _, ok := s.color(ref); !ok {
			return nil, fmt.Errorf("scheme %s: syntax %s refers to %q", s.ID, key, ref)
		}
	}
	for _, ref := range s.Chart {
		if _, ok := s.color(ref); !ok {
			return nil, fmt.Errorf("scheme %s: chart color %q", s.ID, ref)
		}
	}
	for _, name := range s.Accents {
		if _, ok := s.Palette[name]; !ok {
			return nil, fmt.Errorf("scheme %s: accent %s is not in the palette", s.ID, name)
		}
	}
	return &s, nil
}

// color 解析一个颜色引用：调色板名称或 #hex，可带「/透明度」后缀，如 "overlay2/0.25"。
func (s *Scheme) color(ref string) (ui.Color, bool) {
	ref = strings.TrimSpace(ref)
	alpha := float32(1)
	if base, a, ok := strings.Cut(ref, "/"); ok {
		v, err := strconv.ParseFloat(strings.TrimSpace(a), 32)
		if err != nil || v < 0 || v > 1 {
			return ui.Color{}, false
		}
		ref, alpha = strings.TrimSpace(base), float32(v)
	}
	value := ref
	if !strings.HasPrefix(ref, "#") {
		v, ok := s.Palette[ref]
		if !ok {
			return ui.Color{}, false
		}
		value = v
	}
	c, ok := parseHexColor(value)
	if !ok {
		return ui.Color{}, false
	}
	if alpha < 1 {
		c = c.Alpha(alpha)
	}
	return c, true
}

// Color 解析一个颜色引用（调色板名称或 #hex，可带「/透明度」）；外观页用它画强调色色块。
func (s *Scheme) Color(ref string) (ui.Color, bool) { return s.color(ref) }

// role 返回一个角色的颜色；配色没给时返回 false，由调用方推导。
func (s *Scheme) role(name string) (ui.Color, bool) {
	ref, ok := s.Roles[name]
	if !ok {
		return ui.Color{}, false
	}
	return s.color(ref)
}

// parseHexColor 解析 #rgb、#rrggbb 与 #rrggbbaa。ui.Hex 遇到非法值会 panic，用户文件必须先经过这里。
func parseHexColor(s string) (ui.Color, bool) {
	if !strings.HasPrefix(s, "#") {
		return ui.Color{}, false
	}
	h := s[1:]
	if len(h) == 3 {
		h = string([]byte{h[0], h[0], h[1], h[1], h[2], h[2]})
	}
	if len(h) != 6 && len(h) != 8 {
		return ui.Color{}, false
	}
	v, err := strconv.ParseUint(h, 16, 32)
	if err != nil {
		return ui.Color{}, false
	}
	if len(h) == 6 {
		return ui.RGB(uint8(v>>16), uint8(v>>8), uint8(v)), true
	}
	return ui.RGBA(uint8(v>>24), uint8(v>>16), uint8(v>>8), float32(uint8(v))/255), true
}

// cssColor 把颜色写成 CSS 能读的 rgba()，给图表页面用。
func cssColor(c ui.Color) string {
	if c.A == 255 {
		return fmt.Sprintf("#%02x%02x%02x", c.R, c.G, c.B)
	}
	return fmt.Sprintf("rgba(%d,%d,%d,%.3f)", c.R, c.G, c.B, float32(c.A)/255)
}

// --- 配色目录 ---

var (
	builtinOnce    sync.Once
	builtinSchemes map[string]*Scheme
	builtinErr     error
)

// loadBuiltinSchemes 读随应用分发的配色。坏掉的内置配色是构建错误，由测试拦住。
func loadBuiltinSchemes() (map[string]*Scheme, error) {
	builtinOnce.Do(func() {
		builtinSchemes = map[string]*Scheme{}
		entries, err := builtinThemeFiles.ReadDir("themes")
		if err != nil {
			builtinErr = err
			return
		}
		for _, e := range entries {
			data, err := builtinThemeFiles.ReadFile("themes/" + e.Name())
			if err != nil {
				builtinErr = err
				return
			}
			s, err := parseScheme(data)
			if err != nil {
				builtinErr = fmt.Errorf("%s: %w", e.Name(), err)
				return
			}
			s.builtin = true
			builtinSchemes[s.ID] = s
		}
	})
	return builtinSchemes, builtinErr
}

// Catalog 是可选的全部配色：内置的，加上用户目录里的（同 id 时用户的优先）。
type Catalog struct {
	schemes map[string]*Scheme
	// Problems 是用户目录里读不了的文件及原因，外观设置页据此提示。
	Problems []string
}

// LoadCatalog 读内置配色与 dir 里的用户配色；dir 为空或不存在时只有内置配色。
func LoadCatalog(dir string) Catalog {
	cat := Catalog{schemes: map[string]*Scheme{}}
	builtin, err := loadBuiltinSchemes()
	if err != nil {
		cat.Problems = append(cat.Problems, "built-in themes: "+err.Error())
	}
	for id, s := range builtin {
		cat.schemes[id] = s
	}
	if dir == "" {
		return cat
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return cat
	}
	sort.Strings(files)
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			cat.Problems = append(cat.Problems, filepath.Base(file)+": "+err.Error())
			continue
		}
		s, err := parseScheme(data)
		if err != nil {
			cat.Problems = append(cat.Problems, filepath.Base(file)+": "+err.Error())
			continue
		}
		cat.schemes[s.ID] = s
	}
	return cat
}

// pick 返回 id 对应的配色；找不到或外观不符时退回同外观的默认配色。
func (cat Catalog) Pick(id string, dark bool) *Scheme {
	want := "light"
	fallback := prefs.DefaultLightScheme
	if dark {
		want, fallback = "dark", prefs.DefaultDarkScheme
	}
	if s, ok := cat.schemes[id]; ok && s.Appearance == want {
		return s
	}
	if s, ok := cat.schemes[fallback]; ok {
		return s
	}
	return nil
}

// List 返回某种外观（亮或暗）可选的全部配色：DataWhisper 自带的在前，其余按名字排序。
func (cat Catalog) List(dark bool) []*Scheme {
	want := "light"
	if dark {
		want = "dark"
	}
	var out []*Scheme
	for _, s := range cat.schemes {
		if s.Appearance == want {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		di, dj := out[i].Family == "datawhisper", out[j].Family == "datawhisper"
		if di != dj {
			return di
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

// Credits 返回内置配色的出处与许可证（关于对话框的第三方声明），每个家族一行，按名字排序。
func (cat Catalog) Credits() []string {
	names := map[string][]string{}
	lines := map[string]string{}
	for _, s := range cat.schemes {
		if !s.builtin || s.License == "" {
			continue
		}
		family := s.Family
		if family == "" {
			family = s.ID
		}
		names[family] = append(names[family], s.Name)
		lines[family] = s.License + ", " + s.Source
	}
	out := make([]string, 0, len(lines))
	for family, line := range lines {
		out = append(out, familyLabel(family, names[family])+": "+line)
	}
	sort.Strings(out)
	return out
}

// familyLabel 是配色家族的显示名：各变体名字按词的公共前缀（"Catppuccin Latte"、"Catppuccin Mocha" →
// "Catppuccin"）；没有公共前缀时（Dracula 与 Alucard）用家族 id。
func familyLabel(family string, names []string) string {
	if len(names) == 0 {
		return family
	}
	prefix := strings.Fields(names[0])
	for _, name := range names[1:] {
		words := strings.Fields(name)
		n := 0
		for n < len(prefix) && n < len(words) && prefix[n] == words[n] {
			n++
		}
		prefix = prefix[:n]
	}
	if len(prefix) == 0 {
		return family
	}
	return strings.Join(prefix, " ")
}

// UserDir 是数据目录里放用户配色的地方。
func UserDir(dataDir string) string {
	if dataDir == "" {
		return ""
	}
	return filepath.Join(dataDir, "themes")
}

// --- 字体 ---

// SystemMonospace 是系统等宽字体的通用名，MyGo 与 markdown 都认它。
const SystemMonospace = "monospace"

// Fonts 是解析后的字体：界面、buffer（代码、SQL、schema、数据表、工具输出）与回答正文各用哪个 family。
// 空的 UI family 表示系统 UI 字体。
type Fonts struct {
	UI, Buffer, Body                 string
	UISize, BufferSize               float32
	BufferLineHeight, BodyLineHeight float32
	// UIMissing、BufferMissing 记下用户选的字体没有装、已经回退到系统字体（设置页据此提示）。
	UIMissing, BufferMissing string
}

// ResolveFonts 把字体偏好对照系统已安装的字体：装了就用，没装就回退到系统字体（UI → 系统 UI 字体，
// buffer → 系统等宽字体）。字体不随安装包分发（ui-redesign.md §9）。
func ResolveFonts(ap prefs.Appearance, installed []ui.FontFamily) Fonts {
	have := func(family string) bool {
		for _, f := range installed {
			if strings.EqualFold(f.Name, family) {
				return true
			}
		}
		return false
	}
	fc := Fonts{
		UISize:           ap.UIFont.Size,
		BufferSize:       ap.BufferFont.Size,
		BufferLineHeight: ap.BufferFont.LineHeight,
		BodyLineHeight:   ap.BodyLineHeight,
		Buffer:           SystemMonospace,
	}
	if f := ap.UIFont.Family; f != "" {
		if have(f) {
			fc.UI = f
		} else {
			fc.UIMissing = f
		}
	}
	if f := ap.BufferFont.Family; f != "" {
		if have(f) {
			fc.Buffer = f
		} else {
			fc.BufferMissing = f
		}
	}
	fc.Body = fc.Buffer
	if ap.BodyFont == prefs.BodyFontUI {
		fc.Body = fc.UI
	}
	return fc
}

// --- 解析结果 ---

// Tokens 是 ui.Theme 之外、本应用自己用的颜色。
type Tokens struct {
	// Canvas 是 Islands 界面风格下各区域背后的窗口底色。
	Canvas             ui.Color
	Sidebar, Inspector ui.Color
	UserBubble         ui.Color
	CodeBackground     ui.Color
	Card, CardBorder   ui.Color
	Link               ui.Color
	Chart              []ui.Color
}

// ChartTheme 是注入图表 web view 的主题：页面里的脚本据此改 Plotly / ECharts 的配色与字体。
type ChartTheme struct {
	Dark       bool     `json:"dark"`
	Background string   `json:"background"`
	Text       string   `json:"text"`
	Muted      string   `json:"muted"`
	Grid       string   `json:"grid"`
	Font       string   `json:"font"`
	Colorway   []string `json:"colorway"`
}

// Resolved 是一帧用的全部外观。
type Resolved struct {
	UI     *ui.Theme
	MD     *markdown.Theme
	Tok    Tokens
	Chart  ChartTheme
	Fonts  Fonts
	Scheme *Scheme
}

// 对比度门槛（WCAG AA）：正文 4.5:1，次要文字与占位符 3:1。
const (
	minTextContrast  = 4.5
	minMutedContrast = 3.0
)

// Resolve 由配色、强调色与字体推导出一帧的全部外观。纯函数：同样的输入给同样的输出，便于测试。
// scheme 为 nil（内置配色都坏了）时退回 MyGo 自带的主题，保证界面仍然能画出来。
func Resolve(scheme *Scheme, dark bool, accent string, fonts Fonts) *Resolved {
	base := ui.LightTheme()
	if dark {
		base = ui.DarkTheme()
	}
	t := *base
	if scheme == nil {
		scheme = &Scheme{ID: "mygo", Appearance: map[bool]string{true: "dark", false: "light"}[dark]}
	}
	get := func(role string, fallback ui.Color) ui.Color {
		if c, ok := scheme.role(role); ok {
			return c
		}
		return fallback
	}
	t.Dark = scheme.Appearance == "dark"
	t.Background = get("background", t.Background)
	t.Text = get("text", t.Text)
	t.TextMuted = get("textMuted", t.TextMuted)
	t.Surface = get("surface", t.Surface)
	t.SurfaceHover = get("surfaceHover", t.Surface.Mix(t.Text, 0.06))
	t.SurfacePressed = get("surfacePressed", t.Surface.Mix(t.Text, 0.12))
	t.Border = get("border", t.Border)
	t.Success = get("success", t.Success)
	t.Warning = get("warning", t.Warning)
	t.Danger = get("danger", t.Danger)

	// 强调色：用户的选择优先（调色板名称或 #hex），否则用配色自带的。
	t.Accent = get("accent", t.Accent)
	if accent != "" {
		if c, ok := scheme.color(accent); ok {
			t.Accent = c
		}
	}
	// 强调色的悬停与按下色：暗色往亮里走，亮色往暗里走。用户换了强调色时不用配色里写死的这两项。
	shift := ui.RGB(0, 0, 0)
	if t.Dark {
		shift = ui.RGB(255, 255, 255)
	}
	t.AccentHover = t.Accent.Mix(shift, 0.12)
	t.AccentPressed = t.Accent.Mix(shift, 0.24)
	if accent == "" {
		t.AccentHover = get("accentHover", t.AccentHover)
		t.AccentPressed = get("accentPressed", t.AccentPressed)
	}
	t.AccentText = readableOn(t.Accent, t.Background, t.Text)
	if accent == "" {
		if c, ok := scheme.role("accentText"); ok && contrast(c, t.Accent) >= minTextContrast {
			t.AccentText = c
		}
	}
	t.Focus = t.Accent.Alpha(0.6)
	t.Selection = t.Accent.Alpha(0.3)
	if accent == "" {
		t.Focus = get("focus", t.Focus)
		t.Selection = get("selection", t.Selection)
	}
	t.Inverse = get("inverse", t.Text)
	t.InverseText = get("inverseText", t.Background)
	t.Scrollbar = get("scrollbar", t.TextMuted.Alpha(0.35))

	// 对比度护栏：只调亮度、不改色相；配色本身不动，只调作为文字使用的角色。
	t.Text = ensureContrast(t.Text, t.Background, minTextContrast)
	t.TextMuted = ensureContrast(t.TextMuted, t.Background, minMutedContrast)

	t.Font = fonts.UI
	if fonts.UISize > 0 {
		t.FontSize = fonts.UISize
	}

	tok := Tokens{
		Sidebar:        get("sidebar", t.Background.Mix(t.Text, 0.03)),
		UserBubble:     get("userBubble", t.Surface),
		CodeBackground: get("codeBackground", t.Background.Mix(t.Text, 0.04)),
		Link:           get("link", t.Accent),
	}
	tok.Inspector = get("inspector", tok.Sidebar)
	tok.Card = get("card", tok.CodeBackground)
	tok.CardBorder = get("cardBorder", t.Border)
	// 窗口底色比内容区深一档（暗色往黑里压，亮色往文字色里混一点），岛才浮得起来。
	canvas := t.Background.Mix(t.Text, 0.07)
	if t.Dark {
		canvas = t.Background.Mix(ui.RGB(0, 0, 0), 0.35)
	}
	tok.Canvas = get("canvas", canvas)
	// 有的配色没有比侧栏更深的中性色（Nord、Solarized Dark），canvas 与侧栏或内容区同色时岛会融进底色：
	// 再压深一档，配色本身不动。
	if tok.Canvas == tok.Sidebar || tok.Canvas == t.Background {
		if t.Dark {
			tok.Canvas = tok.Sidebar.Mix(ui.RGB(0, 0, 0), 0.3)
		} else {
			tok.Canvas = tok.Sidebar.Mix(t.Text, 0.08)
		}
	}
	if accent != "" {
		tok.Link = t.Accent
	}
	tok.Link = ensureContrast(tok.Link, t.Background, minTextContrast)
	for _, ref := range scheme.Chart {
		if c, ok := scheme.color(ref); ok {
			tok.Chart = append(tok.Chart, c)
		}
	}
	if len(tok.Chart) == 0 {
		tok.Chart = []ui.Color{t.Accent, t.Success, t.Warning, t.Danger}
	}

	md := &markdown.Theme{
		Font:                fonts.Body,
		CodeFont:            fonts.Buffer,
		FontSize:            fonts.UISize,
		LineHeight:          fonts.BodyLineHeight,
		CodeLineHeight:      fonts.BufferLineHeight,
		Text:                t.Text,
		Muted:               t.TextMuted,
		Link:                tok.Link,
		CodeBackground:      tok.CodeBackground,
		CodeBlockBackground: tok.CodeBackground,
		CodeBlockBorder:     tok.CardBorder,
		TableBorder:         t.Border,
		TableHeader:         tok.CodeBackground,
		QuoteBar:            t.Border,
		Rule:                t.Border,
		CodeColors:          syntaxTheme(scheme, &t, tok),
	}
	if fonts.UISize > 0 && fonts.BufferSize > 0 {
		md.CodeSize = fonts.BufferSize / fonts.UISize
	}

	grid := t.Border
	chart := ChartTheme{
		Dark:       t.Dark,
		Background: "rgba(0,0,0,0)",
		Text:       cssColor(t.Text),
		Muted:      cssColor(t.TextMuted),
		Grid:       cssColor(grid),
		Font:       cssFontStack(fonts.UI),
	}
	for _, c := range tok.Chart {
		chart.Colorway = append(chart.Colorway, cssColor(c))
	}
	return &Resolved{UI: &t, MD: md, Tok: tok, Chart: chart, Fonts: fonts, Scheme: scheme}
}

// Metrics 把密度与圆角的选项换成 ui.Theme 的 Spacing 与 Radius（MyGo 的默认值是 4 与 6）。
// 陌生取值按标准处理。
func Metrics(density, radius string) (spacing, corner float32) {
	spacing, corner = 4, 6
	switch density {
	case prefs.DensityCompact:
		spacing = 3
	case prefs.DensityComfortable:
		spacing = 5
	}
	switch radius {
	case prefs.RadiusSquare:
		corner = 2
	case prefs.RadiusRound:
		corner = 10
	}
	return spacing, corner
}

// syntaxTheme 用配色的 syntax 表给代码高亮上色；配色没给时用 MyGo 按窗口主题挑的默认高亮。
func syntaxTheme(scheme *Scheme, t *ui.Theme, tok Tokens) *editor.Theme {
	et := editor.DefaultTheme(t)
	et.Background = tok.CodeBackground
	et.Text = t.Text
	et.Selection = t.Selection
	for key, ref := range scheme.Syntax {
		kind, ok := syntaxTokens[key]
		if !ok {
			continue
		}
		if c, ok := scheme.color(ref); ok {
			et.Tokens[kind].Color = c
			if key == "comment" {
				et.Tokens[kind].Italic = true
			}
		}
	}
	return et
}

// cssFontStack 给图表页面一个字体栈：选的字体在前，系统字体兜底。
func cssFontStack(family string) string {
	if family == "" {
		return "system-ui, sans-serif"
	}
	return strconv.Quote(family) + ", system-ui, sans-serif"
}

// --- 对比度 ---

// relativeLuminance 是 WCAG 2 的相对亮度。
func relativeLuminance(c ui.Color) float64 {
	lin := func(v uint8) float64 {
		s := float64(v) / 255
		if s <= 0.04045 {
			return s / 12.92
		}
		return math.Pow((s+0.055)/1.055, 2.4)
	}
	return 0.2126*lin(c.R) + 0.7152*lin(c.G) + 0.0722*lin(c.B)
}

// contrast 是两个不透明颜色的对比度（1–21）。
func contrast(a, b ui.Color) float64 {
	la, lb := relativeLuminance(a), relativeLuminance(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

// ensureContrast 让 fg 在 bg 上达到 min 的对比度：向白（暗底）或黑（亮底）逐步混合，色相不变。
func ensureContrast(fg, bg ui.Color, min float64) ui.Color {
	solid := fg.Over(bg)
	if contrast(solid, bg) >= min {
		return fg
	}
	toward := ui.RGB(0, 0, 0)
	if relativeLuminance(bg) < 0.5 {
		toward = ui.RGB(255, 255, 255)
	}
	for step := float32(0.05); step <= 1; step += 0.05 {
		c := solid.Mix(toward, step)
		if contrast(c, bg) >= min {
			return c
		}
	}
	return toward
}

// readableOn 在 candidates 与黑白之间挑出在 bg 上对比度最高的颜色，作为 bg 上的文字色。
func readableOn(bg ui.Color, candidates ...ui.Color) ui.Color {
	best, bestRatio := ui.RGB(255, 255, 255), contrast(ui.RGB(255, 255, 255), bg)
	for _, c := range append(candidates, ui.RGB(0, 0, 0)) {
		c = c.Over(bg)
		if r := contrast(c, bg); r > bestRatio {
			best, bestRatio = c, r
		}
	}
	return best
}
