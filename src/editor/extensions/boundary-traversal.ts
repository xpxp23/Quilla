import { EditorView, KeyBinding, keymap } from "@codemirror/view";
import { findTablesInDoc } from "./table-editor";
import { findMermaidBlocks } from "./mermaid-extension";
import { findMathBlocks } from "./math-block-extension";
import { getDocStructureFromState } from "./doc-structure";
import { getFoldedSectionSpanAtLine, getCodeBlockVisibleBounds } from "./live-preview";

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
 * 检测光标是否位于当前逻辑行的第一个视觉软换行行 (First Visual Row)
 * 防止在软换行长段落的第 2/3/4 视觉行按 ArrowUp 时直接跳过整段窜入上方块
 */
function isOnFirstVisualLine(view: EditorView, pos: number, lineFrom: number): boolean {
  if (pos <= lineFrom) return true;
  try {
    const curCoords = view.coordsAtPos(pos);
    const startCoords = view.coordsAtPos(lineFrom);
    if (!curCoords || !startCoords) return true;
    return Math.abs(curCoords.top - startCoords.top) < 6;
  } catch {
    return true;
  }
}

/**
 * 检测光标是否位于当前逻辑行的最后一个视觉软换行行 (Last Visual Row)
 * 防止在软换行长段落的第 1 视觉行按 ArrowDown 时直接跳过整段窜入下方块
 */
function isOnLastVisualLine(view: EditorView, pos: number, lineTo: number): boolean {
  if (pos >= lineTo) return true;
  try {
    const curCoords = view.coordsAtPos(pos);
    const endCoords = view.coordsAtPos(lineTo, -1);
    if (!curCoords || !endCoords) return true;
    return Math.abs(curCoords.bottom - endCoords.bottom) < 6;
  } catch {
    return true;
  }
}

/**
 * 块级边界漫游扩展 (Widget Boundary Traversal v0.7):
 * 1. 感知 EditorView.lineWrapping 软换行视觉行，仅在首/末视觉行触发跨块跳转，彻底根治按上/下箭头一次跳多行的 Bug。
 * 2. 感知代码块折叠态与 28 行自动截断态，防止光标跳入 display:none 隐藏行或引发代码块突然展开导致的视口暴跳。
 * 3. 当光标在已折叠标题行按 ArrowDown，或从已折叠章节下方按 ArrowUp 时，自动跨过整个被隐藏的折叠区间。
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

      // 若当前行发生了软换行且光标尚不在最后一个视觉行，交由 CodeMirror 原生逻辑在当前段落内下移一行
      if (!isOnLastVisualLine(view, head, line.to)) {
        return false;
      }

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

      // 0b. 检查围栏代码块边界穿透（兼容折叠态与 28 行截断态）
      for (let cIdx = 0; cIdx < struct.codeRanges.length; cIdx++) {
        const cr = struct.codeRanges[cIdx];
        if (cr.unclosed) continue;
        const { isCollapsed, lastVisibleCodeLine } = getCodeBlockVisibleBounds(
          view.state,
          cIdx
        );

        // 从代码块上方一行按 ArrowDown -> 若已折叠则直接跨到 cr.endLine + 1，否则进入第一行代码 (startLine + 1)
        if (line.number === cr.startLine - 1 || line.number === cr.startLine) {
          if (isCollapsed) {
            if (cr.endLine < totalLines) {
              const afterPos = view.state.doc.line(cr.endLine + 1).from;
              view.dispatch({ selection: { anchor: afterPos }, scrollIntoView: true });
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
          const targetLineNum = Math.min(cr.startLine + 1, cr.endLine);
          const targetPos = view.state.doc.line(targetLineNum).from;
          view.dispatch({
            selection: { anchor: targetPos },
            scrollIntoView: true,
          });
          return true;
        }

        // 在代码块最后一行可见代码 (lastVisibleCodeLine 或 endLine - 1) 按 ArrowDown -> 跨过底部围栏跳到代码块下方一行
        if (
          line.number === lastVisibleCodeLine ||
          line.number === cr.endLine - 1 ||
          line.number === cr.endLine
        ) {
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

      // 若当前行发生了软换行且光标尚不在第一个视觉行，交由 CodeMirror 原生逻辑在当前段落内上移一行
      if (!isOnFirstVisualLine(view, head, line.from)) {
        return false;
      }

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

      // 0b. 检查围栏代码块边界穿透（兼容折叠态与 28 行截断态）
      for (let cIdx = 0; cIdx < struct.codeRanges.length; cIdx++) {
        const cr = struct.codeRanges[cIdx];
        if (cr.unclosed) continue;
        const { isCollapsed, lastVisibleCodeLine } = getCodeBlockVisibleBounds(
          view.state,
          cIdx
        );

        // 从代码块下方一行 (endLine + 1) 按 ArrowUp -> 若已折叠则跨到 startLine - 1，否则跳入最后一行可见代码 (lastVisibleCodeLine)
        if (line.number === cr.endLine + 1 || line.number === cr.endLine) {
          if (isCollapsed) {
            const beforeLineNum = Math.max(1, cr.startLine - 1);
            const beforePos = view.state.doc.line(beforeLineNum).to;
            view.dispatch({ selection: { anchor: beforePos }, scrollIntoView: true });
            return true;
          }
          const targetPos = view.state.doc.line(lastVisibleCodeLine).to;
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
