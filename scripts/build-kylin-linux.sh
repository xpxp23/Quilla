#!/usr/bin/env bash
# ==============================================================================
# Quilla (羽墨) v0.13.0 — 银河麒麟系统 (Kylin OS V10) & 海光 3350 一键编译与打包脚本
# 特性：
# 1. 自动识别海光 C86 3350 (x86_64 Zen 架构 8核16线程)，开启 AVX2/FMA/BMI2 硬件指令集优化；
# 2. 自动检测银河麒麟 V10 SP1 常见的 WebKitGTK 4.0 环境，若系统仅有 4.0 则自动生成
#    `.kylin-compat-sysroot` (pkg-config + 动态库符号桥接)，无需更改系统源即可编译 Tauri v2；
# 3. 编译完成后自动调用 `scripts/package-kylin-deb.sh` 生成银河麒麟专用 `.deb` 安装包与便携版 `.tar.gz`。
# ==============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}======================================================================${NC}"
echo -e "${CYAN}  Quilla (羽墨) v0.13.0 · 银河麒麟 (Kylin OS) & 海光 3350 构建管线${NC}"
echo -e "${CYAN}======================================================================${NC}"

ARCH="$(uname -m)"
CPU_NAME="$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || echo "$ARCH")"
CORES="$(nproc 2>/dev/null || echo 8)"
echo -e "目标架构: ${GREEN}${ARCH}${NC} | 处理器: ${GREEN}${CPU_NAME}${NC} | 并行核心: ${GREEN}${CORES}${NC}"

# ------------------------------------------------------------------------------
# 1. 银河麒麟 V10 WebKitGTK 4.0 -> 4.1 编译期自动桥接层 (.kylin-compat-sysroot)
# ------------------------------------------------------------------------------
setup_webkit_compat_bridge() {
  if pkg-config --exists webkit2gtk-4.1 2>/dev/null && pkg-config --exists javascriptcoregtk-4.1 2>/dev/null; then
    echo -e "${GREEN}✓ 检测到原生 webkit2gtk-4.1 与 javascriptcoregtk-4.1 开发库${NC}"
    return 0
  fi

  if ! pkg-config --exists webkit2gtk-4.0 2>/dev/null; then
    echo -e "${RED}✗ 未检测到 webkit2gtk-4.1 或 webkit2gtk-4.0 开发库！${NC}"
    echo -e "${YELLOW}请先运行: bash scripts/install-kylin-deps.sh${NC}"
    exit 1
  fi

  echo -e "${YELLOW}⚙ 检测到银河麒麟系统提供 webkit2gtk-4.0，正在构建 webkit2gtk-4.1 编译桥接层...${NC}"
  COMPAT_DIR="$ROOT_DIR/.kylin-compat-sysroot"
  PC_DIR="$COMPAT_DIR/pkgconfig"
  LIB_DIR="$COMPAT_DIR/lib"
  mkdir -p "$PC_DIR" "$LIB_DIR"

  WK40_VER="$(pkg-config --modversion webkit2gtk-4.0 2>/dev/null || echo '2.38.0')"
  WK40_CFLAGS="$(pkg-config --cflags webkit2gtk-4.0)"
  WK40_LIBS="$(pkg-config --libs webkit2gtk-4.0)"
  JSC40_CFLAGS="$(pkg-config --cflags javascriptcoregtk-4.0)"
  JSC40_LIBS="$(pkg-config --libs javascriptcoregtk-4.0)"
  SOUP_CFLAGS="$(pkg-config --cflags libsoup-2.4 2>/dev/null || echo '')"
  SOUP_LIBS="$(pkg-config --libs libsoup-2.4 2>/dev/null || echo '-lsoup-2.4')"

  cat > "$PC_DIR/javascriptcoregtk-4.1.pc" <<EOF
Name: JavaScriptCoreGTK+
Description: JavaScript engine library for GTK (Kylin 4.0->4.1 Bridge)
Version: ${WK40_VER}
Cflags: ${JSC40_CFLAGS}
Libs: -L${LIB_DIR} ${JSC40_LIBS}
EOF

  cat > "$PC_DIR/webkit2gtk-4.1.pc" <<EOF
Name: WebKit2GTK
Description: Web content engine for GTK (Kylin 4.0->4.1 Bridge)
Version: ${WK40_VER}
Requires: gtk+-3.0 javascriptcoregtk-4.1
Cflags: ${WK40_CFLAGS}
Libs: -L${LIB_DIR} ${WK40_LIBS}
EOF

  cat > "$PC_DIR/libsoup-3.0.pc" <<EOF
Name: libsoup
Description: HTTP client/server library for GNOME (Kylin 2.4->3.0 Bridge)
Version: 3.0.0
Cflags: ${SOUP_CFLAGS}
Libs: -L${LIB_DIR} ${SOUP_LIBS}
EOF

  # 查找系统库路径并创建编译期 .so 符号链接
  SYS_LIB_DIRS=(
    "/usr/lib/x86_64-linux-gnu"
    "/lib/x86_64-linux-gnu"
    "/usr/lib64"
    "/usr/lib"
  )
  for sdir in "${SYS_LIB_DIRS[@]}"; do
    if [ -e "$sdir/libwebkit2gtk-4.0.so" ] || [ -e "$sdir/libwebkit2gtk-4.0.so.37" ]; then
      WK_SRC="$(ls "$sdir"/libwebkit2gtk-4.0.so* | head -n1)"
      ln -sf "$WK_SRC" "$LIB_DIR/libwebkit2gtk-4.1.so"
      ln -sf "$WK_SRC" "$LIB_DIR/libwebkit2gtk-4.1.so.0"
    fi
    if [ -e "$sdir/libjavascriptcoregtk-4.0.so" ] || [ -e "$sdir/libjavascriptcoregtk-4.0.so.18" ]; then
      JSC_SRC="$(ls "$sdir"/libjavascriptcoregtk-4.0.so* | head -n1)"
      ln -sf "$JSC_SRC" "$LIB_DIR/libjavascriptcoregtk-4.1.so"
      ln -sf "$JSC_SRC" "$LIB_DIR/libjavascriptcoregtk-4.1.so.0"
    fi
    if [ -e "$sdir/libsoup-2.4.so" ] || [ -e "$sdir/libsoup-2.4.so.1" ]; then
      SOUP_SRC="$(ls "$sdir"/libsoup-2.4.so* | head -n1)"
      ln -sf "$SOUP_SRC" "$LIB_DIR/libsoup-3.0.so"
      ln -sf "$SOUP_SRC" "$LIB_DIR/libsoup-3.0.so.0"
    fi
  done

  export PKG_CONFIG_PATH="${PC_DIR}:${PKG_CONFIG_PATH:-}"
  export LIBRARY_PATH="${LIB_DIR}:${LIBRARY_PATH:-}"
  echo -e "${GREEN}✓ 已启用银河麒麟 WebKitGTK 4.0 -> 4.1 兼容桥接目录: ${COMPAT_DIR}${NC}"
}

setup_webkit_compat_bridge

# ------------------------------------------------------------------------------
# 2. 安装前端依赖并执行自动化回归测试与 Vite 生产构建
# ------------------------------------------------------------------------------
echo -e "${CYAN}[1/3] 构建前端工程并运行架构回归验证...${NC}"
if command -v pnpm >/dev/null 2>&1; then
  if [ ! -d "node_modules" ]; then
    pnpm install
  fi
  node scripts/run-tests.mjs
  pnpm build
else
  if [ ! -d "node_modules" ]; then
    npm install
  fi
  node scripts/run-tests.mjs
  npm run build
fi

# ------------------------------------------------------------------------------
# 3. 针对海光 3350 (Hygon C86 3350) 编译 Rust Release 核心二进制
# ------------------------------------------------------------------------------
echo -e "${CYAN}[2/3] 编译 Rust/Tauri 后端 (海光 3350 AVX2/FMA/BMI2 硬件加速)...${NC}"
if [ "$ARCH" = "x86_64" ]; then
  export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+sse4.2,+avx,+avx2,+fma,+bmi1,+bmi2,+lzcnt,+popcnt,+aes -C link-arg=-Wl,-rpath,\$ORIGIN/lib:/opt/quilla/lib"
fi

cargo build --manifest-path src-tauri/Cargo.toml --release -j "$CORES"

echo -e "${GREEN}✓ Rust Release 二进制编译完成: src-tauri/target/release/quilla${NC}"

# ------------------------------------------------------------------------------
# 4. 生成银河麒麟专用 .deb 安装包与便携版 .tar.gz
# ------------------------------------------------------------------------------
echo -e "${CYAN}[3/3] 打包银河麒麟 V10 (.deb) 与免安装便携版 (.tar.gz)...${NC}"
bash scripts/package-kylin-deb.sh
