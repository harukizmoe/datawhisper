# 仓库约定

## 代码注释使用中文

所有代码注释与文档注释一律使用中文，包括：

- Python 的 `#` 注释与 docstring；
- TypeScript/JavaScript 的 `//`、`/* */`、JSDoc/TSDoc；
- Go 的 `//`、`/* */`；
- SQL、Shell、YAML、JSON5（含注释的配置）里的注释。

规则细则：

1. **只改注释，不改行为**。标识符、字符串字面量、日志文案、用户可见文案、错误消息、测试断言都保持原样；注释翻译不得顺带重构代码。
2. **提示词与 golden 数据不算注释**。例如 `server/src/agent/prompt-text/*.txt`、`server/test/golden/*.json`、`server/test/fixtures/**` 属于被测数据，内容必须与旧实现逐字一致，不得翻译。
3. 术语保留英文原词（如 `snapshot`、`ops`、`requestId`、`hook`），必要时中英并列，例如「增量（ops）」。
4. 注释解释「为什么」，复述代码在做什么的注释直接删掉。

## 仓库结构

| 目录 | 内容 | 语言 |
|---|---|---|
| `desktop/` | 桌面应用（原生 UI、web view 图表、托盘与菜单） | Go + MyGo |
| `server/` | agent 服务：模型回合、工具、长任务、工作流、MCP、飞书机器人 | TypeScript on Bun |
| `compute/` | 计算进程：数据源、SQL、统计、图表、导出 | Python |
| `Function/` | 计算实现（图表模板、清洗、知识库、产出物） | Python |
| `data/sources/` | 计算进程的数据源实现 | Python |
| `skills/`、`commands/`、`config/` | agent 的技能、斜杠命令与默认配置 | Markdown / JSON |
| `static/vendor/` | 图表页面依赖的 plotly / echarts / d3 | JS |
| `docs/refactor/` | 重构计划、协议文档、打包说明 | Markdown |
| `baseline/` | 计算工具的录制回放数据（`fixtures/`、`recordings/`） | JSON |

三条进程边界都是 **stdin/stdout 上的 JSON-RPC 2.0**：桌面端拉起服务，服务拉起计算进程。没有端口、没有令牌、没有 HTTP 服务，也不要有。

### desktop 的包结构

`desktop/main.go` 只解析命令行参数并调用 `app.Run`；`mygo.json`（打包配置，`"main": "."`）与 `resources/`（mygo 的平台资源目录）留在模块根。其余代码都在 `desktop/internal/`，依赖只向下：

| 包 | 内容 |
|---|---|
| `app` | MyGo 界面与状态，按功能分文件：`chat*.go`、`sources*.go`、`settings*.go`（`*_view.go` 是视图，其余是状态与动作）、`layout.go`、`appearance.go`、`shell.go`（菜单托盘拖放）、`run.go`（启动与装配） |
| `conversation` | 会话副本：snapshot 加 ops 还原出的消息、工具调用、图表；`Follow` 断线重订阅 |
| `service` | agent 服务的类型化客户端：会话、模型、数据源、工作区、产物、仪表盘、订阅 |
| `jsonrpc` | stdio 上的 JSON-RPC 2.0 传输：分帧、按 id 关联、通知回调；不认识业务方法 |
| `supervisor` | 服务进程的启动、监管与重启 |
| `preview` | web view 池与 `dw-preview://` 媒体服务、图表主题注入（不含界面） |
| `theme` | 配色 JSON（`themes/`）、主题推导、对比度护栏、字体回退 |
| `prefs` | `ui.json`：外观模式、配色与字体、界面语言的读写与校验 |
| `i18n` | 界面文案的中英文资源 |
| `icons` | Lucide 图标子集（`svg/`） |

## 常用命令

```bash
# 服务端
cd server && bunx tsc --noEmit -p . && bun test

# 桌面端
cd desktop && gofmt -l . && go vet ./... && go test -race -count=1 ./...

# 计算进程（用仓库根的 .venv）
.venv/bin/python -m unittest compute.tests.test_rpc compute.tests.test_tools compute.tests.test_ui_methods

# 开发运行
cd desktop && go run .

# 打包
scripts/build/build-app.sh
```

## 界面

- 一律使用 MyGo 官方组件（`github.com/egoist/mygo/ui`），不要用 `Row/Column/Text` 手搓控件。
  写之前先 `go doc -all github.com/egoist/mygo/ui | grep <组件>` 或查 `https://mygo.egoist.dev/docs/ui/<组件>.md`。
- 界面文案用英文，中文只出现在 `desktop/internal/i18n/i18n.go` 的资源里；模型输出、工具文案与日志不翻译。

## 提交

- 子代理不提交、不切换分支、不 pop/drop stash；由整合者检查后统一提交。
- 重构在 `refactor/pi-durable` 分支上完成并以 v0.1.0 合入 `main`；`87489fb` 是重构前的最后一个提交，可用 `git show 87489fb` 取回。
- 提交信息用中文，写清「做了什么 + 证据」。
