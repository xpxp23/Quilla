#!/usr/bin/env bash
# ==============================================================================
# Quilla (羽墨) v0.15.0 — Ubuntu 20.04 Focal (glibc 2.31 + webkit2gtk-4.0) 容器内构建脚本
# 说明：
# 银河麒麟桌面操作系统 V10 SP1 的运行期基线为：
# - glibc 2.31 (`0kylin9.1k22.0`)
# - libwebkit2gtk-4.0-37 (`2.38.6`)
# - libsoup-2.4-1 (`2.70.0`)
# 本脚本在官方 `ubuntu:20.04` 容器中执行 Rust 编译、ABI 门禁验证与 DEB/便携包打包，
# 确保产出的二进制在不修改银河麒麟系统任何系统库的情况下 100% 原生启动运行。
# ==============================================================================
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=== [Ubuntu 20.04 Focal / glibc 2.31 Container] 1. 安装原生 webkit2gtk-4.0 与 GTK3 开发库 ==="
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates \
  build-essential \
  pkg-config \
  curl \
  wget \
  file \
  git \
  binutils \
  libssl-dev \
  libgtk-3-dev \
  libglib2.0-dev \
  libcairo2-dev \
  libpango1.0-dev \
  libgdk-pixbuf2.0-dev \
  libatk1.0-dev \
  libwebkit2gtk-4.0-dev \
  libjavascriptcoregtk-4.0-dev \
  libsoup2.4-dev \
  libayatana-appindicator3-dev \
  xdg-utils \
  desktop-file-utils \
  shared-mime-info

echo "=== [Ubuntu 20.04 Focal / glibc 2.31 Container] 2. 安装/加载 Rust 工具链 ==="
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
  export PATH="$HOME/.cargo/bin:$PATH"
fi

rustc --version
cargo --version
ldd --version | head -n1 || true

echo "=== [Ubuntu 20.04 Focal / glibc 2.31 Container] 3. 编译 Quilla v0.15.0 (Tauri v1.8 + 海光 3350 AVX2/FMA) ==="
CORES="$(nproc 2>/dev/null || echo 8)"
export RUSTFLAGS="-C target-feature=+sse4.2,+avx,+avx2,+fma,+bmi1,+bmi2,+lzcnt,+popcnt,+aes -C link-arg=-Wl,-rpath,\$ORIGIN/lib:/opt/quilla/lib"

cargo build --manifest-path src-tauri/Cargo.toml --release -j "$CORES"

echo "=== [Ubuntu 20.04 Focal / glibc 2.31 Container] 4. 执行银河麒麟 V10 SP1 ABI 门禁校验 ==="
mkdir -p dist-kylin
bash scripts/verify-kylin-abi.sh "src-tauri/target/release/quilla" "dist-kylin/ABI-VERIFICATION-REPORT.txt"

echo "=== [Ubuntu 20.04 Focal / glibc 2.31 Container] 5. 打包银河麒麟 V10 SP1 DEB 与便携版 ==="
bash scripts/package-kylin-deb.sh
