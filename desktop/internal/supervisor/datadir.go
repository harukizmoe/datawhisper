package supervisor

import (
	"os"
	"path/filepath"
	"runtime"
)

// DefaultDataDir 是每用户的数据目录，与服务的默认值一致（server/src/config.ts）：macOS 上是
// ~/Library/Application Support/DataWhisper，Windows 上是 %APPDATA%\DataWhisper，其他系统上是
// $XDG_DATA_HOME/datawhisper（默认为 ~/.local/share/datawhisper）。
func DefaultDataDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "DataWhisper"), nil
	case "windows":
		if appData := os.Getenv("APPDATA"); appData != "" {
			return filepath.Join(appData, "DataWhisper"), nil
		}
		return filepath.Join(home, "AppData", "Roaming", "DataWhisper"), nil
	}
	if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
		return filepath.Join(xdg, "datawhisper"), nil
	}
	return filepath.Join(home, ".local", "share", "datawhisper"), nil
}
