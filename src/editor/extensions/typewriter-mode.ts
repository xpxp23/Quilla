import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

/**
 * 打字机模式状态管理与优雅平滑居中锁频插件 (F9 v0.9)
 * - 彻底消除 keydown 与 update.selectionSet 双重调用 scheduleCenter 导致的滚动动画互搏
 * - 彻底消除模块级全局变量，所有状态挂载于编辑器实例内部，完美隔离左右分屏双实例
 * - 智能忽略代码块复制按钮、语言选择器、任务列表复选框、表格工具栏、标题折叠按钮等非光标交互控件的点击
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

const INTERACTIVE_WIDGET_SELECTOR =
  "button, input, select, textarea, a, .code-block-header-bar, .cm-code-block-last-line, .task-list-item-checkbox, .table-floating-toolbar, .cm-toc-card, .cm-wiki-link, .cm-transclusion-card, .cm-frontmatter-card, .cm-heading-fold-btn, .cm-block-handle, .md-image-card";

const activeAnimMap = new WeakMap<HTMLElement, number>();

function smoothScrollTo(
  element: HTMLElement,
  target: number,
  duration: number = 180,
  shouldAbort?: () => boolean
) {
  const prevAnim = activeAnimMap.get(element);
  if (prevAnim !== undefined) {
    cancelAnimationFrame(prevAnim);
    activeAnimMap.delete(element);
  }

  const start = element.scrollTop;
  const change = target - start;
  if (Math.abs(change) < 6) return;

  const startTime = performance.now();

  function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  function animate(currentTime: number) {
    if (shouldAbort && shouldAbort()) {
      activeAnimMap.delete(element);
      return;
    }
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    element.scrollTop = start + change * easeOutCubic(progress);

    if (progress < 1) {
      const id = requestAnimationFrame(animate);
      activeAnimMap.set(element, id);
    } else {
      activeAnimMap.delete(element);
    }
  }

  const id = requestAnimationFrame(animate);
  activeAnimMap.set(element, id);
}

export const typewriterPlugin = ViewPlugin.fromClass(
  class {
    private dom: HTMLElement;
    private isUserScrolling = false;
    private isPointerDragging = false;
    private pointerStartedOnControl = false;
    private scrollTimeout: any = null;
    private scheduled = false;
    private wheelHandler: () => void;
    private keyHandler: (e: KeyboardEvent) => void;
    private pointerDownHandler: (e: PointerEvent) => void;
    private pointerUpHandler: (e: PointerEvent) => void;

    constructor(readonly view: EditorView) {
      this.dom = view.scrollDOM;

      this.wheelHandler = () => {
        this.isUserScrolling = true;
        const prevAnim = activeAnimMap.get(this.dom);
        if (prevAnim !== undefined) {
          cancelAnimationFrame(prevAnim);
          activeAnimMap.delete(this.dom);
        }
        clearTimeout(this.scrollTimeout);
        this.scrollTimeout = setTimeout(() => {
          this.isUserScrolling = false;
        }, 1200);
      };

      // keydown 仅解除滚轮锁定，不提前抢跑 scheduleCenter（统一由 update(selectionSet/docChanged) 在选区更新后单次触发，避免双重动画互搏）
      this.keyHandler = (e: KeyboardEvent) => {
        if (e.shiftKey && e.key.startsWith("Arrow")) return;
        this.isUserScrolling = false;
        clearTimeout(this.scrollTimeout);
      };

      this.pointerDownHandler = (e: PointerEvent) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest(INTERACTIVE_WIDGET_SELECTOR)) {
          this.pointerStartedOnControl = true;
          this.isPointerDragging = false;
          return;
        }
        this.pointerStartedOnControl = false;
        this.isPointerDragging = true;
        const prevAnim = activeAnimMap.get(this.dom);
        if (prevAnim !== undefined) {
          cancelAnimationFrame(prevAnim);
          activeAnimMap.delete(this.dom);
        }
      };

      this.pointerUpHandler = (e: PointerEvent) => {
        if (this.pointerStartedOnControl) {
          this.pointerStartedOnControl = false;
          return;
        }
        if (!this.isPointerDragging) return;
        this.isPointerDragging = false;

        const target = e.target as HTMLElement | null;
        if (target?.closest(INTERACTIVE_WIDGET_SELECTOR)) {
          return;
        }

        if (this.view.state.selection.main.empty && this.view.hasFocus) {
          this.isUserScrolling = false;
          this.scheduleCenter();
        }
      };

      this.dom.addEventListener("wheel", this.wheelHandler, { passive: true });
      view.contentDOM.addEventListener("keydown", this.keyHandler);
      view.contentDOM.addEventListener("pointerdown", this.pointerDownHandler);
      window.addEventListener("pointerup", this.pointerUpHandler);

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
          this.isUserScrolling = false;
          this.scheduleCenter();
        }
      }

      if (
        isActive &&
        !this.isUserScrolling &&
        !this.isPointerDragging &&
        !this.pointerStartedOnControl &&
        update.state.selection.main.empty
      ) {
        const isTableSync = update.transactions.some((tr) => tr.isUserEvent("input.table"));
        if (isTableSync) return;

        if (update.selectionSet) {
          this.scheduleCenter();
        } else if (update.docChanged) {
          const head = update.state.selection.main.head;
          let nearCursor = false;
          update.changes.iterChanges((_fromA, _toA, fromB, toB) => {
            if (Math.abs(fromB - head) <= 8 || (head >= fromB && head <= toB)) {
              nearCursor = true;
            }
          });
          if (nearCursor) {
            this.scheduleCenter();
          }
        }
      }
    }

    private updateDomClass() {
      const isActive = this.view.state.field(typewriterState);
      this.view.dom.classList.toggle("typewriter-mode", isActive);
    }

    private scheduleCenter() {
      if (this.scheduled) return;
      this.scheduled = true;
      requestAnimationFrame(() => {
        this.scheduled = false;
        if (
          !this.view.state.field(typewriterState) ||
          this.isUserScrolling ||
          this.isPointerDragging
        ) {
          return;
        }

        try {
          const head = this.view.state.selection.main.head;
          const coords = this.view.coordsAtPos(head);
          const scroller = this.view.scrollDOM;
          if (coords) {
            const scrollerRect = scroller.getBoundingClientRect();
            const headCenterY = (coords.top + coords.bottom) / 2;
            const scrollerCenterY = scrollerRect.top + scrollerRect.height / 2;
            const diff = headCenterY - scrollerCenterY;
            if (Math.abs(diff) > 6) {
              smoothScrollTo(
                scroller,
                Math.max(0, scroller.scrollTop + diff),
                180,
                () => this.isUserScrolling || this.isPointerDragging
              );
            }
            return;
          }
          const lineBlock = this.view.lineBlockAt(head);
          const targetY = lineBlock.top - scroller.clientHeight / 2 + lineBlock.height / 2;
          smoothScrollTo(
            scroller,
            Math.max(0, targetY),
            180,
            () => this.isUserScrolling || this.isPointerDragging
          );
        } catch {
          // 容错兜底
        }
      });
    }

    destroy() {
      const prevAnim = activeAnimMap.get(this.dom);
      if (prevAnim !== undefined) {
        cancelAnimationFrame(prevAnim);
        activeAnimMap.delete(this.dom);
      }
      this.dom.removeEventListener("wheel", this.wheelHandler);
      this.view.contentDOM.removeEventListener("keydown", this.keyHandler);
      this.view.contentDOM.removeEventListener("pointerdown", this.pointerDownHandler);
      window.removeEventListener("pointerup", this.pointerUpHandler);
      clearTimeout(this.scrollTimeout);
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
export function centerElementInTypewriter(
  view: EditorView,
  elem: HTMLElement,
  duration: number = 180
) {
  if (!isTypewriterModeActive(view)) return;
  requestAnimationFrame(() => {
    try {
      const scroller = view.scrollDOM;
      const rect = elem.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const elemCenter = rect.top + rect.height / 2;
      const scrollerCenter = scrollerRect.top + scrollerRect.height / 2;
      const diff = elemCenter - scrollerCenter;
      if (Math.abs(diff) > 6) {
        smoothScrollTo(scroller, Math.max(0, scroller.scrollTop + diff), duration);
      }
    } catch {
      // 容错兜底
    }
  });
}

export const typewriterModeExtension = [typewriterState, typewriterPlugin];
