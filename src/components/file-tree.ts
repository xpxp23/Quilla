import { invoke } from "@tauri-apps/api/core";

export interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileItem[];
}

export interface FileTreeOptions {
  workspaceRoot?: string;
  activeFilePath?: string | null;
  onFileSelect: (path: string) => void;
  onRefresh?: () => void;
  onFileRenamed?: (oldPath: string, newPath: string) => void;
  onFileDeleted?: (path: string) => void;
}

// 记录所有已折叠的目录路径，确保重绘时不丢失折叠状态
const collapsedPaths = new Set<string>();

// 全局单例右键上下文菜单
let activeContextMenu: HTMLElement | null = null;

function closeContextMenu() {
  if (activeContextMenu && activeContextMenu.parentNode) {
    activeContextMenu.parentNode.removeChild(activeContextMenu);
  }
  activeContextMenu = null;
}

window.addEventListener("click", () => closeContextMenu());
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeContextMenu();
});

const SVG_CARET = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
const SVG_FOLDER_CLOSED = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
const SVG_FOLDER_OPEN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><path d="M2 10h20"></path></svg>`;
const SVG_FILE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`;

export function renderFileTree(
  container: HTMLElement,
  items: FileItem[],
  optionsOrCb: FileTreeOptions | ((path: string) => void)
) {
  const options: FileTreeOptions =
    typeof optionsOrCb === "function" ? { onFileSelect: optionsOrCb } : optionsOrCb;

  container.innerHTML = "";

  if (items.length === 0) {
    container.innerHTML = `<div style="padding: 12px; color: var(--control-text-color); font-size: 12px; text-align: center;">此文件夹为空</div>`;
    return;
  }

  // 绑定工作区空白区域右键菜单（支持根目录新建）
  container.oncontextmenu = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".tree-item")) return;
    e.preventDefault();
    e.stopPropagation();
    showTreeContextMenu(e.clientX, e.clientY, null, options);
  };

  function createNode(item: FileItem, depth: number): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "tree-node-wrapper";

    const row = document.createElement("div");
    row.className = "tree-item";
    row.style.paddingLeft = `${depth * 14 + 6}px`;

    if (item.is_dir) {
      const isCollapsed = collapsedPaths.has(item.path);

      const toggle = document.createElement("span");
      toggle.className = `tree-toggle ${isCollapsed ? "" : "expanded"}`;
      toggle.innerHTML = SVG_CARET;

      const icon = document.createElement("span");
      icon.className = "tree-icon";
      icon.innerHTML = isCollapsed ? SVG_FOLDER_CLOSED : SVG_FOLDER_OPEN;

      const label = document.createElement("span");
      label.className = "tree-label";
      label.textContent = item.name;
      label.title = item.name;

      row.appendChild(toggle);
      row.appendChild(icon);
      row.appendChild(label);

      // 子节点容器
      const childContainer = document.createElement("div");
      childContainer.className = "tree-children";
      if (isCollapsed) {
        childContainer.style.display = "none";
      }

      if (item.children && item.children.length > 0) {
        item.children.forEach((child) => {
          childContainer.appendChild(createNode(child, depth + 1));
        });
      }

      const toggleFolder = () => {
        if (collapsedPaths.has(item.path)) {
          collapsedPaths.delete(item.path);
          toggle.classList.add("expanded");
          icon.innerHTML = SVG_FOLDER_OPEN;
          childContainer.style.display = "block";
        } else {
          collapsedPaths.add(item.path);
          toggle.classList.remove("expanded");
          icon.innerHTML = SVG_FOLDER_CLOSED;
          childContainer.style.display = "none";
        }
      };

      // 单击文件夹或折叠按钮展开/收起
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFolder();
      });

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFolder();
      });

      // 文件夹右键
      row.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        showTreeContextMenu(e.clientX, e.clientY, item, options);
      });

      wrapper.appendChild(row);
      wrapper.appendChild(childContainer);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "tree-spacer";

      const icon = document.createElement("span");
      icon.className = "tree-icon";
      icon.innerHTML = SVG_FILE;

      const label = document.createElement("span");
      label.className = "tree-label";
      label.textContent = item.name;
      label.title = item.name;

      row.dataset.path = item.path;
      const normalizedPath = item.path.replace(/\\/g, "/").toLowerCase();
      const normalizedActive = (options.activeFilePath || "").replace(/\\/g, "/").toLowerCase();
      if (normalizedActive && normalizedActive === normalizedPath) {
        row.classList.add("active");
      }

      row.appendChild(spacer);
      row.appendChild(icon);
      row.appendChild(label);

      // 单击文件打开（由 loadFile 异步成功后统一同步激活状态，防止取消保存或竞态时高亮串线）
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        options.onFileSelect(item.path);
      });

      // 文件右键
      row.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        showTreeContextMenu(e.clientX, e.clientY, item, options);
      });

      wrapper.appendChild(row);
    }

    return wrapper;
  }

  items.forEach((item) => {
    container.appendChild(createNode(item, 0));
  });
}

/**
 * 根据规范化文件全路径精准同步文件树高亮，彻底杜绝重名文件误激活与串线
 */
export function syncActiveTreeItem(
  container: HTMLElement | null,
  activeFilePath: string | null
) {
  if (!container) return;
  const normalizedActive = (activeFilePath || "").replace(/\\/g, "/").toLowerCase();
  const treeItems = container.querySelectorAll<HTMLElement>(".tree-item");
  treeItems.forEach((row) => {
    const rowPath = (row.dataset.path || "").replace(/\\/g, "/").toLowerCase();
    if (normalizedActive && rowPath && rowPath === normalizedActive) {
      row.classList.add("active");
    } else {
      row.classList.remove("active");
    }
  });
}

function showTreeContextMenu(
  x: number,
  y: number,
  item: FileItem | null,
  options: FileTreeOptions
) {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "ty-dropdown-menu file-tree-context-menu";
  menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 220)}px`;

  // 计算新建目标的基准目录
  const targetDir = item
    ? item.is_dir
      ? item.path
      : item.path.replace(/[\\/][^\\/]+$/, "")
    : options.workspaceRoot || ".";

  const addMenuItem = (icon: string, label: string, onClick: () => void) => {
    const itemEl = document.createElement("div");
    itemEl.className = "menu-item";
    itemEl.innerHTML = `<span class="m-icon">${icon}</span><span>${label}</span>`;
    itemEl.addEventListener("click", (e) => {
      e.stopPropagation();
      closeContextMenu();
      onClick();
    });
    menu.appendChild(itemEl);
  };

  const addDivider = () => {
    const div = document.createElement("div");
    div.className = "menu-divider";
    menu.appendChild(div);
  };

  // 1. 新建 Markdown 文件
  addMenuItem("📄", "新建文件", async () => {
    const rawName = prompt("请输入新建文件名 (例如: note.md):", "untitled.md");
    if (!rawName || !rawName.trim()) return;
    let fileName = rawName.trim();
    if (!fileName.includes(".")) {
      fileName += ".md";
    }
    const sep = targetDir.includes("\\") ? "\\" : "/";
    const fullPath = `${targetDir}${sep}${fileName}`;
    try {
      await invoke("create_file", { path: fullPath });
      if (options.onRefresh) options.onRefresh();
      options.onFileSelect(fullPath);
    } catch (err) {
      alert(`新建文件失败: ${err}`);
    }
  });

  // 2. 新建文件夹
  addMenuItem("📁", "新建文件夹", async () => {
    const rawName = prompt("请输入文件夹名称:", "新文件夹");
    if (!rawName || !rawName.trim()) return;
    const folderName = rawName.trim();
    const sep = targetDir.includes("\\") ? "\\" : "/";
    const fullPath = `${targetDir}${sep}${folderName}`;
    try {
      await invoke("create_folder", { path: fullPath });
      if (options.onRefresh) options.onRefresh();
    } catch (err) {
      alert(`创建文件夹失败: ${err}`);
    }
  });

  if (item) {
    addDivider();

    if (!item.is_dir) {
      // 在新窗口中打开 (对齐 Typora 侧边栏文件右键)
      addMenuItem("🗖", "在新窗口中打开", async () => {
        try {
          await invoke("create_new_window", { filePath: item.path });
        } catch (err) {
          alert(`打开新窗口失败: ${err}`);
        }
      });
      addDivider();
    }

    // 3. 重命名
    addMenuItem("✏️", "重命名", async () => {
      const newName = prompt("请输入新的名称:", item.name);
      if (!newName || !newName.trim() || newName.trim() === item.name) return;
      const sep = item.path.includes("\\") ? "\\" : "/";
      const parentDir = item.path.replace(/[\\/][^\\/]+$/, "");
      const newPath = `${parentDir}${sep}${newName.trim()}`;
      try {
        await invoke("rename_path", { oldPath: item.path, newPath });
        options.onFileRenamed?.(item.path, newPath);
        if (options.onRefresh) options.onRefresh();
      } catch (err) {
        alert(`重命名失败: ${err}`);
      }
    });

    // 4. 删除
    addMenuItem("🗑️", "删除", async () => {
      const ok = confirm(`确定要永久删除 "${item.name}" 吗？此操作无法撤销。`);
      if (!ok) return;
      try {
        await invoke("delete_path", { path: item.path });
        options.onFileDeleted?.(item.path);
        if (options.onRefresh) options.onRefresh();
      } catch (err) {
        alert(`删除失败: ${err}`);
      }
    });

    addDivider();

    // 5. 在文件资源管理器中定位
    addMenuItem("📂", "在文件资源管理器中显示", async () => {
      try {
        await invoke("reveal_in_explorer", { path: item.path });
      } catch (err) {
        alert(`无法打开资源管理器: ${err}`);
      }
    });
  }

  document.body.appendChild(menu);
  activeContextMenu = menu;
}
