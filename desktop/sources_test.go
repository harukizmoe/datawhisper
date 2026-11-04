package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"datawhisper/desktop/internal/api"
	"datawhisper/desktop/internal/supervisor"
	"github.com/egoist/mygo/ui"
)

// sourceCall 是假服务收到的一次请求，参数保留 JSON 解码后的形状，便于检查实际发出去的字段。
type sourceCall struct {
	Method string
	Params map[string]any
}

// sourceFake 是数据面板用到的 stateful 假服务：它保存来源、表、工作区、产物与已保存配置，并按真服务的
// 形状回答 source.* / workspace.* / artifact.*，包括上传的三段式与各种拒绝原因。
type sourceFake struct {
	t *testing.T

	mu      sync.Mutex
	closers []func()
	calls   []sourceCall

	sources []api.Source
	preview map[string]api.SourcePreview
	rows    map[string]api.PreviewTable
	schema  map[string]string
	work    []api.Workspace
	current *api.Workspace
	arts    []api.Artifact
	artText map[string]string
	configs []api.SourceConfig

	// 上传：uploadDir 是 staging 目录，maxBytes 是 begin 声明的上限。
	uploadDir string
	maxBytes  int64
	// uploadErr / openErr / workErr 让测试模拟服务端拒绝。
	uploadErr map[string]any
	openErr   map[string]any
	workErr   map[string]any
	// lastTicket 记录最近一次开票返回的路径，测试用它检查界面有没有提前写盘。
	lastTicket  string
	fileAtOpen  bool   // source.open 时 staging 文件是否存在
	bytesAtOpen string // source.open 时 staging 文件的内容
}

func newSourceFake(t *testing.T) *sourceFake {
	f := &sourceFake{
		t:         t,
		preview:   map[string]api.SourcePreview{},
		rows:      map[string]api.PreviewTable{},
		schema:    map[string]string{},
		artText:   map[string]string{},
		uploadDir: t.TempDir(),
		maxBytes:  512 << 20,
	}
	t.Cleanup(f.stop)
	return f
}

func (f *sourceFake) stop() {
	f.mu.Lock()
	closers := f.closers
	f.closers = nil
	f.mu.Unlock()
	for i := len(closers) - 1; i >= 0; i-- {
		closers[i]()
	}
}

// ready 新建一对内存管道并在另一端启动假服务，返回 supervisor 的 ready 状态。
func (f *sourceFake) ready(pid int) supervisor.Status {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan struct{})
	f.mu.Lock()
	f.closers = append(f.closers,
		func() { _ = inW.Close() },
		func() { _ = outW.Close() },
		func() { close(done) },
	)
	f.mu.Unlock()
	go f.serve(inR, outW)
	return supervisor.Status{State: supervisor.StateReady, Pipe: &fakePipe{r: outR, w: inW, done: done}, PID: pid}
}

func (f *sourceFake) record(method string, raw json.RawMessage) {
	params := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &params)
	}
	f.mu.Lock()
	f.calls = append(f.calls, sourceCall{Method: method, Params: params})
	f.mu.Unlock()
}

// call 返回最后一次 method 的参数；没有时返回 nil。
func (f *sourceFake) call(method string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.calls) - 1; i >= 0; i-- {
		if f.calls[i].Method == method {
			return f.calls[i].Params
		}
	}
	return nil
}

// methods 返回收到的全部方法名，按到达顺序。
func (f *sourceFake) methods() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.calls))
	for i, c := range f.calls {
		out[i] = c.Method
	}
	return out
}

// seedSource 放进一份来源、它的预览与 schema。调用前不能持锁。
func (f *sourceFake) seedSource(src api.Source, tables []string, preview api.SourcePreview, schema string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	src.Tables = tables
	f.sources = append(f.sources, src)
	f.preview[src.ID] = preview
	f.schema[src.ID] = schema
	for _, table := range preview.Tables {
		f.rows[src.ID+"/"+table.Name] = api.PreviewTable{
			Name:      table.Name,
			Columns:   table.Columns,
			Rows:      [][]string{{"alpha", "1"}, {"beta", "2"}, {"gamma", "3"}},
			TotalRows: table.TotalRows,
		}
	}
}

func (f *sourceFake) serve(in io.Reader, out io.Writer) {
	write := func(record any) {
		line, err := json.Marshal(record)
		if err != nil {
			f.t.Errorf("fake source service: %v", err)
			return
		}
		f.mu.Lock()
		_, _ = fmt.Fprintf(out, "%s\n", line)
		f.mu.Unlock()
	}
	respond := func(id json.RawMessage, result any) {
		write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
	fail := func(id json.RawMessage, rpcErr map[string]any) {
		write(map[string]any{"jsonrpc": "2.0", "id": id, "error": rpcErr})
	}
	event := func(subscriptionID int, name string, fields map[string]any) {
		params := map[string]any{"subscriptionId": subscriptionID, "event": name}
		for k, v := range fields {
			params[k] = v
		}
		write(map[string]any{"jsonrpc": "2.0", "method": "conversation.event", "params": params})
	}
	// snapshotLocked 复制来源列表；调用方必须持有 f.mu。
	snapshotLocked := func() []api.Source {
		return append([]api.Source(nil), f.sources...)
	}
	notFound := map[string]any{"code": -32000, "message": "data source not found", "data": map[string]any{"kind": "not_found"}}

	br := bufio.NewReader(in)
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return
		}
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal([]byte(strings.TrimSuffix(line, "\n")), &req) != nil || req.Method == "" {
			continue
		}
		var params map[string]any
		_ = json.Unmarshal(req.Params, &params)

		switch req.Method {
		case "conversation.list":
			respond(req.ID, map[string]any{"conversations": []any{}})
		case "conversation.subscribe":
			// 与真服务一致：先推 snapshot，再回订阅响应。
			event(1, "snapshot", map[string]any{"seq": 0, "view": fakeView(1)})
			respond(req.ID, map[string]any{"subscriptionId": 1})
		case "conversation.unsubscribe":
			respond(req.ID, map[string]any{"ok": true})
		case "models.available":
			respond(req.ID, map[string]any{"models": []any{}})
		case "usage.summary":
			respond(req.ID, map[string]any{"models": map[string]any{}, "tools": map[string]any{}})

		case "source.list":
			f.record(req.Method, req.Params)
			f.mu.Lock()
			list := snapshotLocked()
			f.mu.Unlock()
			respond(req.ID, map[string]any{"sources": list})

		case "source.upload.begin":
			f.record(req.Method, req.Params)
			f.mu.Lock()
			uploadErr := f.uploadErr
			if uploadErr != nil {
				f.mu.Unlock()
				fail(req.ID, uploadErr)
				continue
			}
			filename, _ := params["filename"].(string)
			id := strings.Repeat("a", 32)
			path := filepath.Join(f.uploadDir, id)
			f.lastTicket = path
			maxBytes := f.maxBytes
			f.mu.Unlock()
			respond(req.ID, map[string]any{
				"uploadId": id, "path": path, "filename": filename,
				"maxBytes": maxBytes, "expiresAt": "2026-01-01T00:15:00.000Z",
			})

		case "source.open":
			f.record(req.Method, req.Params)
			uploadID, _ := params["uploadId"].(string)
			sourceID, _ := params["sourceId"].(string)
			f.mu.Lock()
			openErr := f.openErr
			path := f.lastTicket
			if uploadID != "" {
				if data, err := os.ReadFile(path); err == nil {
					f.fileAtOpen, f.bytesAtOpen = true, string(data)
				}
			}
			if openErr != nil {
				f.mu.Unlock()
				fail(req.ID, openErr)
				continue
			}
			if sourceID != "" {
				found := false
				for i := range f.sources {
					if f.sources[i].ID != sourceID {
						continue
					}
					f.sources[i].Open = true
					src := f.sources[i]
					list := snapshotLocked()
					f.mu.Unlock()
					respond(req.ID, map[string]any{"source": src, "sources": list})
					found = true
					break
				}
				if found {
					continue
				}
				f.mu.Unlock()
				fail(req.ID, notFound)
				continue
			}
			if uploadID != "" {
				if !f.fileAtOpen {
					f.mu.Unlock()
					fail(req.ID, map[string]any{"code": -32602, "message": "upload missing", "data": map[string]any{"kind": "invalid_input", "reason": "upload_missing"}})
					continue
				}
				src := api.Source{ID: "s_00000002", Name: "orders.csv", Kind: "csv", Active: true, Open: true, Tables: []string{"orders"}}
				f.sources = append(f.sources, src)
				_ = os.Remove(path)
				list := snapshotLocked()
				f.mu.Unlock()
				respond(req.ID, map[string]any{"source": src, "sources": list})
				continue
			}
			// 远程连接：返回一个来源；密钥只在这次请求里，返回值没有它。
			kind, _ := params["kind"].(string)
			name, _ := params["name"].(string)
			if name == "" {
				name = "Remote " + kind
			}
			src := api.Source{ID: "s_00000003", Name: name, Kind: kind, Active: true, Open: true, Tables: []string{"orders"}}
			f.sources = append(f.sources, src)
			list := snapshotLocked()
			f.mu.Unlock()
			respond(req.ID, map[string]any{"source": src, "sources": list, "configId": "ds_00000001"})

		case "source.toggle":
			f.record(req.Method, req.Params)
			id, _ := params["sourceId"].(string)
			f.mu.Lock()
			found := false
			for i := range f.sources {
				if f.sources[i].ID != id {
					continue
				}
				active := !f.sources[i].Active
				if raw, ok := params["active"].(bool); ok {
					active = raw
				}
				f.sources[i].Active = active
				src := f.sources[i]
				list := snapshotLocked()
				f.mu.Unlock()
				respond(req.ID, map[string]any{"ok": true, "active": active, "source": src, "sources": list})
				found = true
				break
			}
			if !found {
				f.mu.Unlock()
				fail(req.ID, notFound)
			}

		case "source.close":
			f.record(req.Method, req.Params)
			id, _ := params["sourceId"].(string)
			f.mu.Lock()
			for i := range f.sources {
				if f.sources[i].ID == id {
					f.sources[i].Open = false
				}
			}
			list := snapshotLocked()
			f.mu.Unlock()
			respond(req.ID, map[string]any{"ok": true, "closed": true, "sources": list})

		case "source.remove":
			f.record(req.Method, req.Params)
			id, _ := params["sourceId"].(string)
			f.mu.Lock()
			kept := make([]api.Source, 0, len(f.sources))
			for _, src := range f.sources {
				if src.ID != id {
					kept = append(kept, src)
				}
			}
			f.sources = kept
			list := snapshotLocked()
			f.mu.Unlock()
			respond(req.ID, map[string]any{"ok": true, "sources": list})

		case "source.removeAll":
			f.record(req.Method, req.Params)
			f.mu.Lock()
			f.sources = nil
			f.mu.Unlock()
			respond(req.ID, map[string]any{"ok": true, "removed": 0, "sources": []any{}})

		case "source.schema":
			f.record(req.Method, req.Params)
			id, _ := params["sourceId"].(string)
			f.mu.Lock()
			schema := f.schema[id]
			f.mu.Unlock()
			respond(req.ID, map[string]any{"source_id": id, "schema": schema})

		case "source.preview":
			f.record(req.Method, req.Params)
			id, _ := params["sourceId"].(string)
			f.mu.Lock()
			preview, ok := f.preview[id]
			list := snapshotLocked()
			f.mu.Unlock()
			if !ok {
				fail(req.ID, map[string]any{"code": -32000, "message": "no data source", "data": map[string]any{"kind": "not_found"}})
				continue
			}
			preview.Sources = list
			respond(req.ID, preview)

		case "source.previewTable":
			f.record(req.Method, req.Params)
			id, _ := params["sourceId"].(string)
			table, _ := params["table"].(string)
			f.mu.Lock()
			rows, ok := f.rows[id+"/"+table]
			f.mu.Unlock()
			if !ok {
				fail(req.ID, map[string]any{"code": -32000, "message": "preview failed", "data": map[string]any{"kind": "invalid_input", "reason": "preview_failed"}})
				continue
			}
			respond(req.ID, rows)

		case "source.setAnalysisTables":
			f.record(req.Method, req.Params)
			id, _ := params["sourceId"].(string)
			tables := []string{}
			if raw, ok := params["tables"].([]any); ok {
				for _, item := range raw {
					if name, ok := item.(string); ok {
						tables = append(tables, name)
					}
				}
			}
			respond(req.ID, map[string]any{"source_id": id, "tables": tables})

		case "source.config.list":
			f.record(req.Method, req.Params)
			f.mu.Lock()
			configs := append([]api.SourceConfig(nil), f.configs...)
			f.mu.Unlock()
			respond(req.ID, map[string]any{"configs": configs})

		case "source.config.remove":
			f.record(req.Method, req.Params)
			id, _ := params["id"].(string)
			f.mu.Lock()
			kept := make([]api.SourceConfig, 0, len(f.configs))
			for _, cfg := range f.configs {
				if cfg.ID != id {
					kept = append(kept, cfg)
				}
			}
			f.configs = kept
			f.mu.Unlock()
			respond(req.ID, map[string]any{"ok": true, "removed": id, "configs": kept})

		case "workspace.list":
			f.record(req.Method, req.Params)
			f.mu.Lock()
			view := map[string]any{
				"workspace":  f.current,
				"workspaces": append([]api.Workspace(nil), f.work...),
				"sources":    snapshotLocked(),
			}
			f.mu.Unlock()
			respond(req.ID, view)

		case "workspace.mount":
			f.record(req.Method, req.Params)
			f.mu.Lock()
			workErr := f.workErr
			if workErr != nil {
				f.mu.Unlock()
				fail(req.ID, workErr)
				continue
			}
			path, _ := params["path"].(string)
			permission, _ := params["permission"].(string)
			name, _ := params["name"].(string)
			if name == "" {
				name = filepath.Base(path)
			}
			ws := api.Workspace{
				WorkspaceID: "ws_0000000000000001",
				Workdir:     path,
				Name:        name,
				Permission:  permission,
				SourceID:    "s_00000004",
				Mounted:     true,
			}
			f.current = &ws
			kept := make([]api.Workspace, 0, len(f.work)+1)
			for _, existing := range f.work {
				if existing.WorkspaceID != ws.WorkspaceID {
					kept = append(kept, existing)
				}
			}
			f.work = append(kept, ws)
			f.sources = append(f.sources, api.Source{ID: ws.SourceID, Name: "📁 " + name, Kind: "workspace_persistent", Active: true, Open: true, Tables: []string{"sales"}})
			list := snapshotLocked()
			f.mu.Unlock()
			respond(req.ID, map[string]any{"workspace": ws, "sources": list, "added": []any{}, "errors": []any{}, "skipped": 0, "reused": 0})

		case "workspace.unmount":
			f.record(req.Method, req.Params)
			f.mu.Lock()
			ws := f.current
			f.current = nil
			list := snapshotLocked()
			f.mu.Unlock()
			if ws == nil {
				fail(req.ID, map[string]any{"code": -32602, "message": "未挂载工作目录。", "data": map[string]any{"kind": "invalid_input", "reason": "not_mounted"}})
				continue
			}
			respond(req.ID, map[string]any{"ok": true, "workspace": ws, "sources": list})

		case "workspace.setPermission":
			f.record(req.Method, req.Params)
			id, _ := params["workspaceId"].(string)
			permission, _ := params["permission"].(string)
			f.mu.Lock()
			var updated api.Workspace
			for i := range f.work {
				if f.work[i].WorkspaceID == id {
					f.work[i].Permission = permission
					updated = f.work[i]
					if f.current != nil && f.current.WorkspaceID == id {
						f.current.Permission = permission
					}
				}
			}
			list := append([]api.Workspace(nil), f.work...)
			f.mu.Unlock()
			respond(req.ID, map[string]any{"ok": true, "workspace": updated, "workspaces": list})

		case "workspace.remove":
			f.record(req.Method, req.Params)
			id, _ := params["workspaceId"].(string)
			f.mu.Lock()
			kept := make([]api.Workspace, 0, len(f.work))
			for _, ws := range f.work {
				if ws.WorkspaceID != id {
					kept = append(kept, ws)
				}
			}
			f.work = kept
			f.mu.Unlock()
			respond(req.ID, map[string]any{"ok": true, "removed_workspace_id": id, "files_deleted": 0, "directory_deleted": false})

		case "artifact.list":
			f.record(req.Method, req.Params)
			f.mu.Lock()
			arts := append([]api.Artifact(nil), f.arts...)
			f.mu.Unlock()
			respond(req.ID, map[string]any{"artifacts": arts})

		case "artifact.read":
			f.record(req.Method, req.Params)
			name, _ := params["name"].(string)
			as, _ := params["as"].(string)
			f.mu.Lock()
			text, ok := f.artText[name]
			f.mu.Unlock()
			if !ok {
				fail(req.ID, map[string]any{"code": -32000, "message": "artifact not found: " + name, "data": map[string]any{"kind": "not_found"}})
				continue
			}
			out := map[string]any{
				"name": name, "path": "/data/outputs/exports/" + name, "size": len(text),
				"modified": "2026-01-01T00:00:00.000Z", "content_type": "text/csv; charset=utf-8",
			}
			if as == "text" {
				out["text"] = text
			}
			respond(req.ID, out)

		default:
			fail(req.ID, map[string]any{"code": -32601, "message": "method not found: " + req.Method})
		}
	}
}

// openDataPanel 启动假服务，切到会话 1 并展开右侧数据面板。
func openDataPanel(t *testing.T, f *sourceFake, width, height int) (*app, *uiQueue, *ui.Tester) {
	t.Helper()
	q := newQueue()
	a := newTestApp(t, q)
	tt := ui.NewTester(a.view, width, height)
	a.onService(f.ready(61))
	a.show(1)
	q.run()
	tt.Frame()
	if err := tt.Click("Data"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the data panel", func() bool { return a.src.loaded && !a.src.loading })
	return a, q, tt
}

func TestDataPanelListsSourcesAndPreviewsTable(t *testing.T) {
	f := newSourceFake(t)
	three := 3
	f.seedSource(
		api.Source{ID: "s_00000001", Name: "sales.csv", Kind: "csv", Active: true, Open: true},
		[]string{"sales"},
		api.SourcePreview{
			SourceName: "sales.csv",
			Tables: []api.PreviewTableInfo{{
				Name: "sales", Columns: []string{"name", "amount"}, TotalRows: &three,
				SourceID: "s_00000001", SourceName: "sales.csv",
			}},
		},
		"CREATE TABLE sales (name VARCHAR, amount BIGINT);",
	)
	a, q, tt := openDataPanel(t, f, 1400, 1100)

	expectTexts(t, tt, []string{
		"sales.csv", "csv", "1 tables · open", "In analysis", "Preview", "Edit", "Remove",
		"Import", "The service sets the limit when the import starts.",
	}, nil)

	if err := tt.Click("Preview"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the table preview", func() bool { return a.src.table != nil })
	expectTexts(t, tt, []string{
		"Preview: sales.csv", "name", "amount", "alpha", "beta", "gamma",
		"3 rows · 2 columns", "Schema", "CREATE TABLE sales",
	}, nil)

	previewParams := f.call("source.preview")
	if previewParams == nil || previewParams["sourceId"] != "s_00000001" || previewParams["conversationId"] != float64(1) {
		t.Errorf("source.preview params: %v", previewParams)
	}
	tableParams := f.call("source.previewTable")
	if tableParams == nil || tableParams["table"] != "sales" || tableParams["sourceId"] != "s_00000001" {
		t.Errorf("source.previewTable params: %v", tableParams)
	}
}

func TestDataPanelTogglesAnalysisAndRemovesWithConfirmation(t *testing.T) {
	f := newSourceFake(t)
	f.seedSource(
		api.Source{ID: "s_00000001", Name: "sales.csv", Kind: "csv", Active: true, Open: true},
		[]string{"sales"},
		api.SourcePreview{SourceName: "sales.csv", Tables: []api.PreviewTableInfo{{Name: "sales", Columns: []string{"a"}}}},
		"schema",
	)
	a, q, tt := openDataPanel(t, f, 1400, 1100)

	// 先打开预览，再用开关验证写操作之后列表与预览都会自己刷新。
	if err := tt.Click("Preview"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the preview", func() bool { return a.src.table != nil })
	before := countMethod(f.methods(), "source.previewTable")

	if err := tt.Click("Use sales.csv in analysis"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the toggle", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return len(f.sources) == 1 && !f.sources[0].Active
	})
	toggle := f.call("source.toggle")
	if toggle == nil || toggle["active"] != false || toggle["sourceId"] != "s_00000001" {
		t.Errorf("source.toggle params: %v", toggle)
	}
	q.pump(t, tt, "the refreshed preview", func() bool {
		return countMethod(f.methods(), "source.previewTable") > before
	})

	if err := tt.Click("Remove"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the confirmation", func() bool { return a.src.confirmOpen })
	expectTexts(t, tt, []string{"Remove this data source?", "Remove source"}, nil)

	if err := tt.Click("Remove source"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the removed source", func() bool { return len(a.src.sources) == 0 })
	remove := f.call("source.remove")
	if remove == nil || remove["sourceId"] != "s_00000001" {
		t.Errorf("source.remove params: %v", remove)
	}
	if got := strings.Join(tt.Texts(), "\n"); !strings.Contains(got, "No data sources yet") {
		t.Errorf("the empty list is not shown after removing the source; texts %q", got)
	}
}

func TestDataPanelUploadsInThreeSteps(t *testing.T) {
	f := newSourceFake(t)
	a, q, tt := openDataPanel(t, f, 1400, 1100)

	dir := t.TempDir()
	path := filepath.Join(dir, "orders.csv")
	content := "id,total\n1,10\n2,20\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	a.uploadFile(path)
	q.pump(t, tt, "the upload", func() bool { return !a.src.uploading && len(a.src.sources) == 1 })

	begin := f.call("source.upload.begin")
	if begin == nil {
		t.Fatal("source.upload.begin was not called")
	}
	if begin["conversationId"] != float64(1) || begin["filename"] != "orders.csv" || begin["size"] != float64(len(content)) {
		t.Errorf("source.upload.begin params: %v", begin)
	}
	open := f.call("source.open")
	if open == nil || open["uploadId"] != strings.Repeat("a", 32) || open["conversationId"] != float64(1) {
		t.Errorf("source.open params: %v", open)
	}
	methods := f.methods()
	beginAt, openAt := indexOfMethod(methods, "source.upload.begin"), indexOfMethod(methods, "source.open")
	if beginAt < 0 || openAt < 0 || beginAt > openAt {
		t.Errorf("the upload calls are out of order: %v", methods)
	}
	f.mu.Lock()
	wroteFile, written := f.fileAtOpen, f.bytesAtOpen
	f.mu.Unlock()
	if !wroteFile {
		t.Fatal("the bytes were not at the staging path when source.open ran")
	}
	if written != content {
		t.Errorf("the staging file holds %q, want %q", written, content)
	}
	if !strings.Contains(strings.Join(tt.Texts(), "\n"), "orders.csv") {
		t.Errorf("the imported source is not listed; texts %q", tt.Texts())
	}
}

func TestDataPanelRejectsOversizeUploadBeforeWriting(t *testing.T) {
	f := newSourceFake(t)
	f.mu.Lock()
	f.maxBytes = 4
	f.mu.Unlock()
	a, q, tt := openDataPanel(t, f, 1400, 1100)

	dir := t.TempDir()
	path := filepath.Join(dir, "big.csv")
	if err := os.WriteFile(path, []byte("much more than four bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.uploadFile(path)
	q.pump(t, tt, "the rejected upload", func() bool { return !a.src.uploading && a.src.uploadErr != "" })

	f.mu.Lock()
	staging := f.lastTicket
	f.mu.Unlock()
	if staging == "" {
		t.Fatal("source.upload.begin was not called: the limit comes from the service")
	}
	if _, err := os.Stat(staging); !os.IsNotExist(err) {
		t.Errorf("the interface wrote the file despite the service limit (stat %v)", err)
	}
	if f.call("source.open") != nil {
		t.Error("source.open ran for a file that was never copied")
	}
	text := strings.Join(tt.Texts(), "\n")
	if !strings.Contains(text, "accepts at most 4 B") {
		t.Errorf("the limit is not explained; texts %q", text)
	}
}

func TestDataPanelExplainsUploadRefusals(t *testing.T) {
	f := newSourceFake(t)
	f.mu.Lock()
	f.uploadErr = map[string]any{
		"code": -32602, "message": "仅支持 .xlsx / .xls / .csv / .pdf 文件",
		"data": map[string]any{"kind": "invalid_input", "reason": "unsupported_format"},
	}
	f.mu.Unlock()
	a, q, tt := openDataPanel(t, f, 1400, 1100)

	dir := t.TempDir()
	path := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(path, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.uploadFile(path)
	q.pump(t, tt, "the refusal", func() bool { return !a.src.uploading && a.src.uploadErr != "" })
	if !strings.Contains(a.src.uploadErr, "Only .csv, .xlsx, .xls and .pdf files can be imported") {
		t.Errorf("the refusal text is %q", a.src.uploadErr)
	}
	if f.call("source.open") != nil {
		t.Error("source.open ran after the service refused the upload")
	}
}

func TestDataPanelMountsWorkspaceWithPermission(t *testing.T) {
	f := newSourceFake(t)
	dir := t.TempDir()
	a, q, tt := openDataPanel(t, f, 1400, 1400)

	if err := tt.Click("Workspace"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("Folder to mount"); err != nil {
		t.Fatal(err)
	}
	tt.Type(dir)
	if err := tt.Click("Workspace permission"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("Read & write"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("Mount"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the mounted folder", func() bool { return a.src.current != nil })
	mount := f.call("workspace.mount")
	if mount == nil || mount["path"] != dir || mount["permission"] != "read_write" {
		t.Errorf("workspace.mount params: %v", mount)
	}
	expectTexts(t, tt, []string{dir, "mounted", "Known folders"}, nil)
}

func TestDataPanelNeverShowsSecrets(t *testing.T) {
	f := newSourceFake(t)
	a, q, tt := openDataPanel(t, f, 1400, 1400)
	const secret = "postgres://user:hunter2pass@db.internal/app"

	if err := tt.Click("Connect"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.ChooseMenuItem("SQL database"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the connection form", func() bool { return a.src.remoteOpen })
	if err := tt.Click("Connection string"); err != nil {
		t.Fatal(err)
	}
	tt.Type(secret)
	if a.src.remoteConn != secret {
		t.Fatalf("the connection field holds %q", a.src.remoteConn)
	}
	if strings.Contains(strings.Join(tt.Texts(), "\n"), secret) {
		t.Fatal("the form showed the connection string")
	}
	if err := tt.Click("Add source"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the connected source", func() bool { return !a.src.remoteBusy && !a.src.remoteOpen })

	params := f.call("source.open")
	if params == nil || params["kind"] != "sql" {
		t.Fatalf("source.open params: %v", params)
	}
	secretFields, _ := params["secret"].(map[string]any)
	if secretFields["connection_string"] != secret {
		t.Errorf("the secret was not sent to the service: %v", params)
	}
	if a.src.remoteConn != "" {
		t.Errorf("the connection string stayed in the form: %q", a.src.remoteConn)
	}
	text := strings.Join(tt.Texts(), "\n")
	if strings.Contains(text, secret) {
		t.Error("the connection string appeared in the panel after connecting")
	}
	if !strings.Contains(text, "Remote sql") {
		t.Errorf("the connected source is not listed; texts %q", text)
	}
}

func TestDataPanelReusesSavedConnectionWithoutItsSecret(t *testing.T) {
	f := newSourceFake(t)
	f.mu.Lock()
	f.configs = []api.SourceConfig{{
		ID: "ds_00000001", Kind: "sql", Name: "Warehouse",
		Fields: map[string]string{}, SecretFields: []string{"connection_string"},
	}}
	f.mu.Unlock()
	a, q, tt := openDataPanel(t, f, 1400, 1400)

	if err := tt.Click("Connect"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.ChooseMenuItem("SQL database"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the connection form", func() bool { return a.src.remoteOpen })
	if err := tt.Click("Saved connection"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("Warehouse"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the saved connection", func() bool { return a.src.remoteConfigID == "ds_00000001" })
	if a.src.remoteConn != "" {
		t.Errorf("a saved secret came back into the form: %q", a.src.remoteConn)
	}
	expectTexts(t, tt, []string{"Warehouse"}, nil)

	if err := tt.Click("Add source"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the reopened source", func() bool { return !a.src.remoteOpen && !a.src.remoteBusy })
	params := f.call("source.open")
	if params == nil || params["configId"] != "ds_00000001" {
		t.Errorf("source.open params: %v", params)
	}
	if _, hasSecret := params["secret"]; hasSecret {
		t.Errorf("the form sent a secret for a saved connection: %v", params)
	}
}

func TestDataPanelPreviewsTextArtifacts(t *testing.T) {
	f := newSourceFake(t)
	f.mu.Lock()
	f.arts = []api.Artifact{{Name: "summary.csv", Path: "/data/outputs/exports/summary.csv", Size: 12, Modified: "2026-01-01T00:00:00.000Z", Root: "exports"}}
	f.artText["summary.csv"] = "group,total\nA,3\n"
	f.mu.Unlock()
	a, q, tt := openDataPanel(t, f, 1400, 1200)

	if err := tt.Click("Artifacts"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"Artifacts", "summary.csv", "exports", "/data/outputs/exports/summary.csv"}, nil)
	if err := tt.Click("Preview"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the artifact text", func() bool { return a.src.artifactLoaded })
	read := f.call("artifact.read")
	if read == nil || read["as"] != "text" || read["name"] != "summary.csv" {
		t.Errorf("artifact.read params: %v", read)
	}
	if !strings.Contains(strings.Join(tt.Texts(), "\n"), "group,total") {
		t.Errorf("the artifact text is not shown; texts %q", tt.Texts())
	}
}

func TestDataPanelSidebarEntryOpensPanel(t *testing.T) {
	f := newSourceFake(t)
	q := newQueue()
	a := newTestApp(t, q)
	tt := ui.NewTester(a.view, 1400, 1100)
	a.onService(f.ready(62))
	a.show(1)
	q.run()
	tt.Frame()

	if err := tt.Click("Data"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the panel from the sidebar", func() bool { return a.src.open && a.src.loaded })
	if a.nav != navOf(1) {
		t.Errorf("the sidebar selection is %q, want the chat", a.nav)
	}
	expectTexts(t, tt, []string{"Hide data", "Sources", "Workspace", "Artifacts"}, nil)
}

func TestDataPanelEditsAnalysisTables(t *testing.T) {
	f := newSourceFake(t)
	f.seedSource(
		api.Source{ID: "s_00000005", Name: "warehouse", Kind: "sql", Active: true, Open: true},
		[]string{"orders", "customers"},
		api.SourcePreview{SourceName: "warehouse", RequiresTableSelection: true, Tables: []api.PreviewTableInfo{
			{Name: "orders", Columns: []string{"id"}, SelectableForAnalysis: true},
			{Name: "customers", Columns: []string{"id"}, SelectableForAnalysis: true},
		}},
		"schema",
	)
	a, q, tt := openDataPanel(t, f, 1400, 1300)

	if err := tt.Click("Edit"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the source editor", func() bool { return a.src.editOpen && !a.src.editBusy })
	expectTexts(t, tt, []string{"Source: warehouse", "sql", "Tables the agent may analyse", "orders", "customers", "Close source"}, nil)

	if err := tt.Click("customers"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if !a.src.editPicked["customers"] {
		t.Fatal("checking a table did not mark it")
	}
	if err := tt.Click("Save tables"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the saved tables", func() bool { return !a.src.editOpen && !a.src.editBusy })
	params := f.call("source.setAnalysisTables")
	if params == nil || params["sourceId"] != "s_00000005" {
		t.Fatalf("source.setAnalysisTables params: %v", params)
	}
	tables, _ := params["tables"].([]any)
	if len(tables) != 1 || tables[0] != "customers" {
		t.Errorf("the chosen tables are %v, want [customers]", tables)
	}
}

// countMethod 数 calls 里 method 出现的次数。
func countMethod(calls []string, method string) int {
	n := 0
	for _, name := range calls {
		if name == method {
			n++
		}
	}
	return n
}

// indexOfMethod 返回 method 在 calls 里第一次出现的位置。
func indexOfMethod(calls []string, method string) int {
	for i, name := range calls {
		if name == method {
			return i
		}
	}
	return -1
}
