# DataWhisper

[简体中文](./README_CN.md)

A local, single-user desktop app for business data analysis. Ask questions in natural language; the agent
queries your data, draws charts, and writes the conclusions down.

No account, no hosted model, no cloud storage: you bring your own model endpoint and key, and everything
(sessions, charts, credentials) stays on this machine.

## What it is

| Piece | Technology | Role |
|---|---|---|
| Desktop app | Go + [MyGo](https://mygo.egoist.dev) native UI | Windows drawing, chat, data panel, settings |
| Agent service | Bun + `@earendil-works/pi-durable` | Model turns, tools, durable tasks, MCP, Feishu bot |
| Compute worker | Python (pandas / DuckDB / Plotly) | Data loading, SQL, statistics, charts, exports |
| Charts & dashboards | Web view (Plotly, ECharts, D3) | Rendered inside the chat and the artifact panel |

The three processes talk over pipes: the desktop app spawns the service, the service spawns the compute
worker. Every boundary is JSON-RPC 2.0 over stdin/stdout — no ports, no tokens, no HTTP server.

## Quick start (from source)

Requirements: Go 1.24+, Bun 1.4+, Python 3.11 with a virtualenv, and WebKitGTK 4.1 on Linux
(`webkit2gtk-4.1`).

```bash
python3 -m venv .venv
.venv/bin/pip install -r compute/requirements.txt
bun install --cwd server

# Desktop app in development mode (it starts the service itself)
cd desktop && go run .
```

First run: open **Settings → Models**, pick a provider preset (local Ollama, a local OpenAI-compatible
gateway, AtlasCloud) or add any OpenAI-compatible endpoint, paste the key, then **Discover models** to pull
the context limits from the endpoint instead of typing them by hand. Use **Test** before saving.

Then **File → New chat**, type a question, and drag a CSV/XLSX/PDF into the window to import it.

## Features

- **Chat** — streaming Markdown, thinking steps, tool calls collapsed to one line (expandable), inline charts,
  slash commands, interrupt/queue, `ask_user` question cards.
- **Data panel** — import files, connect SQL / Google Sheets / Feishu / HTTP sources, preview tables and schemas,
  choose which columns tables take part in analysis, mount a workspace folder.
- **Analysis** — SQL over DuckDB, 41 chart types, statistical templates, cleaning, Excel/report/PPT/dashboard
  exports, knowledge base (metrics, rules, notes) with local embeddings.
- **Trust** — a numeric provenance gate rejects numbers in the final answer that no tool result supports;
  long tool results spill to artifacts the model must re-read explicitly; write tools ask for confirmation.
- **Local by default** — one SQLite database per user data directory, credentials in the OS keychain (or a
  `0600` file when there is none), no telemetry.

## Data locations

| Platform | Path |
|---|---|
| Linux | `~/.local/share/datawhisper` |
| macOS | `~/Library/Application Support/DataWhisper` |
| Windows | `%APPDATA%\DataWhisper` |

Set `DW_DATA_DIR` to override. The directory holds `datawhisper.sqlite` (sessions, tasks), `library.sqlite`
(titles, hooks, archived runs), `uploads/`, `outputs/` (charts, exports), and `tool_results/` (spilled tool
outputs).

## Building installers

```bash
scripts/build/build-app.sh              # Linux: deb + tar.gz + PKGBUILD under desktop/build/
scripts/build/build-app.sh -platform darwin/universal
```

See [`docs/refactor/packaging.md`](docs/refactor/packaging.md) for per-platform prerequisites, signing and
auto-update keys. CI (`.github/workflows/`) runs the three test suites and the packaging matrix.

## Upgrading from the old web app

The previous version was a Flask web app with login, quotas and hosted models. That code is gone; existing
sessions, job records and workflow runs can be imported:

```bash
cd server && bun run scripts/migrate-old-data.ts --from <old repo> --to <data dir> --dry-run
```

Drop `--dry-run` once the report looks right. Old job and workflow records become read-only archives.

## Documentation

- [`docs/refactor/pi-durable-plan.md`](docs/refactor/pi-durable-plan.md) — the refactor plan and its evidence
- [`docs/refactor/ui-protocol.md`](docs/refactor/ui-protocol.md) — the pipe protocol between app and service
- [`docs/refactor/ipc-uploads.md`](docs/refactor/ipc-uploads.md) — how file imports cross the pipe
- [`docs/refactor/packaging.md`](docs/refactor/packaging.md) — installers, signing, release

## License

See [LICENSE](LICENSE).
