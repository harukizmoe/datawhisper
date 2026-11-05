package conversation

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// TestProvenanceMatchesTheServerGolden 用服务端的 golden 用例（由原 Python 实现导出）核对：哪些数字没有出处，
// 判断必须与服务端的质量闸门一致，否则界面标出的「无出处」会和服务端的要求对不上。
func TestProvenanceMatchesTheServerGolden(t *testing.T) {
	data, err := os.ReadFile("../../../server/test/golden/number-audit.json")
	if err != nil {
		t.Skipf("no server golden file: %v", err)
	}
	var cases []struct {
		Report      string   `json:"report"`
		Evidence    []string `json:"evidence"`
		Context     []string `json:"context"`
		Unsupported []string `json:"unsupported"`
		Total       int      `json:"total"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	failed := 0
	for i, c := range cases {
		got := unsupportedNumbers(c.Report, c.Evidence, c.Context)
		listed := got
		if len(listed) > 15 {
			listed = listed[:15]
		}
		if len(got) != c.Total || strings.Join(listed, ",") != strings.Join(c.Unsupported, ",") {
			failed++
			if failed <= 10 {
				t.Errorf("case %d: got %v (%d), want %v (%d)\nreport: %.120q", i, listed, len(got), c.Unsupported, c.Total, c.Report)
			}
		}
	}
	if failed > 0 {
		t.Errorf("%d of %d golden cases differ", failed, len(cases))
	}
}

// TestProvenanceAttributesNumbersToTools 断言回答里的数字归到提供它的那次工具调用，无出处的数字单独列出；
// 这一轮没有数据类工具时不核对。
func TestProvenanceAttributesNumbersToTools(t *testing.T) {
	msgs := []Message{
		{Role: "user", Text: "各区域销售额？阈值 150", Done: true},
		{Role: "tool", Done: true, Tool: &ToolCall{Name: "query_data", Args: "sql=select", Output: "华东 270\n华北 200\n华南 140", Status: "ok"}},
		{Role: "tool", Done: true, Tool: &ToolCall{Name: "profile_data", Output: "rows: 3,956", Status: "ok"}},
		{Role: "assistant", Text: "华东 270、华北 200，共 3956 行；合计 610，同比 12%，阈值 150，另有 7777。", Done: true},
	}
	p, ok := ProvenanceOf(msgs, 3)
	if !ok {
		t.Fatal("an answer after query_data was not checked")
	}
	if len(p.Sources) != 2 || p.Sources[0].Tool != "query_data" || strings.Join(p.Sources[0].Numbers, ",") != "270,200" ||
		p.Sources[1].Tool != "profile_data" || strings.Join(p.Sources[1].Numbers, ",") != "3956" {
		t.Errorf("sources %+v", p.Sources)
	}
	// 610 是 270+200+140 的和，但只有两数和差算推导出处：它没有出处；150 来自用户消息，12% 不算数据类数字。
	if strings.Join(p.Unsupported, ",") != "610,7777" {
		t.Errorf("unsupported %v", p.Unsupported)
	}
	if _, ok := ProvenanceOf([]Message{{Role: "user", Text: "hi"}, {Role: "assistant", Text: "共 1234 个", Done: true}}, 1); ok {
		t.Error("an answer without data tools was checked")
	}
}
