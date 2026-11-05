package theme

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"datawhisper/desktop/internal/prefs"
	"github.com/egoist/mygo/ui"
)

// TestBuiltinSchemesParse 保证随应用分发的配色都能解析，亮暗默认配色都在。
func TestBuiltinSchemesParse(t *testing.T) {
	schemes, err := loadBuiltinSchemes()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{prefs.DefaultLightScheme, prefs.DefaultDarkScheme} {
		s, ok := schemes[id]
		if !ok {
			t.Fatalf("no built-in scheme %s", id)
		}
		if !s.builtin {
			t.Errorf("%s is not marked built-in", id)
		}
	}
	if schemes[prefs.DefaultDarkScheme].Appearance != "dark" || schemes[prefs.DefaultLightScheme].Appearance != "light" {
		t.Error("default schemes have the wrong appearance")
	}
}

// TestResolvedThemesAreReadable 检查对比度护栏：每个内置配色、配上任何一个强调色，正文与次要文字都过 WCAG AA。
func TestResolvedThemesAreReadable(t *testing.T) {
	schemes, err := loadBuiltinSchemes()
	if err != nil {
		t.Fatal(err)
	}
	for id, s := range schemes {
		accents := append([]string{"", "#ffff00", "#000080"}, s.Accents...)
		for _, accent := range accents {
			rt := Resolve(s, s.Appearance == "dark", accent, Fonts{})
			th := rt.UI
			if th.Dark != (s.Appearance == "dark") {
				t.Errorf("%s: Dark is %v", id, th.Dark)
			}
			if r := contrast(th.Text, th.Background); r < minTextContrast {
				t.Errorf("%s accent %q: text contrast %.2f", id, accent, r)
			}
			if r := contrast(th.TextMuted.Over(th.Background), th.Background); r < minMutedContrast {
				t.Errorf("%s accent %q: muted contrast %.2f", id, accent, r)
			}
			if r := contrast(th.AccentText, th.Accent); r < minTextContrast {
				t.Errorf("%s accent %q: text on accent %.2f", id, accent, r)
			}
			if r := contrast(rt.Tok.Link, th.Background); r < minTextContrast {
				t.Errorf("%s accent %q: link contrast %.2f", id, accent, r)
			}
			if len(rt.Chart.Colorway) == 0 || rt.MD.CodeColors == nil {
				t.Errorf("%s: no chart colors or code colors", id)
			}
		}
	}
}

func TestEnsureContrastFixesUnreadableText(t *testing.T) {
	bg := ui.RGB(28, 29, 36)
	fg := ui.RGB(40, 40, 50) // 暗底上的暗字
	fixed := ensureContrast(fg, bg, minTextContrast)
	if contrast(fixed, bg) < minTextContrast {
		t.Errorf("still unreadable: %v on %v", fixed, bg)
	}
	ok := ui.RGB(230, 230, 230)
	if ensureContrast(ok, bg, minTextContrast) != ok {
		t.Error("a readable color was changed")
	}
}

func TestSchemeColorReferences(t *testing.T) {
	s := &Scheme{Palette: map[string]string{"blue": "#3366d6", "short": "#abc"}}
	if c, ok := s.color("blue"); !ok || c != ui.RGB(0x33, 0x66, 0xd6) {
		t.Errorf("blue = %v %v", c, ok)
	}
	if c, ok := s.color("blue/0.5"); !ok || c.A < 127 || c.A > 128 {
		t.Errorf("blue/0.5 = %v %v", c, ok)
	}
	if c, ok := s.color("short"); !ok || c != ui.RGB(0xaa, 0xbb, 0xcc) {
		t.Errorf("#abc = %v %v", c, ok)
	}
	for _, bad := range []string{"nope", "#12", "#gggggg", "blue/2", "blue/x", ""} {
		if _, ok := s.color(bad); ok {
			t.Errorf("%q resolved", bad)
		}
	}
}

func TestParseSchemeRejectsBrokenFiles(t *testing.T) {
	valid := map[string]any{
		"id": "x", "appearance": "dark",
		"palette": map[string]string{"bg": "#000000", "fg": "#ffffff", "a": "#3366d6"},
		"roles": map[string]string{
			"background": "bg", "surface": "bg", "border": "fg/0.1",
			"text": "fg", "textMuted": "fg/0.7", "accent": "a",
		},
	}
	encode := func(m map[string]any) []byte { data, _ := json.Marshal(m); return data }
	if _, err := parseScheme(encode(valid)); err != nil {
		t.Fatalf("valid scheme: %v", err)
	}
	cases := map[string]func(m map[string]any){
		"bad id":                func(m map[string]any) { m["id"] = "Bad Id" },
		"bad appearance":        func(m map[string]any) { m["appearance"] = "dim" },
		"bad palette":           func(m map[string]any) { m["palette"] = map[string]string{"bg": "black"} },
		"missing role":          func(m map[string]any) { m["roles"] = map[string]string{"background": "bg"} },
		"dangling role":         func(m map[string]any) { m["roles"].(map[string]string)["accent"] = "nope" },
		"unknown role":          func(m map[string]any) { m["roles"].(map[string]string)["bakground"] = "bg" },
		"unknown syntax":        func(m map[string]any) { m["syntax"] = map[string]string{"keywrd": "a"} },
		"accent not in palette": func(m map[string]any) { m["accents"] = []string{"red"} },
	}
	for name, mutate := range cases {
		m := map[string]any{}
		data := encode(valid)
		_ = json.Unmarshal(data, &m)
		// 重新取强类型的 roles，便于修改。
		roles := map[string]string{}
		for k, v := range m["roles"].(map[string]any) {
			roles[k] = v.(string)
		}
		m["roles"] = roles
		mutate(m)
		if _, err := parseScheme(encode(m)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// TestUserSchemesOverrideAndFallBack 验证用户目录：同 id 覆盖内置配色，坏文件被跳过并记下原因，
// 找不到的 id 与外观不符的 id 都退回默认配色。
func TestUserSchemesOverrideAndFallBack(t *testing.T) {
	dir := t.TempDir()
	custom := `{"id":"forest","name":"Forest","appearance":"dark",
	  "palette":{"bg":"#10201a","fg":"#e0f0e8","green":"#2f9e6e"},
	  "roles":{"background":"bg","surface":"bg","border":"fg/0.1","text":"fg","textMuted":"fg/0.7","accent":"green"}}`
	if err := os.WriteFile(filepath.Join(dir, "forest.json"), []byte(custom), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken.json"), []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	cat := LoadCatalog(dir)
	if len(cat.Problems) != 1 || !strings.Contains(cat.Problems[0], "broken.json") {
		t.Errorf("Problems %q", cat.Problems)
	}
	if s := cat.Pick("forest", true); s == nil || s.ID != "forest" {
		t.Errorf("forest picked %v", s)
	}
	if s := cat.Pick("forest", false); s == nil || s.ID != prefs.DefaultLightScheme {
		t.Errorf("a dark scheme in light mode gave %v", s)
	}
	if s := cat.Pick("missing", true); s == nil || s.ID != prefs.DefaultDarkScheme {
		t.Errorf("missing id gave %v", s)
	}
	rt := Resolve(cat.Pick("forest", true), true, "", Fonts{})
	if rt.UI.Accent != ui.RGB(0x2f, 0x9e, 0x6e) {
		t.Errorf("accent %v", rt.UI.Accent)
	}
	// 用户选了调色板里的颜色当强调色。
	rt = Resolve(cat.Pick("forest", true), true, "fg", Fonts{})
	if rt.UI.Accent != ui.RGB(0xe0, 0xf0, 0xe8) {
		t.Errorf("palette accent %v", rt.UI.Accent)
	}
}

// TestFontsFallBackToSystem 验证字体回退：装了就用，没装时 UI 回到系统 UI 字体、buffer 回到系统等宽字体；
// 回答正文默认跟 buffer 字体。
func TestFontsFallBackToSystem(t *testing.T) {
	ap := prefs.DefaultAppearance()
	installed := []ui.FontFamily{{Name: "maple mono nf cn", Monospaced: true}}
	fc := ResolveFonts(ap, installed)
	if fc.UI != "maple mono nf cn" && fc.UI != prefs.DefaultFontFamily {
		t.Errorf("installed UI font not used: %q", fc.UI)
	}
	if fc.Body != fc.Buffer || fc.UIMissing != "" || fc.BufferMissing != "" {
		t.Errorf("fonts %+v", fc)
	}

	fc = ResolveFonts(ap, nil)
	if fc.UI != "" || fc.Buffer != SystemMonospace {
		t.Errorf("fallback fonts %+v", fc)
	}
	if fc.UIMissing != prefs.DefaultFontFamily || fc.BufferMissing != prefs.DefaultFontFamily {
		t.Errorf("missing fonts not reported: %+v", fc)
	}

	ap.BodyFont = prefs.BodyFontUI
	ap.UIFont.Family = ""
	fc = ResolveFonts(ap, nil)
	if fc.Body != "" || fc.UIMissing != "" {
		t.Errorf("body follows the system UI font: %+v", fc)
	}
}
