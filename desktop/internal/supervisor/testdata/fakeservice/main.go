// fakeservice 遵循 agent 服务的进程约定，供 supervisor 的测试使用。FAKE_MODE 选择它怎么出问题：
//
//	ok            打印 ready 行，提供 /v1/health 和 POST /v1/crash，在 stdin EOF 或 SIGTERM 时退出
//	noready       永远不打印 ready 行
//	exit          在 ready 行之前以 3 退出
//	ignore-stdin  同 ok，但在 stdin EOF 后继续运行（SIGTERM 仍能停掉它）
//	ignore-all    同 ok，但忽略 stdin EOF 和 SIGTERM（只有 kill 能停掉它）
//
// FAKE_FAIL_STARTS=n 让前 n 次启动在 ready 行之前以 3 退出，次数记在 FAKE_COUNT 指向的文件里。
// FAKE_STOPPED 指向它用来记录停止方式的文件："stdin" 或 "sigterm"。
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
)

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
		select {}
	}

	token := os.Getenv("DW_TOKEN")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "dataDir": os.Getenv("DW_DATA_DIR"), "port": os.Getenv("DW_PORT")})
	})
	mux.HandleFunc("POST /v1/crash", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(os.Stderr, "fake: crashing on request")
		os.Exit(2)
	})
	go func() { _ = http.Serve(ln, mux) }()
	fmt.Println("a log line before the ready line")
	ready, _ := json.Marshal(map[string]any{"type": "ready", "port": ln.Addr().(*net.TCPAddr).Port, "pid": os.Getpid()})
	fmt.Println(string(ready))
	fmt.Println("a log line after the ready line")

	stopped := func(how string) {
		if path := os.Getenv("FAKE_STOPPED"); path != "" {
			_ = os.WriteFile(path, []byte(how), 0o644)
		}
		os.Exit(0)
	}
	signals := make(chan os.Signal, 1)
	if mode == "ignore-all" {
		signal.Ignore(syscall.SIGTERM)
	} else {
		signal.Notify(signals, syscall.SIGTERM)
	}
	eof := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		close(eof)
	}()
	for {
		select {
		case <-eof:
			if mode == "ok" {
				stopped("stdin")
			}
			eof = nil
		case <-signals:
			stopped("sigterm")
		}
	}
}
