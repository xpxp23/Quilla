import { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import {
  resolveSemanticBlockSpanFromState,
  getDocStructureFromState,
  stripInlineMarkdown,
} from "./doc-structure";
import { toggleHeadingLevel } from "./formatting-keymap";
import { toggleHeadingFoldAtLine, isHeadingFoldedAtLine } from "./live-preview";
import { showToast } from "../../components/save-dialog";

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
 * 局部受影响区间无损块重排（供抓手拖拽、抓手菜单上移/下移块及 Alt+Up/Down 快捷键共用）
 */
export function executeBlockSpanMove(
  view: EditorView,
  src: { startLine: number; endLine: number },
  tgt: { startLine: number; endLine: number },
  insertAfter: boolean
): boolean {
  if (tgt.startLine >= src.startLine && tgt.endLine <= src.endLine) return false;

  const doc = view.state.doc;
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

  const beforeMovedText = remaining.slice(0, relInsertIdx).join("\n");
  const newBlockStartPos =
    replaceFrom + (relInsertIdx > 0 ? beforeMovedText.length + 1 : 0);

  view.dispatch({
    changes: { from: replaceFrom, to: replaceTo, insert: newSegment },
    selection: { anchor: newBlockStartPos },
    scrollIntoView: true,
    userEvent: "move.block",
  });
  view.focus();
  return true;
}

/**
 * 快捷键/菜单：将当前光标所在语义块向上或向下移动一个语义块 (Alt+ArrowUp / Alt+ArrowDown)
 */
export function moveCurrentSemanticBlock(view: EditorView, direction: -1 | 1): boolean {
  const state = view.state;
  const doc = state.doc;
  const curLine = doc.lineAt(state.selection.main.head).number;
  const src = resolveSemanticBlockSpan(state, curLine);

  if (direction === -1) {
    if (src.startLine <= 1) return false;
    let prevLine = src.startLine - 1;
    // 若上一行是空行且再上一行存在非空块，连同跨过相隔空行或与上一行互换
    const tgt = resolveSemanticBlockSpanFromState(state, prevLine);
    return executeBlockSpanMove(view, src, tgt, false);
  } else {
    if (src.endLine >= doc.lines) return false;
    const nextLine = src.endLine + 1;
    const tgt = resolveSemanticBlockSpanFromState(state, nextLine);
    return executeBlockSpanMove(view, src, tgt, true);
  }
}

/**
 * 快捷键/菜单：原位克隆当前语义块 (Ctrl+D / Cmd+D)
 */
export function duplicateCurrentSemanticBlock(view: EditorView, targetSpan?: { startLine: number; endLine: number }): boolean {
  const state = view.state;
  const doc = state.doc;
  const curLine = doc.lineAt(state.selection.main.head).number;
  const span = targetSpan || resolveSemanticBlockSpan(state, curLine);
  const from = doc.line(span.startLine).from;
  const to = doc.line(span.endLine).to;
  const blockText = state.sliceDoc(from, to);
  const insertText = `\n${blockText}`;

  view.dispatch({
    changes: { from: to, to, insert: insertText },
    selection: { anchor: to + 1 },
    scrollIntoView: true,
    userEvent: "input.duplicate",
  });
  view.focus();
  return true;
}

let activeBlockMenuEl: HTMLElement | null = null;
function closeBlockContextMenu() {
  if (activeBlockMenuEl) {
    activeBlockMenuEl.remove();
    activeBlockMenuEl = null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("click", () => closeBlockContextMenu());
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeBlockContextMenu();
  });
}

/**
 * 基于 Pointer Events 的段落/块级左侧拖拽手柄 (⋮⋮ Block Handle v0.5)
 * - 彻底摒弃失真的 view.lineBlockAtHeight(relY)，直接基于 contentDOM.children 真实 DOM 几何边界探测，根治第 10 行左侧激活第 13 行抓手的串行 Bug
 * - 增设“左侧悬停桥接锁 (Hover Bridge Lock)”与扩宽热区，根治二级标题、超链接行移向抓手时抓手瞬移消失指不上的问题
 * - 新增思源笔记/Notion 风格块级右键与点击操作菜单（块类型转换、章节折叠、克隆、上下移动、复制块源码/纯文本、删除块）
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
      this.handle.title = "点击或右键打开块级操作菜单 · 按住上下拖动重排位置";
      this.handle.innerHTML = `
        <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
          <circle cx="3.5" cy="2.5" r="1.35" />
          <circle cx="8.5" cy="2.5" r="1.35" />
          <circle cx="3.5" cy="7" r="1.35" />
          <circle cx="8.5" cy="7" r="1.35" />
          <circle cx="3.5" cy="11.5" r="1.35" />
          <circle cx="8.5" cy="11.5" r="1.35" />
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
        const pos = this.view.posAtDOM(el, 0);
        return this.view.state.doc.lineAt(Math.min(pos, this.view.state.doc.length)).number;
      } catch {
        return Math.max(1, this.activeLineNum);
      }
    }

    /**
     * 基于浏览器真实 DOM 渲染几何矩形 (getBoundingClientRect) 查找 clientY 对应的块级元素
     * 彻底消除 CodeMirror 虚拟 HeightMap 在含标题/代码块/表格 margin 时的跨行偏移串行问题
     */
    private findBlockElementAtY(clientY: number): HTMLElement | null {
      const children = this.view.contentDOM.children;
      let closestEl: HTMLElement | null = null;
      let minDistance = Infinity;

      for (let i = 0; i < children.length; i++) {
        const el = children[i] as HTMLElement;
        if (!el || el.classList.contains("cm-Gap")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.height <= 1) continue;

        if (clientY >= rect.top && clientY <= rect.bottom) {
          this.activeLineNum = this.getLineNumberFromElement(el);
          return el;
        }

        const dist = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom;
        if (dist < minDistance && dist <= 18) {
          minDistance = dist;
          closestEl = el;
        }
      }

      if (closestEl) {
        this.activeLineNum = this.getLineNumberFromElement(closestEl);
      }
      return closestEl;
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
          if (target === this.handle || this.handle.contains(target)) {
            this.handle.classList.add("visible");
            return;
          }

          if (this.rafMoveId !== null) return;
          this.rafMoveId = requestAnimationFrame(() => {
            this.rafMoveId = null;
            if (this.isPointerDown) return;

            // 悬停桥接锁 (Hover Bridge Lock)：当鼠标正从当前活动行向左移动去触碰抓手时，
            // 只要纵坐标仍在当前活动行或抓手热区范围内，严格锁定当前行绝不跳变
            if (
              this.activeLineEl &&
              this.activeLineEl.isConnected &&
              this.handle.classList.contains("visible")
            ) {
              const handleRect = this.handle.getBoundingClientRect();
              const activeRect = this.activeLineEl.getBoundingClientRect();
              const inHorizontalBridge =
                e.clientX >= handleRect.left - 10 && e.clientX <= activeRect.left + 8;
              const inVerticalBridge =
                (e.clientY >= handleRect.top - 10 && e.clientY <= handleRect.bottom + 10) ||
                (e.clientY >= activeRect.top - 4 && e.clientY <= activeRect.bottom + 4);
              if (inHorizontalBridge && inVerticalBridge) {
                return;
              }
            }

            let lineEl = target.closest(
              ".cm-line, .md-math-block-card, .md-mermaid-card, .table-figure, .cm-toc-card, .md-image-card, .cm-frontmatter-card, .cm-transclusion-card"
            ) as HTMLElement | null;

            if (!lineEl || !lineEl.offsetParent) {
              const contentRect = this.view.contentDOM.getBoundingClientRect();
              if (e.clientX >= contentRect.left - 44 && e.clientX <= contentRect.right + 20) {
                lineEl = this.findBlockElementAtY(e.clientY);
              }
              if (!lineEl || !lineEl.offsetParent) {
                if (e.clientX < contentRect.left - 50 || e.clientX > contentRect.right + 24) {
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
        if (!this.isPointerDown && !activeBlockMenuEl) {
          this.hideHandle();
        }
      });

      // 右键抓手直接打开块级操作菜单
      this.handle.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!this.activeLineEl) return;
        const lineNum = this.getLineNumberFromElement(this.activeLineEl);
        const span = resolveSemanticBlockSpan(this.view.state, lineNum);
        this.openBlockActionMenu(e.clientX, e.clientY, span);
      });

      this.handle.addEventListener("pointerdown", (e: PointerEvent) => {
        if (e.button !== 0 || !this.activeLineEl) return;
        e.preventDefault();
        e.stopPropagation();
        closeBlockContextMenu();

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

        const hoveredEl = this.findBlockElementAtY(e.clientY);
        let hoveredLine = this.view.state.doc.lines;
        if (hoveredEl) {
          hoveredLine = this.getLineNumberFromElement(hoveredEl);
        } else if (e.clientY < scrollerRect.top + 60) {
          hoveredLine = 1;
        }

        const tSpan = resolveSemanticBlockSpanFromState(this.view.state, hoveredLine);
        this.targetSpan = tSpan;

        if (
          tSpan.startLine >= this.sourceSpan.startLine &&
          tSpan.endLine <= this.sourceSpan.endLine
        ) {
          this.dropIndicator.style.display = "none";
          return;
        }

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
        } else if (hoveredEl) {
          const r = hoveredEl.getBoundingClientRect();
          const edgeY = this.insertAfterTarget ? r.bottom + 2 : r.top - 2;
          indicatorTop = edgeY - scrollerRect.top + scroller.scrollTop;
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

        // 单击（未发生拖拽）：选中当前语义块并弹出轻量块级操作菜单
        if (!wasDragging) {
          const from = this.view.state.doc.line(src.startLine).from;
          const to = this.view.state.doc.line(src.endLine).to;
          this.view.dispatch({
            selection: { anchor: from, head: to },
          });
          this.view.focus();
          const hRect = this.handle.getBoundingClientRect();
          this.openBlockActionMenu(hRect.left, hRect.bottom + 4, src);
          return;
        }

        if (!commitDrop || !tgt) return;
        executeBlockSpanMove(this.view, src, tgt, this.insertAfterTarget);
      };

      this.handle.addEventListener("pointerup", (e) => finishPointer(e, true));
      this.handle.addEventListener("pointercancel", (e) => finishPointer(e, false));
    }

    /**
     * 弹出思源笔记 / Notion 风格块级操作菜单
     */
    private openBlockActionMenu(
      clientX: number,
      clientY: number,
      span: { startLine: number; endLine: number }
    ) {
      closeBlockContextMenu();

      const state = this.view.state;
      const doc = state.doc;
      const firstLine = doc.line(span.startLine);
      const isHeading = /^\s*(?:>\s*)*#{1,6}\s+/.test(firstLine.text);
      const isFolded = isHeading && isHeadingFoldedAtLine(this.view, span.startLine);

      const menu = document.createElement("div");
      menu.className = "ty-dropdown-menu cm-block-context-menu";
      menu.innerHTML = `
        <div class="menu-section">
          <div class="menu-item-group-title">转换为 (Turn Into)</div>
          <div class="block-turn-into-grid">
            <button type="button" class="block-turn-btn" data-turn="h1" title="一级标题 (Ctrl+1)">H1</button>
            <button type="button" class="block-turn-btn" data-turn="h2" title="二级标题 (Ctrl+2)">H2</button>
            <button type="button" class="block-turn-btn" data-turn="h3" title="三级标题 (Ctrl+3)">H3</button>
            <button type="button" class="block-turn-btn" data-turn="h4" title="四级标题 (Ctrl+4)">H4</button>
            <button type="button" class="block-turn-btn" data-turn="p" title="普通段落 (Ctrl+0)">正文</button>
            <button type="button" class="block-turn-btn" data-turn="ul" title="无序列表">• 列表</button>
            <button type="button" class="block-turn-btn" data-turn="ol" title="有序列表">1. 列表</button>
            <button type="button" class="block-turn-btn" data-turn="task" title="待办任务">☑ 任务</button>
            <button type="button" class="block-turn-btn" data-turn="quote" title="引用块">❝ 引用</button>
            <button type="button" class="block-turn-btn" data-turn="callout" title="GitHub Callout 提示框">💡 提示卡</button>
            <button type="button" class="block-turn-btn" data-turn="code" title="围栏代码块">&lt;/&gt; 代码</button>
          </div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          ${
            isHeading
              ? `<div class="menu-item" data-act="toggle-fold">
                  <div class="menu-item-left"><span class="m-icon">${isFolded ? "▸" : "▾"}</span><span>${
                  isFolded ? "展开本章节内容" : "折叠本章节内容"
                }</span></div>
                </div>`
              : ""
          }
          <div class="menu-item" data-act="move-up">
            <div class="menu-item-left"><span class="m-icon">↑</span><span>上移此块</span></div>
            <span class="shortcut">Alt+↑</span>
          </div>
          <div class="menu-item" data-act="move-down">
            <div class="menu-item-left"><span class="m-icon">↓</span><span>下移此块</span></div>
            <span class="shortcut">Alt+↓</span>
          </div>
          <div class="menu-item" data-act="insert-above">
            <div class="menu-item-left"><span class="m-icon">⤒</span><span>在上方插入空行</span></div>
          </div>
          <div class="menu-item" data-act="insert-below">
            <div class="menu-item-left"><span class="m-icon">⤓</span><span>在下方插入空行</span></div>
          </div>
          <div class="menu-item" data-act="duplicate">
            <div class="menu-item-left"><span class="m-icon">⧉</span><span>克隆当前块</span></div>
            <span class="shortcut">Ctrl+D</span>
          </div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          <div class="menu-item" data-act="copy-md">
            <div class="menu-item-left"><span class="m-icon">📋</span><span>复制块 Markdown</span></div>
          </div>
          <div class="menu-item" data-act="copy-text">
            <div class="menu-item-left"><span class="m-icon">📄</span><span>复制块纯文本</span></div>
          </div>
          <div class="menu-item" data-act="cut-block">
            <div class="menu-item-left"><span class="m-icon">✂</span><span>剪切当前块</span></div>
          </div>
          <div class="menu-item danger-item" data-act="delete-block">
            <div class="menu-item-left"><span class="m-icon">🗑</span><span>删除当前块</span></div>
          </div>
        </div>
      `;

      document.body.appendChild(menu);
      activeBlockMenuEl = menu;

      const menuW = 236;
      const menuH = menu.offsetHeight || 310;
      const left = Math.max(8, Math.min(clientX, window.innerWidth - menuW - 10));
      const top = Math.max(8, Math.min(clientY, window.innerHeight - menuH - 10));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;

      menu.addEventListener("click", (e) => {
        e.stopPropagation();
        const turnBtn = (e.target as HTMLElement).closest(".block-turn-btn") as HTMLElement | null;
        if (turnBtn && turnBtn.dataset.turn) {
          this.convertBlockType(span, turnBtn.dataset.turn);
          closeBlockContextMenu();
          return;
        }

        const item = (e.target as HTMLElement).closest(".menu-item") as HTMLElement | null;
        if (!item || !item.dataset.act) return;
        const act = item.dataset.act;
        closeBlockContextMenu();
        this.executeBlockMenuAction(span, act);
      });
    }

    private convertBlockType(span: { startLine: number; endLine: number }, targetType: string) {
      const doc = this.view.state.doc;
      const line = doc.line(span.startLine);
      this.view.dispatch({ selection: { anchor: line.from } });

      if (targetType.startsWith("h")) {
        const lvl = parseInt(targetType.slice(1), 10);
        toggleHeadingLevel(this.view, lvl);
        return;
      }
      if (targetType === "p") {
        const cleaned = line.text.replace(
          /^(\s*(?:>\s*)*)(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/,
          ""
        );
        this.view.dispatch({
          changes: { from: line.from, to: line.to, insert: cleaned },
          selection: { anchor: line.from + cleaned.length },
        });
        this.view.focus();
        return;
      }

      const bodyText = line.text
        .replace(/^(\s*(?:>\s*)*)(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/, "")
        .trim();

      let replacement = bodyText;
      if (targetType === "ul") replacement = `- ${bodyText}`;
      else if (targetType === "ol") replacement = `1. ${bodyText}`;
      else if (targetType === "task") replacement = `- [ ] ${bodyText}`;
      else if (targetType === "quote") replacement = `> ${bodyText}`;
      else if (targetType === "callout") replacement = `> [!NOTE] 核心提示\n> ${bodyText || "在此输入内容..."}`;
      else if (targetType === "code") {
        const allLines: string[] = [];
        for (let ln = span.startLine; ln <= span.endLine; ln++) {
          allLines.push(doc.line(ln).text);
        }
        const fullTo = doc.line(span.endLine).to;
        const codeBlock = `\`\`\`\n${allLines.join("\n")}\n\`\`\``;
        this.view.dispatch({
          changes: { from: line.from, to: fullTo, insert: codeBlock },
          selection: { anchor: line.from + 4 },
        });
        this.view.focus();
        return;
      }

      this.view.dispatch({
        changes: { from: line.from, to: line.to, insert: replacement },
        selection: { anchor: line.from + replacement.length },
      });
      this.view.focus();
    }

    private executeBlockMenuAction(span: { startLine: number; endLine: number }, act: string) {
      const doc = this.view.state.doc;
      const from = doc.line(span.startLine).from;
      const to = doc.line(span.endLine).to;
      const rawBlock = this.view.state.sliceDoc(from, to);

      if (act === "toggle-fold") {
        toggleHeadingFoldAtLine(this.view, span.startLine);
      } else if (act === "move-up") {
        this.view.dispatch({ selection: { anchor: from } });
        moveCurrentSemanticBlock(this.view, -1);
      } else if (act === "move-down") {
        this.view.dispatch({ selection: { anchor: from } });
        moveCurrentSemanticBlock(this.view, 1);
      } else if (act === "insert-above") {
        this.view.dispatch({
          changes: { from, to: from, insert: "\n" },
          selection: { anchor: from },
        });
        this.view.focus();
      } else if (act === "insert-below") {
        this.view.dispatch({
          changes: { from: to, to, insert: "\n" },
          selection: { anchor: to + 1 },
        });
        this.view.focus();
      } else if (act === "duplicate") {
        duplicateCurrentSemanticBlock(this.view, span);
      } else if (act === "copy-md") {
        navigator.clipboard.writeText(rawBlock);
        showToast("已复制块 Markdown 源码", "success");
      } else if (act === "copy-text") {
        const plain = rawBlock
          .split("\n")
          .map((l) => stripInlineMarkdown(l.replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/, "")))
          .join("\n");
        navigator.clipboard.writeText(plain);
        showToast("已复制块纯文本", "success");
      } else if (act === "cut-block") {
        navigator.clipboard.writeText(rawBlock);
        const delFrom = from > 0 && doc.sliceString(from - 1, from) === "\n" ? from - 1 : from;
        const delTo = delFrom === from && to < doc.length && doc.sliceString(to, to + 1) === "\n" ? to + 1 : to;
        this.view.dispatch({
          changes: { from: delFrom, to: delTo, insert: "" },
          selection: { anchor: Math.min(delFrom, doc.length - (delTo - delFrom)) },
        });
        this.view.focus();
      } else if (act === "delete-block") {
        const delFrom = from > 0 && doc.sliceString(from - 1, from) === "\n" ? from - 1 : from;
        const delTo = delFrom === from && to < doc.length && doc.sliceString(to, to + 1) === "\n" ? to + 1 : to;
        this.view.dispatch({
          changes: { from: delFrom, to: delTo, insert: "" },
          selection: { anchor: Math.min(delFrom, doc.length - (delTo - delFrom)) },
        });
        this.view.focus();
      }
    }

    private updateHandlePosition(lineEl: HTMLElement) {
      const scroller = this.view.scrollDOM;
      const lineRect = lineEl.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const style = window.getComputedStyle(lineEl);

      // 动态扣除标题/代码块的 padding-top，将 22px 高的抓手精确居中于首行文字中线
      const paddingTop = parseFloat(style.paddingTop) || 0;
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      const contentHeight = Math.max(20, lineRect.height - paddingTop - paddingBottom);
      const rawLineHeight = parseFloat(style.lineHeight);
      const firstLineHeight = !Number.isNaN(rawLineHeight)
        ? Math.min(rawLineHeight, contentHeight)
        : Math.min(contentHeight, 34);

      const handleHeight = 22;
      const boxTop = lineRect.top - scrollerRect.top + scroller.scrollTop;
      const alignedTop = boxTop + paddingTop + (firstLineHeight - handleHeight) / 2;

      // 水平紧贴在行元素左边界外侧 24px（处于 .cm-content 的 48px 左内边距热区内，且通过 ::after 桥接消除死区）
      const lineLeft = lineRect.left - scrollerRect.left + scroller.scrollLeft;
      const alignedLeft = Math.max(6, lineLeft - 24);

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
