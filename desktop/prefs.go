package main

// 界面外壳的偏好：外观（深色/浅色/跟随系统）与界面语言。它们存在数据目录的 ui.json 里，与服务的设置分开：
// 服务只管模型、数据源这些它自己懂的东西。

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const (
	themeSystem = "system"
	themeLight  = "light"
	themeDark   = "dark"
)

// uiPrefs 是 ui.json 的内容。取值都经过校验：坏掉的文件或陌生的取值退回默认值，不让界面卡在无效状态。
type uiPrefs struct {
	Theme    string `json:"theme"`    // themeSystem、themeLight 或 themeDark
	Language string `json:"language"` // langSystem、langEN 或 langZH
}

// defaultUIPrefs 是第一次启动时的选择：跟随系统。
func defaultUIPrefs() uiPrefs {
	return uiPrefs{Theme: themeSystem, Language: langSystem}
}

func validTheme(s string) bool {
	switch s {
	case themeSystem, themeLight, themeDark:
		return true
	}
	return false
}

func validLanguage(s string) bool {
	switch s {
	case langSystem, langEN, langZH:
		return true
	}
	return false
}

// uiPrefsPath 返回数据目录里的偏好文件路径；没有数据目录时返回空串（不持久化）。
func uiPrefsPath(dataDir string) string {
	if dataDir == "" {
		return ""
	}
	return filepath.Join(dataDir, "ui.json")
}

// loadUIPrefs 读偏好文件。文件不存在、读不了或不是合法的 JSON 时返回默认值：偏好只是界面的方便，
// 不该挡住启动。
func loadUIPrefs(path string) uiPrefs {
	prefs := defaultUIPrefs()
	if path == "" {
		return prefs
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return prefs
	}
	var stored uiPrefs
	if err := json.Unmarshal(data, &stored); err != nil {
		return prefs
	}
	if validTheme(stored.Theme) {
		prefs.Theme = stored.Theme
	}
	if validLanguage(stored.Language) {
		prefs.Language = stored.Language
	}
	return prefs
}

// saveUIPrefs 原子地写偏好：同目录临时文件写完后 rename，中途退出不会留下半个 JSON。
func saveUIPrefs(path string, prefs uiPrefs) error {
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(prefs, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	f, err := os.CreateTemp(filepath.Dir(path), ".ui-*.json")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	// 先落盘再改名，断电后也不会出现一个空的 ui.json。
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, 0o644); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// savePrefs 保存当前偏好；失败时把原因留在界面上，界面仍然照用户的选择走。-theme/-lang 只对一次运行
// 有效（prefsLocked），这时不写回文件。
func (a *app) savePrefs() {
	if a.prefsLocked {
		return
	}
	if err := saveUIPrefs(a.prefsPath, a.prefs); err != nil {
		a.prefsErr = err.Error()
		return
	}
	a.prefsErr = ""
}
