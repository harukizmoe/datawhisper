// Command desktop 是 DataWhisper 桌面应用：在 agent 服务（server/）之上开一个 MyGo 原生窗口。它把该服务作为
// 子进程启动，服务挂掉时重启它，应用退出时停止它。
//
//	go run .                                   # 开发模式：bun run server/src/main.ts，从当前工作目录向上查找
//	go run . -service /opt/dw/datawhisper-server   # 已编译的服务（bun build --compile）
//	go run . -data-dir /tmp/dw -capture /tmp/dw/frames   # 另外在每种服务状态各存一张窗口 PNG
//	go run . -data-dir /tmp/dw -open 15 -capture /tmp/dw/frames -capture-delay 8s -capture-quit
//	                                                      # 打开会话 15、等服务就绪 8 秒后截一张图就退出（截图脚本）
//	go run . -theme dark -lang zh-Hans -page settings-general
//	                                                      # 本次运行用深色与简体中文，直接落在设置页的「通用」分区；
//	                                                      # 这两个参数不写回 <dataDir>/ui.json（截图与手工验证用）
//
// 打包后的应用不用 -service：它先看可执行文件旁边的 bin/（macOS 是 Contents/Resources/bin/），在那里找到
// 随包的 datawhisper-server 和 datawhisper-compute 就使用它们，并把资源目录设为服务的工作目录。
package main

import (
	_ "embed"
	"encoding/json"
	"flag"
	"log"
	"os"
	"time"

	"datawhisper/desktop/internal/app"
)

// mygoConfig 是打包配置；版本号只在这里写一份，关于对话框与安装包共用，不会漂。
//
//go:embed mygo.json
var mygoConfig []byte

func main() {
	var opts app.Options
	flag.StringVar(&opts.Service, "service", os.Getenv("DW_SERVICE"), "the agent service: a compiled executable, or a .ts entry that bun runs (default: server/src/main.ts in or above the working directory)")
	flag.StringVar(&opts.Bun, "bun", "bun", "the Bun executable that runs a .ts service")
	flag.StringVar(&opts.DataDir, "data-dir", os.Getenv("DW_DATA_DIR"), "the data directory (default: the per-user data directory)")
	flag.StringVar(&opts.Python, "python", "", "the compute worker's Python interpreter or executable, for the service (DW_PYTHON)")
	flag.StringVar(&opts.ComputeCwd, "compute-cwd", "", "the compute worker's working directory, for the service (DW_COMPUTE_CWD)")
	flag.StringVar(&opts.CaptureDir, "capture", "", "write a PNG of the window into this directory at each service state change")
	flag.DurationVar(&opts.CaptureDelay, "capture-delay", 800*time.Millisecond, "how long after the service is ready to capture its window")
	flag.BoolVar(&opts.CaptureQuit, "capture-quit", false, "quit after capturing the ready state")
	flag.IntVar(&opts.Open, "open", 0, "show this conversation on startup (0: a new chat)")
	flag.IntVar(&opts.Width, "width", 1180, "window width in DIPs")
	flag.IntVar(&opts.Height, "height", 760, "window height in DIPs")
	flag.StringVar(&opts.Page, "page", "", "start on the Settings page: settings, or settings-general for the appearance and language tab")
	flag.StringVar(&opts.Theme, "theme", "", "the appearance for this run only: system, light or dark (ui.json still decides on the next run)")
	flag.StringVar(&opts.Lang, "lang", "", "the interface language for this run only: system, en or zh-Hans (ui.json still decides on the next run)")
	flag.Parse()
	opts.Version = version()
	if err := app.Run(opts); err != nil {
		log.Fatal(err)
	}
}

// version 读 mygo.json 的 version；读不出时为空，关于对话框不显示版本号。
func version() string {
	var cfg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(mygoConfig, &cfg); err != nil {
		return ""
	}
	return cfg.Version
}
