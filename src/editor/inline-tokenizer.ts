import { parseBalancedLinksAndImages } from "./extensions/doc-structure";
import { parseWikiLinksInLine, WikiLinkMatch } from "./extensions/wiki-link";

/**
 * Quilla v0.10.0 统一内联词法解析器与边界守卫 (Unified Inline Tokenizer & Boundary Guard)
 * - 供编辑器实时预览 (`live-preview.ts`) 与统一 AST 导出/表格渲染器 (`markdown-ast-renderer.ts`) 共同调用
 * - 根治中文数字区间连接符（如 `1~2周...3~6个月`、`10%~20%`）被误判为 `<sub>` 下标的顽疾 (Bug #5)
 * - 根治同行多个数学幂号（如 `2^10 与 2^20`）或行尾块引用锚点 (`^block-id`) 被误判为 `<sup>` 上标的同源隐患
 * - 引入跨 Token 边界交叉保护（禁止内联标记半交叉跨越代码、公式、超链接或双链边界）
 */

export type UnifiedInlineTokenType =
  | "task"
  | "bullet"
  | "ordered_marker"
  | "code"
  | "math"
  | "wiki_link"
  | "transclusion"
  | "image"
  | "footnote_ref"
  | "hashtag"
  | "link"
  | "bold_italic"
  | "bold"
  | "italic"
  | "strikethrough"
  | "highlight"
  | "subscript"
  | "superscript";

export interface UnifiedInlineToken {
  type: UnifiedInlineTokenType;
  start: number;
  end: number;
  content: string;
  isOpaque?: boolean;
  data?: any;
}

const SUB_SUP_FORBIDDEN_PUNCT_RE = /[，。！？；：、（）()【】《》“”‘’"'!?;:\s\n<>`$|\\]/;
const MAX_SUB_SUP_LEN = 20;

/**
 * 判断指定位置的单波浪号 `~` 是否属于数值/单位区间连接符（如 `1~2`、`3~6`、`10%~20%`、`2024~2026`）
 */
export function isNumericRangeTildeAt(text: string, idx: number): boolean {
  if (text[idx] !== "~") return false;
  if (idx > 0 && text[idx - 1] === "~") return false;
  if (idx + 1 < text.length && text[idx + 1] === "~") return false;

  const prev = idx > 0 ? text[idx - 1] : "";
  const next = idx + 1 < text.length ? text[idx + 1] : "";

  // 左侧为数字或常见数值后缀（%、‰、°、℃、年/月/日/周/天/时/分/秒），右侧为数字或正负号
  const isLeftNumericOrUnit = /[0-9%‰°℃年月日周天时分秒岁元]/.test(prev);
  const isRightNumeric = /[0-9+\-]/.test(next);
  return isLeftNumericOrUnit && isRightNumeric;
}

/**
 * 判断指定位置的 `^` 是否属于行尾块级引用锚点 ` ^block-id` 的起点
 */
export function isTrailingBlockAnchorCaretAt(text: string, idx: number): boolean {
  if (text[idx] !== "^") return false;
  const prev = idx > 0 ? text[idx - 1] : "";
  if (idx > 0 && !/\s/.test(prev)) return false;
  const rest = text.slice(idx + 1).trimEnd();
  return /^[a-zA-Z0-9_\-]+$/.test(rest);
}

/**
 * 严格校验 `~...~` 下标与 `^...^` 上标配对是否合法：
 * 1. 排除数值区间连接符 `1~2`、`3~6`、`10%~20%`
 * 2. 排除行尾 `^block-id` 块级锚点及闭合 `^` 后紧跟数字（如 `2^10与2^20`）
 * 3. 限制最大长度 <= 20 字符，且禁止跨越空白、中英文句读标点及括号
 */
export function isValidSubOrSupPair(
  text: string,
  openIdx: number,
  closeIdx: number,
  marker: "~" | "^"
): boolean {
  if (closeIdx <= openIdx + 1) return false;
  const inner = text.slice(openIdx + 1, closeIdx);
  if (!inner || inner.length > MAX_SUB_SUP_LEN) return false;
  if (SUB_SUP_FORBIDDEN_PUNCT_RE.test(inner)) return false;

  const prevBeforeOpen = openIdx > 0 ? text[openIdx - 1] : "";
  const nextAfterClose = closeIdx + 1 < text.length ? text[closeIdx + 1] : "";

  // 闭合标记前不得为转义反斜杠，且不得紧邻同类标记
  if (text[closeIdx - 1] === "\\" || text[closeIdx - 1] === marker) return false;
  if (nextAfterClose === marker) return false;

  if (marker === "~") {
    // 若开或闭波浪号本身是数值区间连接符（如 1~2 或 3~6），直接判定为非下标
    if (isNumericRangeTildeAt(text, openIdx) || isNumericRangeTildeAt(text, closeIdx)) {
      return false;
    }
    // 闭合下标后绝不会紧跟阿拉伯数字（例如 ~x~2 实为未配对区间）
    if (/[0-9]/.test(nextAfterClose)) {
      return false;
    }
    // 若开启波浪号前直接是阿拉伯数字（如 1~a~），在自然文本中几乎均为区间书写而非下标
    if (/[0-9]/.test(prevBeforeOpen)) {
      return false;
    }
  } else if (marker === "^") {
    // 排除行尾 ^block-id 锚点
    if (isTrailingBlockAnchorCaretAt(text, openIdx) || isTrailingBlockAnchorCaretAt(text, closeIdx)) {
      return false;
    }
    // 闭合上标 ^ 后若紧跟数字（如 2^10与2^20 中的第二个 ^ 后紧跟 20），说明第二个 ^ 是另一处幂运算的起点而非闭合上标
    if (/[0-9]/.test(nextAfterClose)) {
      return false;
    }
    // 若上下标内容包含中文字符且开启符前是数字（如 2^10与2^20），直接拒绝
    if (/[0-9]/.test(prevBeforeOpen) && /[\u4e00-\u9fa5]/.test(inner)) {
      return false;
    }
  }

  return true;
}

/**
 * 在给定行文本中从 openIdx 起寻找合法的配对 `~`（下标）或 `^`（上标）闭合位置
 */
export function findValidSubOrSupClose(
  text: string,
  openIdx: number,
  marker: "~" | "^"
): number {
  const len = text.length;
  if (openIdx + 1 >= len) return -1;
  if (text[openIdx] !== marker || text[openIdx + 1] === marker) return -1;
  if (/\s/.test(text[openIdx + 1])) return -1;

  if (marker === "~" && isNumericRangeTildeAt(text, openIdx)) {
    return -1;
  }
  if (marker === "^" && isTrailingBlockAnchorCaretAt(text, openIdx)) {
    return -1;
  }

  const maxSearchEnd = Math.min(len, openIdx + 1 + MAX_SUB_SUP_LEN + 1);
  let searchPos = openIdx + 1;
  while (searchPos < maxSearchEnd) {
    const cand = text.indexOf(marker, searchPos);
    if (cand === -1 || cand >= maxSearchEnd) break;
    // 若中间遇到换行或句读标点，提前终止无需继续向后扫描
    const sliceBetween = text.slice(openIdx + 1, cand);
    if (SUB_SUP_FORBIDDEN_PUNCT_RE.test(sliceBetween)) {
      break;
    }
    if (isValidSubOrSupPair(text, openIdx, cand, marker)) {
      return cand;
    }
    searchPos = cand + 1;
  }
  return -1;
}

/**
 * 提取单行内的列表前缀标记与所有经过边界守卫校验的富文本内联 Token
 */
export function extractLineInlineTokens(
  text: string,
  initialPrefixEnd: number
): { prefixEnd: number; tokens: UnifiedInlineToken[] } {
  let prefixEnd = initialPrefixEnd;
  const restText = text.slice(prefixEnd);
  const tokens: UnifiedInlineToken[] = [];

  // 1. 列表标记识别：任务列表 (- [ ] / - [x])、无序列表 (- / * / +)、有序列表 (1. )
  const taskMatch = restText.match(/^(\s*)([-*+])\s+\[([ xX])\]\s+/);
  const listMatch = !taskMatch ? restText.match(/^(\s*)([-*+]|\d+\.)\s+/) : null;

  if (taskMatch) {
    const indentSpaces = taskMatch[1].length;
    const isChecked = taskMatch[3].toLowerCase() === "x";
    const bracketOffset = taskMatch[0].indexOf("[");
    const checkPos = prefixEnd + bracketOffset + 1;
    const replaceStart = prefixEnd + indentSpaces;
    const replaceEnd = prefixEnd + taskMatch[0].length;
    const level =
      indentSpaces === 0
        ? 1
        : Math.min(4, Math.max(2, Math.round(indentSpaces / 2.5) + 1));

    tokens.push({
      type: "task",
      start: replaceStart,
      end: replaceEnd,
      content: taskMatch[0].slice(indentSpaces),
      isOpaque: true,
      data: { isChecked, checkPos, indentSpaces, level },
    });
    prefixEnd = replaceEnd;
  } else if (listMatch) {
    const indentSpaces = listMatch[1].length;
    const marker = listMatch[2];
    const level =
      indentSpaces === 0
        ? 1
        : Math.min(4, Math.max(2, Math.round(indentSpaces / 2.5) + 1));
    if (/^[-*+]$/.test(marker)) {
      const markerStart = prefixEnd + indentSpaces;
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

  // 2. 第一梯队：收集不可嵌套的原子 Token（行内代码、数学公式、双链/嵌入、图片、脚注引用、#标签）
  let m: RegExpExecArray | null;

  // 支持单反引号与多反引号行内代码 `` `code` ``
  const codeRegex = /(`+)([^`\n]+?)\1/g;
  while ((m = codeRegex.exec(text)) !== null) {
    if (m.index < prefixEnd) continue;
    tokens.push({
      type: "code",
      start: m.index,
      end: m.index + m[0].length,
      content: m[2],
      isOpaque: true,
      data: { tickLen: m[1].length },
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

  const wikiLinks: WikiLinkMatch[] = parseWikiLinksInLine(text, prefixEnd);
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
    if (/^\d+$/.test(tagBody) || /^[0-9a-fA-F]{3,8}$/.test(tagBody)) continue;
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
  const acceptedTokens: UnifiedInlineToken[] = [];
  let opaqueLimit = 0;
  for (const tok of tokens) {
    if (tok.start >= opaqueLimit) {
      acceptedTokens.push(tok);
      opaqueSpans.push({ start: tok.start, end: tok.end });
      opaqueLimit = tok.end;
    }
  }

  const overlapsOpaque = (s: number, e: number): boolean =>
    opaqueSpans.some((sp) => s < sp.end && e > sp.start);

  const delimiterIntervals: Array<{ start: number; end: number }> = opaqueSpans.map((sp) => ({
    start: sp.start,
    end: sp.end,
  }));
  const placedTokenSpans: Array<{ start: number; end: number }> = [];

  const canPlaceDelimiters = (
    d1Start: number,
    d1End: number,
    d2Start: number,
    d2End: number,
    forbidContainingOpaque: boolean = false
  ) => {
    const collidesDelimiter = delimiterIntervals.some(
      (iv) =>
        (d1Start < iv.end && d1End > iv.start) || (d2Start < iv.end && d2End > iv.start)
    );
    if (collidesDelimiter) return false;

    if (forbidContainingOpaque && overlapsOpaque(d1Start, d2End)) {
      return false;
    }

    // 防止两个外层/内层富文本区间发生部分交叉（如 **a ~b** c~）
    const hasPartialCross = placedTokenSpans.some(
      (sp) =>
        (d1Start < sp.start && d2End > sp.start && d2End < sp.end) ||
        (d1Start > sp.start && d1Start < sp.end && d2End > sp.end)
    );
    if (hasPartialCross) return false;

    delimiterIntervals.push({ start: d1Start, end: d1End }, { start: d2Start, end: d2End });
    placedTokenSpans.push({ start: d1Start, end: d2End });
    return true;
  };

  // 3. 第二梯队：平衡括号超链接与可组合富文本格式 Token
  for (const bm of balancedMatches) {
    if (bm.isImage) continue;
    const s = bm.start;
    const e = bm.end;
    if (overlapsOpaque(s, e)) continue;
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
    /(?<!\*)\*([^*\s\n][^*\n]*?)\*(?!\*)|(?<![_\p{L}\p{N}])_([^_\s\n][^_\n]*?)_(?![_\p{L}\p{N}])/gu;
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

  const strikeRegex = /~~([^~\n]+?)~~/g;
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

  const highlightRegex = /==([^=\n]+?)==/g;
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

  // 下标 ~sub~（配备三层词法守卫，彻底免疫 1~2周...3~6个月 区间连接符）
  for (let i = prefixEnd; i < text.length; i++) {
    if (text[i] === "~" && text[i + 1] !== "~" && (i === 0 || text[i - 1] !== "~")) {
      const closeIdx = findValidSubOrSupClose(text, i, "~");
      if (closeIdx !== -1) {
        const s = i;
        const e = closeIdx + 1;
        if (canPlaceDelimiters(s, s + 1, e - 1, e, true)) {
          acceptedTokens.push({
            type: "subscript",
            start: s,
            end: e,
            content: text.slice(s + 1, closeIdx),
          });
          i = closeIdx;
        }
      }
    }
  }

  // 上标 ^sup^（配备三层词法守卫，彻底免疫 2^10 与 2^20 及行尾 ^block-id）
  for (let i = prefixEnd; i < text.length; i++) {
    if (text[i] === "^" && (i === 0 || text[i - 1] !== "\\")) {
      const closeIdx = findValidSubOrSupClose(text, i, "^");
      if (closeIdx !== -1) {
        const s = i;
        const e = closeIdx + 1;
        if (canPlaceDelimiters(s, s + 1, e - 1, e, true)) {
          acceptedTokens.push({
            type: "superscript",
            start: s,
            end: e,
            content: text.slice(s + 1, closeIdx),
          });
          i = closeIdx;
        }
      }
    }
  }

  return { prefixEnd, tokens: acceptedTokens };
}
