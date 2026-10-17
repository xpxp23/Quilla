import { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { findTablesInDoc } from "./table-editor";
import { findMermaidBlocks } from "./mermaid-extension";
import { findMathBlocks } from "./math-block-extension";

/**
 * 计算给定行所属的完整语义块行号区间（表格、围栏代码块、Mermaid、多行公式块、连续引用块或单行段落），
 * 防止点击或拖拽手柄时将多行块撕裂。
 */
export function resolveSemanticBlockSpan(
  state: EditorState,
  lineNum: number
): { startLine: number; endLine: number } {
  const doc = state.doc;
  const clampedLine = Math.max(1, Math.min(doc.lines, lineNum));

  // 1. 表格块
  const tables = findTablesInDoc(state);
  for (const t of tables) {
    if (clampedLine >= t.startLine && clampedLine <= t.endLine) {
      return { startLine: t.startLine, endLine: t.endLine };
    }
  }

  // 2. Mermaid 块
  const mermaids = findMermaidBlocks(state);
  for (const m of mermaids) {
    if (clampedLine >= m.startLine && clampedLine <= m.endLine) {
      return { startLine: m.startLine, endLine: m.endLine };
    }
  }

  // 3. 多行公式块
  const mathBlocks = findMathBlocks(state);
  for (const mb of mathBlocks) {
    if (clampedLine >= mb.startLine && clampedLine <= mb.endLine) {
      return { startLine: mb.startLine, endLine: mb.endLine };
    }
  }

  // 4. 普通围栏代码块
  let inFence = false;
  let fenceStart = 1;
  let fenceChar = "";
  for (let i = 1; i <= doc.lines; i++) {
    const trimmed = doc.line(i).text.trim();
    if (/^(```+|~~~+)/.test(trimmed)) {
      const marker = trimmed.startsWith("`") ? "`" : "~";
      if (!inFence) {
        inFence = true;
        fenceStart = i;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        if (clampedLine >= fenceStart && clampedLine <= i) {
          return { startLine: fenceStart, endLine: i };
        }
        inFence = false;
      }
    }
  }

  // 5. 连续引用块 (> ...)：若当前行为纯引用段首或非列表项，整段引用块作为语义块
  const curText = doc.line(clampedLine).text;
  if (/^\s*>/.test(curText)) {
    const afterQuote = curText.replace(/^\s*(?:> ?)+/, "");
    if (!/^(\s*)([-*+]|\d+\.)\s+/.test(afterQuote)) {
      let qStart = clampedLine;
      while (qStart > 1 && /^\s*>/.test(doc.line(qStart - 1).text)) {
        qStart--;
      }
      let qEnd = clampedLine;
      while (qEnd < doc.lines && /^\s*>/.test(doc.line(qEnd + 1).text)) {
        qEnd++;
      }
      return { startLine: qStart, endLine: qEnd };
    }
  }

  return { startLine: clampedLine, endLine: clampedLine };
}

/**
 * Typora 经典段落/块级左侧拖拽手柄 (⋮⋮ Block Handle)
 * 鼠标悬浮在任意段落/块左侧显示柔和手柄，单击全选该语义块，拖动可上下重排整个块位置。
 */
export const blockHandlePlugin = ViewPlugin.fromClass(
  class {
    private handle: HTMLElement;
    private dropIndicator: HTMLElement;
    private activeLineEl: HTMLElement | null = null;
    private sourceSpan: { startLine: number; endLine: number } | null = null;
    private targetLineNum: number = -1;

    constructor(private view: EditorView) {
      this.handle = document.createElement("div");
      this.handle.className = "cm-block-handle";
      this.handle.setAttribute("draggable", "true");
      this.handle.title = "点击全选当前块，拖动上下重排位置";
      this.handle.innerHTML = `
        <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
          <circle cx="3.5" cy="2.5" r="1.25" />
          <circle cx="8.5" cy="2.5" r="1.25" />
          <circle cx="3.5" cy="7" r="1.25" />
          <circle cx="8.5" cy="7" r="1.25" />
          <circle cx="3.5" cy="11.5" r="1.25" />
          <circle cx="8.5" cy="11.5" r="1.25" />
        </svg>
      `;

      this.dropIndicator = document.createElement("div");
      this.dropIndicator.className = "cm-block-drop-indicator";
      this.dropIndicator.style.display = "none";

      const scroller = view.scrollDOM;
      scroller.appendChild(this.handle);
      scroller.appendChild(this.dropIndicator);

      this.setupListeners();
    }

    private getLineNumberFromElement(el: HTMLElement): number {
      if (el.dataset.fromPos) {
        const pos = parseInt(el.dataset.fromPos, 10);
        if (!Number.isNaN(pos)) {
          return this.view.state.doc.lineAt(Math.min(pos, this.view.state.doc.length)).number;
        }
      }
      const pos = this.view.posAtDOM(el);
      return this.view.state.doc.lineAt(pos).number;
    }

    private setupListeners() {
      const scroller = this.view.scrollDOM;

      scroller.addEventListener("mousemove", (e: MouseEvent) => {
        if (typeof document !== "undefined" && document.body.classList.contains("source-mode")) {
          this.hideHandle();
          return;
        }

        const target = e.target as HTMLElement;
        if (target === this.handle || this.handle.contains(target)) return;

        const lineEl = target.closest(
          ".cm-line, .md-math-block-card, .md-mermaid-card, .table-figure, .cm-toc-card"
        ) as HTMLElement | null;

        if (!lineEl || !lineEl.offsetParent) {
          const contentRect = this.view.contentDOM.getBoundingClientRect();
          if (e.clientX < contentRect.left - 48 || e.clientX > contentRect.right + 20) {
            this.hideHandle();
          }
          return;
        }

        this.activeLineEl = lineEl;
        this.updateHandlePosition(lineEl);
      });

      scroller.addEventListener("mouseleave", () => {
        this.hideHandle();
      });

      this.handle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!this.activeLineEl) return;
        try {
          const lineNum = this.getLineNumberFromElement(this.activeLineEl);
          const span = resolveSemanticBlockSpan(this.view.state, lineNum);
          const from = this.view.state.doc.line(span.startLine).from;
          const to = this.view.state.doc.line(span.endLine).to;
          this.view.dispatch({
            selection: { anchor: from, head: to },
          });
          this.view.focus();
        } catch {
          // ignore
        }
      });

      this.handle.addEventListener("dragstart", (e) => {
        if (!this.activeLineEl) return;
        try {
          const lineNum = this.getLineNumberFromElement(this.activeLineEl);
          this.sourceSpan = resolveSemanticBlockSpan(this.view.state, lineNum);
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData(
              "text/plain",
              `cm-block-span:${this.sourceSpan.startLine}-${this.sourceSpan.endLine}`
            );
          }
          this.handle.classList.add("dragging");
        } catch {
          // ignore
        }
      });

      this.handle.addEventListener("dragend", () => {
        this.handle.classList.remove("dragging");
        this.dropIndicator.style.display = "none";
        this.sourceSpan = null;
        this.targetLineNum = -1;
      });

      scroller.addEventListener("dragover", (e: DragEvent) => {
        if (!this.sourceSpan) return;
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = "move";
        }

        const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return;

        const hoveredLine = this.view.state.doc.lineAt(pos).number;
        const targetSpan = resolveSemanticBlockSpan(this.view.state, hoveredLine);
        this.targetLineNum =
          hoveredLine < this.sourceSpan.startLine ? targetSpan.startLine : targetSpan.endLine;

        const anchorLine = this.view.state.doc.line(this.targetLineNum);
        const coords = this.view.coordsAtPos(anchorLine.from);
        if (coords) {
          const scrollerRect = scroller.getBoundingClientRect();
          const top = coords.top - scrollerRect.top + scroller.scrollTop;
          this.dropIndicator.style.display = "block";
          this.dropIndicator.style.top = `${top}px`;
          this.dropIndicator.style.left = `${this.view.contentDOM.offsetLeft}px`;
          this.dropIndicator.style.width = `${this.view.contentDOM.clientWidth}px`;
        }
      });

      scroller.addEventListener("drop", (e: DragEvent) => {
        if (!this.sourceSpan || this.targetLineNum === -1) return;
        e.preventDefault();
        e.stopPropagation();

        const { startLine, endLine } = this.sourceSpan;
        const tgtNum = this.targetLineNum;
        this.dropIndicator.style.display = "none";
        this.sourceSpan = null;

        if (tgtNum >= startLine && tgtNum <= endLine) return;

        // 基于行数组无损切片重排，彻底避免末尾块上移时误吞前一行换行符
        const doc = this.view.state.doc;
        const allLines: string[] = [];
        for (let i = 1; i <= doc.lines; i++) {
          allLines.push(doc.line(i).text);
        }

        const srcZeroStart = startLine - 1;
        const srcCount = endLine - startLine + 1;
        const movingLines = allLines.slice(srcZeroStart, srcZeroStart + srcCount);
        const remainingLines = [
          ...allLines.slice(0, srcZeroStart),
          ...allLines.slice(srcZeroStart + srcCount),
        ];

        let insertIdx = endLine < tgtNum ? tgtNum - srcCount : tgtNum - 1;
        insertIdx = Math.max(0, Math.min(remainingLines.length, insertIdx));
        remainingLines.splice(insertIdx, 0, ...movingLines);

        this.view.dispatch({
          changes: { from: 0, to: doc.length, insert: remainingLines.join("\n") },
          userEvent: "move.block",
        });
        this.view.focus();
      });
    }

    private updateHandlePosition(lineEl: HTMLElement) {
      const scroller = this.view.scrollDOM;
      const lineRect = lineEl.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();

      const top = lineRect.top - scrollerRect.top + scroller.scrollTop;
      const contentLeft = this.view.contentDOM.offsetLeft;
      const left = Math.max(8, contentLeft - 28);

      this.handle.style.top = `${top + 3}px`;
      this.handle.style.left = `${left}px`;
      this.handle.classList.add("visible");
      this.handle.style.pointerEvents = "auto";
    }

    private hideHandle() {
      this.handle.classList.remove("visible");
      this.handle.style.pointerEvents = "none";
    }

    update(_update: ViewUpdate) {}

    destroy() {
      this.handle.remove();
      this.dropIndicator.remove();
    }
  }
);
