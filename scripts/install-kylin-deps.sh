#!/usr/bin/env bash
# ==============================================================================
# Quilla (羽墨) v0.13.0 — 银河麒麟系统 (Kylin OS V10) & 海光 3350 依赖一键安装脚本
# 适用平台：银河麒麟桌面操作系统 V10 (SP1/SP2/SP3) / 高级服务器操作系统 V10 (x86_64 / 海光 3350)
# ==============================================================================
set -euo pipefail

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${CYAN}=== Quilla (羽墨) v0.13.0 · 银河麒麟系统 (海光 3350) 编译与运行环境配置 ===${NC}"

if [ -f /etc/os-release ]; then
  . /etc/os-release
  echo -e "检测到操作系统: ${GREEN}${PRETTY_NAME:-Linux}${NC}"
fi

CPU_MODEL=$(grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || uname -m)
echo -e "检测到处理器:   ${GREEN}${CPU_MODEL}${NC}"

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

if command -v apt-get >/dev/null 2>&1; then
  echo -e "${CYAN}[1/3] 检测到 APT 包管理器 (银河麒麟桌面版 V10 / Debian / Ubuntu)...${NC}"
  $SUDO apt-get update -y || true

  BASE_PKGS=(
    build-essential
    pkg-config
    curl
    wget
    file
    git
    libssl-dev
    libgtk-3-dev
    libglib2.0-dev
    libcairo2-dev
    libpango1.0-dev
    libgdk-pixbuf2.0-dev
    libatk1.0-dev
    xdg-utils
    desktop-file-utils
    shared-mime-info
  )

  # 自动探测 WebKitGTK 4.1 或银河麒麟 V10 SP1 默认的 WebKitGTK 4.0
  if apt-cache show libwebkit2gtk-4.1-dev >/dev/null 2>&1; then
    echo -e "${GREEN}✓ 软件源支持 libwebkit2gtk-4.1-dev，将安装原生 4.1 开发库${NC}"
    WEBKIT_PKGS=(libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev)
  else
    echo -e "${YELLOW}ℹ 当前银河麒麟软件源仅提供 libwebkit2gtk-4.0-dev，将安装 4.0 开发库并由构建脚本自动生成 4.1 兼容桥接层${NC}"
    WEBKIT_PKGS=(libwebkit2gtk-4.0-dev libsoup2.4-dev libjavascriptcoregtk-4.0-dev)
  fi

  # 自动探测系统托盘/指示器开发库
  if apt-cache show libayatana-appindicator3-dev >/dev/null 2>&1; then
    INDICATOR_PKGS=(libayatana-appindicator3-dev)
  elif apt-cache show libappindicator3-dev >/dev/null 2>&1; then
    INDICATOR_PKGS=(libappindicator3-dev)
  else
    INDICATOR_PKGS=()
  fi

  $SUDO apt-get install -y "${BASE_PKGS[@]}" "${WEBKIT_PKGS[@]}" "${INDICATOR_PKGS[@]}"

elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  PKG_MGR=$(command -v dnf || command -v yum)
  echo -e "${CYAN}[1/3] 检测到 RPM 包管理器 (${PKG_MGR} · 银河麒麟服务器版 V10)...${NC}"
  $SUDO "$PKG_MGR" groupinstall -y "Development Tools" || true
  $SUDO "$PKG_MGR" install -y \
    pkgconfig \
    openssl-devel \
    gtk3-devel \
    webkit2gtk4.1-devel \
    libsoup3-devel \
    libappindicator-gtk3-devel \
    curl \
    git \
    xdg-utils || \
  $SUDO "$PKG_MGR" install -y \
    pkgconfig \
    openssl-devel \
    gtk3-devel \
    webkit2gtk3-devel \
    libsoup-devel \
    curl \
    git \
    xdg-utils
fi

echo -e "${CYAN}[2/3] 检查 Rust 工具链 (rustc / cargo)...${NC}"
if ! command -v cargo >/dev/null 2>&1; then
  echo -e "${YELLOW}未检测到 cargo，正在通过字节跳动 Rsproxy 镜像安装 Rust 工具链...${NC}"
  export RUSTUP_DIST_SERVER="https://rsproxy.cn"
  export RUSTUP_UPDATE_ROOT="https://rsproxy.cn/rustup"
  curl --proto '=https' --tlsv1.2 -sSf https://rsproxy.cn/rustup-init.sh | sh -s -- -y
  source "$HOME/.cargo/env"
else
  echo -e "${GREEN}✓ 已安装 Rust: $(rustc --version)${NC}"
fi

echo -e "${CYAN}[3/3] 检查 Node.js 与 pnpm...${NC}"
if ! command -v node >/dev/null 2>&1; then
  echo -e "${YELLOW}提示: 未检测到 Node.js，请通过 apt install nodejs npm 或 nvm 安装 Node.js >= 18${NC}"
else
  echo -e "${GREEN}✓ 已安装 Node.js: $(node --version)${NC}"
  if ! command -v pnpm >/dev/null 2>&1; then
    npm install -g pnpm --registry=https://registry.npmmirror.com || true
  fi
fi

echo -e "${GREEN}=== 银河麒麟 (海光 3350) 依赖准备完成！接下来可执行: bash scripts/build-kylin-linux.sh ===${NC}"
