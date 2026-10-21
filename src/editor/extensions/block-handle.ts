import { ChangeSpec, EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import {
  resolveSemanticBlockSpanFromState,
  stripInlineMarkdown,
} from "./doc-structure";
import {
  buildSubsequentRenumberChanges,
  computeExpectedOrderedNumber,
  toggleHeadingLevel,
} from "./formatting-keymap";
import { toggleHeadingFoldAtLine, isHeadingFoldedAtLine } from "./live-preview";
import { showToast } from "../../components/save-dialog";

const BLOCK_SVG = {
  foldOpen: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
  foldClosed: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>`,
  moveUp: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`,
  moveDown: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>`,
  insertAbove: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="4" x2="20" y2="4"></line><line x1="12" y1="9" x2="12" y2="19"></line><polyline points="8 13 12 9 16 13"></polyline></svg>`,
  insertBelow: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="20" x2="20" y2="20"></line><line x1="12" y1="5" x2="12" y2="15"></line><polyline points="8 11 12 15 16 11"></polyline></svg>`,
  duplicate: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
  copyMd: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>`,
  copyText: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`,
  cut: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg>`,
  trash: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
};

/**
 * 计算给定行所属的完整语义块行号区间（支持表格、围栏代码块、Mermaid、多行公式块、Callout、连续引用块、带嵌套子列表的列表项及多块框选范围）
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
 * 批量转换一个或多个文本块/行区间的块级类型 (Bug #5 & Bug #8 增强)
 * 支持：h1~h6、p (普通段落)、ul (无序列表)、ol (自动递增有序列表)、task (任务列表)、quote (引用块)、callout (提示卡)、code (围栏代码块)
 * 当把有序列表中间某项转为其他类型时，自动将下方断开的有序列表从 1 重新编号。
 */
export function convertBlockSpanType(
  view: EditorView,
  span: { startLine: number; endLine: number },
  targetType: string
) {
  const doc = view.state.doc;
  const startLineNum = Math.max(1, Math.min(span.startLine, doc.lines));
  const endLineNum = Math.max(startLineNum, Math.min(span.endLine, doc.lines));
  const firstLine = doc.line(startLineNum);
  const lastLine = doc.line(endLineNum);

  if (targetType.startsWith("h")) {
    const lvl = parseInt(targetType.slice(1), 10);
    view.dispatch({
      selection: { anchor: firstLine.from, head: lastLine.to },
    });
    toggleHeadingLevel(view, lvl);
    view.focus();
    return;
  }

  const rawLines: string[] = [];
  for (let ln = startLineNum; ln <= endLineNum; ln++) {
    rawLines.push(doc.line(ln).text);
  }

  // 检测末行是否原本为有序列表项（用于列表从中间断开时重排下方列表）
  const lastLineQuoteMatch = lastLine.text.match(/^(\s*(?:> ?)+)/);
  const lastQuotePrefix = lastLineQuoteMatch ? lastLineQuoteMatch[1] : "";
  const lastRest = lastLine.text.slice(lastQuotePrefix.length);
  const lastOrderedMatch = lastRest.match(/^(\s*)\d+\.\s+/);

  // 如果原本是一个完整的围栏代码块，转换到其他类型时先剥离首尾 ``` 围栏行
  const isWrappedInFence =
    rawLines.length >= 2 &&
    /^\s*(`{3,}|~{3,})/.test(rawLines[0]) &&
    /^\s*(`{3,}|~{3,})\s*$/.test(rawLines[rawLines.length - 1]);

  if (targetType === "code") {
    if (isWrappedInFence) {
      const unwrapped = rawLines.slice(1, -1).join("\n");
      view.dispatch({
        changes: { from: firstLine.from, to: lastLine.to, insert: unwrapped },
        selection: { anchor: firstLine.from, head: firstLine.from + unwrapped.length },
      });
    } else {
      const codeBlock = `\`\`\`\n${rawLines.join("\n")}\n\`\`\``;
      const extraRenumber = lastOrderedMatch
        ? buildSubsequentRenumberChanges(
            doc,
            endLineNum + 1,
            lastQuotePrefix,
            lastOrderedMatch[1].length,
            1
          )
        : [];
      view.dispatch({
        changes: [
          { from: firstLine.from, to: lastLine.to, insert: codeBlock },
          ...extraRenumber,
        ],
        selection: { anchor: firstLine.from + 4 },
      });
    }
    view.focus();
    return;
  }

  const effectiveLines = isWrappedInFence ? rawLines.slice(1, -1) : rawLines;

  const stripBlockLinePrefix = (text: string): string => {
    return text.replace(
      /^(\s*(?:>\s*)*)(?:\[!([A-Za-z]+)\]\s*|#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)?/,
      ""
    );
  };

  if (targetType === "callout") {
    const bodyLines = effectiveLines
      .map((l) => stripBlockLinePrefix(l).trim())
      .filter((l, idx, arr) => l.length > 0 || arr.length === 1);
    const calloutContent =
      bodyLines.length > 0 && bodyLines[0]
        ? bodyLines.map((l) => `> ${l}`).join("\n")
        : "> 在此输入内容...";
    const replacement = `> [!NOTE] 核心提示\n${calloutContent}`;
    const extraRenumber = lastOrderedMatch
      ? buildSubsequentRenumberChanges(
          doc,
          endLineNum + 1,
          lastQuotePrefix,
          lastOrderedMatch[1].length,
          1
        )
      : [];
    view.dispatch({
      changes: [
        { from: firstLine.from, to: lastLine.to, insert: replacement },
        ...extraRenumber,
      ],
      selection: { anchor: firstLine.from, head: firstLine.from + replacement.length },
    });
    view.focus();
    return;
  }

  let olCounter =
    targetType === "ol"
      ? computeExpectedOrderedNumber(doc, startLineNum, "", 0)
      : 1;
  const convertedLines = effectiveLines.map((lineText) => {
    if (lineText.trim().length === 0) {
      return targetType === "quote" ? ">" : "";
    }
    const cleanBody = stripBlockLinePrefix(lineText).trim();
    if (targetType === "p") return cleanBody;
    if (targetType === "ul") return `- ${cleanBody}`;
    if (targetType === "ol") return `${olCounter++}. ${cleanBody}`;
    if (targetType === "task") return `- [ ] ${cleanBody}`;
    if (targetType === "quote") return `> ${cleanBody}`;
    return cleanBody;
  });

  const replacement = convertedLines.join("\n");
  const extraChanges: ChangeSpec[] = [];
  if (targetType === "ol") {
    extraChanges.push(
      ...buildSubsequentRenumberChanges(doc, endLineNum + 1, "", 0, olCounter)
    );
  } else if (lastOrderedMatch) {
    extraChanges.push(
      ...buildSubsequentRenumberChanges(
        doc,
        endLineNum + 1,
        lastQuotePrefix,
        lastOrderedMatch[1].length,
        1
      )
    );
  }

  view.dispatch({
    changes: [
      { from: firstLine.from, to: lastLine.to, insert: replacement },
      ...extraChanges,
    ],
    selection: {
      anchor: firstLine.from,
      head: firstLine.from + replacement.length,
    },
  });
  view.focus();
}

/**
 * 对一组行文本中的有序列表进行连续序号重整（用于块移动后保持有序列表序号自洽）
 */
function renumberOrderedListsInLines(lines: string[], startExpectedTopLevel: number): string[] {
  const counters = new Map<string, number>();
  let usedInitialTopLevel = false;

  return lines.map((raw) => {
    const qm = raw.match(/^(\s*(?:> ?)+)/);
    const qp = qm ? qm[1] : "";
    const sub = raw.slice(qp.length);
    if (!sub.trim()) {
      counters.clear();
      usedInitialTopLevel = true;
      return raw;
    }
    const lm = sub.match(/^(\s*)([-*+]|\d+\.)(\s+)(.*)$/);
    if (!lm) {
      counters.clear();
      usedInitialTopLevel = true;
      return raw;
    }
    const ind = lm[1];
    const marker = lm[2];
    const spaceAfter = lm[3];
    const body = lm[4];

    for (const k of Array.from(counters.keys())) {
      const [kQp, kLenStr] = k.split("::");
      if (kQp === qp && parseInt(kLenStr, 10) > ind.length) {
        counters.delete(k);
      }
    }

    const key = `${qp}::${ind.length}`;
    if (/^\d+\.$/.test(marker)) {
      let nextNum: number;
      if (!counters.has(key) && ind.length === 0 && !usedInitialTopLevel) {
        nextNum = startExpectedTopLevel;
        usedInitialTopLevel = true;
      } else {
        nextNum = (counters.get(key) || 0) + 1;
      }
      counters.set(key, nextNum);
      return `${qp}${ind}${nextNum}.${spaceAfter}${body}`;
    } else {
      counters.delete(key);
      return raw;
    }
  });
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

  const startExpected = computeExpectedOrderedNumber(doc, rangeStartLine, "", 0);
  const renumberedRemaining = renumberOrderedListsInLines(remaining, startExpected);

  const replaceFrom = doc.line(rangeStartLine).from;
  const replaceTo = doc.line(rangeEndLine).to;
  const newSegment = renumberedRemaining.join("\n");

  const beforeMovedText = renumberedRemaining.slice(0, relInsertIdx).join("\n");
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
    const prevLine = src.startLine - 1;
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
export function duplicateCurrentSemanticBlock(
  view: EditorView,
  targetSpan?: { startLine: number; endLine: number }
): boolean {
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
 * 基于 Pointer Events 的段落/块级左侧拖拽手柄 (⋮⋮ Block Handle v0.8)
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
     * 弹出思源笔记 / Notion 风格块级操作菜单（全线性 SVG 图标 + 支持多块批量转换）
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
      const lineCount = span.endLine - span.startLine + 1;

      const menu = document.createElement("div");
      menu.className = "ty-dropdown-menu cm-block-context-menu";
      menu.innerHTML = `
        <div class="menu-section">
          <div class="menu-item-group-title">${
            lineCount > 1 ? `批量转换为 (${lineCount} 行)` : "转换为 (Turn Into)"
          }</div>
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
            <button type="button" class="block-turn-btn" data-turn="callout" title="GitHub Callout 提示框">提示卡</button>
            <button type="button" class="block-turn-btn" data-turn="code" title="围栏代码块">&lt;/&gt; 代码</button>
          </div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          ${
            isHeading
              ? `<div class="menu-item" data-act="toggle-fold">
                  <div class="menu-item-left"><span class="m-icon">${
                    isFolded ? BLOCK_SVG.foldClosed : BLOCK_SVG.foldOpen
                  }</span><span>${
                  isFolded ? "展开本章节内容" : "折叠本章节内容"
                }</span></div>
                </div>`
              : ""
          }
          <div class="menu-item" data-act="move-up">
            <div class="menu-item-left"><span class="m-icon">${BLOCK_SVG.moveUp}</span><span>上移此块</span></div>
            <span class="shortcut">Alt+↑</span>
          </div>
          <div class="menu-item" data-act="move-down">
            <div class="menu-item-left"><span class="m-icon">${BLOCK_SVG.moveDown}</span><span>下移此块</span></div>
            <span class="shortcut">Alt+↓</span>
          </div>
          <div class="menu-item" data-act="insert-above">
            <div class="menu-item-left"><span class="m-icon">${BLOCK_SVG.insertAbove}</span><span>在上方插入空行</span></div>
          </div>
          <div class="menu-item" data-act="insert-below">
            <div class="menu-item-left"><span class="m-icon">${BLOCK_SVG.insertBelow}</span><span>在下方插入空行</span></div>
          </div>
          <div class="menu-item" data-act="duplicate">
            <div class="menu-item-left"><span class="m-icon">${BLOCK_SVG.duplicate}</span><span>克隆当前块</span></div>
            <span class="shortcut">Ctrl+D</span>
          </div>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-section">
          <div class="menu-item" data-act="copy-md">
            <div class="menu-item-left"><span class="m-icon">${BLOCK_SVG.copyMd}</span><span>复制块 Markdown</span></div>
          </div>
          <div class="menu-item" data-act="copy-text">
            <div class="menu-item-left"><span class="m-icon">${BLOCK_SVG.copyText}</span><span>复制块纯文本</span></div>
          </div>
          <div class="menu-item" data-act="cut-block">
            <div class="menu-item-left"><span class="m-icon">${BLOCK_SVG.cut}</span><span>剪切当前块</span></div>
          </div>
          <div class="menu-item danger-item" data-act="delete-block">
            <div class="menu-item-left"><span class="m-icon">${BLOCK_SVG.trash}</span><span>删除当前块</span></div>
          </div>
        </div>
      `;

      document.body.appendChild(menu);
      activeBlockMenuEl = menu;

      const menuW = 242;
      const menuH = menu.offsetHeight || 310;
      const left = Math.max(8, Math.min(clientX, window.innerWidth - menuW - 10));
      const top = Math.max(8, Math.min(clientY, window.innerHeight - menuH - 10));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;

      menu.addEventListener("click", (e) => {
        e.stopPropagation();
        const turnBtn = (e.target as HTMLElement).closest(".block-turn-btn") as HTMLElement | null;
        if (turnBtn && turnBtn.dataset.turn) {
          convertBlockSpanType(this.view, span, turnBtn.dataset.turn);
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
          .map((l) =>
            stripInlineMarkdown(
              l.replace(
                /^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/,
                ""
              )
            )
          )
          .join("\n");
        navigator.clipboard.writeText(plain);
        showToast("已复制块纯文本", "success");
      } else if (act === "cut-block") {
        navigator.clipboard.writeText(rawBlock);
        const delFrom = from > 0 && doc.sliceString(from - 1, from) === "\n" ? from - 1 : from;
        const delTo =
          delFrom === from && to < doc.length && doc.sliceString(to, to + 1) === "\n" ? to + 1 : to;
        this.view.dispatch({
          changes: { from: delFrom, to: delTo, insert: "" },
          selection: { anchor: Math.min(delFrom, doc.length - (delTo - delFrom)) },
        });
        this.view.focus();
      } else if (act === "delete-block") {
        const delFrom = from > 0 && doc.sliceString(from - 1, from) === "\n" ? from - 1 : from;
        const delTo =
          delFrom === from && to < doc.length && doc.sliceString(to, to + 1) === "\n" ? to + 1 : to;
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

      const paddingTop = parseFloat(style.paddingTop) || 0;
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      const contentHeight = Math.max(20, lineRect.height - paddingTop - paddingBottom);
      const rawLineHeight = parseFloat(style.lineHeight);
      const firstLineHeight = !Number.isNaN(rawLineHeight)
        ? Math.min(rawLineHeight, contentHeight)
        : Math.min(28, contentHeight);

      const handleHeight = 20;
      const topInScroller =
        lineRect.top -
        scrollerRect.top +
        scroller.scrollTop +
        paddingTop +
        Math.max(0, (firstLineHeight - handleHeight) / 2);

      const contentRect = this.view.contentDOM.getBoundingClientRect();
      const contentStyle = window.getComputedStyle(this.view.contentDOM);
      const contentPadLeft = parseFloat(contentStyle.paddingLeft) || 48;
      const textStartLeft = contentRect.left - scrollerRect.left + contentPadLeft;
      const leftInScroller = Math.max(6, textStartLeft - 28);

      this.handle.style.top = `${Math.round(topInScroller)}px`;
      this.handle.style.left = `${Math.round(leftInScroller)}px`;
      this.handle.classList.add("visible");
    }

    private hideHandle() {
      this.handle.classList.remove("visible");
      this.activeLineEl = null;
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
