import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const SVG_MAXIMIZE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>`;
const SVG_RESTORE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="7" width="14" height="14" rx="1.8" ry="1.8"></rect><path d="M9 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"></path></svg>`;

/**
 * 沉浸式标题栏控制器：
 * 支持原生窗口最小化、最大化/还原图标动态同步、双击标题栏最大化还原、系统级关闭事件拦截及置顶锁定
 */
export function initTitlebar(callbacks?: { onClose?: () => void }) {
  const titlebar = document.getElementById("top-titlebar");
  const pinBtn = document.getElementById("w-pin");
  const minBtn = document.getElementById("w-min");
  const maxBtn = document.getElementById("w-max");
  const closeBtn = document.getElementById("w-close");

  let isAlwaysOnTop = false;

  const syncMaximizeIcon = (isMaximized: boolean) => {
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
