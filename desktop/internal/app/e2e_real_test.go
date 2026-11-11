package app

// 真实 server 的端到端冒烟：拉起 `bun run src/main.ts`（它自己再拉起 compute），用一根本地管道接到界面，
// 发一句话，要求屏幕上出现模型回复。
//
// 模型由测试内的 OpenAI 兼容桩提供（`/v1/models` + 流式 `/v1/chat/completions`），所以不联网、不需要密钥。
// 默认跳过：桌面端的 CI 任务没有 bun 与 Python 环境，只有显式设置 DW_E2E_REAL=1 时才跑（本地开发用）。
//
//	go test ./internal/app -run TestRealServerEndToEnd -v   # 需要 DW_E2E_REAL=1

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"datawhisper/desktop/internal/supervisor"
	"github.com/egoist/mygo/ui"
)

// processPipe 是子进程的 stdin/stdout，实现 supervisor.Pipe。
type processPipe struct {
	in   io.WriteCloser
	out  io.Reader
	done chan struct{}
	err  error
	once sync.Once
}

func (p *processPipe) Read(b []byte) (int, error)  { return p.out.Read(b) }
func (p *processPipe) Write(b []byte) (int, error) { return p.in.Write(b) }
func (p *processPipe) Close() error                { return p.in.Close() }
func (p *processPipe) Done() <-chan struct{}       { return p.done }
func (p *processPipe) Wait() error {
	<-p.done
	return p.err
}

func (p *processPipe) finish(err error) {
	p.once.Do(func() {
		p.err = err
		close(p.done)
	})
}

// findRepoRoot 从测试的工作目录往上找 `server/src/main.ts`。
func findRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, statErr := os.Stat(filepath.Join(dir, "server", "src", "main.ts")); statErr == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("找不到仓库根目录（server/src/main.ts）")
		}
		dir = parent
	}
}

// stubProvider 是一个最小的 OpenAI 兼容服务：模型列表固定一个，回复固定一句话并带用量。
func stubProvider(t *testing.T, want string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"stub-chat","object":"model","owned_by":"test"}]}`))
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		chunks := []string{
			`{"id":"c1","object":"chat.completion.chunk","created":1,"model":"stub-chat","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
			fmt.Sprintf(`{"id":"c1","object":"chat.completion.chunk","created":1,"model":"stub-chat","choices":[{"index":0,"delta":{"content":%q},"finish_reason":null}]}`, want),
			`{"id":"c1","object":"chat.completion.chunk","created":1,"model":"stub-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":6,"total_tokens":18}}`,
		}
		for _, chunk := range chunks {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", chunk)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	})
	return httptest.NewServer(mux)
}

func TestRealServerEndToEnd(t *testing.T) {
	if os.Getenv("DW_E2E_REAL") != "1" {
		t.Skip("设置 DW_E2E_REAL=1 才跑真实 server 的端到端冒烟（需要 bun 与 Python 环境）")
	}
	if _, err := exec.LookPath("bun"); err != nil {
		t.Skip("没有 bun，跳过真实 server 冒烟")
	}
	repo := findRepoRoot(t)
	answer := "端到端冒烟通过"
	provider := stubProvider(t, answer)
	defer provider.Close()

	dataDir := t.TempDir()
	models := map[string]any{
		"version": 1,
		"providers": []any{map[string]any{
			"kind": "custom", "id": "stub", "name": "Stub", "baseUrl": provider.URL + "/v1",
			"requiresKey": false, "enabled": true,
			"models": []any{map[string]any{
				"id": "stub-chat", "name": "stub-chat", "contextWindow": 8192, "maxTokens": 512, "reasoning": false,
			}},
		}},
		"defaultModel": map[string]any{"provider": "stub", "modelId": "stub-chat"},
	}
	encoded, err := json.Marshal(models)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "models.json"), encoded, 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("bun", "run", "src/main.ts")
	cmd.Dir = filepath.Join(repo, "server")
	cmd.Env = append(os.Environ(), "DW_DATA_DIR="+dataDir)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pipe := &processPipe{in: stdin, out: stdout, done: make(chan struct{})}
	go func() { pipe.finish(cmd.Wait()) }()
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
	})

	// 服务先打印一行 `ready`，客户端不该看到它：从这一行之后开始读。
	ready := make(chan struct{})
	reader, writer := io.Pipe()
	go func() {
		lines := bufio.NewReader(stdout)
		for {
			line, readErr := lines.ReadString('\n')
			if strings.Contains(line, `"ready"`) {
				close(ready)
				break
			}
			if readErr != nil {
				_ = writer.CloseWithError(fmt.Errorf("server 没打印 ready 就退出了：%v，stderr: %s", readErr, stderr.String()))
				return
			}
		}
		_, _ = io.Copy(writer, lines)
		_ = writer.Close()
	}()
	select {
	case <-ready:
	case <-time.After(60 * time.Second):
		t.Fatalf("60 秒内没等到 ready；stderr: %s", stderr.String())
	}
	pipe.out = reader

	q := newQueue()
	a := newTestApp(t, q)
	tt := ui.NewTester(a.view, 1400, 1000)
	a.onService(supervisor.Status{State: supervisor.StateReady, Pipe: pipe, PID: cmd.Process.Pid})
	q.run()
	tt.Frame()

	start := time.Now()
	a.input = "你好"
	a.send()
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		q.run()
		tt.Frame()
		for _, message := range a.chat.Messages {
			if message.Role == "assistant" && strings.Contains(message.Text, answer) {
				if a.conv == 0 {
					t.Error("回复到了但界面还不知道对话 id")
				}
				t.Logf("收到回复用了 %s；消息 %d 条", time.Since(start), len(a.chat.Messages))
				return
			}
		}
		if a.chat.Failure != "" {
			t.Fatalf("这一轮失败了：%s；stderr: %s", a.chat.Failure, stderr.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("90 秒内没看到回复；messages=%d stderr: %s", len(a.chat.Messages), stderr.String())
}
