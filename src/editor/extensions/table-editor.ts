import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import { EditorView, KeyBinding, WidgetType, Decoration, DecorationSet } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { centerElementInTypewriter } from "./typewriter-mode";

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
 * 扫描文档中所有的 Markdown 表格块
 */
export function findTablesInDoc(state: EditorState): TableBlock[] {
  const doc = state.doc;
  const tables: TableBlock[] = [];
  let inTable = false;
  let startLine = 0;
  let from = 0;
  let lines: string[] = [];

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const trimmed = line.text.trim();

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
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const normalizedHeaders = new Array(colCount).fill("").map((_, i) => headers[i] || `列 ${i + 1}`);
  const normalizedRows = rows.map((r) =>
    new Array(colCount).fill("").map((_, i) => (r[i] !== undefined ? r[i] : ""))
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

  const delimiterRow = alignments.map((align, i) => {
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
  // 1. 转义 HTML 特殊字符
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 2. 加粗斜体 ***text*** 或 ___text___
  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/___([^_]+)___/g, "<strong><em>$1</em></strong>");

  // 3. 加粗 **text** 或 __text__
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");

  // 4. 单星号斜体 *text* 或 单下划线斜体 _text_
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/(?<!_)_([^_]+)_(?!_)/g, "<em>$1</em>");

  // 5. 删除线 ~~text~~
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // 6. 行内代码 `text`
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // 7. 支持换行 <br>
  html = html.replace(/&lt;br\s*\/?&gt;/gi, "<br>");

  return html;
}

/**
 * 将单元格 DOM 结构逆向转换为规范的 Markdown 格式文本
 */
export function formatHTMLToMarkdown(cell: HTMLElement): string {
  function serializeNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || "";
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tagName = el.tagName.toUpperCase();
      let inner = "";
      el.childNodes.forEach((child) => {
        inner += serializeNode(child);
      });

      if (tagName === "STRONG" || tagName === "B") {
        return `**${inner}**`;
      }
      if (tagName === "EM" || tagName === "I") {
        return `*${inner}*`;
      }
      if (tagName === "DEL" || tagName === "S" || tagName === "STRIKE") {
        return `~~${inner}~~`;
      }
      if (tagName === "CODE") {
        return `\`${inner}\``;
      }
      if (tagName === "BR") {
        return "<br>";
      }
      return inner;
    }
    return "";
  }

  let result = "";
  cell.childNodes.forEach((child) => {
    result += serializeNode(child);
  });
  return result.trim();
}

/**
 * 可视化表格内联可编辑组件 (In-Place Interactive TableWidget)
 */
class InteractiveTableWidget extends WidgetType {
  private currentHeaders: string[] = [];
  private currentRows: string[][] = [];
  private currentAlignments: Array<"left" | "center" | "right"> = [];

  constructor(
    readonly lines: string[],
    readonly fromPos: number,
    readonly toPos: number
  ) {
    super();
  }

  // 动态预估表格真实物理高度，彻底解决 CodeMirror 滚动脱节与鼠标向下偏移
  get estimatedHeight(): number {
    const rowCount = this.lines.length;
    return Math.max(120, rowCount * 36 + 60);
  }

  // 必须返回 true，阻止 CodeMirror 拦截单元格内的点击与光标事件
  ignoreEvent(_event: Event): boolean {
    return true;
  }

  // 返回 true 保证 CodeMirror 复用当前 DOM 节点，不在输入过程中销毁聚焦节点
  updateDOM(_dom: HTMLElement): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("figure");
    container.className = "table-figure interactive-table";

    // 阻止鼠标事件冒泡给 CodeMirror，防止 CodeMirror 抢夺焦点
    container.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });

    const parseRowCells = (rowText: string): string[] => {
      let trimmed = rowText.trim();
      if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
      if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
      return trimmed.split("|").map((c) => c.trim());
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

    const syncToDoc = () => {
      const newMarkdown = serializeMarkdownTable(
        this.currentHeaders,
        this.currentRows,
        this.currentAlignments
      );

      try {
        const curLine = view.state.doc.lineAt(Math.min(this.fromPos, view.state.doc.length));
        let startLine = curLine.number;
        while (startLine > 1 && view.state.doc.line(startLine - 1).text.trim().includes("|")) {
          startLine--;
        }
        let endLine = curLine.number;
        while (endLine < view.state.doc.lines && view.state.doc.line(endLine + 1).text.trim().includes("|")) {
          endLine++;
        }
        const from = view.state.doc.line(startLine).from;
        const to = view.state.doc.line(endLine).to;

        view.dispatch({
          changes: { from, to, insert: newMarkdown },
        });
      } catch (err) {
        console.error("同步表格到文档失败:", err);
      }
    };

    // 悬浮工具条 (仅在聚焦单元格时显示，配备清晰 SVG 与语义标签)
    const toolbar = document.createElement("div");
    toolbar.className = "table-floating-toolbar";
    toolbar.innerHTML = `
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
        <button type="button" class="tbl-btn" data-act="add-row-below" title="下方插入行">
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
        <button type="button" class="tbl-btn danger" data-act="del-row" title="删除行">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          <span>删行</span>
        </button>
        <button type="button" class="tbl-btn danger" data-act="del-col" title="删除列">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          <span>删列</span>
        </button>
      </div>
    `;

    const table = document.createElement("table");
    table.className = "md-table in-place-edit";

    const renderTableDOM = () => {
      table.innerHTML = "";
      const cols = Math.max(this.currentHeaders.length, ...this.currentRows.map((r) => r.length), 1);

      // thead
      const thead = document.createElement("thead");
      const trHead = document.createElement("tr");
      this.currentHeaders.forEach((text, cIdx) => {
        const th = document.createElement("th");
        th.contentEditable = "true";
        th.spellcheck = false;
        th.style.textAlign = this.currentAlignments[cIdx] || "left";
        th.innerHTML = formatMarkdownToHTML(text);
        th.dataset.row = "-1";
        th.dataset.col = String(cIdx);

        th.addEventListener("focus", () => {
          activeRow = -1;
          activeCol = cIdx;
          container.classList.add("focused");
          centerElementInTypewriter(view, th);
        });

        th.addEventListener("pointerdown", () => {
          centerElementInTypewriter(view, th);
        });

        th.addEventListener("input", () => {
          this.currentHeaders[cIdx] = formatHTMLToMarkdown(th);
        });

        th.addEventListener("blur", () => {
          const val = formatHTMLToMarkdown(th);
          if (this.currentHeaders[cIdx] !== val) {
            this.currentHeaders[cIdx] = val;
            syncToDoc();
          }
        });

        trHead.appendChild(th);
      });
      thead.appendChild(trHead);
      table.appendChild(thead);

      // tbody
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

          td.addEventListener("focus", () => {
            activeRow = rIdx;
            activeCol = cIdx;
            container.classList.add("focused");
            centerElementInTypewriter(view, td);
          });

          td.addEventListener("pointerdown", () => {
            centerElementInTypewriter(view, td);
          });

          td.addEventListener("input", () => {
            this.currentRows[rIdx][cIdx] = formatHTMLToMarkdown(td);
          });

          td.addEventListener("blur", () => {
            const val = formatHTMLToMarkdown(td);
            if (this.currentRows[rIdx][cIdx] !== val) {
              this.currentRows[rIdx][cIdx] = val;
              syncToDoc();
            }
          });

          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
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
      isSelecting = false;
      selectStart = null;
    };
    window.addEventListener("mouseup", onMouseUp);

    const focusCell = (rowIdx: number, colIdx: number) => {
      const targetR = Math.max(-1, Math.min(rowIdx, this.currentRows.length - 1));
      const targetC = Math.max(0, Math.min(colIdx, this.currentHeaders.length - 1));
      const cell = table.querySelector(`[data-row="${targetR}"][data-col="${targetC}"]`) as HTMLElement;
      if (cell) {
        cell.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(cell);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    };

    // 单元格内键盘快捷导航与全局撤销/重做
    table.addEventListener("keydown", (e: KeyboardEvent) => {
      // 1. 优先捕获 Ctrl+Z 撤销 与 Ctrl+Y / Ctrl+Shift+Z 重做
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        undo(view);
        return;
      }
      if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
      ) {
        e.preventDefault();
        e.stopPropagation();
        redo(view);
        return;
      }

      // 1.5 加粗与斜体快捷键支持 (Ctrl+B / Ctrl+I)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        e.stopPropagation();
        document.execCommand("bold");
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        e.stopPropagation();
        document.execCommand("italic");
        return;
      }

      // 2. 跨单元格多选快捷键
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
        for (let r = selectedRange.r1; r <= selectedRange.r2; r++) {
          for (let c = selectedRange.c1; c <= selectedRange.c2; c++) {
            if (r === -1) {
              this.currentHeaders[c] = "";
            } else if (this.currentRows[r]) {
              this.currentRows[r][c] = "";
            }
          }
        }
        renderTableDOM();
        syncToDoc();
        clearSelection();
        return;
      }

      if (e.key === "Escape") {
        clearSelection();
        return;
      }

      const target = e.target as HTMLElement;
      if (!target || !target.isContentEditable) return;

      const r = parseInt(target.dataset.row || "0", 10);
      const c = parseInt(target.dataset.col || "0", 10);
      const cols = this.currentHeaders.length;
      // 2.1 捕获表格内撤销/重做，统一接入 CodeMirror 全局历史栈
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) redo(view);
        else undo(view);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        e.stopPropagation();
        redo(view);
        return;
      }

      // 3. 边界方向键跳出表格
      if (e.key === "ArrowUp" && r === -1) {
        e.preventDefault();
        clearSelection();
        const beforePos = Math.max(0, this.fromPos - 1);
        view.dispatch({ selection: { anchor: beforePos }, scrollIntoView: true });
        view.focus();
        return;
      }

      if (e.key === "ArrowDown" && r === this.currentRows.length - 1) {
        e.preventDefault();
        clearSelection();
        const afterPos = Math.min(view.state.doc.length, this.toPos + 1);
        view.dispatch({ selection: { anchor: afterPos }, scrollIntoView: true });
        view.focus();
        return;
      }

      // 3.1 左边界离开表格
      if (e.key === "ArrowLeft" && r === -1 && c === 0) {
        const sel = window.getSelection();
        if (sel && sel.anchorOffset === 0) {
          e.preventDefault();
          clearSelection();
          const beforePos = Math.max(0, this.fromPos - 1);
          view.dispatch({ selection: { anchor: beforePos }, scrollIntoView: true });
          view.focus();
          return;
        }
      }

      // 3.2 右边界离开表格
      if (e.key === "ArrowRight" && r === this.currentRows.length - 1 && c === cols - 1) {
        const sel = window.getSelection();
        const textLen = (target.textContent || "").length;
        if (sel && sel.anchorOffset >= textLen) {
          e.preventDefault();
          clearSelection();
          const afterPos = Math.min(view.state.doc.length, this.toPos + 1);
          view.dispatch({ selection: { anchor: afterPos }, scrollIntoView: true });
          view.focus();
          return;
        }
      }

      // 4. Tab / Shift+Tab 单元格跳转与自动续行
      if (e.key === "Tab") {
        e.preventDefault();
        clearSelection();
        if (!e.shiftKey) {
          if (c + 1 < cols) {
            focusCell(r, c + 1);
          } else if (r === -1) {
            focusCell(0, 0);
          } else if (r + 1 < this.currentRows.length) {
            focusCell(r + 1, 0);
          } else {
            // 在末尾按 Tab：自动增加下一行！
            this.currentRows.push(new Array(cols).fill(""));
            renderTableDOM();
            syncToDoc();
            setTimeout(() => focusCell(this.currentRows.length - 1, 0), 10);
          }
        } else {
          if (c - 1 >= 0) {
            focusCell(r, c - 1);
          } else if (r > 0) {
            focusCell(r - 1, cols - 1);
          } else if (r === 0) {
            focusCell(-1, cols - 1);
          }
        }
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        clearSelection();
        if (r === -1) {
          focusCell(0, c);
        } else if (r + 1 < this.currentRows.length) {
          focusCell(r + 1, c);
        } else {
          this.currentRows.push(new Array(cols).fill(""));
          renderTableDOM();
          syncToDoc();
          setTimeout(() => focusCell(this.currentRows.length - 1, c), 10);
        }
      }
    });

    // 工具栏交互
    toolbar.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = (e.target as HTMLElement).closest(".tbl-btn") as HTMLElement;
      if (!btn) return;

      // 在执行任何工具栏动作前，刷新当前聚焦单元格的富文本输入
      const activeEl = table.querySelector("th:focus, td:focus") as HTMLElement | null;
      if (activeEl) {
        const r = parseInt(activeEl.dataset.row || "0", 10);
        const c = parseInt(activeEl.dataset.col || "0", 10);
        const val = formatHTMLToMarkdown(activeEl);
        if (r === -1) {
          if (this.currentHeaders[c] !== undefined) this.currentHeaders[c] = val;
        } else {
          if (this.currentRows[r] && this.currentRows[r][c] !== undefined) this.currentRows[r][c] = val;
        }
      }

      const act = btn.dataset.act;
      const cols = this.currentHeaders.length;

      if (act === "align-left") {
        this.currentAlignments[activeCol] = "left";
        renderTableDOM();
        syncToDoc();
        focusCell(activeRow, activeCol);
      } else if (act === "align-center") {
        this.currentAlignments[activeCol] = "center";
        renderTableDOM();
        syncToDoc();
        focusCell(activeRow, activeCol);
      } else if (act === "align-right") {
        this.currentAlignments[activeCol] = "right";
        renderTableDOM();
        syncToDoc();
        focusCell(activeRow, activeCol);
      } else if (act === "add-row-above") {
        const insertIdx = activeRow === -1 ? 0 : activeRow;
        this.currentRows.splice(insertIdx, 0, new Array(cols).fill(""));
        renderTableDOM();
        syncToDoc();
        focusCell(insertIdx, activeCol);
      } else if (act === "add-row-below") {
        const insertIdx = activeRow === -1 ? 0 : activeRow + 1;
        this.currentRows.splice(insertIdx, 0, new Array(cols).fill(""));
        renderTableDOM();
        syncToDoc();
        focusCell(insertIdx, activeCol);
      } else if (act === "add-col-left") {
        this.currentHeaders.splice(activeCol, 0, `新列`);
        this.currentAlignments.splice(activeCol, 0, "left");
        this.currentRows.forEach((row) => row.splice(activeCol, 0, ""));
        renderTableDOM();
        syncToDoc();
        focusCell(activeRow, activeCol);
      } else if (act === "add-col-right") {
        this.currentHeaders.splice(activeCol + 1, 0, `新列`);
        this.currentAlignments.splice(activeCol + 1, 0, "left");
        this.currentRows.forEach((row) => row.splice(activeCol + 1, 0, ""));
        renderTableDOM();
        syncToDoc();
        focusCell(activeRow, activeCol + 1);
      } else if (act === "del-row") {
        if (activeRow >= 0 && this.currentRows.length > 1) {
          this.currentRows.splice(activeRow, 1);
          renderTableDOM();
          syncToDoc();
          focusCell(Math.min(activeRow, this.currentRows.length - 1), activeCol);
        }
      } else if (act === "del-col") {
        if (this.currentHeaders.length > 1) {
          this.currentHeaders.splice(activeCol, 1);
          this.currentAlignments.splice(activeCol, 1);
          this.currentRows.forEach((row) => row.splice(activeCol, 1));
          renderTableDOM();
          syncToDoc();
          focusCell(activeRow, Math.min(activeCol, this.currentHeaders.length - 1));
        }
      }
    });

    container.addEventListener("focusin", () => {
      container.classList.add("focused");
    });
    container.addEventListener("focusout", (e) => {
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
      this.toPos !== other.toPos
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

  for (const t of tables) {
    builder.add(
      t.from,
      t.to,
      Decoration.replace({
        widget: new InteractiveTableWidget(t.lines, t.from, t.to),
        block: true,
      })
    );
  }

  return builder.finish();
}

import { forceRefreshEffect } from "./refresh-effect";

/**
 * 表格实时预览与可视化内联编辑 StateField
 */
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

  const sampleTable = `\n| 列 1 | 列 2 | 列 3 |\n| :--- | :---: | ---: |\n| 单元格 | 单元格 | 单元格 |\n`;
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
