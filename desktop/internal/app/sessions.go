package app

// 侧栏里的会话管理：置顶、归档、删除（服务端软删除，删除前确认）、导出 Markdown，以及按正文搜索。标题过滤
// 在本地即时完成（sessionGroups）；正文搜索走 session.search，输入停顿后才发，避免每敲一个字发一次请求。

import (
	"context"
	"os"
	"strings"
	"time"

	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// searchDelay 是输入停顿多久后发正文搜索。
const searchDelay = 300 * time.Millisecond

// sessionState 是会话管理的界面状态。
type sessionState struct {
	// deleteID 是等待确认删除的会话；0 表示没有。
	deleteID   int
	deleteOpen bool

	// 正文搜索：query 是已经发出的搜索，typed 是输入框最近一次变化的时刻。
	query    string
	typed    time.Time
	lastSeen string
	hits     []service.SessionHit
	gen      int

	// err 是最近一次会话操作失败的原因，显示在侧栏里。
	err string
}

// setSessionFlag 置顶或归档会话 id（flag 是 "pinned" 或 "archived"），完成后刷新会话列表。
func (a *app) setSessionFlag(id int, flag string, on bool) {
	client := a.client
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		var err error
		if flag == "pinned" {
			err = client.PinSession(ctx, id, on)
		} else {
			err = client.ArchiveSession(ctx, id, on)
		}
		a.post(func() {
			if err != nil {
				a.sess.err = err.Error()
				return
			}
			a.sess.err = ""
			a.refreshConversations()
		})
	}()
}

// askDeleteSession 请用户确认删除会话 id。
func (a *app) askDeleteSession(id int) {
	a.sess.deleteID, a.sess.deleteOpen = id, true
}

// deleteSession 删除会话 id；正在看的会话被删时回到新对话。
func (a *app) deleteSession(id int) {
	client := a.client
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := client.DeleteSession(ctx, id)
		a.post(func() {
			if err != nil {
				a.sess.err = err.Error()
				return
			}
			a.sess.err = ""
			if a.conv == id {
				a.newChat()
			}
			a.refreshConversations()
		})
	}()
}

// exportSession 把会话导出成 Markdown：服务端生成正文，用户在保存对话框里选位置。
func (a *app) exportSession(id int) {
	client := a.client
	if client == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		name, content, err := client.ExportSession(ctx, id, "md")
		if err != nil {
			a.post(func() { a.sess.err = err.Error() })
			return
		}
		path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
			Title:       a.tr("sidebar.exportTitle"),
			DefaultPath: name,
			Filters:     []mygo.FileFilter{{Name: "Markdown", Extensions: []string{"md"}}},
		})
		if err != nil || path == "" {
			return // 取消，或没有保存对话框
		}
		werr := os.WriteFile(path, []byte(content), 0o644)
		a.post(func() {
			if werr != nil {
				a.sess.err = werr.Error()
			}
		})
	}()
}

// maybeSearch 在输入停顿 searchDelay 后发出正文搜索；输入清空时清掉结果。
func (a *app) maybeSearch(c *ui.Context) {
	q := strings.TrimSpace(a.sideSearch)
	if q != a.sess.lastSeen {
		a.sess.lastSeen, a.sess.typed = q, c.Now()
	}
	if q == "" {
		a.sess.query, a.sess.hits = "", nil
		return
	}
	if q == a.sess.query || a.client == nil {
		return
	}
	if wait := searchDelay - c.Now().Sub(a.sess.typed); wait > 0 {
		c.After(wait)
		return
	}
	a.sess.query = q
	a.sess.gen++
	gen, client := a.sess.gen, a.client
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		hits, err := client.SearchSessions(ctx, q)
		a.post(func() {
			if gen != a.sess.gen {
				return
			}
			if err != nil {
				a.sess.hits = nil
				return
			}
			a.sess.hits = hits
		})
	}()
}

// bodyHits 是正文搜索命中、但标题过滤没留下的会话（已经在分组里的不重复列出）。
func (a *app) bodyHits(groups []sessionGroup) []service.SessionHit {
	shown := map[int]bool{}
	for _, g := range groups {
		for _, s := range g.sessions {
			shown[s.ID] = true
		}
	}
	var out []service.SessionHit
	for _, h := range a.sess.hits {
		if !shown[h.ID] && !h.Archived {
			out = append(out, h)
		}
	}
	return out
}

// archivedSessions 是已归档的会话（搜索时不列出）。
func (a *app) archivedSessions() []service.Session {
	if strings.TrimSpace(a.sideSearch) != "" {
		return nil
	}
	var out []service.Session
	for _, s := range a.sessions {
		if s.Archived {
			out = append(out, s)
		}
	}
	return out
}

// sessionModals 画删除会话的确认框。
func (a *app) sessionModals(c *ui.Context) {
	if !a.sess.deleteOpen {
		return
	}
	id := a.sess.deleteID
	title := a.tr("sidebar.deleteTitle", "title", a.sessionTitle(id))
	if ui.AlertDialog(c, &a.sess.deleteOpen, title, a.tr("sidebar.deleteBody"), a.tr("sidebar.cancel"), a.tr("sidebar.delete")) == 1 {
		a.deleteSession(id)
	}
}
