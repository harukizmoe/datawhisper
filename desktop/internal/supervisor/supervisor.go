// Package supervisor 把 agent 服务（server/，Bun）作为桌面应用的子进程运行。
//
// 进程约定（server/src/main.ts）：
//   - 环境变量：DW_TOKEN（bearer token，在这里生成）、DW_PORT=0、DW_DATA_DIR，以及配置了时的 DW_PYTHON /
//     DW_COMPUTE_CWD；
//   - ready：stdout 上的一行 {"type":"ready","port":N,"pid":N}；其余 stdout 和 stderr 的每一行都是日志；
//   - stop：关闭子进程的 stdin（服务在 EOF 时退出），然后 SIGTERM，最后 kill。Windows 没有 SIGTERM，所以在那里
//     关闭 stdin 就是停止路径；
//   - 运行期间退出即崩溃（退出码 1：存储故障）；服务重启后会继续被中断的工作，所以 supervisor 用指数退避重启
//     它，并在 CrashWindow 内崩溃达到 CrashLimit 次后放弃（StateFailed）。
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

// State 是 supervisor 眼中的服务状态。
type State int

const (
	// StateStopped：还没启动，或已被 Stop 停掉。
	StateStopped State = iota
	// StateStarting：第一次启动，正在等 ready 行。
	StateStarting
	// StateReady：服务在 Status.Port 上监听。
	StateReady
	// StateRestarting：服务退出了或启动失败；正在等退避结束或等 ready 行。
	StateRestarting
	// StateFailed：CrashWindow 内崩溃太多次；Retry 会重新开始。
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

// Status 是一次状态变化。
type Status struct {
	State State
	// ready 状态服务的 Port 与 PID（仅 StateReady）。
	Port int
	PID  int
	// Err 说明服务为何在重启或为何失败：它的退出、启动失败、ready 超时。
	Err error
	// Crashes 是 CrashWindow 内的崩溃次数。
	Crashes int
}

// Config 描述如何运行服务。
type Config struct {
	// Command 及其参数：编译好的服务可执行文件，或开发时的 {"bun", "run", ".../server/src/main.ts"}。
	Command []string
	// Dir 是服务的工作目录；为空表示用应用的。
	Dir string
	// DataDir 是 DW_DATA_DIR；日志文件写到 <DataDir>/logs/service.log。
	DataDir string
	// Python 和 ComputeCwd 在设置时会成为 DW_PYTHON 和 DW_COMPUTE_CWD。
	Python     string
	ComputeCwd string
	// Env 在应用的环境中追加变量（"KEY=value"）。
	Env []string

	// ReadyTimeout 限制等待 ready 行的时长。默认 30 s。
	ReadyTimeout time.Duration
	// StopTimeout 限制关闭 stdin 之后的等待，以及之后 SIGTERM 的等待，超过就进入下一步。默认 10 s。
	StopTimeout time.Duration
	// BackoffInitial 每在窗口内多一次崩溃就翻倍，直到 BackoffMax。默认 500 ms 和 15 s。
	BackoffInitial time.Duration
	BackoffMax     time.Duration
	// CrashWindow 内崩溃达到 CrashLimit 次就进入 StateFailed。默认 5 次和 2 分钟。
	CrashLimit  int
	CrashWindow time.Duration

	// OnState 按顺序收到每一次状态变化，回调在 supervisor 的 goroutine 上。它不能长时间阻塞，也不能调用 Stop。
	OnState func(Status)
}

// Supervisor 负责启动、监视、重启并停止一个服务进程。
type Supervisor struct {
	cfg     Config
	token   string
	logPath string

	mu      sync.Mutex
	status  Status
	running bool          // loop goroutine 正在运行
	stop    chan struct{} // 由 Stop 关闭
	done    chan struct{} // loop 返回时关闭
	retry   chan struct{} // 处于 failed 时的一次 Retry
	crashes []time.Time   // 窗口内的崩溃时间；只在 loop goroutine 里改
	notify  sync.Mutex    // 串行化 OnState 调用

	now   func() time.Time    // 崩溃窗口用的时钟
	sleep func(time.Duration) // 测试用：设置后替换退避等待
}

// New 校验 cfg、填入默认值并生成 token。它不启动任何东西。
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

// newToken 返回 32 个随机字节，base64url 无填充（43 个字符）。
func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("supervisor: token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Token 是每个 /v1 请求用的 bearer token，也用作 web-view 资源的 ?token=。
func (s *Supervisor) Token() string { return s.token }

// LogPath 是服务输出写入的文件。
func (s *Supervisor) LogPath() string { return s.logPath }

// Status 是最近一次状态。
func (s *Supervisor) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

// Start 在后台运行服务。已在运行时什么也不做。
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

// Retry 在 StateFailed 之后重新开始，并重置崩溃计数。其他状态下什么也不做。
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

// Stop 停止服务（关闭 stdin、SIGTERM、kill），并等待 supervisor 结束，或等到 ctx。
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

// loop 启动服务，等它结束，然后重启，直到 Stop。
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

	starting := true // 一次重启在退避之前已经上报过 StateRestarting
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

// recordCrash 记下此刻的一次崩溃，并返回窗口内的崩溃次数。
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

// backoff 是 BackoffInitial 按窗口内更早的崩溃次数翻倍，最多 BackoffMax。
func (s *Supervisor) backoff(crashes int) time.Duration {
	d := s.cfg.BackoffInitial
	for i := 1; i < crashes && d < s.cfg.BackoffMax; i++ {
		d *= 2
	}
	return min(d, s.cfg.BackoffMax)
}

// wait 睡 d，除非先被停止；它报告是否继续。
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

// run 是一个已启动的子进程。
type run struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	port   int
	pid    int
	exited chan struct{} // Wait 返回且输出已排空后关闭
	err    error         // Wait 的错误，在 exited 关闭前设置
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

// launch 启动子进程并等它的 ready 行。在此之前出现的输出行也会写进日志。
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
		output.Wait() // Wait 会关掉管道：先把它们排空
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

// shutdown 先关闭 stdin，再发 SIGTERM（Windows 上没有），最后 kill，每一步都等 StopTimeout。
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

// logLimit：打开时日志超过它就把它留作 service.log.1，另开一个新的。
const logLimit = 8 << 20

// openLog 以追加方式打开日志文件；超过 logLimit 的日志会被轮转一次。
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

// syncWriter 把各输出 goroutine 的写入串行化。
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
