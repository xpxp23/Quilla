import { EditorView } from "@codemirror/view";
import { setSearchHighlightEffect } from "./search-highlighter";
import { getDocStructureFromState } from "./doc-structure";

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
 * 在文档中定位目标锚点标题或 `^block-id` 块引用并平滑跳转置顶（自动忽略代码块内部注释）
 */
export function navigateToAnchor(view: EditorView, rawAnchor: string): boolean {
  if (!rawAnchor) return false;
  let cleanedInput = rawAnchor.trim().replace(/^#+/, "");

  // 0. 支持 `^block-id` 块级引用精准定位（兼容 `^block-id (预览)` 格式）
  if (cleanedInput.startsWith("^")) {
    const blockId = cleanedInput
      .slice(1)
      .split(/[\s(]/)[0]
      .trim()
      .toLowerCase();
    if (blockId) {
      const struct = getDocStructureFromState(view.state);
      const hitBlock = struct.blockAnchors.find((b) => b.id.toLowerCase() === blockId);
      if (hitBlock) {
        const line = view.state.doc.line(hitBlock.line);
        view.dispatch({
          selection: { anchor: line.from },
          effects: [
            EditorView.scrollIntoView(line.from, { y: "start", yMargin: 48 }),
            setSearchHighlightEffect.of({ from: line.from, to: line.to }),
          ],
        });
        view.focus();
        setTimeout(() => {
          view.dispatch({ effects: [setSearchHighlightEffect.of(null)] });
        }, 1800);
        return true;
      }
    }
  }

  const targetClean = normalizeAnchor(cleanedInput);
  if (!targetClean) return false;

  const doc = view.state.doc;
  const struct = getDocStructureFromState(view.state);
  let targetLinePos: number | null = null;
  let targetLineEnd: number | null = null;

  // 1. 第一优先级：O(1) 从缓存的 DocStructure.headings 中比对标题行（天然跳过代码块与 YAML）
  for (const h of struct.headings) {
    const headingClean = normalizeAnchor(h.text);
    if (
      headingClean === targetClean ||
      headingClean.endsWith(targetClean) ||
      targetClean.endsWith(headingClean) ||
      headingClean.includes(targetClean) ||
      targetClean.includes(headingClean)
    ) {
      const line = doc.line(h.line);
      targetLinePos = line.from;
      targetLineEnd = line.to;
      break;
    }
  }

  // 2. 第二优先级：若未匹配到标准标题，检索全文档任意出现该关键词的非代码块行
  if (targetLinePos === null) {
    for (let i = 1; i <= doc.lines; i++) {
      if (struct.codeLineSet.has(i)) continue;
      const line = doc.line(i);
      const textClean = normalizeAnchor(line.text);
      if (
        textClean.length >= 2 &&
        (textClean.includes(targetClean) || targetClean.includes(textClean))
      ) {
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
