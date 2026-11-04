package main

// 随应用安装的服务与 compute 可执行文件。打包后它们就放在资源目录的 bin/ 下：
//
//   - Linux / Windows：<应用目录>/bin/datawhisper-server[.exe]，资源目录就是可执行文件的目录；
//   - macOS：DataWhisper.app/Contents/Resources/bin/datawhisper-server，资源目录在 Contents/Resources。
//
// 开发时（go run、go test）可执行文件在临时目录里，旁边没有 bin/，于是回退到仓库里的服务入口。

import (
	"os"
	"path/filepath"
	"runtime"
)

// bundled 是一次随包资源的查找结果。compute 可以缺失：服务仍能启动，只是第一次用到 compute 时才失败。
type bundled struct {
	// root 是资源根目录，服务进程的工作目录与环境变量的默认值都以它为准。
	root string
	// service 是随包的服务可执行文件的绝对路径。
	service string
	// compute 是随包的 compute 可执行文件；没有时为空串。
	compute string
}

// exeName 返回 goos 下可执行文件的名字。findBundled 用 runtime.GOOS，测试可以传别的值。
func exeName(goos, name string) string {
	if goos == "windows" {
		return name + ".exe"
	}
	return name
}

// existingExecutable 返回 path 存在且可执行时的路径，否则返回空串。Windows 没有可执行位，只看存在与是否为普通文件。
func existingExecutable(path, goos string) string {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	if goos != "windows" && info.Mode().Perm()&0o111 == 0 {
		return ""
	}
	return path
}

// bundledIn 在可执行文件所在目录 exeDir 里找随包资源，找不到服务时报告 false。
// 先看 exeDir（Linux、Windows），再看 exeDir/../Resources（macOS 应用包）。
func bundledIn(exeDir, goos string) (bundled, bool) {
	serviceName := exeName(goos, "datawhisper-server")
	computeName := exeName(goos, "datawhisper-compute")
	roots := []string{exeDir, filepath.Join(exeDir, "..", "Resources")}
	for _, root := range roots {
		service := existingExecutable(filepath.Join(root, "bin", serviceName), goos)
		if service == "" {
			continue
		}
		return bundled{
			root:    filepath.Clean(root),
			service: service,
			compute: existingExecutable(filepath.Join(root, "bin", computeName), goos),
		}, true
	}
	return bundled{}, false
}

// findBundled 在运行中的可执行文件旁边找随包资源。它只读文件系统，不看 DW_* 环境变量：
// 显式指定的 -service / -python 由 newSupervisor 优先处理。
func findBundled() (bundled, bool) {
	exe, err := os.Executable()
	if err != nil {
		return bundled{}, false
	}
	// 通过符号链接启动时（例如 Linux 上的 /usr/bin/datawhisper），资源在真实文件旁边。
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return bundledIn(filepath.Dir(exe), runtime.GOOS)
}
