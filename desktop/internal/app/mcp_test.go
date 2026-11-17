package app

import "testing"

// 「集成 → MCP 服务器」：列表显示状态与工具数；编辑保存时不重发密钥；连接测试结果显示工具数。
func TestMcpSettingsSection(t *testing.T) {
	fs, q, a, tt := readyApp(t, 1280, 900)
	if err := tt.Click("Settings"); err != nil {
		t.Fatal(err)
	}
	a.st.tab = settingsTabIntegrations
	q.pump(t, tt, "the MCP list", func() bool { return a.mcp.loaded && len(a.mcp.servers) == 1 })
	expectTexts(t, tt, []string{"MCP servers", "GitHub", "github", "Connected", "7 tools", "npx -y server-github"}, nil)

	a.openMcpEditor(&a.mcp.servers[0])
	tt.Frame()
	expectTexts(t, tt, []string{"Edit MCP server", "GITHUB_TOKEN"}, nil)
	a.mcp.form.label = "GitHub Enterprise"
	a.saveMcp()
	q.pump(t, tt, "mcp.upsert", func() bool { return len(fs.callsTo("mcp.upsert")) > 0 })
	sent, _ := fs.callsTo("mcp.upsert")[0]["server"].(map[string]any)
	if sent["label"] != "GitHub Enterprise" {
		t.Errorf("label not sent: %v", sent)
	}
	// 密钥留空表示沿用：env/headers 字段必须缺席，否则服务端会删掉已保存的密钥。
	if _, present := sent["env"]; present {
		t.Error("an empty env map was sent instead of keeping the saved secrets")
	}
	if a.mcp.open {
		t.Error("the editor stayed open after a successful save")
	}

	a.openMcpEditor(&a.mcp.servers[0])
	a.testMcp()
	q.pump(t, tt, "the MCP test result", func() bool { return a.mcp.testMsg != "" })
	if a.mcp.testMsg != "Connected; 2 tools available." {
		t.Errorf("test message %q", a.mcp.testMsg)
	}
}
