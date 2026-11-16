/**
 * Quilla (羽墨) v0.14.0 — 跨版本 Tauri Core IPC 兼容桥接层 (Tauri v1 webkit2gtk-4.0 & Tauri v2 双栈自适应)
 * - 在银河麒麟 V10 SP1 (glibc 2.31 + libwebkit2gtk-4.0-37 + libsoup-2.4) 下自动走 Tauri v1 `window.__TAURI__` / `window.__TAURI_IPC__`
 *   (`webkit_user_content_manager_register_script_message_handler` postMessage 通道)，彻底摆脱对 `webkit_uri_scheme_request_get_http_body` 的依赖；
 * - 在 Tauri v2 环境下自动感知 `window.__TAURI_INTERNALS__.invoke`。
 */

function registerIpcCallback(
  callback?: (response: any) => void,
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
      return callback?.(result);
    },
    writable: false,
    configurable: true,
  });

  return identifier;
}

export async function invoke<T = any>(
  cmd: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Tauri IPC 仅在客户端窗口环境中可用"));
  }

  const win = window as any;

  // 1. 优先使用 Tauri v1 全局注入的 window.__TAURI__.tauri.invoke 或 window.__TAURI__.invoke
  if (typeof win.__TAURI__?.tauri?.invoke === "function") {
    return win.__TAURI__.tauri.invoke(cmd, args);
  }
  if (typeof win.__TAURI__?.invoke === "function") {
    return win.__TAURI__.invoke(cmd, args);
  }

  // 2. 兼容 Tauri v2 window.__TAURI_INTERNALS__.invoke
  if (typeof win.__TAURI_INTERNALS__?.invoke === "function") {
    return win.__TAURI_INTERNALS__.invoke(cmd, args);
  }

  // 3. 兼容 Tauri v1 底层原始 window.__TAURI_IPC__ (WebKitGTK 4.0 script message handler)
  if (typeof win.__TAURI_IPC__ === "function") {
    return new Promise<T>((resolve, reject) => {
      const callback = registerIpcCallback((r) => {
        resolve(r);
        Reflect.deleteProperty(win, `_${error}`);
      }, true);
      const error = registerIpcCallback((e) => {
        reject(e);
        Reflect.deleteProperty(win, `_${callback}`);
      }, true);

      win.__TAURI_IPC__({
        cmd,
        callback,
        error,
        ...args,
      });
    });
  }

  return Promise.reject(new Error(`未检测到 Tauri IPC 运行时 (command: ${cmd})`));
}
