// Command desktop 是 DataWhisper 桌面应用：在 agent 服务（server/）之上开一个 MyGo 原生窗口。它把该服务作为
// 子进程启动，服务挂掉时重启它，应用退出时停止它。
//
//	go run .                                   # 开发模式：bun run server/src/main.ts，从当前工作目录向上查找
//	go run . -service /opt/dw/datawhisper-server   # 已编译的服务（bun build --compile）
//	go run . -data-dir /tmp/dw -capture /tmp/dw/frames   # 另外在每种服务状态各存一张窗口 PNG
//
// 打包后的应用不用 -service：它先看可执行文件旁边的 bin/（macOS 是 Contents/Resources/bin/），在那里找到
// 随包的 datawhisper-server 和 datawhisper-compute 就使用它们，并把资源目录设为服务的工作目录。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"datawhisper/desktop/internal/supervisor"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func main() {
	service := flag.String("service", os.Getenv("DW_SERVICE"), "the agent service: a compiled executable, or a .ts entry that bun runs (default: server/src/main.ts in or above the working directory)")
	bun := flag.String("bun", "bun", "the Bun executable that runs a .ts service")
	dataDir := flag.String("data-dir", os.Getenv("DW_DATA_DIR"), "the data directory (default: the per-user data directory)")
	python := flag.String("python", "", "the compute worker's Python interpreter or executable, for the service (DW_PYTHON)")
	computeCwd := flag.String("compute-cwd", "", "the compute worker's working directory, for the service (DW_COMPUTE_CWD)")
	captureDir := flag.String("capture", "", "write a PNG of the window into this directory at each service state change")
	flag.Parse()

	a := &app{}
	sup, err := newSupervisor(*service, *bun, *dataDir, *python, *computeCwd, a)
	mygo.App.WhenReady(func() {
		view := a.view
		if *captureDir != "" {
			capture = &capturer{dir: *captureDir, reqs: make(chan supervisor.State, 32)}
			view = func(c *ui.Context) {
				a.view(c)
				capture.built()
			}
		}
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:   "DataWhisper",
			Width:   1180,
			Height:  760,
			Content: ui.View(view),
		})
		a.post = win.Update
		if capture != nil {
			capture.start(win)
		}
		if err != nil {
			log.Print(err)
			a.onService(supervisor.Status{State: supervisor.StateFailed, Err: err})
			return
		}
		sup.Start()
	})

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-quit
		mygo.App.Quit()
	}()
	runErr := mygo.App.Run()
	if capture != nil {
		capture.close()
	}
	if sup != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		if err := sup.Stop(ctx); err != nil {
			log.Printf("stop the agent service: %v", err)
		}
		cancel()
	}
	if runErr != nil {
		log.Fatal(runErr)
	}
}

// newSupervisor 配置 agent 服务的 supervisor，并把它的状态上报给 a。
func newSupervisor(service, bun, dataDir, python, computeCwd string, a *app) (*supervisor.Supervisor, error) {
	// 打包后的应用：可执行文件旁边的 bin/ 里有随包的服务与 compute。显式给出的 -service / -python /
	// -compute-cwd 优先，所以开发时仍然用仓库里的 server/src/main.ts。
	var dir string
	if service == "" {
		if b, ok := findBundled(); ok {
			service, dir = b.service, b.root
			if python == "" {
				python = b.compute
			}
			if computeCwd == "" {
				computeCwd = b.root
			}
		}
	}
	command, err := serviceCommand(service, bun)
	if err != nil {
		return nil, err
	}
	if dataDir == "" {
		if dataDir, err = supervisor.DefaultDataDir(); err != nil {
			return nil, fmt.Errorf("data directory: %w", err)
		}
	}
	sup, err := supervisor.New(supervisor.Config{
		Command:    command,
		Dir:        dir,
		DataDir:    dataDir,
		Python:     python,
		ComputeCwd: computeCwd,
		OnState: func(st supervisor.Status) {
			logState(st)
			a.post(func() { a.onService(st) })
			if capture != nil {
				capture.request(st)
			}
		},
	})
	if err != nil {
		return nil, err
	}
	a.retry, a.logPath = sup.Retry, sup.LogPath()
	return sup, nil
}

// serviceCommand 返回运行 service 的命令：.ts 入口交给 bun 跑，其他路径当作可执行文件。service 为空表示开发
// 入口，即工作目录或其上级目录里的 server/src/main.ts。
func serviceCommand(service, bun string) ([]string, error) {
	if service == "" {
		dir, err := os.Getwd()
		if err != nil {
			return nil, err
		}
		for {
			entry := filepath.Join(dir, "server", "src", "main.ts")
			if _, err := os.Stat(entry); err == nil {
				service = entry
				break
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				return nil, errors.New("no -service given, and no server/src/main.ts in or above the working directory")
			}
			dir = parent
		}
	}
	path, err := filepath.Abs(service)
	if err != nil {
		return nil, err
	}
	if strings.HasSuffix(path, ".ts") {
		return []string{bun, "run", path}, nil
	}
	return []string{path}, nil
}

// logState 记录一次状态变化。
func logState(st supervisor.Status) {
	switch st.State {
	case supervisor.StateReady:
		log.Printf("service ready pid=%d crashes=%d", st.PID, st.Crashes)
	case supervisor.StateRestarting, supervisor.StateFailed:
		log.Printf("service %s crashes=%d: %v", st.State, st.Crashes, st.Err)
	default:
		log.Printf("service %s", st.State)
	}
}

// capture 由 -capture 设置。
var capture *capturer

// capturer 在窗口显示每种服务状态时把它保存成图片。Window.CapturePage 拍到的是最后构建出的那一帧，而一帧
// 要等合成器的 frame callback 才会出现，所以 capturer 先等状态变化之后的那次视图构建完成；对 ready 状态还会
// 再等一小会儿，等会话列表到位后再拍。
type capturer struct {
	win     *mygo.Window
	dir     string
	n       int
	reqs    chan supervisor.State
	closed  atomic.Bool
	waiting chan struct{} // 由视图的下一次构建关闭；在 UI 线程上
}

func (cp *capturer) start(win *mygo.Window) {
	if err := os.MkdirAll(cp.dir, 0o755); err != nil {
		log.Printf("capture: %v", err)
	}
	cp.win = win
	go cp.run()
}

// built 由视图在每次构建后调用，运行在 UI 线程上。
func (cp *capturer) built() {
	if cp.waiting != nil {
		close(cp.waiting)
		cp.waiting = nil
	}
}

// request 请求拍下在它之前投递的那次状态变化。
func (cp *capturer) request(st supervisor.Status) {
	if cp.closed.Load() {
		return
	}
	select {
	case cp.reqs <- st.State:
	default:
	}
}

func (cp *capturer) close() { cp.closed.Store(true) }

func (cp *capturer) run() {
	for state := range cp.reqs {
		if state == supervisor.StateReady {
			time.Sleep(800 * time.Millisecond)
		}
		// Update 会在它所跟随的状态变化之后运行，并请求重绘一帧；该帧的构建过程会关闭 built。
		built := make(chan struct{})
		cp.win.Update(func() { cp.waiting = built })
		select {
		case <-built:
		case <-time.After(5 * time.Second):
			log.Printf("capture %s: the window drew no frame in 5 s (hidden?); the picture may be older", state)
		}
		if cp.closed.Load() {
			return
		}
		png, err := cp.win.CapturePage()
		if err != nil {
			log.Printf("capture %s: %v", state, err)
			continue
		}
		cp.n++
		path := filepath.Join(cp.dir, fmt.Sprintf("%02d-%s.png", cp.n, state))
		if err := os.WriteFile(path, png, 0o644); err != nil {
			log.Printf("capture: %v", err)
			continue
		}
		log.Printf("capture: wrote %s", path)
	}
}
