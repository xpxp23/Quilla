import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { imeState } from "./ime-guard";
import { isTableDelimiter } from "./table-editor";
import { findMermaidBlocks } from "./mermaid-extension";
import { findMathBlocks } from "./math-block-extension";
import { invoke } from "@tauri-apps/api/core";
import katex from "katex";
import { centerElementInTypewriter } from "./typewriter-mode";

export let activeDocumentPath: string | null = null;
export function setActiveDocumentPath(path: string | null) {
  activeDocumentPath = path;
}

// 1. KaTeX 数学公式 Widget (强制 HTML 矢量输出，无 MathML 冗余)
class MathWidget extends WidgetType {
  constructor(
    readonly mathStr: string,
    readonly isBlock: boolean,
    readonly clickPos: number
  ) {
    super();
  }

  get estimatedHeight(): number {
    return this.isBlock ? 60 : 24;
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = this.isBlock ? "md-math-block-preview" : "md-inline-math-preview";
    span.style.cursor = "pointer";
    span.title = "点击进入公式微观编辑";
    try {
      katex.render(this.mathStr, span, {
        displayMode: this.isBlock,
        throwOnError: false,
        output: "html",
      });
    } catch {
      span.textContent = `[Math Error: ${this.mathStr}]`;
    }
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      view.dispatch({ selection: { anchor: this.clickPos } });
      view.focus();
    });
    return span;
  }

  eq(other: MathWidget) {
    return (
      other.mathStr === this.mathStr &&
      other.isBlock === this.isBlock &&
      other.clickPos === this.clickPos
    );
  }
}

// 2. 任务列表 Checkbox Widget
class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }

  toDOM(view: EditorView) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "task-list-item-checkbox";
    input.checked = this.checked;
    input.addEventListener("click", (e) => {
      e.stopPropagation();
      const newChar = input.checked ? "x" : " ";
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 1, insert: newChar },
      });
    });
    return input;
  }

  eq(other: TaskWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }
}

// 3. 行内图片渲染 Widget (支持 width/align 自适应与浮层控制)
class ImageWidget extends WidgetType {
  constructor(
    readonly alt: string,
    readonly src: string,
    readonly pos: number,
    readonly endPos: number,
    readonly width: string = "",
    readonly align: string = "left"
  ) {
    super();
  }

  get estimatedHeight(): number {
    return 200;
  }

  toDOM(view: EditorView) {
    const figure = document.createElement("figure");
    figure.className = "md-image-card";
    figure.dataset.from = String(this.pos);
    figure.dataset.to = String(this.endPos);
    figure.dataset.src = this.src;
    figure.dataset.alt = this.alt;
    figure.dataset.width = this.width;
    figure.dataset.align = this.align;

    if (this.align === "center") {
      figure.style.textAlign = "center";
      figure.style.display = "block";
    } else if (this.align === "right") {
      figure.style.textAlign = "right";
      figure.style.display = "block";
    } else {
      figure.style.textAlign = "left";
    }

    const img = document.createElement("img");
    img.alt = this.alt;
    img.title = this.alt;
    if (this.width) {
      img.style.width = this.width;
      img.style.maxWidth = "100%";
    }

    img.onload = () => {
      view.requestMeasure();
    };

    if (this.src.startsWith("http://") || this.src.startsWith("https://") || this.src.startsWith("data:")) {
      img.src = this.src;
    } else {
      invoke<string>("read_image_base64", {
        docPath: activeDocumentPath,
        relPath: this.src,
      })
        .then((base64) => {
          img.src = base64;
          view.requestMeasure();
        })
        .catch(() => {
          img.src = this.src;
        });
    }

    if (this.alt) {
      const caption = document.createElement("figcaption");
      caption.textContent = this.alt;
      figure.appendChild(caption);
    }

    // 单击图片居中 (打字机模式)
    figure.addEventListener("click", () => {
      centerElementInTypewriter(view, figure);
    });

    figure.prepend(img);
    return figure;
  }

  eq(other: ImageWidget) {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.pos === this.pos &&
      other.endPos === this.endPos &&
      other.width === this.width &&
      other.align === this.align
    );
  }
}

// 4. 代码块头部语言与复制按钮 Widget
class CodeBlockHeaderWidget extends WidgetType {
  constructor(readonly lang: string, readonly codeText: string) {
    super();
  }

  get estimatedHeight(): number {
    return 34;
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  toDOM() {
    const header = document.createElement("div");
    header.className = "code-block-header-bar";

    const langSpan = document.createElement("span");
    langSpan.className = "code-lang-tag";
    langSpan.textContent = this.lang ? this.lang.toUpperCase() : "CODE";

    const copyBtn = document.createElement("button");
    copyBtn.className = "code-copy-btn";
    copyBtn.type = "button";
    copyBtn.innerHTML = "📋 复制";
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(this.codeText).then(() => {
        copyBtn.innerHTML = "✓ 已复制";
        setTimeout(() => {
          copyBtn.innerHTML = "📋 复制";
        }, 1600);
      });
    });

    header.appendChild(langSpan);
    header.appendChild(copyBtn);
    return header;
  }

  eq(other: CodeBlockHeaderWidget) {
    return other.lang === this.lang && other.codeText === this.codeText;
  }
}

// 5. 水平分割线 Widget (--- / *** / ___)
class HorizontalRuleWidget extends WidgetType {
  constructor(readonly lineFrom: number) {
    super();
  }

  get estimatedHeight(): number {
    return 48;
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  toDOM(view: EditorView) {
    const hr = document.createElement("hr");
    hr.className = "md-hr";
    hr.style.cursor = "pointer";
    hr.title = "点击编辑分割线 (---)";
    hr.addEventListener("click", (e) => {
      e.stopPropagation();
      view.dispatch({ selection: { anchor: this.lineFrom } });
      view.focus();
    });
    return hr;
  }

  eq(other: HorizontalRuleWidget) {
    return other.lineFrom === this.lineFrom;
  }
}

// 5. 动态 [TOC] 目录树 Widget
class TocWidget extends WidgetType {
  constructor(readonly linePos: number) {
    super();
  }

  get estimatedHeight(): number {
    return 120;
  }

  ignoreEvent(event: Event): boolean {
    return !(event.target as HTMLElement).classList.contains("cm-toc-item");
  }

  toDOM(view: EditorView) {
    const card = document.createElement("div");
    card.className = "cm-toc-card";
    const title = document.createElement("div");
    title.className = "cm-toc-title";
    title.innerHTML = `<span>📑</span><span>目录 (Table of Contents)</span>`;
    card.appendChild(title);

    const doc = view.state.doc;
    const list = document.createElement("ul");
    list.className = "cm-toc-list";

    let hasHeadings = false;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const m = line.text.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        hasHeadings = true;
        const level = m[1].length;
        const headingText = m[2].trim();
        const li = document.createElement("li");
        li.className = "cm-toc-item";
        li.style.paddingLeft = `${(level - 1) * 16}px`;
        li.textContent = `${level > 1 ? "• " : ""}${headingText}`;
        const targetPos = line.from;
        li.addEventListener("click", (e) => {
          e.stopPropagation();
          view.dispatch({
            selection: { anchor: targetPos },
            effects: [EditorView.scrollIntoView(targetPos, { y: "start", yMargin: 40 })],
          });
          view.focus();
        });
        list.appendChild(li);
      }
    }

    if (!hasHeadings) {
      const empty = document.createElement("div");
      empty.style.color = "var(--control-text-color, #888)";
      empty.style.fontSize = "12px";
      empty.textContent = "文档暂无标题";
      card.appendChild(empty);
    } else {
      card.appendChild(list);
    }

    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("cm-toc-item")) return;
      e.stopPropagation();
      view.dispatch({ selection: { anchor: this.linePos } });
      view.focus();
    });

    return card;
  }

  eq(other: TocWidget) {
    return other.linePos === this.linePos;
  }
}

// 6. 脚注角标 Widget
class FootnoteRefWidget extends WidgetType {
  constructor(readonly label: string, readonly clickPos: number) {
    super();
  }

  toDOM(view: EditorView) {
    const sup = document.createElement("sup");
    sup.className = "cm-footnote-ref";
    sup.textContent = `[${this.label}]`;
    sup.title = `脚注: [^${this.label}] 点击定位`;
    sup.addEventListener("click", (e) => {
      e.stopPropagation();
      // 在文档中查找对应的定义 [^label]:
      const doc = view.state.doc;
      const targetPattern = `[^${this.label}]:`;
      let targetPos = -1;
      for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        if (line.text.trim().startsWith(targetPattern)) {
          targetPos = line.from;
          break;
        }
      }
      if (targetPos !== -1) {
        view.dispatch({
          selection: { anchor: targetPos },
          effects: [EditorView.scrollIntoView(targetPos, { y: "center" })],
        });
      } else {
        view.dispatch({ selection: { anchor: this.clickPos } });
      }
      view.focus();
    });
    return sup;
  }

  eq(other: FootnoteRefWidget) {
    return other.label === this.label && other.clickPos === this.clickPos;
  }
}

interface InlineToken {
  type:
    | "code"
    | "math"
    | "image"
    | "bold"
    | "italic"
    | "bold_italic"
    | "strikethrough"
    | "highlight"
    | "subscript"
    | "superscript"
    | "footnote_ref"
    | "link"
    | "task";
  start: number;
  end: number;
  content: string;
  data?: any;
}

import { forceRefreshEffect } from "./refresh-effect";

function buildDecorations(view: EditorView): DecorationSet {
  if (typeof document !== "undefined" && document.body.classList.contains("source-mode")) {
    return Decoration.none;
  }

  const builder = new RangeSetBuilder<Decoration>();
  const selection = view.state.selection.main;
  const cursorHead = selection.head;
  const cursorLine = view.state.doc.lineAt(cursorHead).number;
  const doc = view.state.doc;
  const mermaidBlocks = findMermaidBlocks(view.state);
  const mathBlocks = findMathBlocks(view.state);

  // 1. 扫描普通代码块区间 (排除 mermaid 流程图，mermaid 交由 mermaidLiveViewField 专职处理)
  interface CodeRange {
    startLine: number;
    endLine: number;
    lang: string;
    codeText: string;
  }
  const codeRanges: CodeRange[] = [];
  let inCode = false;
  let inMermaid = false;
  let codeStart = 0;
  let codeLang = "";
  let codeLines: string[] = [];

  for (let i = 1; i <= doc.lines; i++) {
    const l = doc.line(i);
    const trimmed = l.text.trim();
    if (inMermaid) {
      if (/^```+$/.test(trimmed)) {
        inMermaid = false;
      }
      continue;
    }
    if (!inCode) {
      if (/^```+\s*mermaid/i.test(trimmed)) {
        inMermaid = true;
        continue;
      }
      const match = trimmed.match(/^```(\w*)$/);
      if (match) {
        inCode = true;
        codeStart = i;
        codeLang = match[1];
        codeLines = [];
      }
    } else {
      if (/^```+$/.test(trimmed)) {
        inCode = false;
        codeRanges.push({
          startLine: codeStart,
          endLine: i,
          lang: codeLang,
          codeText: codeLines.join("\n"),
        });
      } else {
        codeLines.push(l.text);
      }
    }
  }

  // 2. 遍历全篇文档逐行构建结构与行内装饰，确保 CodeMirror 内部 HeightMap 永远保持全局精确对齐，杜绝长文档底部光标偏移
  for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
    const line = doc.line(lineNum);
    const text = line.text;
    const trimmed = text.trim();

    // 2.1 检查是否位于普通代码块中
    const codeRange = codeRanges.find((r) => lineNum >= r.startLine && lineNum <= r.endLine);
    if (codeRange) {
      if (lineNum === codeRange.startLine) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({ class: "cm-code-block-first-line" })
        );
        const isCursorOnHeader = cursorLine === lineNum;
        if (!isCursorOnHeader) {
          builder.add(
            line.from,
            line.to,
            Decoration.replace({
              widget: new CodeBlockHeaderWidget(codeRange.lang, codeRange.codeText),
            })
          );
        }
      } else if (lineNum === codeRange.endLine) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({ class: "cm-code-block-last-line" })
        );
        const isCursorOnFooter = cursorLine === lineNum;
        if (!isCursorOnFooter) {
          builder.add(line.from, line.to, Decoration.replace({}));
        }
      } else {
        builder.add(
          line.from,
          line.from,
          Decoration.line({ class: "cm-code-block-line" })
        );
      }

      continue;
    }

    // 2.15 Mermaid 流程图块由 mermaidLiveViewField 专职处理
    const mermaidBlock = mermaidBlocks.find((b) => lineNum >= b.startLine && lineNum <= b.endLine);
    if (mermaidBlock) {
      const isEditingThisMermaid = cursorLine >= mermaidBlock.startLine && cursorLine <= mermaidBlock.endLine;
      if (isEditingThisMermaid) {
        if (lineNum === mermaidBlock.startLine) {
          builder.add(line.from, line.from, Decoration.line({ class: "cm-code-block-first-line" }));
        } else if (lineNum === mermaidBlock.endLine) {
          builder.add(line.from, line.from, Decoration.line({ class: "cm-code-block-last-line" }));
        } else {
          builder.add(line.from, line.from, Decoration.line({ class: "cm-code-block-line" }));
        }
      }
      continue;
    }

    // 2.16 多行独立数学公式块由 mathBlockLiveViewField 专职处理
    const mathBlock = mathBlocks.find((b) => lineNum >= b.startLine && lineNum <= b.endLine);
    if (mathBlock) {
      const isEditingThisMath = cursorLine >= mathBlock.startLine && cursorLine <= mathBlock.endLine;
      if (isEditingThisMath) {
        if (lineNum === mathBlock.startLine) {
          builder.add(line.from, line.from, Decoration.line({ class: "cm-code-block-first-line" }));
        } else if (lineNum === mathBlock.endLine) {
          builder.add(line.from, line.from, Decoration.line({ class: "cm-code-block-last-line" }));
        } else {
          builder.add(line.from, line.from, Decoration.line({ class: "cm-code-block-line" }));
        }
      }
      continue;
    }

    // 2.2 表格行交由专职 StateField 处理
    if (
      trimmed.startsWith("|") ||
      isTableDelimiter(trimmed)
    ) {
      continue;
    }

    // 2.3 水平分割线 (--- 或 *** 或 ___)
    const hrMatch = trimmed.match(/^(\-{3,}|\*{3,}|_{3,})$/);
    if (hrMatch) {
      const isCursorOnHr = cursorLine === lineNum;
      if (!isCursorOnHr) {
        builder.add(
          line.from,
          line.to,
          Decoration.replace({
            widget: new HorizontalRuleWidget(line.from),
          })
        );
        continue;
      }
    }

    // 2.35 动态 [TOC] 目录树
    const tocMatch = trimmed.match(/^\[TOC\]$/i);
    if (tocMatch) {
      const isCursorOnToc = cursorLine === lineNum;
      if (!isCursorOnToc) {
        builder.add(
          line.from,
          line.to,
          Decoration.replace({
            widget: new TocWidget(line.from),
          })
        );
        continue;
      }
    }

    // 2.4 独立单行公式块 ($$ formula $$)
    const blockMathMatch = trimmed.match(/^\$\$\s*(.+?)\s*\$\$$/);
    if (blockMathMatch) {
      const isCursorInMath = cursorHead >= line.from && cursorHead <= line.to;
      if (!isCursorInMath) {
        builder.add(
          line.from,
          line.to,
          Decoration.replace({
            widget: new MathWidget(blockMathMatch[1], true, line.from + 2),
          })
        );
        continue;
      }
    }

      let prefixEnd = 0;

      // 2.45 脚注定义行 ([^label]: ...)
      const fnDefMatch = text.match(/^\[\^([^\]\n]+)\]:\s*/);
      if (fnDefMatch) {
        builder.add(line.from, line.from, Decoration.line({ class: "cm-footnote-def" }));
      }

      // 2.5 标题识别 (# Title)
      const headerMatch = text.match(/^(#{1,6})\s+/);
      if (headerMatch) {
        const depth = headerMatch[1].length;
        const prefixLen = headerMatch[0].length;
        const isCursorAtPrefix = cursorHead >= line.from && cursorHead <= line.from + prefixLen;

        builder.add(
          line.from,
          line.from,
          Decoration.line({ class: `cm-heading cm-heading-${depth}` })
        );
        if (!isCursorAtPrefix) {
          builder.add(line.from, line.from + prefixLen, Decoration.replace({}));
        }
        prefixEnd = prefixLen;
      }

      // 2.6 引用块 (> Quote)
      const quoteMatch = text.match(/^>\s*/);
      if (quoteMatch && prefixEnd === 0) {
        const isCursorAtQuotePrefix = cursorHead >= line.from && cursorHead <= line.from + quoteMatch[0].length;
        builder.add(line.from, line.from, Decoration.line({ class: "cm-blockquote" }));
        if (!isCursorAtQuotePrefix) {
          builder.add(line.from, line.from + quoteMatch[0].length, Decoration.replace({}));
        }
        prefixEnd = quoteMatch[0].length;
      }

      // 2.68 列表项识别与多级缩进引导线 (Indent Guide Lines)
      const listMatch = text.match(/^(\s*)([-*+]|\d+\.)\s+/);
      if (listMatch && prefixEnd === 0) {
        const indentSpaces = listMatch[1].length;
        const level = Math.min(4, Math.floor(indentSpaces / 2) + 1);
        builder.add(
          line.from,
          line.from,
          Decoration.line({ class: `cm-list-item cm-list-level-${level}` })
        );
      }

      // 2.7 收集该行内所有 Token
      const tokens: InlineToken[] = [];

      // 任务列表 (- [ ] / - [x])
      const taskMatch = text.match(/^([-*+]\s+\[)([ xX])(\]\s*)/);
      if (taskMatch && prefixEnd === 0) {
        const prefixLen = taskMatch[1].length;
        const isChecked = taskMatch[2].toLowerCase() === "x";
        tokens.push({
          type: "task",
          start: 0,
          end: taskMatch[0].length,
          content: taskMatch[0],
          data: { isChecked, checkPos: prefixLen },
        });
      }

      // 行内图片 (![alt](src)) 与 HTML 图片标签 (<img ... />)
      const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
      let m;
      while ((m = imgRegex.exec(text)) !== null) {
        tokens.push({
          type: "image",
          start: m.index,
          end: m.index + m[0].length,
          content: m[0],
          data: { alt: m[1], src: m[2], width: "", align: "left" },
        });
      }

      const htmlImgRegex = /<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)\/?>/gi;
      while ((m = htmlImgRegex.exec(text)) !== null) {
        const fullAttrs = `${m[1]} ${m[3]}`;
        const altMatch = fullAttrs.match(/alt=["']([^"']*)["']/i);
        const widthMatch = fullAttrs.match(/width=["']([^"']*)["']/i);
        const alignMatch = fullAttrs.match(/align=["']([^"']*)["']/i);
        tokens.push({
          type: "image",
          start: m.index,
          end: m.index + m[0].length,
          content: m[0],
          data: {
            src: m[2],
            alt: altMatch ? altMatch[1] : "",
            width: widthMatch ? widthMatch[1] : "",
            align: alignMatch ? alignMatch[1] : "left",
          },
        });
      }

      // 超链接 ([text](url)) - 排除图片
      const linkRegex = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
      while ((m = linkRegex.exec(text)) !== null) {
        if (m.index > 0 && text[m.index - 1] === "!") {
          continue;
        }
        tokens.push({
          type: "link",
          start: m.index,
          end: m.index + m[0].length,
          content: m[0],
          data: { text: m[1], url: m[2] },
        });
      }

      // 行内代码 (`code`)
      const codeRegex = /`([^`\n]+)`/g;
      while ((m = codeRegex.exec(text)) !== null) {
        tokens.push({
          type: "code",
          start: m.index,
          end: m.index + m[0].length,
          content: m[1],
        });
      }

      // 行内数学公式 ($formula$)
      const mathRegex = /\$([^$\n]+)\$/g;
      while ((m = mathRegex.exec(text)) !== null) {
        if (m[1].startsWith("$") || m[1].endsWith("$")) continue;
        tokens.push({
          type: "math",
          start: m.index,
          end: m.index + m[0].length,
          content: m[1],
        });
      }

      // 行内加粗斜体 (***bold italic*** 或 ___bold italic___)
      const boldItalicRegex = /(\*{3}|_{3})([^*_\n]+?)\1/g;
      while ((m = boldItalicRegex.exec(text)) !== null) {
        tokens.push({
          type: "bold_italic",
          start: m.index,
          end: m.index + m[0].length,
          content: m[2],
        });
      }

      // 行内加粗 (**bold** 或 __bold__)
      const boldRegex = /(\*{2}|_{2})([^*_\n]+?)\1/g;
      while ((m = boldRegex.exec(text)) !== null) {
        tokens.push({
          type: "bold",
          start: m.index,
          end: m.index + m[0].length,
          content: m[2],
        });
      }

      // 行内斜体 (*italic* 或 _italic_) - 避免与 ** / __ 冲突
      const italicRegex = /(?<!\*)\*([^*\s\n][^*\n]*?)\*(?!\*)|(?<!_)_([^_\s\n][^_\n]*?)_(?!_)/g;
      while ((m = italicRegex.exec(text)) !== null) {
        tokens.push({
          type: "italic",
          start: m.index,
          end: m.index + m[0].length,
          content: m[1] || m[2],
        });
      }

      // 行内删除线 (~~del~~)
      const strikeRegex = /~~([^~\n]+)~~/g;
      while ((m = strikeRegex.exec(text)) !== null) {
        tokens.push({
          type: "strikethrough",
          start: m.index,
          end: m.index + m[0].length,
          content: m[1],
        });
      }

      // 行内高亮 (==mark==)
      const highlightRegex = /==([^=\n]+)==/g;
      while ((m = highlightRegex.exec(text)) !== null) {
        tokens.push({
          type: "highlight",
          start: m.index,
          end: m.index + m[0].length,
          content: m[1],
        });
      }

      // 行内脚注引用 [^note] (排除定义行)
      const fnRefRegex = /\[\^([^\]\n]+)\](?!\:)/g;
      while ((m = fnRefRegex.exec(text)) !== null) {
        tokens.push({
          type: "footnote_ref",
          start: m.index,
          end: m.index + m[0].length,
          content: m[0],
          data: { label: m[1] },
        });
      }

      // 行内下标 (H~2~O)
      const subRegex = /(?<!~)~([^~\s\n][^~\n]*?)~(?!~)/g;
      while ((m = subRegex.exec(text)) !== null) {
        tokens.push({
          type: "subscript",
          start: m.index,
          end: m.index + m[0].length,
          content: m[1],
        });
      }

      // 行内上标 (X^2^)
      const supRegex = /\^([^\^\s\n][^\^\n]*?)\^/g;
      while ((m = supRegex.exec(text)) !== null) {
        tokens.push({
          type: "superscript",
          start: m.index,
          end: m.index + m[0].length,
          content: m[1],
        });
      }

      // 按位置排序并过滤重叠
      tokens.sort((a, b) => a.start - b.start);
      const validTokens: InlineToken[] = [];
      let curLimit = prefixEnd;
      for (const tok of tokens) {
        if (tok.start >= curLimit) {
          validTokens.push(tok);
          curLimit = tok.end;
        }
      }

      // 核心：Token 级高雅微观局部展开 (Typora 原生交互：移入时内容保留样式，两端淡化定界符)
      for (const tok of validTokens) {
        const s = line.from + tok.start;
        const e = line.from + tok.end;

        const isCursorInside = cursorHead >= s && cursorHead <= e;

        if (tok.type === "task") {
          builder.add(
            s,
            e,
            Decoration.replace({
              widget: new TaskWidget(tok.data.isChecked, line.from + tok.data.checkPos),
            })
          );
        } else if (tok.type === "image") {
          if (!isCursorInside) {
            builder.add(
              s,
              e,
              Decoration.replace({
                widget: new ImageWidget(
                  tok.data.alt,
                  tok.data.src,
                  s,
                  e,
                  tok.data.width,
                  tok.data.align
                ),
              })
            );
          }
        } else if (tok.type === "bold_italic") {
          if (!isCursorInside) {
            builder.add(s, s + 3, Decoration.replace({}));
            builder.add(s + 3, e - 3, Decoration.mark({ class: "cm-strong cm-emphasis" }));
            builder.add(e - 3, e, Decoration.replace({}));
          } else {
            builder.add(s, s + 3, Decoration.mark({ class: "cm-md-delimiter" }));
            builder.add(s + 3, e - 3, Decoration.mark({ class: "cm-strong cm-emphasis" }));
            builder.add(e - 3, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "bold") {
          if (!isCursorInside) {
            builder.add(s, s + 2, Decoration.replace({}));
            builder.add(s + 2, e - 2, Decoration.mark({ class: "cm-strong" }));
            builder.add(e - 2, e, Decoration.replace({}));
          } else {
            // 光标移入：加粗样式持续保留，两端 ** 显示为柔和浅灰
            builder.add(s, s + 2, Decoration.mark({ class: "cm-md-delimiter" }));
            builder.add(s + 2, e - 2, Decoration.mark({ class: "cm-strong" }));
            builder.add(e - 2, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "italic") {
          if (!isCursorInside) {
            builder.add(s, s + 1, Decoration.replace({}));
            builder.add(s + 1, e - 1, Decoration.mark({ class: "cm-emphasis" }));
            builder.add(e - 1, e, Decoration.replace({}));
          } else {
            // 光标移入：斜体样式持续保留，两端 * 显示为柔和浅灰
            builder.add(s, s + 1, Decoration.mark({ class: "cm-md-delimiter" }));
            builder.add(s + 1, e - 1, Decoration.mark({ class: "cm-emphasis" }));
            builder.add(e - 1, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "strikethrough") {
          if (!isCursorInside) {
            builder.add(s, s + 2, Decoration.replace({}));
            builder.add(s + 2, e - 2, Decoration.mark({ class: "cm-strikethrough" }));
            builder.add(e - 2, e, Decoration.replace({}));
          } else {
            builder.add(s, s + 2, Decoration.mark({ class: "cm-md-delimiter" }));
            builder.add(s + 2, e - 2, Decoration.mark({ class: "cm-strikethrough" }));
            builder.add(e - 2, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "highlight") {
          if (!isCursorInside) {
            builder.add(s, s + 2, Decoration.replace({}));
            builder.add(s + 2, e - 2, Decoration.mark({ class: "cm-highlight" }));
            builder.add(e - 2, e, Decoration.replace({}));
          } else {
            builder.add(s, s + 2, Decoration.mark({ class: "cm-md-delimiter" }));
            builder.add(s + 2, e - 2, Decoration.mark({ class: "cm-highlight" }));
            builder.add(e - 2, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "subscript") {
          if (!isCursorInside) {
            builder.add(s, s + 1, Decoration.replace({}));
            builder.add(s + 1, e - 1, Decoration.mark({ class: "cm-subscript" }));
            builder.add(e - 1, e, Decoration.replace({}));
          } else {
            builder.add(s, s + 1, Decoration.mark({ class: "cm-md-delimiter" }));
            builder.add(s + 1, e - 1, Decoration.mark({ class: "cm-subscript" }));
            builder.add(e - 1, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "superscript") {
          if (!isCursorInside) {
            builder.add(s, s + 1, Decoration.replace({}));
            builder.add(s + 1, e - 1, Decoration.mark({ class: "cm-superscript" }));
            builder.add(e - 1, e, Decoration.replace({}));
          } else {
            builder.add(s, s + 1, Decoration.mark({ class: "cm-md-delimiter" }));
            builder.add(s + 1, e - 1, Decoration.mark({ class: "cm-superscript" }));
            builder.add(e - 1, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "footnote_ref") {
          if (!isCursorInside) {
            builder.add(
              s,
              e,
              Decoration.replace({
                widget: new FootnoteRefWidget(tok.data.label, s),
              })
            );
          } else {
            builder.add(s, s + 2, Decoration.mark({ class: "cm-md-delimiter" }));
            builder.add(s + 2, e - 1, Decoration.mark({ class: "cm-footnote-ref" }));
            builder.add(e - 1, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "code") {
          if (!isCursorInside) {
            builder.add(s, s + 1, Decoration.replace({}));
            builder.add(s + 1, e - 1, Decoration.mark({ class: "cm-inline-code" }));
            builder.add(e - 1, e, Decoration.replace({}));
          } else {
            builder.add(s, s + 1, Decoration.mark({ class: "cm-md-delimiter" }));
            builder.add(s + 1, e - 1, Decoration.mark({ class: "cm-inline-code" }));
            builder.add(e - 1, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "link") {
          const textLen = tok.data.text.length;
          if (!isCursorInside) {
            // 光标离开：仅显示蓝色下划线文字，隐藏 (url)
            builder.add(s, s + 1, Decoration.replace({}));
            builder.add(s + 1, s + 1 + textLen, Decoration.mark({
              class: "cm-link",
              attributes: { "data-href": tok.data.url, title: `Ctrl+点击打开: ${tok.data.url}` },
            }));
            builder.add(s + 1 + textLen, e, Decoration.replace({}));
          } else {
            // 光标移入：文字保持蓝色链接，两端括号及 URL 展现为浅灰色供直接编辑
            builder.add(s, s + 1, Decoration.mark({ class: "cm-md-delimiter" }));
            builder.add(s + 1, s + 1 + textLen, Decoration.mark({
              class: "cm-link",
              attributes: { "data-href": tok.data.url, title: `Ctrl+点击打开: ${tok.data.url}` },
            }));
            builder.add(s + 1 + textLen, s + 1 + textLen + 2, Decoration.mark({ class: "cm-md-delimiter" }));
            builder.add(s + 1 + textLen + 2, e - 1, Decoration.mark({ class: "cm-md-url" }));
            builder.add(e - 1, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "math") {
          if (!isCursorInside) {
            builder.add(
              s,
              e,
              Decoration.replace({
                widget: new MathWidget(tok.content, false, s + 1),
              })
            );
          }
        }
      }
    }

    return builder.finish();
  }

  export const livePreviewPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (imeState.isComposing) {
          // 拼音/中文输入法组合态输入时：对已有装饰器做坐标映射，绝不全篇回退为源码
          this.decorations = this.decorations.map(update.changes);
          return;
        }

        if (
          update.docChanged ||
          update.selectionSet ||
          update.transactions.some((tr) => tr.effects.some((e) => e.is(forceRefreshEffect)))
        ) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
