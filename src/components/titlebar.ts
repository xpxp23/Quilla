import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const SVG_MAXIMIZE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>`;
const SVG_RESTORE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="7" width="14" height="14" rx="1.8" ry="1.8"></rect><path d="M9 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"></path></svg>`;

const RESIZE_DIRECTIONS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

function isLinuxDesktop(): boolean {
  if (typeof navigator === "undefined") return false;
  return /linux/i.test(navigator.userAgent) && !/android/i.test(navigator.userAgent);
}

/**
 * 仅在 Linux (WebKitGTK) 下注入无边框窗口八向边缘拉伸热区：
 * - Windows / macOS 使用系统原生边框与 Tauri 原生窗口机制，彻底消除顶部 4px 热区遮挡标题栏导致的拖动假死；
 * - 在 Linux 下先绑定释放监听器再 await 窗口矩形，并监听 blur / pointercancel 防止 mousemove 残留死循环。
 */
function ensureFramelessResizeHandles() {
  if (typeof document === "undefined" || !isLinuxDesktop()) return;
  if (document.getElementById("quilla-window-resize-layer")) return;

  const layer = document.createElement("div");
  layer.id = "quilla-window-resize-layer";
  layer.setAttribute("aria-hidden", "true");

  for (const dir of RESIZE_DIRECTIONS) {
    const handle = document.createElement("div");
    handle.className = `quilla-resize-handle dir-${dir}`;
    handle.dataset.resizeDir = dir;
    handle.addEventListener("mousedown", async (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      let aborted = false;
      let moveHandler: ((ev: MouseEvent) => void) | null = null;
      const cleanup = () => {
        aborted = true;
        if (moveHandler) {
          window.removeEventListener("mousemove", moveHandler);
          moveHandler = null;
        }
        window.removeEventListener("mouseup", cleanup);
        window.removeEventListener("blur", cleanup);
      };

      // 先注册释放与失焦守卫，杜绝 await 期间松开鼠标造成监听器永久泄漏
      window.addEventListener("mouseup", cleanup);
      window.addEventListener("blur", cleanup);

      const startScreenX = e.screenX;
      const startScreenY = e.screenY;
      let startRect: [number, number, number, number] | null = null;
      try {
        startRect = await invoke<[number, number, number, number]>("get_window_outer_rect");
      } catch {
        cleanup();
        return;
      }
      if (!startRect || aborted) {
        cleanup();
        return;
      }

      const [initX, initY, initW, initH] = startRect;
      const dpr = window.devicePixelRatio || 1;
      let rafPending = false;

      moveHandler = (moveEv: MouseEvent) => {
        if (aborted || rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          if (aborted) return;
          const dx = Math.round((moveEv.screenX - startScreenX) * dpr);
          const dy = Math.round((moveEv.screenY - startScreenY) * dpr);

          let newX = initX;
          let newY = initY;
          let newW = initW;
          let newH = initH;
          const minW = Math.round(640 * dpr);
          const minH = Math.round(480 * dpr);

          if (dir.includes("e")) {
            newW = Math.max(minW, initW + dx);
          }
          if (dir.includes("s")) {
            newH = Math.max(minH, initH + dy);
          }
          if (dir.includes("w")) {
            const candidateW = initW - dx;
            if (candidateW >= minW) {
              newW = candidateW;
              newX = initX + dx;
            }
          }
          if (dir.includes("n")) {
            const candidateH = initH - dy;
            if (candidateH >= minH) {
              newH = candidateH;
              newY = initY + dy;
            }
          }

          invoke("set_window_outer_rect", {
            x: newX,
            y: newY,
            width: newW,
            height: newH,
          }).catch(() => {});
        });
      };

      window.addEventListener("mousemove", moveHandler);
    });
    layer.appendChild(handle);
  }

  document.body.appendChild(layer);
}

/**
 * 沉浸式标题栏控制器 (v0.15.0 双平台防假死重构)：
 * - Windows / macOS：仅使用 Tauri 原生 `data-tauri-drag-region`，不再叠加 CSS `-webkit-app-region: drag`
 *   和手动 `window_start_dragging` IPC，彻底根治 Windows 拖动窗口重入死锁与数秒假死；
 * - Linux / 银河麒麟：保留原生 `window_start_dragging` 与带失焦保护的边缘拉伸热区。
 */
export function initTitlebar(callbacks?: { onClose?: () => void }) {
  const titlebar = document.getElementById("top-titlebar");
  const tabsBar = document.getElementById("doc-tabs-bar");
  const pinBtn = document.getElementById("w-pin");
  const minBtn = document.getElementById("w-min");
  const maxBtn = document.getElementById("w-max");
  const closeBtn = document.getElementById("w-close");

  let isAlwaysOnTop = false;
  const linuxPlatform = isLinuxDesktop();

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

  listen("window-close-requested", () => {
    if (callbacks?.onClose) {
      callbacks.onClose();
    } else {
      invoke("window_close").catch(() => {});
    }
  }).catch(() => {});

  pinBtn?.addEventListener("click", async () => {
    const nextState = !isAlwaysOnTop;
    try {
      await invoke("window_set_always_on_top", { onTop: nextState });
      isAlwaysOnTop = nextState;
      pinBtn.classList.toggle("pinned", isAlwaysOnTop);
      pinBtn.title = isAlwaysOnTop ? "取消置顶 (已开启置顶)" : "窗口置顶";
    } catch (e) {
      console.error("置顶切换失败:", e);
    }
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

  // 仅在 Linux (WebKitGTK) 下手动触发 window_start_dragging；Windows 下交由 Tauri 原生 data-tauri-drag-region 处理
  if (linuxPlatform) {
    titlebar?.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0 || e.detail > 1) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("#w-traffic-lights, #w-menu-btn, button, input, select, a")) {
        return;
      }
      invoke("window_start_dragging").catch(() => {});
    });

    tabsBar?.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0 || e.detail > 1) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".doc-tab-item, .doc-tabs-actions, button, input")) {
        return;
      }
      invoke("window_start_dragging").catch(() => {});
    });
  }

  // 双击标题栏空白处切换最大化/还原
  titlebar?.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("#w-traffic-lights, #w-menu-btn, button")) return;
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
