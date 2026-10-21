import { EditorSelection, EditorState, Extension } from "@codemirror/state";
import { isInsideCodeContextAST, parseBalancedLinksAndImages } from "./doc-structure";

export interface InlineAtomicSpan {
  type:
    | "link"
    | "image"
    | "wikilink"
    | "inline_math"
    | "inline_code"
    | "bold_italic"
    | "bold"
    | "italic"
    | "strikethrough"
    | "highlight";
  from: number;
  to: number;
  innerFrom: number;
  innerTo: number;
}

/**
 * 判断一段文本是否是一个网址（支持 http/https/ftp/mailto/www. 以及常见域名后缀）
 * 用于右键转超链接、Ctrl+K、气泡栏超链接、表格超链接与智能粘贴 URL 识别 (Bug #7)
 */
export function isLikelyUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^(https?:\/\/|ftp:\/\/|mailto:|tel:|www\.)\S+$/i.test(trimmed)) {
    return true;
  }
  return /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+\.(com|cn|org|net|io|edu|gov|cc|me|app|dev|info|vip|xyz|tech|top|ai|co|uk|jp|de|fr)(\/\S*)?$/i.test(
    trimmed
  );
}

/**
 * 将类似 www.example.com 或 quilla.app 的简写网址规范化为完整协议地址
 */
export function normalizeUrlForLink(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "https://";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

/**
 * 智能构建 Markdown 超链接插入片段与光标选中区间 (彻底解决选中网址转超链接时被塞进名称栏的 Bug #7)：
 * - 当选中的文本本身是网址时：自动将网址填入右侧 `(url)` 链接栏，左侧 `[链接文字]` 名称栏填入默认提示并自动选中名称栏，方便用户直接输入名称；
 * - 当选中的文本是普通名称时：将其填入左侧 `[名称]` 栏，右侧填入 `(https://)` 并选中链接栏待填部分。
 */
export function buildSmartMarkdownLink(
  rawSelected: string,
  defaultLabel: string = "链接文字",
  defaultUrl: string = "https://"
): {
  insertStr: string;
  anchorOffset: number;
  headOffset: number;
  isUrlInput: boolean;
  labelValue: string;
  urlValue: string;
} {
  const trimmed = rawSelected.trim();
  if (trimmed && isLikelyUrl(trimmed)) {
    const normalizedUrl = normalizeUrlForLink(trimmed);
    const label = defaultLabel;
    const insertStr = `[${label}](${normalizedUrl})`;
    return {
      insertStr,
      anchorOffset: 1,
      headOffset: 1 + label.length,
      isUrlInput: true,
      labelValue: label,
      urlValue: normalizedUrl,
    };
  }

  const label = rawSelected || defaultLabel;
  const url = defaultUrl || "https://";
  const insertStr = `[${label}](${url})`;
  return {
    insertStr,
    anchorOffset: label.length + 3,
    headOffset: insertStr.length - 1,
    isUrlInput: false,
    labelValue: label,
    urlValue: url,
  };
}

/**
 * 扫描单行内的所有行内原子/富文本语法区间（超链接、图片、WikiLink、行内代码、行内公式、加粗、斜体、删除线、高亮）
 */
export function scanLineInlineAtomicSpans(
  lineText: string,
  lineFrom: number
): InlineAtomicSpan[] {
  const spans: InlineAtomicSpan[] = [];
  const occupied = new Uint8Array(lineText.length);

  const markOccupied = (s: number, e: number) => {
    for (let i = Math.max(0, s); i < Math.min(lineText.length, e); i++) {
      occupied[i] = 1;
    }
  };
  const isRangeFree = (s: number, e: number): boolean => {
    for (let i = Math.max(0, s); i < Math.min(lineText.length, e); i++) {
      if (occupied[i]) return false;
    }
    return true;
  };

  // 1. 行内代码 `...`
  const codeRe = /(`+)([^`]+?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(lineText)) !== null) {
    const s = m.index;
    const e = s + m[0].length;
    const tickLen = m[1].length;
    markOccupied(s, e);
    spans.push({
      type: "inline_code",
      from: lineFrom + s,
      to: lineFrom + e,
      innerFrom: lineFrom + s + tickLen,
      innerTo: lineFrom + e - tickLen,
    });
  }

  // 2. 双链 [[...]] 与嵌入 ![[...]]
  const wikiRe = /(!?\[\[)([^\]\n]+?)(\]\])/g;
  while ((m = wikiRe.exec(lineText)) !== null) {
    const s = m.index;
    const e = s + m[0].length;
    if (!isRangeFree(s, e)) continue;
    markOccupied(s, e);
    spans.push({
      type: "wikilink",
      from: lineFrom + s,
      to: lineFrom + e,
      innerFrom: lineFrom + s + m[1].length,
      innerTo: lineFrom + e - 2,
    });
  }

  // 3. 平衡括号超链接 [text](url) 与图片 ![alt](url)
  const balancedLinks = parseBalancedLinksAndImages(lineText, 0);
  for (const bl of balancedLinks) {
    if (!isRangeFree(bl.start, bl.end)) continue;
    markOccupied(bl.start, bl.end);
    const openLen = bl.isImage ? 2 : 1;
    spans.push({
      type: bl.isImage ? "image" : "link",
      from: lineFrom + bl.start,
      to: lineFrom + bl.end,
      innerFrom: lineFrom + bl.start + openLen,
      innerTo: lineFrom + bl.start + openLen + bl.label.length,
    });
  }

  // 4. 行内数学公式 $...$
  const mathRe = /(?<!\\|\$)\$(?!\$)([^\$\n]+?)(?<!\\|\$)\$(?!\$)/g;
  while ((m = mathRe.exec(lineText)) !== null) {
    const s = m.index;
    const e = s + m[0].length;
    if (!isRangeFree(s, e)) continue;
    markOccupied(s, e);
    spans.push({
      type: "inline_math",
      from: lineFrom + s,
      to: lineFrom + e,
      innerFrom: lineFrom + s + 1,
      innerTo: lineFrom + e - 1,
    });
  }

  // 5. 加粗斜体 ***...***、加粗 **...**、删除线 ~~...~~、高亮 ==...==、斜体 *...*
  const inlineFormats: Array<{
    type: InlineAtomicSpan["type"];
    re: RegExp;
    delimLen: number;
  }> = [
    { type: "bold_italic", re: /\*\*\*([^*]+?)\*\*\*/g, delimLen: 3 },
    { type: "bold", re: /(?<!\*)\*\*([^*]+?)\*\*(?!\*)/g, delimLen: 2 },
    { type: "strikethrough", re: /~~([^~]+?)~~/g, delimLen: 2 },
    { type: "highlight", re: /==([^=]+?)==/g, delimLen: 2 },
    { type: "italic", re: /(?<!\*)\*([^*]+?)\*(?!\*)/g, delimLen: 1 },
  ];

  for (const fmt of inlineFormats) {
    while ((m = fmt.re.exec(lineText)) !== null) {
      const s = m.index;
      const e = s + m[0].length;
      if (!isRangeFree(s, e)) continue;
      markOccupied(s, e);
      spans.push({
        type: fmt.type,
        from: lineFrom + s,
        to: lineFrom + e,
        innerFrom: lineFrom + s + fmt.delimLen,
        innerTo: lineFrom + e - fmt.delimLen,
      });
    }
  }

  spans.sort((a, b) => a.from - b.from);
  return spans;
}

/**
 * 当用户在超链接或行内原子语法右边缘单击时，若原本光标不在该语法内部，
 * 且 DOM 映射落点恰好卡在显示文本末尾 `innerTo`（即隐藏的 `](url)` 或闭合符号之前），
 * 自动将光标吸附到完整语法闭合处 `to`，彻底避免紧接着按回车或打字把格式劈裂 (Bug #6)。
 */
export function snapClickPosAtInlineBoundary(
  state: EditorState,
  candidatePos: number,
  clickedOnLinkElement: boolean = false
): number {
  if (clickedOnLinkElement) return candidatePos;
  if (isInsideCodeContextAST(state, candidatePos)) return candidatePos;

  const line = state.doc.lineAt(candidatePos);
  const prevSel = state.selection.main;
  const spans = scanLineInlineAtomicSpans(line.text, line.from);

  for (const sp of spans) {
    const wasCursorInside =
      prevSel.empty && prevSel.head >= sp.from && prevSel.head <= sp.to;
    if (wasCursorInside) continue;

    // 当语法处于收起预览态时，单击其右侧边缘在 DOM 中会命中 innerTo（因为 innerTo..to 被 Decoration.replace 隐藏）
    if (candidatePos >= sp.innerTo && candidatePos < sp.to) {
      return sp.to;
    }
  }
  return candidatePos;
}

/**
 * 当用户按下 Enter 键准备换行时，检查光标是否卡在超链接 `[text|](url)`、`[text](url|)`
 * 或其他行内原子语法的闭合定界符夹缝中。若是，自动将换行点安全逃逸到 `sp.to`（语法末尾之后）
 * 或 `sp.from`（语法开头之前），100% 杜绝回车把超链接或行内语法劈成两半 (Bug #6)。
 */
export function resolveSafeInlineEnterPosition(
  state: EditorState,
  pos: number
): { escaped: boolean; safePos: number } {
  if (isInsideCodeContextAST(state, pos)) {
    return { escaped: false, safePos: pos };
  }

  const line = state.doc.lineAt(pos);
  const spans = scanLineInlineAtomicSpans(line.text, line.from);

  for (const sp of spans) {
    // 1. 光标位于显示文字末尾或右侧隐藏的 URL/闭合标记内部 [innerTo, to) -> 逃逸到整个语法块右侧 sp.to
    if (pos >= sp.innerTo && pos < sp.to) {
      return { escaped: true, safePos: sp.to };
    }
    // 2. 光标位于左侧起始定界符内部 (from, innerFrom] -> 逃逸到整个语法块左侧 sp.from
    if (pos > sp.from && pos <= sp.innerFrom) {
      return { escaped: true, safePos: sp.from };
    }
  }

  return { escaped: false, safePos: pos };
}

/**
 * 统一行内原子装饰器边界守卫 (Inline Atomic Cursor Guard v0.9)
 * 基于 EditorState.transactionFilter 统一拦截：
 * 1. 鼠标点击落在折叠态超链接/行内语法的右边缘夹缝 (innerTo) 时，自动吸附到闭合括号右侧 (sp.to)。
 * 2. 在超链接 `[text](url)` 的右半区 `[innerTo, to)` 或左边界 `(from, innerFrom]` 直接插入换行符 `\n` 时，
 *    自动将换行位置逃逸至 `sp.to` 或 `sp.from`，彻底防止任何途径的回车换行破坏超链接与行内原子语法。
 */
export const inlineBoundaryCursorGuardExtension: Extension =
  EditorState.transactionFilter.of((tr) => {
    if (
      typeof document !== "undefined" &&
      document.body.classList.contains("source-mode")
    ) {
      return tr;
    }

    // 1. 拦截指针点击选区：修正超链接与行内装饰器右边缘点击落点
    if (!tr.docChanged && tr.selection && tr.isUserEvent("select.pointer")) {
      const main = tr.selection.main;
      if (main.empty) {
        const snapped = snapClickPosAtInlineBoundary(tr.startState, main.head, false);
        if (snapped !== main.head) {
          return [
            tr,
            {
              selection: EditorSelection.cursor(snapped, 1),
            },
          ];
        }
      }
    }

    // 2. 拦截单光标回车换行事务：若原生回车落入超链接/行内原子语法首尾定界符夹缝，自动重路由到安全边界外换行
    if (tr.docChanged && tr.startState.selection.main.empty) {
      const head = tr.startState.selection.main.head;
      let singleNewlineInsert: { fromA: number; toA: number; inserted: string } | null =
        null;
      let changeCount = 0;

      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changeCount++;
        if (changeCount === 1) {
          singleNewlineInsert = {
            fromA,
            toA,
            inserted: inserted.toString(),
          };
        }
      });

      if (
        changeCount === 1 &&
        singleNewlineInsert &&
        (singleNewlineInsert as { fromA: number; toA: number; inserted: string }).fromA === head &&
        (singleNewlineInsert as { fromA: number; toA: number; inserted: string }).toA === head &&
        /^\r?\n[ \t]*$/.test(
          (singleNewlineInsert as { fromA: number; toA: number; inserted: string }).inserted
        )
      ) {
        const { escaped, safePos } = resolveSafeInlineEnterPosition(
          tr.startState,
          head
        );
        if (escaped && safePos !== head) {
          const insText = (
            singleNewlineInsert as { fromA: number; toA: number; inserted: string }
          ).inserted;
          return {
            changes: { from: safePos, to: safePos, insert: insText },
            selection: EditorSelection.cursor(safePos + insText.length),
            scrollIntoView: true,
            userEvent: "input.enter",
          };
        }
      }
    }

    return tr;
  });
