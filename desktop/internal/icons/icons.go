// Package icons 是界面图标：Lucide（ISC 许可，见 svg/LICENSE）的 SVG 子集，随二进制分发。图标继承所在文字的
// 颜色与字号，所以亮暗主题与用户配色下不需要另备一套。新增图标时把 SVG 放进 svg/ 并在这里登记。
package icons

import (
	"embed"

	"github.com/egoist/mygo/ui"
)

//go:embed svg/*.svg
var iconFiles embed.FS

// mustIcon 解析一个内置图标；文件缺失或坏掉是构建错误，启动即失败，由测试拦住。
func mustIcon(name string) *ui.SVG {
	data, err := iconFiles.ReadFile("svg/" + name + ".svg")
	if err != nil {
		panic("icon " + name + ": " + err.Error())
	}
	return ui.MustParseSVG(data)
}

var (
	Plus         = mustIcon("plus")
	Chat         = mustIcon("message-square")
	Database     = mustIcon("database")
	Settings     = mustIcon("settings")
	Send         = mustIcon("arrow-up")
	Stop         = mustIcon("square")
	PanelRight   = mustIcon("panel-right")
	Pencil       = mustIcon("pencil")
	ChevronDown  = mustIcon("chevron-down")
	ChevronRight = mustIcon("chevron-right")
	Copy         = mustIcon("copy")
	Refresh      = mustIcon("refresh-cw")
	Close        = mustIcon("x")
	Check        = mustIcon("check")
	CircleCheck  = mustIcon("circle-check")
	CircleX      = mustIcon("circle-x")
	Info         = mustIcon("info")
	Upload       = mustIcon("upload")
	Plug         = mustIcon("plug")
	Trash        = mustIcon("trash")
	Eye          = mustIcon("eye")
	EyeOff       = mustIcon("eye-off")
	FolderOpen   = mustIcon("folder-open")
	File         = mustIcon("file-text")
	Search       = mustIcon("search")
	Sun          = mustIcon("sun")
	Moon         = mustIcon("moon")
	Monitor      = mustIcon("monitor")
	Tool         = mustIcon("wrench")
	Chart        = mustIcon("chart-column")
	More         = mustIcon("ellipsis")
	External     = mustIcon("external-link")
	Table        = mustIcon("table")
	Knowledge    = mustIcon("book-open")
	Skill        = mustIcon("puzzle")
	Dashboard    = mustIcon("layout-dashboard")
	ListChecks   = mustIcon("list-checks")
	Sparkles     = mustIcon("sparkles")
)
