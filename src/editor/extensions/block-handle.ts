import { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { resolveSemanticBlockSpanFromState } from "./doc-structure";

/**
 * 计算给定行所属的完整语义块行号区间（支持表格、围栏代码块、Mermaid、多行公式块、Callout、连续引用块及多块框选范围）
 */
export function resolveSemanticBlockSpan(
  state: EditorState,
  lineNum: number
): { startLine: number; endLine: number } {
  const baseSpan = resolveSemanticBlockSpanFromState(state, lineNum);
  const sel = state.selection.main;
  if (!sel.empty) {
    const selStartLine = state.doc.lineAt(sel.from).number;
    const selEndLine = state.doc.lineAt(Math.max(sel.from, sel.to - 1)).number;
    if (lineNum >= selStartLine && lineNum <= selEndLine && selEndLine > selStartLine) {
      const firstBlock = resolveSemanticBlockSpanFromState(state, selStartLine);
      const lastBlock = resolveSemanticBlockSpanFromState(state, selEndLine);
      return {
        startLine: Math.min(baseSpan.startLine, firstBlock.startLine),
        endLine: Math.max(baseSpan.endLine, lastBlock.endLine),
      };
    }
  }
  return baseSpan;
}

/**
 * 基于 Pointer Events 的段落/块级左侧拖拽手柄 (⋮⋮ Block Handle)
 * - 彻底摒弃受 Tauri WebView 拦截影响的原生 HTML5 draggable
 * - 精确计算标题/代码块/表格的 padding-top 与首行 lineHeight，使抓手严格对齐首行文字左侧垂直中线
 * - 支持多块框选批量拖拽、圆点锚点指示线、半透明残影预览与视口边缘自动滚屏
 * - 采用局部区间原子替换 (Local Range Changes) 替代全文替换，完美保留光标与 Ctrl+Z 撤销视口稳定性
 */
export const blockHandlePlugin = ViewPlugin.fromClass(
  class {
    private handle: HTMLElement;
    private dropIndicator: HTMLElement;
    private dragGhost: HTMLElement;
    private activeLineEl: HTMLElement | null = null;
    private activeLineNum: number = -1;
    private sourceSpan: { startLine: number; endLine: number } | null = null;
    private targetSpan: { startLine: number; endLine: number } | null = null;
    private insertAfterTarget: boolean = false;
    private isPointerDown = false;
    private isDragging = false;
    private startX = 0;
    private startY = 0;
    private rafMoveId: number | null = null;
    private autoScrollRaf: number | null = null;

    constructor(private view: EditorView) {
      this.handle = document.createElement("div");
      this.handle.className = "cm-block-handle";
      this.handle.title = "单击全选当前块（或框选多块），按住上下拖动重排位置";
      this.handle.innerHTML = `
        <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
          <circle cx="3.5" cy="2.5" r="1.3" />
          <circle cx="8.5" cy="2.5" r="1.3" />
          <circle cx="3.5" cy="7" r="1.3" />
          <circle cx="8.5" cy="7" r="1.3" />
          <circle cx="3.5" cy="11.5" r="1.3" />
          <circle cx="8.5" cy="11.5" r="1.3" />
        </svg>
      `;

      this.dropIndicator = document.createElement("div");
      this.dropIndicator.className = "cm-block-drop-indicator";
      this.dropIndicator.style.display = "none";

      this.dragGhost = document.createElement("div");
      this.dragGhost.className = "quilla-drag-ghost hidden";
      document.body.appendChild(this.dragGhost);

      const scroller = view.scrollDOM;
      scroller.appendChild(this.handle);
      scroller.appendChild(this.dropIndicator);

      this.setupListeners();
    }

    private getLineNumberFromElement(el: HTMLElement): number {
      const fromAttr = el.dataset.fromPos || el.dataset.from;
      if (fromAttr) {
        const pos = parseInt(fromAttr, 10);
        if (!Number.isNaN(pos)) {
          return this.view.state.doc.lineAt(Math.min(pos, this.view.state.doc.length)).number;
        }
      }
      try {
        const pos = this.view.posAtDOM(el);
        return this.view.state.doc.lineAt(Math.min(pos, this.view.state.doc.length)).number;
      } catch {
        return Math.max(1, this.activeLineNum);
      }
    }

    private findBlockElementAtY(clientY: number): HTMLElement | null {
      const scroller = this.view.scrollDOM;
      const scrollerRect = scroller.getBoundingClientRect();
      const relY = clientY - scrollerRect.top + scroller.scrollTop;
      try {
        const block = this.view.lineBlockAtHeight(relY);
        const domAtPos = this.view.domAtPos(block.from);
        const node =
          domAtPos.node.nodeType === Node.ELEMENT_NODE
            ? (domAtPos.node as HTMLElement)
            : domAtPos.node.parentElement;
        if (node) {
          const matched = node.closest(
            ".cm-line, .md-math-block-card, .md-mermaid-card, .table-figure, .cm-toc-card, .md-image-card"
          ) as HTMLElement | null;
          if (matched) {
            this.activeLineNum = this.view.state.doc.lineAt(block.from).number;
            return matched;
          }
        }
      } catch {
        // ignore
      }
      return null;
    }

    private setupListeners() {
      const scroller = this.view.scrollDOM;

      scroller.addEventListener(
        "mousemove",
        (e: MouseEvent) => {
          if (this.isPointerDown) return;
          if (typeof document !== "undefined" && document.body.classList.contains("source-mode")) {
            this.hideHandle();
            return;
          }

          const target = e.target as HTMLElement;
          if (target === this.handle || this.handle.contains(target)) return;

          if (this.rafMoveId !== null) return;
          this.rafMoveId = requestAnimationFrame(() => {
            this.rafMoveId = null;
            if (this.isPointerDown) return;

            let lineEl = target.closest(
              ".cm-line, .md-math-block-card, .md-mermaid-card, .table-figure, .cm-toc-card, .md-image-card"
            ) as HTMLElement | null;

            if (!lineEl || !lineEl.offsetParent) {
              const contentRect = this.view.contentDOM.getBoundingClientRect();
              if (e.clientX >= contentRect.left - 36 && e.clientX <= contentRect.right + 16) {
                lineEl = this.findBlockElementAtY(e.clientY);
              }
              if (!lineEl || !lineEl.offsetParent) {
                if (e.clientX < contentRect.left - 44 || e.clientX > contentRect.right + 20) {
                  this.hideHandle();
                }
                return;
              }
            } else {
              this.activeLineNum = this.getLineNumberFromElement(lineEl);
            }

            if (lineEl === this.activeLineEl && this.handle.classList.contains("visible")) {
              return;
            }
            this.activeLineEl = lineEl;
            this.updateHandlePosition(lineEl);
          });
        },
        { passive: true }
      );

      scroller.addEventListener("mouseleave", () => {
        if (!this.isPointerDown) {
          this.hideHandle();
        }
      });

      this.handle.addEventListener("pointerdown", (e: PointerEvent) => {
        if (e.button !== 0 || !this.activeLineEl) return;
        e.preventDefault();
        e.stopPropagation();

        try {
          const lineNum = this.getLineNumberFromElement(this.activeLineEl);
          this.sourceSpan = resolveSemanticBlockSpan(this.view.state, lineNum);
        } catch {
          return;
        }

        this.isPointerDown = true;
        this.isDragging = false;
        this.startX = e.clientX;
        this.startY = e.clientY;
        this.targetSpan = null;
        this.handle.setPointerCapture(e.pointerId);
      });

      this.handle.addEventListener("pointermove", (e: PointerEvent) => {
        if (!this.isPointerDown || !this.sourceSpan) return;

        const dx = e.clientX - this.startX;
        const dy = e.clientY - this.startY;
        if (!this.isDragging) {
          if (Math.hypot(dx, dy) < 5) return;
          this.isDragging = true;
          this.handle.classList.add("dragging");

          const doc = this.view.state.doc;
          const firstLineText =
            doc.line(this.sourceSpan.startLine).text.trim().slice(0, 32) || "(空行)";
          const lineCount = this.sourceSpan.endLine - this.sourceSpan.startLine + 1;
          this.dragGhost.textContent =
            lineCount > 1
              ? `⋮⋮ 移动 ${lineCount} 行块 · ${firstLineText}`
              : `⋮⋮ ${firstLineText}`;
          this.dragGhost.classList.remove("hidden");
        }

        this.dragGhost.style.left = `${e.clientX + 14}px`;
        this.dragGhost.style.top = `${e.clientY - 14}px`;

        // 视口上下边缘平滑自动滚屏
        const scrollerRect = scroller.getBoundingClientRect();
        if (e.clientY < scrollerRect.top + 42) {
          scroller.scrollTop -= 10;
        } else if (e.clientY > scrollerRect.bottom - 42) {
          scroller.scrollTop += 10;
        }

        const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
        let hoveredLine = this.view.state.doc.lines;
        if (pos !== null) {
          hoveredLine = this.view.state.doc.lineAt(pos).number;
        } else if (e.clientY < scrollerRect.top + 60) {
          hoveredLine = 1;
        }

        const tSpan = resolveSemanticBlockSpanFromState(this.view.state, hoveredLine);
        this.targetSpan = tSpan;

        // 若悬停在源块自身范围内，隐藏指示线
        if (
          tSpan.startLine >= this.sourceSpan.startLine &&
          tSpan.endLine <= this.sourceSpan.endLine
        ) {
          this.dropIndicator.style.display = "none";
          return;
        }

        // 判断插在目标块上方还是下方
        if (tSpan.startLine < this.sourceSpan.startLine) {
          this.insertAfterTarget = false;
        } else if (tSpan.endLine > this.sourceSpan.endLine) {
          this.insertAfterTarget = true;
        }

        const anchorLineNum = this.insertAfterTarget ? tSpan.endLine : tSpan.startLine;
        const anchorLine = this.view.state.doc.line(anchorLineNum);
        const coords = this.view.coordsAtPos(
          this.insertAfterTarget ? anchorLine.to : anchorLine.from
        );

        let indicatorTop = 0;
        if (coords) {
          const edgeY = this.insertAfterTarget ? coords.bottom + 4 : coords.top - 2;
          indicatorTop = edgeY - scrollerRect.top + scroller.scrollTop;
        } else {
          const blk = this.view.lineBlockAt(anchorLine.from);
          indicatorTop = this.insertAfterTarget ? blk.bottom : blk.top;
        }

        const contentRect = this.view.contentDOM.getBoundingClientRect();
        const style = window.getComputedStyle(this.view.contentDOM);
        const padLeft = parseFloat(style.paddingLeft) || 48;
        const padRight = parseFloat(style.paddingRight) || 48;

        this.dropIndicator.style.display = "block";
        this.dropIndicator.style.top = `${Math.round(indicatorTop)}px`;
        this.dropIndicator.style.left = `${Math.round(
          contentRect.left - scrollerRect.left + padLeft
        )}px`;
        this.dropIndicator.style.width = `${Math.round(
          Math.max(120, contentRect.width - padLeft - padRight)
        )}px`;
      });

      const finishPointer = (e: PointerEvent, commitDrop: boolean) => {
        if (!this.isPointerDown) return;
        this.isPointerDown = false;
        try {
          if (this.handle.hasPointerCapture(e.pointerId)) {
            this.handle.releasePointerCapture(e.pointerId);
          }
        } catch {
          // ignore
        }

        this.handle.classList.remove("dragging");
        this.dropIndicator.style.display = "none";
        this.dragGhost.classList.add("hidden");

        if (this.autoScrollRaf !== null) {
          cancelAnimationFrame(this.autoScrollRaf);
          this.autoScrollRaf = null;
        }

        const src = this.sourceSpan;
        const tgt = this.targetSpan;
        const wasDragging = this.isDragging;
        this.isDragging = false;
        this.sourceSpan = null;
        this.targetSpan = null;

        if (!src) return;

        // 单击（未发生拖拽）：全选当前语义块
        if (!wasDragging) {
          const from = this.view.state.doc.line(src.startLine).from;
          const to = this.view.state.doc.line(src.endLine).to;
          this.view.dispatch({
            selection: { anchor: from, head: to },
          });
          this.view.focus();
          return;
        }

        if (!commitDrop || !tgt) return;
        if (tgt.startLine >= src.startLine && tgt.endLine <= src.endLine) return;

        this.executeLocalizedBlockMove(src, tgt, this.insertAfterTarget);
      };

      this.handle.addEventListener("pointerup", (e) => finishPointer(e, true));
      this.handle.addEventListener("pointercancel", (e) => finishPointer(e, false));
    }

    /**
     * 局部受影響区间无损块重排（绝不触碰受影响行区间以外的文档内容，完美维持 Undo 历史与光标位置）
     */
    private executeLocalizedBlockMove(
      src: { startLine: number; endLine: number },
      tgt: { startLine: number; endLine: number },
      insertAfter: boolean
    ) {
      const doc = this.view.state.doc;
      const rangeStartLine = Math.min(src.startLine, tgt.startLine);
      const rangeEndLine = Math.max(src.endLine, tgt.endLine);

      const affectedLines: string[] = [];
      for (let ln = rangeStartLine; ln <= rangeEndLine; ln++) {
        affectedLines.push(doc.line(ln).text);
      }

      const relSrcStart = src.startLine - rangeStartLine;
      const srcCount = src.endLine - src.startLine + 1;
      const movingLines = affectedLines.slice(relSrcStart, relSrcStart + srcCount);
      const remaining = [
        ...affectedLines.slice(0, relSrcStart),
        ...affectedLines.slice(relSrcStart + srcCount),
      ];

      let relInsertIdx = insertAfter
        ? tgt.endLine - rangeStartLine + 1
        : tgt.startLine - rangeStartLine;
      if (relInsertIdx > relSrcStart) {
        relInsertIdx -= srcCount;
      }
      relInsertIdx = Math.max(0, Math.min(remaining.length, relInsertIdx));
      remaining.splice(relInsertIdx, 0, ...movingLines);

      const replaceFrom = doc.line(rangeStartLine).from;
      const replaceTo = doc.line(rangeEndLine).to;
      const newSegment = remaining.join("\n");

      // 计算移动后块首的精确字符偏移，使光标跟随移动块，保证 Ctrl+Z 不乱跳
      const beforeMovedText = remaining.slice(0, relInsertIdx).join("\n");
      const newBlockStartPos =
        replaceFrom + (relInsertIdx > 0 ? beforeMovedText.length + 1 : 0);

      this.view.dispatch({
        changes: { from: replaceFrom, to: replaceTo, insert: newSegment },
        selection: { anchor: newBlockStartPos },
        userEvent: "move.block",
      });
      this.view.focus();
    }

    private updateHandlePosition(lineEl: HTMLElement) {
      const scroller = this.view.scrollDOM;
      const lineRect = lineEl.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const style = window.getComputedStyle(lineEl);

      // 动态扣除标题/代码块的 padding-top，将 20px 高的抓手精确居中于首行文字中线
      const paddingTop = parseFloat(style.paddingTop) || 0;
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      const contentHeight = Math.max(20, lineRect.height - paddingTop - paddingBottom);
      const rawLineHeight = parseFloat(style.lineHeight);
      const firstLineHeight = !Number.isNaN(rawLineHeight)
        ? Math.min(rawLineHeight, contentHeight)
        : Math.min(contentHeight, 34);

      const handleHeight = 20;
      const boxTop = lineRect.top - scrollerRect.top + scroller.scrollTop;
      const alignedTop = boxTop + paddingTop + (firstLineHeight - handleHeight) / 2;

      // 水平紧贴在行元素左边界外侧 24px（处于 .cm-content 的 48px 左内边距热区内）
      const lineLeft = lineRect.left - scrollerRect.left + scroller.scrollLeft;
      const alignedLeft = Math.max(8, lineLeft - 24);

      this.handle.style.top = `${Math.round(alignedTop)}px`;
      this.handle.style.left = `${Math.round(alignedLeft)}px`;
      this.handle.classList.add("visible");
      this.handle.style.pointerEvents = "auto";
    }

    private hideHandle() {
      this.activeLineEl = null;
      this.handle.classList.remove("visible");
      this.handle.style.pointerEvents = "none";
    }

    update(update: ViewUpdate) {
      if (update.docChanged && this.activeLineEl && this.activeLineEl.isConnected) {
        this.updateHandlePosition(this.activeLineEl);
      }
    }

    destroy() {
      if (this.rafMoveId !== null) cancelAnimationFrame(this.rafMoveId);
      if (this.autoScrollRaf !== null) cancelAnimationFrame(this.autoScrollRaf);
      this.handle.remove();
      this.dropIndicator.remove();
      this.dragGhost.remove();
    }
  }
);
