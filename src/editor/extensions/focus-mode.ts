import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { resolveSemanticBlockSpanFromState } from "./doc-structure";

/**
 * 专注模式状态管理与段落级视差聚焦插件 (F8)
 * - 当前光标所在段落/列表项/标题/代码块/公式块/表格/Callout：保持 100% 不透明度高清高亮
 * - 其余所有非当前段落与行：平滑淡化至 28% 不透明度
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

function getBlockRange(state: any, cursorLineNum: number): { start: number; end: number } {
  const doc = state.doc;

  // 0. 优先 O(1) 检查多行语义块（围栏代码块、Mermaid 块、多行数学公式块、表格块、Callout 块）
  const semanticSpan = resolveSemanticBlockSpanFromState(state, cursorLineNum);
  if (semanticSpan.startLine !== semanticSpan.endLine) {
    return { start: semanticSpan.startLine, end: semanticSpan.endLine };
  }

  const currentLine = doc.line(cursorLineNum);
  const text = currentLine.text;
  const trimmed = text.trim();

  if (trimmed === "") {
    return { start: cursorLineNum, end: cursorLineNum };
  }

  if (/^#{1,6}\s+/.test(trimmed)) {
    return { start: cursorLineNum, end: cursorLineNum };
  }

  if (trimmed.startsWith(">")) {
    let start = cursorLineNum;
    while (start > 1 && doc.line(start - 1).text.trim().startsWith(">")) {
      start--;
    }
    let end = cursorLineNum;
    while (end < doc.lines && doc.line(end + 1).text.trim().startsWith(">")) {
      end++;
    }
    return { start, end };
  }

  const isListItemStart = (t: string) => /^(\s*[-*+]|\s*\d+\.)(\s+\[[ xX]\])?\s+/.test(t);
  if (isListItemStart(text)) {
    let end = cursorLineNum;
    while (end < doc.lines) {
      const next = doc.line(end + 1);
      if (
        next.text.trim() === "" ||
        isListItemStart(next.text) ||
        /^#{1,6}\s+/.test(next.text.trim())
      ) {
        break;
      }
      end++;
    }
    return { start: cursorLineNum, end };
  }

  let start = cursorLineNum;
  while (start > 1) {
    const prev = doc.line(start - 1);
    if (prev.text.trim() === "" || /^#{1,6}\s+/.test(prev.text.trim())) break;
    if (isListItemStart(prev.text)) {
      start--;
      let end = cursorLineNum;
      while (end < doc.lines) {
        const next = doc.line(end + 1);
        if (
          next.text.trim() === "" ||
          isListItemStart(next.text) ||
          /^#{1,6}\s+/.test(next.text.trim())
        ) {
          break;
        }
        end++;
      }
      return { start, end };
    }
    start--;
  }

  start = cursorLineNum;
  while (start > 1) {
    const prev = doc.line(start - 1);
    if (
      prev.text.trim() === "" ||
      /^#{1,6}\s+/.test(prev.text.trim()) ||
      isListItemStart(prev.text)
    ) {
      break;
    }
    start--;
  }

  let end = cursorLineNum;
  while (end < doc.lines) {
    const next = doc.line(end + 1);
    if (
      next.text.trim() === "" ||
      /^#{1,6}\s+/.test(next.text.trim()) ||
      isListItemStart(next.text)
    ) {
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
        if (isActive !== wasActive || update.docChanged || update.selectionSet) {
          this.decorations = this.buildDecorations(update.state);
        }
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

      const { start, end } = getBlockRange(state, headLine.number);

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

export const focusModeExtension = [focusModeState, focusModePlugin];
