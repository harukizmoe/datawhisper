// fakeservice follows the agent service's process contract for the supervisor tests. FAKE_MODE selects how it
// misbehaves:
//
//	ok            print the ready line, serve /v1/health and POST /v1/crash, exit at stdin EOF or SIGTERM
//	noready       never print the ready line
//	exit          exit 3 before the ready line
//	ignore-stdin  as ok, but keep running at stdin EOF (SIGTERM still stops it)
//	ignore-all    as ok, but ignore stdin EOF and SIGTERM (only a kill stops it)
//
// FAKE_FAIL_STARTS=n makes the first n starts exit 3 before the ready line, counted in the file FAKE_COUNT.
// FAKE_STOPPED names a file it writes how it was stopped to: "stdin" or "sigterm".
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
