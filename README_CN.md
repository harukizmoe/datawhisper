# DataWhisper（智析）

[English](./README.md)

本机单用户的数据分析桌面应用。用自然语言提问，agent 去查数据、画图，并把结论写下来。

没有账号、没有托管模型、没有云端存储：提供商与密钥由你自己配置，会话、图表、凭据全部留在这台机器上。

## 组成

| 部分 | 技术 | 作用 |
|---|---|---|
| 桌面端 | Go + [MyGo](https://mygo.egoist.dev) 原生 UI | 窗口、聊天、数据面板、设置 |
| agent 服务 | Bun + `@earendil-works/pi-durable` | 模型回合、工具、长任务、MCP、飞书机器人 |
| 计算进程 | Python（pandas / DuckDB / Plotly） | 载入数据、SQL、统计、图表、导出 |
| 图表与仪表盘 | Web view（Plotly / ECharts / D3） | 在聊天与产物面板里内嵌渲染 |

三个进程用管道相连：桌面端拉起服务，服务拉起计算进程。所有边界都是 stdin/stdout 上的
JSON-RPC 2.0 —— 没有端口、没有令牌、没有 HTTP 服务。

## 从源码运行

需要：Go 1.24+、Bun 1.4+、带虚拟环境的 Python 3.11，Linux 上还需要 WebKitGTK 4.1（`webkit2gtk-4.1`）。

```bash
python3 -m venv .venv
.venv/bin/pip install -r compute/requirements.txt
bun install --cwd server

# 开发模式启动桌面端（它会自己拉起服务）
cd desktop && go run .
```

首次使用：打开 **Settings → Models**，选一个预设（本机 Ollama、本机 OpenAI 兼容网关、AtlasCloud），
或自己填任意 OpenAI 兼容地址；填密钥后点 **Discover models** 从端点读取上下文长度与能力（不用手抄），
保存前先点 **Test**。

然后 **File → New chat**，直接提问；把 CSV/XLSX/PDF 拖进窗口即可导入。

## 功能

- **聊天** —— 流式 Markdown、思考过程、工具调用折叠成一行（可展开）、内嵌图表、斜杠命令、中止与排队、
  `ask_user` 问题卡片。
- **数据面板** —— 导入文件、连接 SQL / Google Sheets / 飞书 / HTTP 数据源、预览表与 schema、
  选择哪些表参与分析、挂载工作区目录。
- **分析** —— DuckDB 上的 SQL、41 种图表、统计模板、数据清洗、Excel/报告/PPT/仪表盘导出、
  知识库（指标、规则、笔记，本地向量）。
- **可信** —— 数字溯源门会拒绝回答里没有工具结果支撑的数值；超长工具结果外溢成制品，模型必须显式读取；
  写操作需要确认。
- **本地优先** —— 每个用户数据目录一个 SQLite；凭据进系统钥匙串（没有时落 `0600` 文件）；无遥测。

## 数据位置

| 平台 | 路径 |
|---|---|
| Linux | `~/.local/share/datawhisper` |
| macOS | `~/Library/Application Support/DataWhisper` |
| Windows | `%APPDATA%\DataWhisper` |

可用 `DW_DATA_DIR` 覆盖。目录里有 `datawhisper.sqlite`（会话、任务）、`library.sqlite`（标题、hooks、
归档运行记录）、`uploads/`、`outputs/`（图表与导出）、`tool_results/`（外溢的工具结果）。

## 打包

```bash
scripts/build/build-app.sh              # Linux：desktop/build/ 下的 deb + tar.gz + PKGBUILD
scripts/build/build-app.sh -platform darwin/universal
```

各平台前置依赖、签名与自动更新密钥见 [`docs/refactor/packaging.md`](docs/refactor/packaging.md)。
CI（`.github/workflows/`）会跑三个测试套件与打包矩阵。

## 从旧版升级

旧版是带登录、配额与托管模型的 Flask 网页应用，那套代码已删除；旧会话、job 记录与工作流运行可以导入：

```bash
cd server && bun run scripts/migrate-old-data.ts --from <旧仓库> --to <数据目录> --dry-run
```

确认报告无误后去掉 `--dry-run`。旧 job 与工作流记录会成为只读归档。

## 文档

- [`docs/refactor/pi-durable-plan.md`](docs/refactor/pi-durable-plan.md) —— 重构计划与验收证据
- [`docs/refactor/ui-protocol.md`](docs/refactor/ui-protocol.md) —— 桌面端与服务的管道协议
- [`docs/refactor/ipc-uploads.md`](docs/refactor/ipc-uploads.md) —— 文件导入如何跨管道
- [`docs/refactor/packaging.md`](docs/refactor/packaging.md) —— 安装包、签名、发布

## 许可

见 [LICENSE](LICENSE)。
