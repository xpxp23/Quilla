import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

/**
 * 打字机模式状态管理与优雅平滑居中锁频插件 (F9)
 * - 键盘打字换行或点击导航时：平滑（ease-out 缓动动画）将当前行居中在视口 50% 处
 * - 同一行横向打字时：不重复触发滚动动画，保证输入毫无抖动
 * - 用户鼠标滚轮滑动时：立即中止动画并释放居中锁，允许用户自由查阅全文
 * - 再次按键或点击编辑时：平滑回弹居中
 */

export const setTypewriterMode = StateEffect.define<boolean>();

export const typewriterState = StateField.define<boolean>({
  create() {
    return localStorage.getItem("typora_typewriter_mode") === "true";
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setTypewriterMode)) {
        return effect.value;
      }
    }
    return value;
  },
});

let isUserScrolling = false;
let scrollTimeout: any = null;
let currentAnimId: number | null = null;
let scheduled = false;

function smoothScrollTo(element: HTMLElement, target: number, duration: number = 260) {
  if (currentAnimId !== null) {
    cancelAnimationFrame(currentAnimId);
    currentAnimId = null;
  }

  const start = element.scrollTop;
  const change = target - start;
  if (Math.abs(change) < 6) return;

  const startTime = performance.now();

  function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  function animate(currentTime: number) {
    if (isUserScrolling) {
      currentAnimId = null;
      return;
    }
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    element.scrollTop = start + change * easeOutCubic(progress);

    if (progress < 1) {
      currentAnimId = requestAnimationFrame(animate);
    } else {
      currentAnimId = null;
    }
  }

  currentAnimId = requestAnimationFrame(animate);
}

export const typewriterPlugin = ViewPlugin.fromClass(
  class {
    private dom: HTMLElement;
    private wheelHandler: () => void;
    private keyHandler: (e: KeyboardEvent) => void;
    private pointerHandler: () => void;

    constructor(readonly view: EditorView) {
      this.dom = view.scrollDOM;

      this.wheelHandler = () => {
        isUserScrolling = true;
        if (currentAnimId !== null) {
          cancelAnimationFrame(currentAnimId);
          currentAnimId = null;
        }
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          isUserScrolling = false;
        }, 1200);
      };

      this.keyHandler = (_e: KeyboardEvent) => {
        isUserScrolling = false;
        clearTimeout(scrollTimeout);
        this.scheduleCenter();
      };

      this.pointerHandler = () => {
        isUserScrolling = false;
        clearTimeout(scrollTimeout);
        this.scheduleCenter();
      };

      this.dom.addEventListener("wheel", this.wheelHandler, { passive: true });
      view.contentDOM.addEventListener("keydown", this.keyHandler);
      view.contentDOM.addEventListener("pointerdown", this.pointerHandler);

      this.updateDomClass();
      if (view.state.field(typewriterState)) {
        setTimeout(() => this.scheduleCenter(), 80);
      }
    }

    update(update: ViewUpdate) {
      const isActive = update.state.field(typewriterState);
      const wasActive = update.startState.field(typewriterState);

      if (isActive !== wasActive) {
        this.updateDomClass();
        if (isActive) {
          isUserScrolling = false;
          this.scheduleCenter();
        }
      }

      if (isActive && !isUserScrolling && (update.docChanged || update.selectionSet)) {
        this.scheduleCenter();
      }
    }

    private updateDomClass() {
      const isActive = this.view.state.field(typewriterState);
      if (isActive) {
        this.view.dom.classList.add("typewriter-mode");
        document.body.classList.add("typewriter-mode-active");
      } else {
        this.view.dom.classList.remove("typewriter-mode");
        document.body.classList.remove("typewriter-mode-active");
      }
    }

    private scheduleCenter() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (!this.view.state.field(typewriterState) || isUserScrolling) return;

        try {
          const head = this.view.state.selection.main.head;
          const lineBlock = this.view.lineBlockAt(head);
          const scroller = this.view.scrollDOM;
          const targetY = lineBlock.top - (scroller.clientHeight / 2) + (lineBlock.height / 2);
          smoothScrollTo(scroller, Math.max(0, targetY), 260);
        } catch {
          // 容错兜底
        }
      });
    }

    destroy() {
      if (currentAnimId !== null) {
        cancelAnimationFrame(currentAnimId);
        currentAnimId = null;
      }
      this.dom.removeEventListener("wheel", this.wheelHandler);
      this.view.contentDOM.removeEventListener("keydown", this.keyHandler);
      this.view.contentDOM.removeEventListener("pointerdown", this.pointerHandler);
      clearTimeout(scrollTimeout);
    }
  }
);

export function toggleTypewriterMode(view: EditorView, force?: boolean): boolean {
  const current = view.state.field(typewriterState);
  const next = typeof force === "boolean" ? force : !current;
  localStorage.setItem("typora_typewriter_mode", String(next));
  view.dispatch({
    effects: setTypewriterMode.of(next),
  });
  return next;
}

export function isTypewriterModeActive(view: EditorView): boolean {
  return view.state.field(typewriterState);
}

/**
 * 在打字机模式下将特定元素 (表格行、图表、公式块) 平滑缓动居中在视口 50% 水平线上
 */
export function centerElementInTypewriter(view: EditorView, elem: HTMLElement, duration: number = 260) {
  if (!isTypewriterModeActive(view)) return;
  requestAnimationFrame(() => {
    try {
      const scroller = view.scrollDOM;
      const rect = elem.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const elemCenter = rect.top + rect.height / 2;
      const scrollerCenter = scrollerRect.top + scrollerRect.height / 2;
      const diff = elemCenter - scrollerCenter;
      if (Math.abs(diff) > 4) {
        smoothScrollTo(scroller, Math.max(0, scroller.scrollTop + diff), duration);
      }
    } catch {
      // 容错兜底
    }
  });
}

export const typewriterModeExtension = [
  typewriterState,
  typewriterPlugin,
];
