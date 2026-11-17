package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

// 新对话里直接添加附件：先按首页选择创建一条会话，再走三段式导入；不支持的扩展名当场拒绝。
func TestAttachFromNewChatCreatesConversationAndImports(t *testing.T) {
	f := newSourceFake(t)
	q := newQueue()
	a := newTestApp(t, q)
	tt := ui.NewTester(a.view, 1400, 1100)
	a.onService(f.ready(61))
	tt.Frame()

	dir := t.TempDir()
	path := filepath.Join(dir, "orders.csv")
	if err := os.WriteFile(path, []byte("id,total\n1,10\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.attachPaths([]string{path, filepath.Join(dir, "notes.txt")})
	if !strings.Contains(a.src.uploadErr, "notes.txt") {
		t.Errorf("unsupported file not reported: %q", a.src.uploadErr)
	}
	q.pump(t, tt, "the attachment import", func() bool {
		return f.call("conversation.create") != nil && f.call("source.upload.begin") != nil && !a.src.uploading
	})
	if a.conv == 0 {
		t.Fatal("no conversation was created for the attachment")
	}
	begin := f.call("source.upload.begin")
	if begin["conversationId"] != float64(a.conv) || begin["filename"] != "orders.csv" {
		t.Errorf("source.upload.begin params: %v", begin)
	}
	// 不支持的扩展名不能混进上传队列。
	if methods := f.methods(); countMethod(methods, "source.upload.begin") != 1 {
		t.Errorf("unexpected uploads: %v", methods)
	}
}
