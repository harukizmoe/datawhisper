#!/usr/bin/env bash
# 把旧网页的前端库（plotly / echarts / d3）放进桌面应用的资源目录。
#
# 图表 HTML 由 compute 生成，里面的脚本标签是旧 Flask 前端的绝对路径
# `/static/vendor/plotly.min.js`（见 Function/Charts_generation/chart_generate.py）。桌面应用用
# 自己的 dw-preview:// 处理器把这类请求指向资源目录里的 static/vendor，所以离线也能画图；
# 没带上这三个文件时图表走「静态资源缺失」的降级说明。
#
# 用法：
#   scripts/build/bundle-static.sh                 # 本机平台
#   scripts/build/bundle-static.sh linux/amd64
#
# 产物：<resources>/<goos>-<goarch>/static/vendor/{plotly.min.js,echarts.min.js,d3.v7.min.js}
# 资源目录默认 desktop/resources（mygo 按平台目录合并资源），可用 DW_RESOURCES_DIR 覆盖。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLATFORM="${1:-${DW_PLATFORM:-}}"
if [[ -z "$PLATFORM" ]]; then
  PLATFORM="$(go env GOOS)/$(go env GOARCH)"
fi

case "$PLATFORM" in
  linux/amd64|linux/arm64|darwin/amd64|darwin/arm64|windows/amd64|windows/arm64) ;;
  *)
    echo "bundle-static: unsupported platform '$PLATFORM' (use GOOS/GOARCH, e.g. linux/amd64)" >&2
    exit 2
    ;;
esac

TARGET_OS="${PLATFORM%/*}"
TARGET_ARCH="${PLATFORM#*/}"
RESOURCES="${DW_RESOURCES_DIR:-$ROOT/desktop/resources}"
SRC="$ROOT/static/vendor"
OUT_DIR="$RESOURCES/$TARGET_OS-$TARGET_ARCH/static/vendor"

FILES=(plotly.min.js echarts.min.js d3.v7.min.js)
for name in "${FILES[@]}"; do
  if [[ ! -f "$SRC/$name" ]]; then
    echo "bundle-static: missing $SRC/$name" >&2
    exit 2
  fi
done

mkdir -p "$OUT_DIR"
for name in "${FILES[@]}"; do
  cp -f "$SRC/$name" "$OUT_DIR/$name"
done
echo "bundle-static: $SRC -> $OUT_DIR"
ls -lh "$OUT_DIR"
