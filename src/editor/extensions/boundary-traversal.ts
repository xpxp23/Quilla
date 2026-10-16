import { EditorView, KeyBinding, keymap } from "@codemirror/view";
import { findTablesInDoc } from "./table-editor";
import { findMermaidBlocks } from "./mermaid-extension";
import { findMathBlocks } from "./math-block-extension";

/**
 * 根据目标表格块起始坐标精准查找对应的 DOM 表格元素
 */
function findMatchingTableElement(view: EditorView, tableFromPos: number, tableIdx: number): HTMLElement | null {
  const figures = view.dom.querySelectorAll<HTMLElement>("figure.table-figure");
  for (let i = 0; i < figures.length; i++) {
    const fig = figures[i];
    if (Number(fig.dataset.fromPos) === tableFromPos) {
      return fig.querySelector<HTMLElement>(".in-place-edit");
    }
  }
  const allTables = view.dom.querySelectorAll<HTMLElement>(".in-place-edit");
  return allTables[tableIdx] || null;
}

/**
 * 块级边界漫游扩展 (Widget Boundary Traversal):
 * 当光标在普通正文行移动时，如果按 ArrowDown/ArrowUp 遇到块级元素 (表格、Mermaid 流程图、多行公式块)，
 * 自动无缝穿透进入该 Widget 内部进行编辑或选定，彻底解决多表格跳错目标与公式块跳过问题。
 */
export const boundaryTraversalKeymap: KeyBinding[] = [
  {
    key: "ArrowDown",
    run: (view: EditorView) => {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      if (line.number >= view.state.doc.lines) return false;

      const nextLineNum = line.number + 1;

      // 1. 检查下一行是否是表格块的起始行
      const tables = findTablesInDoc(view.state);
      const targetTableIdx = tables.findIndex((t) => t.startLine === nextLineNum);
      if (targetTableIdx !== -1) {
        const targetTable = tables[targetTableIdx];
        const tbl = findMatchingTableElement(view, targetTable.from, targetTableIdx);
        const firstTh = tbl?.querySelector<HTMLElement>("th");
        if (firstTh) {
          firstTh.focus();
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents(firstTh);
          range.collapse(true);
          sel?.removeAllRanges();
          sel?.addRange(range);
          return true;
        }
      }

      // 2. 检查下一行是否是多行数学公式块的起始行
      const mathBlocks = findMathBlocks(view.state);
      const targetMath = mathBlocks.find((m) => m.startLine === nextLineNum);
      if (targetMath) {
        const enterPos = Math.min(
          view.state.doc.line(Math.min(targetMath.startLine + 1, targetMath.endLine)).from,
          view.state.doc.length
        );
        view.dispatch({
          selection: { anchor: enterPos },
          scrollIntoView: true,
        });
        return true;
      }

      // 3. 检查下一行是否是 Mermaid 流程图的起始行
      const mermaids = findMermaidBlocks(view.state);
      const targetMermaid = mermaids.find((m) => m.startLine === nextLineNum);
      if (targetMermaid) {
        const enterPos = Math.min(
          view.state.doc.line(Math.min(targetMermaid.startLine + 1, targetMermaid.endLine)).from,
          view.state.doc.length
        );
        view.dispatch({
          selection: { anchor: enterPos },
          scrollIntoView: true,
        });
        return true;
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

      const prevLineNum = line.number - 1;

      // 1. 检查上一行是否是表格块的结束行
      const tables = findTablesInDoc(view.state);
      const targetTableIdx = tables.findIndex((t) => t.endLine === prevLineNum);
      if (targetTableIdx !== -1) {
        const targetTable = tables[targetTableIdx];
        const tbl = findMatchingTableElement(view, targetTable.from, targetTableIdx);
        if (tbl) {
          const rows = tbl.querySelectorAll("tbody tr");
          if (rows.length > 0) {
            const lastRow = rows[rows.length - 1];
            const firstTd = lastRow.querySelector<HTMLElement>("td");
            if (firstTd) {
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

      // 2. 检查上一行是否是多行公式块的结束行
      const mathBlocks = findMathBlocks(view.state);
      const targetMath = mathBlocks.find((m) => m.endLine === prevLineNum);
      if (targetMath) {
        const enterLine = Math.max(targetMath.startLine, targetMath.endLine - 1);
        const enterPos = view.state.doc.line(enterLine).to;
        view.dispatch({
          selection: { anchor: enterPos },
          scrollIntoView: true,
        });
        return true;
      }

      // 3. 检查上一行是否是 Mermaid 流程图的结束行
      const mermaids = findMermaidBlocks(view.state);
      const targetMermaid = mermaids.find((m) => m.endLine === prevLineNum);
      if (targetMermaid) {
        const enterLine = Math.max(targetMermaid.startLine, targetMermaid.endLine - 1);
        const enterPos = view.state.doc.line(enterLine).to;
        view.dispatch({
          selection: { anchor: enterPos },
          scrollIntoView: true,
        });
        return true;
      }

      return false;
    },
  },
];

export const boundaryTraversalExtension = keymap.of(boundaryTraversalKeymap);
