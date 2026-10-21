import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { EditorState, Range } from "@codemirror/state";
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
  HeadingEntry,
  CodeFenceRange,
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

// 维护正文标题折叠集合 & 代码块折叠/自动换行/超长展开集合（采用与行号解耦的稳定签名 Key，防止在上方打字回车导致下方折叠块自动弹开）
const foldedHeadingKeys = new Set<string>();
const collapsedCodeBlocks = new Set<string>();
const wrappedCodeBlocks = new Set<string>();
const expandedMaxHeightCodeBlocks = new Set<string>();

// 跟踪鼠标左键按住拖拽选区状态：拖拽途中冻结块级 Widget 展开切换，彻底根除框选文字时屏幕乱闪
const mouseSelectingViews = new WeakSet<EditorView>();

export function isViewMouseSelecting(view: EditorView): boolean {
  return mouseSelectingViews.has(view);
}

/**
 * 为文档内所有标题构建不受前文增删行影响的稳定折叠 Key (`level::text::occurrence`)
 */
export function buildStableHeadingFoldKeys(headings: HeadingEntry[]): string[] {
  const counts = new Map<string, number>();
  return headings.map((h) => {
    const base = `${h.level}::${h.text}`;
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    return `${base}::${n}`;
  });
}

/**
 * 为文档内所有围栏代码块构建不受前文增删行影响的稳定 Key
 */
function buildStableCodeBlockKeys(codeRanges: CodeFenceRange[]): string[] {
  const counts = new Map<string, number>();
  return codeRanges.map((cr) => {
    const headSnippet = cr.codeText.slice(0, 48).trim();
    const base = `${cr.lang}::${headSnippet}`;
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    return `${base}::${n}`;
  });
}

function getHeadingFoldKeyAtLine(state: EditorState, lineNum: number): string | null {
  const struct = getDocStructureFromState(state);
  const idx = struct.headings.findIndex((item) => item.line === lineNum);
  if (idx === -1) return null;
  const keys = buildStableHeadingFoldKeys(struct.headings);
  return keys[idx] || null;
}

export function isHeadingFoldedAtLine(view: EditorView, lineNum: number): boolean {
  const key = getHeadingFoldKeyAtLine(view.state, lineNum);
  if (!key) return false;
  return foldedHeadingKeys.has(key);
}

export function toggleHeadingFoldAtLine(view: EditorView, lineNum: number): boolean {
  const key = getHeadingFoldKeyAtLine(view.state, lineNum);
  if (!key) return false;
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

export function setHeadingFoldAtLine(
  view: EditorView,
  lineNum: number,
  folded: boolean
): void {
  const key = getHeadingFoldKeyAtLine(view.state, lineNum);
  if (!key) return;
  if (folded) {
    foldedHeadingKeys.add(key);
  } else {
    foldedHeadingKeys.delete(key);
  }
  view.dispatch({
    effects: forceRefreshEffect.of(true),
  });
}

/**
 * 查询某行是否处于已折叠的章节内部（供方向键边界漫游跳过折叠区使用，防止光标掉入 display:none 黑洞）
 */
export function getFoldedSectionSpanAtLine(
  state: EditorState,
  lineNum: number
): { startLine: number; endLine: number } | null {
  const struct = getDocStructureFromState(state);
  const keys = buildStableHeadingFoldKeys(struct.headings);
  for (let i = 0; i < struct.headings.length; i++) {
    const h = struct.headings[i];
    if (foldedHeadingKeys.has(keys[i])) {
      if (lineNum >= h.line && lineNum <= h.endLine) {
        return { startLine: h.line, endLine: h.endLine };
      }
    }
  }
  return null;
}

export function setActiveDocumentPath(path: string | null) {
  activeDocumentPath = path;
}

export interface TabFoldSnapshot {
  foldedHeadings: string[];
  collapsedCodes: string[];
  wrappedCodes: string[];
  expandedMaxCodes: string[];
}

export function snapshotFoldState(): TabFoldSnapshot {
  return {
    foldedHeadings: Array.from(foldedHeadingKeys),
    collapsedCodes: Array.from(collapsedCodeBlocks),
    wrappedCodes: Array.from(wrappedCodeBlocks),
    expandedMaxCodes: Array.from(expandedMaxHeightCodeBlocks),
  };
}

export function restoreFoldState(snapshot?: TabFoldSnapshot | null) {
  foldedHeadingKeys.clear();
  collapsedCodeBlocks.clear();
  wrappedCodeBlocks.clear();
  expandedMaxHeightCodeBlocks.clear();
  if (!snapshot) return;
  snapshot.foldedHeadings.forEach((k) => foldedHeadingKeys.add(k));
  snapshot.collapsedCodes.forEach((k) => collapsedCodeBlocks.add(k));
  snapshot.wrappedCodes.forEach((k) => wrappedCodeBlocks.add(k));
  snapshot.expandedMaxCodes.forEach((k) => expandedMaxHeightCodeBlocks.add(k));
}

export function getCodeBlockVisibleBounds(
  state: EditorState,
  codeRangeIdx: number
): { isCollapsed: boolean; isMaxExpanded: boolean; lastVisibleCodeLine: number } {
  const struct = getDocStructureFromState(state);
  const cr = struct.codeRanges[codeRangeIdx];
  if (!cr) {
    return { isCollapsed: false, isMaxExpanded: true, lastVisibleCodeLine: 1 };
  }
  const keys = buildStableCodeBlockKeys(struct.codeRanges);
  const key = keys[codeRangeIdx] || `${cr.startLine}`;
  const isCollapsed = collapsedCodeBlocks.has(key);
  const isMaxExpanded = expandedMaxHeightCodeBlocks.has(key);
  const codeLinesCount = Math.max(0, cr.endLine - cr.startLine - 1);
  const isLong = codeLinesCount > 28;
  const lastVisibleCodeLine =
    !isLong || isMaxExpanded
      ? Math.max(cr.startLine + 1, cr.endLine - 1)
      : Math.min(cr.startLine + 28, Math.max(cr.startLine + 1, cr.endLine - 1));
  return { isCollapsed, isMaxExpanded, lastVisibleCodeLine };
}

export function clearImageCache(clearFolds: boolean = false) {
  imageBase64Cache.clear();
  if (clearFolds) {
    foldedHeadingKeys.clear();
    collapsedCodeBlocks.clear();
    wrappedCodeBlocks.clear();
    expandedMaxHeightCodeBlocks.clear();
  }
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
  if (codeTokenCache.size > 1500) {
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
 * 计算剥离字符串与行注释后的净括号增量（防止字符串内的 `{` 或 `}` 干扰缩进计算）
 */
function countNetStructuralDelimiters(
  trimmedLine: string,
  ignoreHashComment: boolean
): {
  leadingClose: boolean;
  netDelta: number;
} {
  let clean = "";
  let inQuote: string | null = null;
  for (let i = 0; i < trimmedLine.length; i++) {
    const ch = trimmedLine[i];
    const next = trimmedLine[i + 1] || "";
    if (inQuote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === "/" && next === "/") break;
    if (ignoreHashComment && ch === "#") break;
    if (ch === '"' || ch === "'" || ch === "`") {
      inQuote = ch;
      continue;
    }
    clean += ch;
  }

  const cleanTrimmed = clean.trim();
  const leadingClose = /^[}\])]/.test(cleanTrimmed);
  const openCount = (cleanTrimmed.match(/[{[(]/g) || []).length;
  const closeCount = (cleanTrimmed.match(/[}\])]/g) || []).length;
  return {
    leadingClose,
    netDelta: openCount - closeCount,
  };
}

/**
 * 智能多语言代码自动格式化器（v0.6 全面升级）：
 * - 支持 JSON（含单行压缩 JSON 自动展开）、Rust/TS/JS/Go/C/C++/C#/Java/Kotlin/Swift/CSS（支持单行紧凑花括号智能拆行与字符串安全缩进）
 * - 支持 HTML/XML/SVG/Vue 标签层级缩进、SQL 关键字大写与子句换行、Python/YAML/Shell/TOML 公共缩进剥离（Dedent）与 Tab 转空格规范化
 * - 支持未指定语言（plaintext）时根据内容特征自动探测 JSON / HTML / SQL / 花括号代码
 */
export function formatCodeSnippet(code: string, lang: string): string {
  const normalized = code.replace(/\r\n/g, "\n").replace(/\t/g, "  ");
  if (!normalized.trim()) return normalized.trim();

  let cleanLang = (lang || "").trim().toLowerCase();
  const trimmedAll = normalized.trim();

  // 未指定语言时智能探测代码结构
  if (!cleanLang || cleanLang === "plaintext" || cleanLang === "text" || cleanLang === "txt") {
    if (
      (trimmedAll.startsWith("{") && trimmedAll.endsWith("}")) ||
      (trimmedAll.startsWith("[") && trimmedAll.endsWith("]"))
    ) {
      try {
        JSON.parse(trimmedAll);
        cleanLang = "json";
      } catch {
        if (trimmedAll.includes("{") && trimmedAll.includes("}")) {
          cleanLang = "javascript";
        }
      }
    } else if (/^<[a-zA-Z!/?]/.test(trimmedAll) && trimmedAll.includes(">")) {
      cleanLang = "html";
    } else if (/^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE)\b/i.test(trimmedAll)) {
      cleanLang = "sql";
    } else if (trimmedAll.includes("{") && trimmedAll.includes("}")) {
      cleanLang = "javascript";
    }
  }

  // 1. JSON / JSONC 格式化
  if (cleanLang === "json" || cleanLang === "jsonc") {
    try {
      return JSON.stringify(JSON.parse(trimmedAll), null, 2);
    } catch {
      // 若含注释或尾随逗号，降级走花括号缩进
    }
  }

  // 2. HTML / XML / SVG / Vue 标签缩进美化
  if (["html", "xml", "svg", "vue", "xhtml"].includes(cleanLang)) {
    const rawExpanded = normalized
      .replace(/>\s*</g, ">\n<")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    let depth = 0;
    const voidTags = new Set([
      "area", "base", "br", "col", "embed", "hr", "img", "input",
      "link", "meta", "param", "source", "track", "wbr",
    ]);
    return rawExpanded
      .map((line) => {
        const isClosing = /^<\//.test(line);
        const isCommentOrDoctype = /^<![-a-zA-Z]/.test(line);
        const tagMatch = line.match(/^<([a-zA-Z0-9\-_]+)/);
        const tagName = tagMatch ? tagMatch[1].toLowerCase() : "";
        const isSelfClosing =
          /\/>$/.test(line) ||
          voidTags.has(tagName) ||
          (tagName !== "" && line.includes(`</${tagName}>`));

        if (isClosing) {
          depth = Math.max(0, depth - 1);
        }
        const out = `${"  ".repeat(depth)}${line}`;
        if (!isClosing && !isCommentOrDoctype && !isSelfClosing && tagName) {
          depth++;
        }
        return out;
      })
      .join("\n");
  }

  // 3. SQL 关键字规范化与子句拆行对齐
  if (["sql", "mysql", "postgres", "postgresql", "sqlite"].includes(cleanLang)) {
    const sqlKeywords = [
      "SELECT", "FROM", "WHERE", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "OUTER JOIN",
      "JOIN", "ON", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "INSERT INTO",
      "VALUES", "UPDATE", "SET", "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE",
      "AND", "OR", "AS", "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX",
    ];
    let working = normalized
      .split("\n")
      .map((l) => l.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    for (const kw of sqlKeywords) {
      const re = new RegExp(`\\b${kw.replace(/\s+/g, "\\s+")}\\b`, "gi");
      working = working.replace(re, kw);
    }
    working = working.replace(
      /\s+(FROM|WHERE|LEFT JOIN|RIGHT JOIN|INNER JOIN|JOIN|GROUP BY|ORDER BY|HAVING|LIMIT|VALUES|SET)\b/g,
      "\n$1"
    );
    working = working.replace(/\s+(AND|OR)\b/g, "\n  $1");
    return working;
  }

  // 4. 花括号系语言（支持单行压缩代码如 `fn main() { println!("hi"); }` 自动拆行与多行精准重缩进）
  if (
    [
      "rust", "rs", "typescript", "ts", "tsx", "javascript", "js", "jsx",
      "go", "c", "cpp", "c++", "h", "hpp", "csharp", "cs", "java",
      "kotlin", "kt", "swift", "css", "scss", "less", "json", "jsonc",
    ].includes(cleanLang)
  ) {
    let rawLines = normalized.split("\n");
    // 若整段代码被挤在单行且包含花括号语句，自动在 `{`、`;`、`}` 处安全拆行（跳过字符串内部）
    if (rawLines.length <= 2 && trimmedAll.includes("{") && trimmedAll.includes("}")) {
      let expanded = "";
      let inStr: string | null = null;
      let parenDepth = 0;
      for (let i = 0; i < trimmedAll.length; i++) {
        const ch = trimmedAll[i];
        if (inStr) {
          expanded += ch;
          if (ch === "\\" && i + 1 < trimmedAll.length) {
            expanded += trimmedAll[++i];
            continue;
          }
          if (ch === inStr) inStr = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          inStr = ch;
          expanded += ch;
          continue;
        }
        if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);

        if (ch === "{" && parenDepth === 0) {
          expanded = expanded.trimEnd() + " {\n";
        } else if (ch === "}" && parenDepth === 0) {
          expanded = expanded.trimEnd() + "\n}\n";
        } else if (ch === ";" && parenDepth === 0) {
          expanded += ";\n";
        } else {
          expanded += ch;
        }
      }
      rawLines = expanded.split("\n");
    }

    let depth = 0;
    const indentUnit = ["rust", "rs", "java", "c", "cpp", "csharp", "cs", "go"].includes(
      cleanLang
    )
      ? "    "
      : "  ";

    const formattedLines: string[] = [];
    let prevBlank = false;

    for (const raw of rawLines) {
      const trimmed = raw.trim();
      if (!trimmed) {
        if (!prevBlank && formattedLines.length > 0) {
          formattedLines.push("");
          prevBlank = true;
        }
        continue;
      }
      prevBlank = false;

      const { leadingClose, netDelta } = countNetStructuralDelimiters(trimmed, false);
      if (leadingClose) {
        depth = Math.max(0, depth - 1);
      }
      formattedLines.push(`${indentUnit.repeat(depth)}${trimmed}`);
      const adjustAfter = netDelta + (leadingClose ? 1 : 0);
      depth = Math.max(0, depth + adjustAfter);
    }

    return formattedLines.join("\n").trim();
  }

  // 5. Python / YAML / Shell / TOML / 通用文本：剥离公共多余前导缩进 (Dedent) 并合并连续空行
  const lines = normalized.split("\n");
  let minIndent = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const lead = (l.match(/^ */)?.[0] || "").length;
    if (lead < minIndent) minIndent = lead;
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;

  const outLines: string[] = [];
  let lastEmpty = false;
  for (const l of lines) {
    const trimmedRight = l.replace(/\s+$/, "");
    if (!trimmedRight.trim()) {
      if (!lastEmpty && outLines.length > 0) {
        outLines.push("");
        lastEmpty = true;
      }
      continue;
    }
    lastEmpty = false;
    outLines.push(trimmedRight.slice(minIndent));
  }
  return outLines.join("\n").trim();
}

// 0. 顶部 YAML Front Matter 可视化属性面板 Widget (Properties UI v0.6 — 支持原位编辑属性值与完整 CSS 对齐)
class FrontMatterCardWidget extends WidgetType {
  constructor(
    readonly props: FrontMatterProperty[],
    readonly endLine: number,
    readonly editPos: number
  ) {
    super();
  }

  get estimatedHeight(): number {
    return Math.max(54, this.props.length * 30 + 38);
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  toDOM(view: EditorView) {
    const card = document.createElement("div");
    card.className = "cm-frontmatter-card";
    card.dataset.from = "0";
    card.addEventListener("pointerdown", (e) => e.stopPropagation());
    card.addEventListener("mousedown", (e) => e.stopPropagation());

    const header = document.createElement("div");
    header.className = "cm-frontmatter-header fm-card-header";
    header.innerHTML = `
      <div class="cm-frontmatter-title fm-card-badge">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"></path><path d="M7 7h.01"></path></svg>
        <span>文档属性 (YAML Properties)</span>
      </div>
      <div class="cm-frontmatter-actions">
        <button type="button" class="cm-fm-btn" data-act="add-prop" title="新增 YAML 属性字段">+ 属性</button>
        <button type="button" class="cm-fm-btn" data-act="edit-yaml" title="切换至原始 YAML 源码编辑">编辑源码</button>
      </div>
    `;
    card.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "cm-frontmatter-grid fm-card-grid";

    if (this.props.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cm-frontmatter-empty";
      empty.textContent = "空的 YAML 头部（点击右上角“+ 属性”或“编辑源码”添加元数据）";
      grid.appendChild(empty);
    } else {
      for (const p of this.props) {
        const row = document.createElement("div");
        row.className = "cm-frontmatter-row fm-prop-row";

        const keyEl = document.createElement("span");
        keyEl.className = "cm-fm-key fm-prop-key";
        keyEl.textContent = p.key;
        keyEl.title = "点击编辑属性名或切入源码";

        const valEl = document.createElement("div");
        valEl.className = "cm-fm-val fm-prop-val";

        if (p.key.toLowerCase() === "tags" || p.key.toLowerCase() === "tag") {
          const clean = p.value.replace(/^\[|\]$/g, "");
          const tags = clean
            .split(",")
            .map((s) => s.trim().replace(/^['"#]|['"]$/g, ""))
            .filter(Boolean);
          tags.forEach((t) => {
            const pill = document.createElement("span");
            pill.className = "cm-hashtag cm-fm-tag-pill fm-tag-pill";
            pill.textContent = `#${t}`;
            pill.title = `点击在侧边栏检索标签 #${t}`;
            pill.addEventListener("click", (e) => {
              e.stopPropagation();
              handleTagClickTrigger(t);
            });
            valEl.appendChild(pill);
          });
        } else {
          valEl.textContent = p.value.replace(/^['"]|['"]$/g, "") || "-";
        }

        // 点击属性值支持原位内联编辑，Enter 直接写回对应 YAML 行
        const startInlinePropEdit = (e: MouseEvent) => {
          if ((e.target as HTMLElement).classList.contains("cm-fm-tag-pill")) return;
          if (row.querySelector("input")) return;
          e.stopPropagation();

          const input = document.createElement("input");
          input.type = "text";
          input.className = "ty-inline-input cm-fm-inline-input";
          input.value = p.value;
          valEl.innerHTML = "";
          valEl.appendChild(input);
          input.focus();
          input.select();

          let committed = false;
          const commitVal = (save: boolean) => {
            if (committed) return;
            committed = true;
            if (save && input.value.trim() !== p.value) {
              const targetLine = view.state.doc.line(Math.min(p.line, view.state.doc.lines));
              const newLineStr = `${p.key}: ${input.value.trim()}`;
              view.dispatch({
                changes: { from: targetLine.from, to: targetLine.to, insert: newLineStr },
                userEvent: "input.yaml.prop",
              });
              return;
            }
            view.dispatch({ effects: forceRefreshEffect.of(true) });
          };

          input.addEventListener("keydown", (ke) => {
            ke.stopPropagation();
            if (ke.key === "Enter") {
              ke.preventDefault();
              commitVal(true);
            } else if (ke.key === "Escape") {
              ke.preventDefault();
              commitVal(false);
            }
          });
          input.addEventListener("blur", () => commitVal(true));
        };

        valEl.addEventListener("click", startInlinePropEdit);
        keyEl.addEventListener("click", (e) => {
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
        selection: {
          anchor: closingLine.from + 10,
          head: closingLine.from + insertText.length - 1,
        },
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

// 0.5 正文标题右侧折叠/展开小三角 Widget
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
    wrap.className = `cm-heading-fold-btn ${this.isFolded ? "folded is-folded" : "expanded"}`;
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
    span.textContent = this.level === 1 ? "• " : this.level === 2 ? "◦ " : "▪ ";
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
    span.className = `md-ordered-marker md-list-ordered md-ordered-l${Math.min(4, this.level)}`;
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

// 2.9 块级/章节嵌入 ![[文档名#标题]] 原位引用卡片 Widget (Transclusion Card — 对齐 base.css 样式类名)
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
    card.addEventListener("mousedown", (e) => e.stopPropagation());

    const header = document.createElement("div");
    header.className = "cm-transclusion-header transclusion-header";
    header.innerHTML = `
      <div class="cm-transclusion-title transclusion-title-wrap">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M14 9h4"/><path d="M14 15h4"/></svg>
        <span>嵌入引用：${this.displayText}</span>
      </div>
      <div class="cm-transclusion-actions transclusion-actions">
        <button type="button" class="cm-trans-btn transclusion-jump-btn" data-act="jump" title="跳转到源文档章节">跳转源文 ↗</button>
        <button type="button" class="cm-trans-btn transclusion-src-btn" data-act="edit" title="编辑嵌入语法">源码</button>
      </div>
    `;

    const body = document.createElement("div");
    body.className = "cm-transclusion-body transclusion-body";
    const previewPre = document.createElement("pre");
    previewPre.className = "transclusion-md-preview";
    previewPre.textContent = "正在加载嵌入章节...";
    body.appendChild(previewPre);

    card.appendChild(header);
    card.appendChild(body);

    fetchTransclusionSectionContent(
      this.targetDoc,
      this.heading,
      view.state.doc.toString()
    ).then((res) => {
      if (!res.found) {
        body.innerHTML = `<span class="cm-transclusion-missing">未找到目标笔记 “${this.targetDoc}”，点击右上角“跳转源文”可一键创建该笔记</span>`;
      } else {
        previewPre.textContent = res.content || "(目标章节内容为空)";
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

// 4. 代码块头部语言选择器、折叠、自动换行、格式化、编辑围栏与复制按钮 Widget (v0.6 全面升级)
class CodeBlockHeaderWidget extends WidgetType {
  constructor(
    readonly stableKey: string,
    readonly lang: string,
    readonly codeText: string,
    readonly headerLineFrom: number,
    readonly fencePrefix: string,
    readonly codeLinesCount: number,
    readonly isCollapsed: boolean,
    readonly isWrapped: boolean
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

    header.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });
    header.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });

    const resolveDynamicCodeRange = (): {
      headerLine: { from: number; to: number; number: number };
      range: CodeFenceRange | null;
    } => {
      let headerLine = view.state.doc.lineAt(
        Math.min(this.headerLineFrom, view.state.doc.length)
      );
      try {
        const domPos = view.posAtDOM(header);
        headerLine = view.state.doc.lineAt(Math.min(domPos, view.state.doc.length));
      } catch {
        // fallback to headerLineFrom
      }
      const struct = getDocStructureFromState(view.state);
      const matched =
        struct.codeRanges.find((r) => r.startLine === headerLine.number) ||
        struct.codeRanges.find(
          (r) => headerLine.number >= r.startLine && headerLine.number <= r.endLine
        ) ||
        null;
      return { headerLine, range: matched };
    };

    const leftWrap = document.createElement("div");
    leftWrap.className = "code-header-left";

    // 代码块折叠/展开按钮
    const foldBtn = document.createElement("button");
    foldBtn.type = "button";
    foldBtn.className = `code-fold-btn ${this.isCollapsed ? "collapsed" : "expanded"}`;
    foldBtn.title = this.isCollapsed ? "展开代码块" : "折叠代码块";
    foldBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    foldBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (collapsedCodeBlocks.has(this.stableKey)) {
        collapsedCodeBlocks.delete(this.stableKey);
      } else {
        collapsedCodeBlocks.add(this.stableKey);
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
      const { headerLine, range } = resolveDynamicCodeRange();
      const prefix = range ? range.fencePrefix : this.fencePrefix;
      const newLineText = `${prefix}${targetLang}`;
      view.dispatch({
        changes: { from: headerLine.from, to: headerLine.to, insert: newLineText },
        userEvent: "input.code.lang",
      });
      dropdown.classList.add("hidden");
      showToast(`代码块语言已设为 ${targetLang || "plaintext"}`, "info");
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
      foldedHint.textContent = `已折叠 ${this.codeLinesCount} 行代码`;
      foldedHint.addEventListener("click", (e) => {
        e.stopPropagation();
        collapsedCodeBlocks.delete(this.stableKey);
        view.dispatch({ effects: forceRefreshEffect.of(true) });
      });
      leftWrap.appendChild(foldedHint);
    } else {
      const lineCountHint = document.createElement("span");
      lineCountHint.className = "code-line-count-meta";
      lineCountHint.textContent = `${this.codeLinesCount} 行`;
      leftWrap.appendChild(lineCountHint);
    }

    const actionsWrap = document.createElement("div");
    actionsWrap.className = "code-header-actions";

    // 自动换行切换按钮
    const wrapBtn = document.createElement("button");
    wrapBtn.className = `code-copy-btn code-wrap-btn ${this.isWrapped ? "active" : ""}`;
    wrapBtn.type = "button";
    wrapBtn.title = this.isWrapped ? "切换为横向滚动（关闭自动换行）" : "切换代码自动折行";
    wrapBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><polyline points="16 16 14 18 16 20"/><path d="M3 18h7"/></svg><span>换行</span>`;
    wrapBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (wrappedCodeBlocks.has(this.stableKey)) {
        wrappedCodeBlocks.delete(this.stableKey);
      } else {
        wrappedCodeBlocks.add(this.stableKey);
      }
      view.dispatch({ effects: forceRefreshEffect.of(true) });
    });

    // 一键格式化代码按钮（支持实时动态定位代码块区间与明确 Toast 反馈）
    const formatBtn = document.createElement("button");
    formatBtn.className = "code-copy-btn code-format-btn";
    formatBtn.type = "button";
    formatBtn.title = "一键规范代码缩进、JSON/SQL/HTML 美化与去除多余空行";
    formatBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="7" y2="10"></line><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="14" x2="3" y2="14"></line><line x1="21" y1="18" x2="7" y2="18"></line></svg><span>格式化</span>`;
    formatBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const { range } = resolveDynamicCodeRange();
      const currentCode = range ? range.codeText : this.codeText;
      const currentLang = range ? range.lang : this.lang;
      if (!currentCode.trim()) {
        showToast("代码块内容为空，请先输入代码", "info");
        return;
      }
      const formatted = formatCodeSnippet(currentCode, currentLang);
      if (range && range.endLine > range.startLine + 1 && formatted !== currentCode) {
        const bodyStart = view.state.doc.line(range.startLine + 1).from;
        const bodyEnd = view.state.doc.line(range.endLine - 1).to;
        view.dispatch({
          changes: { from: bodyStart, to: bodyEnd, insert: formatted },
          userEvent: "input.code.format",
        });
        showToast("代码格式与缩进已自动规范化", "success");
      } else {
        showToast("当前代码缩进与格式已规范", "info");
      }
    });

    // 编辑围栏源码按钮 (` ```lang `)
    const fenceBtn = document.createElement("button");
    fenceBtn.className = "code-copy-btn code-fence-btn";
    fenceBtn.type = "button";
    fenceBtn.title = "编辑代码块围栏与语言标记 (```)";
    fenceBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg><span>围栏</span>`;
    fenceBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const { headerLine } = resolveDynamicCodeRange();
      view.dispatch({ selection: { anchor: headerLine.to } });
      view.focus();
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
      const { range } = resolveDynamicCodeRange();
      const textToCopy = range ? range.codeText : this.codeText;
      navigator.clipboard.writeText(textToCopy).then(() => {
        copyBtn.innerHTML = checkSvg;
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.innerHTML = copySvg;
          copyBtn.classList.remove("copied");
        }, 1600);
      });
    });

    actionsWrap.appendChild(wrapBtn);
    actionsWrap.appendChild(formatBtn);
    actionsWrap.appendChild(fenceBtn);
    actionsWrap.appendChild(copyBtn);

    // 点击顶栏空白处时，将光标温和定位于代码块第一行代码
    header.addEventListener("click", (e) => {
      if (e.target === header || e.target === leftWrap) {
        const { headerLine, range } = resolveDynamicCodeRange();
        const firstCodeLine = range
          ? Math.min(range.startLine + 1, range.endLine)
          : Math.min(headerLine.number + 1, view.state.doc.lines);
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
      other.stableKey === this.stableKey &&
      other.lang === this.lang &&
      other.codeText === this.codeText &&
      other.fencePrefix === this.fencePrefix &&
      other.codeLinesCount === this.codeLinesCount &&
      other.isCollapsed === this.isCollapsed &&
      other.isWrapped === this.isWrapped
    );
  }
}

// 4.5 超长代码块底栏“展开全部 N 行 / 收起长代码”折叠横幅 Widget
class CodeBlockExpandFooterWidget extends WidgetType {
  constructor(
    readonly stableKey: string,
    readonly hiddenLinesCount: number,
    readonly isExpanded: boolean
  ) {
    super();
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  toDOM(view: EditorView) {
    const bar = document.createElement("div");
    bar.className = "cm-code-expand-footer code-block-expand-footer";
    bar.innerHTML = this.isExpanded
      ? `<span class="code-expand-more-btn">收起超长代码 ▴</span>`
      : `<span class="code-expand-more-btn">展开剩余 ${this.hiddenLinesCount} 行代码 ▾</span>`;
    bar.addEventListener("pointerdown", (e) => e.stopPropagation());
    bar.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (expandedMaxHeightCodeBlocks.has(this.stableKey)) {
        expandedMaxHeightCodeBlocks.delete(this.stableKey);
      } else {
        expandedMaxHeightCodeBlocks.add(this.stableKey);
      }
      view.dispatch({ effects: forceRefreshEffect.of(true) });
    });
    return bar;
  }

  eq(other: CodeBlockExpandFooterWidget) {
    return (
      other.stableKey === this.stableKey &&
      other.hiddenLinesCount === this.hiddenLinesCount &&
      other.isExpanded === this.isExpanded
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

// 行级内联 Token LRU 缓存：避免每次光标移动或框选时对未改动行重复运行 12 个复杂正则表达式
const inlineTokenCache = new Map<string, { prefixEnd: number; tokens: InlineToken[] }>();

function extractLineInlineTokensCached(
  text: string,
  initialPrefixEnd: number
): { prefixEnd: number; tokens: InlineToken[] } {
  const cacheKey = `${initialPrefixEnd}::${text}`;
  const cached = inlineTokenCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let prefixEnd = initialPrefixEnd;
  const tokens: InlineToken[] = [];

  // 1. 列表项识别
  const afterQuoteAndHeader = text.slice(prefixEnd);
  const taskMatch = afterQuoteAndHeader.match(/^(\s*)([-*+]\s+\[)([ xX])(\]\s*)/);
  const listMatch = afterQuoteAndHeader.match(/^(\s*)([-*+]|\d+\.)(\s+)/);

  if (taskMatch) {
    const indentSpaces = taskMatch[1].length;
    const checkRelOffset = prefixEnd + indentSpaces + taskMatch[2].length;
    const isChecked = taskMatch[3].toLowerCase() === "x";
    tokens.push({
      type: "task",
      start: prefixEnd + indentSpaces,
      end: prefixEnd + taskMatch[0].length,
      content: taskMatch[0].slice(indentSpaces),
      isOpaque: true,
      data: { isChecked, checkPos: checkRelOffset, indentSpaces },
    });
    prefixEnd += taskMatch[0].length;
  } else if (listMatch) {
    const indentSpaces = listMatch[1].length;
    const marker = listMatch[2];
    const level = Math.min(4, Math.floor(indentSpaces / 2) + 1);
    if (/^[-*+]$/.test(marker)) {
      const markerStart = prefixEnd + indentSpaces;
      // 包含符号后的空格，防止多余空格暴露造成视觉缩进错乱
      const markerEnd = prefixEnd + listMatch[0].length;
      tokens.push({
        type: "bullet",
        start: markerStart,
        end: markerEnd,
        content: listMatch[0].slice(indentSpaces),
        isOpaque: true,
        data: { level, indentSpaces },
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
        data: { numText, level, indentSpaces },
      });
    }
    prefixEnd += listMatch[0].length;
  }

  // 2. 第一梯队：收集不可嵌套的原子 Token
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

  const tagRegex =
    /(?:^|(?<=\s))#([a-zA-Z0-9_\-\u4e00-\u9fa5]+(?:\/[a-zA-Z0-9_\-\u4e00-\u9fa5]+)*)(?=\s|$|[，。！？、；：,.!?;:])/g;
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

  // 3. 第二梯队：平衡括号超链接与可组合富文本格式 Token
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

  const res = { prefixEnd, tokens: acceptedTokens };
  if (inlineTokenCache.size > 1500) {
    const first = inlineTokenCache.keys().next().value;
    if (first) inlineTokenCache.delete(first);
  }
  inlineTokenCache.set(cacheKey, res);
  return res;
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

const CODE_MAX_VISIBLE_LINES = 28;

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
  const isCaretOnly = selection.empty && !isViewMouseSelecting(view);
  const cursorHead = selection.head;
  const doc = view.state.doc;
  const cursorLine = doc.lineAt(cursorHead).number;

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

  const stableHeadingKeys = buildStableHeadingFoldKeys(headings);
  const stableCodeKeys = buildStableCodeBlockKeys(codeRanges);

  // 计算当前被折叠章节覆盖的行号集合（若单光标直接进入折叠章节内部则自动临时展开以防黑洞）
  const foldedLinesSet = new Set<number>();
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const key = stableHeadingKeys[i];
    if (foldedHeadingKeys.has(key)) {
      if (isCaretOnly && cursorLine > h.line && cursorLine <= h.endLine) {
        foldedHeadingKeys.delete(key);
        continue;
      }
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
        const isEditingFM = isCaretOnly && cursorLine >= 1 && cursorLine <= frontMatterEndLine;
        if (!isEditingFM) {
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

      // 2.1 普通代码块（恒定展示顶栏卡片；当单光标落入围栏首尾行时允许原位编辑围栏，框选文字时绝不销毁顶栏防止跳闪）
      const codeRangeIdx = codeRanges.findIndex(
        (r) => lineNum >= r.startLine && lineNum <= r.endLine
      );
      if (codeRangeIdx !== -1) {
        const codeRange = codeRanges[codeRangeIdx];
        const stableKey = stableCodeKeys[codeRangeIdx] || `${codeRange.startLine}`;
        const isCodeCollapsed = collapsedCodeBlocks.has(stableKey);
        const isCodeWrapped = !wrappedCodeBlocks.has(stableKey);
        const codeLinesCount = Math.max(0, codeRange.endLine - codeRange.startLine - 1);
        const isLongBlock = codeLinesCount > CODE_MAX_VISIBLE_LINES;
        if (
          cursorLine > codeRange.startLine + CODE_MAX_VISIBLE_LINES &&
          cursorLine < codeRange.endLine
        ) {
          expandedMaxHeightCodeBlocks.add(stableKey);
        }
        const isMaxExpanded = expandedMaxHeightCodeBlocks.has(stableKey);

        if (lineNum === codeRange.startLine) {
          const isEditingOpeningFence = isCaretOnly && cursorLine === codeRange.startLine;
          addDeco(
            line.from,
            line.from,
            Decoration.line({
              class: `cm-code-block-first-line ${
                isCodeCollapsed ? "cm-code-block-collapsed-header" : ""
              }`,
            })
          );
          if (!isEditingOpeningFence) {
            addDeco(
              line.from,
              line.to,
              Decoration.replace({
                widget: new CodeBlockHeaderWidget(
                  stableKey,
                  codeRange.lang,
                  codeRange.codeText,
                  line.from,
                  codeRange.fencePrefix,
                  codeLinesCount,
                  isCodeCollapsed,
                  isCodeWrapped
                ),
              })
            );
          }
        } else if (!codeRange.unclosed && lineNum === codeRange.endLine) {
          const isEditingClosingFence = isCaretOnly && cursorLine === codeRange.endLine;
          addDeco(
            line.from,
            line.from,
            Decoration.line({
              class: isCodeCollapsed
                ? "cm-folded-section-line"
                : isEditingClosingFence
                ? "cm-code-block-last-line"
                : "cm-code-block-last-line cm-code-block-cap",
            })
          );
          if (!isEditingClosingFence && !isCodeCollapsed) {
            if (isLongBlock) {
              addDeco(
                line.from,
                line.to,
                Decoration.replace({
                  widget: new CodeBlockExpandFooterWidget(
                    stableKey,
                    codeLinesCount - CODE_MAX_VISIBLE_LINES,
                    isMaxExpanded
                  ),
                })
              );
            } else {
              addDeco(line.from, line.to, Decoration.replace({}));
            }
          }
        } else {
          const codeLineIdx = lineNum - codeRange.startLine;
          if (
            isCodeCollapsed ||
            (isLongBlock && !isMaxExpanded && codeLineIdx > CODE_MAX_VISIBLE_LINES)
          ) {
            addDeco(line.from, line.from, Decoration.line({ class: "cm-folded-section-line" }));
            continue;
          }
          addDeco(
            line.from,
            line.from,
            Decoration.line({
              class: `cm-code-block-line ${isCodeWrapped ? "cm-code-line-wrapped" : "cm-code-nowrap"}`,
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
      const mermaidBlock = mermaidBlocks.find(
        (b) => lineNum >= b.startLine && lineNum <= b.endLine
      );
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
        const isCursorOnHr = isCaretOnly && cursorLine === lineNum;
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
        const isCursorOnToc = isCaretOnly && cursorLine === lineNum;
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
        const isCursorInMath = isCaretOnly && cursorHead >= line.from && cursorHead <= line.to;
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
          const isCursorOnCalloutHeader = isCaretOnly && cursorLine === lineNum;
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
          const isPrevQuote = lineNum > 1 && /^\s*>/.test(doc.line(lineNum - 1).text);
          const isNextQuote = lineNum < doc.lines && /^\s*>/.test(doc.line(lineNum + 1).text);
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
          isCaretOnly && cursorHead >= line.from && cursorHead < line.from + quotePrefixLen;

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
        const isCursorAtPrefix =
          isCaretOnly &&
          cursorHead >= line.from + hStart &&
          cursorHead < line.from + hEnd;

        const headingIdx = headings.findIndex((h) => h.line === lineNum);
        const headingMeta = headingIdx !== -1 ? headings[headingIdx] : undefined;
        const foldKey = headingIdx !== -1 ? stableHeadingKeys[headingIdx] : "";
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

      // 2.7 O(1) 从行级 LRU 缓存提取当前行的列表标记与内联 Token
      const { tokens: acceptedTokens } = extractLineInlineTokensCached(text, prefixEnd);

      for (const tok of acceptedTokens) {
        const s = line.from + tok.start;
        const e = line.from + tok.end;

        // 仅当单光标（非拖拽框选态）真正进入该 Token 内部时才展开 Markdown 定界符，
        // 框选多行文字时保持所有定界符与 Widget 稳定不跳变，彻底根治左键框选闪烁问题
        const isCursorInside = isCaretOnly && cursorHead >= s && cursorHead <= e;

        if (tok.type === "task" || tok.type === "bullet" || tok.type === "ordered_marker") {
          const indentSpaces: number = tok.data.indentSpaces || 0;
          // 兼容 2 空格无序子列表与 3 空格有序子列表缩进层级计算
          const level =
            indentSpaces === 0
              ? 1
              : Math.min(4, Math.max(2, Math.round(indentSpaces / 2.5) + 1));
          const lineCls =
            tok.type === "task"
              ? `cm-list-item cm-task-list-item cm-list-level-${level}`
              : `cm-list-item cm-list-level-${level}`;
          addDeco(line.from, line.from, Decoration.line({ class: lineCls }));

          // 当光标停留在列表标记末尾空格之后（即 cursorHead === e，例如刚按下回车生成新列表行时），
          // 保持渲染圆点/有序编号/任务复选框 Widget，仅当光标真正进入标记字符内部 (s <= cursorHead < e) 时才展开源码
          const isCursorInMarker = isCaretOnly && cursorHead >= s && cursorHead < e;

          if (indentSpaces > 0) {
            const indentFrom = s - indentSpaces;
            const indentTo = s;
            const isCursorInIndent =
              isCaretOnly && cursorHead >= indentFrom && cursorHead < indentTo;
            if (!isCursorInIndent) {
              addDeco(indentFrom, indentTo, Decoration.replace({}));
            }
          }

          if (tok.type === "task") {
            if (!isCursorInMarker) {
              addDeco(
                s,
                e,
                Decoration.replace({
                  widget: new TaskWidget(tok.data.isChecked, line.from + tok.data.checkPos),
                })
              );
            } else {
              addDeco(s, e, Decoration.mark({ class: "cm-md-delimiter" }));
            }
          } else if (tok.type === "bullet") {
            if (!isCursorInMarker) {
              addDeco(
                s,
                e,
                Decoration.replace({
                  widget: new BulletWidget(level, s),
                })
              );
            } else {
              addDeco(s, e, Decoration.mark({ class: "cm-md-delimiter" }));
            }
          } else if (tok.type === "ordered_marker") {
            if (!isCursorInMarker) {
              addDeco(
                s,
                e,
                Decoration.replace({
                  widget: new OrderedListMarkerWidget(tok.data.numText, level, s),
                })
              );
            } else {
              addDeco(s, e, Decoration.mark({ class: "cm-md-delimiter" }));
            }
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
          const isSelectionInsideThisLink =
            !mouseSelectingViews.has(view) &&
            !selection.empty &&
            selection.from >= s &&
            selection.to <= e;
          const isCursorInUrlPart =
            isSelectionInsideThisLink ||
            (isCursorInside &&
              (!prefs.compactLinkExpansion ||
                cursorHead <= s + 1 ||
                cursorHead >= s + 1 + textLen));

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
    private onMouseDown: (e: MouseEvent) => void;
    private onMouseUp: () => void;

    constructor(readonly view: EditorView) {
      this.decorations = buildDecorations(view);

      this.onMouseDown = (e: MouseEvent) => {
        if (e.button === 0) {
          mouseSelectingViews.add(this.view);
        }
      };

      this.onMouseUp = () => {
        if (mouseSelectingViews.has(this.view)) {
          mouseSelectingViews.delete(this.view);
          if (this.view.state.selection.main.empty) {
            this.view.dispatch({ effects: forceRefreshEffect.of(true) });
          }
        }
      };

      view.contentDOM.addEventListener("mousedown", this.onMouseDown);
      window.addEventListener("mouseup", this.onMouseUp);
    }

    update(update: ViewUpdate) {
      if (imeState.isViewComposing(update.view)) {
        this.decorations = this.decorations.map(update.changes);
        return;
      }

      // 鼠标按住左键拖拽框选途中，若文档内容未变且视口未变，不反复重建装饰器，彻底消除框选跳闪
      if (
        mouseSelectingViews.has(update.view) &&
        !update.docChanged &&
        !update.viewportChanged &&
        !update.state.selection.main.empty
      ) {
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

    destroy() {
      mouseSelectingViews.delete(this.view);
      this.view.contentDOM.removeEventListener("mousedown", this.onMouseDown);
      window.removeEventListener("mouseup", this.onMouseUp);
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
