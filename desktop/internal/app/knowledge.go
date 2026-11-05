package app

// 知识库页的状态与动作（knowledge.*）：分类、指标、规则、笔记与导入的文档。agent 在分析时检索这里的内容；
// 页面让用户维护它。导入文档走 parse → 确认：parse 读出模板里的记录并把文件复制进知识库，确认时写入记录并
// 为文档建索引（不在这里调模型做抽取）；取消时删掉 parse 留下的副本。

import (
	"context"
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo"
)

// 知识库页的标签。
const (
	knowTabMetrics = iota
	knowTabRules
	knowTabNotes
	knowTabDocs
)

// knowKinds 是前三个标签对应的知识种类。
var knowKinds = [...]string{service.KnowledgeMetric, service.KnowledgeRule, service.KnowledgeNote}

type knowledgeState struct {
	gen     int
	loading bool
	loaded  bool
	err     string
	notice  string

	tab        int
	categories []service.KnowledgeRecord
	catID      int // 选中的分类；0 表示还没加载（用第一个）
	items      []service.KnowledgeRecord
	itemsKey   string // items 对应的「种类/分类」，换了就重新加载
	files      []service.KnowledgeFile

	newCategory string

	// 搜索：query 是输入框，searched 是已经搜过的词。
	query    string
	searched string
	hits     *service.KnowledgeHits

	// 编辑弹窗：id 为 0 表示新增。
	editOpen   bool
	editKind   string
	editID     int
	editValues map[string]string
	editErr    string
	editBusy   bool

	// 导入文档：parse 之后等确认。
	importBusy    bool
	importOpen    bool
	importFile    string
	importRecords []service.KnowledgeRecord
}

// knowledgeKind 返回当前标签的知识种类；文档标签返回空串。
func (k *knowledgeState) kind() string {
	if k.tab >= 0 && k.tab < len(knowKinds) {
		return knowKinds[k.tab]
	}
	return ""
}

// knowledgeCall 在后台调用 fn，完成后在 UI 线程上执行 done；失败时把原因记在页面上。
func (a *app) knowledgeCall(fn func(ctx context.Context, c *service.Client) error, done func()) {
	client := a.client
	if client == nil {
		return
	}
	k := &a.know
	gen := k.gen
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		err := fn(ctx, client)
		a.post(func() {
			if gen != a.know.gen {
				return
			}
			if err != nil {
				// 失败时放开所有「进行中」的状态，页面不会一直转圈；原因显示在页面顶部。
				k := &a.know
				k.err = sourceErrorText(err)
				k.loading, k.editBusy, k.importBusy = false, false, false
				return
			}
			a.know.err = ""
			if done != nil {
				done()
			}
		})
	}()
}

// loadKnowledge 加载分类，再加载当前标签的内容。
func (a *app) loadKnowledge() {
	k := &a.know
	if a.client == nil || k.loading {
		return
	}
	k.loading = true
	var cats []service.KnowledgeRecord
	a.knowledgeCall(func(ctx context.Context, c *service.Client) error {
		var err error
		cats, err = c.KnowledgeList(ctx, service.KnowledgeCategory, 0)
		return err
	}, func() {
		k.loading, k.loaded, k.categories = false, true, cats
		if !hasCategory(cats, k.catID) && len(cats) > 0 {
			k.catID = cats[0].ID()
		}
		k.itemsKey = ""
		a.loadKnowledgeTab()
	})
}

func hasCategory(cats []service.KnowledgeRecord, id int) bool {
	for _, c := range cats {
		if c.ID() == id {
			return true
		}
	}
	return false
}

// loadKnowledgeTab 加载当前标签：某个分类下的一种知识，或导入的文档。
func (a *app) loadKnowledgeTab() {
	k := &a.know
	if k.tab == knowTabDocs {
		var files []service.KnowledgeFile
		a.knowledgeCall(func(ctx context.Context, c *service.Client) error {
			var err error
			files, err = c.KnowledgeFiles(ctx)
			return err
		}, func() { k.files = files })
		return
	}
	kind, cat := k.kind(), k.catID
	key := kind + "/" + strconv.Itoa(cat)
	var items []service.KnowledgeRecord
	a.knowledgeCall(func(ctx context.Context, c *service.Client) error {
		var err error
		items, err = c.KnowledgeList(ctx, kind, cat)
		return err
	}, func() { k.items, k.itemsKey = items, key })
}

// addCategory 新建一个分类并选中它。
func (a *app) addCategory() {
	name := strings.TrimSpace(a.know.newCategory)
	if name == "" {
		return
	}
	a.knowledgeCall(func(ctx context.Context, c *service.Client) error {
		return c.KnowledgeAdd(ctx, service.KnowledgeCategory, 0, map[string]any{"name": name})
	}, func() {
		a.know.newCategory = ""
		a.loadKnowledge()
	})
}

// removeKnowledge 删除一条知识（分类会连带删掉它下面的条目）。
func (a *app) removeKnowledge(kind string, id int) {
	a.knowledgeCall(func(ctx context.Context, c *service.Client) error {
		return c.KnowledgeRemove(ctx, kind, id)
	}, func() {
		if kind == service.KnowledgeCategory {
			a.loadKnowledge()
			return
		}
		a.loadKnowledgeTab()
	})
}

// toggleKnowledge 启用或停用一条知识。
func (a *app) toggleKnowledge(kind string, id int) {
	a.knowledgeCall(func(ctx context.Context, c *service.Client) error {
		return c.KnowledgeToggle(ctx, kind, id)
	}, func() {
		if kind == service.KnowledgeCategory {
			a.loadKnowledge()
			return
		}
		a.loadKnowledgeTab()
	})
}

// openKnowledgeEditor 打开编辑弹窗；rec 为 nil 时是新增。
func (a *app) openKnowledgeEditor(kind string, rec service.KnowledgeRecord) {
	k := &a.know
	k.editOpen, k.editKind, k.editErr, k.editBusy = true, kind, "", false
	k.editID = 0
	k.editValues = map[string]string{}
	if rec != nil {
		k.editID = rec.ID()
		for _, f := range service.KnowledgeFields[kind] {
			k.editValues[f] = rec.Text(f)
		}
	}
}

// saveKnowledge 保存编辑弹窗：新增时写进当前分类。
func (a *app) saveKnowledge() {
	k := &a.know
	kind, id, cat := k.editKind, k.editID, k.catID
	fields := map[string]any{}
	for _, f := range service.KnowledgeFields[kind] {
		fields[f] = strings.TrimSpace(k.editValues[f])
	}
	if title := fields[knowledgeTitleField(kind)]; title == "" {
		k.editErr = a.tr("know.titleRequired")
		return
	}
	k.editBusy = true
	a.knowledgeCall(func(ctx context.Context, c *service.Client) error {
		if id == 0 {
			return c.KnowledgeAdd(ctx, kind, cat, fields)
		}
		return c.KnowledgeUpdate(ctx, kind, id, fields)
	}, func() {
		k.editOpen, k.editBusy = false, false
		a.loadKnowledgeTab()
	})
}

// knowledgeTitleField 是每种知识必填的标题字段。
func knowledgeTitleField(kind string) string {
	switch kind {
	case service.KnowledgeRule:
		return "rule_id"
	case service.KnowledgeNote:
		return "topic"
	}
	return "name"
}

// searchKnowledge 在启用的知识里检索输入框里的词。
func (a *app) searchKnowledge() {
	q := strings.TrimSpace(a.know.query)
	if q == "" {
		a.know.hits, a.know.searched = nil, ""
		return
	}
	var hits service.KnowledgeHits
	a.knowledgeCall(func(ctx context.Context, c *service.Client) error {
		var err error
		hits, err = c.KnowledgeSearch(ctx, q)
		return err
	}, func() { a.know.hits, a.know.searched = &hits, q })
}

// importKnowledgeFile 选一个 .xlsx/.xls/.docx 文件并解析，等用户确认后入库。
func (a *app) importKnowledgeFile() {
	go func() {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
			Title:   a.tr("know.importTitle"),
			Filters: []mygo.FileFilter{{Name: "Excel / Word", Extensions: []string{"xlsx", "xls", "docx"}}},
		})
		if err != nil || len(paths) == 0 {
			return
		}
		path := paths[0]
		a.post(func() { a.parseKnowledgeFile(path) })
	}()
}

// parseKnowledgeFile 解析文件，打开确认弹窗。
func (a *app) parseKnowledgeFile(path string) {
	k := &a.know
	k.importBusy = true
	var name string
	var records []service.KnowledgeRecord
	a.knowledgeCall(func(ctx context.Context, c *service.Client) error {
		var err error
		name, records, err = c.KnowledgeParse(ctx, path)
		return err
	}, func() {
		k.importBusy, k.importOpen, k.importFile, k.importRecords = false, true, name, records
	})
}

// confirmKnowledgeImport 写入解析出的记录并为文档建索引。
func (a *app) confirmKnowledgeImport() {
	k := &a.know
	name, records, cat := k.importFile, k.importRecords, k.catID
	k.importBusy = true
	a.knowledgeCall(func(ctx context.Context, c *service.Client) error {
		return c.KnowledgeConfirm(ctx, name, records, cat)
	}, func() {
		k.importBusy, k.importOpen = false, false
		k.notice = a.tr("know.imported", "file", name)
		a.loadKnowledgeTab()
	})
}

// cancelKnowledgeImport 放弃导入：删掉 parse 复制进知识库目录的文件。
func (a *app) cancelKnowledgeImport() {
	name := a.know.importFile
	a.know.importOpen = false
	if name == "" {
		return
	}
	a.knowledgeCall(func(ctx context.Context, c *service.Client) error {
		return c.KnowledgeDeleteFile(ctx, name)
	}, nil)
}

// deleteKnowledgeFile 删除一个导入的文档及其索引。
func (a *app) deleteKnowledgeFile(name string) {
	a.knowledgeCall(func(ctx context.Context, c *service.Client) error {
		return c.KnowledgeDeleteFile(ctx, name)
	}, a.loadKnowledgeTab)
}
