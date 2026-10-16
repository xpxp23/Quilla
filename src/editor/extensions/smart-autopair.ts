import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { EditorState, Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

/**
 * 检测当前光标位置是否位于围栏代码块或行内代码反引号内
 */
function isInsideCodeContext(state: EditorState, pos: number): boolean {
  const doc = state.doc;
  const curLine = doc.lineAt(pos);

  // 1. 检查是否位于围栏代码块内部
  let inFence = false;
  let fenceChar = "";
  for (let i = 1; i <= curLine.number; i++) {
    const trimmed = doc.line(i).text.trim();
    if (/^(```+|~~~+)/.test(trimmed)) {
      const marker = trimmed.startsWith("`") ? "`" : "~";
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        if (i === curLine.number) return true;
        inFence = false;
      }
    }
  }
  if (inFence) return true;

  // 2. 检查当前行光标左侧是否有奇数个反引号（处于行内代码内部）
  const beforeInLine = curLine.text.slice(0, pos - curLine.from);
  const backtickCount = (beforeInLine.match(/`/g) || []).length;
  return backtickCount % 2 === 1;
}

/**
 * Typora 风格成对标点与选区自动包裹扩展
 * 包含：括号、双引号、单引号、反引号、LaTeX 美元符、Markdown 加粗 (**)、删除线 (~~)、高亮 (==)
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
      } else if (key === "{" || key === "}") {
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

    // 2. 无选区时：若处于代码块或行内代码内部，跳过 Markdown 专属配对
    const pos = from;
    if (isInsideCodeContext(view.state, pos)) {
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
      const prevChar = view.state.sliceDoc(Math.max(0, pos - 1), pos);
      const nextTwo = view.state.sliceDoc(pos, pos + 2);
      if (nextTwo === ch + ch) {
        event.preventDefault();
        view.dispatch({ selection: { anchor: pos + 1 } });
        return true;
      }
      // 当刚输入了第一个 * / ~ / =，再按第二个时自动补齐右侧成对标记并将光标置于中间
      if (prevChar === ch && view.state.sliceDoc(pos, pos + 1) !== ch) {
        event.preventDefault();
        view.dispatch({
          changes: { from: pos, to: pos, insert: ch + ch + ch },
          selection: { anchor: pos + 1 },
        });
        return true;
      }
    }

    // 3. 退格对称删除成对的 $$ / **** / ~~~~ / ====
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
          (prevTwo === "==" && nextTwo === "==")
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

/**
 * 组合输出成对标点与包裹扩展
 */
export function smartAutopairExtension(): Extension[] {
  return [
    closeBrackets(),
    markdownSurroundHandler,
    Prec.high(keymap.of(closeBracketsKeymap)),
  ];
}
