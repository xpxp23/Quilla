import { EditorSelection } from "@codemirror/state";
import { EditorView, MouseSelectionStyle } from "@codemirror/view";

/**
 * 基于原生浏览器 DOM 精准坐标计算文档位置，
 * 彻底绕过 CodeMirror 虚拟 HeightMap 测量误差累积导致的长文档底部光标下偏问题
 */
export function getExactPosAtCoords(
  view: EditorView,
  x: number,
  y: number
): { pos: number; assoc: -1 | 1 } | null {
  const contentDOM = view.contentDOM;
  if (!contentDOM) return null;

  const contentRect = contentDOM.getBoundingClientRect();

  // 若点击在内容区上方
  if (y < contentRect.top) {
    return { pos: 0, assoc: 1 };
  }
  // 若点击在内容区下方
  if (y > contentRect.bottom) {
    return { pos: view.state.doc.length, assoc: -1 };
  }

  if (typeof document !== "undefined") {
    let node: Node | null = null;
    let offset = 0;

    // 1. 首选 Chromium / WebKit 标准 caretRangeFromPoint
    if ((document as any).caretRangeFromPoint) {
      const range = (document as any).caretRangeFromPoint(x, y);
      if (range) {
        node = range.startContainer;
        offset = range.startOffset;
      }
    } else if ((document as any).caretPositionFromPoint) {
      const cp = (document as any).caretPositionFromPoint(x, y);
      if (cp) {
        node = cp.offsetNode;
        offset = cp.offset;
      }
    }

    if (node && contentDOM.contains(node)) {
      try {
        const pos = view.posAtDOM(node, offset);
        if (typeof pos === "number" && !isNaN(pos)) {
          const clamped = Math.max(0, Math.min(view.state.doc.length, pos));
          return { pos: clamped, assoc: 1 };
        }
      } catch (_) {}
    }

    // 2. 若点击在某行的空白处（如行尾右侧空白留白区）
    const el = document.elementFromPoint(x, y);
    if (el && contentDOM.contains(el)) {
      const lineEl = el.closest(".cm-line") as HTMLElement | null;
      if (lineEl && contentDOM.contains(lineEl)) {
        try {
          const linePos = view.posAtDOM(lineEl, 0);
          const line = view.state.doc.lineAt(linePos);
          const rect = lineEl.getBoundingClientRect();
          if (x >= rect.right) {
            return { pos: line.to, assoc: -1 };
          } else if (x <= rect.left) {
            return { pos: line.from, assoc: 1 };
          } else {
            return { pos: line.to, assoc: -1 };
          }
        } catch (_) {}
      }
    }
  }

  return null;
}

function getClickType(event: MouseEvent): number {
  return event.detail || 1;
}

export function createPreciseMouseSelection(
  view: EditorView,
  event: MouseEvent
): MouseSelectionStyle | null {
  if (event.button !== 0) return null;

  // 避免干扰按钮、超链接或内置交互式组件内部的独立点击
  const target = event.target as HTMLElement | null;
  if (
    target?.closest(
      "button, a, input, select, textarea, .md-table, .md-mermaid-card, .md-math-block-card, .cm-link"
    )
  ) {
    return null;
  }

  const startCoord = { x: event.clientX, y: event.clientY };
  let start =
    getExactPosAtCoords(view, startCoord.x, startCoord.y) ||
    (view as any)._origPosAndSideAtCoords?.(startCoord, false) ||
    view.posAndSideAtCoords(startCoord, false) || { pos: 0, assoc: 1 as const };

  const type = getClickType(event);
  let startSel = view.state.selection;

  function rangeForClick(pos: number, assoc: -1 | 1): any {
    if (type === 1) {
      return EditorSelection.cursor(pos, assoc);
    } else if (type === 2) {
      const word = view.state.wordAt(pos);
      if (word) {
        return EditorSelection.range(word.from, word.to);
      }
      return EditorSelection.cursor(pos, assoc);
    } else {
      const line = view.state.doc.lineAt(pos);
      const to = Math.min(line.to + 1, view.state.doc.length);
      return EditorSelection.range(line.from, to);
    }
  }

  return {
    update(update) {
      if (update.docChanged) {
        start.pos = update.changes.mapPos(start.pos);
        startSel = startSel.map(update.changes);
      }
    },
    get(curEvent: MouseEvent, extend: boolean, multiple: boolean) {
      const cur =
        getExactPosAtCoords(view, curEvent.clientX, curEvent.clientY) ||
        (view as any)._origPosAndSideAtCoords?.(
          { x: curEvent.clientX, y: curEvent.clientY },
          false
        ) ||
        view.posAndSideAtCoords({ x: curEvent.clientX, y: curEvent.clientY }, false) || {
          pos: 0,
          assoc: 1 as const,
        };

      let range = rangeForClick(cur.pos, cur.assoc);
      if (start.pos !== cur.pos && !extend) {
        const startRange = rangeForClick(start.pos, start.assoc);
        const from = Math.min(startRange.from, range.from);
        const to = Math.max(startRange.to, range.to);
        range =
          from < range.from
            ? EditorSelection.range(from, to, range.assoc)
            : EditorSelection.range(to, from, range.assoc);
      }

      if (extend) {
        return startSel.replaceRange(startSel.main.extend(range.from, range.to, range.assoc));
      } else if (multiple) {
        return startSel.addRange(range);
      } else {
        return EditorSelection.create([range]);
      }
    },
  };
}

export const preciseCursorExtension = EditorView.mouseSelectionStyle.of(
  createPreciseMouseSelection
);
