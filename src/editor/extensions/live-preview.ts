import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { Range } from "@codemirror/state";
import { imeState } from "./ime-guard";
import { tokenizeCodeLine, CodeTokenSpan } from "./code-highlighter";
import { getPreferences } from "../../components/preferences";
import { invoke } from "@tauri-apps/api/core";
import katex from "katex";
import { centerElementInTypewriter } from "./typewriter-mode";
import { forceRefreshEffect } from "./refresh-effect";
import {
  getDocStructureFromState,
  isTableDelimiter,
  stripInlineMarkdown,
  parseBalancedLinksAndImages,
  CalloutType,
  FrontMatterProperty,
} from "./doc-structure";
import {
  parseWikiLinksInLine,
  handleWikiLinkTrigger,
  fetchTransclusionSectionContent,
  handleTagClickTrigger,
} from "./wiki-link";
import { showToast } from "../../components/save-dialog";

export { stripInlineMarkdown };

export let activeDocumentPath: string | null = null;
const imageBase64Cache = new Map<string, string>();
const katexHtmlCache = new Map<string, string>();
const codeTokenCache = new Map<string, CodeTokenSpan[]>();

// 维护正文标题折叠集合 (支持跨章节折叠) & 代码块折叠集合
const foldedHeadingKeys = new Set<string>();
const collapsedCodeBlocks = new Set<string>();
const expandedMaxHeightCodeBlocks = new Set<string>();

function getHeadingFoldKey(lineNum: number, text: string): string {
  return `${lineNum}::${text}`;
}

export function isHeadingFoldedAtLine(view: EditorView, lineNum: number): boolean {
  const struct = getDocStructureFromState(view.state);
  const h = struct.headings.find((item) => item.line === lineNum);
  if (!h) return false;
  return foldedHeadingKeys.has(getHeadingFoldKey(h.line, h.text));
}

export function toggleHeadingFoldAtLine(view: EditorView, lineNum: number): boolean {
  const struct = getDocStructureFromState(view.state);
  const h = struct.headings.find((item) => item.line === lineNum);
  if (!h) return false;
  const key = getHeadingFoldKey(h.line, h.text);
  const nextState = !foldedHeadingKeys.has(key);
  if (nextState) {
    foldedHeadingKeys.add(key);
  } else {
    foldedHeadingKeys.delete(key);
  }
  view.dispatch({
    effects: forceRefreshEffect.of(true),
  });
  return nextState;
}

export function setActiveDocumentPath(path: string | null) {
  activeDocumentPath = path;
}

export function clearImageCache() {
  imageBase64Cache.clear();
  foldedHeadingKeys.clear();
  collapsedCodeBlocks.clear();
}

export function getImageBase64FromCache(key: string): string | undefined {
  return imageBase64Cache.get(key);
}

function renderKatexCached(latex: string, displayMode: boolean): string {
  const key = `${displayMode ? "B" : "I"}::${latex}`;
  const hit = katexHtmlCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const html = katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: "html",
    });
    if (katexHtmlCache.size > 600) {
      const firstKey = katexHtmlCache.keys().next().value;
      if (firstKey) katexHtmlCache.delete(firstKey);
    }
    katexHtmlCache.set(key, html);
    return html;
  } catch {
    return `[Math Error: ${latex}]`;
  }
}

function tokenizeCodeLineCached(lineText: string, lang: string): CodeTokenSpan[] {
  const key = `${lang}::${lineText}`;
  const hit = codeTokenCache.get(key);
  if (hit !== undefined) return hit;
  const spans = tokenizeCodeLine(lineText, lang);
  if (codeTokenCache.size > 1200) {
    const firstKey = codeTokenCache.keys().next().value;
    if (firstKey) codeTokenCache.delete(firstKey);
  }
  codeTokenCache.set(key, spans);
  return spans;
}

const COMMON_CODE_LANGUAGES = [
  "plaintext",
  "rust",
  "typescript",
  "javascript",
  "python",
  "go",
  "c",
  "cpp",
  "csharp",
  "java",
  "kotlin",
  "swift",
  "html",
  "css",
  "json",
  "yaml",
  "toml",
  "sql",
  "bash",
  "shell",
  "powershell",
  "markdown",
  "dockerfile",
  "mermaid",
];

/**
 * 轻量多语言代码自动格式化器（支持 JSON 美化与花括号语言缩进重排）
 */
function formatCodeSnippet(code: string, lang: string): string {
  const cleanLang = (lang || "").trim().toLowerCase();
  if (cleanLang === "json") {
    try {
      return JSON.stringify(JSON.parse(code), null, 2);
    } catch {
      // fallback
    }
  }
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  if (
    [
      "rust",
      "typescript",
      "javascript",
      "js",
      "ts",
      "go",
      "c",
      "cpp",
      "csharp",
      "java",
      "kotlin",
      "swift",
      "css",
    ].includes(cleanLang)
  ) {
    let depth = 0;
    const indentUnit = cleanLang === "rust" || cleanLang === "java" ? "    " : "  ";
    return lines
      .map((raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return "";
        if (/^[}\])]/.test(trimmed)) {
          depth = Math.max(0, depth - 1);
        }
        const formatted = `${indentUnit.repeat(depth)}${trimmed}`;
        const openCount = (trimmed.match(/[{[(]/g) || []).length;
        const closeCount = (trimmed.match(/[}\])]/g) || []).length;
        const net = openCount - closeCount + (/^[}\])]/.test(trimmed) ? 1 : 0);
        depth = Math.max(0, depth + net);
        return formatted;
      })
      .join("\n");
  }
  return lines.map((l) => l.replace(/\s+$/, "")).join("\n");
}

// 0. 顶部 YAML Front Matter 可视化属性面板 Widget (Properties UI)
class FrontMatterCardWidget extends WidgetType {
  constructor(
    readonly props: FrontMatterProperty[],
    readonly endLine: number,
    readonly editPos: number
  ) {
    super();
  }

  get estimatedHeight(): number {
    return Math.max(54, this.props.length * 28 + 36);
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  toDOM(view: EditorView) {
    const card = document.createElement("div");
    card.className = "cm-frontmatter-card";
    card.dataset.from = "0";
    card.addEventListener("pointerdown", (e) => e.stopPropagation());

    const header = document.createElement("div");
    header.className = "cm-frontmatter-header";
    header.innerHTML = `
      <div class="cm-frontmatter-title">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"></path><path d="M7 7h.01"></path></svg>
        <span>文档属性 (YAML Properties)</span>
      </div>
      <div class="cm-frontmatter-actions">
        <button type="button" class="cm-fm-btn" data-act="add-prop" title="新增 YAML 属性字段">+ 属性</button>
        <button type="button" class="cm-fm-btn" data-act="edit-yaml" title="编辑原始 YAML Front Matter">编辑源码</button>
      </div>
    `;
    card.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "cm-frontmatter-grid";

    if (this.props.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cm-frontmatter-empty";
      empty.textContent = "空的 YAML 头部（点击右上角“编辑源码”或“+ 属性”添加元数据）";
      grid.appendChild(empty);
    } else {
      for (const p of this.props) {
        const row = document.createElement("div");
        row.className = "cm-frontmatter-row";

        const keyEl = document.createElement("span");
        keyEl.className = "cm-fm-key";
        keyEl.textContent = p.key;

        const valEl = document.createElement("div");
        valEl.className = "cm-fm-val";

        if (p.key.toLowerCase() === "tags" || p.key.toLowerCase() === "tag") {
          const clean = p.value.replace(/^\[|\]$/g, "");
          const tags = clean
            .split(",")
            .map((s) => s.trim().replace(/^['"#]|['"]$/g, ""))
            .filter(Boolean);
          tags.forEach((t) => {
            const pill = document.createElement("span");
            pill.className = "cm-hashtag cm-fm-tag-pill";
            pill.textContent = `#${t}`;
            pill.addEventListener("click", (e) => {
              e.stopPropagation();
              handleTagClickTrigger(t);
            });
            valEl.appendChild(pill);
          });
        } else {
          valEl.textContent = p.value.replace(/^['"]|['"]$/g, "") || "-";
        }

        row.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).classList.contains("cm-fm-tag-pill")) return;
          e.stopPropagation();
          const line = view.state.doc.line(Math.min(p.line, view.state.doc.lines));
          view.dispatch({ selection: { anchor: line.to } });
          view.focus();
        });

        row.appendChild(keyEl);
        row.appendChild(valEl);
        grid.appendChild(row);
      }
    }

    card.appendChild(grid);

    header.querySelector('[data-act="edit-yaml"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      view.dispatch({ selection: { anchor: this.editPos } });
      view.focus();
    });

    header.querySelector('[data-act="add-prop"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      const closingLine = view.state.doc.line(Math.min(this.endLine, view.state.doc.lines));
      const insertText = `category: 默认分类\n`;
      view.dispatch({
        changes: { from: closingLine.from, to: closingLine.from, insert: insertText },
        selection: { anchor: closingLine.from + 10, head: closingLine.from + insertText.length - 1 },
      });
      view.focus();
    });

    return card;
  }

  eq(other: FrontMatterCardWidget) {
    if (other.endLine !== this.endLine || other.props.length !== this.props.length) {
      return false;
    }
    return this.props.every(
      (p, i) => p.key === other.props[i].key && p.value === other.props[i].value
    );
  }
}

// 0.5 正文标题左侧折叠/展开小三角 Widget
class HeadingFoldWidget extends WidgetType {
  constructor(
    readonly lineNum: number,
    readonly isFolded: boolean,
    readonly foldedLineCount: number
  ) {
    super();
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = `cm-heading-fold-btn ${this.isFolded ? "folded" : "expanded"}`;
    wrap.title = this.isFolded
      ? `点击展开章节 (已折叠 ${this.foldedLineCount} 行)`
      : "点击折叠本章节";
    wrap.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>`;

    if (this.isFolded && this.foldedLineCount > 0) {
      const badge = document.createElement("span");
      badge.className = "cm-heading-folded-badge";
      badge.textContent = `${this.foldedLineCount} 行已折叠`;
      wrap.appendChild(badge);
    }

    wrap.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    wrap.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleHeadingFoldAtLine(view, this.lineNum);
    });
    return wrap;
  }

  eq(other: HeadingFoldWidget) {
    return (
      other.lineNum === this.lineNum &&
      other.isFolded === this.isFolded &&
      other.foldedLineCount === this.foldedLineCount
    );
  }
}

// 1. KaTeX 数学公式 Widget (带全局缓存)
class MathWidget extends WidgetType {
  constructor(
    readonly mathStr: string,
    readonly isBlock: boolean,
    readonly clickPos: number
  ) {
    super();
  }

  get estimatedHeight(): number {
    return this.isBlock ? 56 : 24;
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = this.isBlock ? "md-math-block-preview" : "md-inline-math-preview";
    span.style.cursor = "pointer";
    span.title = "点击编辑 LaTeX 公式";
    span.innerHTML = renderKatexCached(this.mathStr, this.isBlock);
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

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "task-list-item-prefix";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "task-list-item-checkbox";
    input.checked = this.checked;
    input.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });
    input.addEventListener("click", (e) => {
      e.stopPropagation();
      const newChar = input.checked ? "x" : " ";
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 1, insert: newChar },
        userEvent: "input.checkbox",
      });
    });
    wrap.appendChild(input);
    return wrap;
  }

  eq(other: TaskWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }
}

// 2.5 无序列表排版圆点 Widget (• / ◦ / ▪)
class BulletWidget extends WidgetType {
  constructor(readonly level: number, readonly clickPos: number) {
    super();
  }

  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = `md-list-bullet md-list-bullet-l${Math.min(3, this.level)}`;
    span.textContent = this.level === 1 ? "•" : this.level === 2 ? "◦" : "▪";
    span.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      view.dispatch({ selection: { anchor: this.clickPos } });
      view.focus();
    });
    return span;
  }

  eq(other: BulletWidget) {
    return other.level === this.level && other.clickPos === this.clickPos;
  }
}

// 2.6 有序列表等宽排版序号 Widget
class OrderedListMarkerWidget extends WidgetType {
  constructor(
    readonly numText: string,
    readonly level: number,
    readonly clickPos: number
  ) {
    super();
  }

  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = `md-ordered-marker md-ordered-l${Math.min(4, this.level)}`;
    span.textContent = `${this.numText}. `;
    span.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      view.dispatch({ selection: { anchor: this.clickPos } });
      view.focus();
    });
    return span;
  }

  eq(other: OrderedListMarkerWidget) {
    return (
      other.numText === this.numText &&
      other.level === this.level &&
      other.clickPos === this.clickPos
    );
  }
}

// 2.7 GitHub 风格 Callout / Admonition 头部卡片 Widget
const CALLOUT_ICONS: Record<CalloutType, string> = {
  note: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  tip: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>`,
  important: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
  warning: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  caution: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
};

class CalloutHeaderWidget extends WidgetType {
  constructor(
    readonly calloutType: CalloutType,
    readonly title: string,
    readonly clickPos: number
  ) {
    super();
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  toDOM(view: EditorView) {
    const bar = document.createElement("div");
    bar.className = `cm-callout-header-widget cm-callout-header-${this.calloutType}`;
    bar.title = "点击编辑 Callout 标题与类型";

    const iconSpan = document.createElement("span");
    iconSpan.className = "cm-callout-icon";
    iconSpan.innerHTML = CALLOUT_ICONS[this.calloutType] || CALLOUT_ICONS.note;

    const titleSpan = document.createElement("span");
    titleSpan.className = "cm-callout-title";
    titleSpan.textContent = this.title;

    const badgeSpan = document.createElement("span");
    badgeSpan.className = "cm-callout-badge";
    badgeSpan.textContent = this.calloutType.toUpperCase();

    bar.appendChild(iconSpan);
    bar.appendChild(titleSpan);
    bar.appendChild(badgeSpan);

    bar.addEventListener("click", (e) => {
      e.stopPropagation();
      view.dispatch({ selection: { anchor: this.clickPos } });
      view.focus();
    });

    return bar;
  }

  eq(other: CalloutHeaderWidget) {
    return (
      other.calloutType === this.calloutType &&
      other.title === this.title &&
      other.clickPos === this.clickPos
    );
  }
}

// 2.8 双向链接 [[Wiki Link]] 胶囊 Widget (采用精致 SVG 矢量双链图标)
class WikiLinkWidget extends WidgetType {
  constructor(
    readonly targetDoc: string,
    readonly heading: string,
    readonly displayText: string,
    readonly clickPos: number
  ) {
    super();
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = "cm-wiki-link";
    span.dataset.wikiDoc = this.targetDoc;
    span.dataset.wikiHeading = this.heading;
    span.title = `双向链接: ${this.targetDoc || "当前文档"}${
      this.heading ? "#" + this.heading : ""
    } (点击跳转，Alt+点击编辑源码)`;

    const icon = document.createElement("span");
    icon.className = "cm-wiki-link-icon";
    icon.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`;

    const label = document.createElement("span");
    label.className = "cm-wiki-link-label";
    label.textContent = this.displayText;

    span.appendChild(icon);
    span.appendChild(label);

    span.addEventListener("pointerdown", (e) => e.stopPropagation());
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.altKey) {
        view.dispatch({ selection: { anchor: this.clickPos + 2 } });
        view.focus();
        return;
      }
      handleWikiLinkTrigger(view, this.targetDoc, this.heading);
    });

    return span;
  }

  eq(other: WikiLinkWidget) {
    return (
      other.targetDoc === this.targetDoc &&
      other.heading === this.heading &&
      other.displayText === this.displayText &&
      other.clickPos === this.clickPos
    );
  }
}

// 2.9 块级/章节嵌入 ![[文档名#标题]] 原位引用卡片 Widget (Transclusion Card)
class TransclusionWidget extends WidgetType {
  constructor(
    readonly targetDoc: string,
    readonly heading: string,
    readonly displayText: string,
    readonly clickPos: number
  ) {
    super();
  }

  get estimatedHeight(): number {
    return 110;
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  toDOM(view: EditorView) {
    const card = document.createElement("div");
    card.className = "cm-transclusion-card";
    card.dataset.from = String(this.clickPos);
    card.addEventListener("pointerdown", (e) => e.stopPropagation());

    const header = document.createElement("div");
    header.className = "cm-transclusion-header";
    header.innerHTML = `
      <div class="cm-transclusion-title">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M14 9h4"/><path d="M14 15h4"/></svg>
        <span>嵌入引用：${this.displayText}</span>
      </div>
      <div class="cm-transclusion-actions">
        <button type="button" class="cm-trans-btn" data-act="jump" title="跳转到源文档章节">跳转源文 ↗</button>
        <button type="button" class="cm-trans-btn" data-act="edit" title="编辑嵌入语法">源码</button>
      </div>
    `;

    const body = document.createElement("div");
    body.className = "cm-transclusion-body";
    body.textContent = "正在加载嵌入章节...";

    card.appendChild(header);
    card.appendChild(body);

    fetchTransclusionSectionContent(this.targetDoc, this.heading).then((res) => {
      if (!res.found) {
        body.innerHTML = `<span class="cm-transclusion-missing">未找到目标笔记 “${this.targetDoc}”，点击右上角“跳转源文”可一键创建该笔记</span>`;
      } else {
        body.textContent = res.content || "(目标章节内容为空)";
      }
      view.requestMeasure();
    });

    header.querySelector('[data-act="jump"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      handleWikiLinkTrigger(view, this.targetDoc, this.heading);
    });

    header.querySelector('[data-act="edit"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      view.dispatch({ selection: { anchor: this.clickPos + 3 } });
      view.focus();
    });

    return card;
  }

  eq(other: TransclusionWidget) {
    return (
      other.targetDoc === this.targetDoc &&
      other.heading === this.heading &&
      other.displayText === this.displayText &&
      other.clickPos === this.clickPos
    );
  }
}

// 3. 行内图片渲染 Widget
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

  updateDOM(dom: HTMLElement): boolean {
    if (
      dom.dataset.src === this.src &&
      dom.dataset.alt === this.alt &&
      (dom.dataset.width || "") === this.width &&
      (dom.dataset.align || "left") === this.align
    ) {
      dom.dataset.from = String(this.pos);
      dom.dataset.to = String(this.endPos);
      return true;
    }
    return false;
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
    img.title = this.alt || "点击调整图片尺寸与排版对齐";
    if (this.width) {
      img.style.width = this.width;
      img.style.maxWidth = "100%";
    }

    img.onload = () => {
      view.requestMeasure();
    };

    if (
      this.src.startsWith("http://") ||
      this.src.startsWith("https://") ||
      this.src.startsWith("data:")
    ) {
      img.src = this.src;
    } else {
      const cacheKey = `${activeDocumentPath || ""}::${this.src}`;
      const cached = imageBase64Cache.get(cacheKey);
      if (cached) {
        img.src = cached;
      } else {
        invoke<string>("read_image_base64", {
          docPath: activeDocumentPath,
          relPath: this.src,
        })
          .then((base64) => {
            imageBase64Cache.set(cacheKey, base64);
            img.src = base64;
            view.requestMeasure();
          })
          .catch(() => {
            img.src = this.src;
          });
      }
    }

    if (this.alt) {
      const caption = document.createElement("figcaption");
      caption.textContent = this.alt;
      figure.appendChild(caption);
    }

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

// 4. 代码块头部语言选择器、折叠、格式化与复制按钮 Widget (v0.5 全新卡片化设计)
class CodeBlockHeaderWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly codeText: string,
    readonly headerLineFrom: number,
    readonly headerLineTo: number,
    readonly fencePrefix: string,
    readonly startLine: number,
    readonly endLine: number,
    readonly isCollapsed: boolean
  ) {
    super();
  }

  get estimatedHeight(): number {
    return 34;
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  toDOM(view: EditorView) {
    const header = document.createElement("div");
    header.className = `code-block-header-bar ${this.isCollapsed ? "is-collapsed" : ""}`;

    // 关键修复：彻底阻止 pointerdown / mousedown 向 view.contentDOM 冒泡，
    // 根治打字机模式下点击代码块复制按钮、语言按钮、折叠按钮导致视口跳回远端光标处的问题
    header.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });
    header.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });

    const resolveDynamicHeaderLine = () => {
      try {
        const domPos = view.posAtDOM(header);
        return view.state.doc.lineAt(Math.min(domPos, view.state.doc.length));
      } catch {
        return view.state.doc.lineAt(
          Math.min(this.headerLineFrom, view.state.doc.length)
        );
      }
    };

    const leftWrap = document.createElement("div");
    leftWrap.className = "code-header-left";

    // 代码块折叠/展开按钮
    const foldBtn = document.createElement("button");
    foldBtn.type = "button";
    foldBtn.className = `code-fold-btn ${this.isCollapsed ? "collapsed" : "expanded"}`;
    const codeLinesCount = Math.max(0, this.endLine - this.startLine - 1);
    foldBtn.title = this.isCollapsed ? "展开代码块" : "折叠代码块";
    foldBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    foldBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = `${this.startLine}`;
      if (collapsedCodeBlocks.has(key)) {
        collapsedCodeBlocks.delete(key);
      } else {
        collapsedCodeBlocks.add(key);
      }
      view.dispatch({ effects: forceRefreshEffect.of(true) });
    });

    const langWrap = document.createElement("div");
    langWrap.className = "code-lang-selector-wrap";

    const langBtn = document.createElement("button");
    langBtn.type = "button";
    langBtn.className = "code-lang-tag";
    langBtn.title = "点击选择或输入代码语言";
    langBtn.innerHTML = `
      <span class="code-lang-dot"></span>
      <span>${this.lang ? this.lang.toUpperCase() : "PLAINTEXT"}</span>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 12 15 18 9"></polyline></svg>
    `;

    const dropdown = document.createElement("div");
    dropdown.className = "code-lang-dropdown hidden";
    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.className = "code-lang-filter-input";
    filterInput.placeholder = "搜索或输入语言 (Enter)...";
    filterInput.value = this.lang;

    const listEl = document.createElement("div");
    listEl.className = "code-lang-list";

    const applyLanguage = (newLang: string) => {
      const cleaned = newLang.trim().toLowerCase();
      const targetLang = cleaned === "plaintext" ? "" : cleaned;
      const newLineText = `${this.fencePrefix}${targetLang}`;
      const line = resolveDynamicHeaderLine();
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: newLineText },
        userEvent: "input.code.lang",
      });
      dropdown.classList.add("hidden");
    };

    const renderLangOptions = (q: string) => {
      listEl.innerHTML = "";
      const query = q.trim().toLowerCase();
      const matched = COMMON_CODE_LANGUAGES.filter((l) => l.includes(query));
      if (query && !matched.includes(query)) {
        matched.unshift(query);
      }
      matched.forEach((l) => {
        const item = document.createElement("div");
        item.className = `code-lang-option ${
          l === (this.lang || "plaintext").toLowerCase() ? "active" : ""
        }`;
        item.textContent = l;
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          applyLanguage(l);
        });
        listEl.appendChild(item);
      });
    };

    langBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isHidden = dropdown.classList.toggle("hidden");
      if (!isHidden) {
        renderLangOptions("");
        filterInput.value = this.lang;
        setTimeout(() => {
          filterInput.focus();
          filterInput.select();
        }, 10);
      }
    });

    filterInput.addEventListener("input", () => {
      renderLangOptions(filterInput.value);
    });

    filterInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        applyLanguage(filterInput.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        dropdown.classList.add("hidden");
        view.focus();
      }
    });

    filterInput.addEventListener("blur", () => {
      setTimeout(() => dropdown.classList.add("hidden"), 150);
    });

    dropdown.appendChild(filterInput);
    dropdown.appendChild(listEl);
    langWrap.appendChild(langBtn);
    langWrap.appendChild(dropdown);

    leftWrap.appendChild(foldBtn);
    leftWrap.appendChild(langWrap);

    if (this.isCollapsed) {
      const foldedHint = document.createElement("span");
      foldedHint.className = "code-collapsed-badge";
      foldedHint.textContent = `已折叠 ${codeLinesCount} 行代码`;
      foldedHint.addEventListener("click", (e) => {
        e.stopPropagation();
        collapsedCodeBlocks.delete(`${this.startLine}`);
        view.dispatch({ effects: forceRefreshEffect.of(true) });
      });
      leftWrap.appendChild(foldedHint);
    } else {
      const lineCountHint = document.createElement("span");
      lineCountHint.className = "code-line-count-meta";
      lineCountHint.textContent = `${codeLinesCount} lines`;
      leftWrap.appendChild(lineCountHint);
    }

    const actionsWrap = document.createElement("div");
    actionsWrap.className = "code-header-actions";

    // 一键格式化代码按钮
    const formatBtn = document.createElement("button");
    formatBtn.className = "code-copy-btn code-format-btn";
    formatBtn.type = "button";
    formatBtn.title = "一键规范代码缩进与格式";
    formatBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="7" y2="10"></line><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="14" x2="3" y2="14"></line><line x1="21" y1="18" x2="7" y2="18"></line></svg><span>格式化</span>`;
    formatBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const formatted = formatCodeSnippet(this.codeText, this.lang);
      if (formatted !== this.codeText && this.endLine > this.startLine + 1) {
        const bodyStart = view.state.doc.line(this.startLine + 1).from;
        const bodyEnd = view.state.doc.line(this.endLine - 1).to;
        view.dispatch({
          changes: { from: bodyStart, to: bodyEnd, insert: formatted },
          userEvent: "input.code.format",
        });
        showToast("代码缩进已自动格式化", "success");
      }
    });

    // 复制按钮
    const copyBtn = document.createElement("button");
    copyBtn.className = "code-copy-btn";
    copyBtn.type = "button";
    copyBtn.title = "复制代码内容";
    const copySvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>复制</span>`;
    const checkSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"></polyline></svg><span>已复制</span>`;
    copyBtn.innerHTML = copySvg;
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(this.codeText).then(() => {
        copyBtn.innerHTML = checkSvg;
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.innerHTML = copySvg;
          copyBtn.classList.remove("copied");
        }, 1600);
      });
    });

    actionsWrap.appendChild(formatBtn);
    actionsWrap.appendChild(copyBtn);

    // 点击顶栏空白处时，将光标温和定位于代码块第一行代码（而非展开 ``` 围栏），彻底避免误改围栏
    header.addEventListener("click", (e) => {
      if (e.target === header || e.target === leftWrap) {
        const firstCodeLine = Math.min(this.startLine + 1, this.endLine);
        const targetLine = view.state.doc.line(firstCodeLine);
        view.dispatch({ selection: { anchor: targetLine.from } });
        view.focus();
      }
    });

    header.appendChild(leftWrap);
    header.appendChild(actionsWrap);
    return header;
  }

  eq(other: CodeBlockHeaderWidget) {
    return (
      other.lang === this.lang &&
      other.codeText === this.codeText &&
      other.fencePrefix === this.fencePrefix &&
      other.startLine === this.startLine &&
      other.endLine === this.endLine &&
      other.isCollapsed === this.isCollapsed
    );
  }
}

// 5. 水平分割线 Widget (--- / *** / ___)
class HorizontalRuleWidget extends WidgetType {
  constructor(readonly lineFrom: number) {
    super();
  }

  get estimatedHeight(): number {
    return 36;
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

// 5.5 动态 [TOC] 目录树 Widget
class TocWidget extends WidgetType {
  constructor(readonly linePos: number, readonly headingsSignature: string) {
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
    card.addEventListener("pointerdown", (e) => e.stopPropagation());
    const title = document.createElement("div");
    title.className = "cm-toc-title";
    title.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg><span>目录 (Table of Contents)</span>`;
    card.appendChild(title);

    const structure = getDocStructureFromState(view.state);
    const list = document.createElement("ul");
    list.className = "cm-toc-list";

    if (structure.headings.length === 0) {
      const empty = document.createElement("div");
      empty.style.color = "var(--control-text-color, #888)";
      empty.style.fontSize = "12px";
      empty.textContent = "文档暂无标题";
      card.appendChild(empty);
    } else {
      const minLvl = Math.min(...structure.headings.map((h) => h.level));
      for (const h of structure.headings) {
        const li = document.createElement("li");
        li.className = `cm-toc-item cm-toc-level-${h.level}`;
        li.style.paddingLeft = `${Math.max(0, h.level - minLvl) * 16}px`;
        li.textContent = h.text;
        const targetPos = h.from;
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
    return other.linePos === this.linePos && other.headingsSignature === this.headingsSignature;
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
    | "wiki_link"
    | "transclusion"
    | "hashtag"
    | "bold"
    | "italic"
    | "bold_italic"
    | "strikethrough"
    | "highlight"
    | "subscript"
    | "superscript"
    | "footnote_ref"
    | "link"
    | "task"
    | "bullet"
    | "ordered_marker";
  start: number;
  end: number;
  content: string;
  isOpaque?: boolean;
  data?: any;
}

let inlineMathTooltipEl: HTMLElement | null = null;
function updateInlineMathTooltip(
  view: EditorView,
  activeMath: { latex: string; from: number; to: number } | null
) {
  if (typeof document === "undefined") return;
  if (!activeMath || !getPreferences().inlineMathTooltip) {
    if (inlineMathTooltipEl) inlineMathTooltipEl.classList.add("hidden");
    return;
  }

  if (!inlineMathTooltipEl) {
    inlineMathTooltipEl = document.createElement("div");
    inlineMathTooltipEl.className = "ty-inline-math-tooltip hidden";
    document.body.appendChild(inlineMathTooltipEl);
  }

  try {
    inlineMathTooltipEl.innerHTML = renderKatexCached(
      activeMath.latex.trim() || "\\text{...}",
      false
    );
    inlineMathTooltipEl.classList.remove("hidden");
    requestAnimationFrame(() => {
      if (!inlineMathTooltipEl || inlineMathTooltipEl.classList.contains("hidden")) return;
      const coords = view.coordsAtPos(activeMath.from);
      if (!coords) {
        inlineMathTooltipEl.classList.add("hidden");
        return;
      }
      const w = inlineMathTooltipEl.offsetWidth || 120;
      const h = inlineMathTooltipEl.offsetHeight || 32;
      let top = coords.top - h - 8;
      if (top < 36) top = coords.bottom + 8;
      const left = Math.max(12, Math.min(coords.left, window.innerWidth - w - 12));
      inlineMathTooltipEl.style.top = `${top}px`;
      inlineMathTooltipEl.style.left = `${left}px`;
    });
  } catch {
    inlineMathTooltipEl.classList.add("hidden");
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  if (typeof document !== "undefined" && document.body.classList.contains("source-mode")) {
    updateInlineMathTooltip(view, null);
    return Decoration.none;
  }

  const ranges: Range<Decoration>[] = [];
  const addDeco = (from: number, to: number, deco: Decoration) => {
    if (from <= to) {
      ranges.push(deco.range(from, to));
    }
  };

  const selection = view.state.selection.main;
  const cursorHead = selection.head;
  const doc = view.state.doc;
  const cursorLine = doc.lineAt(cursorHead).number;
  const isMultiLineSelection =
    !selection.empty && doc.lineAt(selection.from).number !== doc.lineAt(selection.to).number;

  // O(1) 读取缓存结构
  const {
    frontMatterEndLine,
    frontMatterProps,
    codeRanges,
    mermaidBlocks,
    mathBlocks,
    callouts,
    headings,
    headingsSignature,
  } = getDocStructureFromState(view.state);

  // 计算当前被折叠章节覆盖的行号集合
  const foldedLinesSet = new Set<number>();
  for (const h of headings) {
    const key = getHeadingFoldKey(h.line, h.text);
    if (foldedHeadingKeys.has(key)) {
      for (let ln = h.line + 1; ln <= h.endLine; ln++) {
        foldedLinesSet.add(ln);
      }
    }
  }

  const prefs = getPreferences();
  let activeInlineMath: { latex: string; from: number; to: number } | null = null;

  const visibleLineIntervals: Array<{ startLine: number; endLine: number }> = [];
  if (view.visibleRanges && view.visibleRanges.length > 0) {
    for (const vr of view.visibleRanges) {
      const sLine = Math.max(1, doc.lineAt(vr.from).number - 40);
      const eLine = Math.min(doc.lines, doc.lineAt(vr.to).number + 40);
      if (
        visibleLineIntervals.length > 0 &&
        sLine <= visibleLineIntervals[visibleLineIntervals.length - 1].endLine + 1
      ) {
        visibleLineIntervals[visibleLineIntervals.length - 1].endLine = Math.max(
          visibleLineIntervals[visibleLineIntervals.length - 1].endLine,
          eLine
        );
      } else {
        visibleLineIntervals.push({ startLine: sLine, endLine: eLine });
      }
    }
  } else {
    visibleLineIntervals.push({ startLine: 1, endLine: doc.lines });
  }

  for (const interval of visibleLineIntervals) {
    for (let lineNum = interval.startLine; lineNum <= interval.endLine; lineNum++) {
      const line = doc.line(lineNum);
      const text = line.text;
      const trimmed = text.trim();

      // 若该行处于已折叠的标题章节内部，直接附加折叠隐藏类并跳过
      if (foldedLinesSet.has(lineNum)) {
        addDeco(line.from, line.from, Decoration.line({ class: "cm-folded-section-line" }));
        continue;
      }

      // 2.0 顶部 YAML Front Matter 可视化属性面板 (Properties UI)
      if (frontMatterEndLine > 0 && lineNum <= frontMatterEndLine) {
        const isCursorInsideFM = cursorLine >= 1 && cursorLine <= frontMatterEndLine;
        if (!isCursorInsideFM && !isMultiLineSelection) {
          if (lineNum === 1) {
            const editLine = doc.line(Math.min(2, frontMatterEndLine));
            addDeco(
              line.from,
              line.to,
              Decoration.replace({
                widget: new FrontMatterCardWidget(
                  frontMatterProps,
                  frontMatterEndLine,
                  editLine.to
                ),
              })
            );
          } else {
            addDeco(line.from, line.from, Decoration.line({ class: "cm-folded-section-line" }));
          }
          continue;
        }
        const cls =
          lineNum === 1
            ? "cm-code-block-first-line cm-frontmatter-line"
            : lineNum === frontMatterEndLine
            ? "cm-code-block-last-line cm-frontmatter-line"
            : "cm-code-block-line cm-frontmatter-line";
        addDeco(line.from, line.from, Decoration.line({ class: cls }));
        continue;
      }

      // 2.1 普通代码块（彻底重构：所见即所得模式下恒定展示优雅顶栏，底部围栏行隐藏为 6px 卡片圆角底边，消除上下 ``` 割裂误触）
      const codeRange = codeRanges.find((r) => lineNum >= r.startLine && lineNum <= r.endLine);
      if (codeRange) {
        const isCodeCollapsed = collapsedCodeBlocks.has(`${codeRange.startLine}`);
        if (lineNum === codeRange.startLine) {
          addDeco(
            line.from,
            line.from,
            Decoration.line({
              class: `cm-code-block-first-line ${isCodeCollapsed ? "cm-code-block-collapsed-header" : ""}`,
            })
          );
          if (!isMultiLineSelection) {
            addDeco(
              line.from,
              line.to,
              Decoration.replace({
                widget: new CodeBlockHeaderWidget(
                  codeRange.lang,
                  codeRange.codeText,
                  line.from,
                  line.to,
                  codeRange.fencePrefix,
                  codeRange.startLine,
                  codeRange.endLine,
                  isCodeCollapsed
                ),
              })
            );
          }
        } else if (!codeRange.unclosed && lineNum === codeRange.endLine) {
          addDeco(
            line.from,
            line.from,
            Decoration.line({
              class: isCodeCollapsed
                ? "cm-folded-section-line"
                : "cm-code-block-last-line cm-code-block-cap",
            })
          );
          if (!isMultiLineSelection) {
            addDeco(line.from, line.to, Decoration.replace({}));
          }
        } else {
          if (isCodeCollapsed) {
            addDeco(line.from, line.from, Decoration.line({ class: "cm-folded-section-line" }));
            continue;
          }
          const codeLineIdx = lineNum - codeRange.startLine;
          addDeco(
            line.from,
            line.from,
            Decoration.line({
              class: "cm-code-block-line",
              attributes: { "data-code-line": String(codeLineIdx) },
            })
          );
          const synTokens = tokenizeCodeLineCached(text, codeRange.lang);
          for (const st of synTokens) {
            addDeco(line.from + st.from, line.from + st.to, Decoration.mark({ class: st.cls }));
          }
        }
        continue;
      }

      // 2.15 Mermaid 流程图块
      const mermaidBlock = mermaidBlocks.find((b) => lineNum >= b.startLine && lineNum <= b.endLine);
      if (mermaidBlock) {
        const isEditingThisMermaid =
          cursorLine >= mermaidBlock.startLine && cursorLine <= mermaidBlock.endLine;
        if (isEditingThisMermaid) {
          if (lineNum === mermaidBlock.startLine) {
            addDeco(line.from, line.from, Decoration.line({ class: "cm-code-block-first-line" }));
          } else if (lineNum === mermaidBlock.endLine) {
            addDeco(
              line.from,
              line.from,
              Decoration.line({ class: "cm-code-block-last-line cm-live-preview-attached" })
            );
          } else {
            addDeco(line.from, line.from, Decoration.line({ class: "cm-code-block-line" }));
          }
        }
        continue;
      }

      // 2.16 多行独立数学公式块
      const mathBlock = mathBlocks.find((b) => lineNum >= b.startLine && lineNum <= b.endLine);
      if (mathBlock) {
        const isEditingThisMath =
          cursorLine >= mathBlock.startLine && cursorLine <= mathBlock.endLine;
        if (isEditingThisMath) {
          if (lineNum === mathBlock.startLine) {
            addDeco(line.from, line.from, Decoration.line({ class: "cm-code-block-first-line" }));
          } else if (lineNum === mathBlock.endLine) {
            addDeco(
              line.from,
              line.from,
              Decoration.line({ class: "cm-code-block-last-line cm-live-preview-attached" })
            );
          } else {
            addDeco(line.from, line.from, Decoration.line({ class: "cm-code-block-line" }));
          }
        }
        continue;
      }

      // 2.2 表格行交由专职 StateField 处理
      if ((trimmed.startsWith("|") || isTableDelimiter(trimmed)) && !/^\s*>/.test(text)) {
        continue;
      }

      // 2.3 水平分割线 (--- 或 *** 或 ___)
      const hrMatch = trimmed.match(/^(\-{3,}|\*{3,}|_{3,})$/);
      if (hrMatch) {
        const isCursorOnHr = cursorLine === lineNum && !isMultiLineSelection;
        if (!isCursorOnHr) {
          addDeco(
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
        const isCursorOnToc = cursorLine === lineNum && !isMultiLineSelection;
        if (!isCursorOnToc) {
          addDeco(
            line.from,
            line.to,
            Decoration.replace({
              widget: new TocWidget(line.from, headingsSignature),
            })
          );
          continue;
        }
      }

      // 2.4 独立单行公式块 ($$ formula $$)
      const blockMathMatch = trimmed.match(/^\$\$\s*(.+?)\s*\$\$$/);
      if (blockMathMatch) {
        const isCursorInMath =
          !isMultiLineSelection && cursorHead >= line.from && cursorHead <= line.to;
        if (!isCursorInMath) {
          addDeco(
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
        addDeco(line.from, line.from, Decoration.line({ class: "cm-footnote-def" }));
      }

      // 2.48 GitHub 风格 Callout / Admonition 块渲染
      const activeCallout = callouts.find((c) => lineNum >= c.startLine && lineNum <= c.endLine);
      if (activeCallout) {
        const isFirstCalloutLine = lineNum === activeCallout.startLine;
        const isLastCalloutLine = lineNum === activeCallout.endLine;
        const calloutClasses = [
          "cm-blockquote",
          "cm-callout-line",
          `cm-callout-${activeCallout.calloutType}`,
          isFirstCalloutLine ? "cm-blockquote-first cm-callout-first" : "",
          isLastCalloutLine ? "cm-blockquote-last cm-callout-last" : "",
        ]
          .filter(Boolean)
          .join(" ");

        addDeco(line.from, line.from, Decoration.line({ class: calloutClasses }));

        if (isFirstCalloutLine) {
          const isCursorOnCalloutHeader = cursorLine === lineNum && !isMultiLineSelection;
          if (!isCursorOnCalloutHeader) {
            addDeco(
              line.from,
              line.to,
              Decoration.replace({
                widget: new CalloutHeaderWidget(
                  activeCallout.calloutType,
                  activeCallout.title,
                  line.to
                ),
              })
            );
            continue;
          }
        }
      }

      // 2.5 引用块 (> Quote)
      const quoteMatch = text.match(/^(\s*(?:> ?)+)/);
      if (quoteMatch) {
        const quotePrefixLen = quoteMatch[0].length;
        const quoteLevel = (quoteMatch[0].match(/>/g) || []).length;
        if (!activeCallout) {
          const isPrevQuote =
            lineNum > 1 && /^\s*>/.test(doc.line(lineNum - 1).text);
          const isNextQuote =
            lineNum < doc.lines && /^\s*>/.test(doc.line(lineNum + 1).text);
          const posClasses = [
            `cm-blockquote`,
            `cm-blockquote-level-${Math.min(3, quoteLevel)}`,
            !isPrevQuote ? "cm-blockquote-first" : "",
            !isNextQuote ? "cm-blockquote-last" : "",
          ]
            .filter(Boolean)
            .join(" ");

          addDeco(
            line.from,
            line.from,
            Decoration.line({
              class: posClasses,
            })
          );
        }

        const isCursorAtQuotePrefix =
          !isMultiLineSelection &&
          cursorHead >= line.from &&
          cursorHead < line.from + quotePrefixLen;

        if (!isCursorAtQuotePrefix) {
          if (quotePrefixLen > 0) {
            addDeco(line.from, line.from + quotePrefixLen, Decoration.replace({}));
          }
        } else {
          addDeco(
            line.from,
            line.from + quotePrefixLen,
            Decoration.mark({ class: "cm-md-delimiter" })
          );
        }
        prefixEnd = quotePrefixLen;
      }

      const restText = text.slice(prefixEnd);

      // 2.6 标题识别 (# Title) + 章节折叠指示器
      const headerMatch = restText.match(/^(#{1,6})\s+/);
      if (headerMatch) {
        const depth = headerMatch[1].length;
        const hStart = prefixEnd;
        const hEnd = prefixEnd + headerMatch[0].length;
        // 仅当光标真正进入 `#` 定界符内部（< line.from + hEnd）时才展开 #，确保 Ctrl+2 后直接打标题处于完美预览态
        const isCursorAtPrefix =
          !isMultiLineSelection &&
          cursorHead >= line.from + hStart &&
          cursorHead < line.from + hEnd;

        const headingMeta = headings.find((h) => h.line === lineNum);
        const foldKey = headingMeta ? getHeadingFoldKey(headingMeta.line, headingMeta.text) : "";
        const isFolded = foldKey ? foldedHeadingKeys.has(foldKey) : false;
        const foldedCount = headingMeta ? Math.max(0, headingMeta.endLine - headingMeta.line) : 0;

        addDeco(
          line.from,
          line.from,
          Decoration.line({
            class: `cm-heading cm-heading-${depth}${isFolded ? " cm-heading-is-folded" : ""}`,
          })
        );
        if (!isCursorAtPrefix) {
          addDeco(line.from + hStart, line.from + hEnd, Decoration.replace({}));
        } else {
          addDeco(
            line.from + hStart,
            line.from + hEnd,
            Decoration.mark({ class: "cm-md-delimiter" })
          );
        }
        if (headingMeta && foldedCount > 0) {
          addDeco(
            line.to,
            line.to,
            Decoration.widget({
              widget: new HeadingFoldWidget(lineNum, isFolded, foldedCount),
              side: 1,
            })
          );
        }
        prefixEnd = hEnd;
      }

      const tokens: InlineToken[] = [];

      // 2.68 列表项识别
      const afterQuoteAndHeader = text.slice(prefixEnd);
      const taskMatch = afterQuoteAndHeader.match(/^(\s*)([-*+]\s+\[)([ xX])(\]\s*)/);
      const listMatch = afterQuoteAndHeader.match(/^(\s*)([-*+]|\d+\.)(\s+)/);

      if (taskMatch) {
        const indentSpaces = taskMatch[1].length;
        const level = Math.min(4, Math.floor(indentSpaces / 2) + 1);
        addDeco(
          line.from,
          line.from,
          Decoration.line({ class: `cm-list-item cm-task-list-item cm-list-level-${level}` })
        );
        if (indentSpaces > 0) {
          const indentFrom = line.from + prefixEnd;
          const indentTo = indentFrom + indentSpaces;
          const isCursorInIndent =
            !isMultiLineSelection && cursorHead >= indentFrom && cursorHead < indentTo;
          if (!isCursorInIndent) {
            addDeco(indentFrom, indentTo, Decoration.replace({}));
          }
        }
        const checkRelOffset = prefixEnd + indentSpaces + taskMatch[2].length;
        const isChecked = taskMatch[3].toLowerCase() === "x";
        tokens.push({
          type: "task",
          start: prefixEnd + indentSpaces,
          end: prefixEnd + taskMatch[0].length,
          content: taskMatch[0].slice(indentSpaces),
          isOpaque: true,
          data: { isChecked, checkPos: checkRelOffset },
        });
        prefixEnd += taskMatch[0].length;
      } else if (listMatch) {
        const indentSpaces = listMatch[1].length;
        const marker = listMatch[2];
        const level = Math.min(4, Math.floor(indentSpaces / 2) + 1);
        addDeco(
          line.from,
          line.from,
          Decoration.line({ class: `cm-list-item cm-list-level-${level}` })
        );
        if (indentSpaces > 0) {
          const indentFrom = line.from + prefixEnd;
          const indentTo = indentFrom + indentSpaces;
          const isCursorInIndent =
            !isMultiLineSelection && cursorHead >= indentFrom && cursorHead < indentTo;
          if (!isCursorInIndent) {
            addDeco(indentFrom, indentTo, Decoration.replace({}));
          }
        }
        if (/^[-*+]$/.test(marker)) {
          const markerStart = prefixEnd + indentSpaces;
          const markerEnd = markerStart + marker.length;
          tokens.push({
            type: "bullet",
            start: markerStart,
            end: markerEnd,
            content: marker,
            isOpaque: true,
            data: { level },
          });
        } else if (/^\d+\.$/.test(marker)) {
          const markerStart = prefixEnd + indentSpaces;
          const markerEnd = prefixEnd + listMatch[0].length;
          const numText = marker.slice(0, -1);
          tokens.push({
            type: "ordered_marker",
            start: markerStart,
            end: markerEnd,
            content: listMatch[0].slice(indentSpaces),
            isOpaque: true,
            data: { numText, level },
          });
        }
        prefixEnd += listMatch[0].length;
      }

      // 2.7 第一梯队：收集不可嵌套的原子 Token
      let m: RegExpExecArray | null;

      const codeRegex = /`([^`\n]+)`/g;
      while ((m = codeRegex.exec(text)) !== null) {
        if (m.index < prefixEnd) continue;
        tokens.push({
          type: "code",
          start: m.index,
          end: m.index + m[0].length,
          content: m[1],
          isOpaque: true,
        });
      }

      const mathRegex = /(?<![\\$\d])\$([^\s$\\](?:[^$\n]*?[^\s$\\])?)\$(?!\d)/g;
      while ((m = mathRegex.exec(text)) !== null) {
        if (m.index < prefixEnd) continue;
        tokens.push({
          type: "math",
          start: m.index,
          end: m.index + m[0].length,
          content: m[1],
          isOpaque: true,
        });
      }

      // 双向知识库链接 [[Wiki Links]] 与块级嵌入 ![[Transclusion]]
      const wikiLinks = parseWikiLinksInLine(text, prefixEnd);
      for (const wl of wikiLinks) {
        tokens.push({
          type: wl.isEmbed ? "transclusion" : "wiki_link",
          start: wl.start,
          end: wl.end,
          content: wl.raw,
          isOpaque: true,
          data: wl,
        });
      }

      // 平衡括号图片与超链接提取
      const balancedMatches = parseBalancedLinksAndImages(text, prefixEnd);
      for (const bm of balancedMatches) {
        if (bm.isImage) {
          tokens.push({
            type: "image",
            start: bm.start,
            end: bm.end,
            content: bm.raw,
            isOpaque: true,
            data: { alt: bm.label, src: bm.url, width: "", align: "left" },
          });
        }
      }

      const htmlImgRegex = /<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)\/?>/gi;
      while ((m = htmlImgRegex.exec(text)) !== null) {
        if (m.index < prefixEnd) continue;
        const fullAttrs = `${m[1]} ${m[3]}`;
        const altMatch = fullAttrs.match(/alt=["']([^"']*)["']/i);
        const widthMatch = fullAttrs.match(/width=["']([^"']*)["']/i);
        const alignMatch = fullAttrs.match(/align=["']([^"']*)["']/i);
        tokens.push({
          type: "image",
          start: m.index,
          end: m.index + m[0].length,
          content: m[0],
          isOpaque: true,
          data: {
            src: m[2],
            alt: altMatch ? altMatch[1] : "",
            width: widthMatch ? widthMatch[1] : "",
            align: alignMatch ? alignMatch[1] : "left",
          },
        });
      }

      const fnRefRegex = /\[\^([^\]\n]+)\](?!\:)/g;
      while ((m = fnRefRegex.exec(text)) !== null) {
        if (m.index < prefixEnd) continue;
        tokens.push({
          type: "footnote_ref",
          start: m.index,
          end: m.index + m[0].length,
          content: m[0],
          isOpaque: true,
          data: { label: m[1] },
        });
      }

      // 行内 #标签 (#tag / #parent/child)
      const tagRegex = /(?:^|(?<=\s))#([a-zA-Z0-9_\-\u4e00-\u9fa5]+(?:\/[a-zA-Z0-9_\-\u4e00-\u9fa5]+)*)(?=\s|$|[，。！？、；：,.!?;:])/g;
      while ((m = tagRegex.exec(text)) !== null) {
        if (m.index < prefixEnd) continue;
        const tagBody = m[1];
        if (/^\d+$/.test(tagBody)) continue;
        tokens.push({
          type: "hashtag",
          start: m.index,
          end: m.index + m[0].length,
          content: m[0],
          isOpaque: true,
          data: { tag: tagBody },
        });
      }

      tokens.sort((a, b) => a.start - b.start);
      const opaqueSpans: Array<{ start: number; end: number }> = [];
      const acceptedTokens: InlineToken[] = [];
      let opaqueLimit = 0;
      for (const tok of tokens) {
        if (tok.start >= opaqueLimit) {
          acceptedTokens.push(tok);
          opaqueSpans.push({ start: tok.start, end: tok.end });
          opaqueLimit = tok.end;
        }
      }

      const OverlapsOpaque = (s: number, e: number): boolean =>
        opaqueSpans.some((sp) => s < sp.end && e > sp.start);

      const delimiterIntervals: Array<{ start: number; end: number }> = opaqueSpans.map((sp) => ({
        start: sp.start,
        end: sp.end,
      }));
      const canPlaceDelimiters = (
        d1Start: number,
        d1End: number,
        d2Start: number,
        d2End: number
      ) => {
        const collides = delimiterIntervals.some(
          (iv) =>
            (d1Start < iv.end && d1End > iv.start) || (d2Start < iv.end && d2End > iv.start)
        );
        if (collides) return false;
        delimiterIntervals.push({ start: d1Start, end: d1End }, { start: d2Start, end: d2End });
        return true;
      };

      // 2.8 第二梯队：收集平衡括号超链接与可组合富文本格式 Token
      for (const bm of balancedMatches) {
        if (bm.isImage) continue;
        const s = bm.start;
        const e = bm.end;
        if (OverlapsOpaque(s, e)) continue;
        const textLen = bm.label.length;
        if (canPlaceDelimiters(s, s + 1, s + 1 + textLen, e)) {
          acceptedTokens.push({
            type: "link",
            start: s,
            end: e,
            content: bm.raw,
            data: { text: bm.label, url: bm.url },
          });
        }
      }

      const boldItalicRegex = /(\*{3}|_{3})([^*_\n]+?)\1/g;
      while ((m = boldItalicRegex.exec(text)) !== null) {
        if (m.index < prefixEnd) continue;
        const s = m.index;
        const e = m.index + m[0].length;
        if (canPlaceDelimiters(s, s + 3, e - 3, e)) {
          acceptedTokens.push({
            type: "bold_italic",
            start: s,
            end: e,
            content: m[2],
          });
        }
      }

      const boldRegex =
        /(?<!\*)(\*{2})(?!\*)([^\n]+?)(?<!\*)\1(?!\*)|(?<!_)(_{2})(?!_)([^\n]+?)(?<!_)\3(?!_)/g;
      while ((m = boldRegex.exec(text)) !== null) {
        if (m.index < prefixEnd) continue;
        const s = m.index;
        const e = m.index + m[0].length;
        if (canPlaceDelimiters(s, s + 2, e - 2, e)) {
          acceptedTokens.push({
            type: "bold",
            start: s,
            end: e,
            content: m[2] || m[4],
          });
        }
      }

      const italicRegex =
        /(?<!\*)\*([^*\s\n][^*\n]*?)\*(?!\*)|(?<!_)_([^_\s\n][^_\n]*?)_(?!_)/g;
      while ((m = italicRegex.exec(text)) !== null) {
        if (m.index < prefixEnd) continue;
        const s = m.index;
        const e = m.index + m[0].length;
        if (canPlaceDelimiters(s, s + 1, e - 1, e)) {
          acceptedTokens.push({
            type: "italic",
            start: s,
            end: e,
            content: m[1] || m[2],
          });
        }
      }

      const strikeRegex = /~~([^~\n]+)~~/g;
      while ((m = strikeRegex.exec(text)) !== null) {
        if (m.index < prefixEnd) continue;
        const s = m.index;
        const e = m.index + m[0].length;
        if (canPlaceDelimiters(s, s + 2, e - 2, e)) {
          acceptedTokens.push({
            type: "strikethrough",
            start: s,
            end: e,
            content: m[1],
          });
        }
      }

      const highlightRegex = /==([^=\n]+)==/g;
      while ((m = highlightRegex.exec(text)) !== null) {
        if (m.index < prefixEnd) continue;
        const s = m.index;
        const e = m.index + m[0].length;
        if (canPlaceDelimiters(s, s + 2, e - 2, e)) {
          acceptedTokens.push({
            type: "highlight",
            start: s,
            end: e,
            content: m[1],
          });
        }
      }

      const subRegex = /(?<!~)~([^~\s\n][^~\n]*?)~(?!~)/g;
      while ((m = subRegex.exec(text)) !== null) {
        if (m.index < prefixEnd) continue;
        const s = m.index;
        const e = m.index + m[0].length;
        if (canPlaceDelimiters(s, s + 1, e - 1, e)) {
          acceptedTokens.push({
            type: "subscript",
            start: s,
            end: e,
            content: m[1],
          });
        }
      }

      const supRegex = /\^([^\^\s\n][^\^\n]*?)\^/g;
      while ((m = supRegex.exec(text)) !== null) {
        if (m.index < prefixEnd) continue;
        const s = m.index;
        const e = m.index + m[0].length;
        if (canPlaceDelimiters(s, s + 1, e - 1, e)) {
          acceptedTokens.push({
            type: "superscript",
            start: s,
            end: e,
            content: m[1],
          });
        }
      }

      // 核心：Token 级高雅微观局部展开
      for (const tok of acceptedTokens) {
        const s = line.from + tok.start;
        const e = line.from + tok.end;

        const isCursorInside = !isMultiLineSelection && cursorHead >= s && cursorHead <= e;

        if (tok.type === "task") {
          if (!isCursorInside) {
            addDeco(
              s,
              e,
              Decoration.replace({
                widget: new TaskWidget(
                  tok.data.isChecked,
                  line.from + tok.data.checkPos
                ),
              })
            );
          }
        } else if (tok.type === "bullet") {
          if (!isCursorInside) {
            addDeco(
              s,
              e,
              Decoration.replace({
                widget: new BulletWidget(tok.data.level, s),
              })
            );
          } else {
            addDeco(s, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "ordered_marker") {
          if (!isCursorInside) {
            addDeco(
              s,
              e,
              Decoration.replace({
                widget: new OrderedListMarkerWidget(tok.data.numText, tok.data.level, s),
              })
            );
          } else {
            addDeco(s, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "wiki_link") {
          if (!isCursorInside) {
            addDeco(
              s,
              e,
              Decoration.replace({
                widget: new WikiLinkWidget(
                  tok.data.targetDoc,
                  tok.data.heading,
                  tok.data.displayText,
                  s
                ),
              })
            );
          } else {
            addDeco(s, s + 2, Decoration.mark({ class: "cm-md-delimiter" }));
            addDeco(s + 2, e - 2, Decoration.mark({ class: "cm-wiki-link-src" }));
            addDeco(e - 2, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "transclusion") {
          if (!isCursorInside) {
            addDeco(
              s,
              e,
              Decoration.replace({
                widget: new TransclusionWidget(
                  tok.data.targetDoc,
                  tok.data.heading,
                  tok.data.displayText,
                  s
                ),
              })
            );
          } else {
            addDeco(s, s + 3, Decoration.mark({ class: "cm-md-delimiter" }));
            addDeco(s + 3, e - 2, Decoration.mark({ class: "cm-wiki-link-src" }));
            addDeco(e - 2, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "hashtag") {
          addDeco(
            s,
            e,
            Decoration.mark({
              class: "cm-hashtag",
              attributes: {
                "data-tag": tok.data.tag,
                title: `标签 #${tok.data.tag} (点击在侧边栏检索全部关联笔记)`,
              },
            })
          );
        } else if (tok.type === "image") {
          if (!isCursorInside) {
            addDeco(
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
            addDeco(s, s + 3, Decoration.replace({}));
            addDeco(s + 3, e - 3, Decoration.mark({ class: "cm-strong cm-emphasis" }));
            addDeco(e - 3, e, Decoration.replace({}));
          } else {
            addDeco(s, s + 3, Decoration.mark({ class: "cm-md-delimiter" }));
            addDeco(s + 3, e - 3, Decoration.mark({ class: "cm-strong cm-emphasis" }));
            addDeco(e - 3, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "bold") {
          if (!isCursorInside) {
            addDeco(s, s + 2, Decoration.replace({}));
            addDeco(s + 2, e - 2, Decoration.mark({ class: "cm-strong" }));
            addDeco(e - 2, e, Decoration.replace({}));
          } else {
            addDeco(s, s + 2, Decoration.mark({ class: "cm-md-delimiter" }));
            addDeco(s + 2, e - 2, Decoration.mark({ class: "cm-strong" }));
            addDeco(e - 2, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "italic") {
          if (!isCursorInside) {
            addDeco(s, s + 1, Decoration.replace({}));
            addDeco(s + 1, e - 1, Decoration.mark({ class: "cm-emphasis" }));
            addDeco(e - 1, e, Decoration.replace({}));
          } else {
            addDeco(s, s + 1, Decoration.mark({ class: "cm-md-delimiter" }));
            addDeco(s + 1, e - 1, Decoration.mark({ class: "cm-emphasis" }));
            addDeco(e - 1, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "strikethrough") {
          if (!isCursorInside) {
            addDeco(s, s + 2, Decoration.replace({}));
            addDeco(s + 2, e - 2, Decoration.mark({ class: "cm-strikethrough" }));
            addDeco(e - 2, e, Decoration.replace({}));
          } else {
            addDeco(s, s + 2, Decoration.mark({ class: "cm-md-delimiter" }));
            addDeco(s + 2, e - 2, Decoration.mark({ class: "cm-strikethrough" }));
            addDeco(e - 2, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "highlight") {
          if (!isCursorInside) {
            addDeco(s, s + 2, Decoration.replace({}));
            addDeco(s + 2, e - 2, Decoration.mark({ class: "cm-highlight" }));
            addDeco(e - 2, e, Decoration.replace({}));
          } else {
            addDeco(s, s + 2, Decoration.mark({ class: "cm-md-delimiter" }));
            addDeco(s + 2, e - 2, Decoration.mark({ class: "cm-highlight" }));
            addDeco(e - 2, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "subscript") {
          if (!isCursorInside) {
            addDeco(s, s + 1, Decoration.replace({}));
            addDeco(s + 1, e - 1, Decoration.mark({ class: "cm-subscript" }));
            addDeco(e - 1, e, Decoration.replace({}));
          } else {
            addDeco(s, s + 1, Decoration.mark({ class: "cm-md-delimiter" }));
            addDeco(s + 1, e - 1, Decoration.mark({ class: "cm-subscript" }));
            addDeco(e - 1, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "superscript") {
          if (!isCursorInside) {
            addDeco(s, s + 1, Decoration.replace({}));
            addDeco(s + 1, e - 1, Decoration.mark({ class: "cm-superscript" }));
            addDeco(e - 1, e, Decoration.replace({}));
          } else {
            addDeco(s, s + 1, Decoration.mark({ class: "cm-md-delimiter" }));
            addDeco(s + 1, e - 1, Decoration.mark({ class: "cm-superscript" }));
            addDeco(e - 1, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "footnote_ref") {
          if (!isCursorInside) {
            addDeco(
              s,
              e,
              Decoration.replace({
                widget: new FootnoteRefWidget(tok.data.label, s),
              })
            );
          } else {
            addDeco(s, s + 2, Decoration.mark({ class: "cm-md-delimiter" }));
            addDeco(s + 2, e - 1, Decoration.mark({ class: "cm-footnote-ref" }));
            addDeco(e - 1, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "code") {
          if (!isCursorInside) {
            addDeco(s, s + 1, Decoration.replace({}));
            addDeco(s + 1, e - 1, Decoration.mark({ class: "cm-inline-code" }));
            addDeco(e - 1, e, Decoration.replace({}));
          } else {
            addDeco(s, s + 1, Decoration.mark({ class: "cm-md-delimiter" }));
            addDeco(s + 1, e - 1, Decoration.mark({ class: "cm-inline-code" }));
            addDeco(e - 1, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "link") {
          const textLen = tok.data.text.length;
          const linkAttrs = {
            "data-href": tok.data.url,
            "data-text": tok.data.text,
            "data-from": String(s),
            "data-to": String(e),
            title: `点击查看/编辑链接，Ctrl+点击打开: ${tok.data.url}`,
          };
          const isCursorInUrlPart =
            isCursorInside &&
            (!prefs.compactLinkExpansion ||
              cursorHead <= s + 1 ||
              cursorHead >= s + 1 + textLen);

          if (!isCursorInUrlPart) {
            addDeco(s, s + 1, Decoration.replace({}));
            addDeco(
              s + 1,
              s + 1 + textLen,
              Decoration.mark({
                class: isCursorInside ? "cm-link cm-link-active" : "cm-link",
                attributes: linkAttrs,
              })
            );
            addDeco(s + 1 + textLen, e, Decoration.replace({}));
          } else {
            addDeco(s, s + 1, Decoration.mark({ class: "cm-md-delimiter" }));
            addDeco(
              s + 1,
              s + 1 + textLen,
              Decoration.mark({
                class: "cm-link cm-link-active",
                attributes: linkAttrs,
              })
            );
            addDeco(
              s + 1 + textLen,
              s + 1 + textLen + 2,
              Decoration.mark({ class: "cm-md-delimiter" })
            );
            addDeco(s + 1 + textLen + 2, e - 1, Decoration.mark({ class: "cm-md-url" }));
            addDeco(e - 1, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        } else if (tok.type === "math") {
          if (!isCursorInside) {
            addDeco(
              s,
              e,
              Decoration.replace({
                widget: new MathWidget(tok.content, false, s + 1),
              })
            );
          } else {
            activeInlineMath = { latex: tok.content, from: s, to: e };
            addDeco(s, s + 1, Decoration.mark({ class: "cm-md-delimiter" }));
            addDeco(s + 1, e - 1, Decoration.mark({ class: "cm-inline-code cm-inline-math-src" }));
            addDeco(e - 1, e, Decoration.mark({ class: "cm-md-delimiter" }));
          }
        }
      }
    }
  }

  updateInlineMathTooltip(view, activeInlineMath);
  return Decoration.set(ranges, true);
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (imeState.isViewComposing(update.view)) {
        this.decorations = this.decorations.map(update.changes);
        return;
      }

      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
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
