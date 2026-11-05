package app

import (
	"testing"

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
