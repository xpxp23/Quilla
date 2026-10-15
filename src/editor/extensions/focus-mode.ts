import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";

/**
 * 专注模式状态管理与段落级视差聚焦插件 (F8)
 * - 当前光标所在段落/列表项/标题：保持 100% 不透明度高清高亮
 * - 其余所有非当前段落与行：平滑淡化至 28% 不透明度
 * - 完全对齐 Typora 专注模式手感
 */

export const setFocusMode = StateEffect.define<boolean>();

export const focusModeState = StateField.define<boolean>({
  create() {
    return localStorage.getItem("typora_focus_mode") === "true";
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFocusMode)) {
        return effect.value;
      }
    }
    return value;
  },
});

const focusActiveLineDeco = Decoration.line({ class: "cm-focus-active-block" });

/**
 * 精确计算当前光标所处的语义块 (Block) 范围：
 * 1. 标题: 独立单行
 * 2. 列表项: 独立列表项，不牵连其他项 (Typora 原生规范)
 * 3. 普通段落: 连续文本行
 */
function getBlockRange(doc: any, cursorLineNum: number): { start: number; end: number } {
  const currentLine = doc.line(cursorLineNum);
  const text = currentLine.text;
  const trimmed = text.trim();

  if (trimmed === "") {
    return { start: cursorLineNum, end: cursorLineNum };
  }

  // 1. 标题: 仅高亮当前单行标题
  if (/^#{1,6}\s+/.test(trimmed)) {
    return { start: cursorLineNum, end: cursorLineNum };
  }

  // 2. 列表项: 独立高亮当前列表项
  const isListItemStart = (t: string) => /^(\s*[-*+]|\s*\d+\.)(\s+\[[ xX]\])?\s+/.test(t);
  if (isListItemStart(text)) {
    let end = cursorLineNum;
    while (end < doc.lines) {
      const next = doc.line(end + 1);
      if (next.text.trim() === "" || isListItemStart(next.text) || /^#{1,6}\s+/.test(next.text.trim())) {
        break;
      }
      end++;
    }
    return { start: cursorLineNum, end };
  }

  // 3. 处于多行列表项的延续行内部时，向上寻找该列表项起始
  let start = cursorLineNum;
  while (start > 1) {
    const prev = doc.line(start - 1);
    if (prev.text.trim() === "" || /^#{1,6}\s+/.test(prev.text.trim())) break;
    if (isListItemStart(prev.text)) {
      start--;
      let end = cursorLineNum;
      while (end < doc.lines) {
        const next = doc.line(end + 1);
        if (next.text.trim() === "" || isListItemStart(next.text) || /^#{1,6}\s+/.test(next.text.trim())) break;
        end++;
      }
      return { start, end };
    }
    start--;
  }

  // 4. 普通段落
  start = cursorLineNum;
  while (start > 1) {
    const prev = doc.line(start - 1);
    if (prev.text.trim() === "" || /^#{1,6}\s+/.test(prev.text.trim()) || isListItemStart(prev.text)) {
      break;
    }
    start--;
  }

  let end = cursorLineNum;
  while (end < doc.lines) {
    const next = doc.line(end + 1);
    if (next.text.trim() === "" || /^#{1,6}\s+/.test(next.text.trim()) || isListItemStart(next.text)) {
      break;
    }
    end++;
  }

  return { start, end };
}

export const focusModePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(readonly view: EditorView) {
      const isActive = view.state.field(focusModeState);
      this.updateDomClass(isActive);
      this.decorations = this.buildDecorations(view.state);
    }

    update(update: ViewUpdate) {
      const isActive = update.state.field(focusModeState);
      const wasActive = update.startState.field(focusModeState);

      if (isActive !== wasActive) {
        this.updateDomClass(isActive);
      }

      if (isActive || wasActive) {
        this.decorations = this.buildDecorations(update.state);
      }
    }

    private updateDomClass(isActive: boolean) {
      if (isActive) {
        this.view.dom.classList.add("focus-mode");
        document.body.classList.add("focus-mode-active");
      } else {
        this.view.dom.classList.remove("focus-mode");
        document.body.classList.remove("focus-mode-active");
      }
    }

    private buildDecorations(state: any): DecorationSet {
      if (!state.field(focusModeState)) {
        return Decoration.none;
      }

      const builder = new RangeSetBuilder<Decoration>();
      const doc = state.doc;
      const sel = state.selection.main;
      const headLine = doc.lineAt(sel.head);

      const { start, end } = getBlockRange(doc, headLine.number);

      // 遍历文档给目标块的所有行加上高光装饰器
      for (let ln = start; ln <= end; ln++) {
        const l = doc.line(ln);
        builder.add(l.from, l.from, focusActiveLineDeco);
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

export function toggleFocusMode(view: EditorView, force?: boolean): boolean {
  const current = view.state.field(focusModeState);
  const next = typeof force === "boolean" ? force : !current;
  localStorage.setItem("typora_focus_mode", String(next));

  document.body.classList.toggle("focus-mode-active", next);
  view.dom.classList.toggle("focus-mode", next);

  view.dispatch({
    effects: setFocusMode.of(next),
  });
  return next;
}

export function isFocusModeActive(view: EditorView): boolean {
  return view.state.field(focusModeState);
}

export const focusModeExtension = [
  focusModeState,
  focusModePlugin,
];
