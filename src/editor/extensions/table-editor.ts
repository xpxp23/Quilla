import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import { EditorView, KeyBinding, WidgetType, Decoration, DecorationSet } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import katex from "katex";
import { centerElementInTypewriter } from "./typewriter-mode";
import { forceRefreshEffect } from "./refresh-effect";

/**
 * 判断一行是否为 Markdown 表格分隔线行 (如 | :--- | :---: | ---: |)
 */
export function isTableDelimiter(lineText: string): boolean {
  const trimmed = lineText.trim();
  if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
  const parts = trimmed
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return false;
  return parts.every((p) => /^:?-+:?$/.test(p));
}

export interface TableBlock {
  startLine: number;
  endLine: number;
  from: number;
  to: number;
  lines: string[];
}

/**
 * 扫描文档中所有的 Markdown 表格块 (自动跳过围栏代码块内部)
 */
export function findTablesInDoc(state: EditorState): TableBlock[] {
  const doc = state.doc;
  const tables: TableBlock[] = [];
  let inTable = false;
  let inFence = false;
  let fenceChar = "";
  let startLine = 0;
  let from = 0;
  let lines: string[] = [];

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const trimmed = line.text.trim();

    if (/^(```+|~~~+)/.test(trimmed)) {
      const marker = trimmed.startsWith("`") ? "`" : "~";
      if (!inFence) {
        if (inTable && lines.length >= 2) {
          const endLine = i - 1;
          const to = doc.line(endLine).to;
          tables.push({ startLine, endLine, from, to, lines });
          inTable = false;
          lines = [];
        }
        inFence = true;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        inFence = false;
      }
      continue;
    }

    if (inFence) continue;

    if (!inTable) {
      if (trimmed.includes("|") && i < doc.lines) {
        const nextLine = doc.line(i + 1);
        if (isTableDelimiter(nextLine.text)) {
          inTable = true;
          startLine = i;
          from = line.from;
          lines = [line.text];
        }
      }
    } else {
      if (trimmed.includes("|") && trimmed.length > 0) {
        lines.push(line.text);
      } else {
        if (lines.length >= 2) {
          const endLine = i - 1;
          const to = doc.line(endLine).to;
          tables.push({ startLine, endLine, from, to, lines });
        }
        inTable = false;
        lines = [];
      }
    }
  }

  if (inTable && lines.length >= 2) {
    const endLine = doc.lines;
    const to = doc.line(endLine).to;
    tables.push({ startLine, endLine, from, to, lines });
  }

  return tables;
}

/**
 * 将二维数据与对齐方式重新序列化为格式化规范的 Markdown 表格
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
    colWidths[i] = Math.max(colWidths[i], h.length);
  });
  normalizedRows.forEach((row) => {
    row.forEach((cell, i) => {
      colWidths[i] = Math.max(colWidths[i], cell.length);
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
  lines.push(`| ${normalizedHeaders.map((h, i) => h.padEnd(colWidths[i], " ")).join(" | ")} |`);
  lines.push(`| ${delimiterRow.join(" | ")} |`);
  normalizedRows.forEach((row) => {
    lines.push(`| ${row.map((c, i) => c.padEnd(colWidths[i], " ")).join(" | ")} |`);
  });

  return lines.join("\n");
}

/**
 * 将单元格文本中的行内 Markdown 转换为富文本 HTML
 */
export function formatMarkdownToHTML(text: string): string {
  if (!text) return "";

  const placeholders: string[] = [];
  const pushPlaceholder = (htmlSnippet: string): string => {
    const id = `\u0000PH_${placeholders.length}_\u0000`;
    placeholders.push(htmlSnippet);
    return id;
  };

  // 0. 预处理 <br> 标签为占位符
  let working = text.replace(/<br\s*\/?>/gi, () => pushPlaceholder("<br>"));

  // 1. 转义 HTML 特殊字符
  working = working
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 2. 优先提取行内代码 `code`
  working = working.replace(/`([^`\n]+)`/g, (_m, codeContent) =>
    pushPlaceholder(`<code>${codeContent}</code>`)
  );

  // 3. 优先提取行内数学公式 $tex$
  working = working.replace(
    /(?<![\\$\d])\$([^\s$\\](?:[^$\n]*?[^\s$\\])?)\$(?!\d)/g,
    (_m, tex) => {
      const rawTex = tex.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      const safeAttr = rawTex.replace(/"/g, "&quot;");
      try {
        const rendered = katex.renderToString(rawTex, {
          displayMode: false,
          throwOnError: false,
          output: "html",
        });
        return pushPlaceholder(
          `<span class="tbl-inline-math" contenteditable="false" data-tex="${safeAttr}">${rendered}</span>`
        );
      } catch {
        return pushPlaceholder(
          `<span class="tbl-inline-math" contenteditable="false" data-tex="${safeAttr}">$${tex}$</span>`
        );
      }
    }
  );

  // 4. 提取超链接 [text](url)
  working = working.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_m, label, url) => {
    const safeUrl = url.replace(/"/g, "&quot;");
    return pushPlaceholder(
      `<a href="${safeUrl}" class="cm-link tbl-inline-link" data-href="${safeUrl}">${label}</a>`
    );
  });

  // 5. 加粗斜体 ***text*** 或 ___text___
  working = working.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  working = working.replace(/___([^_]+)___/g, "<strong><em>$1</em></strong>");

  // 6. 加粗 **text** 或 __text__
  working = working.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  working = working.replace(/__([^_]+)__/g, "<strong>$1</strong>");

  // 7. 单星号斜体 *text* 或 单下划线斜体 _text_
  working = working.replace(/(?<!\*)\*([^*\s][^*]*?)\*(?!\*)/g, "<em>$1</em>");
  working = working.replace(/(?<!_)_([^_\s][^_]*?)_(?!_)/g, "<em>$1</em>");

  // 8. 删除线 ~~text~~ 与 高亮 ==text==
  working = working.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  working = working.replace(/==([^=]+)==/g, "<mark>$1</mark>");

  // 9. 上下标
  working = working.replace(/(?<!~)~([^~\s][^~]*?)~(?!~)/g, "<sub>$1</sub>");
  working = working.replace(/\^([^\^\s][^\^]*?)\^/g, "<sup>$1</sup>");

  // 10. 还原所有保护占位符
  working = working.replace(/\u0000PH_(\d+)_\u0000/g, (_m, idx) => placeholders[Number(idx)] || "");

  return working;
}

/**
 * 将单元格 DOM 结构逆向转换为规范的 Markdown 格式文本
 * 兼容语义标签与跨平台 WebView 产生的内联 style (font-weight/font-style/text-decoration)
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
      const tagName = el.tagName.toUpperCase();

      if (el.classList.contains("tbl-inline-math") && el.dataset.tex) {
        return `$${el.dataset.tex}$`;
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

  let result = "";
  cell.childNodes.forEach((child) => {
    result += serializeNode(child);
  });
  return result
    .replace(/^(?:<br>)+/i, "")
    .replace(/(?:<br>)+$/i, "")
    .replace(/\r?\n/g, " ")
    .trim();
}

/**
 * 现代 Selection/Range 原生 DOM 富文本包裹与插入辅助（彻底替代废弃的 document.execCommand）
 */
function insertNodeAtCellSelection(cell: HTMLElement, node: Node) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    cell.appendChild(node);
    return;
  }
  const range = sel.getRangeAt(0);
  if (!cell.contains(range.commonAncestorContainer)) {
    cell.appendChild(node);
    return;
  }
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function toggleCellInlineTag(cell: HTMLElement, tagName: "strong" | "em" | "del" | "code" | "mark") {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!cell.contains(range.commonAncestorContainer)) return;

  const upper = tagName.toUpperCase();
  const parentEl =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as HTMLElement)
      : range.commonAncestorContainer.parentElement;
  const existingTag = parentEl?.closest(tagName);

  if (existingTag && cell.contains(existingTag)) {
    // 解包已有标签
    const frag = document.createDocumentFragment();
    while (existingTag.firstChild) {
      frag.appendChild(existingTag.firstChild);
    }
    existingTag.replaceWith(frag);
    cell.dispatchEvent(new Event("input", { bubbles: true }));
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
    cell.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    // 选区为空时若处于某标签内则跳出，否则包装当前整个单元格文字
    if (cell.children.length === 1 && cell.firstElementChild?.tagName === upper) {
      const inner = cell.firstElementChild;
      const frag = document.createDocumentFragment();
      while (inner.firstChild) frag.appendChild(inner.firstChild);
      inner.replaceWith(frag);
    } else if (cell.textContent?.trim()) {
      const wrapper = document.createElement(tagName);
      while (cell.firstChild) wrapper.appendChild(cell.firstChild);
      cell.appendChild(wrapper);
    }
    cell.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/**
 * 可视化表格内联可编辑组件 (In-Place Interactive TableWidget)
 */
class InteractiveTableWidget extends WidgetType {
  private currentHeaders: string[] = [];
  private currentRows: string[][] = [];
  private currentAlignments: Array<"left" | "center" | "right"> = [];
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
    return Math.max(110, rowCount * 36 + 52);
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  updateDOM(dom: HTMLElement): boolean {
    if (dom.dataset.forceRebuild === "1") {
      delete dom.dataset.forceRebuild;
      return false;
    }
    if (dom.dataset.keepAlive === "1" || dom.contains(document.activeElement)) {
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

    const resolveCurrentTableSpan = (): { from: number; to: number } => {
      const attrFrom = Number(container.dataset.fromPos);
      const attrIdx = Number(container.dataset.tableIdx);
      if (!Number.isNaN(attrFrom)) {
        this.trackedFromPos = attrFrom;
      }
      const allTables = findTablesInDoc(view.state);
      if (allTables.length > 0) {
        // 1. 精确坐标匹配
        const exact = allTables.find((t) => t.from === this.trackedFromPos);
        if (exact) {
          this.trackedFromPos = exact.from;
          this.trackedToPos = exact.to;
          container.dataset.fromPos = String(exact.from);
          container.dataset.toPos = String(exact.to);
          return { from: exact.from, to: exact.to };
        }
        // 2. 表格序号匹配
        if (!Number.isNaN(attrIdx) && attrIdx >= 0 && attrIdx < allTables.length) {
          const byIdx = allTables[attrIdx];
          this.trackedFromPos = byIdx.from;
          this.trackedToPos = byIdx.to;
          container.dataset.fromPos = String(byIdx.from);
          container.dataset.toPos = String(byIdx.to);
          return { from: byIdx.from, to: byIdx.to };
        }
        // 3. 最近距离回退
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
      const newMarkdown = serializeMarkdownTable(
        this.currentHeaders,
        this.currentRows,
        this.currentAlignments
      );

      try {
        const { from, to } = resolveCurrentTableSpan();
        const existingMarkdown = view.state.sliceDoc(from, to);
        if (!forceDispatch && existingMarkdown === newMarkdown) {
          return;
        }

        this.trackedFromPos = from;
        this.trackedToPos = from + newMarkdown.length;
        container.dataset.fromPos = String(this.trackedFromPos);
        container.dataset.toPos = String(this.trackedToPos);

        container.dataset.keepAlive = "1";
        view.dispatch({
          changes: { from, to, insert: newMarkdown },
        });
        delete container.dataset.keepAlive;
      } catch (err) {
        delete container.dataset.keepAlive;
        console.error("同步表格到文档失败:", err);
      }
    };

    const toolbar = document.createElement("div");
    toolbar.className = "table-floating-toolbar";
    toolbar.innerHTML = `
      <div class="toolbar-group table-dim-group" title="表格规模 (行数 × 列数)">
        <span class="table-dim-badge" id="tbl-dim-badge">0 × 0</span>
      </div>
      <div class="toolbar-sep"></div>
      <div class="toolbar-group">
        <button type="button" class="tbl-btn" data-act="align-left" title="当前列居左">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="17" y1="10" x2="3" y2="10"></line><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="14" x2="3" y2="14"></line><line x1="17" y1="18" x2="3" y2="18"></line></svg>
          <span>居左</span>
        </button>
        <button type="button" class="tbl-btn" data-act="align-center" title="当前列居中">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="10" x2="6" y2="10"></line><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="14" x2="3" y2="14"></line><line x1="18" y1="18" x2="6" y2="18"></line></svg>
          <span>居中</span>
        </button>
        <button type="button" class="tbl-btn" data-act="align-right" title="当前列居右">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="7" y2="10"></line><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="14" x2="3" y2="14"></line><line x1="21" y1="18" x2="7" y2="18"></line></svg>
          <span>居右</span>
        </button>
      </div>
      <div class="toolbar-sep"></div>
      <div class="toolbar-group">
        <button type="button" class="tbl-btn" data-act="add-row-above" title="上方插入行">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
          <span>+行↑</span>
        </button>
        <button type="button" class="tbl-btn" data-act="add-row-below" title="下方插入行 (Ctrl+Enter)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
          <span>+行↓</span>
        </button>
        <button type="button" class="tbl-btn" data-act="add-col-left" title="左侧插入列">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
          <span>+列←</span>
        </button>
        <button type="button" class="tbl-btn" data-act="add-col-right" title="右侧插入列">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          <span>+列→</span>
        </button>
      </div>
      <div class="toolbar-sep"></div>
      <div class="toolbar-group">
        <button type="button" class="tbl-btn danger" data-act="del-row" title="删除当前行 (Ctrl+Shift+Backspace)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          <span>删行</span>
        </button>
        <button type="button" class="tbl-btn danger" data-act="del-col" title="删除当前列">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          <span>删列</span>
        </button>
        <button type="button" class="tbl-btn danger" data-act="del-table" title="删除整个表格">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          <span>删表</span>
        </button>
      </div>
    `;

    const table = document.createElement("table");
    table.className = "md-table in-place-edit";

    const updateToolbarState = () => {
      const dimBadge = toolbar.querySelector("#tbl-dim-badge");
      if (dimBadge) {
        dimBadge.textContent = `${this.currentRows.length + 1} × ${this.currentHeaders.length}`;
      }
      const curAlign = this.currentAlignments[activeCol] || "left";
      toolbar.querySelectorAll("[data-act^='align-']").forEach((btn) => {
        const el = btn as HTMLElement;
        el.classList.toggle("active", el.dataset.act === `align-${curAlign}`);
      });
    };

    const handleCellPaste = (e: ClipboardEvent, rIdx: number, cIdx: number, cell: HTMLElement) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text/plain") || "";
      if (!text) return;

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
      insertNodeAtCellSelection(cell, document.createTextNode(sanitized));
      cell.dispatchEvent(new Event("input", { bubbles: true }));
    };

    const bindCellEvents = (cell: HTMLElement, rIdx: number, cIdx: number) => {
      cell.addEventListener("focus", () => {
        activeRow = rIdx;
        activeCol = cIdx;
        container.classList.add("focused");
        updateToolbarState();
        centerElementInTypewriter(view, cell);
      });

      cell.addEventListener("pointerdown", () => {
        activeRow = rIdx;
        activeCol = cIdx;
        updateToolbarState();
        centerElementInTypewriter(view, cell);
      });

      cell.addEventListener("contextmenu", () => {
        activeRow = rIdx;
        activeCol = cIdx;
        updateToolbarState();
      });

      cell.addEventListener("input", () => {
        if (isRebuildingDOM) return;
        const val = formatHTMLToMarkdown(cell);
        if (rIdx === -1) {
          this.currentHeaders[cIdx] = val;
        } else if (this.currentRows[rIdx]) {
          this.currentRows[rIdx][cIdx] = val;
        }
      });

      cell.addEventListener("blur", () => {
        if (isRebuildingDOM || !cell.isConnected) return;
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

      cell.addEventListener("paste", (e) => handleCellPaste(e, rIdx, cIdx, cell));
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
          th.contentEditable = "true";
          th.spellcheck = false;
          th.style.textAlign = this.currentAlignments[cIdx] || "left";
          th.innerHTML = formatMarkdownToHTML(text);
          th.dataset.row = "-1";
          th.dataset.col = String(cIdx);
          bindCellEvents(th, -1, cIdx);
          trHead.appendChild(th);
        }
        thead.appendChild(trHead);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        this.currentRows.forEach((row, rIdx) => {
          const tr = document.createElement("tr");
          for (let cIdx = 0; cIdx < cols; cIdx++) {
            const td = document.createElement("td");
            td.contentEditable = "true";
            td.spellcheck = false;
            td.style.textAlign = this.currentAlignments[cIdx] || "left";
            td.innerHTML = formatMarkdownToHTML(row[cIdx] || "");
            td.dataset.row = String(rIdx);
            td.dataset.col = String(cIdx);
            bindCellEvents(td, rIdx, cIdx);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        updateToolbarState();
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
      if (cell) {
        cell.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(cell);
          range.collapse(caretPlacement === "start");
          sel.removeAllRanges();
          sel.addRange(range);
        }
        updateToolbarState();
      }
    };

    const rebuildAndSync = (
      nextRow: number,
      nextCol: number,
      caretPlacement: "start" | "end" = "end"
    ) => {
      renderTableDOM();
      focusCell(nextRow, nextCol, caretPlacement);
      syncToDoc(true);
    };

    const flushActiveCellContent = () => {
      const activeEl = table.querySelector("th:focus, td:focus") as HTMLElement | null;
      if (activeEl && activeEl.isConnected) {
        const r = parseInt(activeEl.dataset.row || "0", 10);
        const c = parseInt(activeEl.dataset.col || "0", 10);
        const val = formatHTMLToMarkdown(activeEl);
        if (r === -1) {
          if (this.currentHeaders[c] !== undefined) this.currentHeaders[c] = val;
        } else if (this.currentRows[r] && this.currentRows[r][c] !== undefined) {
          this.currentRows[r][c] = val;
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

    table.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
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

    const onMouseUp = () => {
      if (!container.isConnected) {
        window.removeEventListener("mouseup", onMouseUp);
        return;
      }
      isSelecting = false;
      selectStart = null;
    };
    window.addEventListener("mouseup", onMouseUp);

    const getCaretBoundary = (cellEl: HTMLElement): { atStart: boolean; atEnd: boolean } => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return { atStart: false, atEnd: false };
      const range = sel.getRangeAt(0);
      if (!range.collapsed || !cellEl.contains(range.startContainer)) {
        return { atStart: false, atEnd: false };
      }
      const preRange = range.cloneRange();
      preRange.selectNodeContents(cellEl);
      preRange.setEnd(range.startContainer, range.startOffset);

      const postRange = range.cloneRange();
      postRange.selectNodeContents(cellEl);
      postRange.setStart(range.endContainer, range.endOffset);

      return {
        atStart: preRange.toString().length === 0,
        atEnd: postRange.toString().length === 0,
      };
    };

    const refocusTableAfterUndoRedo = (savedR: number, savedC: number) => {
      requestAnimationFrame(() => {
        const figures = Array.from(
          view.dom.querySelectorAll<HTMLElement>("figure.table-figure")
        );
        const matchFig =
          figures.find((f) => Number(f.dataset.fromPos) === this.trackedFromPos) ||
          figures[Number(container.dataset.tableIdx) || 0] ||
          figures[0];
        if (matchFig) {
          const cell =
            matchFig.querySelector<HTMLElement>(`[data-row="${savedR}"][data-col="${savedC}"]`) ||
            matchFig.querySelector<HTMLElement>("td, th");
          cell?.focus();
        }
      });
    };

    table.addEventListener("keydown", (e: KeyboardEvent) => {
      // 1. 优先捕获 Ctrl+Z 撤销 与 Ctrl+Y / Ctrl+Shift+Z 重做
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const savedR = activeRow;
        const savedC = activeCol;
        container.dataset.forceRebuild = "1";
        undo(view);
        refocusTableAfterUndoRedo(savedR, savedC);
        return;
      }
      if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
      ) {
        e.preventDefault();
        e.stopPropagation();
        const savedR = activeRow;
        const savedC = activeCol;
        container.dataset.forceRebuild = "1";
        redo(view);
        refocusTableAfterUndoRedo(savedR, savedC);
        return;
      }

      const target = (e.target as HTMLElement).closest("th, td") as HTMLElement | null;

      // 1.5 原生 DOM Selection 富文本快捷键支持 (Ctrl+B / Ctrl+I / Ctrl+Shift+X / Ctrl+E / Ctrl+Shift+H)
      if (target && target.isContentEditable) {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "b") {
          e.preventDefault();
          e.stopPropagation();
          toggleCellInlineTag(target, "strong");
          return;
        }
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "i") {
          e.preventDefault();
          e.stopPropagation();
          toggleCellInlineTag(target, "em");
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "x") {
          e.preventDefault();
          e.stopPropagation();
          toggleCellInlineTag(target, "del");
          return;
        }
        if (
          (e.ctrlKey || e.metaKey) &&
          !e.shiftKey &&
          (e.key.toLowerCase() === "e" || e.key === "`")
        ) {
          e.preventDefault();
          e.stopPropagation();
          toggleCellInlineTag(target, "code");
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "h") {
          e.preventDefault();
          e.stopPropagation();
          toggleCellInlineTag(target, "mark");
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

      if (!target || !target.isContentEditable) return;

      const r = parseInt(target.dataset.row || "0", 10);
      const c = parseInt(target.dataset.col || "0", 10);
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
        insertNodeAtCellSelection(target, document.createElement("br"));
        target.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      // 3. 上下方向键：表内跨行移动 + 首尾行平滑跳出表格
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        flushActiveCellContent();
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
        const { atStart } = getCaretBoundary(target);
        if (atStart) {
          e.preventDefault();
          e.stopPropagation();
          flushActiveCellContent();
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
        const { atEnd } = getCaretBoundary(target);
        if (atEnd) {
          e.preventDefault();
          e.stopPropagation();
          flushActiveCellContent();
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
        this.currentRows.forEach((row) => row.splice(activeCol, 0, ""));
        rebuildAndSync(activeRow, activeCol, "start");
      } else if (act === "add-col-right") {
        this.currentHeaders.splice(activeCol + 1, 0, "");
        this.currentAlignments.splice(activeCol + 1, 0, "left");
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
            focusCell(-1, activeCol, "end");
          }
        }
      } else if (act === "del-col") {
        if (this.currentHeaders.length > 1) {
          this.currentHeaders.splice(activeCol, 1);
          this.currentAlignments.splice(activeCol, 1);
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
        const { from, to } = resolveCurrentTableSpan();
        const delFrom = from > 0 && view.state.sliceDoc(from - 1, from) === "\n" ? from - 1 : from;
        view.dispatch({
          changes: { from: delFrom, to, insert: "" },
          selection: { anchor: delFrom },
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

    container.addEventListener("focusin", () => {
      container.classList.add("focused");
    });
    container.addEventListener("focusout", (e) => {
      if (isRebuildingDOM) return;
      const rel = (e as FocusEvent).relatedTarget as Node | null;
      if (!rel || !container.contains(rel)) {
        container.classList.remove("focused");
      }
    });

    container.appendChild(toolbar);
    container.appendChild(table);
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
    key: "Ctrl-Alt-t",
    run: insertTableCommand,
  },
];
