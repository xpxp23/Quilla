import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { openShortcutGuide } from "./shortcut-guide";
import { getRecentFiles, clearRecentFiles } from "./quick-open";
import { handleOpenLink } from "../editor/index";
import { smartToggleFormat } from "../editor/extensions/formatting-keymap";
import { htmlToMarkdown } from "../editor/extensions/smart-paste";

export interface MenuActions {
  onNewFile: () => void;
  onNewWindow?: () => void;
  onOpenFile: () => void;
  onOpenFileByPath?: (filePath: string) => void;
  onOpenFolder: () => void;
  onSaveFile: () => void;
  onSaveFileAs?: () => void;
  onToggleSidebar?: () => void;
  onToggleSourceMode?: () => void;
  onToggleTypewriterMode?: () => void;
  onToggleFocusMode?: () => void;
  onSwitchTheme?: (themeName: string) => void;
  onExportHtml: () => void;
  onPrint?: () => void;
  onQuickOpen?: () => void;
}

/**
 * 初始化左上角汉堡弹出菜单 (纯粹高效的文件与编辑菜单) 与右键上下文菜单
 */
export function initMenus(view: EditorView, actions: MenuActions) {
  // 1. 创建汉堡菜单悬浮窗
  const menuContainer = document.createElement("div");
  menuContainer.id = "app-hamburger-menu";
  menuContainer.className = "ty-dropdown-menu hidden";
  menuContainer.innerHTML = `
    <div class="menu-section">
      <div class="menu-item" data-action="new">
        <div class="menu-item-left"><span class="m-icon">📄</span><span>新建</span></div>
        <span class="shortcut">Ctrl+N</span>
      </div>
      <div class="menu-item" data-action="new-window">
        <div class="menu-item-left"><span class="m-icon">🗖</span><span>新建窗口</span></div>
        <span class="shortcut">Ctrl+Shift+N</span>
      </div>
      <div class="menu-item" data-action="open-file">
        <div class="menu-item-left"><span class="m-icon">📂</span><span>打开文件...</span></div>
        <span class="shortcut">Ctrl+O</span>
      </div>
      <div class="menu-item" data-action="open-folder">
        <div class="menu-item-left"><span class="m-icon">📁</span><span>打开文件夹...</span></div>
      </div>
      <div class="menu-item has-submenu" id="menu-recent-files">
        <div class="menu-item-left"><span class="m-icon">🕒</span><span>打开最近文件</span></div>
        <span class="submenu-arrow">›</span>
        <div class="ty-submenu" id="submenu-recent-container"></div>
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item" data-action="save">
        <div class="menu-item-left"><span class="m-icon">💾</span><span>保存</span></div>
        <span class="shortcut">Ctrl+S</span>
      </div>
      <div class="menu-item" data-action="save-as">
        <div class="menu-item-left"><span class="m-icon">📥</span><span>另存为...</span></div>
        <span class="shortcut">Ctrl+Shift+S</span>
      </div>
      <div class="menu-item" data-action="print">
        <div class="menu-item-left"><span class="m-icon">🖨️</span><span>打印 / 导出为 PDF...</span></div>
        <span class="shortcut">Ctrl+Shift+P</span>
      </div>
      <div class="menu-item" data-action="export-html">
        <div class="menu-item-left"><span class="m-icon">🌐</span><span>导出为 HTML</span></div>
      </div>
    </div>
    <div class="menu-divider"></div>
    <div class="menu-section">
      <div class="menu-item" data-action="undo">
        <div class="menu-item-left"><span class="m-icon">↩</span><span>撤销</span></div>
        <span class="shortcut">Ctrl+Z</span>
      </div>
      <div class="menu-item" data-action="redo">
        <div class="menu-item-left"><span class="m-icon">↪</span><span>重做</span></div>
        <span class="shortcut">Ctrl+Y</span>
      </div>
      <div class="menu-item" data-action="quick-open">
        <div class="menu-item-left"><span class="m-icon">🔍</span><span>快速漫游...</span></div>
        <span class="shortcut">Ctrl+P</span>
      </div>
      <div class="menu-item" data-action="shortcut-guide">
        <div class="menu-item-left"><span class="m-icon">⌨️</span><span>快捷键指南</span></div>
        <span class="shortcut">F1</span>
      </div>
    </div>
  `;
  document.body.appendChild(menuContainer);

  const menuBtn = document.getElementById("w-menu-btn");
  menuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    menuContainer.classList.toggle("hidden");
    if (!menuContainer.classList.contains("hidden")) {
      // 动态填充最近文件子菜单
      const recentContainer = document.getElementById("submenu-recent-container");
      if (recentContainer) {
        const recentList = getRecentFiles();
        if (recentList.length === 0) {
          recentContainer.innerHTML = `<div style="padding: 8px 14px; font-size: 12px; color: var(--control-text-color); text-align: left;">暂无最近文件</div>`;
        } else {
          recentContainer.innerHTML =
            recentList
              .slice(0, 10)
              .map(
                (f) => `
              <div class="menu-item recent-file-item" data-path="${encodeURIComponent(f.path)}" title="${f.path}">
                <div class="menu-item-left">
                  <span class="m-icon">📄</span>
                  <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width: 170px; text-align: left;">${f.name}</span>
                </div>
              </div>
            `
              )
              .join("") +
            `
              <div class="menu-divider"></div>
              <div class="menu-item" data-action="clear-recent" style="color: var(--control-text-color);">
                <div class="menu-item-left">
                  <span class="m-icon">🗑️</span>
                  <span>清空最近记录</span>
                </div>
              </div>
            `;
        }
      }
    }

    const rect = menuBtn.getBoundingClientRect();
    menuContainer.style.top = `${rect.bottom + 4}px`;
    menuContainer.style.left = `${rect.left}px`;
  });

  // 最近文件悬浮响应与位置动态检测
  const recentMenuItem = document.getElementById("menu-recent-files");
  const recentSubmenuContainer = document.getElementById("submenu-recent-container");
  if (recentMenuItem && recentSubmenuContainer) {
    const adjustSubmenu = () => {
      const rect = recentMenuItem.getBoundingClientRect();
      if (rect.right + 220 > window.innerWidth) {
        recentSubmenuContainer.style.left = "auto";
        recentSubmenuContainer.style.right = "100%";
      } else {
        recentSubmenuContainer.style.left = "100%";
        recentSubmenuContainer.style.right = "auto";
      }
    };
    recentMenuItem.addEventListener("mouseenter", adjustSubmenu);
  }

  menuContainer.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(".menu-item") as HTMLElement;
    if (!item) return;

    // 如果点击的是含有子菜单的父级标签自身，阻止立即关闭菜单
    if (item.classList.contains("has-submenu") && !item.classList.contains("recent-file-item")) {
      return;
    }

    const action = item.dataset.action;
    const recentPath = item.dataset.path;

    if (recentPath) {
      actions.onOpenFileByPath?.(decodeURIComponent(recentPath));
    } else if (action === "clear-recent") {
      clearRecentFiles();
      const recentContainer = document.getElementById("submenu-recent-container");
      if (recentContainer) {
        recentContainer.innerHTML = `<div style="padding: 8px 14px; font-size: 12px; color: var(--control-text-color); text-align: left;">暂无最近文件</div>`;
      }
      return;
    } else if (action === "new") actions.onNewFile();
    else if (action === "new-window") actions.onNewWindow?.();
    else if (action === "open-file") actions.onOpenFile();
    else if (action === "open-folder") actions.onOpenFolder();
    else if (action === "save") actions.onSaveFile();
    else if (action === "save-as") actions.onSaveFileAs?.();
    else if (action === "export-html") actions.onExportHtml();
    else if (action === "print") (actions.onPrint ? actions.onPrint() : window.print());
    else if (action === "quick-open") actions.onQuickOpen?.();
    else if (action === "undo") {
      undo(view);
    } else if (action === "redo") {
      redo(view);
    } else if (action === "shortcut-guide") {
      openShortcutGuide();
    }

    menuContainer.classList.add("hidden");
  });

  // 2. 自定义动态上下文敏感右键菜单 (Context-Sensitive Menu)
  const contextMenu = document.createElement("div");
  contextMenu.id = "app-context-menu";
  contextMenu.className = "ty-dropdown-menu hidden";
  document.body.appendChild(contextMenu);

  let currentContextTarget: {
    type: "table" | "image" | "link" | "text";
    element: HTMLElement;
  } | null = null;

  const writeArea = document.getElementById("content");
  writeArea?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const target = e.target as HTMLElement;

    const tableEl = target.closest(".in-place-edit") as HTMLElement;
    const imgEl = target.closest(".md-image-card") as HTMLElement;
    const linkEl = target.closest(".cm-link") as HTMLElement;

    if (tableEl) {
      currentContextTarget = { type: "table", element: tableEl };
      contextMenu.innerHTML = `
        <div class="menu-section">
          <div class="menu-item-group-title">表格行列</div>
          <div class="menu-item" data-action="tbl-add-row-above"><div class="menu-item-left"><span class="m-icon">⬆️</span><span>上方插入行</span></div></div>
          <div class="menu-item" data-action="tbl-add-row-below"><div class="menu-item-left"><span class="m-icon">⬇️</span><span>下方插入行</span></div></div>
          <div class="menu-item" data-action="tbl-add-col-left"><div class="menu-item-left"><span class="m-icon">⬅️</span><span>左侧插入列</span></div></div>
          <div class="menu-item" data-action="tbl-add-col-right"><div class="menu-item-left"><span class="m-icon">➡️</span><span>右侧插入列</span></div></div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          <div class="menu-item-group-title">列对齐</div>
          <div class="menu-item" data-action="tbl-align-left"><div class="menu-item-left"><span class="m-icon">⇤</span><span>靠左对齐</span></div></div>
          <div class="menu-item" data-action="tbl-align-center"><div class="menu-item-left"><span class="m-icon">↔</span><span>居中对齐</span></div></div>
          <div class="menu-item" data-action="tbl-align-right"><div class="menu-item-left"><span class="m-icon">⇥</span><span>靠右对齐</span></div></div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          <div class="menu-item" data-action="tbl-del-row" style="color: #cf222e;"><div class="menu-item-left"><span class="m-icon">🗑️</span><span>删除当前行</span></div></div>
          <div class="menu-item" data-action="tbl-del-col" style="color: #cf222e;"><div class="menu-item-left"><span class="m-icon">🗑️</span><span>删除当前列</span></div></div>
        </div>
      `;
    } else if (imgEl) {
      currentContextTarget = { type: "image", element: imgEl };
      contextMenu.innerHTML = `
        <div class="menu-section">
          <div class="menu-item-group-title">图片尺寸</div>
          <div class="menu-item" data-action="img-size-25"><div class="menu-item-left"><span class="m-icon">🔍</span><span>缩放至 25%</span></div></div>
          <div class="menu-item" data-action="img-size-50"><div class="menu-item-left"><span class="m-icon">🔍</span><span>缩放至 50%</span></div></div>
          <div class="menu-item" data-action="img-size-80"><div class="menu-item-left"><span class="m-icon">🔍</span><span>缩放至 80%</span></div></div>
          <div class="menu-item" data-action="img-size-100"><div class="menu-item-left"><span class="m-icon">🔍</span><span>原始尺寸 100%</span></div></div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          <div class="menu-item-group-title">排版对齐</div>
          <div class="menu-item" data-action="img-align-left"><div class="menu-item-left"><span class="m-icon">⫷</span><span>居左排版</span></div></div>
          <div class="menu-item" data-action="img-align-center"><div class="menu-item-left"><span class="m-icon">⫸</span><span>居中排版</span></div></div>
          <div class="menu-item" data-action="img-align-right"><div class="menu-item-left"><span class="m-icon">⫹</span><span>居右排版</span></div></div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          <div class="menu-item" data-action="img-copy-src"><div class="menu-item-left"><span class="m-icon">📋</span><span>复制图片地址</span></div></div>
          <div class="menu-item" data-action="img-delete" style="color: #cf222e;"><div class="menu-item-left"><span class="m-icon">🗑️</span><span>删除图片</span></div></div>
        </div>
      `;
    } else if (linkEl) {
      currentContextTarget = { type: "link", element: linkEl };
      const href = linkEl.dataset.href || "";
      contextMenu.innerHTML = `
        <div class="menu-section">
          <div class="menu-item" data-action="link-open"><div class="menu-item-left"><span class="m-icon">🌐</span><span>在浏览器中打开</span></div></div>
          <div class="menu-item" data-action="link-copy" data-url="${href}"><div class="menu-item-left"><span class="m-icon">📋</span><span>复制链接地址</span></div></div>
        </div>
      `;
    } else {
      currentContextTarget = { type: "text", element: target };
      contextMenu.innerHTML = `
        <div class="menu-section">
          <div class="menu-item" data-action="cut">
            <div class="menu-item-left"><span class="m-icon">✂️</span><span>剪切</span></div>
            <span class="shortcut">Ctrl+X</span>
          </div>
          <div class="menu-item" data-action="copy">
            <div class="menu-item-left"><span class="m-icon">📋</span><span>复制</span></div>
            <span class="shortcut">Ctrl+C</span>
          </div>
          <div class="menu-item" data-action="paste">
            <div class="menu-item-left"><span class="m-icon">📥</span><span>智能粘贴</span></div>
            <span class="shortcut">Ctrl+V</span>
          </div>
          <div class="menu-item" data-action="paste-plain">
            <div class="menu-item-left"><span class="m-icon">📄</span><span>纯文本粘贴</span></div>
            <span class="shortcut">Ctrl+Shift+V</span>
          </div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          <div class="menu-item" data-action="bold">
            <div class="menu-item-left"><span class="m-icon">𝐁</span><span>加粗</span></div>
            <span class="shortcut">Ctrl+B</span>
          </div>
          <div class="menu-item" data-action="italic">
            <div class="menu-item-left"><span class="m-icon">𝐼</span><span>斜体</span></div>
            <span class="shortcut">Ctrl+I</span>
          </div>
          <div class="menu-item" data-action="highlight">
            <div class="menu-item-left"><span class="m-icon">🖍️</span><span>荧光高亮</span></div>
            <span class="shortcut">==</span>
          </div>
          <div class="menu-item" data-action="code">
            <div class="menu-item-left"><span class="m-icon">&lt;/&gt;</span><span>行内代码</span></div>
            <span class="shortcut">Ctrl+\`</span>
          </div>
          <div class="menu-item" data-action="link">
            <div class="menu-item-left"><span class="m-icon">🔗</span><span>插入链接</span></div>
            <span class="shortcut">Ctrl+K</span>
          </div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          <div class="menu-item" data-action="table">
            <div class="menu-item-left"><span class="m-icon">▦</span><span>插入表格</span></div>
          </div>
          <div class="menu-item" data-action="codeblock">
            <div class="menu-item-left"><span class="m-icon">📜</span><span>插入代码块</span></div>
          </div>
          <div class="menu-item" data-action="mathblock">
            <div class="menu-item-left"><span class="m-icon">∑</span><span>插入公式块</span></div>
          </div>
        </div>
      `;
    }

    contextMenu.classList.remove("hidden");
    const menuWidth = 220;
    const menuHeight = contextMenu.offsetHeight || 260;
    const posX = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const posY = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
    contextMenu.style.top = `${posY}px`;
    contextMenu.style.left = `${posX}px`;
  });

  contextMenu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(".menu-item") as HTMLElement;
    if (!item) return;
    const act = item.dataset.action;

    // 表格操作委托给浮动工具栏或直接触发
    if (act?.startsWith("tbl-") && currentContextTarget?.element) {
      const btnAct = act.replace("tbl-", "");
      const tblToolbarBtn = currentContextTarget.element
        .closest(".cm-table-widget, .in-place-edit")
        ?.parentElement?.querySelector(`[data-act="${btnAct}"]`) as HTMLElement;
      if (tblToolbarBtn) {
        tblToolbarBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      }
    } else if (act?.startsWith("img-") && currentContextTarget?.element) {
      const from = parseInt(currentContextTarget.element.dataset.from || "0", 10);
      const to = parseInt(currentContextTarget.element.dataset.to || "0", 10);
      const src = currentContextTarget.element.dataset.src || "";
      const alt = currentContextTarget.element.dataset.alt || "";
      let width = currentContextTarget.element.dataset.width || "";
      let align = currentContextTarget.element.dataset.align || "left";

      if (act === "img-size-25") width = "25%";
      else if (act === "img-size-50") width = "50%";
      else if (act === "img-size-80") width = "80%";
      else if (act === "img-size-100") width = "";
      else if (act === "img-align-left") align = "left";
      else if (act === "img-align-center") align = "center";
      else if (act === "img-align-right") align = "right";
      else if (act === "img-copy-src") {
        navigator.clipboard.writeText(src);
      } else if (act === "img-delete") {
        view.dispatch({ changes: { from, to, insert: "" } });
      }

      if (act.startsWith("img-size-") || act.startsWith("img-align-")) {
        const wAttr = width ? ` width="${width}"` : "";
        const aAttr = align !== "left" ? ` align="${align}"` : "";
        const altAttr = alt ? ` alt="${alt}"` : "";
        const tag = width || align !== "left" ? `<img src="${src}"${altAttr}${wAttr}${aAttr} />` : `![${alt}](${src})`;
        view.dispatch({ changes: { from, to, insert: tag } });
      }
    } else if (act === "link-open" && currentContextTarget?.element) {
      const href = currentContextTarget.element.dataset.href;
      if (href) handleOpenLink(href, actions.onOpenFileByPath);
    } else if (act === "link-copy" && currentContextTarget?.element) {
      const href = currentContextTarget.element.dataset.href;
      if (href) navigator.clipboard.writeText(href);
    } else if (act === "cut") document.execCommand("cut");
    else if (act === "copy") document.execCommand("copy");
    else if (act === "paste") {
      if (navigator.clipboard.read) {
        navigator.clipboard
          .read()
          .then(async (items) => {
            for (const clipItem of items) {
              if (clipItem.types.includes("text/html")) {
                const blob = await clipItem.getType("text/html");
                const html = await blob.text();
                const md = htmlToMarkdown(html);
                if (md && md.trim()) {
                  const { from, to } = view.state.selection.main;
                  view.dispatch({
                    changes: { from, to, insert: md },
                    selection: { anchor: from + md.length },
                  });
                  return;
                }
              }
            }
            const txt = await navigator.clipboard.readText();
            const { from, to } = view.state.selection.main;
            view.dispatch({ changes: { from, to, insert: txt }, selection: { anchor: from + txt.length } });
          })
          .catch(() => {
            navigator.clipboard.readText().then((txt) => {
              const { from, to } = view.state.selection.main;
              view.dispatch({ changes: { from, to, insert: txt }, selection: { anchor: from + txt.length } });
            });
          });
      } else {
        navigator.clipboard.readText().then((txt) => {
          const { from, to } = view.state.selection.main;
          view.dispatch({ changes: { from, to, insert: txt }, selection: { anchor: from + txt.length } });
        });
      }
    } else if (act === "paste-plain") {
      navigator.clipboard.readText().then((txt) => {
        const { from, to } = view.state.selection.main;
        view.dispatch({ changes: { from, to, insert: txt }, selection: { anchor: from + txt.length } });
      });
    } else if (act === "bold") {
      smartToggleFormat(view, "**");
    } else if (act === "italic") {
      smartToggleFormat(view, "*");
    } else if (act === "highlight") {
      smartToggleFormat(view, "==");
    } else if (act === "code") {
      smartToggleFormat(view, "`");
    } else if (act === "link") {
      const sel = view.state.selection.main;
      const txt = view.state.sliceDoc(sel.from, sel.to);
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: `[${txt || "链接"}](url)` } });
    } else if (act === "table") {
      const pos = view.state.selection.main.head;
      view.dispatch({ changes: { from: pos, insert: `\n| 列 1 | 列 2 |\n| :--- | :--- |\n| 内容 | 内容 |\n` } });
    } else if (act === "codeblock") {
      const pos = view.state.selection.main.head;
      view.dispatch({ changes: { from: pos, insert: `\n\`\`\`\n\n\`\`\`\n` } });
    } else if (act === "mathblock") {
      const pos = view.state.selection.main.head;
      view.dispatch({ changes: { from: pos, insert: `\n$$\n\n$$\n` } });
    }

    contextMenu.classList.add("hidden");
  });

  // 全局点击关闭菜单
  window.addEventListener("click", () => {
    menuContainer.classList.add("hidden");
    contextMenu.classList.add("hidden");
  });
}
