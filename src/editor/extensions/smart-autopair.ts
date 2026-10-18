import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { isInsideCodeContextAST } from "./doc-structure";

/**
 * Typora 风格成对标点与选区自动包裹扩展 (v0.6)
 * 修复行首输入 *** 水平分割线或列表符号时被误扩展为 **** 的逻辑异常
 */
const markdownSurroundHandler = EditorView.domEventHandlers({
  keydown: (event: KeyboardEvent, view: EditorView) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return false;
    const { from, to } = view.state.selection.main;

    // 1. 选区包裹逻辑
    if (from !== to) {
      const key = event.key;
      let openStr = "";
      let closeStr = "";

      if (key === "(" || key === ")") {
        openStr = "(";
        closeStr = ")";
      } else if (key === "[" || key === "]") {
        openStr = "[";
        closeStr = "]";
      } else if (key === "{") {
        openStr = "{";
        closeStr = "}";
      } else if (key === '"') {
        openStr = '"';
        closeStr = '"';
      } else if (key === "'") {
        openStr = "'";
        closeStr = "'";
      } else if (key === "`") {
        openStr = "`";
        closeStr = "`";
      } else if (key === "$") {
        openStr = "$";
        closeStr = "$";
      } else if (key === "*") {
        openStr = "*";
        closeStr = "*";
      } else if (key === "~") {
        openStr = "~";
        closeStr = "~";
      } else if (key === "=") {
        openStr = "=";
        closeStr = "=";
      } else {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();

      const selectedText = view.state.sliceDoc(from, to);
      const replacement = `${openStr}${selectedText}${closeStr}`;

      view.dispatch({
        changes: { from, to, insert: replacement },
        selection: {
          anchor: from + openStr.length,
          head: from + openStr.length + selectedText.length,
        },
      });

      return true;
    }

    // 2. 无选区时：利用 Lezer AST O(log N) 检测是否处于代码块或行内代码内部
    const pos = from;
    if (isInsideCodeContextAST(view.state, pos)) {
      return false;
    }

    // 2.1 LaTeX 数学公式美元符成对自动补全与跳过
    if (event.key === "$") {
      const nextChar = view.state.sliceDoc(pos, pos + 1);
      if (nextChar === "$") {
        event.preventDefault();
        view.dispatch({ selection: { anchor: pos + 1 } });
        return true;
      }
      event.preventDefault();
      view.dispatch({
        changes: { from: pos, to: pos, insert: "$$" },
        selection: { anchor: pos + 1 },
      });
      return true;
    }

    // 2.2 双符号 Markdown 标记智能配对 (** / ~~ / ==) 与步进跳过
    if (event.key === "*" || event.key === "~" || event.key === "=") {
      const ch = event.key;
      const line = view.state.doc.lineAt(pos);
      const beforeInLine = line.text.slice(0, pos - line.from);
      const prevChar = view.state.sliceDoc(Math.max(0, pos - 1), pos);
      const nextTwo = view.state.sliceDoc(pos, pos + 2);

      // 若在行首连续输入 *** 或 ~~~（准备输入分割线或代码块围栏），不自动补齐成对后缀
      if ((ch === "*" || ch === "~") && /^[*~]{2,}$/.test(beforeInLine.trim())) {
        return false;
      }

      if (nextTwo === ch + ch) {
        event.preventDefault();
        view.dispatch({ selection: { anchor: pos + 1 } });
        return true;
      }
      if (prevChar === ch && view.state.sliceDoc(pos, pos + 1) !== ch) {
        event.preventDefault();
        view.dispatch({
          changes: { from: pos, to: pos, insert: ch + ch + ch },
          selection: { anchor: pos + 1 },
        });
        return true;
      }
    }

    // 3. 退格对称删除成对的 $$ / **** / ~~~~ / ==== / [[]]
    if (event.key === "Backspace") {
      if (pos > 0 && pos < view.state.doc.length) {
        const prevChar = view.state.sliceDoc(pos - 1, pos);
        const nextChar = view.state.sliceDoc(pos, pos + 1);
        if (prevChar === "$" && nextChar === "$") {
          event.preventDefault();
          view.dispatch({
            changes: { from: pos - 1, to: pos + 1, insert: "" },
            selection: { anchor: pos - 1 },
          });
          return true;
        }
        const prevTwo = view.state.sliceDoc(Math.max(0, pos - 2), pos);
        const nextTwo = view.state.sliceDoc(pos, Math.min(view.state.doc.length, pos + 2));
        if (
          (prevTwo === "**" && nextTwo === "**") ||
          (prevTwo === "~~" && nextTwo === "~~") ||
          (prevTwo === "==" && nextTwo === "==") ||
          (prevTwo === "[[" && nextTwo === "]]")
        ) {
          event.preventDefault();
          view.dispatch({
            changes: { from: pos - 2, to: pos + 2, insert: "" },
            selection: { anchor: pos - 2 },
          });
          return true;
        }
      }
    }

    return false;
  },
});

export function smartAutopairExtension(): Extension[] {
  return [
    closeBrackets(),
    markdownSurroundHandler,
    Prec.high(keymap.of(closeBracketsKeymap)),
  ];
}
