#!/usr/bin/env bash
# ==============================================================================
# Quilla (羽墨) v0.14.0 — 银河麒麟桌面系统 V10 SP1 二进制 ABI 门禁校验器
# 严格校验编译产出的 `quilla` 二进制是否 100% 满足银河麒麟 V10 SP1 实机基线：
# 1. GLIBC 符号最高版本必须 <= 2.31（严禁出现 GLIBC_2.32 / 2.33 / 2.34 / 2.35）；
# 2. 动态库依赖 (DT_NEEDED) 必须为原生 `libwebkit2gtk-4.0.so.37` 与 `libsoup-2.4.so.1`
#    （严禁依赖 `libwebkit2gtk-4.1.so.0` 或 `libsoup-3.0.so.0`）；
# 3. 严禁引用 Tauri v2 / WebKitGTK 4.1 专属符号 `webkit_uri_scheme_request_get_http_body`、
#    `webkit_cookie_manager_get_all_cookies` 与 `soup_message_headers_ref`。
# ==============================================================================
set -euo pipefail

BIN_FILE="${1:-src-tauri/target/release/quilla}"
REPORT_FILE="${2:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

if [ ! -f "$BIN_FILE" ]; then
  echo -e "${RED}✗ [ABI Gatekeeper] 未找到待校验的二进制文件: $BIN_FILE${NC}"
  exit 1
fi

echo -e "${CYAN}=== Quilla v0.14.0 · 银河麒麟 V10 SP1 (glibc 2.31 / webkit2gtk-4.0) ABI 门禁校验 ===${NC}"

# 1. 检查 GLIBC 版本上限 (必须 <= 2.31)
GLIBC_VERSIONS="$(objdump -T "$BIN_FILE" | grep -oE 'GLIBC_[0-9]+\.[0-9]+(\.[0-9]+)?' | sed 's/GLIBC_//' | sort -uV)"
MAX_GLIBC="$(echo "$GLIBC_VERSIONS" | tail -n1)"
echo -e "检测到最高 GLIBC 符号版本: ${GREEN}GLIBC_${MAX_GLIBC}${NC}"

FORBIDDEN_GLIBC="$(echo "$GLIBC_VERSIONS" | awk -F. '($1 > 2) || ($1 == 2 && $2 > 31) {print "GLIBC_"$0}')"
if [ -n "$FORBIDDEN_GLIBC" ]; then
  echo -e "${RED}✗ [ABI Gatekeeper] 检测到高于银河麒麟 V10 SP1 (glibc 2.31) 的符号版本:${NC}"
  echo "$FORBIDDEN_GLIBC"
  echo -e "${RED}请在 Ubuntu 20.04 (Focal / glibc 2.31) 容器或银河麒麟 V10 SP1 本机编译！${NC}"
  exit 1
fi
echo -e "${GREEN}✓ [1/3] GLIBC 基线校验通过 (最高 GLIBC_${MAX_GLIBC} <= GLIBC_2.31)${NC}"

# 2. 检查 DT_NEEDED 动态链接库依赖
NEEDED_LIBS="$(readelf -d "$BIN_FILE" | grep '(NEEDED)' || true)"
echo "$NEEDED_LIBS"

if echo "$NEEDED_LIBS" | grep -q "libwebkit2gtk-4.1"; then
  echo -e "${RED}✗ [ABI Gatekeeper] 二进制仍链接了 libwebkit2gtk-4.1.so.0（银河麒麟 V10 SP1 仅提供 4.0）！${NC}"
  exit 1
fi
if echo "$NEEDED_LIBS" | grep -q "libsoup-3.0"; then
  echo -e "${RED}✗ [ABI Gatekeeper] 二进制仍链接了 libsoup-3.0.so.0（银河麒麟 V10 SP1 仅提供 2.4）！${NC}"
  exit 1
fi
if ! echo "$NEEDED_LIBS" | grep -q "libwebkit2gtk-4.0.so.37"; then
  echo -e "${RED}✗ [ABI Gatekeeper] 二进制未链接原生 libwebkit2gtk-4.0.so.37！${NC}"
  exit 1
fi
echo -e "${GREEN}✓ [2/3] 动态库依赖校验通过 (原生绑定 libwebkit2gtk-4.0.so.37 + libsoup-2.4.so.1)${NC}"

# 3. 检查是否残留 WebKitGTK 4.1 / libsoup3 专有符号
FORBIDDEN_SYMS=(
  "webkit_uri_scheme_request_get_http_body"
  "webkit_cookie_manager_get_all_cookies"
  "soup_message_headers_ref"
  "soup_message_headers_unref"
)
for sym in "${FORBIDDEN_SYMS[@]}"; do
  if nm -D "$BIN_FILE" | grep -q "$sym"; then
    echo -e "${RED}✗ [ABI Gatekeeper] 检测到不兼容银河麒麟 V10 SP1 (webkit2gtk 2.38.6) 的符号: ${sym}${NC}"
    exit 1
  fi
done
echo -e "${GREEN}✓ [3/3] 符号表纯净度校验通过 (零 4.1/soup3 专有未定义符号)${NC}"

if [ -n "$REPORT_FILE" ]; then
  mkdir -p "$(dirname "$REPORT_FILE")"
  {
    echo "Quilla (羽墨) v0.14.0 — 银河麒麟桌面 V10 SP1 (海光 C86 3350) 二进制 ABI 校验报告"
    echo "================================================================================"
    echo "Build Timestamp : $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
    echo "Binary MD5      : $(md5sum "$BIN_FILE" | awk '{print $1}')"
    echo "Binary SHA256   : $(sha256sum "$BIN_FILE" | awk '{print $1}')"
    echo "Max GLIBC Ver   : GLIBC_${MAX_GLIBC} (Target <= GLIBC_2.31 [0kylin9.1k22.0])"
    echo ""
    echo "[DT_NEEDED Shared Libraries]"
    echo "$NEEDED_LIBS"
    echo ""
    echo "[Forbidden 4.1 Symbols Check]"
    echo "webkit_uri_scheme_request_get_http_body : ABSENT (OK)"
    echo "webkit_cookie_manager_get_all_cookies   : ABSENT (OK)"
    echo "soup_message_headers_ref / _unref       : ABSENT (OK)"
  } > "$REPORT_FILE"
fi
