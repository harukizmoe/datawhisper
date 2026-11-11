#!/usr/bin/env bash
# 把 Bun 服务编译成单个可执行文件，放进桌面应用的资源目录。
#
# 用法：
#   scripts/build/bundle-server.sh                 # 本机平台
#   scripts/build/bundle-server.sh linux/amd64     # 交叉编译（bun --target）
#
# 产物：<resources>/<goos>-<goarch>/bin/datawhisper-server[.exe]
# 资源目录默认 desktop/resources（mygo 按平台目录合并资源），可用 DW_RESOURCES_DIR 覆盖。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLATFORM="${1:-${DW_PLATFORM:-}}"
if [[ -z "$PLATFORM" ]]; then
  PLATFORM="$(go env GOOS)/$(go env GOARCH)"
fi

case "$PLATFORM" in
  linux/amd64)  TARGET_OS=linux   TARGET_ARCH=amd64 BUN_TARGET=bun-linux-x64  ;;
  linux/arm64)  TARGET_OS=linux   TARGET_ARCH=arm64 BUN_TARGET=bun-linux-arm64 ;;
  darwin/amd64) TARGET_OS=darwin  TARGET_ARCH=amd64 BUN_TARGET=bun-darwin-x64 ;;
  darwin/arm64) TARGET_OS=darwin  TARGET_ARCH=arm64 BUN_TARGET=bun-darwin-arm64 ;;
  windows/amd64) TARGET_OS=windows TARGET_ARCH=amd64 BUN_TARGET=bun-windows-x64 ;;
  windows/arm64) TARGET_OS=windows TARGET_ARCH=arm64 BUN_TARGET=bun-windows-arm64 ;;
  *)
    echo "bundle-server: unsupported platform '$PLATFORM' (use GOOS/GOARCH, e.g. linux/amd64)" >&2
    exit 2
    ;;
esac

SUFFIX=""
if [[ "$TARGET_OS" == "windows" ]]; then
  SUFFIX=".exe"
fi

RESOURCES="${DW_RESOURCES_DIR:-$ROOT/desktop/resources}"
OUT_DIR="$RESOURCES/$TARGET_OS-$TARGET_ARCH/bin"
OUT="$OUT_DIR/datawhisper-server$SUFFIX"

if [[ ! -d "$ROOT/server/node_modules" ]]; then
  echo "bundle-server: server/node_modules is missing; run 'cd server && bun install --frozen-lockfile' first" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
# Bun 是原生程序：Git Bash 下给它 Windows 路径，避免它把 /d/a/... 当成相对路径。
BUN_OUT="$OUT"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if command -v cygpath >/dev/null 2>&1; then
      BUN_OUT="$(cygpath -w "$OUT")"
    fi
    ;;
esac
echo "bundle-server: bun ($BUN_TARGET) -> $OUT"
cd "$ROOT/server"
bun build --compile --target="$BUN_TARGET" --outfile "$BUN_OUT" src/main.ts
chmod +x "$OUT" 2>/dev/null || true
ls -lh "$OUT"
