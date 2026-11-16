#!/usr/bin/env bash
# ==============================================================================
# Quilla (羽墨) v0.14.0 — 银河麒麟桌面 V10 SP1 (glibc 2.31 / webkit2gtk-4.0 / 海光 3350) 一键构建脚本
# 核心改进 (v0.14.0)：
# 1. 架构级切换至 Tauri v1.8 (`webkit2gtk-4.0` + `libsoup-2.4`)，彻底消除对 `libwebkit2gtk-4.1.so.0`、
#    `libsoup-3.0.so.0` 与 `webkit_uri_scheme_request_get_http_body` 的符号依赖；
# 2. 若当前编译宿主机 GLIBC 版本高于 2.31（如在 Ubuntu 22.04/24.04 上编译）且装有 Docker，
#    自动启动 `ubuntu:20.04` (glibc 2.31) 容器执行编译与打包，从根源杜绝 `GLIBC_2.32~2.34` 污染；
# 3. 编译完成后强制执行 `scripts/verify-kylin-abi.sh` 校验 GLIBC 与动态库依赖。
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
echo -e "${CYAN}  Quilla (羽墨) v0.14.0 · 银河麒麟 V10 SP1 (glibc 2.31 / 海光 3350) 构建管线${NC}"
echo -e "${CYAN}======================================================================${NC}"

ARCH="$(uname -m)"
CPU_NAME="$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || echo "$ARCH")"
CORES="$(nproc 2>/dev/null || echo 8)"
HOST_GLIBC="$(ldd --version 2>/dev/null | head -n1 | grep -oE '[0-9]+\.[0-9]+$' || echo '2.31')"
echo -e "目标架构: ${GREEN}${ARCH}${NC} | 处理器: ${GREEN}${CPU_NAME}${NC} | 宿主 glibc: ${GREEN}${HOST_GLIBC}${NC}"

# ------------------------------------------------------------------------------
# 1. 构建前端工程并运行全量回归测试
# ------------------------------------------------------------------------------
echo -e "${CYAN}[1/3] 构建前端工程并运行架构回归验证...${NC}"
if command -v pnpm >/dev/null 2>&1; then
  if [ ! -d "node_modules" ]; then
    pnpm install --no-frozen-lockfile
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
# 2. 检查宿主机 glibc 版本：若宿主 glibc > 2.31 且存在 Docker，自动使用 ubuntu:20.04 容器编译
# ------------------------------------------------------------------------------
GLIBC_HIGH="$(echo "$HOST_GLIBC" | awk -F. '($1 > 2) || ($1 == 2 && $2 > 31) {print 1}')"
if [ "${GLIBC_HIGH:-0}" = "1" ] && [ "${QUILLA_SKIP_DOCKER:-0}" != "1" ] && command -v docker >/dev/null 2>&1; then
  echo -e "${YELLOW}⚙ 检测到当前宿主机 glibc (${HOST_GLIBC}) 高于银河麒麟 V10 SP1 (glibc 2.31)，正在启动 ubuntu:20.04 容器编译以确保 100% 兼容...${NC}"
  docker run --rm \
    -v "$ROOT_DIR:/work" \
    -w /work \
    ubuntu:20.04 \
    bash scripts/build-kylin-focal-container.sh
  exit 0
fi

# ------------------------------------------------------------------------------
# 3. 本机直接编译 (适用于银河麒麟 V10 SP1 本机或 Ubuntu 20.04 环境)
# ------------------------------------------------------------------------------
if ! pkg-config --exists webkit2gtk-4.0 2>/dev/null; then
  echo -e "${RED}✗ 未检测到原生 webkit2gtk-4.0 (libwebkit2gtk-4.0-dev) 开发库！${NC}"
  echo -e "${YELLOW}请先运行: bash scripts/install-kylin-deps.sh${NC}"
  exit 1
fi

echo -e "${CYAN}[2/3] 编译 Rust/Tauri v1.8 后端 (原生绑定 webkit2gtk-4.0 + libsoup-2.4 + 海光 3350 AVX2/FMA)...${NC}"
if [ "$ARCH" = "x86_64" ]; then
  export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+sse4.2,+avx,+avx2,+fma,+bmi1,+bmi2,+lzcnt,+popcnt,+aes -C link-arg=-Wl,-rpath,\$ORIGIN/lib:/opt/quilla/lib"
fi

cargo build --manifest-path src-tauri/Cargo.toml --release -j "$CORES"

mkdir -p dist-kylin
bash scripts/verify-kylin-abi.sh "src-tauri/target/release/quilla" "dist-kylin/ABI-VERIFICATION-REPORT.txt"

echo -e "${CYAN}[3/3] 打包银河麒麟 V10 SP1 (.deb) 与免安装便携版 (.tar.gz)...${NC}"
bash scripts/package-kylin-deb.sh
