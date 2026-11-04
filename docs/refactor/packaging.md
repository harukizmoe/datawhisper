# 打包与发布（P9）

桌面应用由三个运行时组成，安装包里各占一个可执行文件：

| 部分 | 来源 | 包内位置 | 构建方式 |
|---|---|---|---|
| 桌面外壳 | `desktop/`（Go + MyGo，无 cgo） | 应用本体 | `mygo build` |
| agent 服务 | `server/`（Bun + TS） | `resources/bin/datawhisper-server[.exe]` | `bun build --compile`，单文件 |
| compute | `compute/` + `Function/` + `Information/` | `resources/bin/datawhisper-compute[.exe]` | PyInstaller `--onefile` |
| 图表静态库 | `static/vendor/`（plotly、echarts、d3） | `resources/static/vendor/` | `bundle-static.sh` 复制三个文件 |

`desktop/resources/<goos>-<goarch>/bin/` 是 mygo 的[平台资源目录](https://github.com/egoist/mygo/blob/main/docs/distribution.md#platform-resources)：
打包时只合并目标平台的那一份，Linux 应用里不会混进 Windows 的 `.exe`。用平台目录而不是共享的
`resources/bin/` 是这里唯一与最初计划不同的地方；`mygo.json` 因此不需要 `resources` 字段，
`resources/` 目录本身由 mygo 自动随包复制。

## 产物

| 平台 | `desktop/build/<os>-<arch>/` |
|---|---|
| Linux | `datawhisper`、`datawhisper.desktop`、图标、`datawhisper_0.1.0_amd64.deb`、`datawhisper-0.1.0-linux-amd64.tar.gz`（含 `install.sh`）、`PKGBUILD` |
| macOS | `DataWhisper.app`、`datawhisper-0.1.0-arm64.dmg` |
| Windows | `datawhisper.exe` 及其文件、`datawhisper-setup-0.1.0-amd64.exe`（NSIS） |

版本号只写在 `desktop/mygo.json` 的 `version`；`App.Version()`、安装器和包名都取它。

## 本地打包

```sh
cd server && bun install --frozen-lockfile   # 编译服务需要依赖
# PyInstaller 只是打包期工具，不入 requirements
uv pip install --python .venv/bin/python "pyinstaller==6.22.3"

scripts/build/build-app.sh                    # 本机平台
scripts/build/build-app.sh -platform windows/amd64   # 交叉编译（需要 bun；compute 不能交叉）
```

脚本顺序：`bundle-server.sh` → `bundle-compute.sh` → `bundle-static.sh` → `go run github.com/egoist/mygo/cmd/mygo@v0.7.4 build ./desktop`。
`bundle-static.sh` 把仓库的 `static/vendor/{plotly,echarts,d3}` 复制到
`desktop/resources/<goos>-<goarch>/static/vendor/`：图表 HTML 引用旧网页的 `/static/vendor/*`，桌面应用的
`dw-preview://` 处理器从这里取，离线也能画图。开发时没有这一步，`findStaticDir()` 会从可执行文件与工作目录
向上找仓库里的 `static/`；也可以用 `DW_STATIC_DIR` 显式指定。
环境变量：`DW_RESOURCES_DIR`（资源根，默认 `desktop/resources`）、`DW_SKIP_COMPUTE=1`（不打包 compute，
安装包要求用户自备 Python）、`DW_SKIP_INSTALLER=1`、`DW_SKIP_NOTARIZE=1`、`DW_SIGN_IDENTITY`。

## 平台前置依赖

| 平台 | 构建 | 运行 |
|---|---|---|
| Linux | Go 1.27+、Bun 1.4、Python 3.11、PyInstaller、`dpkg-deb`/`tar` | GTK 3 与 WebKitGTK 4.1（Debian/Ubuntu `libwebkit2gtk-4.1-0`，Arch `webkit2gtk-4.1`，Fedora `webkit2gtk4.1`）；桌面条目与 deb 已声明依赖 |
| macOS | 同上（`brew install makensis` 只有构建 Windows 包时才需要）；签名、公证与 dmg 必须在本机做 | macOS 12+，无需额外运行时 |
| Windows | Go 1.27+、Bun 1.4、Python 3.11、PyInstaller；NSIS（`choco install nsis`，没有时 mygo 会自行下载） | WebView2 Runtime（Windows 11 自带） |

PyInstaller 不能交叉编译，所以 Windows 包必须在 Windows 上出；macOS 应用只在 macOS 上签名与生成 dmg。

## 运行期路径

`desktop/bundle.go` 在可执行文件旁边找随包资源：Linux/Windows 看 `<应用目录>/bin/`，macOS 看
`Contents/Resources/bin/`。找到服务时 `newSupervisor` 直接启动它，并把 `DW_PYTHON` 指向
`datawhisper-compute`、`DW_COMPUTE_CWD` 指向资源根；`-service` / `-python` / `-compute-cwd` 仍然优先，
所以 `go run .` 的开发流程不变（可执行文件在临时目录，旁边没有 `bin/`）。

编译后的服务没有仓库目录：`import.meta.dir` 是 Bun 的虚拟路径 `/$bunfs/root`（Windows 为
`B:\~BUN\root`）。`server/src/config.ts` 据此把默认值改为从 `process.execPath` 推算的资源根；
工作区根（`DW_PROJECT_ROOT`）默认为用户数据目录。数据目录仍是 `DW_DATA_DIR`，日志在
`<数据目录>/logs/service.log`。

**升级只换文件**：Linux（`/opt/datawhisper` 或 `~/.local/datawhisper.app`）与 Windows
（`%LOCALAPPDATA%\Programs\DataWhisper`）里，替换 `bin/datawhisper-server` 或
`bin/datawhisper-compute` 后重启应用即可。macOS 的 `.app` 是签名的密封包，替换内部文件会使签名失效，
需要重新 `codesign`，所以 macOS 走完整安装包或 mygo 的自动更新。

## 签名、公证与更新

没有凭据也能出包：macOS 是 ad-hoc 签名，Windows 无签名，安装器照常生成。凭据用仓库 secret：

| Secret | 用途 |
|---|---|
| `MACOS_CERTIFICATE` / `MACOS_CERTIFICATE_PASSWORD` | base64 的 Developer ID Application `.p12` 及其密码 |
| `MACOS_SIGNING_IDENTITY` | 例如 `Developer ID Application: Example Inc. (TEAMID)`；有它时 CI 才 `-sign` |
| `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_PASSWORD` | 公证凭据；还要在 `mygo.json` 里加 `macos.notarize.keychainProfile` |
| `MYGO_UPDATER_PRIVATE_KEY` | mygo 自动更新的签名私钥；另有 `MYGO_WINDOWS_CERTIFICATE_PASSWORD` 给 Windows 代码签名 |

自动更新需要 `mygo keygen` 生成的公钥写进 `mygo.json` 的 `updates.publicKey` 加 `updates.github`；
未配置前 `-upload` 与更新清单都不会生成，这是有意的：不要让未签名的包进入更新通道。

## CI

- `.github/workflows/ci.yml`：`server`（`bun install --frozen-lockfile`、`tsc --noEmit`、`timeout 900 bun test --timeout 60000`）、
  `compute`（Python 3.11 + `requirements.txt`，`timeout 1800 python -m unittest compute.tests.test_{rpc,tools,ui_methods}`）、
  `desktop`（`gofmt -l`、`go vet`、`xvfb-run go test -race`）。
- `.github/workflows/package.yml`：`ubuntu-latest` / `windows-latest` / `macos-latest` 三个 runner 各出本平台包，
  上传 `desktop/build/<os>-<arch>/` 的安装包；macOS 有 secret 才签名，否则 `-skip-notarize`。
- 两个工作流都不访问模型 API，也不需要 API key；compute 的测试只读 `baseline/` 里的录制品。

## 已知限制

- compute 的 PyInstaller 包很大（本机实测 289 MB，服务 92 MB）；`--onefile` 首次启动要解压到临时目录。
- `Function/`、`Information/` 作为数据随包（`_MEIPASS`）。图表与 PPT 引擎以裸模块名从
  `_MEIPASS/Function/...` 导入，依赖必须在冻结时收集齐全；新增这类动态导入时要重新验证包。
- 没有 PyInstaller 的平台（例如受限的 CI）可用 `DW_SKIP_COMPUTE=1` 出包，运行期由用户提供 Python；
  服务会在第一次使用 compute 时报错，而不是整个应用起不来。
- Linux 的 `install.sh` 不安装 WebKitGTK，只提示安装命令；deb/PKGBUILD 声明了依赖。
- `darwin/universal` 需要同时准备 `darwin-arm64` 与 `darwin-amd64` 两份资源；CI 目前只出 arm64。
