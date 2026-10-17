import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { forceRefreshEffect } from "./refresh-effect";

/**
 * IME 防护守卫 (v0.5)：
 * - 支持多视图实例独立跟踪 CompositionState
 * - 增加 blur 失焦自动释放锁，根治输入法选词中途切换标签页导致实时预览永久冻结的 Bug
 */
const composingViews = new WeakMap<EditorView, boolean>();

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
      const finishComposition = () => {
        if (!composingViews.get(view) && !imeState.isComposing) return;
        composingViews.set(view, false);
        imeState.isComposing = false;
        setTimeout(() => {
          view.dispatch({
            effects: forceRefreshEffect.of(true),
          });
          view.requestMeasure();
        }, 25);
      };

      view.dom.addEventListener("compositionstart", () => {
        composingViews.set(view, true);
        imeState.isComposing = true;
      });

      view.dom.addEventListener("compositionend", finishComposition);
      view.contentDOM.addEventListener("blur", finishComposition);
    }

    update(_update: ViewUpdate) {}
  }
);
