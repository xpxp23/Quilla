import { EditorSelection } from "@codemirror/state";
import { EditorView, KeyBinding, keymap } from "@codemirror/view";
import { findTablesInDoc } from "./table-editor";
import { findMermaidBlocks } from "./mermaid-extension";
import { findMathBlocks } from "./math-block-extension";
import { getDocStructureFromState } from "./doc-structure";
import { getFoldedSectionSpanAtLine, getCodeBlockVisibleBounds } from "./live-preview";
import { getExactPosAtCoords } from "./precise-cursor";

/**
 * 按编辑器实例独立维护连续上下方向键移动时的水平基准列记忆 (Goal X Memory)
 * - 采用相对于 .cm-content 内容区左边缘的像素偏移 relX，100% 免疫左侧 260px 侧边栏开关与垂直滚动影响；
 * - 一旦用户通过鼠标点击、打字或按左右键改变了光标 head，自动失效并重新采样当前光标的真实 X 坐标。
 */
const goalXMemory = new WeakMap<
  EditorView,
  { lastHead: number; relX: number; clientX: number }
>();

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
 * 注意：排除 `---` / `***` 水平分割线，防止将 `---` 误判为无序列表前缀
 */
export function getVisibleStartCol(
  view: EditorView,
  lineText: string,
  lineNumber: number
): number {
  const struct = getDocStructureFromState(view.state);
  if (struct.codeLineSet.has(lineNumber)) return 0;
  if (/^\s*(?:>\s*)*(\-{3,}|\*{3,}|_{3,})\s*$/.test(lineText)) return 0;
  const prefixMatch = lineText.match(
    /^(\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)?)/
  );
  return prefixMatch ? prefixMatch[0].length : 0;
}

/**
 * 查找指定文档位置所在逻辑行对应的真实 `.cm-line` DOM 节点及其去除内边距后的文字内容区上下边界
 * 彻底解决 `.cm-heading-1` 等大 padding-top 标题行导致原生坐标探测落入留白区而卡死或跳行的问题
 */
function getLineContentBox(
  view: EditorView,
  lineFrom: number
): {
  lineEl: HTMLElement;
  rect: DOMRect;
  contentTop: number;
  contentBottom: number;
} | null {
  try {
    const domHit = view.domAtPos(lineFrom);
    const node = domHit.node;
    let el =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as HTMLElement)
        : node.parentElement;
    if (!el) return null;

    let lineEl: HTMLElement | null = null;
    if (el.classList.contains("cm-line")) {
      lineEl = el;
    } else {
      lineEl = el.closest(".cm-line") as HTMLElement | null;
      if (!lineEl && el === view.contentDOM && domHit.offset < el.childNodes.length) {
        const candidate = el.childNodes[domHit.offset] as HTMLElement;
        if (candidate?.classList?.contains("cm-line")) {
          lineEl = candidate;
        }
      }
    }
    if (!lineEl) return null;

    const rect = lineEl.getBoundingClientRect();
    if (rect.height <= 0) return null;

    const style = window.getComputedStyle(lineEl);
    const padTop = parseFloat(style.paddingTop) || 0;
    const padBottom = parseFloat(style.paddingBottom) || 0;
    const contentTop = rect.top + padTop;
    const contentBottom = Math.max(contentTop + 4, rect.bottom - padBottom);
    return { lineEl, rect, contentTop, contentBottom };
  } catch {
    return null;
  }
}

/**
 * 计算中英文混合字符串的等宽显示列宽（CJK 全角字符计 2 列，ASCII 计 1 列）
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
 * 获取当前光标的真实屏幕水平 X 坐标（视口 clientX 坐标系，与 CodeMirror SelectionRange.goalColumn 严格对齐）
 */
function resolveCursorGoalX(
  view: EditorView,
  pos: number
): { screenX: number | null; goalColumn: number | undefined; relX: number | null } {
  const contentRect = view.contentDOM.getBoundingClientRect();
  const mem = goalXMemory.get(view);
  if (mem && mem.lastHead === pos && contentRect.width > 0) {
    const screenX = contentRect.left + mem.relX;
    return {
      screenX,
      goalColumn: screenX,
      relX: mem.relX,
    };
  }

  const line = view.state.doc.lineAt(pos);
  const visibleStart = line.from + getVisibleStartCol(view, line.text, line.number);
  const measurePos = Math.min(line.to, Math.max(pos, visibleStart));
  const mainRange = view.state.selection.main;
  const coords =
    view.coordsAtPos(measurePos, mainRange.assoc || 1) ||
    view.coordsAtPos(measurePos, -1) ||
    view.coordsAtPos(pos, 1);

  if (!coords) {
    return { screenX: null, goalColumn: undefined, relX: null };
  }

  const relX = Math.max(0, coords.left - contentRect.left);
  goalXMemory.set(view, {
    lastHead: pos,
    relX,
    clientX: coords.left,
  });

  return {
    screenX: coords.left,
    goalColumn: coords.left,
    relX,
  };
}

/**
 * 检测光标是否位于当前逻辑行的第一个视觉软换行行 (First Visual Row)
 */
function isOnFirstVisualLine(view: EditorView, pos: number, lineFrom: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const visibleStart = lineFrom + getVisibleStartCol(view, line.text, line.number);
  if (pos <= visibleStart) return true;
  try {
    const assoc = view.state.selection.main.assoc || 1;
    const curCoords =
      view.coordsAtPos(pos, assoc) || view.coordsAtPos(pos, (assoc === 1 ? -1 : 1) as -1 | 1);
    const box = getLineContentBox(view, lineFrom);
    if (curCoords && box) {
      const rowHeight = Math.max(15, curCoords.bottom - curCoords.top);
      return curCoords.top - box.contentTop < rowHeight * 0.6;
    }

    const activeRange =
      view.state.selection.main.head === pos
        ? view.state.selection.main
        : EditorSelection.cursor(pos);
    const probe = view.moveVertically(activeRange, false);
    if (probe.head !== pos && view.state.doc.lineAt(probe.head).number === line.number) {
      return false;
    }
    const startCoords =
      view.coordsAtPos(Math.min(visibleStart, line.to), 1) || view.coordsAtPos(lineFrom, 1);
    if (!curCoords || !startCoords) return true;
    const rowHeight = Math.max(15, curCoords.bottom - curCoords.top);
    return Math.abs(curCoords.top - startCoords.top) < rowHeight * 0.65;
  } catch {
    return true;
  }
}

/**
 * 检测光标是否位于当前逻辑行的最后一个视觉软换行行 (Last Visual Row)
 */
function isOnLastVisualLine(view: EditorView, pos: number, lineTo: number): boolean {
  if (pos >= lineTo) return true;
  try {
    const line = view.state.doc.lineAt(pos);
    const visibleStart = line.from + getVisibleStartCol(view, line.text, line.number);
    const measurePos = Math.min(line.to, Math.max(pos, visibleStart));
    const assoc = view.state.selection.main.assoc || 1;
    const curCoords =
      view.coordsAtPos(measurePos, assoc) ||
      view.coordsAtPos(measurePos, (assoc === 1 ? -1 : 1) as -1 | 1);
    const box = getLineContentBox(view, line.from);
    if (curCoords && box) {
      const rowHeight = Math.max(15, curCoords.bottom - curCoords.top);
      return box.contentBottom - curCoords.bottom < rowHeight * 0.6;
    }

    const activeRange =
      view.state.selection.main.head === pos
        ? view.state.selection.main
        : EditorSelection.cursor(pos);
    const probe = view.moveVertically(activeRange, true);
    if (probe.head !== pos && view.state.doc.lineAt(probe.head).number === line.number) {
      return false;
    }
    const endCoords = view.coordsAtPos(lineTo, -1);
    if (!curCoords || !endCoords) return true;
    const rowHeight = Math.max(15, curCoords.bottom - curCoords.top);
    return Math.abs(curCoords.bottom - endCoords.bottom) < rowHeight * 0.65;
  } catch {
    return true;
  }
}

/**
 * 当当前逻辑行发生了软换行（包含多个视觉行）且光标不在边界视觉行时，
 * 精准在当前逻辑行内向上或向下移动 1 个视觉行，同时严格保护行首隐藏前缀不弹开、水平基准列不漂移
 */
function stepWithinSoftWrappedLine(
  view: EditorView,
  pos: number,
  direction: "down" | "up"
): boolean {
  const line = view.state.doc.lineAt(pos);
  if (line.from === line.to) return false;

  const visibleStart = line.from + getVisibleStartCol(view, line.text, line.number);
  const measurePos = Math.min(line.to, Math.max(pos, visibleStart));
  const assoc = view.state.selection.main.assoc || 1;
  const curCoords =
    view.coordsAtPos(measurePos, assoc) ||
    view.coordsAtPos(measurePos, (assoc === 1 ? -1 : 1) as -1 | 1);
  if (!curCoords) return false;

  const { screenX, goalColumn, relX } = resolveCursorGoalX(view, pos);
  const rowHeight = Math.max(16, curCoords.bottom - curCoords.top);
  const probeY =
    direction === "down"
      ? curCoords.bottom + Math.min(12, rowHeight * 0.48)
      : curCoords.top - Math.min(12, rowHeight * 0.48);

  let targetPos: number | null = null;
  let targetAssoc: -1 | 1 = direction === "down" ? 1 : -1;

  if (screenX !== null) {
    const exact = getExactPosAtCoords(view, screenX, probeY);
    if (exact && exact.pos >= line.from && exact.pos <= line.to) {
      targetPos = exact.pos;
      targetAssoc = exact.assoc;
    } else {
      const sideHit = view.posAndSideAtCoords({ x: screenX, y: probeY }, false);
      if (sideHit && sideHit.pos >= line.from && sideHit.pos <= line.to) {
        targetPos = sideHit.pos;
        targetAssoc = sideHit.assoc;
      }
    }
  }

  if (
    targetPos === null ||
    (direction === "down" && targetPos <= pos) ||
    (direction === "up" && targetPos >= pos)
  ) {
    const seedCursor = EditorSelection.cursor(measurePos, assoc, undefined, goalColumn);
    const moved = view.moveVertically(seedCursor, direction === "down");
    if (
      moved.head !== pos &&
      moved.head >= line.from &&
      moved.head <= line.to
    ) {
      targetPos = moved.head;
      targetAssoc = moved.assoc || targetAssoc;
    }
  }

  if (targetPos === null) return false;
  const clampedPos = Math.min(line.to, Math.max(visibleStart, targetPos));
  if (clampedPos === pos) return false;

  const cursor = EditorSelection.cursor(clampedPos, targetAssoc, undefined, goalColumn);
  view.dispatch({
    selection: EditorSelection.create([cursor]),
    scrollIntoView: true,
    userEvent: "select",
  });
  if (relX !== null && screenX !== null) {
    goalXMemory.set(view, { lastHead: clampedPos, relX, clientX: screenX });
  }
  return true;
}

/**
 * 跨行/跨块垂直导航时保留用户当前水平列位置 (Goal Column / X Coordinate)，并感知进入方向 (v0.9.1 彻底根治版)：
 * - 当 enterFromBottom = false (按 ArrowDown 从上往下进) 时，基于目标 `.cm-line` 的 contentTop 定位到【第一视觉行】；
 * - 当 enterFromBottom = true (按 ArrowUp 从下往上进) 时，基于目标 `.cm-line` 的 contentBottom 定位到【最后一个视觉行】；
 * - 始终将落点限制在 `tgtVisibleFromPos`（隐藏的 `# / > / - / 1.` 之后），杜绝上下移动光标时行首 Markdown 符号突然弹出导致排版跳动。
 */
function resolveTargetPosPreservingColumn(
  view: EditorView,
  sourcePos: number,
  targetLineNum: number,
  enterFromBottom: boolean = false
): { pos: number; assoc: -1 | 1 } {
  const doc = view.state.doc;
  const clampedLineNum = Math.max(1, Math.min(targetLineNum, doc.lines));
  const srcLine = doc.lineAt(sourcePos);
  const tgtLine = doc.line(clampedLineNum);

  if (tgtLine.from === tgtLine.to) {
    return { pos: tgtLine.from, assoc: 1 };
  }

  const srcVisibleStart = getVisibleStartCol(view, srcLine.text, srcLine.number);
  const tgtVisibleStart = getVisibleStartCol(view, tgtLine.text, tgtLine.number);
  const tgtVisibleFromPos = Math.min(tgtLine.to, tgtLine.from + tgtVisibleStart);

  // 1. 优先基于真实 .cm-line 内容盒 (contentTop / contentBottom) 与 screenX 精准命中目标视觉行
  try {
    const { screenX } = resolveCursorGoalX(view, sourcePos);
    if (screenX !== null) {
      let probeY: number | null = null;
      const box = getLineContentBox(view, tgtLine.from);
      if (box) {
        const innerSpan = Math.max(8, box.contentBottom - box.contentTop);
        const inset = Math.min(11, innerSpan * 0.35);
        probeY = enterFromBottom
          ? box.contentBottom - inset
          : box.contentTop + inset;
      } else {
        const anchorPos = enterFromBottom ? tgtLine.to : tgtVisibleFromPos;
        const anchorBias: -1 | 1 = enterFromBottom ? -1 : 1;
        const tgtEdgeCoords =
          view.coordsAtPos(anchorPos, anchorBias) || view.coordsAtPos(tgtLine.from, 1);
        if (tgtEdgeCoords) {
          probeY = (tgtEdgeCoords.top + tgtEdgeCoords.bottom) / 2;
        }
      }

      if (probeY !== null) {
        const exact = getExactPosAtCoords(view, screenX, probeY);
        if (exact && exact.pos >= tgtLine.from && exact.pos <= tgtLine.to) {
          return {
            pos: Math.max(tgtVisibleFromPos, exact.pos),
            assoc: exact.assoc,
          };
        }
        const sideHit = view.posAndSideAtCoords({ x: screenX, y: probeY }, false);
        if (sideHit && sideHit.pos >= tgtLine.from && sideHit.pos <= tgtLine.to) {
          return {
            pos: Math.max(tgtVisibleFromPos, sideHit.pos),
            assoc: sideHit.assoc,
          };
        }
        const probePos = view.posAtCoords({ x: screenX, y: probeY });
        if (probePos !== null && probePos >= tgtLine.from && probePos <= tgtLine.to) {
          return {
            pos: Math.max(tgtVisibleFromPos, probePos),
            assoc: enterFromBottom ? -1 : 1,
          };
        }
      }
    }
  } catch {
    // 回退至 CJK 感知的视觉列宽映射
  }

  // 2. CJK 全角/半角感知的视觉列宽回退映射（当目标行尚未挂载到视口 DOM 时使用）
  const srcRelOffset = Math.max(0, sourcePos - (srcLine.from + srcVisibleStart));
  const visualDisplayWidth = computeVisualDisplayWidth(
    srcLine.text.slice(srcVisibleStart, srcVisibleStart + srcRelOffset)
  );
  const tgtBodyText = tgtLine.text.slice(tgtVisibleStart);
  const mappedBodyOffset = offsetAtVisualDisplayWidth(tgtBodyText, visualDisplayWidth);
  return {
    pos: Math.min(tgtLine.from + tgtVisibleStart + mappedBodyOffset, tgtLine.to),
    assoc: enterFromBottom ? -1 : 1,
  };
}

/**
 * 派发保留 goalColumn 的垂直光标移动事务，确保连续按上下箭头跨越任意行、空行与块级组件时水平基准列绝不丢失
 */
function dispatchVerticalCursorMove(
  view: EditorView,
  sourcePos: number,
  targetLineNum: number,
  enterFromBottom: boolean
): boolean {
  const { screenX, goalColumn, relX } = resolveCursorGoalX(view, sourcePos);
  const { pos: targetPos, assoc } = resolveTargetPosPreservingColumn(
    view,
    sourcePos,
    targetLineNum,
    enterFromBottom
  );
  const cursor = EditorSelection.cursor(targetPos, assoc, undefined, goalColumn);
  view.dispatch({
    selection: EditorSelection.create([cursor]),
    scrollIntoView: true,
    userEvent: "select",
  });
  if (relX !== null && screenX !== null) {
    goalXMemory.set(view, {
      lastHead: targetPos,
      relX,
      clientX: screenX,
    });
  }
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
 * 全场景逐视觉行垂直导航与块级边界漫游引擎 (Visual-Row & Boundary Traversal v0.9.1):
 * 1. 统一接管全文档所有行的 ArrowUp / ArrowDown，彻底告别 CodeMirror 默认 moveVertically 在大 padding 标题与隐藏前缀上的跳行/卡死顽疾；
 * 2. 基于真实 .cm-line 内容盒 (getLineContentBox) 精准执行软换行段落内部逐视觉行移动与跨行首/末视觉行进入；
 * 3. 采用相对于 .cm-content 的像素偏移记忆 (goalXMemory)，彻底修复 260px 侧边栏开启时 goalColumn 坐标系错位导致的左跳行首 Bug。
 */
export const boundaryTraversalKeymap: KeyBinding[] = [
  {
    key: "ArrowDown",
    run: (view: EditorView) => {
      if (typeof document !== "undefined" && document.body.classList.contains("source-mode")) {
        return false;
      }
      if (!view.state.selection.main.empty) {
        return false;
      }

      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      const totalLines = view.state.doc.lines;

      // 0. 若当前逻辑行发生了软换行且光标尚不在最后一个视觉行，直接在当前行内向下移动 1 个视觉行
      if (!isOnLastVisualLine(view, head, line.to)) {
        if (stepWithinSoftWrappedLine(view, head, "down")) {
          return true;
        }
      }

      const struct = getDocStructureFromState(view.state);

      // 1. 检查当前行是否是已折叠标题行（或正处于已折叠章节内部）
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

      // 2. 检查围栏代码块边界穿透（兼容折叠态与 28 行截断态，严格保留水平列坐标）
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

        // 在代码块最后一行可见代码 (lastVisibleCodeLine 或 endLine - 1) 按 ArrowDown -> 跨过底部 6px 收口围栏跳到代码块下方一行
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

      // 3. 检查下一行是否是表格块的起始行（按水平 X 坐标智能聚焦对应列）
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

      // 4. 检查下一行是否是多行数学公式块的起始行
      const mathBlocks = findMathBlocks(view.state);
      const targetMath = mathBlocks.find((m) => m.startLine === nextLineNum);
      if (targetMath) {
        const enterLine = Math.min(targetMath.startLine + 1, targetMath.endLine);
        return dispatchVerticalCursorMove(view, head, enterLine, false);
      }
      const currentMath = mathBlocks.find(
        (m) => line.number === m.endLine - 1 || line.number === m.endLine
      );
      if (currentMath && currentMath.endLine < totalLines) {
        return dispatchVerticalCursorMove(view, head, currentMath.endLine + 1, false);
      }

      // 5. 检查下一行是否是 Mermaid 流程图的起始行
      const mermaids = findMermaidBlocks(view.state);
      const targetMermaid = mermaids.find((m) => m.startLine === nextLineNum);
      if (targetMermaid) {
        const enterLine = Math.min(targetMermaid.startLine + 1, targetMermaid.endLine);
        return dispatchVerticalCursorMove(view, head, enterLine, false);
      }
      const currentMermaid = mermaids.find(
        (m) => line.number === m.endLine - 1 || line.number === m.endLine
      );
      if (currentMermaid && currentMermaid.endLine < totalLines) {
        return dispatchVerticalCursorMove(view, head, currentMermaid.endLine + 1, false);
      }

      // 6. 所有普通行（标题、段落、列表、引用块、Callout、分割线、空行）：确定性逐行下移至下一逻辑行的第一视觉行
      return dispatchVerticalCursorMove(view, head, nextLineNum, false);
    },
  },
  {
    key: "ArrowUp",
    run: (view: EditorView) => {
      if (typeof document !== "undefined" && document.body.classList.contains("source-mode")) {
        return false;
      }
      if (!view.state.selection.main.empty) {
        return false;
      }

      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      const struct = getDocStructureFromState(view.state);

      // 0. 若当前逻辑行发生了软换行且光标尚不在第一个视觉行，直接在当前行内向上移动 1 个视觉行
      if (!isOnFirstVisualLine(view, head, line.from)) {
        if (stepWithinSoftWrappedLine(view, head, "up")) {
          return true;
        }
      }

      if (line.number > 1) {
        // 1. 检查上一行是否处于已折叠的章节内部 -> 直接跳到该折叠章节的标题行并保留列偏移
        const prevFoldedSpan = getFoldedSectionSpanAtLine(view.state, line.number - 1);
        if (prevFoldedSpan && line.number - 1 >= prevFoldedSpan.startLine) {
          return dispatchVerticalCursorMove(view, head, prevFoldedSpan.startLine, true);
        }
      }

      // 2. 检查围栏代码块边界穿透（兼容折叠态与 28 行截断态，严格保留水平列坐标并落入目标行最后视觉行）
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

      // 3. 检查上一行是否是表格块的结束行（按水平 X 坐标聚焦末行对应列）
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

      // 4. 检查上一行是否是多行公式块的结束行
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

      // 5. 检查上一行是否是 Mermaid 流程图的结束行
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

      // 6. 所有普通行（标题、段落、列表、引用块、Callout、分割线、空行）：确定性逐行上移至上一逻辑行的最后一个视觉行
      return dispatchVerticalCursorMove(view, head, prevLineNum, true);
    },
  },
];

export const boundaryTraversalExtension = keymap.of(boundaryTraversalKeymap);
