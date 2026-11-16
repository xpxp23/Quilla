#!/usr/bin/env bash
# ==============================================================================
# Quilla (羽墨) v0.14.0 — 银河麒麟桌面系统 V10 SP1 (海光 3350 amd64) DEB & 便携包构建器
# 核心修正 (v0.14.0)：
# 1. 二进制基于 Tauri v1.8 + Ubuntu 20.04 (glibc 2.31) 原生链接 `libwebkit2gtk-4.0.so.37`
#    与 `libsoup-2.4.so.1`，彻底移除 v0.13.0 中无效的 4.0->4.1 软链伪装；
# 2. `DEBIAN/control` 精确声明银河麒麟 V10 SP1 原生库依赖：
#    `Depends: libc6 (>= 2.31), libgtk-3-0, libwebkit2gtk-4.0-37, libsoup2.4-1, xdg-utils`；
# 3. 打包前强制调用 `scripts/verify-kylin-abi.sh` 进行 ABI 门禁检查，并将校验报告一并写入产物目录。
# ==============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="0.14.0"
PKG_NAME="quilla"
ARCH_DEB="amd64"
BIN_PATH="$ROOT_DIR/src-tauri/target/release/quilla"
OUT_DIR="$ROOT_DIR/dist-kylin"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

if [ ! -f "$BIN_PATH" ]; then
  echo -e "${RED}✗ 未找到编译后的二进制文件: $BIN_PATH${NC}"
  echo -e "${YELLOW}请先运行: bash scripts/build-kylin-linux.sh${NC}"
  exit 1
fi

mkdir -p "$OUT_DIR"

# 打包前强制执行 ABI 门禁验证
bash "$ROOT_DIR/scripts/verify-kylin-abi.sh" "$BIN_PATH" "$OUT_DIR/ABI-VERIFICATION-REPORT.txt"

STAGE_DEB="$OUT_DIR/deb_stage"
rm -rf "$STAGE_DEB"
mkdir -p \
  "$STAGE_DEB/DEBIAN" \
  "$STAGE_DEB/opt/quilla/lib" \
  "$STAGE_DEB/opt/quilla/themes" \
  "$STAGE_DEB/usr/bin" \
  "$STAGE_DEB/usr/share/applications" \
  "$STAGE_DEB/usr/share/mime/packages" \
  "$STAGE_DEB/usr/share/icons/hicolor/32x32/apps" \
  "$STAGE_DEB/usr/share/icons/hicolor/128x128/apps" \
  "$STAGE_DEB/usr/share/icons/hicolor/256x256/apps"

# 1. 拷贝主程序、ABI 校验报告与主题资源
cp -f "$BIN_PATH" "$STAGE_DEB/opt/quilla/quilla-bin"
chmod 0755 "$STAGE_DEB/opt/quilla/quilla-bin"
cp -f "$OUT_DIR/ABI-VERIFICATION-REPORT.txt" "$STAGE_DEB/opt/quilla/ABI-VERIFICATION-REPORT.txt"
cp -rf "$ROOT_DIR/src/themes/." "$STAGE_DEB/opt/quilla/themes/"

# 2. 拷贝应用图标
cp -f "$ROOT_DIR/src-tauri/icons/32x32.png" "$STAGE_DEB/usr/share/icons/hicolor/32x32/apps/quilla.png"
cp -f "$ROOT_DIR/src-tauri/icons/128x128.png" "$STAGE_DEB/usr/share/icons/hicolor/128x128/apps/quilla.png"
cp -f "$ROOT_DIR/src-tauri/icons/128x128@2x.png" "$STAGE_DEB/usr/share/icons/hicolor/256x256/apps/quilla.png"

# 3. 生成银河麒麟 V10 SP1 + 海光 3350 启动包装器 /usr/bin/quilla
cat > "$STAGE_DEB/usr/bin/quilla" <<'EOF'
#!/usr/bin/env bash
# Quilla (羽墨) v0.14.0 — 银河麒麟桌面 V10 SP1 (glibc 2.31 / webkit2gtk-4.0 / 海光 3350) 启动器
APP_DIR="/opt/quilla"
export LD_LIBRARY_PATH="${APP_DIR}/lib:${LD_LIBRARY_PATH:-}"

# 默认关闭 WebKitGTK DMA-BUF 渲染器以规避银河麒麟下景嘉微/Mesa 驱动白屏
if [ "${QUILLA_ALLOW_DMABUF:-0}" != "1" ] && [ -z "${WEBKIT_DISABLE_DMABUF_RENDERER:-}" ]; then
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
fi

# 若检测到景嘉微显卡驱动或开启安全渲染模式，关闭合成加速防止闪烁
if [ -e "/proc/driver/jmgpu" ] || [ -e "/dev/jmgpu" ] || [ "${QUILLA_SAFE_RENDER:-0}" = "1" ]; then
  export WEBKIT_DISABLE_COMPOSITING_MODE=1
fi

# Wayland 会话下兼容 UKUI 无边框窗口置顶与拖拽
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ] && [ -z "${GDK_BACKEND:-}" ]; then
  export GDK_BACKEND="x11,wayland"
fi

exec "${APP_DIR}/quilla-bin" "$@"
EOF
chmod 0755 "$STAGE_DEB/usr/bin/quilla"
ln -sf /usr/bin/quilla "$STAGE_DEB/opt/quilla/quilla"

# 4. 生成 XDG 桌面入口文件 (/usr/share/applications/quilla.desktop)
cat > "$STAGE_DEB/usr/share/applications/quilla.desktop" <<'EOF'
[Desktop Entry]
Name=Quilla (羽墨)
Name[zh_CN]=Quilla (羽墨)
GenericName=Markdown Editor
GenericName[zh_CN]=所见即所得 Markdown 编辑器
Comment=Modern WYSIWYG Markdown Editor & Local Knowledge Base
Comment[zh_CN]=现代化所见即所得 Markdown 编辑器与本地双链知识库 (银河麒麟 V10 SP1 / 海光 3350 原生版)
Exec=/usr/bin/quilla %U
Icon=quilla
Terminal=false
Type=Application
StartupWMClass=quilla
MimeType=text/markdown;text/x-markdown;text/plain;
Categories=Office;TextEditor;Utility;
Keywords=Markdown;Editor;Note;Quilla;羽墨;知识库;
Actions=NewWindow;SafeRender;

[Desktop Action NewWindow]
Name=新建独立窗口
Name[zh_CN]=新建独立窗口
Exec=/usr/bin/quilla --new-window

[Desktop Action SafeRender]
Name=兼容渲染模式启动 (禁用 GPU 合成)
Name[zh_CN]=兼容渲染模式启动 (禁用 GPU 合成)
Exec=/usr/bin/quilla --safe-render %U
EOF

# 5. 生成 MIME 类型定义 (/usr/share/mime/packages/quilla-markdown.xml)
cat > "$STAGE_DEB/usr/share/mime/packages/quilla-markdown.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="text/markdown">
    <comment>Markdown Document</comment>
    <comment xml:lang="zh_CN">Markdown 文档 (Quilla 羽墨)</comment>
    <glob pattern="*.md"/>
    <glob pattern="*.markdown"/>
    <glob pattern="*.mdown"/>
    <glob pattern="*.mkd"/>
  </mime-type>
</mime-info>
EOF

# 6. 生成 DEBIAN/control (精确匹配银河麒麟桌面 V10 SP1 原生软件源包名)
INSTALLED_SIZE="$(du -sk "$STAGE_DEB/opt" "$STAGE_DEB/usr" | awk '{s+=$1} END {print s}')"
cat > "$STAGE_DEB/DEBIAN/control" <<EOF
Package: ${PKG_NAME}
Version: ${VERSION}
Section: editors
Priority: optional
Architecture: ${ARCH_DEB}
Installed-Size: ${INSTALLED_SIZE}
Maintainer: Quilla Team <support@quilla.app>
Depends: libc6 (>= 2.31), libgtk-3-0, libwebkit2gtk-4.0-37, libsoup2.4-1, xdg-utils
Recommends: git, curl, chromium | chromium-browser | qaxbrowser-safe-stable | browser360-cn-stable | google-chrome-stable
Description: Quilla (羽墨) v0.14.0 - 现代化所见即所得 Markdown 编辑器与双链知识库 (银河麒麟 V10 SP1 & 海光 3350 原生版)
 基于 Rust + Tauri v1.8 + CodeMirror 6 Lezer AST 构建的高性能 Markdown 编辑器。
 原生基于 glibc 2.31 + libwebkit2gtk-4.0-37 + libsoup-2.4-1 编译，100% 兼容银河麒麟桌面操作系统 V10 SP1 与海光 C86 3350。
EOF

# 7. 生成 DEBIAN/postinst：配置 kysec 白名单并刷新桌面与 MIME 数据库
cat > "$STAGE_DEB/DEBIAN/postinst" <<'EOF'
#!/usr/bin/env bash
set -e

# 兼容银河麒麟安全中心 (kysec) 执行控制保护白名单
if command -v kysec_set >/dev/null 2>&1; then
  kysec_set -n exectl -v verified /opt/quilla/quilla-bin >/dev/null 2>&1 || true
  kysec_set -n exectl -v verified /usr/bin/quilla >/dev/null 2>&1 || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi

exit 0
EOF
chmod 0755 "$STAGE_DEB/DEBIAN/postinst"

# 8. 生成 DEBIAN/prerm
cat > "$STAGE_DEB/DEBIAN/prerm" <<'EOF'
#!/usr/bin/env bash
set -e
exit 0
EOF
chmod 0755 "$STAGE_DEB/DEBIAN/prerm"

DEB_FILE="$OUT_DIR/quilla_${VERSION}_${ARCH_DEB}_kylin_hygon3350.deb"
dpkg-deb --build --root-owner-group "$STAGE_DEB" "$DEB_FILE"

# 9. 同时构建免 root 绿色便携版 (.tar.gz)
PORTABLE_NAME="Quilla-v${VERSION}-Kylin-Hygon3350-x86_64"
PORTABLE_DIR="$OUT_DIR/${PORTABLE_NAME}"
rm -rf "$PORTABLE_DIR"
mkdir -p "$PORTABLE_DIR/lib" "$PORTABLE_DIR/themes" "$PORTABLE_DIR/icons"
cp -f "$BIN_PATH" "$PORTABLE_DIR/quilla-bin"
chmod 0755 "$PORTABLE_DIR/quilla-bin"
cp -f "$OUT_DIR/ABI-VERIFICATION-REPORT.txt" "$PORTABLE_DIR/ABI-VERIFICATION-REPORT.txt"
cp -rf "$ROOT_DIR/src/themes/." "$PORTABLE_DIR/themes/"
cp -f "$ROOT_DIR/src-tauri/icons/128x128.png" "$PORTABLE_DIR/icons/quilla.png"

cat > "$PORTABLE_DIR/quilla" <<'EOF'
#!/usr/bin/env bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LD_LIBRARY_PATH="${HERE}/lib:${LD_LIBRARY_PATH:-}"

if [ "${QUILLA_ALLOW_DMABUF:-0}" != "1" ] && [ -z "${WEBKIT_DISABLE_DMABUF_RENDERER:-}" ]; then
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
fi
if [ -e "/proc/driver/jmgpu" ] || [ -e "/dev/jmgpu" ] || [ "${QUILLA_SAFE_RENDER:-0}" = "1" ]; then
  export WEBKIT_DISABLE_COMPOSITING_MODE=1
fi
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ] && [ -z "${GDK_BACKEND:-}" ]; then
  export GDK_BACKEND="x11,wayland"
fi

exec "${HERE}/quilla-bin" "$@"
EOF
chmod 0755 "$PORTABLE_DIR/quilla"

PORTABLE_TAR="$OUT_DIR/quilla-v${VERSION}-kylin-hygon3350-portable-x86_64.tar.gz"
tar -czf "$PORTABLE_TAR" -C "$OUT_DIR" "$PORTABLE_NAME"

rm -rf "$STAGE_DEB" "$PORTABLE_DIR"

echo -e "${GREEN}======================================================================${NC}"
echo -e "${GREEN}✓ 银河麒麟 V10 SP1 (glibc 2.31 / webkit2gtk-4.0 / 海光 3350) 安装包构建完成：${NC}"
echo -e "  1. DEB 安装包:   ${CYAN}${DEB_FILE}${NC}"
echo -e "  2. 绿色便携版:   ${CYAN}${PORTABLE_TAR}${NC}"
echo -e "  3. ABI 校验报告: ${CYAN}${OUT_DIR}/ABI-VERIFICATION-REPORT.txt${NC}"
echo -e "${GREEN}======================================================================${NC}"
