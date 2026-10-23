import { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { getDocStructure, isInsideCodeContextAST } from "./doc-structure";
import { showToast } from "../../components/save-dialog";

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

function highlightKeywordInSnippet(text: string, keyword: string): string {
  if (!keyword) return escapeHtml(text);
  const escapedText = escapeHtml(text);
  const escapedKw = escapeHtml(keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    const re = new RegExp(`(\\[\\[${escapedKw}(?:[#|][^\\]]*)?\\]\\]|${escapedKw})`, "gi");
    return escapedText.replace(re, `<span class="backlink-hit">$1</span>`);
  } catch {
    return escapedText;
  }
}

/**
 * 解析单行中的 [[文件名#标题|显示别名]] 双向链接与 ![[文件名#标题]] / ![[文件名#^block-id]] 块级嵌入（自动忽略行内代码反引号包裹区间）
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
 * 在内存中提取指定 Markdown 文本的章节或 `^block-id` 块内容（供当前未落盘文档实时嵌入同步使用）
 */
export function extractSectionOrBlockInMemory(fullMarkdown: string, heading?: string): string {
  const lines = fullMarkdown.replace(/\r\n/g, "\n").split("\n");
  let startIdx = 0;
  if (lines.length >= 3 && lines[0].trim() === "---") {
    for (let k = 1; k < Math.min(lines.length, 40); k++) {
      if (lines[k].trim() === "---" || lines[k].trim() === "...") {
        startIdx = k + 1;
        break;
      }
    }
  }
  const query = (heading || "").trim().replace(/^#+/, "").trim();
  if (!query) {
    return lines.slice(startIdx).join("\n").trim();
  }
  if (query.startsWith("^")) {
    const blockId = query.slice(1).toLowerCase();
    const re = new RegExp(`^(.*?)\\s+\\^${blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
    for (let i = startIdx; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) {
        return m[1].trim() || (i > startIdx ? lines[i - 1].trim() : "");
      }
      if (lines[i].trim().toLowerCase() === `^${blockId}` && i > startIdx) {
        return lines[i - 1].trim();
      }
    }
    return "";
  }
  const lowerQuery = query.toLowerCase();
  let matchStart = -1;
  let matchLevel = 0;
  for (let i = startIdx; i < lines.length; i++) {
    const hm = lines[i].match(/^\s*(?:>\s*)*(#{1,6})\s+(.*)$/);
    if (hm) {
      const lvl = hm[1].length;
      const cleanTitle = hm[2]
        .replace(/\s+#+\s*$/, "")
        .replace(/\s+\^[a-zA-Z0-9_\-]+$/, "")
        .trim()
        .toLowerCase();
      if (matchStart === -1) {
        if (cleanTitle === lowerQuery || cleanTitle.includes(lowerQuery)) {
          matchStart = i;
          matchLevel = lvl;
        }
      } else if (lvl <= matchLevel) {
        return lines.slice(matchStart, i).join("\n").trim();
      }
    }
  }
  if (matchStart !== -1) {
    return lines.slice(matchStart).join("\n").trim();
  }
  return "";
}

/**
 * 异步读取 ![[文档#标题]] 或 ![[文档#^block-id]] 嵌入块的目标章节/段落文本（支持内存实时双向同步）
 */
export async function fetchTransclusionSectionContent(
  targetDoc: string,
  heading?: string,
  currentDocFallback?: string
): Promise<{ found: boolean; filePath: string | null; content: string }> {
  const targetName = (targetDoc || "").trim();
  const headingName = (heading || "").trim();

  if (!workspaceProvider) {
    if (currentDocFallback) {
      const extracted = extractSectionOrBlockInMemory(currentDocFallback, headingName);
      return { found: Boolean(extracted), filePath: null, content: extracted };
    }
    return { found: false, filePath: null, content: "" };
  }

  let targetPath: string | null = null;
  const activePath = workspaceProvider.getActiveFilePath();

  if (!targetName) {
    targetPath = activePath;
    if (currentDocFallback) {
      const extracted = extractSectionOrBlockInMemory(currentDocFallback, headingName);
      if (extracted) {
        return { found: true, filePath: targetPath, content: extracted };
      }
    }
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
    if (!targetName && currentDocFallback) {
      const extracted = extractSectionOrBlockInMemory(currentDocFallback, headingName);
      return { found: Boolean(extracted), filePath: null, content: extracted };
    }
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
 * 双向同步修改 ![[文档#标题]] 或 ![[文档#^block-id]] 源块内容并实时广播刷新 (Phase 3.1)
 */
export async function updateTransclusionSectionContent(
  targetDoc: string,
  heading: string | undefined,
  newContent: string,
  activeView?: EditorView
): Promise<boolean> {
  const targetName = (targetDoc || "").trim();
  const headingName = (heading || "").trim();
  const activePath = workspaceProvider?.getActiveFilePath() || null;

  let targetPath: string | null = null;
  if (!targetName) {
    targetPath = activePath;
  } else if (workspaceProvider) {
    const files = await workspaceProvider.getWorkspaceMarkdownFiles();
    const matched = files.find(
      (f) =>
        f.stem.toLowerCase() === targetName.toLowerCase() ||
        f.name.toLowerCase() === targetName.toLowerCase()
    );
    if (matched) targetPath = matched.path;
  }

  // 若是当前正在编辑的同一篇文档（或未落盘内存文档），直接在 EditorView 中原位替换对应块/章节
  const isSelfDoc =
    !targetName ||
    (targetPath &&
      activePath &&
      targetPath.replace(/\\/g, "/").toLowerCase() ===
        activePath.replace(/\\/g, "/").toLowerCase());

  if (isSelfDoc && activeView && headingName.startsWith("^")) {
    const blockId = headingName.slice(1);
    const doc = activeView.state.doc;
    const re = new RegExp(`^(.*?)(\\s+\\^${blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*)$`, "i");
    for (let ln = 1; ln <= doc.lines; ln++) {
      const lineObj = doc.line(ln);
      const m = lineObj.text.match(re);
      if (m) {
        const updatedLine = `${newContent.replace(/\r?\n/g, " ").trim()}${m[2]}`;
        activeView.dispatch({
          changes: { from: lineObj.from, to: lineObj.to, insert: updatedLine },
          userEvent: "input.transclusion.sync",
        });
        clearTransclusionCache();
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("quilla-transclusion-updated"));
        }
        return true;
      }
    }
  }

  if (!targetPath) return false;

  try {
    await invoke("update_heading_section", {
      path: targetPath,
      heading: headingName || null,
      newContent,
    });
    clearTransclusionCache();
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("quilla-transclusion-updated", {
          detail: { path: targetPath, heading: headingName },
        })
      );
    }
    return true;
  } catch (err) {
    console.warn("双向同步写回源文档失败:", err);
    return false;
  }
}

/**
 * 触发双向链接跳转或自动新建目标笔记（支持 [[文档#标题]] 与 [[文档#^block-id]] 精准定位）
 */
export async function handleWikiLinkTrigger(
  view: EditorView,
  targetDoc: string,
  heading?: string | null
) {
  const targetName = (targetDoc || "").trim();
  const headingName = (heading || "").trim() || null;

  if (!targetName && headingName) {
    const activePath = workspaceProvider?.getActiveFilePath();
    if (activePath && workspaceProvider) {
      workspaceProvider.onOpenWikiTarget(activePath, headingName);
    } else {
      import("./anchor-navigator").then(({ navigateToAnchor }) => {
        navigateToAnchor(view, headingName);
      });
    }
    return;
  }

  if (!workspaceProvider) return;

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
 * CodeMirror 6 自动补全源：
 * - 输入 `[[` 或 `![[` 时检索工作区文件名
 * - 输入 `[[文件名#` 或 `[[#` 时实时补全目标文档内的全部 H1~H6 标题与 `^block-id` 块级引用锚点
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
  if (afterOpen.includes("]]") || afterOpen.includes("|")) return null;

  const afterCursor = line.text.slice(context.pos - line.from);
  const hasClosingBrackets = afterCursor.startsWith("]]");

  const files = workspaceProvider ? await workspaceProvider.getWorkspaceMarkdownFiles() : [];

  // 情况 1：包含 `#`，补全指定文档（或当前文档）内的 H1~H6 标题与 ^block-id 块引用锚点
  const hashIdx = afterOpen.indexOf("#");
  if (hashIdx !== -1) {
    const docStem = afterOpen.slice(0, hashIdx).trim();
    const headingQuery = afterOpen.slice(hashIdx + 1).toLowerCase();
    const fromPos = line.from + openIdx + 2 + hashIdx + 1;

    const activeFilePath = workspaceProvider?.getActiveFilePath() || null;
    let targetFilePath: string | null = null;
    let isCurrentActiveDoc = false;

    if (!docStem) {
      targetFilePath = activeFilePath;
      isCurrentActiveDoc = true;
    } else {
      const matchedFile = files.find(
        (f) =>
          f.stem.toLowerCase() === docStem.toLowerCase() ||
          f.name.toLowerCase() === docStem.toLowerCase()
      );
      targetFilePath = matchedFile ? matchedFile.path : null;
      if (
        targetFilePath &&
        activeFilePath &&
        targetFilePath.replace(/\\/g, "/").toLowerCase() ===
          activeFilePath.replace(/\\/g, "/").toLowerCase()
      ) {
        isCurrentActiveDoc = true;
      }
    }

    try {
      let headings: Array<{ level: number; text: string; line: number; insertValue?: string }> = [];

      if (isCurrentActiveDoc) {
        const struct = getDocStructure(context.state);
        for (const h of struct.headings) {
          headings.push({
            level: h.level,
            text: h.text,
            line: h.line,
            insertValue: h.text,
          });
        }
        for (const b of struct.blockAnchors) {
          headings.push({
            level: 0,
            text: `^${b.id} (${b.preview})`,
            line: b.line,
            insertValue: `^${b.id}`,
          });
        }
      } else if (targetFilePath) {
        const rawHeadings = await invoke<Array<{ level: number; text: string; line: number }>>(
          "extract_file_headings",
          { path: targetFilePath }
        );
        headings = rawHeadings.map((h) => {
          const isBlockId = h.level === 0 || h.text.startsWith("^");
          const cleanInsert = isBlockId ? h.text.replace(/\s+\(.*\)$/, "").trim() : h.text;
          return {
            level: h.level,
            text: h.text,
            line: h.line,
            insertValue: cleanInsert,
          };
        });
      }

      const options = headings
        .filter((h) => !headingQuery || h.text.toLowerCase().includes(headingQuery))
        .map((h) => {
          const targetInsert = h.insertValue || h.text;
          return {
            label: h.text,
            detail: h.level === 0 ? `块引用 · L${h.line}` : `H${h.level} · L${h.line}`,
            apply: (view: EditorView, _completion: any, from: number, to: number) => {
              const insertText = hasClosingBrackets ? targetInsert : `${targetInsert}]]`;
              view.dispatch({
                changes: { from, to, insert: insertText },
                selection: { anchor: from + insertText.length + (hasClosingBrackets ? 2 : 0) },
              });
            },
          };
        });

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
    .slice(0, 35)
    .map((f) => ({
      label: f.stem,
      detail: `${f.name} · 可输入 # 跳转标题`,
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
      const matched = targetName
        ? files.find(
            (f) =>
              f.stem.toLowerCase() === targetName.toLowerCase() ||
              f.name.toLowerCase() === targetName.toLowerCase()
          )
        : {
            path: workspaceProvider.getActiveFilePath() || "",
            name: "当前文档",
            stem: "当前文档",
          };

      const rect = wikiEl.getBoundingClientRect();
      previewCard.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`;
      previewCard.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 200)}px`;

      if (!matched || !matched.path) {
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
            <span class="wiki-preview-badge">${
              headingName.startsWith("^") ? "块级引用" : "双链预览"
            }</span>
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

interface BacklinkHitItem {
  file: string;
  file_name: string;
  line: number;
  text: string;
}

/**
 * 文档底部与大纲面板下方联动的反向链接（Backlinks: Linked & Unlinked Mentions）控制器
 */
export class BacklinksController {
  private panelEl: HTMLElement;
  private listEl: HTMLElement;
  private countBadgeEl: HTMLElement;
  private linkedTabBtn: HTMLElement;
  private unlinkedTabBtn: HTMLElement;
  private outlineSectionEl: HTMLElement | null = null;
  private outlineListEl: HTMLElement | null = null;
  private outlineBadgeEl: HTMLElement | null = null;
  private isCollapsed: boolean = true;
  private isOutlineCollapsed: boolean = false;
  private activeTab: "linked" | "unlinked" = "linked";
  private lastLinkedItems: BacklinkHitItem[] = [];
  private lastUnlinkedItems: BacklinkHitItem[] = [];
  private lastTargetStem: string = "";
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
      <div class="backlinks-header" id="backlinks-toggle-header" title="展开/收起提及当前文档的反向链接 (Linked & Unlinked Mentions)">
        <div class="backlinks-title-box">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
          </svg>
          <span>反向链接 (Backlinks)</span>
          <span class="backlinks-badge" id="backlinks-count-badge">0</span>
        </div>
        <div class="backlinks-header-right">
          <div class="backlinks-tabs" id="backlinks-mode-tabs">
            <button type="button" class="backlinks-tab-btn active" data-tab="linked" title="显式通过 [[双链]] 引用当前文档的位置">已链接引用 (0)</button>
            <button type="button" class="backlinks-tab-btn" data-tab="unlinked" title="提及了当前文档名但尚未添加 [[]] 的位置（支持一键转为双链）">未链接提及 (0)</button>
          </div>
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
    this.linkedTabBtn = this.panelEl.querySelector('[data-tab="linked"]') as HTMLElement;
    this.unlinkedTabBtn = this.panelEl.querySelector('[data-tab="unlinked"]') as HTMLElement;

    this.panelEl.querySelector("#backlinks-toggle-header")?.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("#backlinks-open-graph-btn") || target.closest(".backlinks-tab-btn")) {
        return;
      }
      this.isCollapsed = !this.isCollapsed;
      this.panelEl.classList.toggle("collapsed", this.isCollapsed);
    });

    this.panelEl.querySelectorAll<HTMLElement>(".backlinks-tab-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const tab = (btn.dataset.tab as "linked" | "unlinked") || "linked";
        this.activeTab = tab;
        this.isCollapsed = false;
        this.panelEl.classList.remove("collapsed");
        this.renderCurrentItems();
      });
    });

    this.panelEl.querySelector("#backlinks-open-graph-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (workspaceProvider?.onOpenGraphModal) {
        workspaceProvider.onOpenGraphModal();
      } else {
        window.dispatchEvent(new CustomEvent("quilla-open-graph-view"));
      }
    });

    this.mountOutlineBacklinksSection();
  }

  private mountOutlineBacklinksSection() {
    const panelOutline = document.getElementById("panel-outline");
    if (!panelOutline || document.getElementById("outline-backlinks-section")) return;

    const section = document.createElement("div");
    section.id = "outline-backlinks-section";
    section.className = "outline-backlinks-section hidden";
    section.innerHTML = `
      <div class="outline-backlinks-header" id="outline-backlinks-toggle">
        <div class="outline-backlinks-title">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
          </svg>
          <span>提及此文档 (Mentions)</span>
          <span class="backlinks-badge" id="outline-backlinks-badge">0</span>
        </div>
        <svg class="backlinks-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </div>
      <div class="outline-backlinks-list" id="outline-backlinks-list"></div>
    `;
    panelOutline.appendChild(section);

    this.outlineSectionEl = section;
    this.outlineListEl = section.querySelector("#outline-backlinks-list") as HTMLElement;
    this.outlineBadgeEl = section.querySelector("#outline-backlinks-badge") as HTMLElement;

    section.querySelector("#outline-backlinks-toggle")?.addEventListener("click", () => {
      this.isOutlineCollapsed = !this.isOutlineCollapsed;
      section.classList.toggle("collapsed", this.isOutlineCollapsed);
    });
  }

  private buildBacklinkRow(
    item: BacklinkHitItem,
    targetStem: string,
    isUnlinked: boolean
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = `backlink-item${isUnlinked ? " is-unlinked" : ""}`;
    row.innerHTML = `
      <div class="backlink-item-meta">
        <span class="backlink-file">${escapeHtml(item.file_name)}</span>
        <span class="backlink-line">L${item.line}</span>
      </div>
      <div class="backlink-snippet">${highlightKeywordInSnippet(item.text, targetStem)}</div>
      ${
        isUnlinked
          ? `<button type="button" class="backlink-linkify-btn" title="将该行中的「${escapeHtml(
              targetStem
            )}」自动转换为 [[${escapeHtml(targetStem)}]] 双链">转为 [[双链]]</button>`
          : ""
      }
    `;

    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".backlink-linkify-btn")) return;
      this.onNavigate(item.file, item.line, targetStem);
    });

    if (isUnlinked) {
      row.querySelector(".backlink-linkify-btn")?.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          // 修复 Tauri IPC 参数契约：Rust commands.rs 接收 line: usize（同时传递 line 与 lineNumber 双向兼容）
          await invoke("convert_unlinked_mention_to_wikilink", {
            filePath: item.file,
            line: item.line,
            lineNumber: item.line,
            targetName: targetStem,
          });
          showToast(`已将 ${item.file_name} (L${item.line}) 转为 [[${targetStem}]] 双链`, "success");
          await this.refresh();
        } catch (err) {
          showToast(`转换双链失败: ${err}`, "error");
        }
      });
    }

    return row;
  }

  private renderCurrentItems() {
    const totalCount = this.lastLinkedItems.length + this.lastUnlinkedItems.length;
    this.countBadgeEl.textContent = String(totalCount);
    if (this.outlineBadgeEl) {
      this.outlineBadgeEl.textContent = String(totalCount);
    }

    this.linkedTabBtn.textContent = `已链接引用 (${this.lastLinkedItems.length})`;
    this.unlinkedTabBtn.textContent = `未链接提及 (${this.lastUnlinkedItems.length})`;
    this.linkedTabBtn.classList.toggle("active", this.activeTab === "linked");
    this.unlinkedTabBtn.classList.toggle("active", this.activeTab === "unlinked");

    const activeItems =
      this.activeTab === "linked" ? this.lastLinkedItems : this.lastUnlinkedItems;
    const isUnlinked = this.activeTab === "unlinked";

    const frag = document.createDocumentFragment();
    if (activeItems.length === 0) {
      const emptyHint = document.createElement("div");
      emptyHint.className = "backlinks-empty-hint";
      emptyHint.textContent =
        this.activeTab === "linked"
          ? this.lastUnlinkedItems.length > 0
            ? `暂无显式 [[${this.lastTargetStem}]] 双链引用 · 发现 ${this.lastUnlinkedItems.length} 处未链接提及，可切换至「未链接提及」一键转为双链`
            : "暂无其他笔记引用此文档 · 点击右上角“知识图谱”可总览工作区连接网络"
          : "工作区其他笔记中暂无未加 [[]] 的同名提及";
      frag.appendChild(emptyHint);
    } else {
      activeItems.forEach((item) => {
        frag.appendChild(this.buildBacklinkRow(item, this.lastTargetStem, isUnlinked));
      });
    }

    this.listEl.replaceChildren(frag);

    if (this.outlineListEl && this.outlineSectionEl) {
      const outlineFrag = document.createDocumentFragment();
      if (this.lastLinkedItems.length === 0 && this.lastUnlinkedItems.length === 0) {
        const hint = document.createElement("div");
        hint.className = "backlinks-empty-hint";
        hint.textContent = "暂无其他笔记提及当前文档";
        outlineFrag.appendChild(hint);
      } else {
        if (this.lastLinkedItems.length > 0) {
          const groupTitle = document.createElement("div");
          groupTitle.className = "outline-backlinks-group-label";
          groupTitle.textContent = `已链接引用 (${this.lastLinkedItems.length})`;
          outlineFrag.appendChild(groupTitle);
          this.lastLinkedItems.forEach((item) => {
            outlineFrag.appendChild(this.buildBacklinkRow(item, this.lastTargetStem, false));
          });
        }
        if (this.lastUnlinkedItems.length > 0) {
          const groupTitle = document.createElement("div");
          groupTitle.className = "outline-backlinks-group-label";
          groupTitle.textContent = `未链接提及 (${this.lastUnlinkedItems.length})`;
          outlineFrag.appendChild(groupTitle);
          this.lastUnlinkedItems.forEach((item) => {
            outlineFrag.appendChild(this.buildBacklinkRow(item, this.lastTargetStem, true));
          });
        }
      }
      this.outlineListEl.replaceChildren(outlineFrag);
    }
  }

  public async refresh() {
    clearTransclusionCache();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("quilla-transclusion-updated"));
    }
    if (!workspaceProvider) {
      this.panelEl.classList.add("hidden");
      this.outlineSectionEl?.classList.add("hidden");
      return;
    }
    const wsRoot = workspaceProvider.getWorkspaceRoot();
    const activePath = workspaceProvider.getActiveFilePath();
    if (!wsRoot || !activePath) {
      this.panelEl.classList.add("hidden");
      this.outlineSectionEl?.classList.add("hidden");
      return;
    }

    const fileName = activePath.split(/[\\/]/).pop() || "";
    const targetStem = fileName.replace(/\.(md|markdown|txt)$/i, "");
    if (!targetStem) {
      this.panelEl.classList.add("hidden");
      this.outlineSectionEl?.classList.add("hidden");
      return;
    }

    this.lastTargetStem = targetStem;

    try {
      const overview = await invoke<{
        linked: BacklinkHitItem[];
        unlinked: BacklinkHitItem[];
      }>("search_backlinks_overview", {
        targetName: targetStem,
        currentFilePath: activePath,
      }).catch(async () => {
        const linkedOnly = await invoke<BacklinkHitItem[]>("search_backlinks", {
          targetName: targetStem,
          currentFilePath: activePath,
        });
        return { linked: linkedOnly || [], unlinked: [] };
      });

      this.lastLinkedItems = overview.linked || [];
      this.lastUnlinkedItems = overview.unlinked || [];
      if (this.lastLinkedItems.length === 0 && this.lastUnlinkedItems.length > 0) {
        this.activeTab = "unlinked";
      } else if (
        this.lastLinkedItems.length > 0 &&
        this.activeTab === "unlinked" &&
        this.lastUnlinkedItems.length === 0
      ) {
        this.activeTab = "linked";
      }

      this.panelEl.classList.remove("hidden");
      this.outlineSectionEl?.classList.remove("hidden");
      this.renderCurrentItems();
    } catch {
      this.panelEl.classList.add("hidden");
      this.outlineSectionEl?.classList.add("hidden");
    }
  }
}
