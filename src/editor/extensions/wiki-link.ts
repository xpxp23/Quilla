import { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { isInsideCodeContextAST } from "./doc-structure";

export interface WikiLinkMatch {
  start: number;
  end: number;
  fromOffset: number;
  toOffset: number;
  raw: string;
  rawInner: string;
  targetDoc: string;
  target: string;
  heading: string;
  alias: string | null;
  displayText: string;
  isEmbed: boolean;
}

export interface WikiWorkspaceProvider {
  getWorkspaceRoot: () => string | null;
  getActiveFilePath: () => string | null;
  getWorkspaceMarkdownFiles: () => Promise<Array<{ path: string; name: string; stem: string }>>;
  onOpenWikiTarget: (filePath: string, headingAnchor?: string | null) => void;
  onCreateAndOpenWikiFile?: (targetName: string, headingAnchor?: string | null) => void;
  onSearchTag?: (tagName: string) => void;
  onFilterByTag?: (tagName: string) => void;
  onOpenGraphModal?: () => void;
}

let workspaceProvider: WikiWorkspaceProvider | null = null;

export function registerWikiWorkspaceProvider(provider: WikiWorkspaceProvider) {
  workspaceProvider = provider;
}

export function getWikiWorkspaceProvider(): WikiWorkspaceProvider | null {
  return workspaceProvider;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * 解析单行中的 [[文件名#标题|显示别名]] 双向链接与 ![[文件名#标题]] 块级嵌入（自动忽略行内代码反引号包裹区间）
 */
export function parseWikiLinksInLine(
  lineText: string,
  startOffset: number = 0
): WikiLinkMatch[] {
  const results: WikiLinkMatch[] = [];
  const len = lineText.length;
  let i = Math.max(0, startOffset);

  while (i < len) {
    if (lineText[i] === "\\") {
      i += 2;
      continue;
    }
    if (lineText[i] === "`") {
      let ticks = 1;
      while (i + ticks < len && lineText[i + ticks] === "`") ticks++;
      const closeIdx = lineText.indexOf("`".repeat(ticks), i + ticks);
      if (closeIdx !== -1) {
        i = closeIdx + ticks;
        continue;
      }
    }

    const isEmbed =
      lineText[i] === "!" &&
      i + 2 < len &&
      lineText[i + 1] === "[" &&
      lineText[i + 2] === "[";
    const isStandardWiki =
      lineText[i] === "[" && i + 1 < len && lineText[i + 1] === "[";

    if (isEmbed || isStandardWiki) {
      const bracketOpenIdx = isEmbed ? i + 1 : i;
      const closeIdx = lineText.indexOf("]]", bracketOpenIdx + 2);
      if (closeIdx !== -1) {
        const rawInner = lineText.slice(bracketOpenIdx + 2, closeIdx).trim();
        if (rawInner.length > 0 && !rawInner.includes("\n")) {
          const [targetAndHeading, aliasPart] = rawInner.split("|");
          const [targetPart, headingPart] = (targetAndHeading || "").split("#");
          const target = (targetPart || "").trim();
          const heading = headingPart ? headingPart.trim() : "";
          const alias = aliasPart ? aliasPart.trim() : null;
          const displayText = alias
            ? alias
            : heading
            ? target
              ? `${target} › ${heading}`
              : `#${heading}`
            : target;
          if (target || heading) {
            results.push({
              start: i,
              end: closeIdx + 2,
              fromOffset: i,
              toOffset: closeIdx + 2,
              raw: lineText.slice(i, closeIdx + 2),
              rawInner,
              targetDoc: target,
              target,
              heading,
              alias,
              displayText,
              isEmbed,
            });
          }
          i = closeIdx + 2;
          continue;
        }
      }
    }
    i++;
  }

  return results;
}

const transclusionCache = new Map<string, string>();
export function clearTransclusionCache() {
  transclusionCache.clear();
}

/**
 * 异步读取 ![[文档#标题]] 嵌入块的目标章节文本（带内存缓存）
 */
export async function fetchTransclusionSectionContent(
  targetDoc: string,
  heading?: string,
  currentDocFallback?: string
): Promise<{ found: boolean; filePath: string | null; content: string }> {
  if (!workspaceProvider) {
    if (currentDocFallback) {
      return { found: true, filePath: null, content: currentDocFallback.slice(0, 500) };
    }
    return { found: false, filePath: null, content: "" };
  }
  const targetName = (targetDoc || "").trim();
  const headingName = (heading || "").trim();
  let targetPath: string | null = null;

  if (!targetName) {
    targetPath = workspaceProvider.getActiveFilePath();
  } else {
    const files = await workspaceProvider.getWorkspaceMarkdownFiles();
    const matched = files.find(
      (f) =>
        f.stem.toLowerCase() === targetName.toLowerCase() ||
        f.name.toLowerCase() === targetName.toLowerCase()
    );
    if (matched) targetPath = matched.path;
  }

  if (!targetPath) {
    return { found: false, filePath: null, content: "" };
  }

  const cacheKey = `${targetPath}::${headingName}`;
  const cached = transclusionCache.get(cacheKey);
  if (cached !== undefined) {
    return { found: true, filePath: targetPath, content: cached };
  }

  try {
    const sectionMd = await invoke<string>("read_heading_section", {
      path: targetPath,
      heading: headingName || null,
    });
    const trimmed = (sectionMd || "").trim();
    transclusionCache.set(cacheKey, trimmed);
    return { found: true, filePath: targetPath, content: trimmed };
  } catch {
    return { found: false, filePath: targetPath, content: "" };
  }
}

/**
 * 触发双向链接跳转或自动新建目标笔记（供 live-preview WikiLinkWidget 与事件委托调用）
 */
export async function handleWikiLinkTrigger(
  _view: EditorView,
  targetDoc: string,
  heading?: string | null
) {
  if (!workspaceProvider) return;
  const targetName = (targetDoc || "").trim();
  const headingName = (heading || "").trim() || null;

  if (!targetName) {
    const activePath = workspaceProvider.getActiveFilePath();
    if (activePath && headingName) {
      workspaceProvider.onOpenWikiTarget(activePath, headingName);
    }
    return;
  }

  const files = await workspaceProvider.getWorkspaceMarkdownFiles();
  const matched = files.find(
    (f) =>
      f.stem.toLowerCase() === targetName.toLowerCase() ||
      f.name.toLowerCase() === targetName.toLowerCase()
  );

  if (matched) {
    workspaceProvider.onOpenWikiTarget(matched.path, headingName);
  } else if (workspaceProvider.onCreateAndOpenWikiFile) {
    workspaceProvider.onCreateAndOpenWikiFile(targetName, headingName);
  }
}

/**
 * 触发 #标签 点击检索（统一对齐 onFilterByTag / onSearchTag 与全局自定义事件）
 */
export function handleTagClickTrigger(tagName: string) {
  const cleanTag = (tagName || "").replace(/^#+/, "").trim();
  if (!cleanTag) return;
  if (workspaceProvider?.onFilterByTag) {
    workspaceProvider.onFilterByTag(cleanTag);
    return;
  }
  if (workspaceProvider?.onSearchTag) {
    workspaceProvider.onSearchTag(cleanTag);
    return;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("quilla-filter-by-tag", { detail: { tag: cleanTag } }));
  }
}

/**
 * CodeMirror 6 自动补全源：输入 `[[` 或 `![[` 时检索工作区文件名，输入 `[[文件名#` 时检索该文件的全部 H1~H6 标题
 */
export async function wikiLinkCompletionSource(
  context: CompletionContext
): Promise<CompletionResult | null> {
  if (isInsideCodeContextAST(context.state, context.pos)) {
    return null;
  }

  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const openIdx = before.lastIndexOf("[[");
  if (openIdx === -1) return null;

  const afterOpen = before.slice(openIdx + 2);
  if (afterOpen.includes("]]")) return null;

  const afterCursor = line.text.slice(context.pos - line.from);
  const hasClosingBrackets = afterCursor.startsWith("]]");

  if (!workspaceProvider) return null;
  const files = await workspaceProvider.getWorkspaceMarkdownFiles();

  // 情况 1：包含 `#`，补全指定文档（或当前文档）内的标题
  const hashIdx = afterOpen.indexOf("#");
  if (hashIdx !== -1) {
    const docStem = afterOpen.slice(0, hashIdx).trim();
    const headingQuery = afterOpen.slice(hashIdx + 1).toLowerCase();
    const fromPos = line.from + openIdx + 2 + hashIdx + 1;

    let targetFilePath: string | null = null;
    if (!docStem) {
      targetFilePath = workspaceProvider.getActiveFilePath();
    } else {
      const matchedFile = files.find(
        (f) =>
          f.stem.toLowerCase() === docStem.toLowerCase() ||
          f.name.toLowerCase() === docStem.toLowerCase()
      );
      targetFilePath = matchedFile ? matchedFile.path : null;
    }

    if (!targetFilePath) return null;

    try {
      const headings = await invoke<Array<{ level: number; text: string; line: number }>>(
        "extract_file_headings",
        { path: targetFilePath }
      );
      const options = headings
        .filter((h) => !headingQuery || h.text.toLowerCase().includes(headingQuery))
        .map((h) => ({
          label: h.text,
          detail: `H${h.level} · L${h.line}`,
          apply: (view: EditorView, _completion: any, from: number, to: number) => {
            const insertText = hasClosingBrackets ? h.text : `${h.text}]]`;
            view.dispatch({
              changes: { from, to, insert: insertText },
              selection: { anchor: from + insertText.length + (hasClosingBrackets ? 2 : 0) },
            });
          },
        }));

      if (options.length === 0) return null;
      return {
        from: fromPos,
        options,
        filter: false,
      };
    } catch {
      return null;
    }
  }

  // 情况 2：补全工作区内的 Markdown 文档名
  const fileQuery = afterOpen.trim().toLowerCase();
  const fromPos = line.from + openIdx + 2;

  const options = files
    .filter(
      (f) =>
        !fileQuery ||
        f.stem.toLowerCase().includes(fileQuery) ||
        f.name.toLowerCase().includes(fileQuery)
    )
    .slice(0, 30)
    .map((f) => ({
      label: f.stem,
      detail: f.name,
      apply: (view: EditorView, _completion: any, from: number, to: number) => {
        const insertText = hasClosingBrackets ? f.stem : `${f.stem}]]`;
        view.dispatch({
          changes: { from, to, insert: insertText },
          selection: { anchor: from + f.stem.length + 2 },
        });
      },
    }));

  if (options.length === 0) return null;
  return {
    from: fromPos,
    options,
    filter: false,
  };
}

/**
 * 绑定编辑器内的 [[Wiki Link]] 悬停预览卡片交互
 */
export function setupWikiLinkInteractions(view: EditorView) {
  let previewCard = document.getElementById("ty-wikilink-preview-card");
  if (!previewCard) {
    previewCard = document.createElement("div");
    previewCard.id = "ty-wikilink-preview-card";
    previewCard.className = "ty-wikilink-preview-card hidden";
    document.body.appendChild(previewCard);
  }

  let hoverTimer: any = null;

  view.dom.addEventListener("mouseover", (e: MouseEvent) => {
    const wikiEl = (e.target as HTMLElement).closest(
      ".cm-wiki-link, .cm-wikilink"
    ) as HTMLElement | null;
    if (!wikiEl || !workspaceProvider) return;

    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(async () => {
      if (!workspaceProvider || !previewCard) return;
      const targetName = wikiEl.dataset.wikiDoc || wikiEl.dataset.target || "";
      const headingName = wikiEl.dataset.wikiHeading || wikiEl.dataset.heading || "";
      const files = await workspaceProvider.getWorkspaceMarkdownFiles();
      const matched = files.find(
        (f) =>
          f.stem.toLowerCase() === targetName.toLowerCase() ||
          f.name.toLowerCase() === targetName.toLowerCase()
      );

      const rect = wikiEl.getBoundingClientRect();
      previewCard.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`;
      previewCard.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 200)}px`;

      if (!matched) {
        previewCard.innerHTML = `
          <div class="wiki-preview-header">
            <span class="wiki-preview-title">${escapeHtml(targetName || "当前文档")}</span>
            <span class="wiki-preview-badge missing">未创建 · 点击自动新建</span>
          </div>
          <div class="wiki-preview-body">工作区中尚无此文档，点击该双链可一键新建 <strong>${escapeHtml(
            targetName
          )}.md</strong></div>
        `;
        previewCard.classList.remove("hidden");
        return;
      }

      try {
        const sectionText = await invoke<string>("read_heading_section", {
          path: matched.path,
          heading: headingName || null,
        });
        const excerpt = (sectionText || "").trim().slice(0, 280);
        previewCard.innerHTML = `
          <div class="wiki-preview-header">
            <span class="wiki-preview-title">${escapeHtml(matched.name)}${
          headingName ? ` › #${escapeHtml(headingName)}` : ""
        }</span>
            <span class="wiki-preview-badge">双链预览</span>
          </div>
          <div class="wiki-preview-body">${escapeHtml(excerpt || "(空白文档)")}${
          sectionText.length > 280 ? "..." : ""
        }</div>
          <div class="wiki-preview-footer">点击跳转 · Alt+点击编辑源码</div>
        `;
        previewCard.classList.remove("hidden");
      } catch {
        previewCard.classList.add("hidden");
      }
    }, 200);
  });

  view.dom.addEventListener("mouseout", (e: MouseEvent) => {
    const related = e.relatedTarget as HTMLElement | null;
    if (
      related &&
      (related.closest(".cm-wiki-link, .cm-wikilink") ||
        related.closest("#ty-wikilink-preview-card"))
    ) {
      return;
    }
    clearTimeout(hoverTimer);
    previewCard?.classList.add("hidden");
  });
}

/**
 * 文档底部可折叠反向链接（Backlinks）控制器 + 局部知识图谱入口
 */
export class BacklinksController {
  private panelEl: HTMLElement;
  private listEl: HTMLElement;
  private countBadgeEl: HTMLElement;
  private isCollapsed: boolean = true;
  private onNavigate: (filePath: string, line: number, targetName: string) => void;

  constructor(
    parentContainer: HTMLElement,
    onNavigate: (filePath: string, line: number, targetName: string) => void
  ) {
    this.onNavigate = onNavigate;
    this.panelEl = document.createElement("div");
    this.panelEl.id = "ty-backlinks-panel";
    this.panelEl.className = "ty-backlinks-panel collapsed hidden";
    this.panelEl.innerHTML = `
      <div class="backlinks-header" id="backlinks-toggle-header" title="展开/收起当前文档的双向链接反向引用列表">
        <div class="backlinks-title-box">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
          </svg>
          <span>反向链接 (Backlinks)</span>
          <span class="backlinks-badge" id="backlinks-count-badge">0</span>
        </div>
        <div class="backlinks-header-right">
          <button type="button" class="backlinks-graph-btn" id="backlinks-open-graph-btn" title="打开双链知识关系图谱 (Knowledge Graph)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="6" cy="6" r="3"></circle>
              <circle cx="18" cy="6" r="3"></circle>
              <circle cx="12" cy="18" r="3"></circle>
              <line x1="8.6" y1="7.5" x2="15.4" y2="6.5"></line>
              <line x1="7.5" y1="8.6" x2="10.5" y2="15.4"></line>
              <line x1="16.5" y1="8.6" x2="13.5" y2="15.4"></line>
            </svg>
            <span>知识图谱</span>
          </button>
          <svg class="backlinks-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
      </div>
      <div class="backlinks-list" id="backlinks-list"></div>
    `;
    parentContainer.appendChild(this.panelEl);

    this.listEl = this.panelEl.querySelector("#backlinks-list") as HTMLElement;
    this.countBadgeEl = this.panelEl.querySelector("#backlinks-count-badge") as HTMLElement;

    this.panelEl.querySelector("#backlinks-toggle-header")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("#backlinks-open-graph-btn")) return;
      this.isCollapsed = !this.isCollapsed;
      this.panelEl.classList.toggle("collapsed", this.isCollapsed);
    });

    this.panelEl.querySelector("#backlinks-open-graph-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (workspaceProvider?.onOpenGraphModal) {
        workspaceProvider.onOpenGraphModal();
      } else {
        window.dispatchEvent(new CustomEvent("quilla-open-graph-view"));
      }
    });
  }

  public async refresh() {
    clearTransclusionCache();
    if (!workspaceProvider) {
      this.panelEl.classList.add("hidden");
      return;
    }
    const wsRoot = workspaceProvider.getWorkspaceRoot();
    const activePath = workspaceProvider.getActiveFilePath();
    if (!wsRoot || !activePath) {
      this.panelEl.classList.add("hidden");
      return;
    }

    const fileName = activePath.split(/[\\/]/).pop() || "";
    const targetStem = fileName.replace(/\.(md|markdown|txt)$/i, "");
    if (!targetStem) {
      this.panelEl.classList.add("hidden");
      return;
    }

    try {
      const results = await invoke<
        Array<{ file: string; file_name: string; line: number; text: string }>
      >("search_backlinks", {
        targetName: targetStem,
        currentFilePath: activePath,
      });

      this.countBadgeEl.textContent = String(results.length);
      this.panelEl.classList.remove("hidden");

      const frag = document.createDocumentFragment();
      if (results.length === 0) {
        const emptyHint = document.createElement("div");
        emptyHint.className = "backlinks-empty-hint";
        emptyHint.textContent =
          "暂无其他笔记引用此文档 · 点击右上角“知识图谱”可总览工作区连接网络";
        frag.appendChild(emptyHint);
      } else {
        results.forEach((item) => {
          const row = document.createElement("div");
          row.className = "backlink-item";
          row.innerHTML = `
            <div class="backlink-item-meta">
              <span class="backlink-file">${escapeHtml(item.file_name)}</span>
              <span class="backlink-line">L${item.line}</span>
            </div>
            <div class="backlink-snippet">${escapeHtml(item.text)}</div>
          `;
          row.addEventListener("click", () => {
            this.onNavigate(item.file, item.line, targetStem);
          });
          frag.appendChild(row);
        });
      }

      // 原子替换子节点，彻底消除异步刷新期间先清空 innerHTML 导致的编辑区高度跳动 (Bug #4)
      this.listEl.replaceChildren(frag);
    } catch {
      this.panelEl.classList.add("hidden");
    }
  }
}
