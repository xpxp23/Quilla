#!/usr/bin/env bash
# ==============================================================================
# Quilla (羽墨) v0.13.0 — 银河麒麟桌面系统 V10 (海光 3350 amd64) DEB & 便携包构建器
# 解决的核心痛点：
# 1. 采用 `libwebkit2gtk-4.1-0 | libwebkit2gtk-4.0-37` 双版本或依赖声明，
#    彻底解决银河麒麟 V10 SP1 双击安装 .deb 时报错“缺少 libwebkit2gtk-4.1-0”；
# 2. 内置 `postinst` 与 `/usr/bin/quilla` 启动器，当检测到银河麒麟系统仅有 4.0 库时，
#    自动在 `/opt/quilla/lib` 建立私有运行期 `.so` 映射并注入 `WEBKIT_DISABLE_DMABUF_RENDERER=1`；
# 3. 自动兼容银河麒麟安全中心 (kysec) 执行白名单放行与牡丹文件管理器 (Peony) 右键关联。
# ==============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="0.13.0"
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

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

STAGE_DEB="$OUT_DIR/deb_stage"
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

# 1. 拷贝主程序与主题资源
cp -f "$BIN_PATH" "$STAGE_DEB/opt/quilla/quilla-bin"
chmod 0755 "$STAGE_DEB/opt/quilla/quilla-bin"
cp -rf "$ROOT_DIR/src/themes/." "$STAGE_DEB/opt/quilla/themes/"

# 2. 拷贝应用图标
cp -f "$ROOT_DIR/src-tauri/icons/32x32.png" "$STAGE_DEB/usr/share/icons/hicolor/32x32/apps/quilla.png"
cp -f "$ROOT_DIR/src-tauri/icons/128x128.png" "$STAGE_DEB/usr/share/icons/hicolor/128x128/apps/quilla.png"
cp -f "$ROOT_DIR/src-tauri/icons/128x128@2x.png" "$STAGE_DEB/usr/share/icons/hicolor/256x256/apps/quilla.png"

# 3. 生成银河麒麟 + 海光 3350 智能启动包装器 /usr/bin/quilla
cat > "$STAGE_DEB/usr/bin/quilla" <<'EOF'
#!/usr/bin/env bash
# Quilla (羽墨) v0.13.0 — 银河麒麟 (Kylin OS V10) & 海光 3350 启动包装器
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

# 避免麒麟 UKUI 下 xdg-desktop-portal 阻塞文件选择对话框
if [ "${QUILLA_USE_PORTAL:-0}" != "1" ] && [ -z "${GTK_USE_PORTAL:-}" ]; then
  export GTK_USE_PORTAL=0
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
Comment[zh_CN]=现代化所见即所得 Markdown 编辑器与本地双链知识库 (银河麒麟/海光3350专版)
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

# 6. 生成 DEBIAN/control (支持 libwebkit2gtk-4.1-0 | libwebkit2gtk-4.0-37 双版本或依赖)
INSTALLED_SIZE="$(du -sk "$STAGE_DEB/opt" "$STAGE_DEB/usr" | awk '{s+=$1} END {print s}')"
cat > "$STAGE_DEB/DEBIAN/control" <<EOF
Package: ${PKG_NAME}
Version: ${VERSION}
Section: editors
Priority: optional
Architecture: ${ARCH_DEB}
Installed-Size: ${INSTALLED_SIZE}
Maintainer: Quilla Team <support@quilla.app>
Depends: libc6 (>= 2.28), libgtk-3-0, libwebkit2gtk-4.1-0 | libwebkit2gtk-4.0-37, xdg-utils
Recommends: git, curl, chromium | chromium-browser | qaxbrowser-safe-stable | google-chrome-stable
Description: Quilla (羽墨) - 现代化所见即所得 Markdown 编辑器与双链知识库 (银河麒麟 & 海光 3350 专版)
 基于 Rust + Tauri v2 + CodeMirror 6 Lezer AST 构建的高性能 Markdown 编辑器。
 针对银河麒麟桌面操作系统 V10 (UKUI / Peony) 与海光 C86 3350 (x86_64) 深度优化。
EOF

# 7. 生成 DEBIAN/postinst：自动桥接 WebKitGTK 4.0 -> 4.1 共享库、配置 kysec 白名单并刷新桌面数据库
cat > "$STAGE_DEB/DEBIAN/postinst" <<'EOF'
#!/usr/bin/env bash
set -e

LIB_DST="/opt/quilla/lib"
mkdir -p "$LIB_DST"

# 若银河麒麟系统未安装 libwebkit2gtk-4.1.so.0 但装有 libwebkit2gtk-4.0.so.37，自动建立私有运行期符号链接
for sdir in /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu /usr/lib64 /usr/lib; do
  if [ ! -e "$sdir/libwebkit2gtk-4.1.so.0" ] && [ -e "$sdir/libwebkit2gtk-4.0.so.37" ]; then
    ln -sf "$sdir/libwebkit2gtk-4.0.so.37" "$LIB_DST/libwebkit2gtk-4.1.so.0"
  fi
  if [ ! -e "$sdir/libjavascriptcoregtk-4.1.so.0" ] && [ -e "$sdir/libjavascriptcoregtk-4.0.so.18" ]; then
    ln -sf "$sdir/libjavascriptcoregtk-4.0.so.18" "$LIB_DST/libjavascriptcoregtk-4.1.so.0"
  fi
  if [ ! -e "$sdir/libsoup-3.0.so.0" ] && [ -e "$sdir/libsoup-2.4.so.1" ]; then
    ln -sf "$sdir/libsoup-2.4.so.1" "$LIB_DST/libsoup-3.0.so.0"
  fi
done

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

# 8. 生成 DEBIAN/prerm：卸载时清理动态生成的软链接
cat > "$STAGE_DEB/DEBIAN/prerm" <<'EOF'
#!/usr/bin/env bash
set -e
rm -rf /opt/quilla/lib/*.so* 2>/dev/null || true
exit 0
EOF
chmod 0755 "$STAGE_DEB/DEBIAN/prerm"

DEB_FILE="$OUT_DIR/quilla_${VERSION}_${ARCH_DEB}_kylin_hygon3350.deb"
dpkg-deb --build --root-owner-group "$STAGE_DEB" "$DEB_FILE"

# 9. 同时构建免 root 绿色便携版 (.tar.gz)
PORTABLE_DIR="$OUT_DIR/Quilla-v${VERSION}-Kylin-Hygon3350-x86_64"
mkdir -p "$PORTABLE_DIR/lib" "$PORTABLE_DIR/themes" "$PORTABLE_DIR/icons"
cp -f "$BIN_PATH" "$PORTABLE_DIR/quilla-bin"
chmod 0755 "$PORTABLE_DIR/quilla-bin"
cp -rf "$ROOT_DIR/src/themes/." "$PORTABLE_DIR/themes/"
cp -f "$ROOT_DIR/src-tauri/icons/128x128.png" "$PORTABLE_DIR/icons/quilla.png"

cat > "$PORTABLE_DIR/quilla" <<'EOF'
#!/usr/bin/env bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LD_LIBRARY_PATH="${HERE}/lib:${LD_LIBRARY_PATH:-}"

for sdir in /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu /usr/lib64 /usr/lib; do
  if [ ! -e "$sdir/libwebkit2gtk-4.1.so.0" ] && [ -e "$sdir/libwebkit2gtk-4.0.so.37" ] && [ ! -e "$HERE/lib/libwebkit2gtk-4.1.so.0" ]; then
    ln -sf "$sdir/libwebkit2gtk-4.0.so.37" "$HERE/lib/libwebkit2gtk-4.1.so.0"
  fi
  if [ ! -e "$sdir/libjavascriptcoregtk-4.1.so.0" ] && [ -e "$sdir/libjavascriptcoregtk-4.0.so.18" ] && [ ! -e "$HERE/lib/libjavascriptcoregtk-4.1.so.0" ]; then
    ln -sf "$sdir/libjavascriptcoregtk-4.0.so.18" "$HERE/lib/libjavascriptcoregtk-4.1.so.0"
  fi
  if [ ! -e "$sdir/libsoup-3.0.so.0" ] && [ -e "$sdir/libsoup-2.4.so.1" ] && [ ! -e "$HERE/lib/libsoup-3.0.so.0" ]; then
    ln -sf "$sdir/libsoup-2.4.so.1" "$HERE/lib/libsoup-3.0.so.0"
  fi
done

if [ "${QUILLA_ALLOW_DMABUF:-0}" != "1" ] && [ -z "${WEBKIT_DISABLE_DMABUF_RENDERER:-}" ]; then
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
fi
if [ -e "/proc/driver/jmgpu" ] || [ -e "/dev/jmgpu" ] || [ "${QUILLA_SAFE_RENDER:-0}" = "1" ]; then
  export WEBKIT_DISABLE_COMPOSITING_MODE=1
fi
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ] && [ -z "${GDK_BACKEND:-}" ]; then
  export GDK_BACKEND="x11,wayland"
fi
if [ "${QUILLA_USE_PORTAL:-0}" != "1" ] && [ -z "${GTK_USE_PORTAL:-}" ]; then
  export GTK_USE_PORTAL=0
fi

exec "${HERE}/quilla-bin" "$@"
EOF
chmod 0755 "$PORTABLE_DIR/quilla"

PORTABLE_TAR="$OUT_DIR/quilla-v${VERSION}-kylin-hygon3350-portable-x86_64.tar.gz"
tar -czf "$PORTABLE_TAR" -C "$OUT_DIR" "Quilla-v${VERSION}-Kylin-Hygon3350-x86_64"

rm -rf "$STAGE_DEB" "$PORTABLE_DIR"

echo -e "${GREEN}======================================================================${NC}"
echo -e "${GREEN}✓ 银河麒麟 V10 (海光 3350) 安装包构建完成：${NC}"
echo -e "  1. DEB 安装包:   ${CYAN}${DEB_FILE}${NC}"
echo -e "  2. 绿色便携版:   ${CYAN}${PORTABLE_TAR}${NC}"
echo -e "${GREEN}======================================================================${NC}"
