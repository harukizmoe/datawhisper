// Command desktop is the DataWhisper desktop app: a MyGo native window over the agent service (server/), which it
// starts as a child process, restarts when it dies, and stops when the app quits.
//
//	go run .                                   # development: bun run server/src/main.ts, found above the cwd
//	go run . -service /opt/dw/datawhisper-server   # a compiled service (bun build --compile)
//	go run . -data-dir /tmp/dw -capture /tmp/dw/frames   # also write a PNG of the window at each service state
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

// newSupervisor configures the agent service's supervisor, reporting its states to a.
func newSupervisor(service, bun, dataDir, python, computeCwd string, a *app) (*supervisor.Supervisor, error) {
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
	a.token, a.retry, a.logPath = sup.Token(), sup.Retry, sup.LogPath()
	return sup, nil
}

// serviceCommand runs service: a .ts entry with bun, anything else as an executable. An empty service is the
// development entry, server/src/main.ts in or above the working directory.
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

// logState logs a state change; the token never appears in it.
func logState(st supervisor.Status) {
	switch st.State {
	case supervisor.StateReady:
		log.Printf("service ready pid=%d port=%d crashes=%d", st.PID, st.Port, st.Crashes)
	case supervisor.StateRestarting, supervisor.StateFailed:
		log.Printf("service %s crashes=%d: %v", st.State, st.Crashes, st.Err)
	default:
		log.Printf("service %s", st.State)
	}
}

// capture is set by -capture.
var capture *capturer

// capturer writes the window as it shows each service state. Window.CapturePage pictures the last frame built, and
// a frame waits for the compositor's frame callback, so the capturer first waits until the view was built after the
// state change; a ready window is taken a moment later, once the conversation list is in.
type capturer struct {
	win     *mygo.Window
	dir     string
	n       int
	reqs    chan supervisor.State
	closed  atomic.Bool
	waiting chan struct{} // closed by the next build of the view; the UI thread's
}

func (cp *capturer) start(win *mygo.Window) {
	if err := os.MkdirAll(cp.dir, 0o755); err != nil {
		log.Printf("capture: %v", err)
	}
	cp.win = win
	go cp.run()
}

// built is called by the view after each build, on the UI thread.
func (cp *capturer) built() {
	if cp.waiting != nil {
		close(cp.waiting)
		cp.waiting = nil
	}
}

// request asks for a capture of the state change posted before it.
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
		// Update runs after the state change it follows and asks for a frame; the build of that frame closes built.
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
