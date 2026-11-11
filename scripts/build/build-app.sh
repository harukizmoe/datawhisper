#!/usr/bin/env bash
# 打桌面安装包的入口：先准备随包的服务与 compute，再让 mygo build 打包。
#
# 用法：
#   scripts/build/build-app.sh                        # 本机平台
#   scripts/build/build-app.sh -platform linux/amd64  # 指定目标（其余参数转给 mygo build）
#
# 常用环境变量：
#   DW_SKIP_COMPUTE=1      不打包 compute（安装包会要求用户自备 Python；见 docs/refactor/packaging.md）
#   DW_SKIP_INSTALLER=1    不生成 Windows 安装器（也不需要 NSIS）
#   DW_SKIP_NOTARIZE=1     不公证 macOS 磁盘映像（CI 没有凭据时）
#   DW_SIGN_IDENTITY=...   macOS 签名身份，等价于 mygo build -sign
#
# 产物在 desktop/build/<os>-<arch>/；Linux 有 deb、tar.gz（含 install.sh）和 PKGBUILD。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# mygo 的版本由 desktop/go.mod 固定（v0.7.4）。在 desktop 模块里 `go run` 取它，比 `@v0.7.4` 少一次
# 模块代理往返：离线、代理抖动时也能打包。
MYGO_DIR="$ROOT/desktop"
MYGO=(go run github.com/egoist/mygo/cmd/mygo)

PLATFORM=""
MYGO_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -platform|--platform)
      PLATFORM="${2:-}"
      shift 2
      ;;
    *)
      MYGO_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -n "$PLATFORM" ]]; then
  export DW_PLATFORM="$PLATFORM"
fi

echo "==> bundle server"
if [[ "$PLATFORM" == "darwin/universal" ]]; then
  # mygo 的 universal 应用要求两个架构各有自己的资源目录（稍后由 lipo 合并）。
  "$ROOT/scripts/build/bundle-server.sh" darwin/arm64
  "$ROOT/scripts/build/bundle-server.sh" darwin/amd64
elif [[ -n "$PLATFORM" ]]; then
  "$ROOT/scripts/build/bundle-server.sh" "$PLATFORM"
else
  "$ROOT/scripts/build/bundle-server.sh"
fi

if [[ "${DW_SKIP_COMPUTE:-0}" != "1" ]]; then
  echo "==> bundle compute"
  "$ROOT/scripts/build/bundle-compute.sh"
else
  echo "==> bundle compute: skipped (DW_SKIP_COMPUTE=1)"
fi

echo "==> bundle static"
# 图表 HTML 引用旧网页的 /static/vendor/*；它们随包，图表在离线机器上也能画。
if [[ "$PLATFORM" == "darwin/universal" ]]; then
  "$ROOT/scripts/build/bundle-static.sh" darwin/arm64
  "$ROOT/scripts/build/bundle-static.sh" darwin/amd64
elif [[ -n "$PLATFORM" ]]; then
  "$ROOT/scripts/build/bundle-static.sh" "$PLATFORM"
else
  "$ROOT/scripts/build/bundle-static.sh"
fi

echo "==> mygo build"
BUILD_ARGS=(build "$ROOT/desktop")
if [[ -n "$PLATFORM" ]]; then
  BUILD_ARGS+=(-platform "$PLATFORM")
fi
if [[ "${DW_SKIP_INSTALLER:-0}" == "1" ]]; then
  BUILD_ARGS+=(-skip-installer)
fi
if [[ "${DW_SKIP_NOTARIZE:-0}" == "1" ]]; then
  BUILD_ARGS+=(-skip-notarize)
fi
if [[ -n "${DW_SIGN_IDENTITY:-}" ]]; then
  BUILD_ARGS+=(-sign "$DW_SIGN_IDENTITY")
fi
BUILD_ARGS+=("${MYGO_ARGS[@]}")

cd "$MYGO_DIR"
"${MYGO[@]}" "${BUILD_ARGS[@]}"

echo "==> artifacts"
find "$ROOT/desktop/build" -maxdepth 2 -type f \( -name '*.deb' -o -name '*.tar.gz' -o -name '*.dmg' -o -name '*.exe' -o -name 'PKGBUILD' -o -name '*.AppImage' \) -print 2>/dev/null | sort
