import { EditorView, KeyBinding, keymap } from "@codemirror/view";
import { findTablesInDoc } from "./table-editor";
import { findMermaidBlocks } from "./mermaid-extension";
import { findMathBlocks } from "./math-block-extension";
import { getDocStructureFromState } from "./doc-structure";
import { getFoldedSectionSpanAtLine } from "./live-preview";

/**
 * 根据目标表格块起始坐标精准查找对应的 DOM 表格元素
 */
function findMatchingTableElement(
  view: EditorView,
  tableFromPos: number,
  tableIdx: number
): HTMLElement | null {
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
 * 块级边界漫游扩展 (Widget Boundary Traversal v0.6):
 * 1. 当光标在已折叠标题行按 ArrowDown，或从已折叠章节下方按 ArrowUp 时，自动跨过整个被隐藏的折叠区间，杜绝光标掉入 display:none 黑洞。
 * 2. 当光标在普通正文行移动时，如果按 ArrowDown/ArrowUp 遇到块级元素 (围栏代码块、表格、Mermaid 流程图、多行公式块)，
 *    自动无缝跨过 ``` 围栏行穿透进入代码内容或下一个段落。
 */
export const boundaryTraversalKeymap: KeyBinding[] = [
  {
    key: "ArrowDown",
    run: (view: EditorView) => {
      if (typeof document !== "undefined" && document.body.classList.contains("source-mode")) {
        return false;
      }
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      const totalLines = view.state.doc.lines;

      // 0a. 检查当前行是否是已折叠标题行（或正处于已折叠章节内部）
      const foldedSpan =
        getFoldedSectionSpanAtLine(view.state, line.number) ||
        (line.number < totalLines ? getFoldedSectionSpanAtLine(view.state, line.number + 1) : null);
      if (foldedSpan && line.number >= foldedSpan.startLine && line.number <= foldedSpan.endLine) {
        if (foldedSpan.endLine < totalLines) {
          const nextVisibleLine = view.state.doc.line(foldedSpan.endLine + 1);
          view.dispatch({
            selection: { anchor: nextVisibleLine.from },
            scrollIntoView: true,
          });
        } else {
          const endDoc = view.state.doc.line(foldedSpan.endLine).to;
          view.dispatch({
            changes: { from: endDoc, insert: "\n" },
            selection: { anchor: endDoc + 1 },
            scrollIntoView: true,
          });
        }
        return true;
      }

      const struct = getDocStructureFromState(view.state);

      // 0b. 检查当前行是否位于普通围栏代码块最后一行代码 (endLine - 1)，或者正要从代码块上方进入 startLine
      for (const cr of struct.codeRanges) {
        if (cr.unclosed) continue;
        // 从代码块上方一行按 ArrowDown -> 直接跳入第一行代码 (startLine + 1)，跳过 ```lang 顶栏
        if (line.number === cr.startLine - 1 || line.number === cr.startLine) {
          const targetLineNum = Math.min(cr.startLine + 1, cr.endLine);
          const targetPos = view.state.doc.line(targetLineNum).from;
          view.dispatch({
            selection: { anchor: targetPos },
            scrollIntoView: true,
          });
          return true;
        }
        // 在代码块最后一行代码 (endLine - 1) 按 ArrowDown -> 直接跨过底部 ``` 围栏跳到代码块下方一行
        if (line.number === cr.endLine - 1 || line.number === cr.endLine) {
          if (cr.endLine < totalLines) {
            const afterPos = view.state.doc.line(cr.endLine + 1).from;
            view.dispatch({
              selection: { anchor: afterPos },
              scrollIntoView: true,
            });
          } else {
            const endDoc = view.state.doc.line(cr.endLine).to;
            view.dispatch({
              changes: { from: endDoc, insert: "\n" },
              selection: { anchor: endDoc + 1 },
              scrollIntoView: true,
            });
          }
          return true;
        }
      }

      if (line.number >= totalLines) return false;
      const nextLineNum = line.number + 1;

      // 1. 检查下一行是否是表格块的起始行
      const tables = findTablesInDoc(view.state);
      const targetTableIdx = tables.findIndex((t) => t.startLine === nextLineNum);
      if (targetTableIdx !== -1) {
        const targetTable = tables[targetTableIdx];
        const tbl = findMatchingTableElement(view, targetTable.from, targetTableIdx);
        const firstTh = tbl?.querySelector<HTMLElement>("th");
        if (firstTh) {
          const editorEl = (firstTh.querySelector(".tbl-cell-editor") as HTMLElement) || firstTh;
          editorEl.focus();
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents(editorEl);
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
      if (typeof document !== "undefined" && document.body.classList.contains("source-mode")) {
        return false;
      }
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      const struct = getDocStructureFromState(view.state);

      if (line.number > 1) {
        // 0a. 检查上一行是否处于已折叠的章节内部 -> 直接跳到该折叠章节的标题行
        const prevFoldedSpan = getFoldedSectionSpanAtLine(view.state, line.number - 1);
        if (prevFoldedSpan && line.number - 1 > prevFoldedSpan.startLine) {
          const headingLine = view.state.doc.line(prevFoldedSpan.startLine);
          view.dispatch({
            selection: { anchor: headingLine.to },
            scrollIntoView: true,
          });
          return true;
        }
      }

      // 0b. 检查围栏代码块边界穿透
      for (const cr of struct.codeRanges) {
        if (cr.unclosed) continue;
        // 从代码块下方一行 (endLine + 1) 按 ArrowUp -> 直接跳入最后一行代码 (endLine - 1)，跳过底部 ``` 围栏
        if (line.number === cr.endLine + 1 || line.number === cr.endLine) {
          const targetLineNum = Math.max(cr.startLine + 1, cr.endLine - 1);
          const targetPos = view.state.doc.line(targetLineNum).to;
          view.dispatch({
            selection: { anchor: targetPos },
            scrollIntoView: true,
          });
          return true;
        }
        // 在代码块第一行代码 (startLine + 1) 按 ArrowUp -> 直接跳出到代码块上方一行 (startLine - 1)
        if (line.number === cr.startLine + 1 || line.number === cr.startLine) {
          if (cr.startLine > 1) {
            const beforePos = view.state.doc.line(cr.startLine - 1).to;
            view.dispatch({
              selection: { anchor: beforePos },
              scrollIntoView: true,
            });
            return true;
          }
          return false;
        }
      }

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
              const editorEl =
                (firstTd.querySelector(".tbl-cell-editor") as HTMLElement) || firstTd;
              editorEl.focus();
              const range = document.createRange();
              const sel = window.getSelection();
              range.selectNodeContents(editorEl);
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
