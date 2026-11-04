package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

var fakeBin string

// TestMain builds testdata/fakeservice once for every test.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "dw-fakeservice-")
	if err != nil {
		panic(err)
	}
	fakeBin = filepath.Join(dir, "fakeservice")
	if runtime.GOOS == "windows" {
		fakeBin += ".exe"
	}
	build := exec.Command("go", "build", "-o", fakeBin, "./testdata/fakeservice")
	build.Stdout, build.Stderr = os.Stdout, os.Stderr
	if err := build.Run(); err != nil {
		panic(fmt.Sprintf("build fakeservice: %v", err))
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// recorder collects state changes; wait blocks until one matches. Its one-minute guard only turns a hang into a
// failure: every wait is for an event the supervisor produces.
type recorder struct {
	mu     sync.Mutex
	states []Status
	cond   *sync.Cond
}

func newRecorder() *recorder {
	r := &recorder{}
	r.cond = sync.NewCond(&r.mu)
	return r
}

func (r *recorder) on(st Status) {
	r.mu.Lock()
	r.states = append(r.states, st)
	r.mu.Unlock()
	r.cond.Broadcast()
}

// wait returns the first state at index >= from in want, and its index.
func (r *recorder) wait(t *testing.T, from int, want State) (Status, int) {
	t.Helper()
	timer := time.AfterFunc(time.Minute, r.cond.Broadcast)
	defer timer.Stop()
	deadline := time.Now().Add(time.Minute)
	r.mu.Lock()
	defer r.mu.Unlock()
	for {
		for i := from; i < len(r.states); i++ {
			if r.states[i].State == want {
				return r.states[i], i
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no %v state; got %v", want, r.kinds())
		}
		r.cond.Wait()
	}
}

func (r *recorder) kinds() []string {
	var out []string
	for _, st := range r.states {
		out = append(out, st.State.String())
	}
	return out
}

func (r *recorder) snapshot() []Status {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Status(nil), r.states...)
}

type fixture struct {
	sup     *Supervisor
	rec     *recorder
	dataDir string
	stopped string
	delays  []time.Duration
}

func start(t *testing.T, env []string, tune func(*Config)) *fixture {
	t.Helper()
	f := &fixture{rec: newRecorder(), dataDir: t.TempDir()}
	f.stopped = filepath.Join(f.dataDir, "stopped")
	cfg := Config{
		Command:        []string{fakeBin},
		DataDir:        f.dataDir,
		Env:            append([]string{"FAKE_STOPPED=" + f.stopped, "FAKE_COUNT=" + filepath.Join(f.dataDir, "count")}, env...),
		BackoffInitial: 100 * time.Millisecond,
		BackoffMax:     time.Second,
		OnState:        f.rec.on,
	}
	if tune != nil {
		tune(&cfg)
	}
	sup, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	sup.sleep = func(d time.Duration) { // record the backoff instead of waiting it out
		mu.Lock()
		f.delays = append(f.delays, d)
		mu.Unlock()
	}
	f.sup = sup
	sup.Start()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		_ = sup.Stop(ctx)
	})
	return f
}

func (f *fixture) health(t *testing.T, port int, token string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/v1/health", port), nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(res.Body).Decode(&body)
	return res.StatusCode, body
}

func stop(t *testing.T, sup *Supervisor) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := sup.Stop(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestReadyHealthLogsAndGracefulStop(t *testing.T) {
	f := start(t, []string{"FAKE_MODE=ok"}, nil)
	ready, _ := f.rec.wait(t, 0, StateReady)
	if ready.Port == 0 || ready.PID == 0 {
		t.Fatalf("ready without port/pid: %+v", ready)
	}
	if len(f.sup.Token()) != 43 {
		t.Errorf("token %q is not 32 bytes base64url", f.sup.Token())
	}
	if code, _ := f.health(t, ready.Port, ""); code != http.StatusUnauthorized {
		t.Errorf("health without token: %d", code)
	}
	code, body := f.health(t, ready.Port, f.sup.Token())
	if code != http.StatusOK || body["dataDir"] != f.dataDir || body["port"] != "0" {
		t.Errorf("health: %d %v", code, body)
	}
	stop(t, f.sup)
	if got := f.rec.kinds(); strings.Join(got, ",") != "starting,ready,stopped" {
		t.Errorf("states %v", got)
	}
	if how, _ := os.ReadFile(f.stopped); string(how) != "stdin" {
		t.Errorf("stopped by %q, want stdin", how)
	}
	log, err := os.ReadFile(f.sup.LogPath())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"[stderr] fake: starting ok", "[stdout] a log line before the ready line", "[stdout] a log line after the ready line", "stopped (stdin closed)"} {
		if !strings.Contains(string(log), want) {
			t.Errorf("log lacks %q:\n%s", want, log)
		}
	}
	if strings.Contains(string(log), `"type":"ready"`) || strings.Contains(string(log), f.sup.Token()) {
		t.Errorf("log holds the ready line or the token:\n%s", log)
	}
}

func TestReadyTimeoutEndsFailed(t *testing.T) {
	f := start(t, []string{"FAKE_MODE=noready"}, func(c *Config) {
		c.ReadyTimeout = 200 * time.Millisecond
		c.CrashLimit = 2
	})
	failed, _ := f.rec.wait(t, 0, StateFailed)
	if failed.Err == nil || !strings.Contains(failed.Err.Error(), "no ready line within 200ms") || failed.Crashes != 2 {
		t.Errorf("failed: %+v", failed)
	}
	if got := strings.Join(f.rec.kinds(), ","); got != "starting,restarting,failed" {
		t.Errorf("states %s", got)
	}
}

func TestRestartWithBackoffUntilReady(t *testing.T) {
	f := start(t, []string{"FAKE_MODE=ok", "FAKE_FAIL_STARTS=3"}, nil)
	ready, _ := f.rec.wait(t, 0, StateReady)
	if ready.Crashes != 3 {
		t.Errorf("ready after %d crashes, want 3", ready.Crashes)
	}
	want := []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond}
	if fmt.Sprint(f.delays) != fmt.Sprint(want) {
		t.Errorf("backoff %v, want %v", f.delays, want)
	}
	for _, st := range f.rec.snapshot() {
		if st.State == StateRestarting && st.Err != nil && !strings.Contains(st.Err.Error(), "exited before it was ready") {
			t.Errorf("restart reason %v", st.Err)
		}
	}
}

func TestBackoffIsCapped(t *testing.T) {
	sup, err := New(Config{Command: []string{"x"}, DataDir: t.TempDir(), BackoffInitial: time.Second, BackoffMax: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	var got []time.Duration
	for crashes := 1; crashes <= 6; crashes++ {
		got = append(got, sup.backoff(crashes))
	}
	if fmt.Sprint(got) != "[1s 2s 4s 5s 5s 5s]" {
		t.Errorf("backoff %v", got)
	}
}

func TestCrashWhileReadyRestarts(t *testing.T) {
	f := start(t, []string{"FAKE_MODE=ok"}, nil)
	first, i := f.rec.wait(t, 0, StateReady)
	res, err := http.Post(fmt.Sprintf("http://127.0.0.1:%d/v1/crash", first.Port), "text/plain", nil)
	if err == nil {
		res.Body.Close()
	}
	restarting, j := f.rec.wait(t, i, StateRestarting)
	if restarting.Err == nil || !strings.Contains(restarting.Err.Error(), "exit status 2") {
		t.Errorf("restart reason %v", restarting.Err)
	}
	second, _ := f.rec.wait(t, j, StateReady)
	if second.PID == first.PID {
		t.Errorf("same pid after restart: %d", second.PID)
	}
	if code, _ := f.health(t, second.Port, f.sup.Token()); code != http.StatusOK {
		t.Errorf("health after restart: %d (the token survives restarts)", code)
	}
}

func TestCrashLimitFailsThenRetry(t *testing.T) {
	f := start(t, []string{"FAKE_MODE=ok", "FAKE_FAIL_STARTS=3"}, func(c *Config) { c.CrashLimit = 3 })
	failed, i := f.rec.wait(t, 0, StateFailed)
	if failed.Crashes != 3 || !strings.Contains(failed.Err.Error(), "3 crashes within 2m0s") {
		t.Errorf("failed: %+v", failed)
	}
	if got := strings.Join(f.rec.kinds(), ","); got != "starting,restarting,restarting,failed" {
		t.Errorf("states %s", got)
	}
	f.sup.Retry()
	starting, j := f.rec.wait(t, i, StateStarting)
	if starting.Crashes != 0 {
		t.Errorf("retry kept %d crashes", starting.Crashes)
	}
	f.rec.wait(t, j, StateReady) // the fourth start succeeds
}

func TestStopFallsBackToSigtermThenKill(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no SIGTERM on Windows")
	}
	t.Run("sigterm", func(t *testing.T) {
		f := start(t, []string{"FAKE_MODE=ignore-stdin"}, func(c *Config) { c.StopTimeout = 200 * time.Millisecond })
		f.rec.wait(t, 0, StateReady)
		stop(t, f.sup)
		if how, _ := os.ReadFile(f.stopped); string(how) != "sigterm" {
			t.Errorf("stopped by %q, want sigterm", how)
		}
	})
	t.Run("kill", func(t *testing.T) {
		f := start(t, []string{"FAKE_MODE=ignore-all"}, func(c *Config) { c.StopTimeout = 200 * time.Millisecond })
		f.rec.wait(t, 0, StateReady)
		stop(t, f.sup)
		if how, err := os.ReadFile(f.stopped); err == nil {
			t.Errorf("stopped by %q, want a kill", how)
		}
		log, _ := os.ReadFile(f.sup.LogPath())
		if !strings.Contains(string(log), "killed after 200ms") {
			t.Errorf("log lacks the kill:\n%s", log)
		}
	})
}

func TestStopDuringBackoff(t *testing.T) {
	f := start(t, []string{"FAKE_MODE=exit"}, func(c *Config) { c.CrashLimit = 100 })
	f.rec.wait(t, 0, StateRestarting)
	stop(t, f.sup)
	f.rec.wait(t, 0, StateStopped)
	if st := f.sup.Status(); st.State != StateStopped {
		t.Errorf("status %v", st.State)
	}
}
