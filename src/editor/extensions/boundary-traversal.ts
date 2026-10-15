import { EditorView, KeyBinding, keymap } from "@codemirror/view";
import { findTablesInDoc } from "./table-editor";
import { findMermaidBlocks } from "./mermaid-extension";
import { findMathBlocks } from "./math-block-extension";

/**
 * 块级边界漫游扩展 (Widget Boundary Traversal):
 * 当光标在普通正文行移动时，如果按 ArrowDown/ArrowUp 遇到块级元素 (表格、Mermaid 流程图、多行公式块)，
 * 自动无缝穿透进入该 Widget 内部进行编辑或选定，而不是粗暴跳过！
 */
export const boundaryTraversalKeymap: KeyBinding[] = [
  {
    key: "ArrowDown",
    run: (view: EditorView) => {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      if (line.number >= view.state.doc.lines) return false;

      // 检查下一行是否是表格块的起始行
      const tables = findTablesInDoc(view.state);
      const nextLineNum = line.number + 1;
      const targetTable = tables.find((t) => t.startLine === nextLineNum);
      if (targetTable) {
        // 查找 DOM 中渲染的表格 widget
        const tableWidgets = view.dom.querySelectorAll<HTMLElement>(".in-place-edit");
        for (let i = 0; i < tableWidgets.length; i++) {
          const tbl = tableWidgets[i];
          const firstTh = tbl.querySelector<HTMLElement>("th");
          if (firstTh && firstTh.getBoundingClientRect().height > 0) {
            firstTh.focus();
            // 将光标移入单元格起始
            const range = document.createRange();
            const sel = window.getSelection();
            range.selectNodeContents(firstTh);
            range.collapse(true);
            sel?.removeAllRanges();
            sel?.addRange(range);
            return true;
          }
        }
      }

      // 检查下一行是否是 Mermaid 流程图或数学公式块
      const mermaids = findMermaidBlocks(view.state);
      const targetMermaid = mermaids.find((m) => m.startLine === nextLineNum);
      if (targetMermaid) {
        const card = view.dom.querySelector<HTMLElement>(".md-mermaid-card");
        if (card) {
          card.scrollIntoView({ block: "nearest" });
          return false;
        }
      }

      return false;
    },
  },
  {
    key: "ArrowUp",
    run: (view: EditorView) => {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      if (line.number <= 1) return false;

      // 检查上一行是否是表格块的结束行
      const tables = findTablesInDoc(view.state);
      const prevLineNum = line.number - 1;
      const targetTable = tables.find((t) => t.endLine === prevLineNum);
      if (targetTable) {
        const tableWidgets = view.dom.querySelectorAll<HTMLElement>(".in-place-edit");
        for (let i = 0; i < tableWidgets.length; i++) {
          const tbl = tableWidgets[i];
          const rows = tbl.querySelectorAll("tbody tr");
          if (rows.length > 0) {
            const lastRow = rows[rows.length - 1];
            const firstTd = lastRow.querySelector<HTMLElement>("td");
            if (firstTd && firstTd.getBoundingClientRect().height > 0) {
              firstTd.focus();
              const range = document.createRange();
              const sel = window.getSelection();
              range.selectNodeContents(firstTd);
              range.collapse(false);
              sel?.removeAllRanges();
              sel?.addRange(range);
              return true;
            }
          }
        }
      }

      return false;
    },
  },
];

export const boundaryTraversalExtension = keymap.of(boundaryTraversalKeymap);
