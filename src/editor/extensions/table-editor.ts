import { isLikelyUrl, normalizeUrlForLink } from "./inline-boundary-guard";
import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import { EditorView, KeyBinding, WidgetType, Decoration, DecorationSet } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import katex from "katex";
import { centerElementInTypewriter } from "./typewriter-mode";
import { forceRefreshEffect } from "./refresh-effect";
import {
  getDocStructureFromState,
  isTableDelimiter,
  TableBlock,
} from "./doc-structure";
import { parseInlineAST, renderInlineASTSync } from "../markdown-ast-renderer";

export { isTableDelimiter };
export type { TableBlock };

/**
 * O(1) 从缓存结构中读取文档内所有的 Markdown 表格块
 */
export function findTablesInDoc(state: EditorState): TableBlock[] {
  return getDocStructureFromState(state).tables;
}

/**
 * 计算字符串在等宽字体下的视觉显示列宽（CJK 中文字符计 2 列，ASCII 计 1 列）
 */
function getVisualDisplayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) || 0;
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function padVisualEnd(str: string, targetVisualWidth: number): string {
  const curWidth = getVisualDisplayWidth(str);
  const padSpaces = Math.max(0, targetVisualWidth - curWidth);
  return str + " ".repeat(padSpaces);
}

/**
 * 将二维数据与对齐方式重新序列化为 CJK 视觉等宽对齐的规范 Markdown 表格
 */
export function serializeMarkdownTable(
  headers: string[],
  rows: string[][],
  alignments: Array<"left" | "center" | "right">
): string {
  const sanitizeCell = (s: string) =>
    s
      .replace(/\r?\n/g, "<br>")
      .replace(/(?<!\\)\|/g, "\\|")
      .trim();

  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const normalizedHeaders = new Array(colCount)
    .fill("")
    .map((_, i) => sanitizeCell(headers[i] !== undefined ? headers[i] : ""));
  const normalizedRows = rows.map((r) =>
    new Array(colCount).fill("").map((_, i) => sanitizeCell(r[i] !== undefined ? r[i] : ""))
  );

  const colWidths = new Array(colCount).fill(3);
  normalizedHeaders.forEach((h, i) => {
    colWidths[i] = Math.max(colWidths[i], getVisualDisplayWidth(h));
  });
  normalizedRows.forEach((row) => {
    row.forEach((cell, i) => {
      colWidths[i] = Math.max(colWidths[i], getVisualDisplayWidth(cell));
    });
  });

  const delimiterRow = new Array(colCount).fill("left").map((_, i) => {
    const align = alignments[i] || "left";
    const w = colWidths[i];
    if (align === "center") return `:${"-".repeat(Math.max(w - 2, 1))}:`;
    if (align === "right") return `${"-".repeat(Math.max(w - 1, 2))}:`;
    return `:${"-".repeat(Math.max(w - 1, 2))}`;
  });

  const lines: string[] = [];
  lines.push(`| ${normalizedHeaders.map((h, i) => padVisualEnd(h, colWidths[i])).join(" | ")} |`);
  lines.push(`| ${delimiterRow.join(" | ")} |`);
  normalizedRows.forEach((row) => {
    lines.push(`| ${row.map((c, i) => padVisualEnd(c, colWidths[i])).join(" | ")} |`);
  });

  return lines.join("\n");
}

function sanitizeSafeHref(url: string): string {
  const trimmed = url.trim();
  if (/^(javascript:|vbscript:|data:text\/html)/i.test(trimmed)) {
    return "#";
  }
  return trimmed.replace(/&quot;/g, "").replace(/"/g, "&quot;");
}

/**
 * 将单元格文本中的行内 Markdown 转换为富文本 HTML（支持平衡括号链接、双向链接、公式、代码等）
 */
export function formatMarkdownToHTML(text: string): string {
  if (!text) return "";
  const ast = parseInlineAST(text);
  return renderInlineASTSync(ast, { mode: "table-cell" });
}

/**
 * 将单元格 DOM 结构逆向转换为规范的 Markdown 格式文本
 */
export function formatHTMLToMarkdown(cell: HTMLElement): string {
  function serializeNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent || "")
        .replace(/\r?\n/g, " ")
        .replace(/<(?=[a-zA-Z!/])/g, "&lt;");
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (
        el.classList.contains("tbl-col-drag-grip") ||
        el.classList.contains("tbl-row-drag-grip") ||
        el.classList.contains("tbl-col-resizer")
      ) {
        return "";
      }

      const tagName = el.tagName.toUpperCase();

      if (el.classList.contains("tbl-inline-math") && el.dataset.tex) {
        return `$${el.dataset.tex}$`;
      }
      if (el.classList.contains("cm-wikilink") && el.dataset.raw) {
        return el.dataset.raw;
      }

      if (tagName === "BR") {
        return "<br>";
      }

      let inner = "";
      el.childNodes.forEach((child) => {
        inner += serializeNode(child);
      });

      if (!inner) return "";

      if (tagName === "STRONG" || tagName === "B") {
        return `**${inner}**`;
      }
      if (tagName === "EM" || tagName === "I") {
        return `*${inner}*`;
      }
      if (tagName === "DEL" || tagName === "S" || tagName === "STRIKE") {
        return `~~${inner}~~`;
      }
      if (tagName === "MARK") {
        return `==${inner}==`;
      }
      if (tagName === "SUB") {
        return `~${inner}~`;
      }
      if (tagName === "SUP") {
        return `^${inner}^`;
      }
      if (tagName === "CODE") {
        return `\`${inner}\``;
      }
      if (tagName === "A") {
        const href = el.getAttribute("data-href") || el.getAttribute("href") || "";
        return href ? `[${inner || href}](${href})` : inner;
      }
      if (tagName === "SPAN") {
        const fw = el.style?.fontWeight || "";
        const fs = el.style?.fontStyle || "";
        const td = el.style?.textDecoration || el.style?.textDecorationLine || "";
        let wrapped = inner;
        if (td.includes("line-through")) wrapped = `~~${wrapped}~~`;
        if (fs === "italic" || fs === "oblique") wrapped = `*${wrapped}*`;
        if (fw === "bold" || Number(fw) >= 600) wrapped = `**${wrapped}**`;
        return wrapped;
      }
      if (tagName === "DIV" || tagName === "P") {
        return `<br>${inner}`;
      }
      return inner;
    }
    return "";
  }

  const contentRoot = (cell.querySelector(".tbl-cell-editor") as HTMLElement) || cell;
  let result = "";
  contentRoot.childNodes.forEach((child) => {
    result += serializeNode(child);
  });
  return result
    .replace(/^(?:<br>)+/i, "")
    .replace(/(?:<br>)+$/i, "")
    .replace(/\r?\n/g, " ")
    .trim();
}

function insertNodeAtCellSelection(cellEditor: HTMLElement, node: Node) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    cellEditor.appendChild(node);
    return;
  }
  const range = sel.getRangeAt(0);
  if (!cellEditor.contains(range.commonAncestorContainer)) {
    cellEditor.appendChild(node);
    return;
  }
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function toggleCellInlineTag(
  cellEditor: HTMLElement,
  tagName: "strong" | "em" | "del" | "code" | "mark"
) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!cellEditor.contains(range.commonAncestorContainer)) return;

  const upper = tagName.toUpperCase();
  const parentEl =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as HTMLElement)
      : range.commonAncestorContainer.parentElement;
  const existingTag = parentEl?.closest(tagName);

  if (existingTag && cellEditor.contains(existingTag)) {
    const frag = document.createDocumentFragment();
    while (existingTag.firstChild) {
      frag.appendChild(existingTag.firstChild);
    }
    existingTag.replaceWith(frag);
    cellEditor.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  if (!range.collapsed) {
    const wrapper = document.createElement(tagName);
    try {
      range.surroundContents(wrapper);
    } catch {
      wrapper.appendChild(range.extractContents());
      range.insertNode(wrapper);
    }
    const newRange = document.createRange();
    newRange.selectNodeContents(wrapper);
    sel.removeAllRanges();
    sel.addRange(newRange);
    cellEditor.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    if (cellEditor.children.length === 1 && cellEditor.firstElementChild?.tagName === upper) {
      const inner = cellEditor.firstElementChild;
      const frag = document.createDocumentFragment();
      while (inner.firstChild) frag.appendChild(inner.firstChild);
      inner.replaceWith(frag);
    } else if (cellEditor.textContent?.trim()) {
      const wrapper = document.createElement(tagName);
      while (cellEditor.firstChild) wrapper.appendChild(cellEditor.firstChild);
      cellEditor.appendChild(wrapper);
    }
    cellEditor.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/**
 * 在单元格内弹出轻量超链接输入浮层或直接包裹超链接 (支持表格内 Ctrl+K)
 */
function promptCellInlineLink(cellEditor: HTMLElement, onCommit: () => void) {
  const sel = window.getSelection();
  let selectedText = "";
  let savedRange: Range | null = null;
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0);
    if (cellEditor.contains(r.commonAncestorContainer)) {
      savedRange = r.cloneRange();
      selectedText = r.toString().trim();
    }
  }

  const existingPop = document.getElementById("quilla-tbl-link-popover");
  if (existingPop) existingPop.remove();

  const pop = document.createElement("div");
  pop.id = "quilla-tbl-link-popover";
  pop.className = "ty-link-tooltip";
  const selectedIsUrl = isLikelyUrl(selectedText);
  const initTextVal = selectedIsUrl ? "" : selectedText;
  const initUrlVal = selectedIsUrl ? normalizeUrlForLink(selectedText) : "https://";
  pop.innerHTML = `
    <div class="link-tooltip-edit-form">
      <label class="link-edit-field" for="tbl-lnk-text">
        <span class="link-edit-label">名称</span>
        <input type="text" id="tbl-lnk-text" class="ty-inline-input" placeholder="输入链接显示名称..." value="${initTextVal.replace(/"/g, "&quot;")}" />
      </label>
      <label class="link-edit-field" for="tbl-lnk-url">
        <span class="link-edit-label">链接</span>
        <input type="text" id="tbl-lnk-url" class="ty-inline-input" placeholder="https://..." value="${initUrlVal.replace(/"/g, "&quot;")}" />
      </label>
      <div class="link-edit-actions">
        <button type="button" class="ty-toolbar-btn primary" id="tbl-lnk-save">插入</button>
        <button type="button" class="ty-toolbar-btn" id="tbl-lnk-cancel">取消</button>
      </div>
    </div>
  `;
  document.body.appendChild(pop);

  const rect = cellEditor.getBoundingClientRect();
  pop.style.top = `${Math.max(40, rect.top - 96)}px`;
  pop.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 260))}px`;

  const textInp = pop.querySelector("#tbl-lnk-text") as HTMLInputElement;
  const urlInp = pop.querySelector("#tbl-lnk-url") as HTMLInputElement;

  const closePop = () => {
    pop.remove();
    cellEditor.focus({ preventScroll: true });
  };

  const applyLink = () => {
    const label = textInp.value.trim() || "链接文字";
    const url = sanitizeSafeHref(urlInp.value.trim() || "https://");
    pop.remove();
    cellEditor.focus({ preventScroll: true });
    if (savedRange && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    const a = document.createElement("a");
    a.href = url;
    a.dataset.href = url;
    a.className = "cm-link tbl-inline-link";
    a.textContent = label;
    insertNodeAtCellSelection(cellEditor, a);
    cellEditor.dispatchEvent(new Event("input", { bubbles: true }));
    onCommit();
  };

  pop.querySelector("#tbl-lnk-save")?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    applyLink();
  });
  pop.querySelector("#tbl-lnk-cancel")?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closePop();
  });

  [textInp, urlInp].forEach((inp) => {
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        applyLink();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closePop();
      }
    });
  });

  setTimeout(() => {
    if (selectedText && !selectedIsUrl) {
      urlInp.focus();
      urlInp.select();
    } else {
      textInp.focus();
      textInp.select();
    }
  }, 15);
}

/**
 * 可视化表格内联可编辑组件 (In-Place Interactive TableWidget v0.4)
 * - 根治删行后 Ctrl+Z 无法撤销与视口乱跳 Bug（仅在 keepAlive="1" 时跳过重建，外部 undo/redo/查找替换 100% 重建表格并锁定 scrollTop）
 * - 支持 Pointer Events 行列拖拽换位、列宽拖拽调节、表格右/下边缘一键加行列、单元格 Ctrl+K 插入链接
 * - 悬浮工具栏纯图标化设计，且在表格靠近视口顶部时自动向下翻转 (.flip-bottom) 防遮挡
 */
class InteractiveTableWidget extends WidgetType {
  private currentHeaders: string[] = [];
  private currentRows: string[][] = [];
  private currentAlignments: Array<"left" | "center" | "right"> = [];
  private colWidthsPx: Array<number | null> = [];
  private trackedFromPos: number;
  private trackedToPos: number;

  constructor(
    readonly lines: string[],
    readonly fromPos: number,
    readonly toPos: number,
    readonly tableIdx: number
  ) {
    super();
    this.trackedFromPos = fromPos;
    this.trackedToPos = toPos;
  }

  get estimatedHeight(): number {
    const rowCount = this.lines.length;
    return Math.max(110, rowCount * 38 + 52);
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  updateDOM(dom: HTMLElement): boolean {
    if (dom.dataset.forceRebuild === "1") {
      delete dom.dataset.forceRebuild;
      return false;
    }
    // 仅当由当前 Widget 内部 syncToDoc 主动触发 (keepAlive === "1") 时复用 DOM，
    // 任何外部 Undo/Redo、菜单撤销或查找替换事务均返回 false 强制无损重建表格 DOM！
    if (dom.dataset.keepAlive === "1") {
      dom.dataset.fromPos = String(this.fromPos);
      dom.dataset.toPos = String(this.toPos);
      dom.dataset.tableIdx = String(this.tableIdx);
      return true;
    }
    return false;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("figure");
    container.className = "table-figure interactive-table cm-table-widget";
    container.dataset.fromPos = String(this.fromPos);
    container.dataset.toPos = String(this.toPos);
    container.dataset.tableIdx = String(this.tableIdx);

    container.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });

    const parseRowCells = (rowText: string): string[] => {
      let trimmed = rowText.trim();
      if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
      if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);
      return trimmed
        .split(/(?<!\\)\|/)
        .map((c) => c.trim().replace(/\\\|/g, "|"));
    };

    this.currentHeaders = parseRowCells(this.lines[0] || "");
    const delimiterRow = this.lines[1] || "";
    const delimiterParts = delimiterRow
      .split("|")
      .map((s) => s.trim())
      .filter((s, idx, arr) => {
        if (idx === 0 && s === "" && delimiterRow.trim().startsWith("|")) return false;
        if (idx === arr.length - 1 && s === "" && delimiterRow.trim().endsWith("|")) return false;
        return true;
      });

    const colCount = Math.max(this.currentHeaders.length, delimiterParts.length, 1);
    while (this.currentHeaders.length < colCount) {
      this.currentHeaders.push("");
    }
    this.colWidthsPx = new Array(colCount).fill(null);
    this.currentAlignments = new Array(colCount)
      .fill("left")
      .map((_, i) => {
        const p = delimiterParts[i] || "";
        const startColon = p.startsWith(":");
        const endColon = p.endsWith(":");
        if (startColon && endColon) return "center";
        if (endColon) return "right";
        return "left";
      });

    this.currentRows = [];
    for (let r = 2; r < this.lines.length; r++) {
      const rowCells = parseRowCells(this.lines[r]);
      const normalized = new Array(colCount).fill("").map((_, c) => rowCells[c] || "");
      this.currentRows.push(normalized);
    }
    if (this.currentRows.length === 0) {
      this.currentRows.push(new Array(colCount).fill(""));
    }

    let activeRow = 0;
    let activeCol = 0;
    let isRebuildingDOM = false;
    let isUndoingOrRedoing = false;
    let hasUserEdited = false;
    let debouncedInputTimer: any = null;

    const resolveCurrentTableSpan = (): { from: number; to: number } => {
      const attrFrom = Number(container.dataset.fromPos);
      const attrIdx = Number(container.dataset.tableIdx);
      if (!Number.isNaN(attrFrom)) {
        this.trackedFromPos = attrFrom;
      }
      const allTables = findTablesInDoc(view.state);
      if (allTables.length > 0) {
        const exact = allTables.find((t) => t.from === this.trackedFromPos);
        if (exact) {
          this.trackedFromPos = exact.from;
          this.trackedToPos = exact.to;
          container.dataset.fromPos = String(exact.from);
          container.dataset.toPos = String(exact.to);
          return { from: exact.from, to: exact.to };
        }
        if (!Number.isNaN(attrIdx) && attrIdx >= 0 && attrIdx < allTables.length) {
          const byIdx = allTables[attrIdx];
          this.trackedFromPos = byIdx.from;
          this.trackedToPos = byIdx.to;
          container.dataset.fromPos = String(byIdx.from);
          container.dataset.toPos = String(byIdx.to);
          return { from: byIdx.from, to: byIdx.to };
        }
        let best = allTables[0];
        let minDiff = Math.abs(best.from - this.trackedFromPos);
        for (const t of allTables) {
          const diff = Math.abs(t.from - this.trackedFromPos);
          if (diff < minDiff) {
            best = t;
            minDiff = diff;
          }
        }
        this.trackedFromPos = best.from;
        this.trackedToPos = best.to;
        container.dataset.fromPos = String(best.from);
        container.dataset.toPos = String(best.to);
        return { from: best.from, to: best.to };
      }

      const curLine = view.state.doc.lineAt(Math.min(this.trackedFromPos, view.state.doc.length));
      let startLine = curLine.number;
      while (startLine > 1 && view.state.doc.line(startLine - 1).text.trim().includes("|")) {
        startLine--;
      }
      let endLine = curLine.number;
      while (
        endLine < view.state.doc.lines &&
        view.state.doc.line(endLine + 1).text.trim().includes("|")
      ) {
        endLine++;
      }
      const from = view.state.doc.line(startLine).from;
      const to = view.state.doc.line(endLine).to;
      this.trackedFromPos = from;
      this.trackedToPos = to;
      container.dataset.fromPos = String(from);
      container.dataset.toPos = String(to);
      return { from, to };
    };

    const syncToDoc = (forceDispatch: boolean = false) => {
      if (isUndoingOrRedoing) return;
      if (!forceDispatch && !hasUserEdited) return;

      if (debouncedInputTimer) {
        clearTimeout(debouncedInputTimer);
        debouncedInputTimer = null;
      }
      const newMarkdown = serializeMarkdownTable(
        this.currentHeaders,
        this.currentRows,
        this.currentAlignments
      );

      try {
        const { from, to } = resolveCurrentTableSpan();
        const existingMarkdown = view.state.sliceDoc(from, to);
        if (!forceDispatch && existingMarkdown === newMarkdown) {
          hasUserEdited = false;
          return;
        }

        const prevScrollTop = view.scrollDOM.scrollTop;
        this.trackedFromPos = from;
        this.trackedToPos = from + newMarkdown.length;
        container.dataset.fromPos = String(this.trackedFromPos);
        container.dataset.toPos = String(this.trackedToPos);

        container.dataset.keepAlive = "1";
        view.dispatch({
          changes: { from, to, insert: newMarkdown },
          // 将 CodeMirror 主选区锚定至当前表格起点，彻底根除 Ctrl+Z 撤销时视口跳回远端旧光标的 Bug
          selection: { anchor: from },
          userEvent: "input.table",
        });
        delete container.dataset.keepAlive;
        hasUserEdited = false;
        view.scrollDOM.scrollTop = prevScrollTop;
      } catch (err) {
        delete container.dataset.keepAlive;
        console.error("同步表格到文档失败:", err);
      }
    };

    const toolbar = document.createElement("div");
    toolbar.className = "table-floating-toolbar";
    toolbar.innerHTML = `
      <div class="toolbar-group table-dim-group" title="表格规模 (总行数 × 列数)">
        <span class="table-dim-badge" id="tbl-dim-badge">0 × 0</span>
      </div>
      <div class="toolbar-sep"></div>
      <div class="toolbar-group">
        <button type="button" class="tbl-btn icon-only" data-act="align-left" title="当前列左对齐">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="17" y1="10" x2="3" y2="10"></line><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="14" x2="3" y2="14"></line><line x1="17" y1="18" x2="3" y2="18"></line></svg>
        </button>
        <button type="button" class="tbl-btn icon-only" data-act="align-center" title="当前列居中对齐">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="10" x2="6" y2="10"></line><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="14" x2="3" y2="14"></line><line x1="18" y1="18" x2="6" y2="18"></line></svg>
        </button>
        <button type="button" class="tbl-btn icon-only" data-act="align-right" title="当前列右对齐">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="7" y2="10"></line><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="14" x2="3" y2="14"></line><line x1="21" y1="18" x2="7" y2="18"></line></svg>
        </button>
      </div>
      <div class="toolbar-sep"></div>
      <div class="toolbar-group">
        <button type="button" class="tbl-btn" data-act="add-row-above" title="上方插入行">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
          <span>+行</span>
        </button>
        <button type="button" class="tbl-btn" data-act="add-row-below" title="下方插入行 (Ctrl+Enter)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
          <span>+行</span>
        </button>
        <button type="button" class="tbl-btn" data-act="add-col-left" title="左侧插入列">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
          <span>+列</span>
        </button>
        <button type="button" class="tbl-btn" data-act="add-col-right" title="右侧插入列">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          <span>+列</span>
        </button>
      </div>
      <div class="toolbar-sep"></div>
      <div class="toolbar-group">
        <button type="button" class="tbl-btn danger" data-act="del-row" title="删除当前行 (Ctrl+Shift+Backspace)">
          <span>删行</span>
        </button>
        <button type="button" class="tbl-btn danger" data-act="del-col" title="删除当前列">
          <span>删列</span>
        </button>
        <button type="button" class="tbl-btn danger icon-only" data-act="del-table" title="删除整个表格">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    `;

    const tableWrap = document.createElement("div");
    tableWrap.className = "tbl-scroll-and-edge-wrap";

    const table = document.createElement("table");
    table.className = "md-table in-place-edit";

    const addColEdgeBtn = document.createElement("button");
    addColEdgeBtn.type = "button";
    addColEdgeBtn.className = "tbl-edge-add-col";
    addColEdgeBtn.title = "在末尾新增一列";
    addColEdgeBtn.textContent = "+";

    const addRowEdgeBtn = document.createElement("button");
    addRowEdgeBtn.type = "button";
    addRowEdgeBtn.className = "tbl-edge-add-row";
    addRowEdgeBtn.title = "在底部新增一行";
    addRowEdgeBtn.innerHTML = `<span>+ 新增一行</span>`;

    const updateToolbarPositionAndState = () => {
      const dimBadge = toolbar.querySelector("#tbl-dim-badge");
      if (dimBadge) {
        dimBadge.textContent = `${this.currentRows.length + 1} × ${this.currentHeaders.length}`;
      }
      const curAlign = this.currentAlignments[activeCol] || "left";
      toolbar.querySelectorAll("[data-act^='align-']").forEach((btn) => {
        const el = btn as HTMLElement;
        el.classList.toggle("active", el.dataset.act === `align-${curAlign}`);
      });

      // 当表格位于文档顶部或靠近视口上边缘时，工具栏自动向下翻转，避免超出视口顶部被裁切
      requestAnimationFrame(() => {
        if (!container.isConnected) return;
        const figRect = container.getBoundingClientRect();
        const scrollerRect = view.scrollDOM.getBoundingClientRect();
        const nearTop = figRect.top - scrollerRect.top < 44;
        toolbar.classList.toggle("flip-bottom", nearTop);
      });
    };

    const handleCellPaste = (
      e: ClipboardEvent,
      rIdx: number,
      cIdx: number,
      cellEditor: HTMLElement
    ) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text/plain") || "";
      if (!text) return;

      hasUserEdited = true;
      const rawLines = text.replace(/\r\n/g, "\n").split("\n");
      const hasTabs = text.includes("\t");
      if (hasTabs || (rawLines.length > 1 && selectedRange)) {
        const grid = rawLines
          .filter((l, idx) => !(idx === rawLines.length - 1 && l === ""))
          .map((l) => l.split("\t").map((c) => c.trim()));

        if (grid.length > 0) {
          const neededCols = cIdx + Math.max(...grid.map((g) => g.length));
          while (this.currentHeaders.length < neededCols) {
            this.currentHeaders.push("");
            this.currentAlignments.push("left");
            this.colWidthsPx.push(null);
            this.currentRows.forEach((row) => row.push(""));
          }

          grid.forEach((gridRow, dr) => {
            const targetRow = rIdx + dr;
            if (targetRow === -1) {
              gridRow.forEach((val, dc) => {
                this.currentHeaders[cIdx + dc] = val;
              });
            } else {
              while (this.currentRows.length <= targetRow) {
                this.currentRows.push(new Array(this.currentHeaders.length).fill(""));
              }
              gridRow.forEach((val, dc) => {
                this.currentRows[targetRow][cIdx + dc] = val;
              });
            }
          });

          rebuildAndSync(rIdx, cIdx);
          return;
        }
      }

      const sanitized = text.replace(/\r?\n/g, " ");
      insertNodeAtCellSelection(cellEditor, document.createTextNode(sanitized));
      cellEditor.dispatchEvent(new Event("input", { bubbles: true }));
    };

    // Pointer Events 行列拖拽排序与列宽调整
    const attachColumnDragAndResize = (th: HTMLElement, cIdx: number) => {
      const colGrip = document.createElement("span");
      colGrip.className = "tbl-col-drag-grip";
      colGrip.contentEditable = "false";
      colGrip.title = "按住左右拖动交换列顺序";
      colGrip.textContent = "⋯";

      let isDraggingCol = false;
      let startX = 0;
      let targetColIdx: number | null = null;

      colGrip.addEventListener("pointerdown", (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        flushActiveCellContent();
        isDraggingCol = true;
        startX = e.clientX;
        targetColIdx = null;
        colGrip.setPointerCapture(e.pointerId);
        th.classList.add("tbl-dragging-source");
      });

      colGrip.addEventListener("pointermove", (e: PointerEvent) => {
        if (!isDraggingCol) return;
        if (Math.abs(e.clientX - startX) < 5) return;

        table.querySelectorAll("th, td").forEach((el) => {
          el.classList.remove("tbl-drop-col-left", "tbl-drop-col-right");
        });

        const ths = Array.from(table.querySelectorAll<HTMLElement>("thead th"));
        targetColIdx = null;
        for (let i = 0; i < ths.length; i++) {
          if (i === cIdx) continue;
          const r = ths[i].getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right) {
            targetColIdx = i;
            const cls = i < cIdx ? "tbl-drop-col-left" : "tbl-drop-col-right";
            table.querySelectorAll(`[data-col="${i}"]`).forEach((cell) => cell.classList.add(cls));
            break;
          }
        }
      });

      const endColDrag = (e: PointerEvent, commit: boolean) => {
        if (!isDraggingCol) return;
        isDraggingCol = false;
        try {
          if (colGrip.hasPointerCapture(e.pointerId)) colGrip.releasePointerCapture(e.pointerId);
        } catch {}
        th.classList.remove("tbl-dragging-source");
        table.querySelectorAll("th, td").forEach((el) => {
          el.classList.remove("tbl-drop-col-left", "tbl-drop-col-right");
        });

        if (commit && targetColIdx !== null && targetColIdx !== cIdx) {
          hasUserEdited = true;
          const [movedHeader] = this.currentHeaders.splice(cIdx, 1);
          this.currentHeaders.splice(targetColIdx, 0, movedHeader);

          const [movedAlign] = this.currentAlignments.splice(cIdx, 1);
          this.currentAlignments.splice(targetColIdx, 0, movedAlign);

          const [movedWidth] = this.colWidthsPx.splice(cIdx, 1);
          this.colWidthsPx.splice(targetColIdx, 0, movedWidth);

          this.currentRows.forEach((row) => {
            const [movedCell] = row.splice(cIdx, 1);
            row.splice(targetColIdx!, 0, movedCell);
          });

          rebuildAndSync(-1, targetColIdx, "end");
        }
      };

      colGrip.addEventListener("pointerup", (e) => endColDrag(e, true));
      colGrip.addEventListener("pointercancel", (e) => endColDrag(e, false));

      // 列宽拖拽调节把手
      const resizer = document.createElement("span");
      resizer.className = "tbl-col-resizer";
      resizer.contentEditable = "false";
      resizer.title = "拖动调整列宽，双击恢复自适应宽度";

      let isResizing = false;
      let resizeStartX = 0;
      let startWidth = 0;

      resizer.addEventListener("pointerdown", (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        resizeStartX = e.clientX;
        startWidth = th.getBoundingClientRect().width;
        resizer.setPointerCapture(e.pointerId);
        resizer.classList.add("active");
      });

      resizer.addEventListener("pointermove", (e: PointerEvent) => {
        if (!isResizing) return;
        const newW = Math.max(56, Math.round(startWidth + (e.clientX - resizeStartX)));
        this.colWidthsPx[cIdx] = newW;
        table.querySelectorAll<HTMLElement>(`[data-col="${cIdx}"]`).forEach((cell) => {
          cell.style.width = `${newW}px`;
          cell.style.minWidth = `${newW}px`;
        });
      });

      const stopResize = (e: PointerEvent) => {
        if (!isResizing) return;
        isResizing = false;
        resizer.classList.remove("active");
        try {
          if (resizer.hasPointerCapture(e.pointerId)) resizer.releasePointerCapture(e.pointerId);
        } catch {}
      };

      resizer.addEventListener("pointerup", stopResize);
      resizer.addEventListener("pointercancel", stopResize);
      resizer.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this.colWidthsPx[cIdx] = null;
        table.querySelectorAll<HTMLElement>(`[data-col="${cIdx}"]`).forEach((cell) => {
          cell.style.width = "";
          cell.style.minWidth = "";
        });
      });

      th.appendChild(colGrip);
      th.appendChild(resizer);
    };

    const attachRowDragGrip = (firstTd: HTMLElement, rIdx: number) => {
      const rowGrip = document.createElement("span");
      rowGrip.className = "tbl-row-drag-grip";
      rowGrip.contentEditable = "false";
      rowGrip.title = "按住上下拖动调整行顺序";
      rowGrip.textContent = "⋮";

      let isDraggingRow = false;
      let startY = 0;
      let targetRowIdx: number | null = null;

      rowGrip.addEventListener("pointerdown", (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        flushActiveCellContent();
        isDraggingRow = true;
        startY = e.clientY;
        targetRowIdx = null;
        rowGrip.setPointerCapture(e.pointerId);
        firstTd.parentElement?.classList.add("tbl-dragging-source");
      });

      rowGrip.addEventListener("pointermove", (e: PointerEvent) => {
        if (!isDraggingRow) return;
        if (Math.abs(e.clientY - startY) < 5) return;

        table.querySelectorAll("tbody tr").forEach((tr) => {
          tr.classList.remove("tbl-drop-row-top", "tbl-drop-row-bottom");
        });

        const trs = Array.from(table.querySelectorAll<HTMLElement>("tbody tr"));
        targetRowIdx = null;
        for (let i = 0; i < trs.length; i++) {
          if (i === rIdx) continue;
          const r = trs[i].getBoundingClientRect();
          if (e.clientY >= r.top && e.clientY <= r.bottom) {
            targetRowIdx = i;
            trs[i].classList.add(i < rIdx ? "tbl-drop-row-top" : "tbl-drop-row-bottom");
            break;
          }
        }
      });

      const endRowDrag = (e: PointerEvent, commit: boolean) => {
        if (!isDraggingRow) return;
        isDraggingRow = false;
        try {
          if (rowGrip.hasPointerCapture(e.pointerId)) rowGrip.releasePointerCapture(e.pointerId);
        } catch {}
        firstTd.parentElement?.classList.remove("tbl-dragging-source");
        table.querySelectorAll("tbody tr").forEach((tr) => {
          tr.classList.remove("tbl-drop-row-top", "tbl-drop-row-bottom");
        });

        if (commit && targetRowIdx !== null && targetRowIdx !== rIdx) {
          hasUserEdited = true;
          const [movedRow] = this.currentRows.splice(rIdx, 1);
          this.currentRows.splice(targetRowIdx, 0, movedRow);
          rebuildAndSync(targetRowIdx, activeCol, "end");
        }
      };

      rowGrip.addEventListener("pointerup", (e) => endRowDrag(e, true));
      rowGrip.addEventListener("pointercancel", (e) => endRowDrag(e, false));

      firstTd.appendChild(rowGrip);
    };

    const bindCellEvents = (cell: HTMLElement, cellEditor: HTMLElement, rIdx: number, cIdx: number) => {
      cellEditor.addEventListener("focus", () => {
        activeRow = rIdx;
        activeCol = cIdx;
        container.classList.add("focused");
        updateToolbarPositionAndState();
        centerElementInTypewriter(view, cell);
      });

      cell.addEventListener("pointerdown", (e) => {
        const t = e.target as HTMLElement;
        if (
          t.closest(".tbl-col-drag-grip, .tbl-row-drag-grip, .tbl-col-resizer")
        ) {
          return;
        }
        activeRow = rIdx;
        activeCol = cIdx;
        updateToolbarPositionAndState();
        if (t === cell && document.activeElement !== cellEditor) {
          cellEditor.focus({ preventScroll: true });
        }
      });

      cell.addEventListener("contextmenu", () => {
        activeRow = rIdx;
        activeCol = cIdx;
        updateToolbarPositionAndState();
      });

      cellEditor.addEventListener("input", () => {
        if (isRebuildingDOM || isUndoingOrRedoing) return;
        hasUserEdited = true;
        const val = formatHTMLToMarkdown(cell);
        if (rIdx === -1) {
          this.currentHeaders[cIdx] = val;
        } else if (this.currentRows[rIdx]) {
          this.currentRows[rIdx][cIdx] = val;
        }
        if (debouncedInputTimer) clearTimeout(debouncedInputTimer);
        debouncedInputTimer = setTimeout(() => {
          debouncedInputTimer = null;
          if (cell.isConnected && !isUndoingOrRedoing) {
            syncToDoc();
          }
        }, 260);
      });

      cellEditor.addEventListener("blur", () => {
        // 关键防护：在 DOM 重建、Ctrl+Z 撤销重做、节点已卸载或用户根本未编辑时，严禁触发 syncToDoc 覆写底层文档！
        if (
          isRebuildingDOM ||
          isUndoingOrRedoing ||
          !cell.isConnected ||
          !hasUserEdited ||
          container.dataset.forceRebuild === "1"
        ) {
          return;
        }
        const val = formatHTMLToMarkdown(cell);
        if (rIdx === -1) {
          if (cIdx < this.currentHeaders.length) {
            this.currentHeaders[cIdx] = val;
          }
        } else if (rIdx >= 0 && rIdx < this.currentRows.length && this.currentRows[rIdx]) {
          if (cIdx < this.currentRows[rIdx].length) {
            this.currentRows[rIdx][cIdx] = val;
          }
        }
        syncToDoc();
      });

      cellEditor.addEventListener("paste", (e) => handleCellPaste(e, rIdx, cIdx, cellEditor));
    };

    const renderTableDOM = () => {
      isRebuildingDOM = true;
      try {
        table.innerHTML = "";
        const cols = Math.max(
          this.currentHeaders.length,
          ...this.currentRows.map((r) => r.length),
          1
        );

        const thead = document.createElement("thead");
        const trHead = document.createElement("tr");
        for (let cIdx = 0; cIdx < cols; cIdx++) {
          const text = this.currentHeaders[cIdx] || "";
          const th = document.createElement("th");
          th.style.textAlign = this.currentAlignments[cIdx] || "left";
          if (this.colWidthsPx[cIdx]) {
            th.style.width = `${this.colWidthsPx[cIdx]}px`;
            th.style.minWidth = `${this.colWidthsPx[cIdx]}px`;
          }
          th.dataset.row = "-1";
          th.dataset.col = String(cIdx);

          const editorSpan = document.createElement("div");
          editorSpan.className = "tbl-cell-editor";
          editorSpan.contentEditable = "true";
          editorSpan.spellcheck = false;
          editorSpan.innerHTML = formatMarkdownToHTML(text);

          th.appendChild(editorSpan);
          attachColumnDragAndResize(th, cIdx);
          bindCellEvents(th, editorSpan, -1, cIdx);
          trHead.appendChild(th);
        }
        thead.appendChild(trHead);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        this.currentRows.forEach((row, rIdx) => {
          const tr = document.createElement("tr");
          for (let cIdx = 0; cIdx < cols; cIdx++) {
            const td = document.createElement("td");
            td.style.textAlign = this.currentAlignments[cIdx] || "left";
            if (this.colWidthsPx[cIdx]) {
              td.style.width = `${this.colWidthsPx[cIdx]}px`;
              td.style.minWidth = `${this.colWidthsPx[cIdx]}px`;
            }
            td.dataset.row = String(rIdx);
            td.dataset.col = String(cIdx);

            const editorSpan = document.createElement("div");
            editorSpan.className = "tbl-cell-editor";
            editorSpan.contentEditable = "true";
            editorSpan.spellcheck = false;
            editorSpan.innerHTML = formatMarkdownToHTML(row[cIdx] || "");

            td.appendChild(editorSpan);
            if (cIdx === 0) {
              attachRowDragGrip(td, rIdx);
            }
            bindCellEvents(td, editorSpan, rIdx, cIdx);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        updateToolbarPositionAndState();
      } finally {
        isRebuildingDOM = false;
      }
    };

    const focusCell = (
      rowIdx: number,
      colIdx: number,
      caretPlacement: "start" | "end" = "end"
    ) => {
      const targetR = Math.max(-1, Math.min(rowIdx, this.currentRows.length - 1));
      const targetC = Math.max(0, Math.min(colIdx, this.currentHeaders.length - 1));
      activeRow = targetR;
      activeCol = targetC;
      const cell = table.querySelector(
        `[data-row="${targetR}"][data-col="${targetC}"]`
      ) as HTMLElement | null;
      const cellEditor = (cell?.querySelector(".tbl-cell-editor") as HTMLElement) || cell;
      if (cellEditor) {
        cellEditor.focus({ preventScroll: true });
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(cellEditor);
          range.collapse(caretPlacement === "start");
          sel.removeAllRanges();
          sel.addRange(range);
        }
        updateToolbarPositionAndState();
      }
    };

    /**
     * 先同步底层 CodeMirror 文档 (syncToDoc)，再重建 DOM 并原位聚焦单元格，
     * 彻底杜绝先聚焦后 dispatch 导致焦点被 CodeMirror 抢走及 blur 二次污染的问题
     */
    const rebuildAndSync = (
      nextRow: number,
      nextCol: number,
      caretPlacement: "start" | "end" = "end"
    ) => {
      hasUserEdited = true;
      syncToDoc(true);
      renderTableDOM();
      focusCell(nextRow, nextCol, caretPlacement);
    };

    const flushActiveCellContent = () => {
      const activeEditor = table.querySelector(".tbl-cell-editor:focus") as HTMLElement | null;
      const activeCell = activeEditor?.closest("th, td") as HTMLElement | null;
      if (activeCell && activeCell.isConnected) {
        const r = parseInt(activeCell.dataset.row || "0", 10);
        const c = parseInt(activeCell.dataset.col || "0", 10);
        const val = formatHTMLToMarkdown(activeCell);
        if (r === -1) {
          if (this.currentHeaders[c] !== undefined && this.currentHeaders[c] !== val) {
            this.currentHeaders[c] = val;
            hasUserEdited = true;
          }
        } else if (
          this.currentRows[r] &&
          this.currentRows[r][c] !== undefined &&
          this.currentRows[r][c] !== val
        ) {
          this.currentRows[r][c] = val;
          hasUserEdited = true;
        }
      }
    };

    renderTableDOM();

    let isSelecting = false;
    let selectStart: { r: number; c: number } | null = null;
    let selectedRange: { r1: number; c1: number; r2: number; c2: number } | null = null;

    const clearSelection = () => {
      selectedRange = null;
      table.querySelectorAll(".cell-range-selected").forEach((el) => {
        el.classList.remove("cell-range-selected");
      });
    };

    const updateSelectionHighlight = () => {
      if (!selectedRange) {
        clearSelection();
        return;
      }
      table.querySelectorAll("th, td").forEach((cell) => {
        const r = parseInt((cell as HTMLElement).dataset.row || "0", 10);
        const c = parseInt((cell as HTMLElement).dataset.col || "0", 10);
        if (
          r >= selectedRange!.r1 &&
          r <= selectedRange!.r2 &&
          c >= selectedRange!.c1 &&
          c <= selectedRange!.c2
        ) {
          cell.classList.add("cell-range-selected");
        } else {
          cell.classList.remove("cell-range-selected");
        }
      });
    };

    const onWindowMouseUp = () => {
      isSelecting = false;
      selectStart = null;
      window.removeEventListener("mouseup", onWindowMouseUp);
    };

    table.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (
        (e.target as HTMLElement).closest(
          ".tbl-col-drag-grip, .tbl-row-drag-grip, .tbl-col-resizer"
        )
      ) {
        return;
      }
      const cell = (e.target as HTMLElement).closest("th, td") as HTMLElement;
      if (!cell) {
        clearSelection();
        return;
      }
      selectStart = {
        r: parseInt(cell.dataset.row || "0", 10),
        c: parseInt(cell.dataset.col || "0", 10),
      };
      isSelecting = true;
      clearSelection();
      window.addEventListener("mouseup", onWindowMouseUp);
    });

    table.addEventListener("mousemove", (e) => {
      if (!isSelecting || !selectStart) return;
      const cell = (e.target as HTMLElement).closest("th, td") as HTMLElement;
      if (!cell) return;
      const curR = parseInt(cell.dataset.row || "0", 10);
      const curC = parseInt(cell.dataset.col || "0", 10);

      if (curR !== selectStart.r || curC !== selectStart.c) {
        selectedRange = {
          r1: Math.min(selectStart.r, curR),
          c1: Math.min(selectStart.c, curC),
          r2: Math.max(selectStart.r, curR),
          c2: Math.max(selectStart.c, curC),
        };
        updateSelectionHighlight();
      }
    });

    const getCaretBoundary = (cellEditor: HTMLElement): { atStart: boolean; atEnd: boolean } => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return { atStart: false, atEnd: false };
      const range = sel.getRangeAt(0);
      if (!range.collapsed || !cellEditor.contains(range.startContainer)) {
        return { atStart: false, atEnd: false };
      }
      const preRange = range.cloneRange();
      preRange.selectNodeContents(cellEditor);
      preRange.setEnd(range.startContainer, range.startOffset);

      const postRange = range.cloneRange();
      postRange.selectNodeContents(cellEditor);
      postRange.setStart(range.endContainer, range.endOffset);

      return {
        atStart: preRange.toString().length === 0,
        atEnd: postRange.toString().length === 0,
      };
    };

    const refocusTableAfterUndoRedo = (
      savedR: number,
      savedC: number,
      savedScrollTop: number
    ) => {
      view.scrollDOM.scrollTop = savedScrollTop;
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = savedScrollTop;
        const figures = Array.from(
          view.dom.querySelectorAll<HTMLElement>("figure.table-figure")
        );
        const targetIdx = Number(container.dataset.tableIdx);
        const matchFig =
          figures.find((f) => Number(f.dataset.fromPos) === this.trackedFromPos) ||
          (!Number.isNaN(targetIdx) ? figures[targetIdx] : undefined);
        if (matchFig) {
          const cell =
            matchFig.querySelector<HTMLElement>(`[data-row="${savedR}"][data-col="${savedC}"]`) ||
            matchFig.querySelector<HTMLElement>(`[data-row="0"][data-col="0"]`) ||
            matchFig.querySelector<HTMLElement>("td, th");
          const editorEl =
            (cell?.querySelector(".tbl-cell-editor") as HTMLElement) || cell;
          editorEl?.focus({ preventScroll: true });
          view.scrollDOM.scrollTop = savedScrollTop;
        }
      });
    };

    container.addEventListener("keydown", (e: KeyboardEvent) => {
      // 1. 优先捕获 Ctrl+Z 撤销 与 Ctrl+Y / Ctrl+Shift+Z 重做（严格加锁阻止 blur 回写，并锁定视口 scrollTop）
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (debouncedInputTimer) {
          flushActiveCellContent();
          syncToDoc();
        }
        const savedR = activeRow;
        const savedC = activeCol;
        const savedScrollTop = view.scrollDOM.scrollTop;
        isUndoingOrRedoing = true;
        container.dataset.forceRebuild = "1";
        try {
          undo(view);
        } finally {
          view.scrollDOM.scrollTop = savedScrollTop;
        }
        refocusTableAfterUndoRedo(savedR, savedC, savedScrollTop);
        return;
      }
      if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (debouncedInputTimer) {
          flushActiveCellContent();
          syncToDoc();
        }
        const savedR = activeRow;
        const savedC = activeCol;
        const savedScrollTop = view.scrollDOM.scrollTop;
        isUndoingOrRedoing = true;
        container.dataset.forceRebuild = "1";
        try {
          redo(view);
        } finally {
          view.scrollDOM.scrollTop = savedScrollTop;
        }
        refocusTableAfterUndoRedo(savedR, savedC, savedScrollTop);
        return;
      }

      const cellEditor = (e.target as HTMLElement).closest(
        ".tbl-cell-editor"
      ) as HTMLElement | null;
      const targetCell = (e.target as HTMLElement).closest("th, td") as HTMLElement | null;

      // 1.5 表格单元格内富文本快捷键支持（含 Ctrl+K 插入超链接）
      if (cellEditor && cellEditor.isContentEditable) {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "b") {
          e.preventDefault();
          e.stopPropagation();
          toggleCellInlineTag(cellEditor, "strong");
          return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "i") {
          e.preventDefault();
          e.stopPropagation();
          toggleCellInlineTag(cellEditor, "em");
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "x") {
          e.preventDefault();
          e.stopPropagation();
          toggleCellInlineTag(cellEditor, "del");
          return;
        }
        if (
          (e.ctrlKey || e.metaKey) &&
          !e.shiftKey &&
          (e.key.toLowerCase() === "e" || e.key === "`")
        ) {
          e.preventDefault();
          e.stopPropagation();
          toggleCellInlineTag(cellEditor, "code");
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "h") {
          e.preventDefault();
          e.stopPropagation();
          toggleCellInlineTag(cellEditor, "mark");
          return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
          e.preventDefault();
          e.stopPropagation();
          promptCellInlineLink(cellEditor, () => {
            hasUserEdited = true;
            flushActiveCellContent();
            syncToDoc(true);
          });
          return;
        }
      }

      // 2. 跨单元格多选复制与清空快捷键
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && selectedRange) {
        e.preventDefault();
        e.stopPropagation();
        const tsvLines: string[] = [];
        for (let r = selectedRange.r1; r <= selectedRange.r2; r++) {
          const rowVals: string[] = [];
          for (let c = selectedRange.c1; c <= selectedRange.c2; c++) {
            if (r === -1) {
              rowVals.push(this.currentHeaders[c] || "");
            } else {
              rowVals.push(this.currentRows[r] ? this.currentRows[r][c] || "" : "");
            }
          }
          tsvLines.push(rowVals.join("\t"));
        }
        navigator.clipboard.writeText(tsvLines.join("\n"));
        return;
      }

      if ((e.key === "Backspace" || e.key === "Delete") && selectedRange) {
        e.preventDefault();
        e.stopPropagation();
        const focusR = selectedRange.r1;
        const focusC = selectedRange.c1;
        for (let r = selectedRange.r1; r <= selectedRange.r2; r++) {
          for (let c = selectedRange.c1; c <= selectedRange.c2; c++) {
            if (r === -1) {
              this.currentHeaders[c] = "";
            } else if (this.currentRows[r]) {
              this.currentRows[r][c] = "";
            }
          }
        }
        clearSelection();
        rebuildAndSync(focusR, focusC, "start");
        return;
      }

      if (e.key === "Escape") {
        clearSelection();
        return;
      }

      if (!targetCell || !cellEditor) return;

      const r = parseInt(targetCell.dataset.row || "0", 10);
      const c = parseInt(targetCell.dataset.col || "0", 10);
      const cols = this.currentHeaders.length;

      // 2.5 Typora 快捷键：Ctrl+Enter 下方插入行，Ctrl+Shift+Backspace 删除当前行
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        flushActiveCellContent();
        const insertIdx = r === -1 ? 0 : r + 1;
        this.currentRows.splice(insertIdx, 0, new Array(cols).fill(""));
        rebuildAndSync(insertIdx, c, "start");
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        executeToolbarAction("del-row");
        return;
      }

      // 2.6 Shift+Enter 在单元格内安全插入 <br> 换行
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        insertNodeAtCellSelection(cellEditor, document.createElement("br"));
        cellEditor.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      // 3. 上下方向键：表内跨行移动 + 首尾行平滑跳出表格
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        flushActiveCellContent();
        if (hasUserEdited) syncToDoc();
        clearSelection();
        if (r === -1) {
          const { from } = resolveCurrentTableSpan();
          const beforePos = Math.max(0, from - 1);
          view.dispatch({ selection: { anchor: beforePos }, scrollIntoView: true });
          view.focus();
        } else {
          focusCell(r - 1, c, "end");
        }
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        flushActiveCellContent();
        if (hasUserEdited) syncToDoc();
        clearSelection();
        if (r === this.currentRows.length - 1) {
          const { to } = resolveCurrentTableSpan();
          const afterPos = Math.min(view.state.doc.length, to + 1);
          view.dispatch({ selection: { anchor: afterPos }, scrollIntoView: true });
          view.focus();
        } else {
          focusCell(r + 1, c, "end");
        }
        return;
      }

      // 3.1 左右方向键：单元格首尾边界跨格流转 + 首末格离开表格
      if (e.key === "ArrowLeft" && !e.shiftKey) {
        const { atStart } = getCaretBoundary(cellEditor);
        if (atStart) {
          e.preventDefault();
          e.stopPropagation();
          flushActiveCellContent();
          if (hasUserEdited) syncToDoc();
          clearSelection();
          if (c > 0) {
            focusCell(r, c - 1, "end");
          } else if (r > -1) {
            focusCell(r - 1, cols - 1, "end");
          } else {
            const { from } = resolveCurrentTableSpan();
            const beforePos = Math.max(0, from - 1);
            view.dispatch({ selection: { anchor: beforePos }, scrollIntoView: true });
            view.focus();
          }
          return;
        }
      }

      if (e.key === "ArrowRight" && !e.shiftKey) {
        const { atEnd } = getCaretBoundary(cellEditor);
        if (atEnd) {
          e.preventDefault();
          e.stopPropagation();
          flushActiveCellContent();
          if (hasUserEdited) syncToDoc();
          clearSelection();
          if (c + 1 < cols) {
            focusCell(r, c + 1, "start");
          } else if (r + 1 < this.currentRows.length) {
            focusCell(r + 1, 0, "start");
          } else {
            const { to } = resolveCurrentTableSpan();
            const afterPos = Math.min(view.state.doc.length, to + 1);
            view.dispatch({ selection: { anchor: afterPos }, scrollIntoView: true });
            view.focus();
          }
          return;
        }
      }

      // 4. Tab / Shift+Tab 单元格跳格与自动续行
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        flushActiveCellContent();
        if (hasUserEdited) syncToDoc();
        clearSelection();
        if (!e.shiftKey) {
          if (c + 1 < cols) {
            focusCell(r, c + 1, "end");
          } else if (r === -1) {
            focusCell(0, 0, "end");
          } else if (r + 1 < this.currentRows.length) {
            focusCell(r + 1, 0, "end");
          } else {
            this.currentRows.push(new Array(cols).fill(""));
            rebuildAndSync(this.currentRows.length - 1, 0, "start");
          }
        } else {
          if (c - 1 >= 0) {
            focusCell(r, c - 1, "end");
          } else if (r > 0) {
            focusCell(r - 1, cols - 1, "end");
          } else if (r === 0) {
            focusCell(-1, cols - 1, "end");
          }
        }
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        flushActiveCellContent();
        if (hasUserEdited) syncToDoc();
        clearSelection();
        if (r === -1) {
          focusCell(0, c, "end");
        } else if (r + 1 < this.currentRows.length) {
          focusCell(r + 1, c, "end");
        } else {
          this.currentRows.push(new Array(cols).fill(""));
          rebuildAndSync(this.currentRows.length - 1, c, "start");
        }
      }
    });

    const executeToolbarAction = (act: string | undefined) => {
      if (!act) return;
      flushActiveCellContent();
      const cols = this.currentHeaders.length;

      if (act === "align-left") {
        this.currentAlignments[activeCol] = "left";
        rebuildAndSync(activeRow, activeCol);
      } else if (act === "align-center") {
        this.currentAlignments[activeCol] = "center";
        rebuildAndSync(activeRow, activeCol);
      } else if (act === "align-right") {
        this.currentAlignments[activeCol] = "right";
        rebuildAndSync(activeRow, activeCol);
      } else if (act === "add-row-above") {
        const insertIdx = activeRow === -1 ? 0 : activeRow;
        this.currentRows.splice(insertIdx, 0, new Array(cols).fill(""));
        rebuildAndSync(insertIdx, activeCol, "start");
      } else if (act === "add-row-below") {
        const insertIdx = activeRow === -1 ? 0 : activeRow + 1;
        this.currentRows.splice(insertIdx, 0, new Array(cols).fill(""));
        rebuildAndSync(insertIdx, activeCol, "start");
      } else if (act === "add-col-left") {
        this.currentHeaders.splice(activeCol, 0, "");
        this.currentAlignments.splice(activeCol, 0, "left");
        this.colWidthsPx.splice(activeCol, 0, null);
        this.currentRows.forEach((row) => row.splice(activeCol, 0, ""));
        rebuildAndSync(activeRow, activeCol, "start");
      } else if (act === "add-col-right") {
        this.currentHeaders.splice(activeCol + 1, 0, "");
        this.currentAlignments.splice(activeCol + 1, 0, "left");
        this.colWidthsPx.splice(activeCol + 1, 0, null);
        this.currentRows.forEach((row) => row.splice(activeCol + 1, 0, ""));
        rebuildAndSync(activeRow, activeCol + 1, "start");
      } else if (act === "del-row") {
        if (activeRow === -1) {
          if (this.currentRows.length > 0) {
            this.currentHeaders = [...this.currentRows[0]];
            this.currentRows.splice(0, 1);
            if (this.currentRows.length === 0) {
              this.currentRows.push(new Array(cols).fill(""));
            }
            rebuildAndSync(-1, activeCol, "end");
          }
        } else if (this.currentRows.length > 1) {
          this.currentRows.splice(activeRow, 1);
          const nextR = Math.min(activeRow, this.currentRows.length - 1);
          rebuildAndSync(nextR, activeCol, "end");
        } else if (this.currentRows.length === 1) {
          const isRowEmpty = this.currentRows[0].every((c) => !c.trim());
          if (!isRowEmpty) {
            this.currentRows[0] = new Array(cols).fill("");
            rebuildAndSync(0, activeCol, "start");
          } else {
            // 若唯一数据行已为空且用户再次点击删行，则删除整个表格（支持 Ctrl+Z 一键恢复）
            executeToolbarAction("del-table");
          }
        }
      } else if (act === "del-col") {
        if (this.currentHeaders.length > 1) {
          this.currentHeaders.splice(activeCol, 1);
          this.currentAlignments.splice(activeCol, 1);
          this.colWidthsPx.splice(activeCol, 1);
          this.currentRows.forEach((row) => row.splice(activeCol, 1));
          const nextC = Math.min(activeCol, this.currentHeaders.length - 1);
          rebuildAndSync(activeRow, nextC, "end");
        } else {
          this.currentHeaders[0] = "";
          this.currentRows.forEach((row) => {
            row[0] = "";
          });
          rebuildAndSync(activeRow, 0, "start");
        }
      } else if (act === "del-table") {
        isUndoingOrRedoing = true;
        const { from, to } = resolveCurrentTableSpan();
        const delFrom = from > 0 && view.state.sliceDoc(from - 1, from) === "\n" ? from - 1 : from;
        view.dispatch({
          changes: { from: delFrom, to, insert: "" },
          selection: { anchor: delFrom },
          userEvent: "delete.table",
        });
        view.focus();
      }
    };

    toolbar.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = (e.target as HTMLElement).closest(".tbl-btn") as HTMLElement;
      if (!btn) return;
      executeToolbarAction(btn.dataset.act);
    });

    addColEdgeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      flushActiveCellContent();
      const newColIdx = this.currentHeaders.length;
      this.currentHeaders.push(`表头 ${newColIdx + 1}`);
      this.currentAlignments.push("left");
      this.colWidthsPx.push(null);
      this.currentRows.forEach((row) => row.push(""));
      rebuildAndSync(-1, newColIdx, "end");
    });

    addRowEdgeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      flushActiveCellContent();
      const cols = this.currentHeaders.length;
      this.currentRows.push(new Array(cols).fill(""));
      rebuildAndSync(this.currentRows.length - 1, 0, "start");
    });

    container.addEventListener("focusin", () => {
      container.classList.add("focused");
      updateToolbarPositionAndState();
    });
    container.addEventListener("focusout", (e) => {
      if (isRebuildingDOM || isUndoingOrRedoing) return;
      const rel = (e as FocusEvent).relatedTarget as Node | null;
      if (!rel || !container.contains(rel)) {
        container.classList.remove("focused");
      }
    });

    tableWrap.appendChild(table);
    tableWrap.appendChild(addColEdgeBtn);
    container.appendChild(toolbar);
    container.appendChild(tableWrap);
    container.appendChild(addRowEdgeBtn);
    return container;
  }

  eq(other: InteractiveTableWidget): boolean {
    if (
      this.lines.length !== other.lines.length ||
      this.fromPos !== other.fromPos ||
      this.toPos !== other.toPos ||
      this.tableIdx !== other.tableIdx
    ) {
      return false;
    }
    return this.lines.every((l, i) => l === other.lines[i]);
  }
}

function computeTableDecorations(state: EditorState): DecorationSet {
  if (typeof document !== "undefined" && document.body.classList.contains("source-mode")) {
    return Decoration.none;
  }

  const tables = findTablesInDoc(state);
  if (tables.length === 0) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();

  tables.forEach((t, idx) => {
    builder.add(
      t.from,
      t.to,
      Decoration.replace({
        widget: new InteractiveTableWidget(t.lines, t.from, t.to, idx),
        block: true,
      })
    );
  });

  return builder.finish();
}

export const tableLiveViewField = StateField.define<DecorationSet>({
  create(state) {
    return computeTableDecorations(state);
  },
  update(decorations, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(forceRefreshEffect))) {
      return computeTableDecorations(tr.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const insertTableCommand = (view: EditorView): boolean => {
  const selection = view.state.selection.main;
  const currentLine = view.state.doc.lineAt(selection.head);
  const needLeadingNewline = currentLine.text.trim().length > 0 ? "\n" : "";

  const sampleTable = `${needLeadingNewline}\n| 表头 1 | 表头 2 | 表头 3 |\n| :--- | :---: | ---: |\n|  |  |  |\n`;
  view.dispatch({
    changes: { from: currentLine.to, insert: sampleTable },
    selection: { anchor: currentLine.to + sampleTable.length },
  });
  return true;
};

export const tableKeymap: KeyBinding[] = [
  {
    key: "Mod-Alt-t",
    run: insertTableCommand,
  },
];
