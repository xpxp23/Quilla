import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { openShortcutGuide } from "./shortcut-guide";
import { getRecentFiles, clearRecentFiles } from "./quick-open";
import { handleOpenLink } from "../editor/index";
import { smartToggleFormat } from "../editor/extensions/formatting-keymap";
import { insertTableCommand } from "../editor/extensions/table-editor";
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

const SVG = {
  file: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
  window: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line></svg>`,
  folderOpen: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
  clock: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
  save: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>`,
  saveAs: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  print: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>`,
  globe: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
  undo: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`,
  redo: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`,
  search: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
  keyboard: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect><line x1="6" y1="8" x2="6.01" y2="8"></line><line x1="10" y1="8" x2="10.01" y2="8"></line><line x1="14" y1="8" x2="14.01" y2="8"></line><line x1="18" y1="8" x2="18.01" y2="8"></line><line x1="8" y1="16" x2="16" y2="16"></line></svg>`,
  trash: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  copy: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
  scissors: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg>`,
  clipboard: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>`,
  link: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`,
  table: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line></svg>`,
  code: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`,
};

/**
 * 初始化左上角汉堡弹出菜单与右键上下文菜单 (统一采用单色线性 SVG 图标)
 */
export function initMenus(view: EditorView, actions: MenuActions) {
  const menuContainer = document.createElement("div");
  menuContainer.id = "app-hamburger-menu";
  menuContainer.className = "ty-dropdown-menu hidden";
  menuContainer.innerHTML = `
    <div class="menu-section">
      <div class="menu-item" data-action="new">
        <div class="menu-item-left"><span class="m-icon">${SVG.file}</span><span>新建</span></div>
        <span class="shortcut">Ctrl+N</span>
      </div>
      <div class="menu-item" data-action="new-window">
        <div class="menu-item-left"><span class="m-icon">${SVG.window}</span><span>新建窗口</span></div>
        <span class="shortcut">Ctrl+Shift+N</span>
      </div>
      <div class="menu-item" data-action="open-file">
        <div class="menu-item-left"><span class="m-icon">${SVG.folderOpen}</span><span>打开文件...</span></div>
        <span class="shortcut">Ctrl+O</span>
      </div>
      <div class="menu-item" data-action="open-folder">
        <div class="menu-item-left"><span class="m-icon">${SVG.folderOpen}</span><span>打开文件夹...</span></div>
      </div>
      <div class="menu-item has-submenu" id="menu-recent-files">
        <div class="menu-item-left"><span class="m-icon">${SVG.clock}</span><span>打开最近文件</span></div>
        <span class="submenu-arrow">›</span>
        <div class="ty-submenu" id="submenu-recent-container"></div>
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item" data-action="save">
        <div class="menu-item-left"><span class="m-icon">${SVG.save}</span><span>保存</span></div>
        <span class="shortcut">Ctrl+S</span>
      </div>
      <div class="menu-item" data-action="save-as">
        <div class="menu-item-left"><span class="m-icon">${SVG.saveAs}</span><span>另存为...</span></div>
        <span class="shortcut">Ctrl+Shift+S</span>
      </div>
      <div class="menu-item" data-action="print">
        <div class="menu-item-left"><span class="m-icon">${SVG.print}</span><span>打印 / 导出为 PDF...</span></div>
        <span class="shortcut">Ctrl+Shift+P</span>
      </div>
      <div class="menu-item" data-action="export-html">
        <div class="menu-item-left"><span class="m-icon">${SVG.globe}</span><span>导出为 HTML</span></div>
      </div>
    </div>
    <div class="menu-divider"></div>
    <div class="menu-section">
      <div class="menu-item" data-action="undo">
        <div class="menu-item-left"><span class="m-icon">${SVG.undo}</span><span>撤销</span></div>
        <span class="shortcut">Ctrl+Z</span>
      </div>
      <div class="menu-item" data-action="redo">
        <div class="menu-item-left"><span class="m-icon">${SVG.redo}</span><span>重做</span></div>
        <span class="shortcut">Ctrl+Y</span>
      </div>
      <div class="menu-item" data-action="quick-open">
        <div class="menu-item-left"><span class="m-icon">${SVG.search}</span><span>快速漫游...</span></div>
        <span class="shortcut">Ctrl+P</span>
      </div>
      <div class="menu-item" data-action="shortcut-guide">
        <div class="menu-item-left"><span class="m-icon">${SVG.keyboard}</span><span>快捷键指南</span></div>
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
                  <span class="m-icon">${SVG.file}</span>
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
                  <span class="m-icon">${SVG.trash}</span>
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
          <div class="menu-item" data-action="tbl-add-row-above"><div class="menu-item-left"><span class="m-icon">↑</span><span>上方插入行</span></div></div>
          <div class="menu-item" data-action="tbl-add-row-below"><div class="menu-item-left"><span class="m-icon">↓</span><span>下方插入行</span></div><span class="shortcut">Ctrl+Enter</span></div>
          <div class="menu-item" data-action="tbl-add-col-left"><div class="menu-item-left"><span class="m-icon">←</span><span>左侧插入列</span></div></div>
          <div class="menu-item" data-action="tbl-add-col-right"><div class="menu-item-left"><span class="m-icon">→</span><span>右侧插入列</span></div></div>
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
          <div class="menu-item danger-item" data-action="tbl-del-row"><div class="menu-item-left"><span class="m-icon">${SVG.trash}</span><span>删除当前行</span></div></div>
          <div class="menu-item danger-item" data-action="tbl-del-col"><div class="menu-item-left"><span class="m-icon">${SVG.trash}</span><span>删除当前列</span></div></div>
          <div class="menu-item danger-item" data-action="tbl-del-table"><div class="menu-item-left"><span class="m-icon">${SVG.trash}</span><span>删除整个表格</span></div></div>
        </div>
      `;
    } else if (imgEl) {
      currentContextTarget = { type: "image", element: imgEl };
      contextMenu.innerHTML = `
        <div class="menu-section">
          <div class="menu-item-group-title">图片尺寸</div>
          <div class="menu-item" data-action="img-size-25"><div class="menu-item-left"><span class="m-icon">25</span><span>缩放至 25%</span></div></div>
          <div class="menu-item" data-action="img-size-50"><div class="menu-item-left"><span class="m-icon">50</span><span>缩放至 50%</span></div></div>
          <div class="menu-item" data-action="img-size-80"><div class="menu-item-left"><span class="m-icon">80</span><span>缩放至 80%</span></div></div>
          <div class="menu-item" data-action="img-size-100"><div class="menu-item-left"><span class="m-icon">100</span><span>原始尺寸 100%</span></div></div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          <div class="menu-item-group-title">排版对齐</div>
          <div class="menu-item" data-action="img-align-left"><div class="menu-item-left"><span class="m-icon">⇤</span><span>居左排版</span></div></div>
          <div class="menu-item" data-action="img-align-center"><div class="menu-item-left"><span class="m-icon">↔</span><span>居中排版</span></div></div>
          <div class="menu-item" data-action="img-align-right"><div class="menu-item-left"><span class="m-icon">⇥</span><span>居右排版</span></div></div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          <div class="menu-item" data-action="img-copy-src"><div class="menu-item-left"><span class="m-icon">${SVG.copy}</span><span>复制图片地址</span></div></div>
          <div class="menu-item danger-item" data-action="img-delete"><div class="menu-item-left"><span class="m-icon">${SVG.trash}</span><span>删除图片</span></div></div>
        </div>
      `;
    } else if (linkEl) {
      currentContextTarget = { type: "link", element: linkEl };
      const href = linkEl.dataset.href || "";
      contextMenu.innerHTML = `
        <div class="menu-section">
          <div class="menu-item" data-action="link-open"><div class="menu-item-left"><span class="m-icon">${SVG.globe}</span><span>在浏览器中打开</span></div></div>
          <div class="menu-item" data-action="link-copy" data-url="${href}"><div class="menu-item-left"><span class="m-icon">${SVG.copy}</span><span>复制链接地址</span></div></div>
        </div>
      `;
    } else {
      currentContextTarget = { type: "text", element: target };
      contextMenu.innerHTML = `
        <div class="menu-section">
          <div class="menu-item" data-action="cut">
            <div class="menu-item-left"><span class="m-icon">${SVG.scissors}</span><span>剪切</span></div>
            <span class="shortcut">Ctrl+X</span>
          </div>
          <div class="menu-item" data-action="copy">
            <div class="menu-item-left"><span class="m-icon">${SVG.copy}</span><span>复制</span></div>
            <span class="shortcut">Ctrl+C</span>
          </div>
          <div class="menu-item" data-action="paste">
            <div class="menu-item-left"><span class="m-icon">${SVG.clipboard}</span><span>智能粘贴</span></div>
            <span class="shortcut">Ctrl+V</span>
          </div>
          <div class="menu-item" data-action="paste-plain">
            <div class="menu-item-left"><span class="m-icon">${SVG.file}</span><span>纯文本粘贴</span></div>
            <span class="shortcut">Ctrl+Shift+V</span>
          </div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          <div class="menu-item" data-action="bold">
            <div class="menu-item-left"><span class="m-icon"><strong>B</strong></span><span>加粗</span></div>
            <span class="shortcut">Ctrl+B</span>
          </div>
          <div class="menu-item" data-action="italic">
            <div class="menu-item-left"><span class="m-icon"><em>I</em></span><span>斜体</span></div>
            <span class="shortcut">Ctrl+I</span>
          </div>
          <div class="menu-item" data-action="highlight">
            <div class="menu-item-left"><span class="m-icon">==</span><span>荧光高亮</span></div>
            <span class="shortcut">Ctrl+Shift+H</span>
          </div>
          <div class="menu-item" data-action="code">
            <div class="menu-item-left"><span class="m-icon">${SVG.code}</span><span>行内代码</span></div>
            <span class="shortcut">Ctrl+\`</span>
          </div>
          <div class="menu-item" data-action="link">
            <div class="menu-item-left"><span class="m-icon">${SVG.link}</span><span>插入链接</span></div>
            <span class="shortcut">Ctrl+K</span>
          </div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          <div class="menu-item" data-action="table">
            <div class="menu-item-left"><span class="m-icon">${SVG.table}</span><span>插入表格</span></div>
            <span class="shortcut">Ctrl+Alt+T</span>
          </div>
          <div class="menu-item" data-action="codeblock">
            <div class="menu-item-left"><span class="m-icon">${SVG.code}</span><span>插入代码块</span></div>
            <span class="shortcut">Ctrl+Shift+K</span>
          </div>
          <div class="menu-item" data-action="mathblock">
            <div class="menu-item-left"><span class="m-icon">∑</span><span>插入公式块</span></div>
            <span class="shortcut">Ctrl+Shift+M</span>
          </div>
        </div>
      `;
    }

    contextMenu.classList.remove("hidden");
    const menuWidth = 220;
    const menuHeight = contextMenu.offsetHeight || 280;
    const posX = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const posY = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
    contextMenu.style.top = `${posY}px`;
    contextMenu.style.left = `${posX}px`;
  });

  contextMenu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(".menu-item") as HTMLElement;
    if (!item) return;
    const act = item.dataset.action;

    if (act?.startsWith("tbl-") && currentContextTarget?.element) {
      const btnAct = act.replace("tbl-", "");
      const tblToolbarBtn = currentContextTarget.element
        .closest(".table-figure, .cm-table-widget, .in-place-edit")
        ?.querySelector(`[data-act="${btnAct}"]`) as HTMLElement | null;
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
        const tag =
          width || align !== "left"
            ? `<img src="${src}"${altAttr}${wAttr}${aAttr} />`
            : `![${alt}](${src})`;
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
            view.dispatch({
              changes: { from, to, insert: txt },
              selection: { anchor: from + txt.length },
            });
          })
          .catch(() => {
            navigator.clipboard.readText().then((txt) => {
              const { from, to } = view.state.selection.main;
              view.dispatch({
                changes: { from, to, insert: txt },
                selection: { anchor: from + txt.length },
              });
            });
          });
      } else {
        navigator.clipboard.readText().then((txt) => {
          const { from, to } = view.state.selection.main;
          view.dispatch({
            changes: { from, to, insert: txt },
            selection: { anchor: from + txt.length },
          });
        });
      }
    } else if (act === "paste-plain") {
      navigator.clipboard.readText().then((txt) => {
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: txt },
          selection: { anchor: from + txt.length },
        });
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
      const txt = view.state.sliceDoc(sel.from, sel.to) || "链接文字";
      const insertStr = `[${txt}](https://)`;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: insertStr },
        selection: { anchor: sel.from + txt.length + 3, head: sel.from + insertStr.length - 1 },
      });
    } else if (act === "table") {
      insertTableCommand(view);
    } else if (act === "codeblock") {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const isEmpty = line.text.trim().length === 0;
      const prefix = isEmpty ? "" : "\n";
      const insertPos = isEmpty ? line.from : line.to;
      const insertStr = `${prefix}\`\`\`\n\n\`\`\`\n`;
      view.dispatch({
        changes: { from: insertPos, to: line.to, insert: insertStr },
        selection: { anchor: insertPos + prefix.length + 4 },
      });
    } else if (act === "mathblock") {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const isEmpty = line.text.trim().length === 0;
      const prefix = isEmpty ? "" : "\n";
      const insertPos = isEmpty ? line.from : line.to;
      const insertStr = `${prefix}$$\n\n$$\n`;
      view.dispatch({
        changes: { from: insertPos, to: line.to, insert: insertStr },
        selection: { anchor: insertPos + prefix.length + 3 },
      });
    }

    contextMenu.classList.add("hidden");
  });

  window.addEventListener("click", () => {
    menuContainer.classList.add("hidden");
    contextMenu.classList.add("hidden");
  });
}
