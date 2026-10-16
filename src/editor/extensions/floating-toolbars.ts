import { EditorView } from "@codemirror/view";
import { handleOpenLink } from "../index";
import { smartToggleFormat, toggleHeadingLevel } from "./formatting-keymap";

export function initFloatingToolbars(
  view: EditorView,
  onOpenFile?: (filePath: string) => void
) {
  // 1. 创建图片微型悬浮工具栏 (Floating Image Toolbar)
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
    <button type="button" class="ty-toolbar-btn" data-action="source" title="查看并编辑 Markdown 源码">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
      <span>源码</span>
    </button>
    <button type="button" class="ty-toolbar-btn danger" data-action="delete" title="删除图片">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
    </button>
  `;
  document.body.appendChild(imgToolbar);

  // 2. 创建超链接悬浮工具栏与内联双字段编辑器
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
      <button type="button" class="ty-toolbar-btn" data-action="edit-link" title="编辑链接文字与地址">
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
      <input type="text" id="ty-link-edit-text" class="ty-inline-input" placeholder="链接显示文字..." />
      <input type="text" id="ty-link-edit-url" class="ty-inline-input" placeholder="https://..." />
      <div class="link-edit-actions">
        <button type="button" class="ty-toolbar-btn primary" data-action="save-link">保存</button>
        <button type="button" class="ty-toolbar-btn" data-action="cancel-link">取消</button>
      </div>
    </div>
  `;
  document.body.appendChild(linkTooltip);

  // 3. 创建选中文本悬浮气泡格式栏 (Selection Bubble Menu)
  const selToolbar = document.createElement("div");
  selToolbar.className = "ty-selection-toolbar hidden";
  selToolbar.innerHTML = `
    <button type="button" class="ty-toolbar-btn" data-fmt="bold" title="加粗 (Ctrl+B)"><strong>B</strong></button>
    <button type="button" class="ty-toolbar-btn" data-fmt="italic" title="斜体 (Ctrl+I)"><em>I</em></button>
    <button type="button" class="ty-toolbar-btn" data-fmt="strike" title="删除线 (Ctrl+Shift+X)"><del>S</del></button>
    <button type="button" class="ty-toolbar-btn" data-fmt="highlight" title="荧光高亮 (Ctrl+Shift+H)"><span class="fmt-mark-icon">H</span></button>
    <button type="button" class="ty-toolbar-btn" data-fmt="code" title="行内代码 (Ctrl+E)"><code>&lt;/&gt;</code></button>
    <button type="button" class="ty-toolbar-btn" data-fmt="math" title="行内公式 ($)"><span>∑</span></button>
    <button type="button" class="ty-toolbar-btn" data-fmt="link" title="超链接 (Ctrl+K)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
    </button>
    <div class="ty-toolbar-divider"></div>
    <button type="button" class="ty-toolbar-btn" data-heading="1" title="一级标题">H1</button>
    <button type="button" class="ty-toolbar-btn" data-heading="2" title="二级标题">H2</button>
    <button type="button" class="ty-toolbar-btn" data-heading="3" title="三级标题">H3</button>
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
    const tbWidth = toolbar.offsetWidth || 300;
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
      selToolbar.classList.remove("hidden");
      const tbWidth = selToolbar.offsetWidth || 280;
      const tbHeight = selToolbar.offsetHeight || 32;
      let top = Math.min(startCoords.top, endCoords.top) - tbHeight - 8;
      if (top < 38) {
        top = Math.max(startCoords.bottom, endCoords.bottom) + 8;
      }
      const midX = (startCoords.left + endCoords.right) / 2;
      let left = Math.max(12, Math.min(midX - tbWidth / 2, window.innerWidth - tbWidth - 12));
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
    // 键盘方向键导航进入超链接时自动无感浮出链接预览工具条，配合紧凑链接模式实现零抖动编辑
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

  // 选中文本气泡栏点击
  selToolbar.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest(".ty-toolbar-btn") as HTMLElement;
    if (!btn) return;
    const fmt = btn.dataset.fmt;
    const heading = btn.dataset.heading;

    if (fmt === "bold") smartToggleFormat(view, "**");
    else if (fmt === "italic") smartToggleFormat(view, "*");
    else if (fmt === "strike") smartToggleFormat(view, "~~");
    else if (fmt === "highlight") smartToggleFormat(view, "==");
    else if (fmt === "code") smartToggleFormat(view, "`");
    else if (fmt === "math") smartToggleFormat(view, "$");
    else if (fmt === "link") {
      const sel = view.state.selection.main;
      const text = view.state.sliceDoc(sel.from, sel.to) || "链接文字";
      const insertStr = `[${text}](https://)`;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: insertStr },
        selection: { anchor: sel.from + text.length + 3, head: sel.from + insertStr.length - 1 },
      });
    } else if (heading) {
      toggleHeadingLevel(view, parseInt(heading, 10));
    }

    selToolbar.classList.add("hidden");
    view.focus();
  });

  // 监听正文点击
  view.dom.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    // 检查是否点击了图片
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

    // 检查是否点击了超链接
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
  imgToolbar.addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest(".ty-toolbar-btn") as HTMLElement;
    if (!btn || !activeImgTarget) return;

    const newSize = btn.dataset.size;
    const newAlign = btn.dataset.align;
    const action = btn.dataset.action;

    let { from, to, src, alt, width, align } = activeImgTarget;

    if (newSize) {
      width = newSize === "100%" || width === newSize ? "" : newSize;
    } else if (newAlign) {
      align = align === newAlign ? "left" : newAlign;
    } else if (action === "source") {
      hideAllToolbars();
      view.dispatch({ selection: { anchor: from + 2 } });
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
      const wAttr = width ? ` width="${width}"` : "";
      const aAttr = align && align !== "left" ? ` align="${align}"` : "";
      const altAttr = alt ? ` alt="${alt}"` : "";
      newTag = `<img src="${src}"${altAttr}${wAttr}${aAttr} />`;
    } else {
      newTag = `![${alt}](${src})`;
    }

    view.dispatch({
      changes: { from, to, insert: newTag },
    });

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
    const newUrl = urlInput.value.trim();

    if (newUrl) {
      const { from, to } = activeLinkTarget;
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
    const { url, text, from, to, elem } = activeLinkTarget;

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
      textInput.value = text;
      urlInput.value = url;
      positionToolbar(linkTooltip, elem);
      setTimeout(() => {
        urlInput.focus();
        urlInput.select();
      }, 15);
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
