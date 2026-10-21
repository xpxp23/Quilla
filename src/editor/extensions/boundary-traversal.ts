import { EditorSelection } from "@codemirror/state";
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
 * 优先调用 CodeMirror 原生 moveVertically 探测是否仍在同一逻辑行内部折行，
 * 避免 line.from 处于隐藏语法标记 (Decoration.replace) 或含行内公式/代码胶囊时因 6px 固定容差误判导致乱跳行 (Bug #1)
 */
function isOnFirstVisualLine(view: EditorView, pos: number, lineFrom: number): boolean {
  if (pos <= lineFrom) return true;
  try {
    const lineNum = view.state.doc.lineAt(pos).number;
    const probe = view.moveVertically(EditorSelection.cursor(pos), false);
    if (probe.head !== pos && view.state.doc.lineAt(probe.head).number === lineNum) {
      return false;
    }
    const curCoords = view.coordsAtPos(pos);
    const startCoords = view.coordsAtPos(lineFrom, 1);
    if (!curCoords || !startCoords) return true;
    const rowHeight = Math.max(12, curCoords.bottom - curCoords.top);
    return Math.abs(curCoords.top - startCoords.top) < rowHeight * 0.65;
  } catch {
    return true;
  }
}

/**
 * 检测光标是否位于当前逻辑行的最后一个视觉软换行行 (Last Visual Row)
 * 优先调用 CodeMirror 原生 moveVertically 探测是否仍在同一逻辑行内部折行，
 * 避免 line.to 处于隐藏语法标记（如 `](url)` 或 `**`）内导致坐标失真而提前跨行乱窜 (Bug #1)
 */
function isOnLastVisualLine(view: EditorView, pos: number, lineTo: number): boolean {
  if (pos >= lineTo) return true;
  try {
    const lineNum = view.state.doc.lineAt(pos).number;
    const probe = view.moveVertically(EditorSelection.cursor(pos), true);
    if (probe.head !== pos && view.state.doc.lineAt(probe.head).number === lineNum) {
      return false;
    }
    const curCoords = view.coordsAtPos(pos);
    const endCoords = view.coordsAtPos(lineTo, -1);
    if (!curCoords || !endCoords) return true;
    const rowHeight = Math.max(12, curCoords.bottom - curCoords.top);
    return Math.abs(curCoords.bottom - endCoords.bottom) < rowHeight * 0.65;
  } catch {
    return true;
  }
}

/**
 * 跨块垂直导航时保留用户当前水平列位置 (Goal Column / X Coordinate)，
 * 彻底修复按上下方向键进出代码块、数学块、折叠章节时每次光标被强行重置到行首(.from)或行尾(.to)导致左右乱窜的问题 (Bug #1)
 */
function resolveTargetPosPreservingColumn(
  view: EditorView,
  sourcePos: number,
  targetLineNum: number
): number {
  const doc = view.state.doc;
  const clampedLineNum = Math.max(1, Math.min(targetLineNum, doc.lines));
  const srcLine = doc.lineAt(sourcePos);
  const tgtLine = doc.line(clampedLineNum);

  // 计算源行中的可见起始偏移（跳过被隐藏的标题 #、引用 >、列表前缀）
  const getVisibleStartCol = (lineText: string, lineNumber: number): number => {
    const struct = getDocStructureFromState(view.state);
    if (struct.codeLineSet.has(lineNumber)) return 0;
    const prefixMatch = lineText.match(
      /^(\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)?)/
    );
    return prefixMatch ? prefixMatch[0].length : 0;
  };

  const srcVisibleStart = getVisibleStartCol(srcLine.text, srcLine.number);
  const visualCol = Math.max(0, sourcePos - (srcLine.from + srcVisibleStart));

  // 优先尝试基于屏幕真实 X 坐标定位目标行对应字符位置
  try {
    const srcCoords = view.coordsAtPos(sourcePos);
    const tgtStartCoords = view.coordsAtPos(tgtLine.from, 1);
    if (srcCoords && tgtStartCoords) {
      const probePos = view.posAtCoords({
        x: srcCoords.left,
        y: (tgtStartCoords.top + tgtStartCoords.bottom) / 2,
      });
      if (
        probePos !== null &&
        probePos >= tgtLine.from &&
        probePos <= tgtLine.to
      ) {
        return probePos;
      }
    }
  } catch {
    // 回退至逻辑列偏移映射
  }

  const tgtVisibleStart = getVisibleStartCol(tgtLine.text, tgtLine.number);
  return Math.min(tgtLine.from + tgtVisibleStart + visualCol, tgtLine.to);
}

/**
 * 块级边界漫游扩展 (Widget Boundary Traversal v0.8):
 * 1. 基于原生 moveVertically 与自适应行高阈值精准识别软换行首/末视觉行，彻底根治按上/下箭头一次跳多行的 Bug。
 * 2. 跨代码块/折叠区/公式块时严格保持光标水平列坐标 (resolveTargetPosPreservingColumn)，杜绝光标忽左忽右乱窜。
 * 3. 感知代码块折叠态与 28 行自动截断态，防止光标跳入 display:none 隐藏行或引发代码块/折叠章节突然展开导致的视口暴跳。
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
      const foldedSpan = getFoldedSectionSpanAtLine(view.state, line.number);
      if (foldedSpan && line.number >= foldedSpan.startLine && line.number <= foldedSpan.endLine) {
        if (foldedSpan.endLine < totalLines) {
          const targetPos = resolveTargetPosPreservingColumn(
            view,
            head,
            foldedSpan.endLine + 1
          );
          view.dispatch({
            selection: { anchor: targetPos },
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

      // 0b. 检查围栏代码块边界穿透（兼容折叠态与 28 行截断态，严格保留水平列坐标）
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
              const afterPos = resolveTargetPosPreservingColumn(
                view,
                head,
                cr.endLine + 1
              );
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
          const targetPos = resolveTargetPosPreservingColumn(view, head, targetLineNum);
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
            const afterPos = resolveTargetPosPreservingColumn(
              view,
              head,
              cr.endLine + 1
            );
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
        const enterLine = Math.min(targetMath.startLine + 1, targetMath.endLine);
        const enterPos = resolveTargetPosPreservingColumn(view, head, enterLine);
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
        const enterLine = Math.min(targetMermaid.startLine + 1, targetMermaid.endLine);
        const enterPos = resolveTargetPosPreservingColumn(view, head, enterLine);
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
        // 0a. 检查上一行是否处于已折叠的章节内部 -> 直接跳到该折叠章节的标题行并保留列偏移
        const prevFoldedSpan = getFoldedSectionSpanAtLine(view.state, line.number - 1);
        if (prevFoldedSpan && line.number - 1 >= prevFoldedSpan.startLine) {
          const targetPos = resolveTargetPosPreservingColumn(
            view,
            head,
            prevFoldedSpan.startLine
          );
          view.dispatch({
            selection: { anchor: targetPos },
            scrollIntoView: true,
          });
          return true;
        }
      }

      // 0b. 检查围栏代码块边界穿透（兼容折叠态与 28 行截断态，严格保留水平列坐标）
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
            const beforePos = resolveTargetPosPreservingColumn(view, head, beforeLineNum);
            view.dispatch({ selection: { anchor: beforePos }, scrollIntoView: true });
            return true;
          }
          const targetPos = resolveTargetPosPreservingColumn(
            view,
            head,
            lastVisibleCodeLine
          );
          view.dispatch({
            selection: { anchor: targetPos },
            scrollIntoView: true,
          });
          return true;
        }

        // 在代码块第一行代码 (startLine + 1) 按 ArrowUp -> 直接跳出到代码块上方一行 (startLine - 1)
        if (line.number === cr.startLine + 1 || line.number === cr.startLine) {
          if (cr.startLine > 1) {
            const beforePos = resolveTargetPosPreservingColumn(
              view,
              head,
              cr.startLine - 1
            );
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
        const enterPos = resolveTargetPosPreservingColumn(view, head, enterLine);
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
        const enterPos = resolveTargetPosPreservingColumn(view, head, enterLine);
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
