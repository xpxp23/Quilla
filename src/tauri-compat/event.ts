/**
 * Quilla (羽墨) v0.14.0 — 跨版本 Tauri Event 事件总线兼容桥接层 (Tauri v1 & Tauri v2)
 */
import { invoke } from "./core";

export interface Event<T> {
  event: string;
  windowLabel?: string;
  id: number;
  payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;
export type UnlistenFn = () => void;

function registerEventCallback(
  callback: (event: any) => void,
  once = false
): number {
  const win = window as any;
  const array = new Uint32Array(1);
  window.crypto.getRandomValues(array);
  const identifier = array[0];
  const prop = `_${identifier}`;

  Object.defineProperty(win, prop, {
    value: (result: any) => {
      if (once) {
        Reflect.deleteProperty(win, prop);
      }
      return callback(result);
    },
    writable: false,
    configurable: true,
  });

  return identifier;
}

export async function listen<T = any>(
  event: string,
  handler: EventCallback<T>
): Promise<UnlistenFn> {
  if (typeof window === "undefined") {
    return () => {};
  }

  const win = window as any;

  // 1. 优先使用 Tauri v1 withGlobalTauri 注入的 window.__TAURI__.event.listen
  if (typeof win.__TAURI__?.event?.listen === "function") {
    return win.__TAURI__.event.listen(event, handler);
  }

  // 2. 底层 Tauri v1 __tauriModule: "Event" IPC 协议兜底
  const handlerId = registerEventCallback(handler, false);
  try {
    const eventId = await invoke<number>("tauri", {
      __tauriModule: "Event",
      message: {
        cmd: "listen",
        event,
        windowLabel: null,
        handler: handlerId,
      },
    });
    return async () => {
      Reflect.deleteProperty(win, `_${handlerId}`);
      await invoke("tauri", {
        __tauriModule: "Event",
        message: {
          cmd: "unlisten",
          event,
          eventId,
        },
      }).catch(() => {});
    };
  } catch {
    return () => {
      Reflect.deleteProperty(win, `_${handlerId}`);
    };
  }
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  if (typeof window === "undefined") return;
  const win = window as any;

  if (typeof win.__TAURI__?.event?.emit === "function") {
    return win.__TAURI__.event.emit(event, payload);
  }

  await invoke("tauri", {
    __tauriModule: "Event",
    message: {
      cmd: "emit",
      event,
      windowLabel: null,
      payload,
    },
  });
}
