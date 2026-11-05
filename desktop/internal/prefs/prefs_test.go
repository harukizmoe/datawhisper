package prefs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"datawhisper/desktop/internal/i18n"
)

func TestPrefsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := Path(dir)
	if path != filepath.Join(dir, "ui.json") {
		t.Fatalf("prefs path %q", path)
	}
	if prefs := Load(path); prefs != Default() {
		t.Errorf("missing file gave %+v, want the defaults", prefs)
	}

	want := Prefs{Theme: ThemeDark, Language: i18n.ZH, Appearance: DefaultAppearance()}
	want.Appearance.Accent = "peach"
	want.Appearance.BufferFont.Family = "JetBrains Mono"
	want.Appearance.BodyFont = BodyFontUI
	if err := Save(path, want); err != nil {
		t.Fatal(err)
	}
	if got := Load(path); got != want {
		t.Errorf("reloaded %+v, want %+v", got, want)
	}
	// 原子写：目录里只剩 ui.json，没有临时文件。
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "ui.json" {
		t.Errorf("directory holds %v, want only ui.json", entries)
	}

	// 坏文件与陌生取值都退回默认值。
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := Load(path); got != Default() {
		t.Errorf("broken file gave %+v, want the defaults", got)
	}
	if err := os.WriteFile(path, []byte(`{"theme":"neon","language":"fr"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := Load(path); got != Default() {
		t.Errorf("unknown values gave %+v, want the defaults", got)
	}
	// 没有数据目录时不持久化，也不报错。
	if err := Save("", want); err != nil {
		t.Errorf("saving without a path: %v", err)
	}
}

func TestNormalizeAppearance(t *testing.T) {
	def := DefaultAppearance()
	bad := Appearance{
		LightScheme: "../etc/passwd", DarkScheme: "",
		Accent:     "#zzzzzz",
		UIFont:     Font{Family: strings.Repeat("x", 200), Size: 99, LineHeight: 3},
		BufferFont: Font{Family: "  JetBrains Mono  ", Size: 2, LineHeight: 9},
		BodyFont:   "serif", BodyLineHeight: 0.1,
	}
	got := NormalizeAppearance(bad)
	if got.LightScheme != def.LightScheme || got.DarkScheme != def.DarkScheme || got.Accent != "" {
		t.Errorf("schemes/accent %+v", got)
	}
	if got.UIFont != def.UIFont {
		t.Errorf("ui font %+v", got.UIFont)
	}
	if got.BufferFont.Family != "JetBrains Mono" || got.BufferFont.Size != def.BufferFont.Size || got.BufferFont.LineHeight != def.BufferFont.LineHeight {
		t.Errorf("buffer font %+v", got.BufferFont)
	}
	if got.BodyFont != def.BodyFont || got.BodyLineHeight != def.BodyLineHeight || got.Version != AppearanceVersion {
		t.Errorf("body %+v", got)
	}
}

// TestOldPrefsFileGetsDefaultAppearance 保证只有 theme 与 language 的旧 ui.json 升级后得到默认外观。
func TestOldPrefsFileGetsDefaultAppearance(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ui.json")
	if err := os.WriteFile(path, []byte(`{"theme":"dark","language":"en"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got := Load(path)
	if got.Theme != ThemeDark || got.Appearance != DefaultAppearance() {
		t.Errorf("upgraded %+v", got)
	}
	// 只改了一项的文件，其余保持默认。
	if err := os.WriteFile(path, []byte(`{"theme":"light","appearance":{"uiFont":{"size":16}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got = Load(path)
	want := DefaultAppearance()
	want.UIFont.Size = 16
	if got.Appearance != want {
		t.Errorf("partial appearance %+v, want %+v", got.Appearance, want)
	}
}

// TestLayoutChoicesFallBack 断言界面风格、密度、圆角与对话宽度只接受已知取值，其余退回默认。
func TestLayoutChoicesFallBack(t *testing.T) {
	in := DefaultAppearance()
	in.Layout, in.Density, in.Radius, in.ChatWidth = LayoutIslands, DensityCompact, RadiusRound, ChatWidthFull
	if got := NormalizeAppearance(in); got != in {
		t.Errorf("valid choices changed: %+v", got)
	}
	in.Layout, in.Density, in.Radius, in.ChatWidth = "floating", "tiny", "blob", "huge"
	got := NormalizeAppearance(in)
	def := DefaultAppearance()
	if got.Layout != def.Layout || got.Density != def.Density || got.Radius != def.Radius || got.ChatWidth != def.ChatWidth {
		t.Errorf("invalid choices kept: %+v", got)
	}
}
