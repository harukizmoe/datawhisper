package app

// 应用的启动与装配：解析数据目录与偏好、找到 agent 服务（随包或开发目录）、建主窗口、接上菜单托盘与
// 预览协议，以及 -capture 截图。命令行参数在根目录的 main 包里解析。

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"datawhisper/desktop/internal/i18n"
	"datawhisper/desktop/internal/prefs"
	"datawhisper/desktop/internal/preview"
	"datawhisper/desktop/internal/supervisor"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// Options 是一次运行的启动参数，由 main 包从命令行解析后传入（各项含义见根目录 main.go 的参数说明）。
type Options struct {
	Service, Bun       string
	DataDir            string
	Python, ComputeCwd string
	CaptureDir         string
	CaptureDelay       time.Duration
	CaptureQuit        bool
	Open               int
	Width, Height      int
	Page               string
	Theme, Lang        string
	// Version 是应用版本（mygo.json 的 version），关于对话框显示它。
	Version string
}

// Run 拉起 agent 服务并打开主窗口，直到应用退出；退出时停止服务。
func Run(opts Options) error {

	dataDirResolved, err := resolveDataDir(opts.DataDir)
	if err != nil {
		return fmt.Errorf("data directory: %w", err)
	}
	a := &app{openOnReady: opts.Open, dataDir: dataDirResolved, prefsPath: prefs.Path(dataDirResolved), version: opts.Version}
	a.prefs = prefs.Load(a.prefsPath)
	// 这两个参数只影响这一次运行（截图与手工验证用），因此不写回 ui.json。
	if opts.Theme != "" {
		if !prefs.ValidTheme(opts.Theme) {
			return fmt.Errorf("-theme must be system, light or dark, not %q", opts.Theme)
		}
		a.prefs.Theme, a.prefsLocked = opts.Theme, true
	}
	if opts.Lang != "" {
		if !i18n.Valid(opts.Lang) {
			return fmt.Errorf("-lang must be system, en or zh-Hans, not %q", opts.Lang)
		}
		a.prefs.Language, a.prefsLocked = opts.Lang, true
	}
	// 界面的两种语言先登记，SetLocale 才能在这两者之间挑。外观在建窗口之前定下来，避免第一帧闪一下。
	mygo.App.SetLanguages(i18n.EN, i18n.ZH)
	mygo.Theme.SetSource(themeSource(a.prefs.Theme))

	sup, err := newSupervisor(opts.Service, opts.Bun, dataDirResolved, opts.Python, opts.ComputeCwd, a)
	mygo.App.WhenReady(func() {
		switch opts.Page {
		case "settings":
			a.nav = navSettings
		case "settings-general":
			// 截图与手工验证用：直接落在「通用」分区。
			a.nav, a.st.tab = navSettings, settingsTabGeneral
		}
		a.preferred = mygo.App.PreferredLanguages()
		a.lang = i18n.Resolve(a.prefs.Language, a.preferred)
		mygo.App.SetLocale(appLocale(a.prefs.Language))
		view := a.view
		if opts.CaptureDir != "" {
			capture = &capturer{dir: opts.CaptureDir, readyDelay: opts.CaptureDelay, quit: mygo.App.Quit, quitAfter: opts.CaptureQuit, reqs: make(chan supervisor.State, 32)}
			view = func(c *ui.Context) {
				a.view(c)
				capture.built()
			}
		}
		// 图表与产物预览由应用自己的 scheme 提供：旧网页的 /static/vendor/* 因此能指向
		// 随包的 plotly/echarts，而文件只通过一次性 token 暴露。scheme 必须在建窗口之前注册。
		if err := mygo.Protocol.Handle(preview.Scheme, a.rich.Server()); err != nil {
			log.Printf("preview scheme: %v", err)
		}
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:   "DataWhisper",
			Width:   opts.Width,
			Height:  opts.Height,
			Content: ui.View(view),
		})
		a.win = win
		a.post = win.Update
		a.rich.Post = win.Update
		a.rich.Host = preview.WindowHost{Win: win, Changed: win.Update}
		// 菜单栏、托盘、文件拖放，以及系统语言与外观变化的监听。
		a.attachShell(win)
		// 窗口关闭会带走它自己的 web view；这里显式释放一遍，删掉媒体登记项。
		win.OnClosed(func() {
			a.rich.ReleaseAll()
			if a.tray != nil {
				a.tray.Destroy()
				a.tray = nil
			}
		})
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
	return runErr
}

// resolveDataDir 决定数据目录：-data-dir / DW_DATA_DIR 优先，否则用每用户的数据目录。界面偏好（ui.json）
// 与服务的数据都放在这里。
func resolveDataDir(dir string) (string, error) {
	if dir != "" {
		return dir, nil
	}
	return supervisor.DefaultDataDir()
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
//
// 注意：Window.CapturePage 只渲染原生内容，web view（图表、HTML 产物）在截图里是一个白洞。要证明图表真的
// 画出来了，用桌面合成器截图（niri/gnome 的 screenshot、grim），或另拍 WebView.CapturePage。
type capturer struct {
	win     *mygo.Window
	dir     string
	n       int
	reqs    chan supervisor.State
	closed  atomic.Bool
	waiting chan struct{} // 由视图的下一次构建关闭；在 UI 线程上
	// readyDelay 是服务就绪后等界面稳定（会话列表、模型目录）再拍的时间。
	readyDelay time.Duration
	// quit 与 quitAfter：拍完 ready 状态就退出，供截图脚本使用。
	quit      func()
	quitAfter bool
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
			delay := cp.readyDelay
			if delay < 800*time.Millisecond {
				delay = 800 * time.Millisecond
			}
			time.Sleep(delay)
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
		if state == supervisor.StateReady && cp.quitAfter {
			if cp.quit != nil {
				cp.quit()
			}
			return
		}
	}
}
