import { EditorView } from "@codemirror/view";
import { setSearchHighlightEffect } from "./search-highlighter";

/**
 * 规范化文本，用于标题与目录锚点的智能宽容度模糊比对
 */
export function normalizeAnchor(str: string): string {
  try {
    str = decodeURIComponent(str);
  } catch (_) {}
  return str
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[^\p{L}\p{N}]/gu, ""); // 支持全语言文字与数字，彻底忽略标点、空格、特殊符号与短横线
}

/**
 * 在文档中定位目标锚点标题并平滑跳转置顶（自动忽略代码块内部注释）
 */
export function navigateToAnchor(view: EditorView, rawAnchor: string): boolean {
  if (!rawAnchor) return false;
  const targetClean = normalizeAnchor(rawAnchor);
  if (!targetClean) return false;

  const doc = view.state.doc;
  let targetLinePos: number | null = null;
  let targetLineEnd: number | null = null;

  // 1. 第一优先级：精确比对 Markdown 标题行 (# Header)，跳过代码块
  let inFence = false;
  let fenceChar = "";
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const trimmed = line.text.trim();
    if (/^(```+|~~~+)/.test(trimmed)) {
      const marker = trimmed.startsWith("`") ? "`" : "~";
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const m = line.text.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const headingClean = normalizeAnchor(m[2]);
      if (
        headingClean === targetClean ||
        headingClean.endsWith(targetClean) ||
        targetClean.endsWith(headingClean) ||
        headingClean.includes(targetClean) ||
        targetClean.includes(headingClean)
      ) {
        targetLinePos = line.from;
        targetLineEnd = line.to;
        break;
      }
    }
  }

  // 2. 第二优先级：若未匹配到标准标题，检索全文档任意出现该关键词的行
  if (targetLinePos === null) {
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const textClean = normalizeAnchor(line.text);
      if (textClean.length >= 3 && (textClean.includes(targetClean) || targetClean.includes(textClean))) {
        targetLinePos = line.from;
        targetLineEnd = line.to;
        break;
      }
    }
  }

  if (targetLinePos !== null) {
    // 视口置顶（预留 40px 优雅呼吸留白）并播放平滑金色高亮脉冲
    view.dispatch({
      selection: { anchor: targetLinePos },
      effects: [
        EditorView.scrollIntoView(targetLinePos, { y: "start", yMargin: 40 }),
        setSearchHighlightEffect.of({
          from: targetLinePos,
          to: targetLineEnd ?? targetLinePos,
        }),
      ],
    });
    view.focus();

    // 1.8 秒后淡出高亮
    setTimeout(() => {
      view.dispatch({
        effects: [setSearchHighlightEffect.of(null)],
      });
    }, 1800);

    return true;
  }

  return false;
}
