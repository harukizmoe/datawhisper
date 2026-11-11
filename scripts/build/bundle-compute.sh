#!/usr/bin/env bash
# 用 PyInstaller 把 compute worker 打包成单个可执行文件（`datawhisper-compute`）。
#
# PyInstaller 不能交叉编译：必须在目标平台上运行，Windows 上需要 Windows 的 Python。
# 它只是打包期工具，不写进 requirements*.txt；未安装时脚本会说明如何安装。
#
# 用法：
#   scripts/build/bundle-compute.sh
#
# 产物：<resources>/<goos>-<goarch>/bin/datawhisper-compute[.exe]
# 资源目录默认 desktop/resources，可用 DW_RESOURCES_DIR 覆盖。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESOURCES="${DW_RESOURCES_DIR:-$ROOT/desktop/resources}"
TARGET_OS="$(go env GOOS)"
TARGET_ARCH="$(go env GOARCH)"
SUFFIX=""
if [[ "$TARGET_OS" == "windows" ]]; then
  SUFFIX=".exe"
fi
OUT_DIR="$RESOURCES/$TARGET_OS-$TARGET_ARCH/bin"
OUT="$OUT_DIR/datawhisper-compute$SUFFIX"

# 解释器：DW_PYTHON > 仓库 venv > python3。
if [[ -n "${DW_PYTHON:-}" ]]; then
  PYTHON="$DW_PYTHON"
elif [[ -x "$ROOT/.venv/bin/python" ]]; then
  PYTHON="$ROOT/.venv/bin/python"
elif [[ -x "$ROOT/.venv/Scripts/python.exe" ]]; then
  PYTHON="$ROOT/.venv/Scripts/python.exe"
else
  PYTHON="python3"
fi

if ! "$PYTHON" -c "import PyInstaller" >/dev/null 2>&1; then
  cat >&2 <<EOF
bundle-compute: PyInstaller is not installed for $PYTHON.
Install it as a build-time tool only (it is not a runtime dependency):
  uv pip install --python "$PYTHON" "pyinstaller==6.22.3"
  # or: "$PYTHON" -m pip install "pyinstaller==6.22.3"
EOF
  exit 2
fi

# PyInstaller 的 --add-data 用平台相关的分隔符：Windows 是 ';'，其他是 ':'。
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) SEP=";"; NATIVE_PATH=1 ;;
  *) SEP=":"; NATIVE_PATH=0 ;;
esac

# PyInstaller 是原生程序：在 Git Bash 里要把 /d/a/... 换成 D:\a\...，否则它按相对路径解析。
native() {
  if [[ "$NATIVE_PATH" == "1" ]] && command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}
PY_ROOT="$(native "$ROOT")"

WORK="${DW_COMPUTE_BUILD_DIR:-$ROOT/desktop/build/compute}"
PY_WORK="$(native "$WORK")"
rm -rf "$WORK"
mkdir -p "$WORK" "$OUT_DIR"

echo "bundle-compute: $PYTHON -> $OUT"
# compute/tools/__init__.py 在运行期把 _MEIPASS/Function 等目录加进 sys.path，所以 Function 要随包带源码与
# HTML/字体等资源；Information 是知识库的只读资料。data/ 是普通 Python 包，PyInstaller 会静态收集。
"$PYTHON" -m PyInstaller \
  --noconfirm --clean --onefile \
  --name datawhisper-compute \
  --distpath "$PY_WORK/dist" \
  --workpath "$PY_WORK/build" \
  --specpath "$PY_WORK" \
  --paths "$PY_ROOT" \
  --add-data="$(native "$ROOT/Function")${SEP}Function" \
  --add-data="$(native "$ROOT/Information")${SEP}Information" \
  --exclude-module tkinter \
  "$(native "$ROOT/scripts/build/compute_entry.py")"

cp "$WORK/dist/datawhisper-compute$SUFFIX" "$OUT"
chmod +x "$OUT" 2>/dev/null || true
ls -lh "$OUT"
