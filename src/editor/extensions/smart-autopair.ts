import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

/**
 * Typora 风格成对标点与选区自动包裹扩展
 * 包含：括号、双引号、单引号、反引号、LaTeX 美元符、Markdown 加粗与高亮
 */

// 选区包裹与 Markdown 特殊配对按键拦截器
const markdownSurroundHandler = EditorView.domEventHandlers({
  keydown: (event: KeyboardEvent, view: EditorView) => {
    // 仅在未按下 Ctrl / Alt / Meta 辅助键时处理
    if (event.ctrlKey || event.altKey || event.metaKey) return false;
    const { from, to } = view.state.selection.main;

    // 1. 选区包裹逻辑
    if (from !== to) {
      const key = event.key;
      let openStr = "";
      let closeStr = "";

      if (key === "(" || key === ")") {
        openStr = "("; closeStr = ")";
      } else if (key === "[" || key === "]") {
        openStr = "["; closeStr = "]";
      } else if (key === "{" || key === "}") {
        openStr = "{"; closeStr = "}";
      } else if (key === '"') {
        openStr = '"'; closeStr = '"';
      } else if (key === "'") {
        openStr = "'"; closeStr = "'";
      } else if (key === "`") {
        openStr = "`"; closeStr = "`";
      } else if (key === "$") {
        openStr = "$"; closeStr = "$";
      } else if (key === "*") {
        openStr = "*"; closeStr = "*";
      } else if (key === "~") {
        openStr = "~"; closeStr = "~";
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

    // 2. 无选区时：LaTeX 数学公式美元符成对自动补全与跳过
    if (event.key === "$") {
      const pos = from;
      const nextChar = view.state.sliceDoc(pos, pos + 1);
      if (nextChar === "$") {
        // 光标后紧跟 $，直接步进跳过
        event.preventDefault();
        view.dispatch({ selection: { anchor: pos + 1 } });
        return true;
      }
      // 否则自动成对补齐 $$
      event.preventDefault();
      view.dispatch({
        changes: { from: pos, to: pos, insert: "$$" },
        selection: { anchor: pos + 1 },
      });
      return true;
    }

    // 退格删除成对的 $$
    if (event.key === "Backspace") {
      const pos = from;
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
