import { invoke } from "@tauri-apps/api/core";

/**
 * 沉浸式标题栏控制器：
 * 支持原生窗口最小化、最大化、关闭、置顶锁定及标题显示
 */
export function initTitlebar(callbacks?: { onClose?: () => void }) {
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

  maxBtn?.addEventListener("click", async () => {
    try {
      await invoke("window_toggle_maximize");
    } catch (e) {
      console.error("最大化切换失败:", e);
    }
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
