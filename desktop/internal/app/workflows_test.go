package app

import (
	"reflect"
	"sync"
	"testing"

	"github.com/egoist/mygo/ui"
)

// fakeWorkflows 是假服务里的工作流部分：一份定义，运行 7 在等审批，运行 5 已经失败；做过的动作会改变之后返回的状态。
type fakeWorkflows struct {
	mu       sync.Mutex
	decided  bool
	decision string
	comment  string
	retried  bool
	removed  bool
}

func (w *fakeWorkflows) serve(method string, params map[string]any) (any, string, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	switch method {
	case "workflow.definitions.list":
		if w.removed {
			return map[string]any{"workflows": []any{}}, "", true
		}
		return map[string]any{"workflows": []any{map[string]any{
			"id": "wf_00000001", "name": "Cleaning plan", "description": "Plan, verify, approve, apply",
			"template": "cleaning_approval", "createdAt": "2026-11-05T07:00:00Z",
		}}}, "", true
	case "workflow.definitions.remove":
		w.removed = true
		return map[string]any{"removed": true}, "", true
	case "workflow.start":
		return map[string]any{"id": 8}, "", true
	case "workflow.runs.list":
		runs := []any{w.run(5), w.run(7)}
		if w.retried {
			runs = append([]any{w.run(9)}, runs...)
		}
		return map[string]any{"runs": runs}, "", true
	case "workflow.runs.get":
		id := int(params["id"].(float64))
		return w.detail(id), "", true
	case "workflow.runs.approve":
		if params["approvalId"] != "ap_1" {
			return nil, "workflow approval not found", true
		}
		w.decided = true
		w.decision, _ = params["decision"].(string)
		w.comment, _ = params["comment"].(string)
		return w.detail(7), "", true
	case "workflow.runs.retry":
		w.retried = true
		return map[string]any{"id": 9}, "", true
	}
	return nil, "", false
}

func (w *fakeWorkflows) run(id int) map[string]any {
	run := map[string]any{"id": id, "workflowVersionId": "wf_00000001", "conversationId": 4, "createdAt": "2026-11-05T08:00:00Z", "endedAt": nil, "failure": nil, "retryOf": nil}
	switch id {
	case 7:
		run["status"] = "waiting_approval"
		if w.decided {
			run["status"] = "succeeded"
		}
	case 5:
		run["status"] = "failed"
		run["failure"] = map[string]any{"code": "workflow_node_failed", "message": "one or more workflow nodes failed"}
	case 9:
		run["status"] = "running"
		run["retryOf"] = map[string]any{"runId": 5, "nodeId": "clean"}
	}
	return run
}

func (w *fakeWorkflows) detail(id int) map[string]any {
	d := w.run(id)
	switch id {
	case 7:
		status := "waiting_approval"
		if w.decided {
			status = "succeeded"
		}
		approval := map[string]any{
			"id": "ap_1", "nodeId": "plan", "kind": "key_approval", "reason": "needs approval",
			"output": map[string]any{"plan": "drop 3 rows", "note": "n"}, "comment": w.comment,
		}
		if w.decided {
			approval["decision"] = w.decision
		}
		d["nodes"] = []any{map[string]any{"nodeId": "plan", "nodeRunId": 21, "status": status, "iteration": 1, "attempt": 1, "output": map[string]any{"plan": "drop 3 rows", "note": "n"}, "error": "", "reused": false}}
		d["approvals"] = []any{approval}
	case 5:
		d["nodes"] = []any{
			map[string]any{"nodeId": "load", "nodeRunId": 31, "status": "succeeded", "iteration": 1, "attempt": 1, "output": map[string]any{"rows": 3}, "error": "", "reused": false},
			map[string]any{"nodeId": "clean", "nodeRunId": 32, "status": "failed", "iteration": 1, "attempt": 2, "output": nil, "error": "warehouse offline", "reused": false},
		}
		d["approvals"] = []any{}
	default:
		d["nodes"] = []any{map[string]any{"nodeId": "load", "nodeRunId": nil, "status": "succeeded", "iteration": 1, "attempt": 1, "output": map[string]any{"rows": 3}, "error": "", "reused": true}}
		d["approvals"] = []any{}
	}
	return d
}

// openWorkflowRuns 打开带工作流的假服务和「运行」标签，等第一次加载完成。
func openWorkflowRuns(t *testing.T) (*fakeService, *uiQueue, *app, *ui.Tester) {
	t.Helper()
	fs := newFakeService(t)
	fs.workflows = &fakeWorkflows{}
	q := newQueue()
	a := &app{post: q.post}
	tt := ui.NewTester(a.view, 1400, 1400)
	openRichChat(t, fs, q, a, tt)
	a.toggleSources()
	a.src.tab = sourcesTabRuns
	q.pump(t, tt, "the runs", func() bool { return a.src.runs.loaded })
	return fs, q, a, tt
}

// TestWorkflowApprovalWithEdits 断言待批的运行排在最前、展开后能看到审批卡片；输出没改就点「Apply edits」会被拦下，
// 改了之后只把改过的键发给服务，决定生效后卡片变成一行记录。
func TestWorkflowApprovalWithEdits(t *testing.T) {
	fs, q, a, tt := openWorkflowRuns(t)
	expectTexts(t, tt, []string{"Saved workflows", "Cleaning plan", "Workflow runs", "Waiting for approval", "Failed"}, nil)
	if got := a.src.runs.workflows[0].ID; got != 7 {
		t.Fatalf("the run waiting for approval is not pinned first: %+v", a.src.runs.workflows)
	}

	if err := tt.Click("Details"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the run detail", func() bool { return a.src.runs.wf.detail != nil })
	expectTexts(t, tt, []string{"Steps", "plan finished. Its output needs your approval before the next steps run.", "Approve", "Apply edits", "Rework", "Stop run"}, nil)

	if err := tt.Click("Apply edits"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"Nothing changed. Edit a value first, or choose Approve."}, nil)
	if got := fs.callsTo("workflow.runs.approve"); len(got) != 0 {
		t.Fatalf("an unchanged output was sent: %v", got)
	}

	a.src.runs.wf.inputs["ap_1"].output = `{"plan": "drop 2 rows", "note": "n"}`
	tt.Frame() // 输出框变矮、按钮上移；先重排，点击才落在按钮上
	if err := tt.Click("Apply edits"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the decision", func() bool { return len(fs.callsTo("workflow.runs.approve")) > 0 })
	got := fs.callsTo("workflow.runs.approve")[0]
	want := map[string]any{"id": float64(7), "approvalId": "ap_1", "decision": "approve_with_changes", "comment": "", "changes": map[string]any{"plan": "drop 2 rows"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("approve params %v, want %v", got, want)
	}
	q.pump(t, tt, "the refreshed detail", func() bool {
		d := a.src.runs.wf.detail
		return d != nil && len(d.Approvals) > 0 && !d.Approvals[0].Pending()
	})
	expectTexts(t, tt, []string{"ap_1 · plan: approved with changes"}, []string{"Apply edits"})
}

// TestDataPanelDividerDragPersists 断言拖动分栏后新的比值写回 a.src.split：布局每帧用的是
// 夹过最小面板宽度的局部值，不写回的话下一帧会弹回去。
func TestDataPanelDividerDragPersists(t *testing.T) {
	_, _, a, tt := openWorkflowRuns(t)
	before := a.src.split
	rect, ok := tt.Find("Divider")
	if !ok {
		t.Fatal("no divider")
	}
	x, y := rect.X+rect.W/2, rect.Y+rect.H/2
	tt.Press(x, y)
	tt.Move(x-80, y)
	tt.Release(x-80, y)
	tt.Frame()
	if a.src.split == before {
		t.Errorf("drag left the split at %v", before)
	}
}

// TestWorkflowReworkCarriesTheComment 断言「Rework」把意见框里的话交给服务；只有 key 审批才有「Approve」。
func TestWorkflowReworkCarriesTheComment(t *testing.T) {
	fs, q, a, tt := openWorkflowRuns(t)
	if err := tt.Click("Details"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the run detail", func() bool { return a.src.runs.wf.detail != nil })
	a.src.runs.wf.inputs["ap_1"].comment = "add a rollback step"
	tt.Frame()
	if err := tt.Click("Rework"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the decision", func() bool { return len(fs.callsTo("workflow.runs.approve")) > 0 })
	got := fs.callsTo("workflow.runs.approve")[0]
	if got["decision"] != "reject_and_retry" || got["comment"] != "add a rollback step" {
		t.Errorf("rework params %v", got)
	}
	if _, has := got["changes"]; has {
		t.Errorf("a rework sent changes: %v", got)
	}
}

// TestWorkflowRetryFromTheFailedNode 断言失败运行里最后失败的节点有「Retry」，点了向服务要重试，并展开新的运行。
func TestWorkflowRetryFromTheFailedNode(t *testing.T) {
	fs, q, a, tt := openWorkflowRuns(t)
	a.toggleRunDetail(5)
	q.pump(t, tt, "the failed run's detail", func() bool { return a.src.runs.wf.detail != nil })
	expectTexts(t, tt, []string{"warehouse offline", "load", "clean", "attempt 2", "Retry"}, nil)

	if err := tt.Click("Retry"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the retried run", func() bool {
		return a.src.runs.wf.open == 9 && a.src.runs.wf.detail != nil && a.src.runs.wf.detail.ID == 9
	})
	got := fs.callsTo("workflow.runs.retry")
	if len(got) != 1 || got[0]["id"] != float64(5) || got[0]["nodeRunId"] != float64(32) {
		t.Errorf("retry params %v", got)
	}
	expectTexts(t, tt, []string{"Retry of run #5 from clean", "reused"}, nil)
}

// TestWorkflowDefinitionsRunAndDelete 断言定义能在当前对话里运行，删除要先确认。
func TestWorkflowDefinitionsRunAndDelete(t *testing.T) {
	fs, q, a, tt := openWorkflowRuns(t)
	if err := tt.Click("Run"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the start", func() bool { return len(fs.callsTo("workflow.start")) > 0 })
	if got := fs.callsTo("workflow.start")[0]; got["workflowId"] != "wf_00000001" || got["conversationId"] != float64(4) {
		t.Errorf("start params %v", got)
	}

	if err := tt.Click("Delete"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	expectTexts(t, tt, []string{"Delete this workflow?"}, nil)
	if got := fs.callsTo("workflow.definitions.remove"); len(got) != 0 {
		t.Fatalf("deleted without confirming: %v", got)
	}
	if err := tt.Click("Delete workflow"); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the removal", func() bool { return len(a.src.runs.wf.definitions) == 0 && a.src.runs.wf.deleting == nil })
	if got := fs.callsTo("workflow.definitions.remove"); len(got) != 1 || got[0]["id"] != "wf_00000001" {
		t.Errorf("remove params %v", got)
	}
}
