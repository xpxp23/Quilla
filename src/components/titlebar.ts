import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const SVG_MAXIMIZE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>`;
const SVG_RESTORE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="7" width="14" height="14" rx="1.8" ry="1.8"></rect><path d="M9 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"></path></svg>`;

const RESIZE_DIRECTIONS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

/**
 * 注入无边框窗口八向边缘拉伸热区：
 * 解决银河麒麟 (Kylin OS UKUI) / Linux X11 & Wayland 下 `decorations: false` 窗口无法从四边与四角鼠标拖拽调整大小的问题
 */
function ensureFramelessResizeHandles() {
  if (typeof document === "undefined") return;
  if (document.getElementById("quilla-window-resize-layer")) return;

  const layer = document.createElement("div");
  layer.id = "quilla-window-resize-layer";
  layer.setAttribute("aria-hidden", "true");

  for (const dir of RESIZE_DIRECTIONS) {
    const handle = document.createElement("div");
    handle.className = `quilla-resize-handle dir-${dir}`;
    handle.dataset.resizeDir = dir;
    handle.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      invoke("window_start_resize_dragging", { direction: dir }).catch(() => {});
    });
    layer.appendChild(handle);
  }

  document.body.appendChild(layer);
}

/**
 * 沉浸式标题栏控制器：
 * 支持原生窗口最小化、最大化/还原图标动态同步、双击标题栏最大化还原、系统级关闭事件拦截、置顶锁定，
 * 以及针对银河麒麟 WebKitGTK 的原生 `window_start_dragging` 无边框拖拽与八向边缘缩放支持
 */
export function initTitlebar(callbacks?: { onClose?: () => void }) {
  const titlebar = document.getElementById("top-titlebar");
  const tabsBar = document.getElementById("doc-tabs-bar");
  const pinBtn = document.getElementById("w-pin");
  const minBtn = document.getElementById("w-min");
  const maxBtn = document.getElementById("w-max");
  const closeBtn = document.getElementById("w-close");

  let isAlwaysOnTop = false;

  ensureFramelessResizeHandles();

  const syncMaximizeIcon = (isMaximized: boolean) => {
    document.body?.classList.toggle("window-is-maximized", isMaximized);
    if (!maxBtn) return;
    maxBtn.innerHTML = isMaximized ? SVG_RESTORE : SVG_MAXIMIZE;
    maxBtn.title = isMaximized ? "向下还原" : "最大化";
  };

  invoke<boolean>("window_is_maximized")
    .then((isMax) => syncMaximizeIcon(isMax))
    .catch(() => {});

  listen<boolean>("window-maximized-changed", (event) => {
    syncMaximizeIcon(Boolean(event.payload));
  }).catch(() => {});

  // 监听操作系统级关闭请求 (如 Alt+F4、任务栏关闭窗口)，统一走未保存改动确认弹窗
  listen("window-close-requested", () => {
    if (callbacks?.onClose) {
      callbacks.onClose();
    } else {
      invoke("window_close").catch(() => {});
    }
  }).catch(() => {});

  pinBtn?.addEventListener("click", async () => {
    isAlwaysOnTop = !isAlwaysOnTop;
    try {
      await invoke("window_set_always_on_top", { onTop: isAlwaysOnTop });
    } catch (e) {
      console.error("置顶切换失败:", e);
    }
    pinBtn.classList.toggle("pinned", isAlwaysOnTop);
    pinBtn.title = isAlwaysOnTop ? "取消置顶 (已开启置顶)" : "窗口置顶";
  });

  minBtn?.addEventListener("click", async () => {
    try {
      await invoke("window_minimize");
    } catch (e) {
      console.error("最小化失败:", e);
    }
  });

  const toggleMaximize = async () => {
    try {
      const isMax = await invoke<boolean>("window_toggle_maximize");
      syncMaximizeIcon(isMax);
    } catch (e) {
      console.error("最大化切换失败:", e);
    }
  };

  maxBtn?.addEventListener("click", toggleMaximize);

  // Linux WebKitGTK 兼容：显式绑定左键单击拖拽标题栏（WebKitGTK 不支持 Chromium 专有 -webkit-app-region: drag）
  titlebar?.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button !== 0 || e.detail > 1) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("#w-traffic-lights, #w-menu-btn, button, input, select, a")) {
      return;
    }
    invoke("window_start_dragging").catch(() => {});
  });

  // 允许拖拽多文档标签栏右侧空白区域移动窗口
  tabsBar?.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button !== 0 || e.detail > 1) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(".doc-tab-item, .doc-tabs-actions, button, input")) {
      return;
    }
    invoke("window_start_dragging").catch(() => {});
  });

  // 双击标题栏空白处切换最大化/还原
  titlebar?.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("#w-traffic-lights, #w-menu-btn")) return;
    toggleMaximize();
  });

  closeBtn?.addEventListener("click", async () => {
    if (callbacks?.onClose) {
      callbacks.onClose();
      return;
    }
    try {
      await invoke("window_close");
    } catch (e) {
      console.error("关闭窗口失败:", e);
    }
  });
}

export function updateWindowTitle(fileName: string, isModified: boolean) {
  const titleElem = document.getElementById("title-text");
  const text = `${isModified ? "● " : ""}${fileName} - Quilla`;
  if (titleElem) {
    titleElem.textContent = text;
  }
  document.title = text;
}
