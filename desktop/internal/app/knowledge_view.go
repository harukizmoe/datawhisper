package app

// 知识库页：左边是分类，右边是指标、规则、笔记、文档四个标签，顶部可以检索。agent 分析时会检索这里启用的内容。

import (
	"strconv"
	"strings"
	"time"

	"datawhisper/desktop/internal/icons"
	"datawhisper/desktop/internal/service"
	"github.com/egoist/mygo/ui"
)

// knowledgePage 画知识库页。
func (a *app) knowledgePage(c *ui.Context) {
	t := c.Theme()
	k := &a.know
	a.pageHeader(c, t, icons.Knowledge, a.tr("know.title"), func() {
		if k.loading {
			ui.Spinner(c)
		}
		if a.client != nil && ui.Button(c, a.tr("data.refresh")).Clicked() {
			a.loadKnowledge()
		}
	})
	if a.client == nil {
		ui.Text(c, a.tr("know.unavailable")).TextColor(t.TextMuted).Padding(24, 32)
		return
	}
	if !k.loaded && !k.loading && k.err == "" {
		a.loadKnowledge()
	}
	ui.Row(c).Grow(1).MinHeight(0).AlignItems(ui.Stretch).Children(func() {
		a.knowledgeCategories(c, t)
		ui.Column(c).Grow(1).MinWidth(0).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(12, 24, 0, 24).Children(func() {
				search := ui.SearchField(c, &k.query).Label(a.tr("know.search")).Placeholder(a.tr("know.searchHint")).Grow(1).MinWidth(0)
				if search.Submitted() {
					a.searchKnowledge()
				}
				if strings.TrimSpace(k.query) == "" && k.hits != nil {
					k.hits, k.searched = nil, ""
				}
			})
			if k.err != "" {
				ui.Text(c, k.err).FontSize(a.fs(textCaption)).TextColor(t.Danger).Padding(6, 24)
			}
			if k.notice != "" {
				ui.Text(c, k.notice).FontSize(a.fs(textCaption)).TextColor(t.Success).Padding(6, 24)
			}
			if k.hits != nil {
				a.knowledgeHits(c, t)
				return
			}
			ui.Row(c).Padding(8, 24, 0, 24).Children(func() {
				if ui.Tabs(c, &k.tab, a.tr("know.metrics"), a.tr("know.rules"), a.tr("know.notes"), a.tr("know.docs")).Label(a.tr("know.title")).Changed() {
					a.loadKnowledgeTab()
				}
			})
			ui.Scroll(c).Grow(1).MinHeight(0).Children(func() {
				ui.Column(c).Padding(16, 24).Gap(10).MaxWidth(900).Children(func() {
					if k.tab == knowTabDocs {
						a.knowledgeDocs(c, t)
					} else {
						a.knowledgeItems(c, t)
					}
				})
			})
		})
	})
	a.knowledgeModals(c, t)
}

// pageHeader 是独立页面（设置之外的知识库、技能）的标题栏：图标、标题与右侧的按钮。
func (a *app) pageHeader(c *ui.Context, t *ui.Theme, icon *ui.SVG, title string, right func()) {
	ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(10, 24).BorderWidth(0, 0, 1, 0).BorderColor(t.Border).Children(func() {
		ui.Icon(c, icon).TextColor(t.Accent)
		ui.Text(c, title).Bold().FontSize(a.fs(textTitle))
		ui.Spacer(c)
		right()
	})
}

// knowledgeCategories 是左侧的分类列表：点一项切换，右键启用/停用或删除；底部新建分类。
func (a *app) knowledgeCategories(c *ui.Context, t *ui.Theme) {
	k := &a.know
	tok := a.tokens().Tok
	ui.Column(c).Width(220).Shrink(0).Padding(16, 12).Gap(6).AlignItems(ui.Stretch).Background(tok.Sidebar).BorderWidth(0, 1, 0, 0).BorderColor(t.Border).Children(func() {
		ui.Text(c, a.tr("know.categories")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Padding(0, 6)
		for _, cat := range k.categories {
			id, name := cat.ID(), cat.Text("name")
			bg := tok.Sidebar
			if id == k.catID {
				bg = t.SurfaceHover
			}
			color := t.Text
			if !cat.Enabled() {
				color = t.TextMuted
			}
			row := ui.ButtonBase(c).Label(name).Children(func() {
				ui.Row(c).Grow(1).Gap(6).AlignItems(ui.Center).Padding(6, 8).Radius(t.Radius).Background(bg).Children(func() {
					ui.Text(c, name).TextColor(color).SingleLine().Grow(1).MinWidth(0)
					if !cat.Enabled() {
						ui.Text(c, a.tr("know.off")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
					}
				})
			}).ContextMenu(func(m *ui.Menu) {
				toggle := a.tr("know.disable")
				if !cat.Enabled() {
					toggle = a.tr("know.enable")
				}
				if m.Item(toggle).Chosen() {
					a.toggleKnowledge(service.KnowledgeCategory, id)
				}
				if m.Item(a.tr("know.deleteCategory")).Chosen() {
					a.removeKnowledge(service.KnowledgeCategory, id)
				}
			})
			if row.Clicked() && id != k.catID {
				k.catID = id
				a.loadKnowledgeTab()
			}
		}
		ui.Spacer(c)
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			in := ui.TextInput(c, &k.newCategory).Label(a.tr("know.newCategory")).Placeholder(a.tr("know.newCategory")).Grow(1).MinWidth(0)
			if iconButton(c, icons.Plus, a.tr("know.addCategory")).Shrink(0).Clicked() || in.Submitted() {
				a.addCategory()
			}
		})
	})
}

// knowledgeItems 是指标、规则或笔记的列表：标题、正文摘要、启用开关、编辑与删除。
func (a *app) knowledgeItems(c *ui.Context, t *ui.Theme) {
	k := &a.know
	kind := k.kind()
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Text(c, a.tr("know.itemsTip")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Grow(1).MinWidth(0)
		if iconTextButton(c, icons.Plus, a.tr("know.add")).Shrink(0).Clicked() {
			a.openKnowledgeEditor(kind, nil)
		}
	})
	if len(k.items) == 0 {
		ui.Text(c, a.tr("know.empty")).TextColor(t.TextMuted).Padding(12, 0)
		return
	}
	tok := a.tokens().Tok
	for _, rec := range k.items {
		rec := rec
		id := rec.ID()
		ui.Column(c).Gap(4).Padding(10, 14).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				title := rec.Title(kind)
				ui.Text(c, title).Bold().SingleLine().Grow(1).MinWidth(0).Tooltip(title)
				on := rec.Enabled()
				if ui.Switch(c, &on).Label(a.tr("know.enabled") + " " + title).Changed() {
					a.toggleKnowledge(kind, id)
				}
				if iconButton(c, icons.Pencil, a.tr("know.edit")).Clicked() {
					a.openKnowledgeEditor(kind, rec)
				}
				if iconButton(c, icons.Trash, a.tr("know.delete")).Clicked() {
					a.removeKnowledge(kind, id)
				}
			})
			if body := knowledgeSummary(kind, rec); body != "" {
				ui.Text(c, body).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).MaxLines(3)
			}
			if kind == service.KnowledgeMetric && rec.Text("sql_template") != "" {
				a.buffer(ui.Text(c, rec.Text("sql_template"))).TextColor(t.TextMuted).SingleLine()
			}
		})
	}
}

// knowledgeSummary 是列表里一条知识的正文摘要。
func knowledgeSummary(kind string, rec service.KnowledgeRecord) string {
	switch kind {
	case service.KnowledgeRule:
		return strings.TrimSpace(rec.Text("description") + "  " + rec.Text("condition"))
	case service.KnowledgeNote:
		return rec.Text("content")
	}
	if alias := rec.Text("alias"); alias != "" {
		return alias + " · " + rec.Text("definition")
	}
	return rec.Text("definition")
}

// knowledgeDocs 是导入的文档：文件名、大小、时间与删除；顶部是导入按钮。
func (a *app) knowledgeDocs(c *ui.Context, t *ui.Theme) {
	k := &a.know
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Text(c, a.tr("know.docsTip")).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Grow(1).MinWidth(0)
		if k.importBusy {
			ui.Spinner(c)
		}
		if iconTextButton(c, icons.Upload, a.tr("know.import")).Disabled(k.importBusy).Shrink(0).Clicked() {
			a.importKnowledgeFile()
		}
	})
	if len(k.files) == 0 {
		ui.Text(c, a.tr("know.noDocs")).TextColor(t.TextMuted).Padding(12, 0)
		return
	}
	tok := a.tokens().Tok
	for _, f := range k.files {
		name := f.Filename
		ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(8, 12).Radius(radiusCard).Background(tok.Card).BorderWidth(1).BorderColor(tok.CardBorder).Children(func() {
			ui.Icon(c, icons.File).TextColor(t.TextMuted)
			ui.Text(c, name).SingleLine().Grow(1).MinWidth(0).Tooltip(name)
			when := time.Unix(int64(f.Mtime), 0).Format("2006-01-02 15:04")
			ui.Text(c, formatBytes(f.Size)+" · "+when).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).Shrink(0)
			if iconButton(c, icons.Trash, a.tr("know.deleteDoc")).Clicked() {
				a.deleteKnowledgeFile(name)
			}
		})
	}
}

// knowledgeHits 是检索结果：按种类分组，每条是标题与摘要。
func (a *app) knowledgeHits(c *ui.Context, t *ui.Theme) {
	h := a.know.hits
	ui.Scroll(c).Grow(1).MinHeight(0).Children(func() {
		ui.Column(c).Padding(16, 24).Gap(12).MaxWidth(900).Children(func() {
			ui.Text(c, a.tr("know.results", "query", a.know.searched)).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
			groups := []struct {
				label, kind string
				items       []service.KnowledgeRecord
			}{
				{a.tr("know.metrics"), service.KnowledgeMetric, h.Metrics},
				{a.tr("know.rules"), service.KnowledgeRule, h.Rules},
				{a.tr("know.notes"), service.KnowledgeNote, h.Notes},
				{a.tr("know.docs"), "", h.Documents},
			}
			total := 0
			for _, g := range groups {
				if len(g.items) == 0 {
					continue
				}
				total += len(g.items)
				ui.Text(c, g.label).Bold()
				for _, rec := range g.items {
					title := rec.Title(g.kind)
					body := knowledgeSummary(g.kind, rec)
					if g.kind == "" {
						title, body = rec.Text("source"), rec.Text("content")
						if title == "" {
							title = rec.Text("filename")
						}
					}
					ui.Column(c).Gap(2).Padding(8, 12).Radius(radiusCard).Background(a.tokens().Tok.Card).Children(func() {
						ui.Text(c, title).SingleLine()
						if body != "" {
							ui.Text(c, body).FontSize(a.fs(textCaption)).TextColor(t.TextMuted).MaxLines(3)
						}
					})
				}
			}
			if total == 0 {
				ui.Text(c, a.tr("know.noResults")).TextColor(t.TextMuted)
			}
		})
	})
}

// knowledgeModals 是编辑弹窗与导入确认弹窗。
func (a *app) knowledgeModals(c *ui.Context, t *ui.Theme) {
	k := &a.know
	if k.editOpen {
		ui.Modal(c, &k.editOpen, func() {
			ui.Column(c).Width(520).Gap(10).Children(func() {
				title := a.tr("know.addTitle")
				if k.editID != 0 {
					title = a.tr("know.editTitle")
				}
				ui.Text(c, title).Bold().FontSize(a.fs(textSection))
				for _, f := range service.KnowledgeFields[k.editKind] {
					v := k.editValues[f]
					label := a.knowledgeFieldLabel(f)
					ui.Text(c, label).FontSize(a.fs(textCaption)).TextColor(t.TextMuted)
					var in ui.Element
					if longKnowledgeField(f) {
						in = ui.TextArea(c, &v).Lines(2, 8).MinHeight(0)
					} else {
						in = ui.TextInput(c, &v)
					}
					in.Label(label)
					k.editValues[f] = v
				}
				if k.editErr != "" {
					ui.Text(c, k.editErr).FontSize(a.fs(textCaption)).TextColor(t.Danger)
				}
				ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
					if k.editBusy {
						ui.Spinner(c)
					}
					if ui.Button(c, a.tr("sidebar.cancel")).Clicked() {
						k.editOpen = false
					}
					if ui.PrimaryButton(c, a.tr("know.save")).Disabled(k.editBusy).Clicked() {
						a.saveKnowledge()
					}
				})
			})
		})
	}
	if k.importOpen {
		open := true
		ui.Modal(c, &open, func() {
			ui.Column(c).Width(480).Gap(10).Children(func() {
				ui.Text(c, a.tr("know.importConfirm")).Bold().FontSize(a.fs(textSection))
				ui.Text(c, a.tr("know.importBody", "file", k.importFile, "count", strconv.Itoa(len(k.importRecords)))).TextColor(t.TextMuted)
				ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
					if k.importBusy {
						ui.Spinner(c)
					}
					if ui.Button(c, a.tr("sidebar.cancel")).Disabled(k.importBusy).Clicked() {
						a.cancelKnowledgeImport()
					}
					if ui.PrimaryButton(c, a.tr("know.importNow")).Disabled(k.importBusy).Clicked() {
						a.confirmKnowledgeImport()
					}
				})
			})
		})
		if !open && !k.importBusy {
			a.cancelKnowledgeImport()
		}
	}
}

// longKnowledgeField 报告字段是不是长文本（用多行输入）。
func longKnowledgeField(f string) bool {
	switch f {
	case "definition", "sql_template", "notes", "description", "condition", "content":
		return true
	}
	return false
}

// knowledgeFieldLabel 是字段在编辑弹窗里的标签。
func (a *app) knowledgeFieldLabel(f string) string {
	switch f {
	case "name":
		return a.tr("know.fieldName")
	case "alias":
		return a.tr("know.fieldAlias")
	case "definition":
		return a.tr("know.fieldDefinition")
	case "sql_template":
		return a.tr("know.fieldSQL")
	case "notes":
		return a.tr("know.fieldNotes")
	case "rule_id":
		return a.tr("know.fieldRuleID")
	case "description":
		return a.tr("know.fieldDescription")
	case "condition":
		return a.tr("know.fieldCondition")
	case "severity":
		return a.tr("know.fieldSeverity")
	case "topic":
		return a.tr("know.fieldTopic")
	case "content":
		return a.tr("know.fieldContent")
	case "tags":
		return a.tr("know.fieldTags")
	}
	return f
}
