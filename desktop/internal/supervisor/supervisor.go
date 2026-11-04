// Package supervisor runs the agent service (server/, Bun) as a child process of the desktop app.
//
// Process contract (server/src/main.ts):
//   - environment: DW_TOKEN (bearer token, generated here), DW_PORT=0, DW_DATA_DIR, and DW_PYTHON / DW_COMPUTE_CWD
//     when configured;
//   - ready: a stdout line {"type":"ready","port":N,"pid":N}; every other stdout and stderr line is a log line;
//   - stop: close the child's stdin (the service exits at EOF), then SIGTERM, then kill. Windows has no SIGTERM, so
//     closing stdin is the stop path there;
//   - an exit while running is a crash (exit code 1: storage failure); the service resumes interrupted work when
//     restarted, so the supervisor restarts it with exponential backoff, and gives up (StateFailed) after
//     CrashLimit crashes within CrashWindow.
package supervisor

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// State is the supervisor's view of the service.
type State int

const (
	// StateStopped: not started yet, or stopped by Stop.
	StateStopped State = iota
	// StateStarting: the first start, waiting for the ready line.
	StateStarting
	// StateReady: the service listens on Status.Port.
	StateReady
	// StateRestarting: the service exited or failed to start; waiting out the backoff or for the ready line.
	StateRestarting
	// StateFailed: too many crashes in CrashWindow; Retry starts again.
	StateFailed
)

func (s State) String() string {
	switch s {
	case StateStopped:
		return "stopped"
	case StateStarting:
		return "starting"
	case StateReady:
		return "ready"
	case StateRestarting:
		return "restarting"
	case StateFailed:
		return "failed"
	}
	return fmt.Sprintf("State(%d)", int(s))
}

// Status is one state change.
type Status struct {
	State State
	// Port and PID of the ready service (StateReady only).
	Port int
	PID  int
	// Err is why the service is restarting or failed: its exit, a start failure, a missed ready deadline.
	Err error
	// Crashes counts crashes within CrashWindow.
	Crashes int
}

// Config describes how to run the service.
type Config struct {
	// Command and its arguments: a compiled service binary, or {"bun", "run", ".../server/src/main.ts"} in development.
	Command []string
	// Dir is the working directory of the service; empty: the app's.
	Dir string
	// DataDir is DW_DATA_DIR; the log file goes to <DataDir>/logs/service.log.
	DataDir string
	// Python and ComputeCwd become DW_PYTHON and DW_COMPUTE_CWD when set.
	Python     string
	ComputeCwd string
	// Env adds variables to the app's environment ("KEY=value").
	Env []string

	// ReadyTimeout bounds the wait for the ready line. Default 30 s.
	ReadyTimeout time.Duration
	// StopTimeout bounds the wait after closing stdin, and again after SIGTERM, before the next step. Default 10 s.
	StopTimeout time.Duration
	// BackoffInitial doubles with each crash in the window, up to BackoffMax. Defaults 500 ms and 15 s.
	BackoffInitial time.Duration
	BackoffMax     time.Duration
	// CrashLimit crashes within CrashWindow end in StateFailed. Defaults 5 and 2 minutes.
	CrashLimit  int
	CrashWindow time.Duration

	// OnState receives every state change, in order, from the supervisor's goroutine. It must not block for long
	// nor call Stop.
	OnState func(Status)
}

// Supervisor starts, watches, restarts and stops one service process.
type Supervisor struct {
	cfg     Config
	token   string
	logPath string

	mu      sync.Mutex
	status  Status
	running bool          // the loop goroutine runs
	stop    chan struct{} // closed by Stop
	done    chan struct{} // closed when the loop returns
	retry   chan struct{} // a Retry while failed
	crashes []time.Time   // crash times within the window; the loop goroutine's
	notify  sync.Mutex    // serializes OnState calls

	now   func() time.Time    // the crash window's clock
	sleep func(time.Duration) // tests: replaces the backoff wait when set
}

// New checks cfg, fills its defaults, and generates the token. It starts nothing.
func New(cfg Config) (*Supervisor, error) {
	if len(cfg.Command) == 0 {
		return nil, errors.New("supervisor: no command")
	}
	if cfg.DataDir == "" {
		return nil, errors.New("supervisor: no data dir")
	}
	setDefault(&cfg.ReadyTimeout, 30*time.Second)
	setDefault(&cfg.StopTimeout, 10*time.Second)
	setDefault(&cfg.BackoffInitial, 500*time.Millisecond)
	setDefault(&cfg.BackoffMax, 15*time.Second)
	setDefault(&cfg.CrashWindow, 2*time.Minute)
	if cfg.CrashLimit <= 0 {
		cfg.CrashLimit = 5
	}
	token, err := newToken()
	if err != nil {
		return nil, err
	}
	return &Supervisor{
		cfg:     cfg,
		token:   token,
		logPath: filepath.Join(cfg.DataDir, "logs", "service.log"),
		now:     time.Now,
	}, nil
}

func setDefault(d *time.Duration, v time.Duration) {
	if *d <= 0 {
		*d = v
	}
}

// newToken returns 32 random bytes, base64url without padding (43 characters).
func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("supervisor: token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Token is the bearer token of every /v1 request, and the ?token= of web-view assets.
func (s *Supervisor) Token() string { return s.token }

// LogPath is the file the service's output goes to.
func (s *Supervisor) LogPath() string { return s.logPath }

// Status is the latest state.
func (s *Supervisor) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

// Start runs the service in the background. It is a no-op while running.
func (s *Supervisor) Start() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return
	}
	s.running = true
	s.stop = make(chan struct{})
	s.done = make(chan struct{})
	s.retry = make(chan struct{}, 1)
	s.crashes = nil
	go s.loop(s.stop, s.done, s.retry)
}

// Retry starts again after StateFailed, with the crash count reset. A no-op in other states.
func (s *Supervisor) Retry() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running && s.status.State == StateFailed {
		select {
		case s.retry <- struct{}{}:
		default:
		}
	}
}

// Stop stops the service (stdin close, SIGTERM, kill) and waits for the supervisor to end, or for ctx.
func (s *Supervisor) Stop(ctx context.Context) error {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return nil
	}
	stop, done := s.stop, s.done
	select {
	case <-stop:
	default:
		close(stop)
	}
	s.mu.Unlock()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Supervisor) setState(st Status) {
	s.notify.Lock()
	defer s.notify.Unlock()
	s.mu.Lock()
	s.status = st
	s.mu.Unlock()
	if s.cfg.OnState != nil {
		s.cfg.OnState(st)
	}
}

// loop starts the service, waits for it to end, and restarts it until Stop.
func (s *Supervisor) loop(stop, done chan struct{}, retry chan struct{}) {
	defer func() {
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
		s.setState(Status{State: StateStopped})
		close(done)
	}()
	log, err := openLog(s.logPath)
	if err != nil {
		s.setState(Status{State: StateFailed, Err: err})
		<-stop
		return
	}
	defer log.Close()

	starting := true // a restart announced StateRestarting before its backoff
	for {
		if starting {
			s.setState(Status{State: StateStarting})
			starting = false
		}
		run, err := s.launch(log, stop)
		if err == nil {
			s.setState(Status{State: StateReady, Port: run.port, PID: run.pid, Crashes: len(s.crashes)})
			select {
			case <-run.exited:
				err = run.exitErr()
			case <-stop:
				s.shutdown(run, log)
				return
			}
		}
		select {
		case <-stop:
			return
		default:
		}
		fmt.Fprintf(log, "%s [supervisor] service ended: %v\n", stamp(), err)
		crashes := s.recordCrash()
		if crashes >= s.cfg.CrashLimit {
			s.setState(Status{State: StateFailed, Err: fmt.Errorf("%d crashes within %v; last: %w", crashes, s.cfg.CrashWindow, err), Crashes: crashes})
			select {
			case <-stop:
				return
			case <-retry:
				s.crashes = nil
				starting = true
				continue
			}
		}
		s.setState(Status{State: StateRestarting, Err: err, Crashes: crashes})
		if !s.wait(s.backoff(crashes), stop) {
			return
		}
	}
}

// recordCrash adds a crash now and returns the crashes within the window.
func (s *Supervisor) recordCrash() int {
	now := s.now()
	kept := s.crashes[:0]
	for _, t := range s.crashes {
		if now.Sub(t) < s.cfg.CrashWindow {
			kept = append(kept, t)
		}
	}
	s.crashes = append(kept, now)
	return len(s.crashes)
}

// backoff is BackoffInitial doubled for each earlier crash in the window, at most BackoffMax.
func (s *Supervisor) backoff(crashes int) time.Duration {
	d := s.cfg.BackoffInitial
	for i := 1; i < crashes && d < s.cfg.BackoffMax; i++ {
		d *= 2
	}
	return min(d, s.cfg.BackoffMax)
}

// wait sleeps d unless stopped first; it reports whether to go on.
func (s *Supervisor) wait(d time.Duration, stop chan struct{}) bool {
	if s.sleep != nil {
		s.sleep(d)
		select {
		case <-stop:
			return false
		default:
			return true
		}
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-stop:
		return false
	}
}

// run is one started child.
type run struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	port   int
	pid    int
	exited chan struct{} // closed once Wait returned and the output was drained
	err    error         // Wait's error, set before exited closes
}

func (r *run) exitErr() error {
	if r.err == nil {
		return errors.New("service exited (code 0) while running")
	}
	return fmt.Errorf("service exited: %w", r.err)
}

type readyLine struct {
	Type string `json:"type"`
	Port int    `json:"port"`
	PID  int    `json:"pid"`
}

// launch starts the child and waits for its ready line. Output lines before it go to the log too.
func (s *Supervisor) launch(log io.Writer, stop chan struct{}) (*run, error) {
	cmd := exec.Command(s.cfg.Command[0], s.cfg.Command[1:]...)
	cmd.Dir = s.cfg.Dir
	cmd.Env = append(os.Environ(), "DW_TOKEN="+s.token, "DW_PORT=0", "DW_DATA_DIR="+s.cfg.DataDir)
	if s.cfg.Python != "" {
		cmd.Env = append(cmd.Env, "DW_PYTHON="+s.cfg.Python)
	}
	if s.cfg.ComputeCwd != "" {
		cmd.Env = append(cmd.Env, "DW_COMPUTE_CWD="+s.cfg.ComputeCwd)
	}
	cmd.Env = append(cmd.Env, s.cfg.Env...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", s.cfg.Command[0], err)
	}
	fmt.Fprintf(log, "%s [supervisor] started pid %d: %v\n", stamp(), cmd.Process.Pid, s.cfg.Command)
	r := &run{cmd: cmd, stdin: stdin, exited: make(chan struct{})}
	ready := make(chan readyLine, 1)
	var output sync.WaitGroup
	output.Add(2)
	go func() {
		defer output.Done()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64<<10), 1<<20)
		seen := false
		for scanner.Scan() {
			line := scanner.Bytes()
			if !seen {
				var rl readyLine
				if json.Unmarshal(line, &rl) == nil && rl.Type == "ready" && rl.Port > 0 {
					seen = true
					ready <- rl
					continue
				}
			}
			fmt.Fprintf(log, "%s [stdout] %s\n", stamp(), line)
		}
	}()
	go func() {
		defer output.Done()
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 64<<10), 1<<20)
		for scanner.Scan() {
			fmt.Fprintf(log, "%s [stderr] %s\n", stamp(), scanner.Bytes())
		}
	}()
	go func() {
		output.Wait() // Wait closes the pipes: drain them first
		r.err = cmd.Wait()
		close(r.exited)
	}()

	deadline := time.NewTimer(s.cfg.ReadyTimeout)
	defer deadline.Stop()
	select {
	case rl := <-ready:
		r.port, r.pid = rl.Port, rl.PID
		if r.pid == 0 {
			r.pid = cmd.Process.Pid
		}
		return r, nil
	case <-r.exited:
		return nil, fmt.Errorf("service exited before it was ready: %w", errOrExit(r.err))
	case <-deadline.C:
		_ = cmd.Process.Kill()
		<-r.exited
		return nil, fmt.Errorf("no ready line within %v", s.cfg.ReadyTimeout)
	case <-stop:
		s.shutdown(r, log)
		return nil, errors.New("stopped")
	}
}

func errOrExit(err error) error {
	if err == nil {
		return errors.New("exit code 0")
	}
	return err
}

// shutdown closes stdin, then sends SIGTERM (not on Windows), then kills, each step after StopTimeout.
func (s *Supervisor) shutdown(r *run, log io.Writer) {
	_ = r.stdin.Close()
	if s.waitExit(r) {
		fmt.Fprintf(log, "%s [supervisor] stopped (stdin closed): %v\n", stamp(), r.err)
		return
	}
	if terminate(r.cmd.Process) == nil && s.waitExit(r) {
		fmt.Fprintf(log, "%s [supervisor] stopped (SIGTERM): %v\n", stamp(), r.err)
		return
	}
	_ = r.cmd.Process.Kill()
	<-r.exited
	fmt.Fprintf(log, "%s [supervisor] killed after %v: %v\n", stamp(), s.cfg.StopTimeout, r.err)
}

func (s *Supervisor) waitExit(r *run) bool {
	t := time.NewTimer(s.cfg.StopTimeout)
	defer t.Stop()
	select {
	case <-r.exited:
		return true
	case <-t.C:
		return false
	}
}

func stamp() string { return time.Now().Format("2006-01-02T15:04:05.000") }

// logLimit: a log above it at open is kept as service.log.1 and a new one started.
const logLimit = 8 << 20

// openLog opens the log file for appending; a log grown past logLimit is rotated once.
func openLog(path string) (*syncWriter, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("log dir: %w", err)
	}
	if info, err := os.Stat(path); err == nil && info.Size() > logLimit {
		_ = os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("log: %w", err)
	}
	return &syncWriter{f: f}, nil
}

// syncWriter serializes the writes of the output goroutines.
type syncWriter struct {
	mu sync.Mutex
	f  *os.File
}

func (w *syncWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.f.Write(p)
}

func (w *syncWriter) Close() error { return w.f.Close() }
