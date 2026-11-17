package app

import "testing"

// 没有任何可用模型时，首页给出直达设置区的引导；点按钮进入设置页的模型分区。
func TestFirstRunCardWhenNoModel(t *testing.T) {
	_, q, a, tt := readyApp(t, 1280, 900)
	a.cv.models = nil
	a.cv.modelsLoaded = true
	tt.Frame()
	expectTexts(t, tt, []string{"Connect a model to get started", "Set up models"}, nil)

	if err := tt.Click("Set up models"); err != nil {
		t.Fatal(err)
	}
	if a.nav != navSettings {
		t.Errorf("nav %q, want settings", a.nav)
	}
	q.pump(t, tt, "the settings page", func() bool { return a.st.loaded })
}
