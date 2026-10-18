import { EditorSelection } from "@codemirror/state";
import { EditorView, MouseSelectionStyle } from "@codemirror/view";

/**
 * 基于原生浏览器 DOM 精准坐标计算文档位置，
 * 彻底绕过 CodeMirror 虚拟 HeightMap 测量误差累积导致的长文档底部光标下偏问题，
 * 同时避免鼠标拖拽框选经过行间空白或边缘时发生选区首尾跳变闪烁 (Bug #4)。
 */
export function getExactPosAtCoords(
  view: EditorView,
  x: number,
  y: number
): { pos: number; assoc: -1 | 1 } | null {
  const contentDOM = view.contentDOM;
  if (!contentDOM) return null;

  const contentRect = contentDOM.getBoundingClientRect();

  // 若坐标位于编辑内容区视口上下范围之外，交由 CodeMirror 原生 posAndSideAtCoords 平滑插值，
  // 严禁直接返回 0 或 doc.length 导致拖拽框选时瞬间全选整个文档而乱闪
  if (y < contentRect.top + 2 || y > contentRect.bottom - 2) {
    return null;
  }

  if (typeof document !== "undefined") {
    // 1. 先检查鼠标所在元素是否位于某一行 (.cm-line) 的水平留白区域（行首左侧或行尾右侧）
    const el = document.elementFromPoint(x, y);
    if (el && contentDOM.contains(el)) {
      // 如果落点在折叠占位的装饰部件或块级交互卡片内，交由原生计算
      if (
        el.closest(
          ".cm-code-header, .cm-code-expand-footer, .md-table, .md-mermaid-card, .md-math-block-card, .cm-frontmatter-card, .cm-transclusion-card, .cm-toc-card"
        )
      ) {
        return null;
      }

      const lineEl = el.closest(".cm-line") as HTMLElement | null;
      if (lineEl && contentDOM.contains(lineEl)) {
        try {
          const linePos = view.posAtDOM(lineEl, 0);
          const line = view.state.doc.lineAt(linePos);
          const rect = lineEl.getBoundingClientRect();
          // 仅当鼠标明确在行文本内容区最左侧之外时定位到行首
          if (x <= rect.left + 2) {
            return { pos: line.from, assoc: 1 };
          }
          // 若整行是空行，直接返回行首
          if (line.from === line.to) {
            return { pos: line.from, assoc: 1 };
          }
        } catch (_) {}
      }
    }

    // 2. 使用 Chromium / WebKit 标准 caretRangeFromPoint 精准解析字符内偏移
    let node: Node | null = null;
    let offset = 0;

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

    if (node && node !== contentDOM && contentDOM.contains(node)) {
      const parentEl =
        node.nodeType === Node.ELEMENT_NODE
          ? (node as HTMLElement)
          : node.parentElement;
      const hitLineEl = parentEl?.closest(".cm-line") as HTMLElement | null;
      const lineRect = hitLineEl?.getBoundingClientRect();
      // 校验命中行在垂直方向确实覆盖当前 y 坐标（容差 ±10px），严防行间大间距处 caretRangeFromPoint 跨行跳变
      const isVerticallyAligned =
        !lineRect || (y >= lineRect.top - 10 && y <= lineRect.bottom + 10);

      // 避免把装饰 Widget 内部的虚拟文本节点映射成行首位置导致跳闪
      if (
        isVerticallyAligned &&
        parentEl &&
        !parentEl.closest(
          ".cm-code-header, .cm-code-expand-footer, .cm-heading-fold-badge, .cm-callout-header, .cm-hr-widget"
        )
      ) {
        try {
          const pos = view.posAtDOM(node, offset);
          if (typeof pos === "number" && !isNaN(pos)) {
            const clamped = Math.max(0, Math.min(view.state.doc.length, pos));
            return { pos: clamped, assoc: 1 };
          }
        } catch (_) {}
      }
    }

    // 3. 若鼠标点击在某行的最右侧留白处且 caretRangeFromPoint 未命中文本节点
    if (el && contentDOM.contains(el)) {
      const lineEl = el.closest(".cm-line") as HTMLElement | null;
      if (lineEl && contentDOM.contains(lineEl)) {
        try {
          const linePos = view.posAtDOM(lineEl, 0);
          const line = view.state.doc.lineAt(linePos);
          const rect = lineEl.getBoundingClientRect();
          if (x >= rect.right - 4) {
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
      "button, a, input, select, textarea, .md-table, .md-mermaid-card, .md-math-block-card, .cm-link, .cm-code-header, .cm-code-expand-footer, .cm-block-handle, .cm-frontmatter-card"
    )
  ) {
    return null;
  }

  const resolvePosAt = (clientX: number, clientY: number, fallbackPos: number) => {
    return (
      getExactPosAtCoords(view, clientX, clientY) ||
      (view as any)._origPosAndSideAtCoords?.({ x: clientX, y: clientY }, false) ||
      view.posAndSideAtCoords({ x: clientX, y: clientY }, false) || {
        pos: fallbackPos,
        assoc: 1 as const,
      }
    );
  };

  const startCoord = { x: event.clientX, y: event.clientY };
  let start = resolvePosAt(startCoord.x, startCoord.y, view.state.selection.main.head);
  let lastValidCur = { ...start };

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
        lastValidCur.pos = update.changes.mapPos(lastValidCur.pos);
        startSel = startSel.map(update.changes);
      }
    },
    get(curEvent: MouseEvent, extend: boolean, multiple: boolean) {
      const cur = resolvePosAt(curEvent.clientX, curEvent.clientY, lastValidCur.pos);
      lastValidCur = cur;

      let range = rangeForClick(cur.pos, cur.assoc);
      if (start.pos !== cur.pos && !extend) {
        const startRange = rangeForClick(start.pos, start.assoc);
        const from = Math.min(startRange.from, range.from);
        const to = Math.max(startRange.to, range.to);
        range =
          start.pos <= cur.pos
            ? EditorSelection.range(from, to, 1)
            : EditorSelection.range(to, from, -1);
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
