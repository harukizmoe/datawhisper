//go:build !windows

package main

// Live 测试：在真正的 supervisor 下跑真正的 agent 服务（server/test/support/stub-service.ts：该服务只带一个
// 进程内 stub 模型作为提供方）。它们需要 bun 以及服务的依赖（cd server && bun install），缺了就跳过。不在
// Windows 上跑：它们用 SIGKILL 杀服务。

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"syscall"
	"testing"
	"time"

	"datawhisper/desktop/internal/api"
	"datawhisper/desktop/internal/supervisor"
	"github.com/egoist/mygo/ui"
)

// stubService 返回用 stub 模型运行该服务的命令。
func stubService(t *testing.T) []string {
	t.Helper()
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("bun is not on PATH")
	}
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "server", "node_modules")); err != nil {
		t.Skip("the server's dependencies are not installed (cd server && bun install)")
	}
	return []string{bun, "run", filepath.Join(root, "server", "test", "support", "stub-service.ts")}
}

// startSupervised 在 supervisor 下启动 stub 服务，状态变化上报给 onState，测试结束后把它停掉。
func startSupervised(t *testing.T, onState func(supervisor.Status)) *supervisor.Supervisor {
	t.Helper()
	sup, err := supervisor.New(supervisor.Config{
		Command: stubService(t),
		DataDir: t.TempDir(),
		// 约 25 个 20 ms 的 chunk：回复会流式输出 500 ms，超过 pi-durable 的 100 ms partial 提交间隔。
		Env:     []string{"STUB_CHUNK_MS=20"},
		OnState: onState,
	})
	if err != nil {
		t.Fatal(err)
	}
	sup.Start()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := sup.Stop(ctx); err != nil {
			t.Errorf("stop: %v", err)
		}
	})
	return sup
}

// next 从 states 中返回下一个状态 want；那一分钟的上限只是把卡死变成失败。
func next(t *testing.T, states <-chan supervisor.Status, want supervisor.State) supervisor.Status {
	t.Helper()
	guard := time.NewTimer(time.Minute)
	defer guard.Stop()
	for {
		select {
		case st := <-states:
			if st.State == want {
				return st
			}
			if st.State == supervisor.StateFailed {
				t.Fatalf("service failed: %v", st.Err)
			}
		case <-guard.C:
			t.Fatalf("no %v state in a minute", want)
		}
	}
}

func snapshotJSON(t *testing.T, c *api.Client, conv string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	var view any
	errDone := errorString("snapshot taken")
	err := c.Subscribe(ctx, conv, func(ev api.Event) error {
		view = ev.View
		return errDone
	})
	if err != errDone {
		t.Fatalf("subscribe %s: %v", conv, err)
	}
	b, _ := json.Marshal(view)
	return string(b)
}

type errorString string

func (e errorString) Error() string { return string(e) }

// TestLiveReplicaMatchesTheService 在回复流式输出期间，用 snapshot 和 ops 复制一个会话，并检查新取的 snapshot
// 与副本一致；在服务被杀掉、并用同一份数据重启之后也一样。
func TestLiveReplicaMatchesTheService(t *testing.T) {
	states := make(chan supervisor.Status, 64)
	sup := startSupervised(t, func(st supervisor.Status) { states <- st })
	ready := next(t, states, supervisor.StateReady)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	client := api.New(ready.Port, sup.Token())
	id, err := client.CreateConversation(ctx, api.CreateConversationRequest{})
	if err != nil {
		t.Fatal(err)
	}
	conv := strconv.Itoa(id)

	events := make(chan api.Event, 4096)
	subCtx, stopSub := context.WithCancel(ctx)
	defer stopSub()
	go func() { _ = client.Subscribe(subCtx, conv, func(ev api.Event) error { events <- ev; return nil }) }()
	var replica api.Replica
	if err := replica.Apply(<-events); err != nil {
		t.Fatal(err)
	}
	sent, err := client.Submit(ctx, conv, api.SubmitRequest{RequestID: "live-1", Text: "Summarize the data"})
	if err != nil {
		t.Fatal(err)
	}
	opsEvents, streamed := 0, false
	for {
		var ev api.Event
		select {
		case ev = <-events:
		case <-ctx.Done():
			t.Fatalf("reply not finished; replica state %+v", replica.State())
		}
		if err := replica.Apply(ev); err != nil {
			t.Fatalf("seq %d: %v", ev.Seq, err)
		}
		opsEvents++
		st := replica.State()
		n := len(st.Messages)
		if n > 0 && st.Messages[n-1].Role == "assistant" && !st.Messages[n-1].Done {
			streamed = true
		}
		if !st.Busy && n == 2 && st.Messages[1].Done {
			break
		}
	}
	stopSub()
	st := replica.State()
	if !streamed || st.Messages[0].Text != "Summarize the data" || st.Model == nil || st.Model.Provider != "custom-stub" {
		t.Errorf("streamed %t, state %+v", streamed, st)
	}
	want, _ := json.Marshal(replica.Tree)
	if got := snapshotJSON(t, client, conv); got != string(want) {
		t.Fatalf("after %d ops events the replica differs from a fresh snapshot\nreplica:  %.600s\nsnapshot: %.600s", opsEvents, want, got)
	}

	if err := syscall.Kill(ready.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	restarting := next(t, states, supervisor.StateRestarting)
	again := next(t, states, supervisor.StateReady)
	client = api.New(again.Port, sup.Token())
	if got := snapshotJSON(t, client, conv); got != string(want) {
		t.Fatalf("after the restart (%v) the service's view differs from the replica\nreplica:  %.600s\nsnapshot: %.600s", restarting.Err, want, got)
	}
	resent, err := client.Submit(ctx, conv, api.SubmitRequest{RequestID: "live-1", Text: "Summarize the data"})
	if err != nil || resent.SubmissionID != sent.SubmissionID {
		t.Errorf("the same request id after the restart: %+v %v, first %+v", resent, err, sent)
	}
	t.Logf("%d ops events; replica == snapshot (%d bytes), before and after a SIGKILL restart (%v)", opsEvents, len(want), restarting.Err)
}

// TestLiveAppSurvivesAServiceKill 让 app 的视图跑在真正的服务上：新对话的消息会流式收到回复；杀掉服务会显示重启
// 横幅，而 app 会连上重启后的服务，还是同一个会话，并且继续可用。
func TestLiveAppSurvivesAServiceKill(t *testing.T) {
	q := newQueue()
	a := newTestApp(t, q)
	sup := startSupervised(t, func(st supervisor.Status) { a.post(func() { a.onService(st) }) })
	a.token, a.retry, a.logPath = sup.Token(), sup.Retry, sup.LogPath()
	tt := ui.NewTester(a.view, 1180, 760)
	q.pump(t, tt, "the ready service", func() bool { return a.service.State == supervisor.StateReady && a.listLoaded })
	expectTexts(t, tt, []string{"Ready", "No conversations yet"}, []string{"Starting the agent service"})

	sendAndWait := func(text string, rows int) {
		t.Helper()
		if err := tt.Click("Message"); err != nil {
			t.Fatal(err)
		}
		tt.Type(text)
		if err := tt.Click("Send"); err != nil {
			t.Fatal(err)
		}
		q.pump(t, tt, "the reply to "+text, func() bool {
			m := a.chat.Messages
			return a.connected && !a.chat.Busy && len(m) == rows && m[rows-1].Role == "assistant" && m[rows-1].Done
		})
		if a.sendErr != "" {
			t.Errorf("send %q: %s", text, a.sendErr)
		}
		tt.Advance(2 * time.Second) // 回复的浮现动画跑在 tester 的时钟上
	}
	sendAndWait("Summarize the data", 2)
	expectTexts(t, tt, []string{"Summarize the data", "Hello", "streamed", "metric", "custom-stub/stub-chat", "Chat " + strconv.Itoa(a.conv)}, nil)
	before := append([]api.Message(nil), a.chat.Messages...)
	conv, pid := a.conv, a.service.PID

	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	q.pump(t, tt, "the restart banner", func() bool { return a.service.State == supervisor.StateRestarting })
	expectTexts(t, tt, []string{"The agent service stopped (service exited: signal: killed). Restarting it…", "Restarting"}, nil)
	q.pump(t, tt, "the recovered conversation", func() bool {
		return a.service.State == supervisor.StateReady && a.connected
	})
	expectTexts(t, tt, []string{"Reconnected", "Ready", "Summarize the data", "Hello"}, []string{"Restarting it…"})
	if a.conv != conv || a.service.PID == pid || !reflect.DeepEqual(a.chat.Messages, before) {
		t.Errorf("after the restart: conversation %d (was %d), pid %d (was %d), rows equal %t", a.conv, conv, a.service.PID, pid, reflect.DeepEqual(a.chat.Messages, before))
	}

	sendAndWait("And once more", 4)
	expectTexts(t, tt, []string{"And once more"}, nil)
}
