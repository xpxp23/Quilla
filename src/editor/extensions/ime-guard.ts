import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { forceRefreshEffect } from "./refresh-effect";

/**
 * IME 防护守卫 (v0.15.0 重构版)：
 * - 多视图独立追踪 CompositionState，互不串台；
 * - 完整实现 Escape 键失焦解锁与 `destroy()` 卸载监听与定时器，彻底杜绝切换文档时的监听器叠加泄漏。
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
    private view: EditorView;
    private startComposition: () => void;
    private finishComposition: () => void;
    private onKeyDown: (e: KeyboardEvent) => void;

    constructor(view: EditorView) {
      this.view = view;
      composingViews.set(view, false);

      const clearUnlockTimer = () => {
        const timer = pendingUnlockTimers.get(view);
        if (timer !== undefined) {
          clearTimeout(timer);
          pendingUnlockTimers.delete(view);
        }
      };

      this.startComposition = () => {
        clearUnlockTimer();
        composingViews.set(view, true);
        imeState.isComposing = true;
      };

      this.finishComposition = () => {
        clearUnlockTimer();
        if (!composingViews.get(view) && !imeState.isComposing) return;
        const timer = setTimeout(() => {
          pendingUnlockTimers.delete(view);
          composingViews.set(view, false);
          imeState.isComposing = false;
          try {
            view.dispatch({
              effects: forceRefreshEffect.of(true),
            });
            view.requestMeasure();
          } catch {
            // 视图可能已在定时器回调前销毁
          }
        }, 32);
        pendingUnlockTimers.set(view, timer);
      };

      this.onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && (composingViews.get(view) || imeState.isComposing)) {
          this.finishComposition();
        }
      };

      view.dom.addEventListener("compositionstart", this.startComposition);
      view.dom.addEventListener("compositionupdate", this.startComposition);
      view.dom.addEventListener("compositionend", this.finishComposition);
      view.dom.addEventListener("keydown", this.onKeyDown);
      view.contentDOM.addEventListener("blur", this.finishComposition);
    }

    update(_update: ViewUpdate) {}

    destroy() {
      const timer = pendingUnlockTimers.get(this.view);
      if (timer !== undefined) {
        clearTimeout(timer);
        pendingUnlockTimers.delete(this.view);
      }
      composingViews.delete(this.view);
      this.view.dom.removeEventListener("compositionstart", this.startComposition);
      this.view.dom.removeEventListener("compositionupdate", this.startComposition);
      this.view.dom.removeEventListener("compositionend", this.finishComposition);
      this.view.dom.removeEventListener("keydown", this.onKeyDown);
      this.view.contentDOM.removeEventListener("blur", this.finishComposition);
    }
  }
);
