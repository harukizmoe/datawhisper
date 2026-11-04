//go:build !windows

package supervisor

import (
	"os"
	"syscall"
)

// terminate asks the service to stop with SIGTERM.
func terminate(p *os.Process) error { return p.Signal(syscall.SIGTERM) }
