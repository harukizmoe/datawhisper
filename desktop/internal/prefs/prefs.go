// Package prefs 是桌面端界面外壳的偏好：外观模式（深色/浅色/跟随系统）、配色与字体（appearance），
// 以及界面语言。它们存在数据目录的 ui.json 里，与服务的设置分开：服务只管模型、数据源这些它自己懂的东西。
package prefs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"datawhisper/desktop/internal/i18n"
)

const (
	ThemeSystem = "system"
	ThemeLight  = "light"
	ThemeDark   = "dark"
)

// Prefs 是 ui.json 的内容。取值都经过校验：坏掉的文件或陌生的取值退回默认值，不让界面卡在无效状态。
type Prefs struct {
	Theme      string     `json:"theme"`    // ThemeSystem、ThemeLight 或 ThemeDark
	Language   string     `json:"language"` // i18n.System、i18n.EN 或 i18n.ZH
	Appearance Appearance `json:"appearance"`
}

// AppearanceVersion 是 appearance 对象的格式版本；以后改格式时据此迁移旧文件。
const AppearanceVersion = 1

// 字体的默认值与取值范围。默认字体不随安装包分发：没装时 resolveFonts 回退到系统字体。
const (
	DefaultFontFamily       = "Maple Mono NF CN"
	DefaultUIFontSize       = 14
	DefaultBufferSize       = 13
	DefaultBufferLineHeight = 1.5
	DefaultBodyLineHeight   = 1.7
	minUIFontSize           = 12
	maxUIFontSize           = 18
	minBufferFontSize       = 11
	maxBufferFontSize       = 18
	minLineHeight           = 1.2
	maxLineHeight           = 2.0
	minBodyLineHeight       = 1.4
	maxFontFamilyLength     = 128
	BodyFontBuffer          = "buffer"
	BodyFontUI              = "ui"
	DefaultLightScheme      = "datawhisper-light"
	DefaultDarkScheme       = "datawhisper-dark"
)

// Font 是一种字体的选择：family 为空表示用系统字体。
type Font struct {
	Family     string  `json:"family"`
	Size       float32 `json:"size"`
	LineHeight float32 `json:"lineHeight,omitempty"`
}

// Appearance 是外观的种子值：亮/暗各用哪套配色、强调色，以及 UI 字体、buffer 字体与回答正文的字体。
// 其余颜色与尺寸都由 theme.Resolve 从这里推导（internal/theme）。
type Appearance struct {
	Version     int    `json:"version"`
	LightScheme string `json:"lightScheme"`
	DarkScheme  string `json:"darkScheme"`
	// Accent 为空表示用配色自带的强调色；调色板里的名称（如 "peach"）在亮/暗配色里各取同名色；#hex 是固定颜色。
	Accent     string `json:"accent"`
	UIFont     Font   `json:"uiFont"`
	BufferFont Font   `json:"bufferFont"`
	// BodyFont 决定回答正文跟哪种字体：BodyFontBuffer（默认）或 BodyFontUI。
	BodyFont       string  `json:"bodyFont"`
	BodyLineHeight float32 `json:"bodyLineHeight"`
	// Layout 是界面风格：LayoutCompact（各区域直接相接，用分隔线隔开）或 LayoutIslands（各区域是浮在
	// 窗口底色上的圆角岛）。
	Layout string `json:"layout"`
	// Density 决定控件内外的留白（ui.Theme.Spacing），Radius 决定控件的圆角，ChatWidth 决定对话列的最大宽度。
	Density   string `json:"density"`
	Radius    string `json:"radius"`
	ChatWidth string `json:"chatWidth"`
}

// 界面风格、密度、圆角与对话宽度的取值。
const (
	LayoutCompact = "compact"
	LayoutIslands = "islands"

	DensityCompact     = "compact"
	DensityStandard    = "standard"
	DensityComfortable = "comfortable"

	RadiusSquare   = "square"
	RadiusStandard = "standard"
	RadiusRound    = "round"

	ChatWidthNarrow   = "narrow"
	ChatWidthStandard = "standard"
	ChatWidthWide     = "wide"
	ChatWidthFull     = "full"
)

// Layouts、Densities、Radii 与 ChatWidths 是各项的全部取值，设置页按这个顺序列出。
var (
	Layouts    = []string{LayoutCompact, LayoutIslands}
	Densities  = []string{DensityCompact, DensityStandard, DensityComfortable}
	Radii      = []string{RadiusSquare, RadiusStandard, RadiusRound}
	ChatWidths = []string{ChatWidthNarrow, ChatWidthStandard, ChatWidthWide, ChatWidthFull}
)

func oneOf(v string, list []string) bool {
	for _, x := range list {
		if v == x {
			return true
		}
	}
	return false
}

func DefaultAppearance() Appearance {
	return Appearance{
		Version:        AppearanceVersion,
		LightScheme:    DefaultLightScheme,
		DarkScheme:     DefaultDarkScheme,
		UIFont:         Font{Family: DefaultFontFamily, Size: DefaultUIFontSize},
		BufferFont:     Font{Family: DefaultFontFamily, Size: DefaultBufferSize, LineHeight: DefaultBufferLineHeight},
		BodyFont:       BodyFontBuffer,
		BodyLineHeight: DefaultBodyLineHeight,
		Layout:         LayoutCompact,
		Density:        DensityStandard,
		Radius:         RadiusStandard,
		ChatWidth:      ChatWidthStandard,
	}
}

// Default 是第一次启动时的选择：跟随系统。
func Default() Prefs {
	return Prefs{Theme: ThemeSystem, Language: i18n.System, Appearance: DefaultAppearance()}
}

// NormalizeAppearance 逐项校验外观偏好：非法或越界的项退回默认值，其余照用户的选择。
// 配色 id 是否真的存在由 internal/theme 的配色目录判断（用户主题目录可能还没加载）。
func NormalizeAppearance(in Appearance) Appearance {
	def := DefaultAppearance()
	out := in
	out.Version = AppearanceVersion
	if !ValidSchemeID(out.LightScheme) {
		out.LightScheme = def.LightScheme
	}
	if !ValidSchemeID(out.DarkScheme) {
		out.DarkScheme = def.DarkScheme
	}
	if !validAccent(out.Accent) {
		out.Accent = ""
	}
	out.UIFont = normalizeFont(out.UIFont, def.UIFont, minUIFontSize, maxUIFontSize)
	out.UIFont.LineHeight = 0
	out.BufferFont = normalizeFont(out.BufferFont, def.BufferFont, minBufferFontSize, maxBufferFontSize)
	if out.BufferFont.LineHeight < minLineHeight || out.BufferFont.LineHeight > maxLineHeight {
		out.BufferFont.LineHeight = def.BufferFont.LineHeight
	}
	if out.BodyFont != BodyFontBuffer && out.BodyFont != BodyFontUI {
		out.BodyFont = def.BodyFont
	}
	if out.BodyLineHeight < minBodyLineHeight || out.BodyLineHeight > maxLineHeight {
		out.BodyLineHeight = def.BodyLineHeight
	}
	if !oneOf(out.Layout, Layouts) {
		out.Layout = def.Layout
	}
	if !oneOf(out.Density, Densities) {
		out.Density = def.Density
	}
	if !oneOf(out.Radius, Radii) {
		out.Radius = def.Radius
	}
	if !oneOf(out.ChatWidth, ChatWidths) {
		out.ChatWidth = def.ChatWidth
	}
	return out
}

// normalizeFont 校验一种字体：family 去掉首尾空白，过长时退回默认；字号越界时退回默认。
// family 为空是合法的，表示用系统字体。
func normalizeFont(in, def Font, minSize, maxSize float32) Font {
	out := in
	out.Family = strings.TrimSpace(out.Family)
	if len(out.Family) > maxFontFamilyLength {
		out.Family = def.Family
	}
	if out.Size < minSize || out.Size > maxSize {
		out.Size = def.Size
	}
	return out
}

// ValidSchemeID 只接受小写字母、数字与连字符：配色 id 同时是用户主题目录里的文件名。
func ValidSchemeID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// hexColorRE 是 #rgb、#rrggbb 或 #rrggbbaa。
var hexColorRE = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)

// validAccent 接受空串、调色板名称（规则同配色 id）或 #hex。
func validAccent(s string) bool {
	if s == "" {
		return true
	}
	if strings.HasPrefix(s, "#") {
		return hexColorRE.MatchString(s)
	}
	return ValidSchemeID(s)
}

func ValidTheme(s string) bool {
	switch s {
	case ThemeSystem, ThemeLight, ThemeDark:
		return true
	}
	return false
}

// Path 返回数据目录里的偏好文件路径；没有数据目录时返回空串（不持久化）。
func Path(dataDir string) string {
	if dataDir == "" {
		return ""
	}
	return filepath.Join(dataDir, "ui.json")
}

// Load 读偏好文件。文件不存在、读不了或不是合法的 JSON 时返回默认值：偏好只是界面的方便，
// 不该挡住启动。
func Load(path string) Prefs {
	prefs := Default()
	if path == "" {
		return prefs
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return prefs
	}
	// 在默认值之上解码：旧文件没有 appearance 或缺了某些字段时，缺的项保持默认。
	stored := Default()
	stored.Theme, stored.Language = "", ""
	if err := json.Unmarshal(data, &stored); err != nil {
		return prefs
	}
	prefs.Appearance = NormalizeAppearance(stored.Appearance)
	if ValidTheme(stored.Theme) {
		prefs.Theme = stored.Theme
	}
	if i18n.Valid(stored.Language) {
		prefs.Language = stored.Language
	}
	return prefs
}

// Save 原子地写偏好：同目录临时文件写完后 rename，中途退出不会留下半个 JSON。
func Save(path string, prefs Prefs) error {
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(prefs, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	f, err := os.CreateTemp(filepath.Dir(path), ".ui-*.json")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	// 先落盘再改名，断电后也不会出现一个空的 ui.json。
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, 0o644); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
