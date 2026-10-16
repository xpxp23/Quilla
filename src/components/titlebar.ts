import { invoke } from "@tauri-apps/api/core";

/**
 * 沉浸式标题栏控制器：
 * 支持原生窗口最小化、最大化、双击标题栏最大化还原、关闭、置顶锁定及标题显示
 */
export function initTitlebar(callbacks?: { onClose?: () => void }) {
  const titlebar = document.getElementById("top-titlebar");
  const pinBtn = document.getElementById("w-pin");
  const minBtn = document.getElementById("w-min");
  const maxBtn = document.getElementById("w-max");
  const closeBtn = document.getElementById("w-close");

  let isAlwaysOnTop = false;

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
      await invoke("window_toggle_maximize");
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
