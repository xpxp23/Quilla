import katex from "katex";
import mermaid from "mermaid";
import { parseWikiLinksInLine } from "./extensions/wiki-link";

/**
 * Quilla v0.8 统一 Markdown AST 解析与渲染内核 (Unified Markdown AST Kernel)
 * - 彻底取代分散在 main.ts 与 table-editor.ts 中的多套手写正则+占位符替换管线
 * - 采用单遍词法扫描 + 递归 AST 节点构建，从根源上杜绝 `\u0000EXP_PH_0_\u0000` / `\u0000PH_0_\u0000` 被斜体 `_..._` 正则腐蚀的 Bug
 * - 严格实现 CommonMark 词内下划线边界规则（snake_case_variable 绝不会误触发斜体）
 * - 支持平衡括号 URL（如 Wikipedia 带括号链接）、4+ 反引号/波浪线围栏代码块、列表内嵌套代码块/引用块、3 空格有序子列表等完整语法
 */

export type InlineAstNode =
  | { type: "text"; value: string }
  | { type: "br" }
  | {
      type: "html_img";
      src: string;
      alt: string;
      width?: string;
      align?: "left" | "center" | "right";
    }
  | { type: "code"; value: string }
  | { type: "math"; tex: string }
  | {
      type: "wikilink";
      target: string;
      heading?: string;
      alias?: string;
      isEmbed?: boolean;
      raw: string;
    }
  | { type: "image"; alt: string; src: string }
  | { type: "link"; children: InlineAstNode[]; href: string; rawLabel: string }
  | { type: "footnote_ref"; label: string }
  | { type: "hashtag"; tag: string }
  | { type: "strong_em"; children: InlineAstNode[] }
  | { type: "strong"; children: InlineAstNode[] }
  | { type: "em"; children: InlineAstNode[] }
  | { type: "strike"; children: InlineAstNode[] }
  | { type: "highlight"; children: InlineAstNode[] }
  | { type: "sub"; children: InlineAstNode[] }
  | { type: "sup"; children: InlineAstNode[] };

export interface ListItemAstNode {
  indent: number;
  ordered: boolean;
  orderNumber?: number;
  isTask: boolean;
  checked?: boolean;
  inlineContent: string;
  extraBlocks: BlockAstNode[];
  sublists: BlockAstNode[];
}

export type BlockAstNode =
  | {
      type: "fenced_code";
      lang: string;
      code: string;
      fenceChar: string;
      fenceLen: number;
    }
  | { type: "math_block"; tex: string }
  | { type: "toc" }
  | {
      type: "transclusion";
      target: string;
      heading?: string;
      alias?: string;
      raw: string;
    }
  | {
      type: "table";
      headers: string[];
      aligns: Array<"left" | "center" | "right">;
      rows: string[][];
    }
  | { type: "hr" }
  | { type: "heading"; level: number; text: string; id: string }
  | { type: "footnote_def"; label: string; content: string }
  | {
      type: "callout";
      calloutType: string;
      title: string;
      children: BlockAstNode[];
    }
  | { type: "blockquote"; children: BlockAstNode[] }
  | {
      type: "list";
      ordered: boolean;
      startNumber?: number;
      items: ListItemAstNode[];
    }
  | { type: "paragraph"; lines: Array<{ text: string; hardBreak: boolean }> };

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function sanitizeSafeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (/^\s*(javascript|vbscript|data\s*:\s*text\/html)/i.test(trimmed)) {
    return "#blocked-unsafe-url";
  }
  return trimmed.replace(/&quot;/g, "").replace(/"/g, "&quot;");
}

export function stripInlineMarkdownText(raw: string): string {
  return raw
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_m, t, a) => a || t)
    .replace(/(\*{1,3}|_{1,3}|~~|==)([^*_~=]+)\1/g, "$2")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * 扫描平衡方括号与圆括号的链接或图片: [label](url) 或 ![alt](url)
 * 支持 URL 内包含平衡圆括号（如 https://en.wikipedia.org/wiki/Markdown_(markup)）
 */
function matchBalancedLinkOrImageAt(
  src: string,
  pos: number
): { isImage: boolean; label: string; url: string; endPos: number } | null {
  const isImage = src[pos] === "!" && src[pos + 1] === "[";
  const openBracket = isImage ? pos + 1 : pos;
  if (src[openBracket] !== "[") return null;

  // 排除 [^footnote] 与 [[wikilink]]
  if (!isImage && (src[openBracket + 1] === "^" || src[openBracket + 1] === "[")) {
    return null;
  }
  if (isImage && src[openBracket + 1] === "[") {
    return null;
  }

  let bracketDepth = 1;
  let i = openBracket + 1;
  while (i < src.length && bracketDepth > 0) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "\n") return null;
    if (src[i] === "[") bracketDepth++;
    else if (src[i] === "]") bracketDepth--;
    i++;
  }
  if (bracketDepth !== 0) return null;
  const closeBracket = i - 1;
  if (src[i] !== "(") return null;

  let parenDepth = 1;
  let j = i + 1;
  while (j < src.length && parenDepth > 0) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === "\n") return null;
    if (src[j] === "(") parenDepth++;
    else if (src[j] === ")") parenDepth--;
    j++;
  }
  if (parenDepth !== 0) return null;
  const closeParen = j - 1;

  const label = src.slice(openBracket + 1, closeBracket);
  let url = src.slice(i + 1, closeParen).trim();
  // 若带有可选 title: (url "title")，提取纯 URL
  const titleMatch = url.match(/^(\S+)\s+["'][^"']*["']$/);
  if (titleMatch) {
    url = titleMatch[1];
  }
  if (url.startsWith("<") && url.endsWith(">")) {
    url = url.slice(1, -1);
  }

  return {
    isImage,
    label,
    url,
    endPos: j,
  };
}

/**
 * 将单行/段落内联 Markdown 文本解析为结构化 InlineAstNode 数组（无任何字符串占位符）
 */
export function parseInlineAST(input: string): InlineAstNode[] {
  if (!input) return [];
  const nodes: InlineAstNode[] = [];
  let textBuf = "";

  const flushText = () => {
    if (textBuf.length > 0) {
      nodes.push({ type: "text", value: textBuf });
      textBuf = "";
    }
  };

  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    // 1. 反斜杠转义序列
    if (ch === "\\" && i + 1 < len && /[\\`*_{}\[\]()#+\-.!|$~^=]/.test(input[i + 1])) {
      textBuf += input[i + 1];
      i += 2;
      continue;
    }

    // 2. HTML <br> 或 <img ...> 标签
    if (ch === "<") {
      const rest = input.slice(i);
      const brMatch = rest.match(/^<br\s*\/?>/i);
      if (brMatch) {
        flushText();
        nodes.push({ type: "br" });
        i += brMatch[0].length;
        continue;
      }

      const imgMatch = rest.match(/^<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)\/?>/i);
      if (imgMatch) {
        flushText();
        const fullAttrs = `${imgMatch[1]} ${imgMatch[3]}`;
        const rawSrc = imgMatch[2];
        const altMatch = fullAttrs.match(/alt=["']([^"']*)["']/i);
        const widthMatch = fullAttrs.match(/width=["']([^"']*)["']/i);
        const alignMatch = fullAttrs.match(/align=["']([^"']*)["']/i);
        const alignVal = alignMatch ? alignMatch[1].toLowerCase() : undefined;
        nodes.push({
          type: "html_img",
          src: rawSrc,
          alt: altMatch ? altMatch[1] : "",
          width: widthMatch ? widthMatch[1] : undefined,
          align:
            alignVal === "center" || alignVal === "right" || alignVal === "left"
              ? alignVal
              : undefined,
        });
        i += imgMatch[0].length;
        continue;
      }
    }

    // 3. 行内代码 `code` 或 ``code``
    if (ch === "`") {
      let tickCount = 0;
      while (i + tickCount < len && input[i + tickCount] === "`") {
        tickCount++;
      }
      const fence = "`".repeat(tickCount);
      const closeIdx = input.indexOf(fence, i + tickCount);
      if (closeIdx !== -1 && !input.slice(i + tickCount, closeIdx).includes("\n")) {
        flushText();
        let codeContent = input.slice(i + tickCount, closeIdx);
        if (
          tickCount > 1 &&
          codeContent.length >= 2 &&
          codeContent.startsWith(" ") &&
          codeContent.endsWith(" ")
        ) {
          codeContent = codeContent.slice(1, -1);
        }
        nodes.push({ type: "code", value: codeContent });
        i = closeIdx + tickCount;
        continue;
      }
      textBuf += fence;
      i += tickCount;
      continue;
    }

    // 4. 行内数学公式 $tex$
    if (ch === "$" && input[i + 1] !== "$") {
      const prevChar = i > 0 ? input[i - 1] : "";
      if (!/\d/.test(prevChar)) {
        let j = i + 1;
        let foundClose = -1;
        while (j < len && input[j] !== "\n") {
          if (input[j] === "\\") {
            j += 2;
            continue;
          }
          if (input[j] === "$") {
            const nextChar = j + 1 < len ? input[j + 1] : "";
            if (!/\d/.test(nextChar)) {
              foundClose = j;
              break;
            }
          }
          j++;
        }
        if (foundClose > i + 1) {
          const innerTex = input.slice(i + 1, foundClose);
          if (!/^\s|\s$/.test(innerTex)) {
            flushText();
            nodes.push({ type: "math", tex: innerTex });
            i = foundClose + 1;
            continue;
          }
        }
      }
    }

    // 5. 双向链接 [[WikiLink]] 或 ![[Embed]]
    if ((ch === "[" && input[i + 1] === "[") || (ch === "!" && input[i + 1] === "[" && input[i + 2] === "[")) {
      const isEmbed = ch === "!";
      const startBr = isEmbed ? i + 2 : i + 1;
      const closeIdx = input.indexOf("]]", startBr + 1);
      if (closeIdx !== -1 && !input.slice(startBr + 1, closeIdx).includes("\n")) {
        const rawSlice = input.slice(i, closeIdx + 2);
        const parsed = parseWikiLinksInLine(rawSlice);
        if (parsed.length === 1) {
          flushText();
          const wl = parsed[0];
          nodes.push({
            type: "wikilink",
            target: wl.target,
            heading: wl.heading,
            alias: wl.alias || undefined,
            isEmbed: wl.isEmbed,
            raw: wl.raw,
          });
          i = closeIdx + 2;
          continue;
        }
      }
    }

    // 6. 脚注引用 [^label]
    if (ch === "[" && input[i + 1] === "^") {
      const closeIdx = input.indexOf("]", i + 2);
      if (
        closeIdx > i + 2 &&
        !input.slice(i + 2, closeIdx).includes("\n") &&
        input[closeIdx + 1] !== ":"
      ) {
        flushText();
        nodes.push({
          type: "footnote_ref",
          label: input.slice(i + 2, closeIdx),
        });
        i = closeIdx + 1;
        continue;
      }
    }

    // 7. Markdown 图片 ![alt](src) 或 超链接 [label](href)
    if (ch === "[" || (ch === "!" && input[i + 1] === "[")) {
      const matched = matchBalancedLinkOrImageAt(input, i);
      if (matched) {
        flushText();
        if (matched.isImage) {
          nodes.push({
            type: "image",
            alt: matched.label,
            src: matched.url,
          });
        } else {
          nodes.push({
            type: "link",
            children: parseInlineAST(matched.label),
            href: matched.url,
            rawLabel: matched.label,
          });
        }
        i = matched.endPos;
        continue;
      }
    }

    // 8. 内联 #标签 (#tag 或 #tag/subtag)
    if (ch === "#") {
      const prevChar = i > 0 ? input[i - 1] : "";
      if (i === 0 || /[\s,，。；;（(]/.test(prevChar)) {
        const tagMatch = input
          .slice(i)
          .match(/^#([\u4e00-\u9fa5a-zA-Z0-9_\-]+(?:\/[\u4e00-\u9fa5a-zA-Z0-9_\-]+)*)/);
        if (tagMatch) {
          const tagBody = tagMatch[1];
          // 排除纯数字 #123 与十六进制颜色码 #ff00aa
          if (!/^\d+$/.test(tagBody) && !/^[0-9a-fA-F]{3,8}$/.test(tagBody)) {
            flushText();
            nodes.push({ type: "hashtag", tag: tagMatch[0] });
            i += tagMatch[0].length;
            continue;
          }
        }
      }
    }

    // 9. 加粗斜体 *** / ___、加粗 ** / __、斜体 * / _
    if (ch === "*" || ch === "_") {
      const prevChar = i > 0 ? input[i - 1] : undefined;
      let runLen = 0;
      while (i + runLen < len && input[i + runLen] === ch) {
        runLen++;
      }

      // CommonMark 规则：下划线 _ 不可在词内触发开启定界符
      const canOpen = ch === "*" || !isWordChar(prevChar);
      if (canOpen && runLen <= 3) {
        for (const delimLen of [3, 2, 1]) {
          if (runLen < delimLen) continue;
          const delim = ch.repeat(delimLen);
          if (i + delimLen >= len || /\s/.test(input[i + delimLen])) continue;

          let searchPos = i + delimLen;
          let closeIdx = -1;
          while (searchPos < len) {
            const candidate = input.indexOf(delim, searchPos);
            if (candidate === -1) break;
            if (input.slice(i + delimLen, candidate).includes("\n")) break;
            // 确保闭合标记前不是反斜杠或空白，且后续没有同字符粘连
            const beforeClose = input[candidate - 1];
            const afterClose = input[candidate + delimLen];
            const exactRunMatch =
              beforeClose !== "\\" &&
              !/\s/.test(beforeClose) &&
              afterClose !== ch &&
              (ch === "*" || !isWordChar(afterClose));
            if (exactRunMatch) {
              closeIdx = candidate;
              break;
            }
            searchPos = candidate + 1;
          }

          if (closeIdx !== -1 && closeIdx > i + delimLen) {
            flushText();
            const inner = input.slice(i + delimLen, closeIdx);
            const children = parseInlineAST(inner);
            if (delimLen === 3) {
              nodes.push({ type: "strong_em", children });
            } else if (delimLen === 2) {
              nodes.push({ type: "strong", children });
            } else {
              nodes.push({ type: "em", children });
            }
            i = closeIdx + delimLen;
            runLen = 0;
            break;
          }
        }
        if (runLen === 0) continue;
      }

      textBuf += ch.repeat(runLen);
      i += runLen;
      continue;
    }

    // 10. 删除线 ~~text~~ 与 下标 ~text~
    if (ch === "~") {
      if (input[i + 1] === "~" && input[i + 2] !== "~") {
        const closeIdx = input.indexOf("~~", i + 2);
        if (closeIdx > i + 2 && !input.slice(i + 2, closeIdx).includes("\n")) {
          flushText();
          nodes.push({
            type: "strike",
            children: parseInlineAST(input.slice(i + 2, closeIdx)),
          });
          i = closeIdx + 2;
          continue;
        }
      } else if (input[i + 1] !== "~" && i + 1 < len && !/\s/.test(input[i + 1])) {
        let searchPos = i + 1;
        let closeIdx = -1;
        while (searchPos < len) {
          const cand = input.indexOf("~", searchPos);
          if (cand === -1 || input.slice(i + 1, cand).includes("\n")) break;
          if (input[cand - 1] !== "\\" && !/\s/.test(input[cand - 1]) && input[cand + 1] !== "~") {
            closeIdx = cand;
            break;
          }
          searchPos = cand + 1;
        }
        if (closeIdx > i + 1) {
          flushText();
          nodes.push({
            type: "sub",
            children: parseInlineAST(input.slice(i + 1, closeIdx)),
          });
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // 11. 高亮 ==text==
    if (ch === "=" && input[i + 1] === "=" && input[i + 2] !== "=") {
      const closeIdx = input.indexOf("==", i + 2);
      if (closeIdx > i + 2 && !input.slice(i + 2, closeIdx).includes("\n")) {
        flushText();
        nodes.push({
          type: "highlight",
          children: parseInlineAST(input.slice(i + 2, closeIdx)),
        });
        i = closeIdx + 2;
        continue;
      }
    }

    // 12. 上标 ^text^
    if (ch === "^" && i + 1 < len && !/\s/.test(input[i + 1])) {
      let searchPos = i + 1;
      let closeIdx = -1;
      while (searchPos < len) {
        const cand = input.indexOf("^", searchPos);
        if (cand === -1 || input.slice(i + 1, cand).includes("\n")) break;
        if (input[cand - 1] !== "\\" && !/\s/.test(input[cand - 1])) {
          closeIdx = cand;
          break;
        }
        searchPos = cand + 1;
      }
      if (closeIdx > i + 1) {
        flushText();
        nodes.push({
          type: "sup",
          children: parseInlineAST(input.slice(i + 1, closeIdx)),
        });
        i = closeIdx + 1;
        continue;
      }
    }

    textBuf += ch;
    i++;
  }

  flushText();
  return nodes;
}

export interface InlineRenderOptions {
  mode: "export" | "table-cell";
  resolveImageSrc?: (rawSrc: string) => Promise<string> | string;
}

/**
 * 同步渲染 InlineAstNode 数组为 HTML（用于表格单元格等同步场景）
 */
export function renderInlineASTSync(
  nodes: InlineAstNode[],
  options: InlineRenderOptions = { mode: "table-cell" }
): string {
  const isTable = options.mode === "table-cell";
  let html = "";

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        html += escapeHtml(node.value);
        break;
      case "br":
        html += isTable ? "<br>" : "<br />";
        break;
      case "html_img": {
        const widthStyle = node.width ? `width:${escapeHtml(node.width)};` : "";
        const wrapStyle =
          node.align === "center"
            ? "text-align:center;"
            : node.align === "right"
            ? "text-align:right;"
            : "text-align:left;";
        html += `<figure class="md-image-card" style="${wrapStyle}"><img src="${escapeHtml(
          node.src
        )}" alt="${escapeHtml(node.alt)}" style="${widthStyle}max-width:100%;" /></figure>`;
        break;
      }
      case "code":
        html += `<code>${escapeHtml(node.value)}</code>`;
        break;
      case "math": {
        const safeAttr = escapeHtml(node.tex);
        try {
          const rendered = katex.renderToString(node.tex, {
            displayMode: false,
            throwOnError: false,
            output: "html",
          });
          if (isTable) {
            html += `<span class="tbl-inline-math" contenteditable="false" data-tex="${safeAttr}">${rendered}</span>`;
          } else {
            html += rendered;
          }
        } catch {
          if (isTable) {
            html += `<span class="tbl-inline-math" contenteditable="false" data-tex="${safeAttr}">$${safeAttr}$</span>`;
          } else {
            html += `<code>$${safeAttr}$</code>`;
          }
        }
        break;
      }
      case "wikilink": {
        const displayLabel = node.alias
          ? node.alias
          : node.heading && node.target
          ? `${node.target} › ${node.heading}`
          : node.heading
          ? `#${node.heading}`
          : node.target;
        html += `<span class="cm-wikilink" data-raw="${escapeHtml(node.raw)}">${escapeHtml(displayLabel)}</span>`;
        break;
      }
      case "image":
        html += `<img alt="${escapeHtml(node.alt)}" src="${escapeHtml(
          node.src
        )}" style="max-width:100%;" />`;
        break;
      case "link": {
        const safeHref = sanitizeSafeUrl(node.href);
        const innerHtml = renderInlineASTSync(node.children, options);
        if (isTable) {
          html += `<a href="${safeHref}" class="cm-link tbl-inline-link" data-href="${safeHref}">${innerHtml}</a>`;
        } else {
          html += `<a href="${safeHref}" target="_blank" rel="noopener">${innerHtml}</a>`;
        }
        break;
      }
      case "footnote_ref": {
        const safeFnId = node.label.replace(/[^\w\-]/g, "_");
        const safeLabel = escapeHtml(node.label);
        html += `<sup class="cm-footnote-ref" id="fn-ref-${safeFnId}"><a href="#fn-def-${safeFnId}">[${safeLabel}]</a></sup>`;
        break;
      }
      case "hashtag":
        html += `<span class="cm-hashtag">${escapeHtml(node.tag)}</span>`;
        break;
      case "strong_em":
        html += `<strong><em>${renderInlineASTSync(node.children, options)}</em></strong>`;
        break;
      case "strong":
        html += `<strong>${renderInlineASTSync(node.children, options)}</strong>`;
        break;
      case "em":
        html += `<em>${renderInlineASTSync(node.children, options)}</em>`;
        break;
      case "strike":
        html += isTable
          ? `<del>${renderInlineASTSync(node.children, options)}</del>`
          : `<s style="text-decoration:line-through;">${renderInlineASTSync(
              node.children,
              options
            )}</s>`;
        break;
      case "highlight":
        html += `<mark>${renderInlineASTSync(node.children, options)}</mark>`;
        break;
      case "sub":
        html += `<sub>${renderInlineASTSync(node.children, options)}</sub>`;
        break;
      case "sup":
        html += `<sup>${renderInlineASTSync(node.children, options)}</sup>`;
        break;
    }
  }

  return html;
}

/**
 * 异步渲染 InlineAstNode 数组为 HTML（支持异步将本地相对图片转换为 Base64 DataURL）
 */
export async function renderInlineASTAsync(
  nodes: InlineAstNode[],
  options: InlineRenderOptions = { mode: "export" }
): Promise<string> {
  const resolveSrc = async (rawSrc: string): Promise<string> => {
    if (!options.resolveImageSrc) return rawSrc;
    return await options.resolveImageSrc(rawSrc);
  };

  let html = "";
  for (const node of nodes) {
    switch (node.type) {
      case "html_img": {
        const resolvedSrc = await resolveSrc(node.src);
        const widthStyle = node.width ? `width:${escapeHtml(node.width)};` : "";
        const wrapStyle =
          node.align === "center"
            ? "text-align:center;"
            : node.align === "right"
            ? "text-align:right;"
            : "text-align:left;";
        html += `<figure class="md-image-card" style="${wrapStyle}"><img src="${escapeHtml(
          resolvedSrc
        )}" alt="${escapeHtml(node.alt)}" style="${widthStyle}max-width:100%;" /></figure>`;
        break;
      }
      case "image": {
        const resolvedSrc = await resolveSrc(node.src);
        html += `<img alt="${escapeHtml(node.alt)}" src="${escapeHtml(
          resolvedSrc
        )}" style="max-width:100%;" />`;
        break;
      }
      case "link": {
        const safeHref = sanitizeSafeUrl(node.href);
        const innerHtml = await renderInlineASTAsync(node.children, options);
        html += `<a href="${safeHref}" target="_blank" rel="noopener">${innerHtml}</a>`;
        break;
      }
      case "strong_em":
        html += `<strong><em>${await renderInlineASTAsync(node.children, options)}</em></strong>`;
        break;
      case "strong":
        html += `<strong>${await renderInlineASTAsync(node.children, options)}</strong>`;
        break;
      case "em":
        html += `<em>${await renderInlineASTAsync(node.children, options)}</em>`;
        break;
      case "strike":
        html += `<s style="text-decoration:line-through;">${await renderInlineASTAsync(
          node.children,
          options
        )}</s>`;
        break;
      case "highlight":
        html += `<mark>${await renderInlineASTAsync(node.children, options)}</mark>`;
        break;
      case "sub":
        html += `<sub>${await renderInlineASTAsync(node.children, options)}</sub>`;
        break;
      case "sup":
        html += `<sup>${await renderInlineASTAsync(node.children, options)}</sup>`;
        break;
      default:
        html += renderInlineASTSync([node], options);
        break;
    }
  }
  return html;
}

export function isTableDelimiterLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) return false;
  let inner = trimmed;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  const cells = inner.split("|");
  return cells.length > 0 && cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c));
}

export function parseTableRowCells(rowStr: string): string[] {
  let t = rowStr.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let buf = "";
  let inCode = false;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && i + 1 < t.length && t[i + 1] === "|") {
      buf += "|";
      i++;
      continue;
    }
    if (t[i] === "`") {
      inCode = !inCode;
      buf += t[i];
      continue;
    }
    if (t[i] === "|" && !inCode) {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += t[i];
  }
  cells.push(buf.trim());
  return cells;
}

export interface DocumentRenderContext {
  fullMarkdown: string;
  showLineNumbers: boolean;
  isDarkTheme: boolean;
  resolveImageSrc?: (rawSrc: string) => Promise<string> | string;
  highlightCodeBlockToHtml: (rawCode: string, lang: string, showLineNumbers: boolean) => string;
  fetchTransclusionContent?: (
    target: string,
    heading?: string,
    fullDoc?: string
  ) => Promise<{ found: boolean; content: string }>;
}

const CALLOUT_LABELS: Record<string, string> = {
  note: "笔记 (Note)",
  tip: "提示 (Tip)",
  important: "重要 (Important)",
  warning: "警告 (Warning)",
  caution: "危险 (Caution)",
};

/**
 * 将完整 Markdown 文档解析并渲染为导出级 HTML Body（支持嵌套列表内代码块/引用、代码块精致卡片顶栏等）
 */
export async function renderMarkdownDocumentToHtml(
  markdown: string,
  ctx: DocumentRenderContext
): Promise<string> {
  const rawLines = markdown.split("\n");
  let startIdx = 0;

  // 1. 剥离顶部 YAML Front Matter
  if (rawLines.length >= 3 && rawLines[0].trim() === "---") {
    for (let i = 1; i < Math.min(rawLines.length, 60); i++) {
      if (rawLines[i].trim() === "---" || rawLines[i].trim() === "...") {
        startIdx = i + 1;
        break;
      }
    }
  }

  // 2. 预收集全文标题供 [TOC] 渲染（精确支持 3+ 反引号与波浪线围栏）
  const allDocHeadings: Array<{ level: number; text: string; id: string }> = [];
  {
    let inF = false;
    let fChar = "";
    let fLen = 0;
    for (let k = startIdx; k < rawLines.length; k++) {
      const t = rawLines[k].replace(/^\s*(?:>\s*)*/, "").trim();
      const fm = t.match(/^(`{3,}|~{3,})/);
      if (fm) {
        const mChar = fm[1][0];
        const mLen = fm[1].length;
        if (!inF) {
          inF = true;
          fChar = mChar;
          fLen = mLen;
        } else if (mChar === fChar && mLen >= fLen && /^(`{3,}|~{3,})\s*$/.test(t)) {
          inF = false;
        }
        continue;
      }
      if (inF) continue;
      const hm = rawLines[k].match(/^\s*(?:>\s*)*(#{1,6})\s+(.*)$/);
      if (hm) {
        const clean = stripInlineMarkdownText(hm[2].replace(/\s+#+\s*$/, ""));
        const id = `heading-${k}-${clean.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}`;
        allDocHeadings.push({ level: hm[1].length, text: clean, id });
      }
    }
  }

  let headingCursor = 0;

  try {
    mermaid.initialize({
      startOnLoad: false,
      theme: ctx.isDarkTheme ? "dark" : "default",
      securityLevel: "loose",
    });
  } catch {
    // 非浏览器环境（如 Node 测试运行器）安全忽略
  }

  const renderInline = async (raw: string): Promise<string> => {
    const ast = parseInlineAST(raw);
    return renderInlineASTAsync(ast, {
      mode: "export",
      resolveImageSrc: ctx.resolveImageSrc,
    });
  };

  const isBlockBoundary = (lines: string[], idx: number): boolean => {
    if (idx >= lines.length) return true;
    const line = lines[idx];
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^(`{3,}|~{3,})/.test(trimmed)) return true;
    if (trimmed === "$$" || /^\$\$\s*(.+?)\s*\$\$$/.test(trimmed)) return true;
    if (/^\[TOC\]$/i.test(trimmed)) return true;
    if (/^!\[\[([^\[\]\n]+)\]\]$/.test(trimmed)) return true;
    if (trimmed.includes("|") && idx + 1 < lines.length && isTableDelimiterLine(lines[idx + 1])) {
      return true;
    }
    if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return true;
    if (/^(#{1,6})\s+/.test(line)) return true;
    if (trimmed.startsWith(">")) return true;
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) return true;
    if (/^\[\^([^\]\n]+)\]:\s*/.test(line)) return true;
    return false;
  };

  const renderCodeCardHtml = (rawCode: string, lang: string): string => {
    const highlightedHtml = ctx.highlightCodeBlockToHtml(
      rawCode,
      lang,
      ctx.showLineNumbers
    );
    const lineCount = rawCode.length === 0 ? 1 : rawCode.split("\n").length;
    const langDisplay = (lang || "text").toUpperCase();
    const lineLabel = `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
    return `<div class="exported-code-card"><div class="exported-code-header"><span class="exported-code-dots"><i class="dot-red"></i><i class="dot-amber"></i><i class="dot-green"></i></span><span class="exported-code-lang">${escapeHtml(
      langDisplay
    )}</span><span class="exported-code-meta">${lineLabel}</span></div><pre class="exported-code-block"><code class="language-${escapeHtml(
      lang || "text"
    )}">${highlightedHtml}</code></pre></div>`;
  };

  const renderBlocks = async (lines: string[]): Promise<string> => {
    const out: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      // 1. 块级嵌入引用 ![[文档#标题]]
      const embedMatch = trimmed.match(/^!\[\[([^\[\]\n]+)\]\]$/);
      if (embedMatch && ctx.fetchTransclusionContent) {
        const parsedLinks = parseWikiLinksInLine(trimmed);
        if (parsedLinks.length === 1 && parsedLinks[0].isEmbed) {
          const wl = parsedLinks[0];
          const res = await ctx.fetchTransclusionContent(
            wl.target,
            wl.heading,
            ctx.fullMarkdown
          );
          const titleLabel = wl.alias
            ? wl.alias
            : wl.target && wl.heading
            ? `${wl.target} › #${wl.heading}`
            : wl.heading
            ? `本篇 › #${wl.heading}`
            : wl.target;
          out.push(
            `<blockquote><strong>🔗 嵌入引用 · ${escapeHtml(
              titleLabel
            )}</strong><pre style="white-space:pre-wrap;margin-top:6px;">${escapeHtml(
              res.content
            )}</pre></blockquote>`
          );
          i++;
          continue;
        }
      }

      // 2. 围栏代码块与 Mermaid 图表（支持 3+ 反引号或波浪线嵌套）
      const fenceMatch = trimmed.match(/^(`{3,}|~{3,})\s*([^\s`~]*).*$/);
      if (fenceMatch) {
        const fenceChar = fenceMatch[1][0];
        const fenceLen = fenceMatch[1].length;
        const lang = (fenceMatch[2] || "").toLowerCase();
        const codeLines: string[] = [];
        i++;
        while (i < lines.length) {
          const t = lines[i].trim();
          const closeM = t.match(/^(`{3,}|~{3,})\s*$/);
          if (closeM && closeM[1][0] === fenceChar && closeM[1].length >= fenceLen) {
            i++;
            break;
          }
          codeLines.push(lines[i]);
          i++;
        }
        const rawCode = codeLines.join("\n");
        if (lang === "mermaid") {
          try {
            const id = "mmd-exp-" + Math.random().toString(36).substring(2, 9);
            const { svg } = await mermaid.render(id, rawCode.trim());
            out.push(
              `<figure class="md-mermaid-card"><div class="mermaid-chart-box">${svg}</div></figure>`
            );
          } catch {
            out.push(renderCodeCardHtml(rawCode, "mermaid"));
          }
        } else {
          out.push(renderCodeCardHtml(rawCode, lang));
        }
        continue;
      }

      // 3. 多行公式块 $$
      if (trimmed === "$$") {
        const mathLines: string[] = [];
        i++;
        while (i < lines.length && lines[i].trim() !== "$$") {
          mathLines.push(lines[i]);
          i++;
        }
        i++;
        try {
          const rendered = katex.renderToString(mathLines.join("\n"), {
            displayMode: true,
            throwOnError: false,
            output: "html",
          });
          out.push(`<div class="md-math-block-preview">${rendered}</div>`);
        } catch {
          out.push(`<pre>${escapeHtml(mathLines.join("\n"))}</pre>`);
        }
        continue;
      }

      // 4. 单行公式块 $$ ... $$
      const singleMath = trimmed.match(/^\$\$\s*(.+?)\s*\$\$$/);
      if (singleMath) {
        try {
          const rendered = katex.renderToString(singleMath[1], {
            displayMode: true,
            throwOnError: false,
            output: "html",
          });
          out.push(`<div class="md-math-block-preview">${rendered}</div>`);
        } catch {
          out.push(`<pre>${escapeHtml(singleMath[1])}</pre>`);
        }
        i++;
        continue;
      }

      // 5. [TOC] 目录块
      if (/^\[TOC\]$/i.test(trimmed)) {
        const tocItems = allDocHeadings
          .map(
            (h) =>
              `<li style="padding-left:${(h.level - 1) * 16}px"><a href="#${h.id}">${escapeHtml(
                h.text
              )}</a></li>`
          )
          .join("");
        out.push(
          `<nav class="cm-toc-card"><div class="cm-toc-title">目录</div><ul class="cm-toc-list">${tocItems}</ul></nav>`
        );
        i++;
        continue;
      }

      // 6. GFM 表格块
      if (trimmed.includes("|") && i + 1 < lines.length && isTableDelimiterLine(lines[i + 1])) {
        const headers = parseTableRowCells(lines[i]);
        const delimParts = parseTableRowCells(lines[i + 1]);
        const aligns = headers.map((_h, idx) => {
          const d = delimParts[idx] || "";
          if (d.startsWith(":") && d.endsWith(":")) return "center";
          if (d.endsWith(":")) return "right";
          return "left";
        });
        i += 2;
        const bodyRows: string[][] = [];
        while (i < lines.length && lines[i].trim().includes("|")) {
          bodyRows.push(parseTableRowCells(lines[i]));
          i++;
        }
        const thRendered = await Promise.all(
          headers.map(
            async (h, idx) =>
              `<th style="text-align:${aligns[idx]}">${await renderInline(h)}</th>`
          )
        );
        const tbodyRowsRendered: string[] = [];
        for (const r of bodyRows) {
          const tds = await Promise.all(
            headers.map(
              async (_h, idx) =>
                `<td style="text-align:${aligns[idx]}">${await renderInline(r[idx] || "")}</td>`
            )
          );
          tbodyRowsRendered.push(`<tr>${tds.join("")}</tr>`);
        }
        out.push(
          `<table class="md-table"><thead><tr>${thRendered.join("")}</tr></thead><tbody>${tbodyRowsRendered.join("")}</tbody></table>`
        );
        continue;
      }

      // 7. 水平分割线
      if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        out.push("<hr />");
        i++;
        continue;
      }

      // 8. ATX 标题
      const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (hMatch) {
        const lvl = hMatch[1].length;
        const hMeta = allDocHeadings[headingCursor++];
        const idAttr = hMeta ? ` id="${hMeta.id}"` : "";
        const cleanHeading = hMatch[2].trim().replace(/\s+#+\s*$/, "");
        out.push(`<h${lvl}${idAttr}>${await renderInline(cleanHeading)}</h${lvl}>`);
        i++;
        continue;
      }

      // 9. 脚注定义行 ([^label]: content)
      const fnDefMatch = line.match(/^\[\^([^\]\n]+)\]:\s*(.*)$/);
      if (fnDefMatch) {
        const fnLabel = escapeHtml(fnDefMatch[1]);
        const safeFnId = fnLabel.replace(/[^\w\-]/g, "_");
        const fnBody = await renderInline(fnDefMatch[2]);
        out.push(
          `<div class="cm-footnote-def" id="fn-def-${safeFnId}"><strong>[${fnLabel}]:</strong> ${fnBody} <a href="#fn-ref-${safeFnId}" class="fn-backref" title="返回正文引用处">↩</a></div>`
        );
        i++;
        continue;
      }

      // 10. 引用块 & GitHub Callout 卡片
      if (trimmed.startsWith(">")) {
        const innerQuoteLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          innerQuoteLines.push(lines[i].replace(/^\s*> ?/, ""));
          i++;
        }
        const calloutMatch = innerQuoteLines[0]?.match(
          /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i
        );
        if (calloutMatch) {
          const cType = calloutMatch[1].toLowerCase();
          const customTitle =
            calloutMatch[2].trim() || CALLOUT_LABELS[cType] || cType.toUpperCase();
          const bodyHtml = await renderBlocks(innerQuoteLines.slice(1));
          out.push(
            `<div class="cm-callout-export cm-callout-${cType}"><div class="cm-callout-header-widget cm-callout-header-${cType}"><span class="cm-callout-title">${escapeHtml(
              customTitle
            )}</span></div><div class="cm-callout-body">${bodyHtml}</div></div>`
          );
        } else {
          const innerHtml = await renderBlocks(innerQuoteLines);
          out.push(`<blockquote>${innerHtml}</blockquote>`);
        }
        continue;
      }

      // 11. 多级无序/有序/任务列表（支持 2/3/4 空格子列表及列表项内嵌套代码块/引用块）
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        interface ParsedListEntry {
          indent: number;
          ordered: boolean;
          isTask: boolean;
          bodyHtml: string;
          nestedBlocksLines: string[];
        }
        const listEntries: ParsedListEntry[] = [];

        while (i < lines.length) {
          const cur = lines[i];
          if (!/^\s*([-*+]|\d+\.)\s+/.test(cur)) break;

          const indent = (cur.match(/^\s*/)?.[0] || "").replace(/\t/g, "  ").length;
          const taskM = cur.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/);
          const ordM = cur.match(/^\s*\d+\.\s+(.*)$/);
          let entry: ParsedListEntry;
          if (taskM) {
            const checked = taskM[1].toLowerCase() === "x" ? " checked disabled" : " disabled";
            entry = {
              indent,
              ordered: false,
              isTask: true,
              bodyHtml: `<input type="checkbox"${checked} /> ${await renderInline(taskM[2])}`,
              nestedBlocksLines: [],
            };
          } else if (ordM) {
            entry = {
              indent,
              ordered: true,
              isTask: false,
              bodyHtml: await renderInline(ordM[1]),
              nestedBlocksLines: [],
            };
          } else {
            const itemTxt = cur.replace(/^\s*[-*+]\s+/, "");
            entry = {
              indent,
              ordered: false,
              isTask: false,
              bodyHtml: await renderInline(itemTxt),
              nestedBlocksLines: [],
            };
          }
          i++;

          // 收集缩进从属于当前列表项的嵌套代码块或引用块
          while (i < lines.length) {
            const nextLine = lines[i];
            const nextTrim = nextLine.trim();
            if (!nextTrim) {
              // 若空行后紧跟缩进块则保留，否则结束列表或进入下一列表项
              if (
                i + 1 < lines.length &&
                /^\s+(`{3,}|~{3,}|>|\$\$)/.test(lines[i + 1]) &&
                !/^\s*([-*+]|\d+\.)\s+/.test(lines[i + 1])
              ) {
                entry.nestedBlocksLines.push("");
                i++;
                continue;
              }
              break;
            }
            if (/^\s*([-*+]|\d+\.)\s+/.test(nextLine)) {
              break;
            }
            const nextIndent = (nextLine.match(/^\s*/)?.[0] || "").replace(/\t/g, "  ").length;
            if (nextIndent > indent) {
              const stripIndent = Math.min(nextIndent, indent + 2);
              const unindented = nextLine.replace(/\t/g, "  ").slice(stripIndent);
              entry.nestedBlocksLines.push(unindented);
              // 若为围栏代码块，持续收集直到闭合围栏
              const subFence = unindented.trim().match(/^(`{3,}|~{3,})/);
              if (subFence) {
                const sfChar = subFence[1][0];
                const sfLen = subFence[1].length;
                i++;
                while (i < lines.length) {
                  const subCur = lines[i].replace(/\t/g, "  ");
                  const subUnindented = subCur.slice(Math.min(subCur.match(/^\s*/)?.[0].length || 0, stripIndent));
                  entry.nestedBlocksLines.push(subUnindented);
                  const closeSub = subUnindented.trim().match(/^(`{3,}|~{3,})\s*$/);
                  i++;
                  if (closeSub && closeSub[1][0] === sfChar && closeSub[1].length >= sfLen) {
                    break;
                  }
                }
                continue;
              }
              i++;
            } else {
              break;
            }
          }

          listEntries.push(entry);
        }

        const buildNestedListHtml = async (
          startIdxInList: number,
          minIndent: number
        ): Promise<{ html: string; nextIdx: number }> => {
          if (startIdxInList >= listEntries.length) {
            return { html: "", nextIdx: startIdxInList };
          }
          const firstItem = listEntries[startIdxInList];
          const listTag = firstItem.ordered ? "ol" : "ul";
          let html = `<${listTag}>`;
          let k = startIdxInList;

          while (k < listEntries.length) {
            const item = listEntries[k];
            if (item.indent < minIndent) break;

            const itemTag = item.ordered ? "ol" : "ul";
            if (item.indent === minIndent && itemTag !== listTag) {
              break;
            }

            const liClass = item.isTask ? ` class="task-list-item"` : "";
            let extraHtml = "";
            if (item.nestedBlocksLines.length > 0) {
              extraHtml = "\n" + (await renderBlocks(item.nestedBlocksLines));
            }
            html += `<li${liClass}>${item.bodyHtml}${extraHtml}`;
            k++;

            while (k < listEntries.length && listEntries[k].indent > item.indent) {
              const sub = await buildNestedListHtml(k, listEntries[k].indent);
              html += sub.html;
              k = sub.nextIdx;
            }
            html += `</li>`;
          }

          html += `</${listTag}>`;
          return { html, nextIdx: k };
        };

        let listCursor = 0;
        while (listCursor < listEntries.length) {
          const built = await buildNestedListHtml(listCursor, listEntries[listCursor].indent);
          out.push(built.html);
          listCursor = built.nextIdx;
        }
        continue;
      }

      // 12. 普通段落
      const paraParts: string[] = [];
      while (i < lines.length && !isBlockBoundary(lines, i)) {
        const rawLine = lines[i];
        const hasHardBreak = /\s{2,}$/.test(rawLine);
        const renderedLine = await renderInline(rawLine.trim());
        paraParts.push(hasHardBreak ? `${renderedLine}<br />` : renderedLine);
        i++;
      }
      if (paraParts.length > 0) {
        out.push(`<p>${paraParts.join("\n")}</p>`);
      } else {
        out.push(`<p>${await renderInline(line)}</p>`);
        i++;
      }
    }

    return out.join("\n");
  };

  return renderBlocks(rawLines.slice(startIdx));
}
