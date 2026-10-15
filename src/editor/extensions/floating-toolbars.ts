import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { handleOpenLink } from "../index";

export function initFloatingToolbars(view: EditorView) {
  // 1. 创建图片微型悬浮工具栏 (Floating Image Toolbar)
  const imgToolbar = document.createElement("div");
  imgToolbar.className = "ty-image-toolbar hidden";
  imgToolbar.innerHTML = `
    <button type="button" class="ty-toolbar-btn" data-size="25%">25%</button>
    <button type="button" class="ty-toolbar-btn" data-size="50%">50%</button>
    <button type="button" class="ty-toolbar-btn" data-size="80%">80%</button>
    <button type="button" class="ty-toolbar-btn" data-size="100%">100%</button>
    <div class="ty-toolbar-divider"></div>
    <button type="button" class="ty-toolbar-btn" data-align="left" title="居左排版">⫷ 左</button>
    <button type="button" class="ty-toolbar-btn" data-align="center" title="居中排版">⫸ 中</button>
    <button type="button" class="ty-toolbar-btn" data-align="right" title="居右排版">⫹ 右</button>
    <div class="ty-toolbar-divider"></div>
    <button type="button" class="ty-toolbar-btn" data-action="source" title="查看并编辑 Markdown/HTML 源码">✏️ 源码</button>
    <button type="button" class="ty-toolbar-btn" data-action="delete" style="color: #cf222e;" title="删除图片">🗑️</button>
  `;
  document.body.appendChild(imgToolbar);

  // 2. 创建超链接悬浮工具栏 (Floating Link Tooltip)
  const linkTooltip = document.createElement("div");
  linkTooltip.className = "ty-link-tooltip hidden";
  linkTooltip.innerHTML = `
    <span class="link-url-text" id="ty-link-preview-url">https://...</span>
    <div class="ty-toolbar-divider"></div>
    <button type="button" class="ty-toolbar-btn" data-action="open-link" title="在默认浏览器中打开">🌐 打开</button>
    <button type="button" class="ty-toolbar-btn" data-action="edit-link" title="编辑链接文字与地址">✏️ 编辑</button>
    <button type="button" class="ty-toolbar-btn" data-action="copy-link" title="复制链接地址">📋 复制</button>
  `;
  document.body.appendChild(linkTooltip);

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
  } | null = null;

  function positionToolbar(toolbar: HTMLElement, targetElem: HTMLElement) {
    const rect = targetElem.getBoundingClientRect();
    const tbWidth = toolbar.offsetWidth || 300;
    const tbHeight = toolbar.offsetHeight || 32;

    let top = rect.top - tbHeight - 6;
    if (top < 40) {
      top = rect.bottom + 6;
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
    activeImgTarget = null;
    activeLinkTarget = null;
  }

  // 监听正文点击与悬浮
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

      // 更新按钮高亮
      imgToolbar.querySelectorAll("[data-size]").forEach((btn: any) => {
        btn.classList.toggle("active", btn.dataset.size === width);
      });
      imgToolbar.querySelectorAll("[data-align]").forEach((btn: any) => {
        btn.classList.toggle("active", btn.dataset.align === align);
      });

      imgToolbar.classList.remove("hidden");
      linkTooltip.classList.add("hidden");
      positionToolbar(imgToolbar, imgFigure);
      return;
    }

    // 检查是否点击了超链接
    const linkEl = target.closest(".cm-link") as HTMLElement;
    if (linkEl) {
      e.stopPropagation();
      const url = linkEl.getAttribute("data-href") || "";
      activeLinkTarget = { elem: linkEl, url };

      const urlSpan = linkTooltip.querySelector("#ty-link-preview-url");
      if (urlSpan) urlSpan.textContent = url;

      linkTooltip.classList.remove("hidden");
      imgToolbar.classList.add("hidden");
      positionToolbar(linkTooltip, linkEl);
      return;
    }

    hideAllToolbars();
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
      width = width === newSize ? "" : newSize;
    } else if (newAlign) {
      align = align === newAlign ? "left" : newAlign;
    } else if (action === "source") {
      hideAllToolbars();
      view.dispatch({ selection: { anchor: from } });
      view.focus();
      return;
    } else if (action === "delete") {
      hideAllToolbars();
      view.dispatch({ changes: { from, to, insert: "" } });
      view.focus();
      return;
    }

    // 序列化为标准 HTML <img> 或 Markdown 标签 (支持 Typora 原生 width & align)
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
    hideAllToolbars();
  });

  // 链接工具栏按钮事件
  linkTooltip.addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest(".ty-toolbar-btn") as HTMLElement;
    if (!btn || !activeLinkTarget) return;

    const action = btn.dataset.action;
    const url = activeLinkTarget.url;

    if (action === "open-link") {
      handleOpenLink(url);
      hideAllToolbars();
    } else if (action === "copy-link") {
      navigator.clipboard.writeText(url).then(() => {
        btn.textContent = "✓ 已复制";
        setTimeout(() => {
          btn.textContent = "📋 复制";
          hideAllToolbars();
        }, 1200);
      });
    } else if (action === "edit-link") {
      hideAllToolbars();
      const newUrl = prompt("修改超链接 URL:", url);
      if (newUrl !== null && newUrl !== url) {
        // 在光标位置替换
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        const lineText = line.text;
        const replaced = lineText.replace(url, newUrl);
        if (replaced !== lineText) {
          view.dispatch({ changes: { from: line.from, to: line.to, insert: replaced } });
        }
      }
    }
  });

  // 视口滚动或全局点击隐藏浮层
  view.scrollDOM.addEventListener("scroll", () => {
    hideAllToolbars();
  });

  window.addEventListener("click", (e) => {
    if (!imgToolbar.contains(e.target as Node) && !linkTooltip.contains(e.target as Node)) {
      hideAllToolbars();
    }
  });
}
