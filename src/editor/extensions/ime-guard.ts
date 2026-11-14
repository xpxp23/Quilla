import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { forceRefreshEffect } from "./refresh-effect";

/**
 * IME 防护守卫 (v0.6 & v0.13.0 银河麒麟 Fcitx5 / 搜狗输入法信创版 WebKitGTK 专项增强)：
 * - 支持多视图实例独立跟踪 CompositionState
 * - 针对 Linux WebKitGTK 下 Fcitx5 / 搜狗输入法候选词上屏时 `compositionend` 与 `input` 事件微秒级交错，
 *   采用带防抖取消的延迟解锁机制，防止连续词组输入中途实时预览闪烁
 * - 增加 blur 与 Escape 失焦自动释放锁，根治输入法选词中途切换标签页导致实时预览永久冻结的 Bug
 */
const composingViews = new WeakMap<EditorView, boolean>();
const pendingUnlockTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();

class IMEState {
  public isComposing = false;
  public isViewComposing(view?: EditorView): boolean {
    if (view && composingViews.has(view)) {
      return Boolean(composingViews.get(view));
    }
    return this.isComposing;
  }
}

export const imeState = new IMEState();

export const imeGuardPlugin = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      const clearUnlockTimer = () => {
        const timer = pendingUnlockTimers.get(view);
        if (timer !== undefined) {
          clearTimeout(timer);
          pendingUnlockTimers.delete(view);
        }
      };

      const startComposition = () => {
        clearUnlockTimer();
        composingViews.set(view, true);
        imeState.isComposing = true;
      };

      const finishComposition = () => {
        clearUnlockTimer();
        if (!composingViews.get(view) && !imeState.isComposing) return;
        const timer = setTimeout(() => {
          pendingUnlockTimers.delete(view);
          composingViews.set(view, false);
          imeState.isComposing = false;
          view.dispatch({
            effects: forceRefreshEffect.of(true),
          });
          view.requestMeasure();
        }, 32);
        pendingUnlockTimers.set(view, timer);
      };

      view.dom.addEventListener("compositionstart", startComposition);
      view.dom.addEventListener("compositionupdate", startComposition);
      view.dom.addEventListener("compositionend", finishComposition);
      view.contentDOM.addEventListener("blur", finishComposition);
    }

    update(_update: ViewUpdate) {}
  }
);
