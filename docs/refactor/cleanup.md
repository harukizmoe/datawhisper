# 旧代码清理清单（P10）

重构后，仓库同时存在两套实现：新的 `server/`（Bun）+ `desktop/`（Go/MyGo）+ `compute/`（Python 计算进程），
以及旧的 Flask 应用（`app.py` + `api/` + `agent/` + `templates/` + `static/`）。P10 把旧的那套删掉。

删除前先确认：**`compute/` 与 `Function/` 不再引用旧模块**（除下面列出的两个例外）。

## 依赖现状（实测）

| 引用方 | 被引用 | 处置 |
|---|---|---|
| `compute/tools/data.py:983` | `LLM.chart_selector`（`select_charts` / `format_selection_result`） | **保留 `LLM/chart_selector.py` + `LLM/chart_rules.yaml`**，或把它移到 `compute/charts_selector.py`（推荐后者，P10 里做）；其余 `LLM/*` 删除 |
| `Function/Charts_generation/chart_generate.py:459` | `LLM.chart_selector._CHARTS`（必填角色注册表） | 同上，随选中的落点调整 import |
| `scripts/golden/*.py` | 旧 `agent/`（生成 golden 用） | golden 已提交在 `server/test/golden/`；生成器归档到 tag，仓库内删除（或移到 `docs/refactor/parity/` 附说明） |
| `baseline/*.py` | 旧 `api/`/`agent/`（行为基线脚本） | 基线已被 `server/test/**` 覆盖；删除，把 `docs/refactor/` 里的基线结果保留为文档 |

## 删除

| 路径 | 内容 | 说明 |
|---|---|---|
| `app.py` | Flask 入口 | 传输已改为 stdio JSON-RPC |
| `api/` | 288 条路由、登录/鉴权/管理后台 | 功能已按界面重新定义在 `server/src/ipc/*` |
| `agent/` | 旧 agent 循环、工具、hooks、压缩、MCP 管理、工作流 | 已迁到 `server/src/{agent,tools,jobs,workflows,teams,mcp}` |
| `LLM/`（除 `chart_selector.py`、`chart_rules.yaml`） | 提供商配置、prompt cache、MCP 配置 | 现在是 `server/src/models/**` 与 `server/src/mcp/**` |
| `templates/`、`static/`（除 `static/vendor/{plotly,echarts,d3}*`） | 旧网页前端 | 桌面端是原生 UI；图表只用那三个 JS 库 |
| `static/drawio/`（147 MB） | 旧 drawio 编辑器 | 桌面端不支持编辑画布，只读入口用外部 drawio |
| `frontend/` | 独立的 Vite 前端 | 同上 |
| `Dockerfile`、`railway.json`、`deploy/`、`vercel*` | 云部署 | 产品定位改为本地单用户 |
| `installer/`（34 MB）、`packaging/`、`remote_runner/` | 旧的安装/打包脚本 | 由 `scripts/build/` + `mygo build` 取代 |
| `start.bat`、`start.command`、`install.sh`、`install.ps1` | 旧启动脚本 | 同上 |
| `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`package.json`、`eslint.config.js` | 旧前端工具链 | 没有前端构建了（`server/` 与 `desktop/` 各自有自己的配置） |
| `requirements.txt` | 混合了 Flask/网页依赖 | 改为 `compute/requirements.txt`（只列计算侧依赖），并核对 `pyproject.toml` |
| `Information/assets/`（15 MB） | README 截图 | 文档里改为不放图，或移到 `docs/assets` 并压缩 |

## 保留

| 路径 | 原因 |
|---|---|
| `server/`、`desktop/`、`compute/`、`scripts/` | 新实现 |
| `Function/`（13 MB） | compute 的图表/清洗/知识库/输出实现 |
| `data/sources/` | compute 的数据源实现（其余 `data/*.py` 删除） |
| `skills/`、`commands/` | agent 的技能与命令资源 |
| `config/` | hooks 与默认配置 |
| `infrastructure/` | `paths.py` 等计算侧基础设施（检查是否只剩这部分） |
| `Information/*.md` | 产品说明与版本记录（`assets/` 另议） |
| `static/vendor/{plotly.min.js,echarts.min.js,d3.v7.min.js}` | 图表 HTML 运行时依赖，随包 |

## 文档

- `README.md` / `README_CN.md`：重写为「本机单用户桌面应用」：安装包、首次配置提供商、导入数据、隐私与本地存储位置。
- `AGENTS.md`：保留中文注释规则，补充新目录结构（`server/`、`desktop/`、`compute/`）与常用命令。
- `docs/refactor/pi-durable-plan.md`：把 §5 的清单全部勾掉，并在末尾附「与旧实现的差异」汇总。
- `CHANGELOG.md`：新增 `0.1.0` 条目（重构说明 + 不兼容变更：无登录、无云端、无 Web 版）。

## 验收

- `cd server && bunx tsc --noEmit -p . && bun test`（全绿）
- `cd desktop && gofmt -l . && go vet ./... && go test -race -count=1 ./...`（全绿）
- `.venv/bin/python -m unittest compute.tests.test_rpc compute.tests.test_tools compute.tests.test_ui_methods`（全绿）
- 全仓库搜不到对 `api/`、`agent/`、`templates/` 的 import（除归档说明）
- 用 `desktop/resources/.../bin/datawhisper-server` 与冻结 compute 起一次真实对话（含一次工具调用与一张图表）
