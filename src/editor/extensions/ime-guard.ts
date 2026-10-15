import { ViewPlugin, ViewUpdate } from "@codemirror/view";
import { forceRefreshEffect } from "./refresh-effect";

/**
 * IME 防护守卫：
 * 当处于拼音/中文输入法 CompositionState 时，冻结装饰器剧烈重绘，
 * 避免拼音截断、候选框乱跳；待输入法确认上屏后，自动平滑重构装饰器。
 */
class IMEState {
  public isComposing = false;
}

export const imeState = new IMEState();

export const imeGuardPlugin = ViewPlugin.fromClass(
  class {
    constructor(view: any) {
      view.dom.addEventListener("compositionstart", () => {
        imeState.isComposing = true;
      });

      view.dom.addEventListener("compositionend", () => {
        imeState.isComposing = false;
        setTimeout(() => {
          view.dispatch({
            effects: forceRefreshEffect.of(true),
          });
          view.requestMeasure();
        }, 30);
      });
    }

    update(_update: ViewUpdate) {}
  }
);
