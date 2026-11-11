package icons

import "testing"

// TestIconsParse 确认每个登记的图标都解析成功（坏掉的 SVG 会在包初始化时 panic，这里再显式检查一遍非空）。
func TestIconsParse(t *testing.T) {
	for name, svg := range map[string]any{"Plus": Plus, "Send": Send, "Stop": Stop, "Settings": Settings} {
		if svg == nil {
			t.Errorf("%s is nil", name)
		}
	}
}
