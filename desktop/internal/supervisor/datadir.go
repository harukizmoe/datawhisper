package supervisor

import (
	"os"
	"path/filepath"
	"runtime"
)

// DefaultDataDir is the per-user data directory, the same as the service's default (server/src/config.ts):
// ~/Library/Application Support/DataWhisper on macOS, %APPDATA%\DataWhisper on Windows, and
// $XDG_DATA_HOME/datawhisper (default ~/.local/share/datawhisper) elsewhere.
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
