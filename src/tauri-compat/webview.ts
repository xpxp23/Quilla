/**
 * Quilla (羽墨) v0.14.0 — 跨版本 Tauri Webview 拖拽事件桥接层
 * 将 Tauri v1 的 `tauri://file-drop` / `tauri://file-drop-hover` / `tauri://file-drop-cancelled`
 * 无缝映射为统一的 `onDragDropEvent` 接口，兼容银河麒麟 V10 SP1 (webkit2gtk-4.0)
 */
import { listen, UnlistenFn } from "./event";

export interface DragDropEventPayload {
  type: "over" | "drop" | "leave";
  paths?: string[];
  position?: { x: number; y: number };
}

export function getCurrentWebview() {
  return {
    async onDragDropEvent(
      handler: (event: { payload: DragDropEventPayload }) => void
    ): Promise<UnlistenFn> {
      const win = typeof window !== "undefined" ? (window as any) : null;

      // 若存在 Tauri v1 window.appWindow.onFileDropEvent，直接接入
      if (typeof win?.__TAURI__?.window?.appWindow?.onFileDropEvent === "function") {
        return win.__TAURI__.window.appWindow.onFileDropEvent((ev: any) => {
          const p = ev?.payload;
          if (!p) return;
          if (p.type === "drop") {
            handler({ payload: { type: "drop", paths: p.paths || [] } });
          } else if (p.type === "hover") {
            handler({ payload: { type: "over", paths: p.paths || [] } });
          } else if (p.type === "cancel") {
            handler({ payload: { type: "leave", paths: [] } });
          }
        });
      }

      // 标准 Tauri v1 全局文件拖放事件监听
      const unlistenDrop = await listen<string[]>("tauri://file-drop", (e) => {
        handler({
          payload: {
            type: "drop",
            paths: Array.isArray(e.payload) ? e.payload : [],
          },
        });
      });
      const unlistenHover = await listen<string[]>("tauri://file-drop-hover", (e) => {
        handler({
          payload: {
            type: "over",
            paths: Array.isArray(e.payload) ? e.payload : [],
          },
        });
      });
      const unlistenCancel = await listen("tauri://file-drop-cancelled", () => {
        handler({
          payload: {
            type: "leave",
            paths: [],
          },
        });
      });

      return () => {
        unlistenDrop();
        unlistenHover();
        unlistenCancel();
      };
    },
  };
}
