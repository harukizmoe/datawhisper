package app

// 输入区附件：把拖进来或选中的数据文件导入当前对话（没有对话时先按首页选择创建一条）。

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo"
)

// attachmentExts 与导入对话框的过滤器一致：其它文件服务端也会拒绝，这里先挡一次给出明确提示。
var attachmentExts = map[string]bool{".csv": true, ".xlsx": true, ".xls": true, ".pdf": true}

// attachPaths 接收本地文件路径：先把不支持的挑出来，再排队走现有的三段式导入。
func (a *app) attachPaths(paths []string) {
	if a.client == nil || len(paths) == 0 {
		return
	}
	var accepted, rejected []string
	for _, path := range paths {
		if attachmentExts[strings.ToLower(filepath.Ext(path))] {
			accepted = append(accepted, path)
		} else {
			rejected = append(rejected, filepath.Base(path))
		}
	}
	if len(rejected) > 0 {
		a.src.uploadErr = a.tr("chat.attachUnsupported", "names", strings.Join(rejected, ", "))
	}
	if len(accepted) == 0 {
		return
	}
	if a.conv != 0 {
		a.enqueueAttachments(accepted)
		return
	}
	// 没有打开的对话：附件需要一个归属。按首页的选择创建一条，再导入。
	client, scope := a.client, a.newChatScope
	draftModel, draftLevel := a.cv.draftModel, a.cv.draftLevel
	a.sending = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		id, err := client.CreateConversation(ctx, service.CreateConversationRequest{WorkspaceID: scope, Model: draftModel, ThinkingLevel: draftLevel})
		a.post(func() {
			a.sending = false
			if err != nil {
				a.sendErr = a.tr("chat.sendStartFailed", "error", err.Error())
				return
			}
			if a.conv == 0 {
				a.nav = navOf(id)
				a.show(id)
			}
			a.refreshConversations()
			a.loadWorkspaces()
			a.enqueueAttachments(accepted)
		})
	}()
}

// enqueueAttachments 交给数据面板已有的上传队列：一次一个，失败的不会挡住后面的文件。
func (a *app) enqueueAttachments(paths []string) {
	a.src.queue = append(a.src.queue, paths...)
	a.startImport()
}

// pickAttachments 是输入区的回形针按钮：多选数据文件，走与拖放相同的导入路径。
func (a *app) pickAttachments() {
	go func() {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
			Title:    a.tr("chat.attachDialogTitle"),
			Message:  a.tr("chat.attachDialogMessage"),
			Multiple: true,
			Filters:  []mygo.FileFilter{{Name: a.tr("data.importFilter"), Extensions: []string{"csv", "xlsx", "xls", "pdf"}}},
		})
		if err != nil {
			a.post(func() { a.src.uploadErr = a.tr("data.dialogUnavailable", "error", err.Error()) })
			return
		}
		if len(paths) == 0 {
			return
		}
		a.post(func() { a.attachPaths(paths) })
	}()
}
