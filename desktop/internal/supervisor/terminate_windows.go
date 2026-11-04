package supervisor

import (
	"errors"
	"os"
)

// terminate has no Windows counterpart of SIGTERM: closing stdin is the stop path, then Kill.
func terminate(*os.Process) error { return errors.ErrUnsupported }
