import { invoke } from "@tauri-apps/api/core";
import { showDeleteConfirmDialog, showToast } from "./save-dialog";

export interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  modified_ms?: number;
  children?: FileItem[];
}

export interface FileTreeOptions {
  workspaceRoot?: string;
  activeFilePath?: string | null;
  sortBy?: "name" | "modified";
  onFileSelect: (path: string) => void;
  onRefresh?: () => void;
  onFileRenamed?: (oldPath: string, newPath: string) => void;
  onFileDeleted?: (path: string) => void;
}

const collapsedPaths = new Set<string>();
let activeContextMenu: HTMLElement | null = null;
let latestTreeOptions: FileTreeOptions | null = null;
let currentSortBy: "name" | "modified" =
  (localStorage.getItem("quilla_tree_sort") as "name" | "modified") || "name";

export function getTreeSortMode(): "name" | "modified" {
  return currentSortBy;
}

export function toggleTreeSortMode(): "name" | "modified" {
  currentSortBy = currentSortBy === "name" ? "modified" : "name";
  localStorage.setItem("quilla_tree_sort", currentSortBy);
  return currentSortBy;
}

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

const ICON_NEW_FILE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>`;
const ICON_NEW_FOLDER = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>`;
const ICON_NEW_WIN = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line></svg>`;
const ICON_RENAME = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
const ICON_DELETE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
const ICON_EXPLORER = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;
const ICON_SORT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="6" x2="13" y2="6"></line><line x1="4" y1="12" x2="11" y2="12"></line><line x1="4" y1="18" x2="11" y2="18"></line><polyline points="15 15 18 18 21 15"></polyline><line x1="18" y1="6" x2="18" y2="18"></line></svg>`;

function sortFileItems(items: FileItem[], mode: "name" | "modified"): FileItem[] {
  const copy = [...items];
  copy.sort((a, b) => {
    if (a.is_dir !== b.is_dir) {
      return a.is_dir ? -1 : 1;
    }
    if (mode === "modified" && (a.modified_ms || 0) !== (b.modified_ms || 0)) {
      return (b.modified_ms || 0) - (a.modified_ms || 0);
    }
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return copy.map((item) =>
    item.children ? { ...item, children: sortFileItems(item.children, mode) } : item
  );
}

/**
 * 在文件树指定目录容器中启动原位内联输入（新建文件 / 新建文件夹）
 */
export function triggerInlineCreateInTree(
  mountContainer: HTMLElement | null,
  isFolder: boolean,
  targetDir?: string,
  depth: number = 0
) {
  if (!mountContainer || !latestTreeOptions) return;
  const options = latestTreeOptions;
  const dir = targetDir || options.workspaceRoot;
  if (!dir) return;

  // 移除整个文件树中已有的临时输入行
  document.querySelectorAll(".tree-inline-create-row").forEach((el) => el.remove());

  const row = document.createElement("div");
  row.className = "tree-item tree-inline-create-row";
  row.style.paddingLeft = `${depth * 14 + 6}px`;

  const spacer = document.createElement("span");
  spacer.className = "tree-spacer";

  const icon = document.createElement("span");
  icon.className = "tree-icon";
  icon.innerHTML = isFolder ? SVG_FOLDER_CLOSED : SVG_FILE;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "tree-inline-input";
  input.value = isFolder ? "新建文件夹" : "Untitled.md";
  input.spellcheck = false;

  row.appendChild(spacer);
  row.appendChild(icon);
  row.appendChild(input);

  const emptyHint = mountContainer.querySelector(".tree-empty-hint");
  if (emptyHint) emptyHint.remove();

  mountContainer.prepend(row);
  input.focus();
  if (!isFolder && input.value.endsWith(".md")) {
    input.setSelectionRange(0, input.value.length - 3);
  } else {
    input.select();
  }

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const rawName = input.value.trim();
    row.remove();
    if (!rawName) {
      options.onRefresh?.();
      return;
    }
    let finalName = rawName;
    if (!isFolder && !finalName.includes(".")) {
      finalName += ".md";
    }
    const sep = dir.includes("\\") ? "\\" : "/";
    const fullPath = `${dir}${sep}${finalName}`;
    try {
      if (isFolder) {
        await invoke("create_folder", { path: fullPath });
        options.onRefresh?.();
        showToast(`已创建文件夹 ${finalName}`, "success");
      } else {
        await invoke("create_file", { path: fullPath });
        options.onRefresh?.();
        options.onFileSelect(fullPath);
      }
    } catch (err) {
      showToast(`创建失败: ${err}`, "error");
      options.onRefresh?.();
    }
  };

  const cancel = () => {
    if (committed) return;
    committed = true;
    row.remove();
    options.onRefresh?.();
  };

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => commit(), 80);
  });
}

/**
 * 原位内联重命名指定文件树节点
 */
function startInlineRename(rowEl: HTMLElement, item: FileItem, options: FileTreeOptions) {
  const labelEl = rowEl.querySelector(".tree-label") as HTMLElement | null;
  if (!labelEl) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "tree-inline-input";
  input.value = item.name;
  input.spellcheck = false;

  labelEl.style.display = "none";
  rowEl.appendChild(input);
  input.focus();

  const dotIdx = item.name.lastIndexOf(".");
  if (!item.is_dir && dotIdx > 0) {
    input.setSelectionRange(0, dotIdx);
  } else {
    input.select();
  }

  let finished = false;
  const finishRename = async (save: boolean) => {
    if (finished) return;
    finished = true;
    const newName = input.value.trim();
    input.remove();
    labelEl.style.display = "";

    if (!save || !newName || newName === item.name) return;

    const sep = item.path.includes("\\") ? "\\" : "/";
    const parentDir = item.path.replace(/[\\/][^\\/]+$/, "");
    const newPath = `${parentDir}${sep}${newName}`;
    try {
      await invoke("rename_path", { oldPath: item.path, newPath });
      options.onFileRenamed?.(item.path, newPath);
      options.onRefresh?.();
      showToast(`已重命名为 ${newName}`, "success");
    } catch (err) {
      showToast(`重命名失败: ${err}`, "error");
    }
  };

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finishRename(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishRename(false);
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => finishRename(true), 80);
  });
}

export function renderFileTree(
  container: HTMLElement,
  items: FileItem[],
  optionsOrCb: FileTreeOptions | ((path: string) => void)
) {
  const options: FileTreeOptions =
    typeof optionsOrCb === "function" ? { onFileSelect: optionsOrCb } : optionsOrCb;
  latestTreeOptions = options;

  container.innerHTML = "";

  const sortedItems = sortFileItems(items, options.sortBy || currentSortBy);

  if (sortedItems.length === 0) {
    container.innerHTML = `<div class="tree-empty-hint" style="padding: 12px; color: var(--control-text-color); font-size: 12px; text-align: center;">此文件夹为空</div>`;
  }

  container.oncontextmenu = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".tree-item")) return;
    e.preventDefault();
    e.stopPropagation();
    showTreeContextMenu(e.clientX, e.clientY, null, null, container, options, 0);
  };

  function createNode(item: FileItem, depth: number, parentMount: HTMLElement): HTMLElement {
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

      const childContainer = document.createElement("div");
      childContainer.className = "tree-children";
      if (isCollapsed) {
        childContainer.style.display = "none";
      }

      if (item.children && item.children.length > 0) {
        item.children.forEach((child) => {
          childContainer.appendChild(createNode(child, depth + 1, childContainer));
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

      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFolder();
      });

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFolder();
      });

      row.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        showTreeContextMenu(e.clientX, e.clientY, item, row, childContainer, options, depth + 1);
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

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        options.onFileSelect(item.path);
      });

      // 修复 BUG-05：在子文件夹内的文件上右键时，传入其直接父级容器 parentMount，使内联新建输入框精准出现在当前同级目录下
      row.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        showTreeContextMenu(e.clientX, e.clientY, item, row, parentMount, options, depth);
      });

      wrapper.appendChild(row);
    }

    return wrapper;
  }

  sortedItems.forEach((item) => {
    container.appendChild(createNode(item, 0, container));
  });
}

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
  rowEl: HTMLElement | null,
  mountContainer: HTMLElement,
  options: FileTreeOptions,
  depth: number = 0
) {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "ty-dropdown-menu file-tree-context-menu";
  menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 280)}px`;

  const targetDir = item
    ? item.is_dir
      ? item.path
      : item.path.replace(/[\\/][^\\/]+$/, "")
    : options.workspaceRoot || ".";

  const addMenuItem = (iconSvg: string, label: string, onClick: () => void, danger = false) => {
    const itemEl = document.createElement("div");
    itemEl.className = `menu-item ${danger ? "danger-item" : ""}`;
    itemEl.innerHTML = `<div class="menu-item-left"><span class="m-icon">${iconSvg}</span><span>${label}</span></div>`;
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

  // 1. 原位新建 Markdown 文件
  addMenuItem(ICON_NEW_FILE, "新建文件", () => {
    if (item?.is_dir) {
      collapsedPaths.delete(item.path);
      mountContainer.style.display = "block";
    }
    triggerInlineCreateInTree(mountContainer, false, targetDir, depth);
  });

  // 2. 原位新建文件夹
  addMenuItem(ICON_NEW_FOLDER, "新建文件夹", () => {
    if (item?.is_dir) {
      collapsedPaths.delete(item.path);
      mountContainer.style.display = "block";
    }
    triggerInlineCreateInTree(mountContainer, true, targetDir, depth);
  });

  addDivider();

  // 2.5 切换排序方式 (按名称 / 按修改时间)
  const sortLabel =
    currentSortBy === "name" ? "排序：切换为按修改时间" : "排序：切换为按名称 A-Z";
  addMenuItem(ICON_SORT, sortLabel, () => {
    const nextSort = toggleTreeSortMode();
    options.onRefresh?.();
    showToast(
      nextSort === "modified" ? "已切换为按最近修改时间排序" : "已切换为按文件名称排序",
      "info"
    );
  });

  if (item && rowEl) {
    addDivider();

    if (!item.is_dir) {
      addMenuItem(ICON_NEW_WIN, "在新窗口中打开", async () => {
        try {
          await invoke("create_new_window", { filePath: item.path });
        } catch (err) {
          showToast(`打开新窗口失败: ${err}`, "error");
        }
      });
      addDivider();
    }

    // 3. 原位内联重命名
    addMenuItem(ICON_RENAME, "重命名", () => {
      startInlineRename(rowEl, item, options);
    });

    // 4. 非阻塞确认删除
    addMenuItem(
      ICON_DELETE,
      "删除",
      async () => {
        const ok = await showDeleteConfirmDialog(item.name);
        if (!ok) return;
        try {
          await invoke("delete_path", { path: item.path });
          options.onFileDeleted?.(item.path);
          options.onRefresh?.();
          showToast(`已删除 ${item.name}`, "info");
        } catch (err) {
          showToast(`删除失败: ${err}`, "error");
        }
      },
      true
    );

    addDivider();

    // 5. 在文件资源管理器中定位
    addMenuItem(ICON_EXPLORER, "在文件资源管理器中显示", async () => {
      try {
        await invoke("reveal_in_explorer", { path: item.path });
      } catch (err) {
        showToast(`无法打开资源管理器: ${err}`, "error");
      }
    });
  }

  document.body.appendChild(menu);
  activeContextMenu = menu;
}
