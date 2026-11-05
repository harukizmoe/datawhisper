package app

// P4 与命令面板的用例：侧栏分组与会话管理、正文搜索、知识库、技能、飞书集成，以及 Ctrl+K。

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// readyApp 启动假服务并等会话列表加载完。
func readyApp(t *testing.T, w, h int) (*fakeService, *uiQueue, *app, *ui.Tester) {
	t.Helper()
	fs := newFakeService(t)
	q := newQueue()
	a := &app{post: q.post}
	a.theme.fontFamily = func() []ui.FontFamily { return nil }
	tt := ui.NewTester(a.view, w, h)
	a.onService(fs.ready(41))
	q.pump(t, tt, "the session list", func() bool { return a.listLoaded })
	return fs, q, a, tt
}

// TestSidebarGroupsAndSessionActions 断言侧栏按置顶 / 更早分组、已归档的单独一节；右键菜单能置顶、删除（先确认）。
func TestSidebarGroupsAndSessionActions(t *testing.T) {
	fs, q, a, tt := readyApp(t, 1180, 900)
	expectTexts(t, tt, []string{"Pinned", "Greeting", "Earlier", "Workspace check", "Archived", "Old analysis"}, nil)

	if err := tt.RightClick("Workspace check"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Pin"); err != nil {
		t.Fatalf("%v; menu %q", err, tt.Menu())
	}
	q.pump(t, tt, "session.pin", func() bool { return len(fs.callsTo("session.pin")) > 0 })
	if got := fs.callsTo("session.pin")[0]; got["id"] != float64(4) || got["pinned"] != true {
		t.Errorf("session.pin params %v", got)
	}

	if err := tt.RightClick("Greeting"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Delete"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !a.sess.deleteOpen || a.sess.deleteID != 2 {
		t.Fatalf("no delete confirmation: %+v", a.sess)
	}
	expectTexts(t, tt, []string{"Delete “Greeting”?"}, nil)
	if len(fs.callsTo("session.delete")) != 0 {
		t.Fatal("deleted before confirming")
	}
	a.deleteSession(2) // 确认框里的「Delete」：AlertDialog 的按钮在测试里直接调用动作
	q.pump(t, tt, "session.delete", func() bool { return len(fs.callsTo("session.delete")) > 0 })
}

// TestSidebarSearch 断言搜索框即时按标题过滤，停顿后再按正文搜索，正文命中的会话单独列出。
func TestSidebarSearch(t *testing.T) {
	fs, q, a, tt := readyApp(t, 1180, 900)
	a.sideSearch = "check"
	tt.Frame()
	expectTexts(t, tt, []string{"Workspace check"}, []string{"Greeting", "Getting started"})

	a.sideSearch = "revenue"
	tt.Frame()
	tt.Advance(searchDelay + 50*time.Millisecond)
	q.pump(t, tt, "session.search", func() bool { return len(fs.callsTo("session.search")) > 0 && len(a.sess.hits) > 0 })
	if got := fs.callsTo("session.search")[0]; got["query"] != "revenue" {
		t.Errorf("session.search params %v", got)
	}
	expectTexts(t, tt, []string{"Found in messages", "Greeting"}, nil)
}

// TestKnowledgePage 断言知识库页列出分类与当前分类的指标，新增一条指标写进当前分类。
func TestKnowledgePage(t *testing.T) {
	fs, q, a, tt := readyApp(t, 1280, 900)
	if err := tt.Click("Knowledge"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the metrics", func() bool { return len(a.know.items) > 0 })
	expectTexts(t, tt, []string{"Sales", "GMV", "gross sales · Sum of order amounts"}, nil)

	a.openKnowledgeEditor("metric", nil)
	a.know.editValues["name"] = "AOV"
	a.know.editValues["definition"] = "GMV / orders"
	a.saveKnowledge()
	q.pump(t, tt, "knowledge.add", func() bool { return len(fs.callsTo("knowledge.add")) > 0 })
	got := fs.callsTo("knowledge.add")[0]
	record, _ := got["record"].(map[string]any)
	if got["kind"] != "metric" || got["categoryId"] != float64(1) || record["name"] != "AOV" || record["definition"] != "GMV / orders" {
		t.Errorf("knowledge.add params %v", got)
	}

	// 名称必填。
	a.openKnowledgeEditor("metric", nil)
	a.saveKnowledge()
	if a.know.editErr == "" {
		t.Error("saving a metric without a name was allowed")
	}
}

// TestSkillsPage 断言技能页列出技能与读不了的技能文件，并能按关键词过滤。
func TestSkillsPage(t *testing.T) {
	_, q, a, tt := readyApp(t, 1280, 900)
	if err := tt.Click("Skills"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the skills", func() bool { return a.skills.loaded })
	expectTexts(t, tt, []string{"Cohort analysis", "Retention by signup cohort", "retention", "broken.md: no front matter"}, nil)
	a.skills.query = "nothing like this"
	tt.Frame()
	expectTexts(t, tt, nil, []string{"Cohort analysis"})
}

// TestFeishuSettings 断言「集成」分区显示连接状态并用已保存的配置填表；保存时留空的密钥不发送（沿用原值）。
func TestFeishuSettings(t *testing.T) {
	fs, q, a, tt := readyApp(t, 1280, 900)
	if err := tt.Click("Settings"); err != nil {
		t.Fatal(err)
	}
	a.st.tab = settingsTabIntegrations
	q.pump(t, tt, "the Feishu status", func() bool { return a.feishu.loaded })
	if a.feishu.appID != "cli_a1" || a.feishu.receiveID != "oc_1" || !a.feishu.enabled {
		t.Errorf("form %+v", a.feishu)
	}
	a.saveFeishu()
	q.pump(t, tt, "feishu.setConfig", func() bool { return len(fs.callsTo("feishu.setConfig")) > 0 })
	got := fs.callsTo("feishu.setConfig")[0]
	if got["app_id"] != "cli_a1" || got["receive_id"] != "oc_1" || got["inbound_transport"] != "long_connection" {
		t.Errorf("feishu.setConfig params %v", got)
	}
	if _, sent := got["app_secret"]; sent {
		t.Error("an empty secret was sent instead of keeping the stored one")
	}
}

// TestCommandPalette 断言 Ctrl+K 打开命令面板，输入过滤结果，Enter 执行第一项。
func TestCommandPalette(t *testing.T) {
	_, q, a, tt := readyApp(t, 1180, 900)
	tt.Key(primaryMod, ui.KeyK)
	tt.Frame()
	if !a.palette.open {
		t.Fatal("Ctrl+K did not open the palette")
	}
	a.palette.query = "greet"
	tt.Frame()
	items := a.paletteItems()
	if len(items) != 1 || items[0].label != "Greeting" {
		t.Fatalf("filtered items %+v", items)
	}
	a.runPaletteItem(items[0])
	q.pump(t, tt, "conversation 2", func() bool { return a.conv == 2 })
	if a.palette.open {
		t.Error("the palette stayed open")
	}
}
