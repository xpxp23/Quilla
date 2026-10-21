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
 * 计算源行中隐藏的 Markdown 块级前缀长度（跳过 # 标题、> 引用、列表标记）
 */
function getVisibleStartCol(view: EditorView, lineText: string, lineNumber: number): number {
  const struct = getDocStructureFromState(view.state);
  if (struct.codeLineSet.has(lineNumber)) return 0;
  const prefixMatch = lineText.match(
    /^(\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)?)/
  );
  return prefixMatch ? prefixMatch[0].length : 0;
}

/**
 * 计算中英文混合字符串的等宽显示列宽（CJK 全角字符计 2 列，ASCII 计 1 列），
 * 解决无 DOM 坐标兜底时中英文宽度差异导致光标左右乱飞的问题
 */
function computeVisualDisplayWidth(str: string): number {
  let width = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      width += 2;
    } else if (code === 9) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function offsetAtVisualDisplayWidth(str: string, targetWidth: number): number {
  let acc = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const charW =
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
        ? 2
        : 1;
    if (acc + charW / 2 > targetWidth) {
      return i;
    }
    acc += charW;
  }
  return str.length;
}

/**
 * 获取当前光标的真实屏幕水平 X 坐标与 CodeMirror goalColumn
 */
function resolveCursorGoalX(
  view: EditorView,
  pos: number
): { screenX: number | null; goalColumn: number | undefined } {
  const mainRange = view.state.selection.main;
  const scrollerRect = view.scrollDOM.getBoundingClientRect();
  if (mainRange.goalColumn !== undefined) {
    return {
      screenX: scrollerRect.left + mainRange.goalColumn,
      goalColumn: mainRange.goalColumn,
    };
  }
  const coords = view.coordsAtPos(pos, mainRange.assoc || 1) || view.coordsAtPos(pos, -1);
  if (!coords) {
    return { screenX: null, goalColumn: undefined };
  }
  return {
    screenX: coords.left,
    goalColumn: coords.left - scrollerRect.left,
  };
}

/**
 * 检测光标是否位于当前逻辑行的第一个视觉软换行行 (First Visual Row)
 * 1. 直接复用携带 goalColumn 的当前真实选区调用 view.moveVertically，避免新建无记忆游标导致列漂移；
 * 2. 测量行首坐标时自动跳过被 Decoration.replace 隐藏的 # / > / - 前缀，彻底根治软换行列表/引用首行误判 (Bug #1)
 */
function isOnFirstVisualLine(view: EditorView, pos: number, lineFrom: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const visibleStart = lineFrom + getVisibleStartCol(view, line.text, line.number);
  if (pos <= visibleStart) return true;
  try {
    const activeRange =
      view.state.selection.main.head === pos
        ? view.state.selection.main
        : EditorSelection.cursor(pos);
    const probe = view.moveVertically(activeRange, false);
    if (probe.head !== pos && view.state.doc.lineAt(probe.head).number === line.number) {
      return false;
    }
    const curCoords = view.coordsAtPos(pos, -1) || view.coordsAtPos(pos, 1);
    const startCoords =
      view.coordsAtPos(Math.min(visibleStart, line.to), 1) || view.coordsAtPos(lineFrom, 1);
    if (!curCoords || !startCoords) return true;
    const rowHeight = Math.max(14, curCoords.bottom - curCoords.top);
    return Math.abs(curCoords.top - startCoords.top) < rowHeight * 0.65;
  } catch {
    return true;
  }
}

/**
 * 检测光标是否位于当前逻辑行的最后一个视觉软换行行 (Last Visual Row)
 * 优先复用携带 goalColumn 的当前真实选区调用 view.moveVertically 探测是否仍在同一逻辑行内折行
 */
function isOnLastVisualLine(view: EditorView, pos: number, lineTo: number): boolean {
  if (pos >= lineTo) return true;
  try {
    const lineNum = view.state.doc.lineAt(pos).number;
    const activeRange =
      view.state.selection.main.head === pos
        ? view.state.selection.main
        : EditorSelection.cursor(pos);
    const probe = view.moveVertically(activeRange, true);
    if (probe.head !== pos && view.state.doc.lineAt(probe.head).number === lineNum) {
      return false;
    }
    const curCoords = view.coordsAtPos(pos, 1) || view.coordsAtPos(pos, -1);
    const endCoords = view.coordsAtPos(lineTo, -1);
    if (!curCoords || !endCoords) return true;
    const rowHeight = Math.max(14, curCoords.bottom - curCoords.top);
    return Math.abs(curCoords.bottom - endCoords.bottom) < rowHeight * 0.65;
  } catch {
    return true;
  }
}

/**
 * 跨块垂直导航时保留用户当前水平列位置 (Goal Column / X Coordinate)，并感知进入方向 (v0.9 彻底根治版)：
 * - 当 enterFromBottom = false (按 ArrowDown 从上往下进) 时，定位到目标逻辑行的【第一视觉行】；
 * - 当 enterFromBottom = true (按 ArrowUp 从下往上进) 时，定位到目标逻辑行的【最后一个视觉行】，
 *   彻底修复按 ArrowUp 进入多行软换行段落时直接跳过中间所有折行飞到段落第一行的顽疾！
 */
function resolveTargetPosPreservingColumn(
  view: EditorView,
  sourcePos: number,
  targetLineNum: number,
  enterFromBottom: boolean = false
): number {
  const doc = view.state.doc;
  const clampedLineNum = Math.max(1, Math.min(targetLineNum, doc.lines));
  const srcLine = doc.lineAt(sourcePos);
  const tgtLine = doc.line(clampedLineNum);

  const srcVisibleStart = getVisibleStartCol(view, srcLine.text, srcLine.number);
  const tgtVisibleStart = getVisibleStartCol(view, tgtLine.text, tgtLine.number);
  const tgtVisibleFromPos = Math.min(tgtLine.to, tgtLine.from + tgtVisibleStart);

  // 1. 优先基于屏幕真实 X 坐标 (goalColumn) 与目标行首/末视觉行 Y 坐标精准命中
  try {
    const { screenX } = resolveCursorGoalX(view, sourcePos);
    const anchorPos = enterFromBottom ? tgtLine.to : tgtVisibleFromPos;
    const anchorBias = enterFromBottom ? -1 : 1;
    const tgtEdgeCoords =
      view.coordsAtPos(anchorPos, anchorBias) || view.coordsAtPos(tgtLine.from, 1);

    if (screenX !== null && tgtEdgeCoords) {
      const probeY = (tgtEdgeCoords.top + tgtEdgeCoords.bottom) / 2;
      const probePos = view.posAtCoords({ x: screenX, y: probeY });
      if (
        probePos !== null &&
        probePos >= tgtLine.from &&
        probePos <= tgtLine.to
      ) {
        return Math.max(tgtVisibleFromPos, probePos);
      }
    }
  } catch {
    // 回退至 CJK 感知的视觉列宽映射
  }

  // 2. CJK 全角/半角感知的视觉列宽回退映射
  const srcRelOffset = Math.max(0, sourcePos - (srcLine.from + srcVisibleStart));
  const visualDisplayWidth = computeVisualDisplayWidth(
    srcLine.text.slice(srcVisibleStart, srcVisibleStart + srcRelOffset)
  );
  const tgtBodyText = tgtLine.text.slice(tgtVisibleStart);
  const mappedBodyOffset = offsetAtVisualDisplayWidth(tgtBodyText, visualDisplayWidth);
  return Math.min(tgtLine.from + tgtVisibleStart + mappedBodyOffset, tgtLine.to);
}

/**
 * 派发保留 goalColumn 的垂直光标移动事务，确保连续按上下箭头跨越多个块时水平基准列绝不丢失
 */
function dispatchVerticalCursorMove(
  view: EditorView,
  sourcePos: number,
  targetLineNum: number,
  enterFromBottom: boolean
): boolean {
  const { goalColumn } = resolveCursorGoalX(view, sourcePos);
  const targetPos = resolveTargetPosPreservingColumn(
    view,
    sourcePos,
    targetLineNum,
    enterFromBottom
  );
  const cursor = EditorSelection.cursor(
    targetPos,
    enterFromBottom ? -1 : 1,
    undefined,
    goalColumn
  );
  view.dispatch({
    selection: EditorSelection.create([cursor]),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

/**
 * 根据当前光标的水平像素 X 坐标，在目标表格行中匹配对应列的单元格并落焦
 */
function focusTableCellMatchingX(
  view: EditorView,
  cells: NodeListOf<HTMLElement> | HTMLElement[],
  sourcePos: number,
  collapseToStart: boolean,
  syncDocPos: number
): boolean {
  if (!cells || cells.length === 0) return false;
  const { screenX } = resolveCursorGoalX(view, sourcePos);
  let chosenCell: HTMLElement = cells[0];

  if (screenX !== null) {
    let bestDist = Infinity;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const rect = c.getBoundingClientRect();
      if (rect.width <= 0) continue;
      if (screenX >= rect.left && screenX <= rect.right) {
        chosenCell = c;
        break;
      }
      const dist = screenX < rect.left ? rect.left - screenX : screenX - rect.right;
      if (dist < bestDist) {
        bestDist = dist;
        chosenCell = c;
      }
    }
  }

  // 同步更新 CodeMirror 选区至表格边界，杜绝 DOM Focus 与 CM6 Selection 脱节
  view.dispatch({
    selection: { anchor: syncDocPos },
    scrollIntoView: true,
  });

  const editorEl =
    (chosenCell.querySelector(".tbl-cell-editor") as HTMLElement) || chosenCell;
  editorEl.focus();
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(editorEl);
  range.collapse(collapseToStart);
  sel?.removeAllRanges();
  sel?.addRange(range);
  return true;
}

/**
 * 块级边界漫游扩展 (Widget Boundary Traversal v0.9):
 * 1. 基于原生 moveVertically（携带 goalColumn）与可见前缀偏移精准识别软换行首/末视觉行，彻底根治按上/下箭头一次跳多行的 Bug。
 * 2. 区分进入方向（下移进首视觉行、上移进末视觉行）并严格保持 goalColumn 像素列坐标，杜绝光标忽左忽右乱窜。
 * 3. 完整覆盖 YAML Front Matter、折叠章节、分割线 (---)、[TOC] 目录块、代码块、数学块、Mermaid 与表格，消除经过原子块时 Widget 突然卸载导致的巨幅重排。
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

      const struct = getDocStructureFromState(view.state);

      // 0. 顶部 YAML Front Matter 卡片穿透：当处于折叠卡片态时，按 ArrowDown 直接跳至正文首行 (frontMatterEndLine + 1)
      if (struct.frontMatterEndLine > 0 && line.number === 1) {
        if (struct.frontMatterEndLine < totalLines) {
          return dispatchVerticalCursorMove(
            view,
            head,
            struct.frontMatterEndLine + 1,
            false
          );
        }
        const endDoc = view.state.doc.line(struct.frontMatterEndLine).to;
        view.dispatch({
          changes: { from: endDoc, insert: "\n" },
          selection: { anchor: endDoc + 1 },
          scrollIntoView: true,
        });
        return true;
      }

      // 0a. 检查当前行是否是已折叠标题行（或正处于已折叠章节内部）
      const foldedSpan = getFoldedSectionSpanAtLine(view.state, line.number);
      if (foldedSpan && line.number >= foldedSpan.startLine && line.number <= foldedSpan.endLine) {
        if (foldedSpan.endLine < totalLines) {
          return dispatchVerticalCursorMove(view, head, foldedSpan.endLine + 1, false);
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
              return dispatchVerticalCursorMove(view, head, cr.endLine + 1, false);
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
          return dispatchVerticalCursorMove(view, head, targetLineNum, false);
        }

        // 在代码块最后一行可见代码 (lastVisibleCodeLine 或 endLine - 1) 按 ArrowDown -> 跨过底部围栏跳到代码块下方一行
        if (
          line.number === lastVisibleCodeLine ||
          line.number === cr.endLine - 1 ||
          line.number === cr.endLine
        ) {
          if (cr.endLine < totalLines) {
            return dispatchVerticalCursorMove(view, head, cr.endLine + 1, false);
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

      // 0c. 若下一行是连续的水平分割线 (---) 或 [TOC] 目录卡片，自动平滑跨过，防止方向键路过时卸载卡片引发视口抖动
      if (struct.hrLines.includes(nextLineNum) || struct.tocLines.includes(nextLineNum)) {
        let skipToLine = nextLineNum + 1;
        while (
          skipToLine <= totalLines &&
          (struct.hrLines.includes(skipToLine) || struct.tocLines.includes(skipToLine))
        ) {
          skipToLine++;
        }
        if (skipToLine <= totalLines) {
          return dispatchVerticalCursorMove(view, head, skipToLine, false);
        }
      }

      // 1. 检查下一行是否是表格块的起始行（按水平 X 坐标智能聚焦对应列）
      const tables = findTablesInDoc(view.state);
      const targetTableIdx = tables.findIndex((t) => t.startLine === nextLineNum);
      if (targetTableIdx !== -1) {
        const targetTable = tables[targetTableIdx];
        const tbl = findMatchingTableElement(view, targetTable.from, targetTableIdx);
        const thList = tbl?.querySelectorAll<HTMLElement>("thead th, tr:first-child th");
        if (thList && thList.length > 0) {
          return focusTableCellMatchingX(view, thList, head, true, targetTable.from);
        }
      }

      // 2. 检查下一行是否是多行数学公式块的起始行
      const mathBlocks = findMathBlocks(view.state);
      const targetMath = mathBlocks.find((m) => m.startLine === nextLineNum);
      if (targetMath) {
        const enterLine = Math.min(targetMath.startLine + 1, targetMath.endLine);
        return dispatchVerticalCursorMove(view, head, enterLine, false);
      }
      // 在多行数学公式块的最后一行内容 (endLine - 1) 按 ArrowDown -> 直接跳出到 endLine + 1
      const currentMath = mathBlocks.find(
        (m) => line.number === m.endLine - 1 || line.number === m.endLine
      );
      if (currentMath) {
        if (currentMath.endLine < totalLines) {
          return dispatchVerticalCursorMove(view, head, currentMath.endLine + 1, false);
        }
      }

      // 3. 检查下一行是否是 Mermaid 流程图的起始行
      const mermaids = findMermaidBlocks(view.state);
      const targetMermaid = mermaids.find((m) => m.startLine === nextLineNum);
      if (targetMermaid) {
        const enterLine = Math.min(targetMermaid.startLine + 1, targetMermaid.endLine);
        return dispatchVerticalCursorMove(view, head, enterLine, false);
      }
      const currentMermaid = mermaids.find(
        (m) => line.number === m.endLine - 1 || line.number === m.endLine
      );
      if (currentMermaid) {
        if (currentMermaid.endLine < totalLines) {
          return dispatchVerticalCursorMove(view, head, currentMermaid.endLine + 1, false);
        }
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

      // 0. 顶部 YAML Front Matter 保护：在正文第一行 (frontMatterEndLine + 1) 按 ArrowUp 时不踏入隐藏的 YAML 内部行
      if (
        struct.frontMatterEndLine > 0 &&
        line.number === struct.frontMatterEndLine + 1
      ) {
        return true;
      }

      if (line.number > 1) {
        // 0a. 检查上一行是否处于已折叠的章节内部 -> 直接跳到该折叠章节的标题行并保留列偏移
        const prevFoldedSpan = getFoldedSectionSpanAtLine(view.state, line.number - 1);
        if (prevFoldedSpan && line.number - 1 >= prevFoldedSpan.startLine) {
          return dispatchVerticalCursorMove(view, head, prevFoldedSpan.startLine, true);
        }
      }

      // 0b. 检查围栏代码块边界穿透（兼容折叠态与 28 行截断态，严格保留水平列坐标并落入目标行最后视觉行）
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
            return dispatchVerticalCursorMove(view, head, beforeLineNum, true);
          }
          return dispatchVerticalCursorMove(view, head, lastVisibleCodeLine, true);
        }

        // 在代码块第一行代码 (startLine + 1) 按 ArrowUp -> 直接跳出到代码块上方一行 (startLine - 1) 的【最后视觉行】
        if (line.number === cr.startLine + 1 || line.number === cr.startLine) {
          if (cr.startLine > 1) {
            return dispatchVerticalCursorMove(view, head, cr.startLine - 1, true);
          }
          return false;
        }
      }

      if (line.number <= 1) return false;
      const prevLineNum = line.number - 1;

      // 0c. 若上一行是水平分割线 (---) 或 [TOC] 目录卡片，平滑向上跨过并落入上方段落的最后视觉行
      if (struct.hrLines.includes(prevLineNum) || struct.tocLines.includes(prevLineNum)) {
        let skipToLine = prevLineNum - 1;
        while (
          skipToLine >= 1 &&
          (struct.hrLines.includes(skipToLine) || struct.tocLines.includes(skipToLine))
        ) {
          skipToLine--;
        }
        if (skipToLine >= 1) {
          return dispatchVerticalCursorMove(view, head, skipToLine, true);
        }
      }

      // 1. 检查上一行是否是表格块的结束行（按水平 X 坐标聚焦末行对应列）
      const tables = findTablesInDoc(view.state);
      const targetTableIdx = tables.findIndex((t) => t.endLine === prevLineNum);
      if (targetTableIdx !== -1) {
        const targetTable = tables[targetTableIdx];
        const tbl = findMatchingTableElement(view, targetTable.from, targetTableIdx);
        if (tbl) {
          const rows = tbl.querySelectorAll("tbody tr");
          if (rows.length > 0) {
            const lastRow = rows[rows.length - 1];
            const tdList = lastRow.querySelectorAll<HTMLElement>("td");
            if (tdList.length > 0) {
              return focusTableCellMatchingX(view, tdList, head, false, targetTable.to);
            }
          }
        }
      }

      // 2. 检查上一行是否是多行公式块的结束行
      const mathBlocks = findMathBlocks(view.state);
      const targetMath = mathBlocks.find((m) => m.endLine === prevLineNum);
      if (targetMath) {
        const enterLine = Math.max(targetMath.startLine, targetMath.endLine - 1);
        return dispatchVerticalCursorMove(view, head, enterLine, true);
      }
      const currentMath = mathBlocks.find(
        (m) => line.number === m.startLine + 1 || line.number === m.startLine
      );
      if (currentMath && currentMath.startLine > 1) {
        return dispatchVerticalCursorMove(view, head, currentMath.startLine - 1, true);
      }

      // 3. 检查上一行是否是 Mermaid 流程图的结束行
      const mermaids = findMermaidBlocks(view.state);
      const targetMermaid = mermaids.find((m) => m.endLine === prevLineNum);
      if (targetMermaid) {
        const enterLine = Math.max(targetMermaid.startLine, targetMermaid.endLine - 1);
        return dispatchVerticalCursorMove(view, head, enterLine, true);
      }
      const currentMermaid = mermaids.find(
        (m) => line.number === m.startLine + 1 || line.number === m.startLine
      );
      if (currentMermaid && currentMermaid.startLine > 1) {
        return dispatchVerticalCursorMove(view, head, currentMermaid.startLine - 1, true);
      }

      // 4. 普通段落间的 ArrowUp：若上一行是软换行多行段落且带有隐藏前缀，确保原生移动不会因行首 replace 跳到第一视觉行
      const prevLine = view.state.doc.line(prevLineNum);
      if (
        !struct.codeLineSet.has(prevLineNum) &&
        prevLine.length > 35 &&
        getVisibleStartCol(view, prevLine.text, prevLineNum) > 0
      ) {
        return dispatchVerticalCursorMove(view, head, prevLineNum, true);
      }

      return false;
    },
  },
];

export const boundaryTraversalExtension = keymap.of(boundaryTraversalKeymap);
