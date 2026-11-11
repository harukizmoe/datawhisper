package supervisor

import (
	"errors"
	"os"
)

// terminate 在 Windows 上没有 SIGTERM 的对应物：停止路径是关闭 stdin，然后再 Kill。
func terminate(*os.Process) error { return errors.ErrUnsupported }
