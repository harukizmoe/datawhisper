// fakeservice 遵循 agent 服务的进程约定，供 supervisor 的测试使用：stdout 的第一行是 ready 记录，之后
// 只承载 JSONL JSON-RPC 记录；日志走 stderr。FAKE_MODE 选择它怎么出问题：
//
//	ok            打印 ready 行，响应 health，在 stdin EOF 或 SIGTERM 时退出
//	noready       永远不打印 ready 行
//	exit          在 ready 行之前以 3 退出
//	ignore-stdin  同 ok，但在 stdin EOF 后继续运行（SIGTERM 仍能停掉它）
//	ignore-all    同 ok，但忽略 stdin EOF 和 SIGTERM（只有 kill 能停掉它）
//
// 另有 crash 方法：记录一次崩溃后以 2 退出，用来模拟运行期间崩溃。
// FAKE_FAIL_STARTS=n 让前 n 次启动在 ready 行之前以 3 退出，次数记在 FAKE_COUNT 指向的文件里。
// FAKE_STOPPED 指向它用来记录停止方式的文件："stdin" 或 "sigterm"。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

type rpcRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
}

func write(out io.Writer, record map[string]any) {
	line, _ := json.Marshal(record)
	_, _ = fmt.Fprintf(out, "%s\n", line)
}

// serve 响应 stdin 上的请求，直到 EOF。
func serve(out io.Writer) {
	input := bufio.NewReader(os.Stdin)
	for {
		line, err := input.ReadString('\n')
		if err != nil {
			return
		}
		var req rpcRequest
		if json.Unmarshal([]byte(line), &req) != nil || req.Method == "" {
			continue
		}
		switch req.Method {
		case "health":
			write(out, map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"ok":          true,
					"scheduling":  "idle",
					"tasks":       0,
					"submissions": 0,
					"computePid":  nil,
					"dataDir":     os.Getenv("DW_DATA_DIR"),
					"pid":         os.Getpid(),
				},
			})
		case "crash":
			fmt.Fprintln(os.Stderr, "fake: crashing on request")
			os.Exit(2)
		default:
			write(out, map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"error":   map[string]any{"code": -32601, "message": "method not found: " + req.Method},
			})
		}
	}
}

func main() {
	mode := os.Getenv("FAKE_MODE")
	fmt.Fprintln(os.Stderr, "fake: starting", mode)
	if n, _ := strconv.Atoi(os.Getenv("FAKE_FAIL_STARTS")); n > 0 {
		path := os.Getenv("FAKE_COUNT")
		b, _ := os.ReadFile(path)
		count, _ := strconv.Atoi(string(b))
		count++
		_ = os.WriteFile(path, []byte(strconv.Itoa(count)), 0o644)
		if count <= n {
			fmt.Fprintln(os.Stderr, "fake: failing start", count)
			os.Exit(3)
		}
	}
	switch mode {
	case "exit":
		os.Exit(3)
	case "noready":
		// 睡而不是 `select {}`：空 select 会被运行时判成死锁并 panic。
		time.Sleep(24 * time.Hour)
	}

	// 先装信号处理器再打印 ready：父进程一看到 ready 就可能发 SIGTERM。
	signals := make(chan os.Signal, 1)
	if mode == "ignore-all" {
		signal.Ignore(syscall.SIGTERM)
	} else {
		signal.Notify(signals, syscall.SIGTERM)
	}
	stopped := func(how string) {
		if path := os.Getenv("FAKE_STOPPED"); path != "" {
			_ = os.WriteFile(path, []byte(how), 0o644)
		}
		os.Exit(0)
	}

	ready, _ := json.Marshal(map[string]any{"type": "ready", "pid": os.Getpid()})
	fmt.Println(string(ready))
	fmt.Fprintln(os.Stderr, "fake: a log line after the ready line")

	if mode != "ignore-stdin" {
		go func() {
			<-signals
			stopped("sigterm")
		}()
		serve(os.Stdout)
		if mode == "ignore-all" {
			// 连 stdin EOF 也不理：只有 kill 能停掉它。
			time.Sleep(24 * time.Hour)
		}
		stopped("stdin")
	}
	<-signals
	stopped("sigterm")
}
