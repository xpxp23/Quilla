/**
 * Quilla (羽墨) v0.15.0 — 跨版本 Tauri Event 事件总线兼容桥接层 (Tauri v1 & Tauri v2)
 * 修复：兜底通道下直接通过 Tauri v1 原始 __tauriModule 协议通信，且不再静默吞掉注册失败异常
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

function sendTauriV1EventModule<T = any>(message: Record<string, unknown>): Promise<T> {
  const win = window as any;
  if (typeof win.__TAURI_IPC__ === "function") {
    return new Promise<T>((resolve, reject) => {
      const callback = registerEventCallback((r) => {
        resolve(r);
        Reflect.deleteProperty(win, `_${error}`);
      }, true);
      const error = registerEventCallback((e) => {
        reject(e);
        Reflect.deleteProperty(win, `_${callback}`);
      }, true);

      win.__TAURI_IPC__({
        cmd: "tauri",
        callback,
        error,
        __tauriModule: "Event",
        message,
      });
    });
  }
  return invoke<T>("tauri", {
    __tauriModule: "Event",
    message,
  });
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

  // 2. 兼容 Tauri v2 事件插件通道
  if (typeof win.__TAURI_INTERNALS__?.invoke === "function") {
    const handlerId = registerEventCallback(handler, false);
    try {
      const eventId = await win.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
        event,
        target: { kind: "Any" },
        handler: handlerId,
      });
      return async () => {
        Reflect.deleteProperty(win, `_${handlerId}`);
        await win.__TAURI_INTERNALS__.invoke("plugin:event|unlisten", {
          event,
          eventId,
        }).catch(() => {});
      };
    } catch (err) {
      Reflect.deleteProperty(win, `_${handlerId}`);
      console.warn(`[Quilla IPC] Tauri v2 listen("${event}") 失败:`, err);
      return () => {};
    }
  }

  // 3. 底层 Tauri v1 __tauriModule: "Event" IPC 协议兜底
  const handlerId = registerEventCallback(handler, false);
  try {
    const eventId = await sendTauriV1EventModule<number>({
      cmd: "listen",
      event,
      windowLabel: null,
      handler: handlerId,
    });
    return async () => {
      Reflect.deleteProperty(win, `_${handlerId}`);
      await sendTauriV1EventModule({
        cmd: "unlisten",
        event,
        eventId,
      }).catch(() => {});
    };
  } catch (err) {
    console.warn(`[Quilla IPC] Tauri v1 listen("${event}") 注册失败:`, err);
    Reflect.deleteProperty(win, `_${handlerId}`);
    return () => {};
  }
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  if (typeof window === "undefined") return;
  const win = window as any;

  if (typeof win.__TAURI__?.event?.emit === "function") {
    return win.__TAURI__.event.emit(event, payload);
  }

  if (typeof win.__TAURI_INTERNALS__?.invoke === "function") {
    await win.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event,
      payload,
    });
    return;
  }

  await sendTauriV1EventModule({
    cmd: "emit",
    event,
    windowLabel: null,
    payload,
  });
}
