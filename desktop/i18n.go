package main

// 界面文案的中英文资源。只有界面自己的文案走这里：模型输出、工具调用的文案、服务日志与错误里的服务原话都
// 保持原样，翻译它们只会让排错变难。
//
// 键按页面分组（menu.*、sidebar.*、chat.*、settings.*、data.*），值里可以用 {name} 这样的占位符，
// tr 用成对的参数替换它。缺条目时回退英文，因此新增文案不必同时翻译。

import (
	"strings"

	"github.com/egoist/mygo/i18n"
	// MyGo 自己的控件、对话框与菜单文案也翻成简体中文（Edit 菜单的角色项等）。
	_ "github.com/egoist/mygo/locales/zh-Hans"
)

const (
	// langSystem 表示跟随系统的语言。
	langSystem = "system"
	langEN     = "en"
	// langZH 用 BCP 47 的简体中文标签，和 MyGo 自带的翻译对齐。
	langZH = "zh-Hans"
)

// uiLanguages 是界面写到的语言；顺序就是匹配时的优先级，第一项是资源里的原文。
var uiLanguages = []string{langEN, langZH}

type messages map[string]string

var enMessages = messages{
	// 菜单
	"menu.about":           "About {name}",
	"menu.settings":        "Settings…",
	"menu.quit":            "Quit {name}",
	"menu.file":            "File",
	"menu.newChat":         "New chat",
	"menu.import":          "Import Data…",
	"menu.closeWindow":     "Close Window",
	"menu.edit":            "Edit",
	"menu.view":            "View",
	"menu.toggleDataPanel": "Toggle Data Panel",
	"menu.toggleTheme":     "Toggle Theme",
	"menu.reload":          "Reload",
	"menu.developer":       "Developer",
	"menu.openServiceLog":  "Open Service Log",
	"menu.help":            "Help",
	"menu.documentation":   "Documentation",
	"menu.reportIssue":     "Report an Issue",
	"menu.aboutBody":       "{name} {version}\nA local data analysis agent.\n\n{url}",
	"menu.importTip":       "Open a chat before importing a file.",

	// 托盘
	"tray.show":    "Show Window",
	"tray.hide":    "Hide Window",
	"tray.newChat": "New Chat",

	// 侧边栏
	"sidebar.newChat":    "New chat",
	"sidebar.chats":      "Chats",
	"sidebar.app":        "App",
	"sidebar.data":       "Data",
	"sidebar.settings":   "Settings",
	"sidebar.listFailed": "Could not load the conversations",
	"sidebar.empty":      "No conversations yet",

	// 服务状态
	"status.ready":      "Ready",
	"status.starting":   "Starting",
	"status.restarting": "Restarting",
	"status.failed":     "Failed",
	"status.stopped":    "Stopped",

	// 服务横幅
	"banner.stopped":      "The agent service is not running.",
	"banner.starting":     "Starting the agent service…",
	"banner.restarting":   "The agent service stopped ({error}). Restarting it…",
	"banner.failed":       "The agent service could not be started: {error}.",
	"banner.failedLog":    " Its log is {path}.",
	"banner.reconnecting": "Reconnecting to the conversation… ({error})",
	"banner.streamFailed": "The conversation could not be opened: {error}",
	"banner.reconnected":  "Reconnected: the agent service restarted and the conversation is up to date.",
	"banner.retry":        "Retry",

	// 聊天页
	"chat.empty":           "Ask a question about your data.",
	"chat.loading":         "Loading the conversation…",
	"chat.lastReplyFailed": "The last reply did not finish: {error}",
	"chat.openSettings":    "Open settings",
	"chat.rename":          "Rename",
	"chat.renameTip":       "Rename this chat",
	"chat.data":            "Data",
	"chat.hideData":        "Hide data",
	"chat.dataTip":         "Data sources, workspace and artifacts of this chat",
	"chat.busy":            "The reply is still running.",
	"chat.queue":           "Queue",
	"chat.steer":           "Steer",
	"chat.enterMode":       "What Enter does while the reply runs",
	"chat.enterQueues":     "Enter queues this message for after the reply.",
	"chat.enterSteers":     "Enter adds this message to the running reply.",
	"chat.queued":          "{count} queued",
	"chat.message":         "Message",
	"chat.placeholder":     "Ask about your data",
	"chat.stop":            "Stop",
	"chat.stopTip":         "Stop the reply and withdraw queued messages",
	"chat.send":            "Send",

	// 设置页
	"settings.title":       "Settings",
	"settings.refresh":     "Refresh settings",
	"settings.loading":     "Loading the model settings…",
	"settings.loadFailed":  "Could not load the settings: {error}",
	"settings.tryAgain":    "Try again",
	"settings.unavailable": "Model settings are available once the agent service is ready.",
	"settings.process":     "{status}: process {pid}",
	"settings.log":         "Log: {path}",
	"settings.providers":   "Model providers",
	"settings.noProvider":  "No provider is configured. Add one below.",
	"settings.addProvider": "Add provider",
	"settings.models":      "Models",
	"settings.general":     "General",
	"settings.appearance":  "Appearance",
	"settings.system":      "System",
	"settings.light":       "Light",
	"settings.dark":        "Dark",
	"settings.language":    "Language",
	"settings.files":       "Files",
	"settings.dataDir":     "Data folder",
	"settings.serviceLog":  "Service log",
	"settings.openFolder":  "Open folder",
	"settings.openLog":     "Open log",
	"settings.notSet":      "Not set",
	"settings.saveFailed":  "Could not save the preference: {error}",
	"settings.themeTip":    "How the interface reads: light, dark, or the system's choice",
	"settings.languageTip": "The language of the interface. Model output, tools and logs keep their own.",

	// 数据面板
	"data.title":         "Data",
	"data.chat":          "Chat {id}",
	"data.refreshTip":    "Reload the sources, workspace and artifacts",
	"data.hideTip":       "Hide the data panel",
	"data.unavailable":   "Data sources are available once the agent service is ready.",
	"data.noChat":        "Start a chat to add data sources.",
	"data.loading":       "Loading the data sources…",
	"data.importTip":     "Import a CSV, Excel or PDF file",
	"data.removeAll":     "Remove all",
	"data.removeAllTip":  "Remove every data source of this chat",
	"data.copying":       "Copying {name}…",
	"data.empty":         "No data sources yet: import a file, or connect a database.",
	"data.tables":        "{count} tables · {state}",
	"data.inAnalysis":    "In analysis",
	"data.preview":       "Preview",
	"data.previewTip":    "Preview the tables of {name}",
	"data.edit":          "Edit",
	"data.editTip":       "Edit {name}",
	"data.remove":        "Remove",
	"data.removeTip":     "Remove {name}",
	"data.previewTitle":  "Preview: {name}",
	"data.loadingTables": "Loading the tables…",
	"data.noTables":      "This source has no tables.",
	"data.rowsColumns":   "{rows} rows · {columns} columns",
	"data.columnsOnly":   "{columns} columns · row count not reported",
	"data.schema":        "Schema",
	"data.noSchema":      "The service reported no schema.",
	"data.noRows":        "No rows to preview.",
	"data.refresh":       "Refresh",
	"data.hide":          "Hide",
	"data.import":        "Import",
	"data.tabSources":    "Sources",
	"data.tabWorkspace":  "Workspace",
	"data.tabArtifacts":  "Artifacts",
	"data.tabsLabel":     "Data tabs",
	"data.stateOpen":     "open",
	"data.stateClosed":   "closed",
	"data.connect":       "Connect",
	"data.connectTip":    "Connect a remote data source",
	"data.limit":         "Files up to {size}: .csv, .xlsx, .xls, .pdf.",
	"data.limitUnknown":  "The service sets the limit when the import starts.",
}

var zhMessages = messages{
	// 菜单
	"menu.about":           "关于 {name}",
	"menu.settings":        "设置…",
	"menu.quit":            "退出 {name}",
	"menu.file":            "文件",
	"menu.newChat":         "新建对话",
	"menu.import":          "导入数据…",
	"menu.closeWindow":     "关闭窗口",
	"menu.edit":            "编辑",
	"menu.view":            "视图",
	"menu.toggleDataPanel": "显示或隐藏数据面板",
	"menu.toggleTheme":     "切换主题",
	"menu.reload":          "重新加载",
	"menu.developer":       "开发者",
	"menu.openServiceLog":  "打开服务日志",
	"menu.help":            "帮助",
	"menu.documentation":   "文档",
	"menu.reportIssue":     "反馈问题",
	"menu.aboutBody":       "{name} {version}\n本地数据分析智能体。\n\n{url}",
	"menu.importTip":       "先打开一个对话再导入文件。",

	// 托盘
	"tray.show":    "显示窗口",
	"tray.hide":    "隐藏窗口",
	"tray.newChat": "新建对话",

	// 侧边栏
	"sidebar.newChat":    "新建对话",
	"sidebar.chats":      "会话",
	"sidebar.app":        "应用",
	"sidebar.data":       "数据",
	"sidebar.settings":   "设置",
	"sidebar.listFailed": "无法加载会话列表",
	"sidebar.empty":      "还没有会话",

	// 服务状态
	"status.ready":      "就绪",
	"status.starting":   "启动中",
	"status.restarting": "重启中",
	"status.failed":     "失败",
	"status.stopped":    "未运行",

	// 服务横幅
	"banner.stopped":      "智能体服务未运行。",
	"banner.starting":     "正在启动智能体服务…",
	"banner.restarting":   "智能体服务已停止（{error}），正在重启…",
	"banner.failed":       "智能体服务无法启动：{error}。",
	"banner.failedLog":    "它的日志在 {path}。",
	"banner.reconnecting": "正在重新连接会话…（{error}）",
	"banner.streamFailed": "无法打开会话：{error}",
	"banner.reconnected":  "已重新连接：智能体服务已重启，会话内容已是最新。",
	"banner.retry":        "重试",

	// 聊天页
	"chat.empty":           "就你的数据提个问题吧。",
	"chat.loading":         "正在加载会话…",
	"chat.lastReplyFailed": "上次回复没有完成：{error}",
	"chat.openSettings":    "打开设置",
	"chat.rename":          "重命名",
	"chat.renameTip":       "重命名此对话",
	"chat.data":            "数据",
	"chat.hideData":        "隐藏数据",
	"chat.dataTip":         "此对话的数据源、工作区与产物",
	"chat.busy":            "回复仍在生成。",
	"chat.queue":           "排队",
	"chat.steer":           "引导",
	"chat.enterMode":       "回复生成期间按 Enter 的作用",
	"chat.enterQueues":     "Enter 会把这条消息排在回复之后。",
	"chat.enterSteers":     "Enter 会把这条消息加入正在生成的回复。",
	"chat.queued":          "已排队 {count} 条",
	"chat.message":         "消息",
	"chat.placeholder":     "向你的数据提问",
	"chat.stop":            "停止",
	"chat.stopTip":         "停止回复并撤回排队的消息",
	"chat.send":            "发送",

	// 设置页
	"settings.title":       "设置",
	"settings.refresh":     "刷新设置",
	"settings.loading":     "正在加载模型设置…",
	"settings.loadFailed":  "无法加载设置：{error}",
	"settings.tryAgain":    "重试",
	"settings.unavailable": "智能体服务就绪后才能设置模型。",
	"settings.process":     "{status}：进程 {pid}",
	"settings.log":         "日志：{path}",
	"settings.providers":   "模型提供商",
	"settings.noProvider":  "还没有配置提供商，请在下面添加。",
	"settings.addProvider": "添加提供商",
	"settings.models":      "模型",
	"settings.general":     "通用",
	"settings.appearance":  "外观",
	"settings.system":      "跟随系统",
	"settings.light":       "浅色",
	"settings.dark":        "深色",
	"settings.language":    "语言",
	"settings.files":       "文件",
	"settings.dataDir":     "数据目录",
	"settings.serviceLog":  "服务日志",
	"settings.openFolder":  "打开文件夹",
	"settings.openLog":     "打开日志",
	"settings.notSet":      "未设置",
	"settings.saveFailed":  "无法保存偏好设置：{error}",
	"settings.themeTip":    "界面用浅色、深色，还是跟随系统",
	"settings.languageTip": "界面语言。模型输出、工具与日志保持原样。",

	// 数据面板
	"data.title":         "数据",
	"data.chat":          "会话 {id}",
	"data.refreshTip":    "重新加载数据源、工作区与产物",
	"data.hideTip":       "隐藏数据面板",
	"data.unavailable":   "智能体服务就绪后才能使用数据源。",
	"data.noChat":        "开始一个对话后就能添加数据源。",
	"data.loading":       "正在加载数据源…",
	"data.importTip":     "导入 CSV、Excel 或 PDF 文件",
	"data.removeAll":     "全部移除",
	"data.removeAllTip":  "移除这个对话的所有数据源",
	"data.copying":       "正在复制 {name}…",
	"data.empty":         "还没有数据源：导入文件，或连接数据库。",
	"data.tables":        "{count} 张表 · {state}",
	"data.inAnalysis":    "分析中",
	"data.preview":       "预览",
	"data.previewTip":    "预览 {name} 的表",
	"data.edit":          "编辑",
	"data.editTip":       "编辑 {name}",
	"data.remove":        "移除",
	"data.removeTip":     "移除 {name}",
	"data.previewTitle":  "预览：{name}",
	"data.loadingTables": "正在加载表…",
	"data.noTables":      "这个数据源没有表。",
	"data.rowsColumns":   "{rows} 行 · {columns} 列",
	"data.columnsOnly":   "{columns} 列 · 服务未报告行数",
	"data.schema":        "结构",
	"data.noSchema":      "服务没有报告结构。",
	"data.noRows":        "没有可预览的行。",
	"data.refresh":       "刷新",
	"data.hide":          "隐藏",
	"data.import":        "导入",
	"data.tabSources":    "数据源",
	"data.tabWorkspace":  "工作区",
	"data.tabArtifacts":  "产物",
	"data.tabsLabel":     "数据页签",
	"data.stateOpen":     "已打开",
	"data.stateClosed":   "已关闭",
	"data.connect":       "连接",
	"data.connectTip":    "连接远程数据源",
	"data.limit":         "文件不超过 {size}：.csv、.xlsx、.xls、.pdf。",
	"data.limitUnknown":  "导入开始时由服务给出上限。",
}

// resources 按语言查资源。langSystem 与陌生取值都退到英文。
var resources = map[string]messages{
	langEN: enMessages,
	langZH: zhMessages,
}

// tr 返回 key 在 lang 下的文案。args 是成对的占位符名与取值，替换文案里的 {name}。缺翻译时用英文；
// 两种语言都没有这个键时返回键名本身，测试里一眼能看出来。
func tr(lang, key string, args ...string) string {
	text := resources[lang][key]
	if text == "" {
		text = enMessages[key]
	}
	if text == "" {
		return key
	}
	if len(args) == 0 {
		return text
	}
	for i := 0; i+1 < len(args); i += 2 {
		text = strings.ReplaceAll(text, "{"+args[i]+"}", args[i+1])
	}
	return text
}

// tr 用界面当前的语言说一条文案。
func (a *app) tr(key string, args ...string) string {
	return tr(a.lang, key, args...)
}

// resolveLang 决定界面语言：显式选择优先；跟随系统时按系统语言列表匹配，匹配不上就用英文（源语言）。
func resolveLang(pref string, preferred []string) string {
	if pref == langEN || pref == langZH {
		return pref
	}
	if match := i18n.Match(preferred, uiLanguages); match != "" {
		return match
	}
	return langEN
}

// languageLabel 是语言选择里显示的名字：语言自己的写法（English、简体中文）。
func languageLabel(tag string) string {
	if tag == langSystem {
		return ""
	}
	if name := i18n.Autonym(tag); name != "" {
		return name
	}
	return tag
}
