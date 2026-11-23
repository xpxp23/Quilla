#!/usr/bin/env bash
# ==============================================================================
# Quilla (羽墨) v0.15.0 — 银河麒麟高级服务器操作系统 V11 2503 原生构建与打包脚本
# 目标基线：内核 6.6.0 · glibc 2.38 · GCC 12.3.1 · x86_64 / AArch64 / LoongArch64 · KVM/QEMU
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VERSION="0.15.0"
ARCH="$(uname -m)"

echo "=== Quilla (羽墨) v${VERSION} · 银河麒麟 V11 2503 (${ARCH}) 原生构建管线 ==="

# 1. 检测 pkg-config 与 WebKitGTK / GTK3 依赖
if ! command -v pkg-config >/dev/null 2>&1; then
  echo "[ERROR] 未找到 pkg-config，请先执行: sudo dnf install -y pkgconf-pkg-config gcc gcc-c++ gtk3-devel" >&2
  exit 1
fi

if ! pkg-config --exists webkit2gtk-4.0; then
  echo "[WARN] 当前系统未检测到 webkit2gtk-4.0 开发包 (Tauri v1.8 需要 webkit2gtk3-devel / libsoup-devel)。"
  echo "       若软件源仅提供 webkit2gtk4.1 + libsoup3，请安装兼容包或切换至 Tauri v2 分支构建。"
  echo "       建议尝试: sudo dnf install -y gtk3-devel webkit2gtk3-devel libsoup-devel libappindicator-gtk3-devel librsvg2-devel zenity"
  exit 1
fi

# 2. 构建前端静态资源
cd "${PROJECT_ROOT}"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile || pnpm install
  pnpm build
else
  npm install
  npm run build
fi

# 3. 编译 Rust 后端（不强制 AVX2/FMA，确保 KVM/QEMU 默认虚拟 CPU 100% 兼容）
cd "${PROJECT_ROOT}/src-tauri"
cargo build --release --features custom-protocol

BIN_PATH="${PROJECT_ROOT}/src-tauri/target/release/quilla"
if [[ ! -f "${BIN_PATH}" ]]; then
  echo "[ERROR] 未找到编译产物: ${BIN_PATH}" >&2
  exit 1
fi

# 4. 生成便携 tar.gz 包（含针对 KVM/QEMU 与 V11 2503 优化的安全启动包装器）
OUT_DIR="${PROJECT_ROOT}/dist-kylin-v11"
PKG_NAME="quilla-${VERSION}-kylin-v11-${ARCH}"
STAGE_DIR="${OUT_DIR}/${PKG_NAME}"
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}/bin"

cp "${BIN_PATH}" "${STAGE_DIR}/bin/quilla-bin"
chmod +x "${STAGE_DIR}/bin/quilla-bin"

cat > "${STAGE_DIR}/quilla.sh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
# KVM/QEMU 虚拟化或无硬件渲染节点时自动关闭 WebKitGTK 硬件合成，防止界面冻结/无法输入
if [[ ! -e /dev/dri/renderD128 ]] || grep -qiE "kvm|qemu|vmware|virtualbox" /sys/class/dmi/id/product_name 2>/dev/null; then
  export WEBKIT_DISABLE_COMPOSITING_MODE="${WEBKIT_DISABLE_COMPOSITING_MODE:-1}"
fi
exec "${SELF_DIR}/bin/quilla-bin" "$@"
EOF
chmod +x "${STAGE_DIR}/quilla.sh"

tar -C "${OUT_DIR}" -czf "${OUT_DIR}/${PKG_NAME}.tar.gz" "${PKG_NAME}"
echo "=== 构建完成: ${OUT_DIR}/${PKG_NAME}.tar.gz ==="
