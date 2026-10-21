import { EditorView } from "@codemirror/view";
import { handleOpenLink } from "../index";
import { smartToggleFormat, toggleHeadingLevel } from "./formatting-keymap";
import {
  buildSmartMarkdownLink,
  isLikelyUrl,
  normalizeUrlForLink,
} from "./inline-boundary-guard";
import { activeDocumentPath } from "./live-preview";
import { uploadImageAssetToBed } from "./image-handler";
import { showToast } from "../../components/save-dialog";
import { openPreferencesModal } from "../../components/preferences";

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeLinkUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^(javascript:|vbscript:|data:text\/html)/i.test(trimmed)) {
    return "#";
  }
  return trimmed;
}

function resolveLocalImagePath(src: string, docPath: string | null): string | undefined {
  if (!src || /^https?:\/\/|^data:/i.test(src)) return undefined;
  const cleaned = src.replace(/^file:\/\/\/?/i, "");
  if (/^[a-zA-Z]:[\\/]/.test(cleaned) || cleaned.startsWith("/")) {
    return cleaned;
  }
  if (!docPath) return cleaned;
  const parentDir = docPath.replace(/[\\/][^\\/]+$/, "");
  return `${parentDir}/${cleaned.replace(/^\.\//, "")}`;
}

export function initFloatingToolbars(
  view: EditorView,
  onOpenFile?: (filePath: string) => void
) {
  // 防止同一 EditorView 重复绑定
  if ((view as any)._quillaFloatingToolbarsBound) return;
  (view as any)._quillaFloatingToolbarsBound = true;

  // 1. 创建图片微型悬浮工具栏 (Floating Image Toolbar) — 新增一键上传图床按钮
  const imgToolbar = document.createElement("div");
  imgToolbar.className = "ty-image-toolbar hidden";
  imgToolbar.innerHTML = `
    <button type="button" class="ty-toolbar-btn" data-size="25%">25%</button>
    <button type="button" class="ty-toolbar-btn" data-size="50%">50%</button>
    <button type="button" class="ty-toolbar-btn" data-size="80%">80%</button>
    <button type="button" class="ty-toolbar-btn" data-size="100%">100%</button>
    <div class="ty-toolbar-divider"></div>
    <button type="button" class="ty-toolbar-btn" data-align="left" title="居左排版">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="17" y1="10" x2="3" y2="10"></line><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="14" x2="3" y2="14"></line><line x1="17" y1="18" x2="3" y2="18"></line></svg>
      <span>左</span>
    </button>
    <button type="button" class="ty-toolbar-btn" data-align="center" title="居中排版">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="10" x2="6" y2="10"></line><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="14" x2="3" y2="14"></line><line x1="18" y1="18" x2="6" y2="18"></line></svg>
      <span>中</span>
    </button>
    <button type="button" class="ty-toolbar-btn" data-align="right" title="居右排版">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="7" y2="10"></line><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="14" x2="3" y2="14"></line><line x1="21" y1="18" x2="7" y2="18"></line></svg>
      <span>右</span>
    </button>
    <div class="ty-toolbar-divider"></div>
    <button type="button" class="ty-toolbar-btn" data-action="upload-bed" title="一键上传本地图片至图床 (PicGo / GitHub / 自定义) 并替换为远程 URL">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
      <span>上传图床</span>
    </button>
    <button type="button" class="ty-toolbar-btn" data-action="source" title="查看并编辑 Markdown 源码">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
      <span>源码</span>
    </button>
    <button type="button" class="ty-toolbar-btn danger" data-action="delete" title="删除图片">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
    </button>
  `;
  document.body.appendChild(imgToolbar);

  // 2. 创建超链接悬浮工具栏与带明确“名称 / 链接”双字段标识的内联编辑器 (Bug #7)
  const linkTooltip = document.createElement("div");
  linkTooltip.className = "ty-link-tooltip hidden";
  linkTooltip.innerHTML = `
    <div class="link-tooltip-view-row" id="ty-link-view-row">
      <span class="link-url-text" id="ty-link-preview-url">https://...</span>
      <div class="ty-toolbar-divider"></div>
      <button type="button" class="ty-toolbar-btn" data-action="open-link" title="在默认浏览器中打开">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
        <span>打开</span>
      </button>
      <button type="button" class="ty-toolbar-btn" data-action="edit-link" title="编辑链接名称与地址">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
        <span>编辑</span>
      </button>
      <button type="button" class="ty-toolbar-btn" data-action="copy-link" title="复制链接地址">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        <span>复制</span>
      </button>
      <button type="button" class="ty-toolbar-btn danger" data-action="unlink" title="移除超链接保留文字">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
    <div class="link-tooltip-edit-form hidden" id="ty-link-edit-form">
      <label class="link-edit-field" for="ty-link-edit-text">
        <span class="link-edit-label" title="超链接显示名称">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>
          <span>名称</span>
        </span>
        <input type="text" id="ty-link-edit-text" class="ty-inline-input" placeholder="输入显示名称 (如：Quilla 官网)..." />
      </label>
      <label class="link-edit-field" for="ty-link-edit-url">
        <span class="link-edit-label" title="超链接目标 URL 地址">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
          <span>链接</span>
        </span>
        <input type="text" id="ty-link-edit-url" class="ty-inline-input" placeholder="https://example.com" />
      </label>
      <div class="link-edit-actions">
        <button type="button" class="ty-toolbar-btn primary" data-action="save-link">保存</button>
        <button type="button" class="ty-toolbar-btn" data-action="cancel-link">取消</button>
      </div>
    </div>
  `;
  document.body.appendChild(linkTooltip);

  // 3. 创建选中文本悬浮气泡格式栏 (Selection Bubble Menu) — 统一精致 SVG 矢量图标 + 激活态高亮
  const selToolbar = document.createElement("div");
  selToolbar.className = "ty-selection-toolbar hidden";
  selToolbar.innerHTML = `
    <button type="button" class="ty-toolbar-btn" data-fmt="bold" title="加粗 (Ctrl+B)">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path></svg>
    </button>
    <button type="button" class="ty-toolbar-btn" data-fmt="italic" title="斜体 (Ctrl+I)">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="4" x2="10" y2="4"></line><line x1="14" y1="20" x2="5" y2="20"></line><line x1="15" y1="4" x2="9" y2="20"></line></svg>
    </button>
    <button type="button" class="ty-toolbar-btn" data-fmt="strike" title="删除线 (Ctrl+Shift+X)">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4H9a3 3 0 0 0-2.83 4"></path><path d="M14 12a4 4 0 0 1 0 8H6"></path><line x1="4" y1="12" x2="20" y2="12"></line></svg>
    </button>
    <button type="button" class="ty-toolbar-btn" data-fmt="highlight" title="荧光高亮 (Ctrl+Shift+H)">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"></path><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"></path></svg>
    </button>
    <button type="button" class="ty-toolbar-btn" data-fmt="code" title="行内代码 (Ctrl+E)">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
    </button>
    <button type="button" class="ty-toolbar-btn" data-fmt="math" title="行内公式 (Ctrl+M)">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 4H6l6 8-6 8h12"></path></svg>
    </button>
    <button type="button" class="ty-toolbar-btn" data-fmt="link" title="超链接 (Ctrl+K)">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
    </button>
    <button type="button" class="ty-toolbar-btn" data-fmt="wikilink" title="转为双链笔记 [[...]]">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"></path><path d="M15 7h2a5 5 0 1 1 0 10h-2"></path><line x1="8" y1="12" x2="16" y2="12"></line></svg>
    </button>
    <div class="ty-toolbar-divider"></div>
    <button type="button" class="ty-toolbar-btn" data-heading="1" title="一级标题 (Ctrl+1)">H1</button>
    <button type="button" class="ty-toolbar-btn" data-heading="2" title="二级标题 (Ctrl+2)">H2</button>
    <button type="button" class="ty-toolbar-btn" data-heading="3" title="三级标题 (Ctrl+3)">H3</button>
  `;
  document.body.appendChild(selToolbar);

  let activeImgTarget: {
    elem: HTMLElement;
    from: number;
    to: number;
    src: string;
    alt: string;
    width: string;
    align: string;
  } | null = null;

  let activeLinkTarget: {
    elem: HTMLElement;
    url: string;
    text: string;
    from: number;
    to: number;
  } | null = null;

  function positionToolbar(toolbar: HTMLElement, targetElem: HTMLElement) {
    const rect = targetElem.getBoundingClientRect();
    const tbWidth = toolbar.offsetWidth || 340;
    const tbHeight = toolbar.offsetHeight || 34;

    let top = rect.top - tbHeight - 8;
    if (top < 40) {
      top = rect.bottom + 8;
    }

    let left = rect.left + rect.width / 2 - tbWidth / 2;
    if (left < 10) left = 10;
    if (left + tbWidth > window.innerWidth - 10) {
      left = window.innerWidth - tbWidth - 10;
    }

    toolbar.style.top = `${top}px`;
    toolbar.style.left = `${left}px`;
  }

  function hideAllToolbars() {
    imgToolbar.classList.add("hidden");
    linkTooltip.classList.add("hidden");
    selToolbar.classList.add("hidden");
    activeImgTarget = null;
    activeLinkTarget = null;
  }

  function showLinkTooltipForElement(linkEl: HTMLElement) {
    const url = linkEl.getAttribute("data-href") || "";
    const text = linkEl.getAttribute("data-text") || linkEl.textContent || "";
    const from = parseInt(linkEl.getAttribute("data-from") || "-1", 10);
    const to = parseInt(linkEl.getAttribute("data-to") || "-1", 10);
    activeLinkTarget = { elem: linkEl, url, text, from, to };

    const urlSpan = linkTooltip.querySelector("#ty-link-preview-url");
    if (urlSpan) urlSpan.textContent = url;

    linkTooltip.querySelector("#ty-link-view-row")?.classList.remove("hidden");
    linkTooltip.querySelector("#ty-link-edit-form")?.classList.add("hidden");

    linkTooltip.classList.remove("hidden");
    imgToolbar.classList.add("hidden");
    selToolbar.classList.add("hidden");
    positionToolbar(linkTooltip, linkEl);
  }

  function refreshImgToolbarState() {
    if (!activeImgTarget) return;
    imgToolbar.querySelectorAll("[data-size]").forEach((btn: any) => {
      const isAct =
        btn.dataset.size === activeImgTarget!.width ||
        (btn.dataset.size === "100%" && !activeImgTarget!.width);
      btn.classList.toggle("active", isAct);
    });
    imgToolbar.querySelectorAll("[data-align]").forEach((btn: any) => {
      btn.classList.toggle("active", btn.dataset.align === activeImgTarget!.align);
    });
    const uploadBtn = imgToolbar.querySelector<HTMLElement>('[data-action="upload-bed"]');
    if (uploadBtn) {
      const isRemote = /^https?:\/\//i.test(activeImgTarget.src);
      uploadBtn.classList.toggle("active", isRemote);
      const span = uploadBtn.querySelector("span");
      if (span) span.textContent = isRemote ? "已上云" : "上传图床";
    }
  }

  function syncSelectionToolbarActiveState() {
    const state = view.state;
    const sel = state.selection.main;
    if (sel.empty) return;

    const checkMarkerActive = (marker: string): boolean => {
      const mLen = marker.length;
      const before = sel.from >= mLen ? state.sliceDoc(sel.from - mLen, sel.from) : "";
      const after = sel.to + mLen <= state.doc.length ? state.sliceDoc(sel.to, sel.to + mLen) : "";
      if (before === marker && after === marker) return true;
      const selected = state.sliceDoc(sel.from, sel.to).trim();
      if (
        selected.length > mLen * 2 &&
        selected.startsWith(marker) &&
        selected.endsWith(marker)
      ) {
        return true;
      }
      if (selected.includes("\n")) {
        const startLine = state.doc.lineAt(sel.from).number;
        const endLine = state.doc.lineAt(Math.max(sel.from, sel.to - 1)).number;
        let nonEmptyCount = 0;
        let wrappedCount = 0;
        for (let ln = startLine; ln <= endLine; ln++) {
          const line = state.doc.line(ln);
          const segFrom = Math.max(sel.from, line.from);
          const segTo = Math.min(sel.to, line.to);
          const seg = state
            .sliceDoc(segFrom, segTo)
            .replace(/^(\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)?)/, "")
            .trim();
          if (!seg) continue;
          nonEmptyCount++;
          if (seg.startsWith(marker) && seg.endsWith(marker) && seg.length > mLen * 2) {
            wrappedCount++;
          }
        }
        return nonEmptyCount > 0 && nonEmptyCount === wrappedCount;
      }
      return false;
    };

    const markerMap: Record<string, string> = {
      bold: "**",
      italic: "*",
      strike: "~~",
      highlight: "==",
      code: "`",
      math: "$",
    };

    selToolbar.querySelectorAll<HTMLElement>("[data-fmt]").forEach((btn) => {
      const fmt = btn.dataset.fmt || "";
      const marker = markerMap[fmt];
      if (marker) {
        btn.classList.toggle("active", checkMarkerActive(marker));
      } else {
        btn.classList.remove("active");
      }
    });

    const firstLine = state.doc.lineAt(sel.from);
    const hMatch = firstLine.text.match(/^\s*(?:>\s*)*(#{1,6})\s+/);
    const activeHeadingLevel = hMatch ? String(hMatch[1].length) : "";
    selToolbar.querySelectorAll<HTMLElement>("[data-heading]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.heading === activeHeadingLevel);
    });
  }

  const checkSelectionBubble = () => {
    setTimeout(() => {
      if (
        !imgToolbar.classList.contains("hidden") ||
        !linkTooltip.classList.contains("hidden")
      ) {
        selToolbar.classList.add("hidden");
        return;
      }
      const sel = view.state.selection.main;
      if (sel.empty || sel.to - sel.from < 1 || !view.hasFocus) {
        selToolbar.classList.add("hidden");
        return;
      }
      const startCoords = view.coordsAtPos(sel.from);
      const endCoords = view.coordsAtPos(sel.to);
      if (!startCoords || !endCoords) {
        selToolbar.classList.add("hidden");
        return;
      }
      syncSelectionToolbarActiveState();
      selToolbar.classList.remove("hidden");
      const tbWidth = selToolbar.offsetWidth || 310;
      const tbHeight = selToolbar.offsetHeight || 34;
      let top = Math.min(startCoords.top, endCoords.top) - tbHeight - 8;
      if (top < 38) {
        top = Math.max(startCoords.bottom, endCoords.bottom) + 8;
      }
      const isMultiLineSel = Math.abs(endCoords.top - startCoords.top) > 10;
      const contentRect = view.contentDOM.getBoundingClientRect();
      const midX = isMultiLineSel
        ? contentRect.left + contentRect.width / 2
        : (startCoords.left + endCoords.right) / 2;
      const left = Math.max(12, Math.min(midX - tbWidth / 2, window.innerWidth - tbWidth - 12));
      selToolbar.style.top = `${top}px`;
      selToolbar.style.left = `${left}px`;
    }, 20);
  };

  view.dom.addEventListener("mouseup", checkSelectionBubble);
  view.dom.addEventListener("keyup", (e) => {
    if (e.shiftKey && e.key.startsWith("Arrow")) {
      checkSelectionBubble();
      return;
    }
    if (e.key === "Escape") {
      hideAllToolbars();
      return;
    }
    if (e.key.startsWith("Arrow") && view.state.selection.main.empty) {
      requestAnimationFrame(() => {
        const activeLink = view.dom.querySelector<HTMLElement>(".cm-link.cm-link-active");
        if (activeLink) {
          showLinkTooltipForElement(activeLink);
        } else if (!linkTooltip.contains(document.activeElement)) {
          linkTooltip.classList.add("hidden");
        }
      });
    }
  });

  // 选中文本气泡栏点击（支持连续组合加粗+斜体+删除线而不关闭气泡栏）
  selToolbar.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest(".ty-toolbar-btn") as HTMLElement;
    if (!btn) return;
    const fmt = btn.dataset.fmt;
    const heading = btn.dataset.heading;

    let keepBubbleAlive = true;

    if (fmt === "bold") smartToggleFormat(view, "**");
    else if (fmt === "italic") smartToggleFormat(view, "*");
    else if (fmt === "strike") smartToggleFormat(view, "~~");
    else if (fmt === "highlight") smartToggleFormat(view, "==");
    else if (fmt === "code") smartToggleFormat(view, "`");
    else if (fmt === "math") smartToggleFormat(view, "$");
    else if (fmt === "wikilink") {
      keepBubbleAlive = false;
      const sel = view.state.selection.main;
      const text = view.state.sliceDoc(sel.from, sel.to) || "笔记名称";
      const insertStr = `[[${text}]]`;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: insertStr },
        selection: { anchor: sel.from + 2, head: sel.from + 2 + text.length },
      });
    } else if (fmt === "link") {
      keepBubbleAlive = false;
      const sel = view.state.selection.main;
      const text = view.state.sliceDoc(sel.from, sel.to);
      const smartLink = buildSmartMarkdownLink(text);
      const from = sel.from;
      view.dispatch({
        changes: { from, to: sel.to, insert: smartLink.insertStr },
        selection: {
          anchor: from + 1,
          head: from + 1 + smartLink.labelValue.length,
        },
      });
      view.dom.dispatchEvent(
        new CustomEvent("quilla-edit-active-link", {
          detail: {
            from,
            to: from + smartLink.insertStr.length,
            text: smartLink.labelValue,
            url: smartLink.urlValue,
            focusField: smartLink.isUrlInput ? "text" : "url",
          },
        })
      );
    } else if (heading) {
      toggleHeadingLevel(view, parseInt(heading, 10));
    }

    view.focus();
    if (keepBubbleAlive && !view.state.selection.main.empty) {
      checkSelectionBubble();
    } else {
      selToolbar.classList.add("hidden");
    }
  });

  // 监听正文点击
  view.dom.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    const imgFigure = target.closest(".md-image-card") as HTMLElement;
    if (imgFigure) {
      e.stopPropagation();
      const img = imgFigure.querySelector("img") as HTMLImageElement;
      const src = imgFigure.dataset.src || (img ? img.getAttribute("src") : "") || "";
      const alt = imgFigure.dataset.alt || (img ? img.getAttribute("alt") : "") || "";
      const from = parseInt(imgFigure.dataset.from || "0", 10);
      const to = parseInt(imgFigure.dataset.to || "0", 10);
      const width = imgFigure.dataset.width || "";
      const align = imgFigure.dataset.align || "left";

      activeImgTarget = { elem: imgFigure, from, to, src, alt, width, align };
      refreshImgToolbarState();

      imgToolbar.classList.remove("hidden");
      linkTooltip.classList.add("hidden");
      selToolbar.classList.add("hidden");
      positionToolbar(imgToolbar, imgFigure);
      return;
    }

    const linkEl = target.closest(".cm-link") as HTMLElement;
    if (linkEl && !linkEl.classList.contains("tbl-inline-link")) {
      e.stopPropagation();
      showLinkTooltipForElement(linkEl);
      return;
    }

    if (view.state.selection.main.empty) {
      hideAllToolbars();
    }
  });

  // 图片工具栏按钮事件
  imgToolbar.addEventListener("click", async (e) => {
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest(".ty-toolbar-btn") as HTMLElement;
    if (!btn || !activeImgTarget) return;

    const newSize = btn.dataset.size;
    const newAlign = btn.dataset.align;
    const action = btn.dataset.action;

    const from = parseInt(activeImgTarget.elem.dataset.from || String(activeImgTarget.from), 10);
    const to = parseInt(activeImgTarget.elem.dataset.to || String(activeImgTarget.to), 10);
    let { src, alt, width, align } = activeImgTarget;

    if (newSize) {
      width = newSize === "100%" || width === newSize ? "" : newSize;
    } else if (newAlign) {
      align = align === newAlign ? "left" : newAlign;
    } else if (action === "upload-bed") {
      if (/^https?:\/\//i.test(src)) {
        showToast("当前图片已是远程图床 URL", "info");
        return;
      }
      const localPath = resolveLocalImagePath(src, activeDocumentPath);
      const filename = (src.split(/[\\/]/).pop() || "image.png").split("?")[0];
      const span = btn.querySelector("span");
      const prevLabel = span?.textContent || "上传图床";
      try {
        if (span) span.textContent = "上传中...";
        const remoteUrl = await uploadImageAssetToBed({
          localPath,
          base64Data: src.startsWith("data:") ? src : undefined,
          filename,
        });
        src = remoteUrl;
        activeImgTarget.src = remoteUrl;
        showToast(`图片已成功上传图床：${remoteUrl}`, "success");
      } catch (err) {
        const errStr = String(err);
        showToast(`${errStr}`, "info");
        if (errStr.includes("偏好设置")) {
          hideAllToolbars();
          openPreferencesModal();
        }
        if (span) span.textContent = prevLabel;
        return;
      }
    } else if (action === "source") {
      hideAllToolbars();
      view.dispatch({ selection: { anchor: Math.min(from + 2, view.state.doc.length) } });
      view.focus();
      return;
    } else if (action === "delete") {
      hideAllToolbars();
      view.dispatch({ changes: { from, to, insert: "" } });
      view.focus();
      return;
    }

    let newTag = "";
    if (width || align !== "left") {
      const wAttr = width ? ` width="${escapeAttr(width)}"` : "";
      const aAttr = align && align !== "left" ? ` align="${escapeAttr(align)}"` : "";
      const altAttr = alt ? ` alt="${escapeAttr(alt)}"` : "";
      newTag = `<img src="${escapeAttr(src)}"${altAttr}${wAttr}${aAttr} />`;
    } else {
      newTag = `![${alt}](${src})`;
    }

    view.dispatch({
      changes: { from, to, insert: newTag },
    });

    activeImgTarget.from = from;
    activeImgTarget.to = from + newTag.length;
    activeImgTarget.width = width;
    activeImgTarget.align = align;
    refreshImgToolbarState();

    requestAnimationFrame(() => {
      const updatedFigure = view.dom.querySelector(
        `.md-image-card[data-from="${from}"]`
      ) as HTMLElement | null;
      if (updatedFigure && activeImgTarget) {
        activeImgTarget.elem = updatedFigure;
        positionToolbar(imgToolbar, updatedFigure);
      }
    });
  });

  const saveLinkChanges = () => {
    if (!activeLinkTarget) return;
    const textInput = linkTooltip.querySelector("#ty-link-edit-text") as HTMLInputElement;
    const urlInput = linkTooltip.querySelector("#ty-link-edit-url") as HTMLInputElement;
    const newText = textInput.value.trim() || activeLinkTarget.text;
    const newUrl = sanitizeLinkUrl(urlInput.value);

    if (newUrl) {
      const from = parseInt(
        activeLinkTarget.elem.getAttribute("data-from") || String(activeLinkTarget.from),
        10
      );
      const to = parseInt(
        activeLinkTarget.elem.getAttribute("data-to") || String(activeLinkTarget.to),
        10
      );
      const replacement = `[${newText}](${newUrl})`;
      if (from >= 0 && to > from && to <= view.state.doc.length) {
        view.dispatch({
          changes: { from, to, insert: replacement },
        });
      }
    }
    hideAllToolbars();
    view.focus();
  };

  // 链接工具栏按钮事件
  linkTooltip.addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest(".ty-toolbar-btn") as HTMLElement;
    if (!btn || !activeLinkTarget) return;

    const action = btn.dataset.action;
    const { url, text, elem } = activeLinkTarget;
    const from = parseInt(elem.getAttribute("data-from") || String(activeLinkTarget.from), 10);
    const to = parseInt(elem.getAttribute("data-to") || String(activeLinkTarget.to), 10);

    if (action === "open-link") {
      handleOpenLink(url, onOpenFile);
      hideAllToolbars();
    } else if (action === "copy-link") {
      navigator.clipboard.writeText(url).then(() => {
        const span = btn.querySelector("span");
        if (span) span.textContent = "已复制";
        setTimeout(() => {
          if (span) span.textContent = "复制";
          hideAllToolbars();
        }, 1000);
      });
    } else if (action === "unlink") {
      if (from >= 0 && to > from && to <= view.state.doc.length) {
        view.dispatch({
          changes: { from, to, insert: text },
        });
      }
      hideAllToolbars();
      view.focus();
    } else if (action === "edit-link") {
      const viewRow = linkTooltip.querySelector("#ty-link-view-row");
      const editForm = linkTooltip.querySelector("#ty-link-edit-form");
      const textInput = linkTooltip.querySelector("#ty-link-edit-text") as HTMLInputElement;
      const urlInput = linkTooltip.querySelector("#ty-link-edit-url") as HTMLInputElement;
      viewRow?.classList.add("hidden");
      editForm?.classList.remove("hidden");

      // 智能纠偏：若旧数据中名称栏填了网址而链接栏还是空的 https://，自动将网址移入链接栏并聚焦名称栏 (Bug #7)
      if ((url === "https://" || !url.trim()) && isLikelyUrl(text)) {
        textInput.value = "链接文字";
        urlInput.value = normalizeUrlForLink(text);
        positionToolbar(linkTooltip, elem);
        setTimeout(() => {
          textInput.focus();
          textInput.select();
        }, 15);
      } else {
        textInput.value = text;
        urlInput.value = url;
        positionToolbar(linkTooltip, elem);
        setTimeout(() => {
          if (!text || text === "链接文字") {
            textInput.focus();
            textInput.select();
          } else {
            urlInput.focus();
            urlInput.select();
          }
        }, 15);
      }
    } else if (action === "save-link") {
      saveLinkChanges();
    } else if (action === "cancel-link") {
      hideAllToolbars();
      view.focus();
    }
  });

  linkTooltip.querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("keydown", (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        saveLinkChanges();
      } else if (e.key === "Escape") {
        e.preventDefault();
        hideAllToolbars();
        view.focus();
      }
    });
  });

  // 监听右键菜单 / 气泡栏 / Ctrl+K 新建超链接事件，直接弹出带“名称/链接”标识的编辑面板并精准聚焦待填栏 (Bug #7)
  view.dom.addEventListener("quilla-edit-active-link", ((e: CustomEvent) => {
    const detail = e.detail;
    if (!detail) return;
    requestAnimationFrame(() => {
      const linkEl =
        view.dom.querySelector<HTMLElement>(`.cm-link[data-from="${detail.from}"]`) ||
        view.dom.querySelector<HTMLElement>(".cm-link.cm-link-active");
      if (!linkEl) return;
      activeLinkTarget = {
        elem: linkEl,
        url: detail.url,
        text: detail.text,
        from: detail.from,
        to: detail.to,
      };
      const viewRow = linkTooltip.querySelector("#ty-link-view-row");
      const editForm = linkTooltip.querySelector("#ty-link-edit-form");
      const textInput = linkTooltip.querySelector("#ty-link-edit-text") as HTMLInputElement;
      const urlInput = linkTooltip.querySelector("#ty-link-edit-url") as HTMLInputElement;
      viewRow?.classList.add("hidden");
      editForm?.classList.remove("hidden");
      textInput.value = detail.text;
      urlInput.value = detail.url;
      linkTooltip.classList.remove("hidden");
      imgToolbar.classList.add("hidden");
      selToolbar.classList.add("hidden");
      positionToolbar(linkTooltip, linkEl);
      setTimeout(() => {
        if (detail.focusField === "text") {
          textInput.focus();
          textInput.select();
        } else {
          urlInput.focus();
          urlInput.select();
        }
      }, 15);
    });
  }) as EventListener);

  view.scrollDOM.addEventListener("scroll", () => {
    hideAllToolbars();
  });

  window.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (
      !imgToolbar.contains(t) &&
      !linkTooltip.contains(t) &&
      !selToolbar.contains(t)
    ) {
      hideAllToolbars();
    }
  });
}
