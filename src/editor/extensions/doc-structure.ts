import { EditorState, StateField, Text } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

export type CalloutType = "note" | "tip" | "important" | "warning" | "caution";

export interface CodeFenceRange {
  startLine: number;
  endLine: number;
  lang: string;
  codeText: string;
  fencePrefix: string;
  unclosed?: boolean;
}

export interface MermaidBlock {
  startLine: number;
  endLine: number;
  from: number;
  to: number;
  code: string;
}

export interface MathBlock {
  startLine: number;
  endLine: number;
  from: number;
  to: number;
  latex: string;
}

export interface TableBlock {
  startLine: number;
  endLine: number;
  from: number;
  to: number;
  lines: string[];
}

export interface CalloutBlock {
  startLine: number;
  endLine: number;
  calloutType: CalloutType;
  title: string;
}

export interface HeadingEntry {
  level: number;
  text: string;
  line: number;
  endLine: number;
  from: number;
}

export interface FrontMatterProperty {
  key: string;
  value: string;
  line: number;
}

export interface BalancedLinkOrImage {
  isImage: boolean;
  start: number;
  end: number;
  raw: string;
  label: string;
  url: string;
}

export interface DocStructure {
  frontMatterEndLine: number;
  frontMatterProps: FrontMatterProperty[];
  codeRanges: CodeFenceRange[];
  mermaidBlocks: MermaidBlock[];
  mathBlocks: MathBlock[];
  tables: TableBlock[];
  callouts: CalloutBlock[];
  headings: HeadingEntry[];
  headingsSignature: string;
  codeLineSet: Set<number>;
}

/**
 * 清理标题或内联文本中的 Markdown 格式包裹符（与 Rust 后端 strip_inline_markdown 完全对齐）
 */
export function stripInlineMarkdown(raw: string): string {
  return raw
    .trim()
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_m, target, alias) =>
      (alias || target).trim()
    )
    .replace(/(\*{1,3}|_{1,3}|~~|==|`)/g, "")
    .trim();
}

export function isTableDelimiter(lineText: string): boolean {
  const t = lineText.trim();
  if (!t.includes("|") || !t.includes("-")) return false;
  let inner = t;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|") && !inner.endsWith("\\|")) inner = inner.slice(0, -1);
  const parts = inner.split(/(?<!\\)\|/);
  if (parts.length === 0) return false;
  return parts.every((cell) => /^:?-{1,}:?$/.test(cell.trim()));
}

/**
 * 基于平衡括号状态机与转义感知解析单行中的 Markdown 链接 [text](url) 与图片 ![alt](url)
 * 彻底解决含括号 URL（如 Wikipedia `https://en.wikipedia.org/wiki/Rust_(programming_language)`）截断问题
 */
export function parseBalancedLinksAndImages(
  lineText: string,
  startOffset: number = 0
): BalancedLinkOrImage[] {
  const results: BalancedLinkOrImage[] = [];
  const len = lineText.length;
  let i = Math.max(0, startOffset);

  while (i < len) {
    if (lineText[i] === "\\") {
      i += 2;
      continue;
    }

    // 跳过行内代码 `...`
    if (lineText[i] === "`") {
      let tickCount = 1;
      while (i + tickCount < len && lineText[i + tickCount] === "`") tickCount++;
      const closeIdx = lineText.indexOf("`".repeat(tickCount), i + tickCount);
      if (closeIdx !== -1) {
        i = closeIdx + tickCount;
        continue;
      }
    }

    // 跳过双链 [[...]]、嵌入 ![[...]] 与脚注 [^...]
    if (
      lineText[i] === "!" &&
      i + 2 < len &&
      lineText[i + 1] === "[" &&
      lineText[i + 2] === "["
    ) {
      const closeBracket = lineText.indexOf("]]", i + 3);
      if (closeBracket !== -1) {
        i = closeBracket + 2;
        continue;
      }
    }
    if (lineText[i] === "[" && (lineText[i + 1] === "[" || lineText[i + 1] === "^")) {
      const closeBracket = lineText.indexOf("]", i + 2);
      if (closeBracket !== -1) {
        i = closeBracket + 1;
        continue;
      }
    }

    const isImage = lineText[i] === "!" && i + 1 < len && lineText[i + 1] === "[";
    const isLink = lineText[i] === "[";

    if (!isImage && !isLink) {
      i++;
      continue;
    }

    const fullFrom = i;
    const openBracketPos = isImage ? i + 1 : i;
    let bracketDepth = 1;
    let j = openBracketPos + 1;
    while (j < len && bracketDepth > 0) {
      if (lineText[j] === "\\") {
        j += 2;
        continue;
      }
      if (lineText[j] === "[") bracketDepth++;
      else if (lineText[j] === "]") bracketDepth--;
      j++;
    }

    if (bracketDepth !== 0 || j >= len || lineText[j] !== "(") {
      i = openBracketPos + 1;
      continue;
    }

    const closeBracketPos = j - 1;
    const openParenPos = j;
    let parenDepth = 1;
    let k = openParenPos + 1;
    while (k < len && parenDepth > 0) {
      if (lineText[k] === "\\") {
        k += 2;
        continue;
      }
      if (lineText[k] === "(") parenDepth++;
      else if (lineText[k] === ")") parenDepth--;
      k++;
    }

    if (parenDepth !== 0) {
      i = openBracketPos + 1;
      continue;
    }

    const closeParenPos = k - 1;
    const label = lineText.slice(openBracketPos + 1, closeBracketPos);
    const url = lineText.slice(openParenPos + 1, closeParenPos).trim();

    results.push({
      isImage,
      start: fullFrom,
      end: k,
      raw: lineText.slice(fullFrom, k),
      label,
      url,
    });

    i = k;
  }

  return results;
}

/**
 * 利用 CodeMirror 6 原生 Lezer 语法树 (syntaxTree) O(log N) 判断光标是否处于代码块或行内代码内
 */
export function isInsideCodeContextAST(state: EditorState, pos: number): boolean {
  try {
    const tree = syntaxTree(state);
    let node: any = tree.resolveInner(pos, -1);
    while (node) {
      const name = node.name;
      if (
        name === "FencedCode" ||
        name === "CodeBlock" ||
        name === "InlineCode" ||
        name === "CodeText" ||
        name === "CodeMark" ||
        name === "CodeInfo" ||
        name === "HTMLBlock"
      ) {
        return true;
      }
      node = node.parent;
    }
  } catch {
    // fallback to cached field
  }

  const struct = state.field(docStructureField, false);
  if (struct) {
    const lineNum = state.doc.lineAt(pos).number;
    if (struct.codeLineSet.has(lineNum)) return true;
  }
  return false;
}

/**
 * 结合 CodeMirror 6 Lezer 语法树与单趟结构扫描构建全文档 AST 缓存
 * 所有扩展（live-preview、mermaid、math-block、table-editor、focus-mode、block-handle、outline）
 * 直接 O(1) 共享此 StateField，避免 7+ 插件各自重复全量扫描文档
 */
export function buildDocStructure(doc: Text, state?: EditorState): DocStructure {
  const totalLines = doc.lines;
  const frontMatterProps: FrontMatterProperty[] = [];
  const codeRanges: CodeFenceRange[] = [];
  const mermaidBlocks: MermaidBlock[] = [];
  const mathBlocks: MathBlock[] = [];
  const tables: TableBlock[] = [];
  const callouts: CalloutBlock[] = [];
  const headings: HeadingEntry[] = [];
  const codeLineSet = new Set<number>();

  // 1. 识别顶部 YAML Front Matter 并解析键值属性
  let frontMatterEndLine = 0;
  if (totalLines >= 3 && doc.line(1).text.trim() === "---") {
    const limit = Math.min(totalLines, 45);
    for (let k = 2; k <= limit; k++) {
      const t = doc.line(k).text.trim();
      if (t === "---" || t === "...") {
        frontMatterEndLine = k;
        for (let m = 1; m <= k; m++) {
          codeLineSet.add(m);
        }
        break;
      }
    }
    if (frontMatterEndLine > 0) {
      for (let k = 2; k < frontMatterEndLine; k++) {
        const rawLine = doc.line(k).text;
        const kvMatch = rawLine.match(/^\s*([a-zA-Z0-9_\-\u4e00-\u9fa5]+)\s*:\s*(.*)$/);
        if (kvMatch) {
          frontMatterProps.push({
            key: kvMatch[1].trim(),
            value: kvMatch[2].trim(),
            line: k,
          });
        }
      }
    }
  }

  // 2. 利用 Lezer syntaxTree 辅助标记 FencedCode 节点范围
  if (state) {
    try {
      const tree = syntaxTree(state);
      tree.iterate({
        enter: (node) => {
          if (node.name === "FencedCode") {
            const sLine = doc.lineAt(node.from).number;
            const eLine = doc.lineAt(node.to).number;
            for (let l = sLine; l <= eLine; l++) {
              codeLineSet.add(l);
            }
            return false;
          }
          return true;
        },
      });
    } catch {
      // ignore if tree not ready
    }
  }

  // 3. 单趟扫描围栏代码块、Mermaid 块、数学公式块、表格块、Callout 块与标题
  let lineIdx = frontMatterEndLine + 1;

  while (lineIdx <= totalLines) {
    const lineObj = doc.line(lineIdx);
    const text = lineObj.text;
    const trimmed = text.trim();

    // 3.1 围栏代码块（支持顶层及引用块内的 3+ 反引号或波浪号）
    const fenceOpenMatch = text.match(/^(\s*(?:>\s*)*(`{3,}|~{3,}))\s*([^\s`~]*).*$/);
    if (fenceOpenMatch) {
      const fencePrefix = fenceOpenMatch[1];
      const fenceMarker = fenceOpenMatch[2];
      const fenceChar = fenceMarker[0];
      const fenceLen = fenceMarker.length;
      const lang = (fenceOpenMatch[3] || "").toLowerCase();
      const isQuotedFence = /^\s*>/.test(text);
      const startLine = lineIdx;
      const fromPos = lineObj.from;
      const codeLines: string[] = [];
      codeLineSet.add(lineIdx);
      lineIdx++;

      let endLine = totalLines;
      let toPos = doc.length;
      let closed = false;

      while (lineIdx <= totalLines) {
        const curLine = doc.line(lineIdx);
        const curStripQuote = curLine.text.replace(/^\s*(?:>\s*)*/, "").trim();
        codeLineSet.add(lineIdx);
        const closeMatch = curStripQuote.match(/^(`{3,}|~{3,})\s*$/);
        if (
          closeMatch &&
          closeMatch[1][0] === fenceChar &&
          closeMatch[1].length >= fenceLen
        ) {
          closed = true;
          endLine = lineIdx;
          toPos = curLine.to;
          lineIdx++;
          break;
        }
        if (isQuotedFence && !/^\s*>/.test(curLine.text)) {
          break;
        }
        codeLines.push(
          isQuotedFence ? curLine.text.replace(/^\s*>\s?/, "") : curLine.text
        );
        endLine = lineIdx;
        toPos = curLine.to;
        lineIdx++;
      }

      const codeText = codeLines.join("\n");
      if (lang === "mermaid" && closed && !isQuotedFence) {
        mermaidBlocks.push({
          startLine,
          endLine,
          from: fromPos,
          to: toPos,
          code: codeText,
        });
      } else if (!isQuotedFence) {
        codeRanges.push({
          startLine,
          endLine,
          lang,
          codeText,
          fencePrefix,
          unclosed: !closed,
        });
      }
      continue;
    }

    // 3.2 多行独立数学公式块 $$ ... $$
    if (trimmed === "$$") {
      const startLine = lineIdx;
      const fromPos = lineObj.from;
      const mathLines: string[] = [];
      codeLineSet.add(lineIdx);
      lineIdx++;

      let closed = false;
      let endLine = startLine;
      let toPos = lineObj.to;

      while (lineIdx <= totalLines) {
        const curLine = doc.line(lineIdx);
        codeLineSet.add(lineIdx);
        if (curLine.text.trim() === "$$") {
          closed = true;
          endLine = lineIdx;
          toPos = curLine.to;
          lineIdx++;
          break;
        }
        mathLines.push(curLine.text);
        endLine = lineIdx;
        toPos = curLine.to;
        lineIdx++;
      }

      if (closed) {
        mathBlocks.push({
          startLine,
          endLine,
          from: fromPos,
          to: toPos,
          latex: mathLines.join("\n"),
        });
      }
      continue;
    }

    // 3.3 表格块（排除引用块内的伪表格行）
    if (
      !/^\s*>/.test(text) &&
      trimmed.includes("|") &&
      lineIdx + 1 <= totalLines &&
      !/^\s*>/.test(doc.line(lineIdx + 1).text) &&
      isTableDelimiter(doc.line(lineIdx + 1).text)
    ) {
      const startLine = lineIdx;
      const fromPos = lineObj.from;
      const tblLines: string[] = [text, doc.line(lineIdx + 1).text];
      let endLine = lineIdx + 1;
      let toPos = doc.line(endLine).to;
      lineIdx += 2;
      while (lineIdx <= totalLines) {
        const rowLine = doc.line(lineIdx);
        if (/^\s*>/.test(rowLine.text) || !rowLine.text.trim().includes("|")) break;
        tblLines.push(rowLine.text);
        endLine = lineIdx;
        toPos = rowLine.to;
        lineIdx++;
      }
      tables.push({
        startLine,
        endLine,
        from: fromPos,
        to: toPos,
        lines: tblLines,
      });
      continue;
    }

    // 3.4 GitHub 风格 Callout / Admonition 引用块 (> [!NOTE] / TIP / IMPORTANT / WARNING / CAUTION)
    const calloutStartMatch = text.match(
      /^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i
    );
    if (calloutStartMatch) {
      const calloutType = calloutStartMatch[1].toLowerCase() as CalloutType;
      const defaultTitles: Record<CalloutType, string> = {
        note: "Note",
        tip: "Tip",
        important: "Important",
        warning: "Warning",
        caution: "Caution",
      };
      const customTitle = calloutStartMatch[2].trim();
      const title = customTitle || defaultTitles[calloutType];
      const startLine = lineIdx;
      let endLine = lineIdx;
      lineIdx++;
      let inCalloutFence = false;
      while (lineIdx <= totalLines) {
        const nextText = doc.line(lineIdx).text;
        if (!/^\s*>/.test(nextText)) break;
        if (/^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(nextText)) {
          break;
        }
        const strippedQuote = nextText.replace(/^\s*(?:>\s*)*/, "").trim();
        if (/^(`{3,}|~{3,})/.test(strippedQuote)) {
          inCalloutFence = !inCalloutFence;
        }
        if (inCalloutFence) {
          codeLineSet.add(lineIdx);
        }
        endLine = lineIdx;
        lineIdx++;
      }
      callouts.push({
        startLine,
        endLine,
        calloutType,
        title,
      });
      continue;
    }

    // 3.5 标题行（兼容顶层标题与普通引用块内标题，严格跳过任何代码块）
    if (!codeLineSet.has(lineIdx)) {
      const headingMatch = text.match(/^\s*(?:>\s*)*(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const rawHeading = headingMatch[2];
        const cleaned = stripInlineMarkdown(rawHeading);
        if (cleaned) {
          headings.push({
            level: headingMatch[1].length,
            text: cleaned,
            line: lineIdx,
            endLine: totalLines,
            from: lineObj.from,
          });
        }
        lineIdx++;
        continue;
      }
    }

    lineIdx++;
  }

  // 4. 计算每个标题的章节闭包结束行 (endLine)，供正文标题折叠与大纲子树操作 O(1) 使用
  for (let i = 0; i < headings.length; i++) {
    let secEnd = totalLines;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= headings[i].level) {
        secEnd = Math.max(headings[i].line, headings[j].line - 1);
        break;
      }
    }
    headings[i].endLine = secEnd;
  }

  const headingsSignature = headings.map((h) => `${h.level}:${h.line}:${h.text}`).join("|");

  return {
    frontMatterEndLine,
    frontMatterProps,
    codeRanges,
    mermaidBlocks,
    mathBlocks,
    tables,
    callouts,
    headings,
    headingsSignature,
    codeLineSet,
  };
}

function isStructuralLineText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (
    t.startsWith("#") ||
    t.startsWith(">") ||
    t.startsWith("```") ||
    t.startsWith("~~~") ||
    t.startsWith("$$") ||
    t.includes("|") ||
    t === "---" ||
    t === "..."
  ) {
    return true;
  }
  return false;
}

function isLineTouchingCachedStructure(value: DocStructure, ln: number): boolean {
  if (ln <= Math.max(3, value.frontMatterEndLine + 1)) return true;
  if (value.codeLineSet.has(ln)) return true;
  if (value.headings.some((h) => h.line === ln)) return true;
  if (value.tables.some((tb) => ln >= tb.startLine - 1 && ln <= tb.endLine + 1)) return true;
  if (value.mathBlocks.some((mb) => ln >= mb.startLine && ln <= mb.endLine)) return true;
  if (value.mermaidBlocks.some((mb) => ln >= mb.startLine && ln <= mb.endLine)) return true;
  if (value.callouts.some((cb) => ln >= cb.startLine - 1 && ln <= cb.endLine + 1)) return true;
  return false;
}

/**
 * 增量 DocStructure 缓存 (v0.8 O(1) 行号平移架构):
 * 1. 当用户在普通段落/列表打字且行数不变时，O(K) 直接通过 tr.changes.mapPos 映射块坐标。
 * 2. 当用户在普通段落/列表按 Enter 换行或 Backspace 合并行（deltaLines !== 0）且变更行不涉及块级结构定界符时，
 *    仅对变更点之后的结构块执行 O(K) 行号平移 (line += deltaLines)，将万字长文换行耗时从 O(N) 全量扫描降为 O(1)。
 */
export const docStructureField = StateField.define<DocStructure>({
  create(state) {
    return buildDocStructure(state.doc, state);
  },
  update(value, tr) {
    if (!tr.docChanged) return value;

    const deltaLines = tr.state.doc.lines - tr.startState.doc.lines;
    let canIncrementalShift = true;
    let rangeCount = 0;
    let pivotLineA = 0;

    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      rangeCount++;
      // 若同一次事务包含多处跨区变更且行数改变，回退全量构建以确保绝对精确
      if (!canIncrementalShift || (rangeCount > 1 && deltaLines !== 0)) {
        canIncrementalShift = false;
        return;
      }

      const lineAStart = tr.startState.doc.lineAt(fromA);
      const lineAEnd = tr.startState.doc.lineAt(toA);
      const lineBStart = tr.state.doc.lineAt(fromB);
      const lineBEnd = tr.state.doc.lineAt(toB);
      pivotLineA = lineAEnd.number;

      // 检查旧文档受影响的所有行是否触及任何块级结构
      for (let ln = lineAStart.number; ln <= lineAEnd.number; ln++) {
        if (
          isLineTouchingCachedStructure(value, ln) ||
          isStructuralLineText(tr.startState.doc.line(ln).text)
        ) {
          canIncrementalShift = false;
          return;
        }
      }

      // 检查新文档变更后的所有行是否引入了新的块级定界符 (#, >, ```, ~~~, $$, |, ---)
      for (let ln = lineBStart.number; ln <= lineBEnd.number; ln++) {
        if (isStructuralLineText(tr.state.doc.line(ln).text)) {
          canIncrementalShift = false;
          return;
        }
      }
    });

    if (canIncrementalShift && rangeCount > 0) {
      if (deltaLines === 0) {
        return {
          ...value,
          mermaidBlocks:
            value.mermaidBlocks.length === 0
              ? value.mermaidBlocks
              : value.mermaidBlocks.map((m) => ({
                  ...m,
                  from: tr.changes.mapPos(m.from),
                  to: tr.changes.mapPos(m.to),
                })),
          mathBlocks:
            value.mathBlocks.length === 0
              ? value.mathBlocks
              : value.mathBlocks.map((m) => ({
                  ...m,
                  from: tr.changes.mapPos(m.from),
                  to: tr.changes.mapPos(m.to),
                })),
          tables:
            value.tables.length === 0
              ? value.tables
              : value.tables.map((t) => ({
                  ...t,
                  from: tr.changes.mapPos(t.from),
                  to: tr.changes.mapPos(t.to),
                })),
          headings:
            value.headings.length === 0
              ? value.headings
              : value.headings.map((h) => ({
                  ...h,
                  from: tr.changes.mapPos(h.from),
                })),
        };
      }

      // O(K) 行号平移：仅对 pivotLineA 之后的块级结构应用 line += deltaLines
      const shiftLine = (ln: number) => (ln > pivotLineA ? ln + deltaLines : ln);

      const shiftedCodeLineSet = new Set<number>();
      value.codeLineSet.forEach((ln) => {
        shiftedCodeLineSet.add(shiftLine(ln));
      });

      const shiftedHeadings =
        value.headings.length === 0
          ? value.headings
          : value.headings.map((h) => ({
              ...h,
              line: shiftLine(h.line),
              endLine: h.endLine >= pivotLineA ? h.endLine + deltaLines : h.endLine,
              from: tr.changes.mapPos(h.from),
            }));

      const headingsSignature =
        shiftedHeadings.length === 0
          ? value.headingsSignature
          : shiftedHeadings.map((h) => `${h.level}:${h.line}:${h.text}`).join("|");

      return {
        ...value,
        codeRanges:
          value.codeRanges.length === 0
            ? value.codeRanges
            : value.codeRanges.map((cr) => ({
                ...cr,
                startLine: shiftLine(cr.startLine),
                endLine: shiftLine(cr.endLine),
              })),
        mermaidBlocks:
          value.mermaidBlocks.length === 0
            ? value.mermaidBlocks
            : value.mermaidBlocks.map((m) => ({
                ...m,
                startLine: shiftLine(m.startLine),
                endLine: shiftLine(m.endLine),
                from: tr.changes.mapPos(m.from),
                to: tr.changes.mapPos(m.to),
              })),
        mathBlocks:
          value.mathBlocks.length === 0
            ? value.mathBlocks
            : value.mathBlocks.map((m) => ({
                ...m,
                startLine: shiftLine(m.startLine),
                endLine: shiftLine(m.endLine),
                from: tr.changes.mapPos(m.from),
                to: tr.changes.mapPos(m.to),
              })),
        tables:
          value.tables.length === 0
            ? value.tables
            : value.tables.map((t) => ({
                ...t,
                startLine: shiftLine(t.startLine),
                endLine: shiftLine(t.endLine),
                from: tr.changes.mapPos(t.from),
                to: tr.changes.mapPos(t.to),
              })),
        callouts:
          value.callouts.length === 0
            ? value.callouts
            : value.callouts.map((c) => ({
                ...c,
                startLine: shiftLine(c.startLine),
                endLine: shiftLine(c.endLine),
              })),
        headings: shiftedHeadings,
        headingsSignature,
        codeLineSet: shiftedCodeLineSet,
      };
    }

    return buildDocStructure(tr.state.doc, tr.state);
  },
});

export function getDocStructureFromState(state: EditorState): DocStructure {
  const cached = state.field(docStructureField, false);
  if (cached) return cached;
  return buildDocStructure(state.doc, state);
}

/**
 * O(1) 从缓存的 DocStructure 解析指定行所属的完整语义块起止行号（供 Focus Mode 与 Block Handle 复用）
 * 支持：FrontMatter、围栏代码块、Mermaid、多行公式块、表格、Callout、连续引用块、以及带嵌套子列表的列表项闭包
 */
export function resolveSemanticBlockSpanFromState(
  state: EditorState,
  targetLine: number
): { startLine: number; endLine: number } {
  const struct = getDocStructureFromState(state);
  const doc = state.doc;
  const totalLines = doc.lines;
  const clamped = Math.max(1, Math.min(targetLine, totalLines));

  if (struct.frontMatterEndLine > 0 && clamped <= struct.frontMatterEndLine) {
    return { startLine: 1, endLine: struct.frontMatterEndLine };
  }
  for (const cr of struct.codeRanges) {
    if (clamped >= cr.startLine && clamped <= cr.endLine) {
      return { startLine: cr.startLine, endLine: cr.endLine };
    }
  }
  for (const mb of struct.mermaidBlocks) {
    if (clamped >= mb.startLine && clamped <= mb.endLine) {
      return { startLine: mb.startLine, endLine: mb.endLine };
    }
  }
  for (const mathB of struct.mathBlocks) {
    if (clamped >= mathB.startLine && clamped <= mathB.endLine) {
      return { startLine: mathB.startLine, endLine: mathB.endLine };
    }
  }
  for (const tb of struct.tables) {
    if (clamped >= tb.startLine && clamped <= tb.endLine) {
      return { startLine: tb.startLine, endLine: tb.endLine };
    }
  }
  for (const cb of struct.callouts) {
    if (clamped >= cb.startLine && clamped <= cb.endLine) {
      return { startLine: cb.startLine, endLine: cb.endLine };
    }
  }

  const lineText = doc.line(clamped).text;
  const trimmed = lineText.trim();
  if (!trimmed) {
    return { startLine: clamped, endLine: clamped };
  }

  // 普通引用块连续区间
  if (trimmed.startsWith(">")) {
    let s = clamped;
    let e = clamped;
    while (s > 1 && doc.line(s - 1).text.trim().startsWith(">")) s--;
    while (e < totalLines && doc.line(e + 1).text.trim().startsWith(">")) e++;
    return { startLine: s, endLine: e };
  }

  // 列表项及挂载在其下方的更深缩进子列表项
  const listMatch = lineText.match(/^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/);
  if (listMatch) {
    const baseIndent = listMatch[1].replace(/\t/g, "  ").length;
    let e = clamped;
    while (e < totalLines) {
      const nextText = doc.line(e + 1).text;
      if (!nextText.trim()) break;
      const nextListMatch = nextText.match(/^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/);
      if (nextListMatch) {
        const nextIndent = nextListMatch[1].replace(/\t/g, "  ").length;
        if (nextIndent > baseIndent) {
          e++;
          continue;
        }
        break;
      }
      const leadingIndent = (nextText.match(/^\s*/)?.[0] || "").replace(/\t/g, "  ").length;
      if (leadingIndent > baseIndent) {
        e++;
        continue;
      }
      break;
    }
    return { startLine: clamped, endLine: e };
  }

  return { startLine: clamped, endLine: clamped };
}
