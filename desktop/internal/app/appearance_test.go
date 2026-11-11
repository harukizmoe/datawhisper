package app

import (
	"path/filepath"
	"strings"
	"testing"

	"datawhisper/desktop/internal/conversation"
	"datawhisper/desktop/internal/prefs"
	"github.com/egoist/mygo/ui"
)

// TestSystemAppearanceIsFollowed 验证跟随系统：窗口报告的亮暗变化后，下一帧换成对应的配色。
func TestSystemAppearanceIsFollowed(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	a.prefs = prefs.Default()
	tt := ui.NewTester(a.view, 1180, 760)
	tt.SetDark(true)
	tt.Frame()
	if got, want := pixelAt(tt, 10, 300), a.themeFor(true).Tok.Sidebar; got != want {
		t.Errorf("dark system drew the sidebar %v, want %v", got, want)
	}
	tt.SetDark(false)
	tt.Frame()
	tt.Frame()
	if got, want := pixelAt(tt, 10, 300), a.themeFor(false).Tok.Sidebar; got != want {
		t.Errorf("light system drew the sidebar %v, want %v", got, want)
	}
}

// openAppearance 打开设置页的「外观」分区。
func openAppearance(t *testing.T, tt *ui.Tester) {
	t.Helper()
	if err := tt.Click("Settings"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("Appearance"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
}

// TestAppearancePageChangesTheLook 走一遍外观页：换暗色配色、点强调色色块、切到 Islands，改动立即生效并写进
// ui.json；「恢复默认外观」全部退回默认。
func TestAppearancePageChangesTheLook(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	a.prefs = prefs.Default()
	a.prefs.Theme = prefs.ThemeDark
	a.prefsPath = filepath.Join(t.TempDir(), "ui.json")
	// 外观页较长：窗口给足高度，底部的「恢复默认外观」不用滚动就能点到。
	tt := ui.NewTester(a.view, 1280, 1800)
	openAppearance(t, tt)

	// 暗色配色：从下拉里选 Catppuccin Mocha。
	if err := tt.Click("DataWhisper Dark"); err != nil {
		t.Fatal(err)
	}
	if err := tt.Click("Catppuccin Mocha"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if got := a.appearance().DarkScheme; got != "catppuccin-mocha" {
		t.Fatalf("dark scheme %q", got)
	}
	if got := a.tokens().Scheme.ID; got != "catppuccin-mocha" {
		t.Errorf("the frame uses %q", got)
	}

	// 强调色：Mocha 调色板里的 peach。
	if err := tt.Click("peach"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	peach, _ := a.tokens().Scheme.Color("peach")
	if a.appearance().Accent != "peach" || a.tokens().UI.Accent != peach {
		t.Errorf("accent %q, color %v", a.appearance().Accent, a.tokens().UI.Accent)
	}

	// Islands：窗口边缘露出的是 canvas 底色。
	if err := tt.Click("Islands"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if got, want := pixelAt(tt, 2, 400), a.tokens().Tok.Canvas; got != want {
		t.Errorf("window edge %v, want the canvas %v", got, want)
	}
	saved := prefs.Load(a.prefsPath).Appearance
	if saved.DarkScheme != "catppuccin-mocha" || saved.Accent != "peach" || saved.Layout != prefs.LayoutIslands {
		t.Errorf("saved %+v", saved)
	}

	if err := tt.Click("Reset appearance"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.appearance() != prefs.DefaultAppearance() {
		t.Errorf("reset left %+v", a.appearance())
	}
}

// TestBuiltinSchemesAreListed 断言外观页的配色下拉列出了内置的开源配色，且按亮暗分开。
func TestBuiltinSchemesAreListed(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	var light, dark []string
	for _, s := range a.schemes().List(false) {
		light = append(light, s.ID)
	}
	for _, s := range a.schemes().List(true) {
		dark = append(dark, s.ID)
	}
	if len(light) == 0 || light[0] != prefs.DefaultLightScheme || dark[0] != prefs.DefaultDarkScheme {
		t.Errorf("the default schemes are not first: %v / %v", light, dark)
	}
	for _, id := range []string{"catppuccin-latte", "alucard", "solarized-light", "rose-pine-dawn"} {
		if !hasString(light, id) {
			t.Errorf("%s missing from the light list %v", id, light)
		}
	}
	for _, id := range []string{"catppuccin-mocha", "dracula", "nord", "tokyonight-night", "gruvbox-dark"} {
		if !hasString(dark, id) {
			t.Errorf("%s missing from the dark list %v", id, dark)
		}
	}
	credits := strings.Join(a.schemes().Credits(), "\n")
	for _, want := range []string{"Catppuccin: MIT", "Tokyo Night: Apache-2.0", "Solarized: MIT"} {
		if !strings.Contains(credits, want) {
			t.Errorf("credits lack %q:\n%s", want, credits)
		}
	}
}

// TestBufferFontSizeReachesAnswerText 回归：回答正文默认用 buffer 字体，它的字号也得跟着 buffer 字号走；
// 改了 buffer 字号后回到已有对话，正文要变大。正文改用界面字体时，则只跟界面字号。
func TestBufferFontSizeReachesAnswerText(t *testing.T) {
	answerHeight := func(bodyFont string, change func(ap *prefs.Appearance)) float32 {
		q := newQueue()
		a := newTestApp(t, q)
		a.prefs = prefs.Default()
		a.prefs.Appearance.BodyFont = bodyFont
		a.chat.Messages = []conversation.Message{
			{Key: "e1", Role: "user", Text: "question", Done: true},
			{Key: "e2", Role: "assistant", Text: "Plain answer text", Done: true},
		}
		tt := ui.NewTester(a.view, 1180, 900)
		tt.Frame()
		a.setAppearance(change)
		tt.Frame()
		r, ok := tt.Find("Plain answer text")
		if !ok {
			t.Fatal("the answer is not shown")
		}
		return r.H
	}
	baseline := answerHeight(prefs.BodyFontBuffer, func(*prefs.Appearance) {})
	if got := answerHeight(prefs.BodyFontBuffer, func(ap *prefs.Appearance) { ap.BufferFont.Size += 2 }); got <= baseline {
		t.Errorf("a larger buffer font left the answer at %v (was %v)", got, baseline)
	}
	baselineUI := answerHeight(prefs.BodyFontUI, func(*prefs.Appearance) {})
	if got := answerHeight(prefs.BodyFontUI, func(ap *prefs.Appearance) { ap.BufferFont.Size += 2 }); got != baselineUI {
		t.Errorf("the buffer font size changed an answer set in the interface font: %v vs %v", got, baselineUI)
	}
	if got := answerHeight(prefs.BodyFontUI, func(ap *prefs.Appearance) { ap.UIFont.Size += 3 }); got <= baselineUI {
		t.Errorf("a larger interface font left the answer at %v (was %v)", got, baselineUI)
	}
}
