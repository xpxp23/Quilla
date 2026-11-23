/**
 * Quilla (羽墨) v0.15.0 — 跨版本 Tauri Core IPC 兼容桥接层 (Tauri v1 & Tauri v2 双栈自适应)
 * - 兼容银河麒麟 V10 SP1 (webkit2gtk-4.0 / libsoup-2.4) 与银河麒麟 V11 2503 (glibc 2.38 / webkit2gtk-4.1)
 * - 修复了底层 __TAURI_IPC__ 展开参数可能覆盖 cmd/callback/error 协议字段的安全隐患
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

  // 3. 兼容 Tauri v1 底层原始 window.__TAURI_IPC__ (WebKitGTK script message handler)
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

      // 安全顺序：先展开业务参数，再用协议保留字段覆盖，防止 args 中同名字段劫持 IPC 回调
      win.__TAURI_IPC__({
        ...args,
        cmd,
        callback,
        error,
      });
    });
  }

  return Promise.reject(new Error(`未检测到 Tauri IPC 运行时 (command: ${cmd})`));
}
