package service

// 知识库（knowledge.*）：业务指标、规则、笔记与分类，以及导入的文档（RAG 索引）。全部由 compute 进程执行；
// compute 没起来时是 internal error。记录的字段按种类不同（compute/knowledge.py 的 _ADD_FIELDS），这里用
// map 原样承载，界面按种类挑字段显示与编辑。

import (
	"context"
	"fmt"
)

// 知识的种类。
const (
	KnowledgeMetric   = "metric"
	KnowledgeRule     = "rule"
	KnowledgeNote     = "note"
	KnowledgeCategory = "category"
)

// KnowledgeFields 是每种知识可编辑的字段（与 compute 的 _ADD_FIELDS 一致，category_id 由分类选择决定）。
var KnowledgeFields = map[string][]string{
	KnowledgeMetric: {"name", "alias", "definition", "sql_template", "notes"},
	KnowledgeRule:   {"rule_id", "description", "condition", "severity"},
	KnowledgeNote:   {"topic", "content", "tags"},
}

// KnowledgeRecord 是一条知识：compute 返回的原始记录，至少有 id 与 enabled（0/1）。
type KnowledgeRecord map[string]any

// ID 返回记录的 id；没有时为 0。
func (r KnowledgeRecord) ID() int {
	if v, ok := r["id"].(float64); ok {
		return int(v)
	}
	return 0
}

// Enabled 报告记录是否启用（compute 用 0/1）。
func (r KnowledgeRecord) Enabled() bool {
	switch v := r["enabled"].(type) {
	case float64:
		return v != 0
	case bool:
		return v
	}
	return true
}

// Text 返回某个字段的文字（数字照原样格式化）；没有时为空。
func (r KnowledgeRecord) Text(field string) string {
	switch v := r[field].(type) {
	case nil:
		return ""
	case string:
		return v
	case float64:
		if v == float64(int64(v)) {
			return fmt.Sprint(int64(v))
		}
		return fmt.Sprint(v)
	default:
		return fmt.Sprint(v)
	}
}

// Title 是记录在列表里的标题：指标与分类用 name，规则用 rule_id，笔记用 topic。
func (r KnowledgeRecord) Title(kind string) string {
	switch kind {
	case KnowledgeRule:
		return r.Text("rule_id")
	case KnowledgeNote:
		return r.Text("topic")
	}
	return r.Text("name")
}

// KnowledgeFile 是导入知识库的一个文档。
type KnowledgeFile struct {
	Filename string  `json:"filename"`
	Size     int64   `json:"size"`
	Mtime    float64 `json:"mtime"`
}

// KnowledgeList 列出某个分类下某种知识（分类本身不看 categoryID）。
func (c *Client) KnowledgeList(ctx context.Context, kind string, categoryID int) ([]KnowledgeRecord, error) {
	var out struct {
		Items []KnowledgeRecord `json:"items"`
	}
	params := map[string]any{"kind": kind}
	if categoryID > 0 && kind != KnowledgeCategory {
		params["categoryId"] = categoryID
	}
	err := c.callInto(ctx, "knowledge.list", params, &out)
	return out.Items, err
}

// KnowledgeAdd 新增一条知识（同名、同 rule_id 或同 topic 时覆盖）。
func (c *Client) KnowledgeAdd(ctx context.Context, kind string, categoryID int, record map[string]any) error {
	params := map[string]any{"kind": kind, "record": record}
	if categoryID > 0 {
		params["categoryId"] = categoryID
	}
	return c.callInto(ctx, "knowledge.add", params, nil)
}

// KnowledgeUpdate 修改一条知识的字段。
func (c *Client) KnowledgeUpdate(ctx context.Context, kind string, id int, fields map[string]any) error {
	return c.callInto(ctx, "knowledge.update", map[string]any{"kind": kind, "id": id, "fields": fields}, nil)
}

// KnowledgeToggle 启用或停用一条知识。
func (c *Client) KnowledgeToggle(ctx context.Context, kind string, id int) error {
	return c.callInto(ctx, "knowledge.toggle", map[string]any{"kind": kind, "id": id}, nil)
}

// KnowledgeRemove 删除一条知识；删除分类会连带删掉它下面的条目。已经不存在时不报错。
func (c *Client) KnowledgeRemove(ctx context.Context, kind string, id int) error {
	return c.callInto(ctx, "knowledge.remove", map[string]any{"kind": kind, "id": id}, nil)
}

// KnowledgeFiles 列出导入过的文档，新的在前。
func (c *Client) KnowledgeFiles(ctx context.Context) ([]KnowledgeFile, error) {
	var out struct {
		Files []KnowledgeFile `json:"files"`
	}
	err := c.callInto(ctx, "knowledge.files", nil, &out)
	return out.Files, err
}

// KnowledgeDeleteFile 删除一个导入的文档及其索引块（不删由它抽出的指标、规则、笔记）。
func (c *Client) KnowledgeDeleteFile(ctx context.Context, filename string) error {
	return c.callInto(ctx, "knowledge.deleteFile", map[string]any{"filename": filename}, nil)
}

// KnowledgeParse 解析一个本机文件（.xlsx、.xls、.docx）并复制进知识库目录，返回模板里的记录预览。不调用模型。
func (c *Client) KnowledgeParse(ctx context.Context, path string) (filename string, records []KnowledgeRecord, err error) {
	var out struct {
		Filename string `json:"filename"`
		Preview  struct {
			Records []KnowledgeRecord `json:"records"`
		} `json:"preview"`
	}
	err = c.callInto(ctx, "knowledge.parse", map[string]any{"filePath": path}, &out)
	return out.Filename, out.Preview.Records, err
}

// KnowledgeConfirm 把记录写进知识库并为文档建索引（耗时，按文档大小）。
func (c *Client) KnowledgeConfirm(ctx context.Context, filename string, records []KnowledgeRecord, categoryID int) error {
	params := map[string]any{"filename": filename}
	if len(records) > 0 {
		params["records"] = records
	}
	if categoryID > 0 {
		params["categoryId"] = categoryID
	}
	return c.callInto(ctx, "knowledge.confirm", params, nil)
}

// KnowledgeHits 是 knowledge.search 的结果（每类最多几条）。
type KnowledgeHits struct {
	Metrics   []KnowledgeRecord `json:"metrics"`
	Rules     []KnowledgeRecord `json:"rules"`
	Notes     []KnowledgeRecord `json:"notes"`
	Documents []KnowledgeRecord `json:"documents"`
}

// KnowledgeSearch 在启用的知识里检索 query（混合检索，最多 5 条）。
func (c *Client) KnowledgeSearch(ctx context.Context, query string) (KnowledgeHits, error) {
	var out KnowledgeHits
	err := c.callInto(ctx, "knowledge.search", map[string]any{"query": query}, &out)
	return out, err
}
