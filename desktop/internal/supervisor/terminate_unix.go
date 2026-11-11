//go:build !windows

package supervisor

import (
	"os"
	"syscall"
)

// terminate 用 SIGTERM 请服务停止。
func terminate(p *os.Process) error { return p.Signal(syscall.SIGTERM) }
