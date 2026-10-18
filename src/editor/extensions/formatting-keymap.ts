import { EditorView, KeyBinding } from "@codemirror/view";
import { ChangeSpec, Text } from "@codemirror/state";
import { moveCurrentSemanticBlock, duplicateCurrentSemanticBlock } from "./block-handle";
import {
  getDocStructureFromState,
  isInsideCodeContextAST,
  parseBalancedLinksAndImages,
} from "./doc-structure";

/**
 * 转义正则特殊字符
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 向上查找在指定行 lineNum 之前、相同 quotePrefix 与 targetIndentLen 下的预期有序列表编号：
 * - 若遇到更浅缩进的父级列表项或空行/非列表行，说明当前是新子列表的起点，重置返回 1
 * - 若遇到相同缩进的前序兄弟有序列表项，返回其编号 + 1
 */
export function computeExpectedOrderedNumber(
  doc: Text,
  lineNum: number,
  quotePrefix: string,
  targetIndentLen: number
): number {
  const quoteLen = quotePrefix.length;
  for (let ln = lineNum - 1; ln >= 1; ln--) {
    const prevText = doc.line(ln).text;
    if (!prevText.startsWith(quotePrefix)) break;
    const sub = prevText.slice(quoteLen);
    if (sub.trim() === "") break;

    const listMatch = sub.match(/^(\s*)([-*+]|\d+\.)\s+/);
    if (!listMatch) break;

    const curIndentLen = listMatch[1].length;
    if (curIndentLen < targetIndentLen) {
      return 1;
    }
    if (curIndentLen === targetIndentLen) {
      const ordMatch = listMatch[2].match(/^(\d+)\.$/);
      if (ordMatch) {
        return parseInt(ordMatch[1], 10) + 1;
      }
      return 1;
    }
  }
  return 1;
}

/**
 * 向上探测最近一个更浅层级的父列表项信息（用于空子列表项按 Enter / Backspace 退格时精准对齐父级缩进与列表类型，
 * 彻底消除硬编码 .slice(2) 导致的 1 空格或奇数空格残留问题）
 */
function findParentListSpec(
  doc: Text,
  lineNum: number,
  quotePrefix: string,
  currentIndentLen: number
): {
  indent: string;
  kind: "ordered" | "bullet" | "task";
  bulletChar: string;
} {
  const quoteLen = quotePrefix.length;
  for (let ln = lineNum - 1; ln >= 1; ln--) {
    const prevText = doc.line(ln).text;
    if (!prevText.startsWith(quotePrefix)) break;
    const sub = prevText.slice(quoteLen);
    if (sub.trim() === "") break;

    const taskMatch = sub.match(/^(\s*)([-*+])\s+\[[ xX]\]\s+/);
    if (taskMatch) {
      const ind = taskMatch[1];
      if (ind.length < currentIndentLen) {
        return { indent: ind, kind: "task", bulletChar: taskMatch[2] || "-" };
      }
      continue;
    }

    const listMatch = sub.match(/^(\s*)([-*+]|\d+\.)\s+/);
    if (!listMatch) break;

    const ind = listMatch[1];
    if (ind.length < currentIndentLen) {
      const marker = listMatch[2];
      if (/^\d+\.$/.test(marker)) {
        return { indent: ind, kind: "ordered", bulletChar: "-" };
      }
      return { indent: ind, kind: "bullet", bulletChar: marker[0] || "-" };
    }
  }

  // 未找到更浅父级列表项时，按 2 空格步进归整（向下取偶），确保绝不残留单个奇数空格
  const rawTarget = Math.max(0, currentIndentLen - 2);
  const alignedLen = rawTarget - (rawTarget % 2);
  return {
    indent: " ".repeat(alignedLen),
    kind: "bullet",
    bulletChar: "-",
  };
}

/**
 * 从 startLine 向后扫描并生成指定缩进层级 ordered list 的连续重编号 ChangeSpec
 */
function buildSubsequentRenumberChanges(
  doc: Text,
  startLine: number,
  quotePrefix: string,
  indentLen: number,
  startingExpectedNum: number
): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  const quoteLen = quotePrefix.length;
  let expectedNum = startingExpectedNum;

  for (let ln = startLine; ln <= doc.lines; ln++) {
    const nextLine = doc.line(ln);
    if (!nextLine.text.startsWith(quotePrefix)) break;
    const subText = nextLine.text.slice(quoteLen);
    if (subText.trim() === "") break;

    const listMatch = subText.match(/^(\s*)([-*+]|\d+\.)\s+/);
    if (!listMatch) {
      const leadingSpaces = (subText.match(/^\s*/)?.[0] || "").length;
      if (leadingSpaces > indentLen) continue;
      break;
    }

    const curIndentLen = listMatch[1].length;
    if (curIndentLen < indentLen) break;
    if (curIndentLen > indentLen) continue;

    const ordMatch = listMatch[2].match(/^(\d+)\.$/);
    if (!ordMatch) break;

    const oldNumStr = ordMatch[1];
    const newNumStr = String(expectedNum);
    if (oldNumStr !== newNumStr) {
      const numFrom = nextLine.from + quoteLen + curIndentLen;
      changes.push({
        from: numFrom,
        to: numFrom + oldNumStr.length,
        insert: newNumStr,
      });
    }
    expectedNum++;
  }

  return changes;
}

/**
 * 包装或插入定界符 (如 **bold**, *italic*, `code`, ~~del~~, ==mark==, $math$)
 * - 支持跨多行选区逐行智能包裹与解包（自动跳过列表/标题/引用块前缀与空行，彻底修复多行删除线/加粗等失效 Bug）
 * - 智能支持单行反选 (再次按下快捷键或点击工具栏取消格式，包括光标处于词内时的精确探测解包及 *** 复合解包)
 */
export function smartToggleFormat(
  view: EditorView,
  before: string,
  after: string = before
): boolean {
  const selection = view.state.selection.main;
  const from = selection.from;
  const to = selection.to;
  const selectedText = view.state.sliceDoc(from, to);

  if (selectedText.length > 0) {
    // 1. 多行选区：按行独立剥离块级前缀并对每行正文执行包裹/解包
    if (selectedText.includes("\n")) {
      const doc = view.state.doc;
      const startLine = doc.lineAt(from);
      const endLine = doc.lineAt(
        to > from && doc.lineAt(to).from === to ? to - 1 : to
      );

      interface LineFormatTarget {
        bodyFrom: number;
        bodyTo: number;
        bodyText: string;
        isWrapped: boolean;
        hasOuterWrapInDoc: boolean;
      }

      const targets: LineFormatTarget[] = [];
      for (let ln = startLine.number; ln <= endLine.number; ln++) {
        const line = doc.line(ln);
        let rFrom = Math.max(from, line.from);
        let rTo = Math.min(to, line.to);
        if (rTo <= rFrom) continue;

        const rawSlice = view.state.sliceDoc(rFrom, rTo);
        if (!rawSlice.trim()) continue;

        // 若选区从行首（或仅含缩进处）开始，自动跳过标题/列表/引用/Callout 前缀，只格式化正文内容
        if (rFrom === line.from) {
          if (/^\s*(?:>\s*)*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(rawSlice)) {
            continue;
          }
          if (/^\s*(`{3,}|~{3,}|\$\$|---|\*\*\*|___)\s*$/.test(rawSlice)) {
            continue;
          }
          const prefixMatch = rawSlice.match(
            /^(\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)?)/
          );
          if (prefixMatch && prefixMatch[0].length > 0) {
            rFrom += prefixMatch[0].length;
          }
        }

        // 收缩首尾多余空白，防止生成 `~~ 文字 ~~` 导致 Markdown 语法不生效
        const innerSlice = view.state.sliceDoc(rFrom, rTo);
        const leadWs = (innerSlice.match(/^\s*/)?.[0] || "").length;
        const trailWs = (innerSlice.match(/\s*$/)?.[0] || "").length;
        rFrom += leadWs;
        rTo -= trailWs;
        if (rTo <= rFrom) continue;

        const bodyText = view.state.sliceDoc(rFrom, rTo);
        const isWrapped =
          bodyText.startsWith(before) &&
          bodyText.endsWith(after) &&
          bodyText.length >= before.length + after.length;
        const docBefore = view.state.sliceDoc(Math.max(line.from, rFrom - before.length), rFrom);
        const docAfter = view.state.sliceDoc(rTo, Math.min(line.to, rTo + after.length));
        const hasOuterWrapInDoc = docBefore === before && docAfter === after;

        targets.push({
          bodyFrom: rFrom,
          bodyTo: rTo,
          bodyText,
          isWrapped,
          hasOuterWrapInDoc,
        });
      }

      if (targets.length === 0) return false;

      const shouldUnwrap = targets.every((t) => t.isWrapped || t.hasOuterWrapInDoc);
      const changes: ChangeSpec[] = [];
      let totalDelta = 0;

      for (const t of targets) {
        if (shouldUnwrap) {
          if (t.isWrapped) {
            const unwrapped = t.bodyText.slice(
              before.length,
              t.bodyText.length - after.length
            );
            changes.push({ from: t.bodyFrom, to: t.bodyTo, insert: unwrapped });
            totalDelta -= before.length + after.length;
          } else if (t.hasOuterWrapInDoc) {
            changes.push({
              from: t.bodyFrom - before.length,
              to: t.bodyTo + after.length,
              insert: t.bodyText,
            });
            totalDelta -= before.length + after.length;
          }
        } else {
          if (t.isWrapped || t.hasOuterWrapInDoc) continue;
          const wrapped = `${before}${t.bodyText}${after}`;
          changes.push({ from: t.bodyFrom, to: t.bodyTo, insert: wrapped });
          totalDelta += before.length + after.length;
        }
      }

      if (changes.length > 0) {
        const firstFrom = shouldUnwrap
          ? Math.max(0, targets[0].bodyFrom - (targets[0].hasOuterWrapInDoc ? before.length : 0))
          : targets[0].bodyFrom;
        const lastTarget = targets[targets.length - 1];
        const rawLastTo = shouldUnwrap
          ? lastTarget.bodyTo + (lastTarget.hasOuterWrapInDoc ? after.length : 0)
          : lastTarget.bodyTo;
        view.dispatch({
          changes,
          selection: {
            anchor: firstFrom,
            head: Math.max(firstFrom, rawLastTo + totalDelta),
          },
          userEvent: "input.format",
        });
      }
      return true;
    }

    // 2. 单行选区：若选区首尾已包含定界符，直接解包
    if (
      selectedText.startsWith(before) &&
      selectedText.endsWith(after) &&
      selectedText.length >= before.length + after.length
    ) {
      view.dispatch({
        changes: {
          from,
          to,
          insert: selectedText.slice(before.length, selectedText.length - after.length),
        },
        selection: { anchor: from, head: to - before.length - after.length },
        userEvent: "input.format",
      });
      return true;
    }

    const docBefore = view.state.sliceDoc(Math.max(0, from - before.length), from);
    const docAfter = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + after.length));
    if (docBefore === before && docAfter === after) {
      view.dispatch({
        changes: [
          { from: to, to: to + after.length, insert: "" },
          { from: from - before.length, to: from, insert: "" },
        ],
        selection: { anchor: from - before.length, head: to - before.length },
        userEvent: "input.format",
      });
      return true;
    }

    // 若用户单行框选时包含了行首的列表或标题前缀（如三击选中整行），自动跳过前缀包裹正文
    const line = view.state.doc.lineAt(from);
    if (from === line.from) {
      const prefixMatch = selectedText.match(
        /^(\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+))/
      );
      if (prefixMatch && prefixMatch[0].length < selectedText.length) {
        const pLen = prefixMatch[0].length;
        const body = selectedText.slice(pLen).trimEnd();
        const trailLen = selectedText.length - pLen - body.length;
        if (
          body.startsWith(before) &&
          body.endsWith(after) &&
          body.length >= before.length + after.length
        ) {
          const unwrapped = body.slice(before.length, body.length - after.length);
          view.dispatch({
            changes: { from: from + pLen, to: to - trailLen, insert: unwrapped },
            selection: { anchor: from + pLen, head: from + pLen + unwrapped.length },
            userEvent: "input.format",
          });
          return true;
        }
        view.dispatch({
          changes: { from: from + pLen, to: to - trailLen, insert: `${before}${body}${after}` },
          selection: {
            anchor: from + pLen + before.length,
            head: from + pLen + before.length + body.length,
          },
          userEvent: "input.format",
        });
        return true;
      }
    }

    view.dispatch({
      changes: { from, to, insert: `${before}${selectedText}${after}` },
      selection: { anchor: from + before.length, head: to + before.length },
      userEvent: "input.format",
    });
    return true;
  }

  const line = view.state.doc.lineAt(from);
  const relPos = from - line.from;
  const lineText = line.text;

  if (before === "**" || before === "*") {
    const tripleRegex = /\*\*\*([^*]+?)\*\*\*/g;
    let tm: RegExpExecArray | null;
    while ((tm = tripleRegex.exec(lineText)) !== null) {
      const mStart = tm.index;
      const mEnd = tm.index + tm[0].length;
      if (relPos >= mStart && relPos <= mEnd) {
        const inner = tm[1];
        const remainDelim = before === "**" ? "*" : "**";
        const replacement = `${remainDelim}${inner}${remainDelim}`;
        const startInDoc = line.from + mStart;
        const endInDoc = line.from + mEnd;
        const newCursorPos = Math.min(
          Math.max(startInDoc + remainDelim.length, from - before.length),
          startInDoc + remainDelim.length + inner.length
        );
        view.dispatch({
          changes: { from: startInDoc, to: endInDoc, insert: replacement },
          selection: { anchor: newCursorPos },
          userEvent: "input.format",
        });
        return true;
      }
    }
  }

  const escB = escapeRegex(before);
  const escA = escapeRegex(after);
  const singleChar = before.length === 1 ? escapeRegex(before[0]) : "";
  const regex =
    before === "*"
      ? /(?<!\*)\*([^*]+?)\*(?!\*)/g
      : before === "**"
      ? /(?<!\*)\*\*([^*]+?)\*\*(?!\*)/g
      : singleChar
      ? new RegExp(`(?<!${singleChar})${escB}([^${singleChar}]+?)${escA}(?!${singleChar})`, "g")
      : new RegExp(`${escB}(.+?)${escA}`, "g");

  let m: RegExpExecArray | null;
  while ((m = regex.exec(lineText)) !== null) {
    const matchStart = m.index;
    const matchEnd = m.index + m[0].length;
    if (relPos >= matchStart && relPos <= matchEnd) {
      const innerContent = m[1];
      const startInDoc = line.from + matchStart;
      const endInDoc = line.from + matchEnd;
      const newCursorPos = Math.min(
        Math.max(startInDoc, from - before.length),
        startInDoc + innerContent.length
      );
      view.dispatch({
        changes: { from: startInDoc, to: endInDoc, insert: innerContent },
        selection: { anchor: newCursorPos },
        userEvent: "input.format",
      });
      return true;
    }
  }

  view.dispatch({
    changes: { from, insert: `${before}${after}` },
    selection: { anchor: from + before.length },
    userEvent: "input.format",
  });
  return true;
}

/**
 * 列表、引用块、代码块与普通段落智能回车续行与退出状态机
 */
export function handleListEnter(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;

  const doc = view.state.doc;
  const line = doc.lineAt(selection.head);
  const text = line.text;
  const struct = getDocStructureFromState(view.state);

  // 0. 围栏代码块内部智能回车：支持自动继承代码缩进、花括号/冒号增缩进及 `{|}` 对称展开
  const activeCodeRange = struct.codeRanges.find(
    (r) => line.number > r.startLine && (r.unclosed || line.number < r.endLine)
  );
  if (activeCodeRange) {
    const relOffset = selection.head - line.from;
    const beforeCursor = text.slice(0, relOffset);
    const afterCursor = text.slice(relOffset);
    const currentIndent = (beforeCursor.match(/^[ \t]*/)?.[0] || "").replace(/\t/g, "  ");
    const lang = (activeCodeRange.lang || "").toLowerCase();
    const indentUnit = ["rust", "rs", "python", "py", "java", "c", "cpp", "csharp", "go"].includes(
      lang
    )
      ? "    "
      : "  ";

    const trimmedBefore = beforeCursor.trimEnd();
    const trimmedAfter = afterCursor.trimStart();
    const leadSpacesInAfter = afterCursor.length - trimmedAfter.length;

    const opensBlock = /[{[(]$/.test(trimmedBefore);
    const opensColon =
      ["python", "py", "yaml", "yml"].includes(lang) && /:$/.test(trimmedBefore);
    const closesMatchingPair =
      (trimmedBefore.endsWith("{") && trimmedAfter.startsWith("}")) ||
      (trimmedBefore.endsWith("[") && trimmedAfter.startsWith("]")) ||
      (trimmedBefore.endsWith("(") && trimmedAfter.startsWith(")"));

    if (closesMatchingPair) {
      const midLine = `\n${currentIndent}${indentUnit}`;
      const closeLine = `\n${currentIndent}`;
      view.dispatch({
        changes: {
          from: selection.head,
          to: selection.head + leadSpacesInAfter,
          insert: `${midLine}${closeLine}`,
        },
        selection: { anchor: selection.head + midLine.length },
        scrollIntoView: true,
        userEvent: "input.enter",
      });
      return true;
    }

    const nextIndent =
      opensBlock || opensColon ? `${currentIndent}${indentUnit}` : currentIndent;
    const insertStr = `\n${nextIndent}`;
    view.dispatch({
      changes: {
        from: selection.head,
        to: selection.head + leadSpacesInAfter,
        insert: insertStr,
      },
      selection: { anchor: selection.head + insertStr.length },
      scrollIntoView: true,
      userEvent: "input.enter",
    });
    return true;
  }

  // 若位于 YAML Front Matter、Mermaid 或数学公式块内部，交由默认回车处理
  if (struct.codeLineSet.has(line.number)) {
    return false;
  }

  const quotePrefixMatch = text.match(/^(\s*(?:> ?)+)/);
  const quotePrefix = quotePrefixMatch ? quotePrefixMatch[1] : "";
  const quoteLen = quotePrefix.length;
  const restText = text.slice(quoteLen);

  // 计算光标右侧紧邻的多余空格数，拆分行时自动吞掉，杜绝回车后新行开头多出空格
  const countTrailingSpacesAtCursor = (minPos: number): number => {
    const start = Math.max(selection.head, minPos);
    const after = doc.sliceString(start, line.to);
    const m = after.match(/^[ \t]+/);
    return m ? m[0].length : 0;
  };

  // 构建回退到父列表层级的行前缀与重编号变更
  const buildOutdentListDispatch = (currentIndentLen: number) => {
    if (currentIndentLen > 0) {
      const parentSpec = findParentListSpec(doc, line.number, quotePrefix, currentIndentLen);
      let newPrefix = `${quotePrefix}${parentSpec.indent}- `;
      const changes: ChangeSpec[] = [];

      if (parentSpec.kind === "ordered") {
        const parentNextNum = computeExpectedOrderedNumber(
          doc,
          line.number,
          quotePrefix,
          parentSpec.indent.length
        );
        newPrefix = `${quotePrefix}${parentSpec.indent}${parentNextNum}. `;
        changes.push(
          { from: line.from, to: line.to, insert: newPrefix },
          ...buildSubsequentRenumberChanges(
            doc,
            line.number + 1,
            quotePrefix,
            parentSpec.indent.length,
            parentNextNum + 1
          )
        );
      } else if (parentSpec.kind === "task") {
        newPrefix = `${quotePrefix}${parentSpec.indent}${parentSpec.bulletChar} [ ] `;
        changes.push({ from: line.from, to: line.to, insert: newPrefix });
      } else {
        newPrefix = `${quotePrefix}${parentSpec.indent}${parentSpec.bulletChar} `;
        changes.push({ from: line.from, to: line.to, insert: newPrefix });
      }

      view.dispatch({
        changes,
        selection: { anchor: line.from + newPrefix.length },
        scrollIntoView: true,
        userEvent: "input.enter",
      });
      return true;
    }

    const fallbackLine = quotePrefix ? quotePrefix.trimEnd() + " " : "";
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: fallbackLine },
      selection: { anchor: line.from + fallbackLine.length },
      scrollIntoView: true,
      userEvent: "input.enter",
    });
    return true;
  };

  // 1. 匹配任务列表（兼容末尾空格被删的空任务项如 `- [ ]`）
  const taskMatch = restText.match(/^(\s*)([-*+]\s+\[[ xX]\]\s*)(.*)$/);
  if (taskMatch && (taskMatch[2].endsWith(" ") || taskMatch[3].trim() === "")) {
    const rawIndent = taskMatch[1].replace(/\t/g, "  ");
    const alignedIndent = " ".repeat(rawIndent.length - (rawIndent.length % 2));
    const prefix = taskMatch[2];
    const content = taskMatch[3];
    const prefixEndPos = line.from + quoteLen + taskMatch[1].length + prefix.length;

    if (content.trim() === "") {
      return buildOutdentListDispatch(rawIndent.length);
    }

    if (selection.head < prefixEndPos) {
      view.dispatch({
        changes: { from: line.from, insert: `${quotePrefix}\n` },
        selection: { anchor: selection.head + quotePrefix.length + 1 },
        scrollIntoView: true,
      });
      return true;
    }

    const bulletChar = prefix.trim()[0] || "-";
    const nextPrefix = `${quotePrefix}${alignedIndent}${bulletChar} [ ] `;
    const skipRightSpaces = countTrailingSpacesAtCursor(prefixEndPos);
    view.dispatch({
      changes: {
        from: selection.head,
        to: selection.head + skipRightSpaces,
        insert: `\n${nextPrefix}`,
      },
      selection: { anchor: selection.head + 1 + nextPrefix.length },
      scrollIntoView: true,
      userEvent: "input.enter",
    });
    return true;
  }

  // 2. 匹配有序列表（兼容末尾空格被删的空有序列表项如 `  1.`）
  const orderedMatch = restText.match(/^(\s*)(\d+)(\.\s*)(.*)$/);
  if (orderedMatch && (orderedMatch[3].length >= 2 || orderedMatch[4].trim() === "")) {
    const rawIndent = orderedMatch[1].replace(/\t/g, "  ");
    const alignedIndent = " ".repeat(rawIndent.length - (rawIndent.length % 2));
    const num = parseInt(orderedMatch[2], 10);
    const dotSpace = orderedMatch[3];
    const content = orderedMatch[4];
    const prefixEndPos =
      line.from + quoteLen + orderedMatch[1].length + orderedMatch[2].length + dotSpace.length;

    if (content.trim() === "") {
      return buildOutdentListDispatch(rawIndent.length);
    }

    if (selection.head < prefixEndPos) {
      view.dispatch({
        changes: { from: line.from, insert: `${quotePrefix}\n` },
        selection: { anchor: selection.head + quotePrefix.length + 1 },
        scrollIntoView: true,
      });
      return true;
    }

    const nextNum = num + 1;
    const nextPrefix = `${quotePrefix}${alignedIndent}${nextNum}. `;
    const skipRightSpaces = countTrailingSpacesAtCursor(prefixEndPos);
    const changes: ChangeSpec[] = [
      {
        from: selection.head,
        to: selection.head + skipRightSpaces,
        insert: `\n${nextPrefix}`,
      },
      ...buildSubsequentRenumberChanges(
        doc,
        line.number + 1,
        quotePrefix,
        alignedIndent.length,
        nextNum + 1
      ),
    ];

    view.dispatch({
      changes,
      selection: { anchor: selection.head + 1 + nextPrefix.length },
      scrollIntoView: true,
      userEvent: "input.enter",
    });
    return true;
  }

  // 3. 匹配无序列表（兼容末尾空格被删的空无序列表项如 `  -`）
  const bulletMatch = restText.match(/^(\s*)([-*+])(\s*)(.*)$/);
  if (
    bulletMatch &&
    !/^(\-{3,}|\*{3,})$/.test(restText.trim()) &&
    (bulletMatch[3].length >= 1 || bulletMatch[4].trim() === "")
  ) {
    const rawIndent = bulletMatch[1].replace(/\t/g, "  ");
    const alignedIndent = " ".repeat(rawIndent.length - (rawIndent.length % 2));
    const bullet = bulletMatch[2];
    const space = bulletMatch[3];
    const content = bulletMatch[4];
    const prefixEndPos =
      line.from + quoteLen + bulletMatch[1].length + bullet.length + space.length;

    if (content.trim() === "") {
      return buildOutdentListDispatch(rawIndent.length);
    }

    if (selection.head < prefixEndPos) {
      view.dispatch({
        changes: { from: line.from, insert: `${quotePrefix}\n` },
        selection: { anchor: selection.head + quotePrefix.length + 1 },
        scrollIntoView: true,
      });
      return true;
    }

    const nextPrefix = `${quotePrefix}${alignedIndent}${bullet} `;
    const skipRightSpaces = countTrailingSpacesAtCursor(prefixEndPos);
    view.dispatch({
      changes: {
        from: selection.head,
        to: selection.head + skipRightSpaces,
        insert: `\n${nextPrefix}`,
      },
      selection: { anchor: selection.head + 1 + nextPrefix.length },
      scrollIntoView: true,
      userEvent: "input.enter",
    });
    return true;
  }

  // 4. 匹配纯引用块
  if (quotePrefix) {
    const content = restText;
    const normalizedPrefix = quotePrefix.endsWith(" ") ? quotePrefix : quotePrefix + " ";

    if (content.trim() === "") {
      const quoteDepth = (quotePrefix.match(/>/g) || []).length;
      if (quoteDepth > 1) {
        const reducedPrefix = "> ".repeat(quoteDepth - 1);
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: reducedPrefix },
          selection: { anchor: line.from + reducedPrefix.length },
          scrollIntoView: true,
        });
        return true;
      }
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: "" },
        selection: { anchor: line.from },
        scrollIntoView: true,
      });
      return true;
    }

    const skipRightSpaces = countTrailingSpacesAtCursor(line.from + quoteLen);
    view.dispatch({
      changes: {
        from: selection.head,
        to: selection.head + skipRightSpaces,
        insert: `\n${normalizedPrefix}`,
      },
      selection: { anchor: selection.head + 1 + normalizedPrefix.length },
      scrollIntoView: true,
    });
    return true;
  }

  // 5. 普通段落行若意外带有行首缩进空格，拦截默认 insertNewlineAndIndent 防止将行首空格传染给后续所有段落
  if (/^[ \t]+/.test(text)) {
    if (text.trim() === "") {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: "\n" },
        selection: { anchor: line.from + 1 },
        scrollIntoView: true,
        userEvent: "input.enter",
      });
      return true;
    }
    const skipRightSpaces = countTrailingSpacesAtCursor(line.from);
    view.dispatch({
      changes: {
        from: selection.head,
        to: selection.head + skipRightSpaces,
        insert: "\n",
      },
      selection: { anchor: selection.head + 1 },
      scrollIntoView: true,
      userEvent: "input.enter",
    });
    return true;
  }

  return false;
}

/**
 * 列表与引用块退格键智能回退 (Backspace)
 */
export function handleListBackspace(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;

  const doc = view.state.doc;
  const line = doc.lineAt(selection.head);
  const text = line.text;

  // 若在非代码块纯空白缩进行末尾按退格，一次性清空所有残留缩进空格
  if (/^[ \t]+$/.test(text) && !isInsideCodeContextAST(view.state, selection.head)) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: "" },
      selection: { anchor: line.from },
    });
    return true;
  }

  const quotePrefixMatch = text.match(/^(\s*(?:> ?)+)/);
  const quotePrefix = quotePrefixMatch ? quotePrefixMatch[1] : "";
  const quoteLen = quotePrefix.length;
  const restText = text.slice(quoteLen);

  const listMatch = restText.match(/^(\s*)([-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d+\.\s+)/);
  if (listMatch && selection.head === line.from + quoteLen + listMatch[0].length) {
    const indent = listMatch[1];
    const prefix = listMatch[2];
    const isOrdered = /^\d+\.\s+$/.test(prefix);

    if (indent.length > 0) {
      const parentSpec = findParentListSpec(doc, line.number, quotePrefix, indent.length);
      const newIndent = parentSpec.indent;
      let newPrefix = prefix;
      const extraChanges: ChangeSpec[] = [];

      if (isOrdered) {
        const expectedNum = computeExpectedOrderedNumber(
          doc,
          line.number,
          quotePrefix,
          newIndent.length
        );
        newPrefix = `${expectedNum}. `;
        extraChanges.push(
          ...buildSubsequentRenumberChanges(
            doc,
            line.number + 1,
            quotePrefix,
            newIndent.length,
            expectedNum + 1
          )
        );
      }

      const replacement = `${quotePrefix}${newIndent}${newPrefix}`;
      view.dispatch({
        changes: [
          {
            from: line.from,
            to: line.from + quoteLen + listMatch[0].length,
            insert: replacement,
          },
          ...extraChanges,
        ],
        selection: { anchor: line.from + replacement.length },
      });
      return true;
    } else {
      const extraChanges: ChangeSpec[] = [];
      if (isOrdered) {
        const prevExpected = computeExpectedOrderedNumber(doc, line.number, quotePrefix, 0);
        extraChanges.push(
          ...buildSubsequentRenumberChanges(doc, line.number + 1, quotePrefix, 0, prevExpected)
        );
      }
      view.dispatch({
        changes: [
          {
            from: line.from + quoteLen,
            to: line.from + quoteLen + listMatch[0].length,
            insert: "",
          },
          ...extraChanges,
        ],
        selection: { anchor: line.from + quoteLen },
      });
      return true;
    }
  }

  if (quotePrefix && selection.head === line.from + quoteLen) {
    const quoteDepth = (quotePrefix.match(/>/g) || []).length;
    if (quoteDepth > 1) {
      const reducedPrefix = "> ".repeat(quoteDepth - 1);
      view.dispatch({
        changes: { from: line.from, to: line.from + quoteLen, insert: reducedPrefix },
        selection: { anchor: line.from + reducedPrefix.length },
      });
      return true;
    } else {
      view.dispatch({
        changes: { from: line.from, to: line.from + quoteLen, insert: "" },
        selection: { anchor: line.from },
      });
      return true;
    }
  }

  return false;
}

/**
 * 列表与引用块缩进/反缩进 (Tab / Shift-Tab)
 * 显式维护光标 selection 偏移，彻底杜绝行首按 Tab 后光标滞留在缩进空格或 > 左侧的同类问题
 */
export function handleListTab(view: EditorView, isShift: boolean): boolean {
  const doc = view.state.doc;
  const selection = view.state.selection.main;
  const startLineNum = doc.lineAt(selection.from).number;
  const endLineNum = doc.lineAt(
    selection.to > selection.from && doc.lineAt(selection.to).from === selection.to
      ? selection.to - 1
      : selection.to
  ).number;

  // 1. 多行框选批量列表/段落缩进
  if (endLineNum > startLineNum) {
    const changes: ChangeSpec[] = [];
    let anyHandled = false;

    for (let ln = startLineNum; ln <= endLineNum; ln++) {
      const l = doc.line(ln);
      const quoteMatch = l.text.match(/^(\s*(?:> ?)+)/);
      const quotePrefix = quoteMatch ? quoteMatch[1] : "";
      const qLen = quotePrefix.length;
      const rest = l.text.slice(qLen);

      if (isShift) {
        const removeLen = rest.startsWith("  ") ? 2 : rest.startsWith(" ") ? 1 : 0;
        if (removeLen > 0) {
          changes.push({ from: l.from + qLen, to: l.from + qLen + removeLen, insert: "" });
          anyHandled = true;
        }
      } else {
        changes.push({ from: l.from + qLen, insert: "  " });
        anyHandled = true;
      }
    }

    if (anyHandled) {
      view.dispatch({ changes, userEvent: isShift ? "delete.dedent" : "input.indent" });
      return true;
    }
    return false;
  }

  // 2. 单行精细列表与引用块缩进及有序列表智能重编号
  const line = doc.line(startLineNum);
  const text = line.text;

  const quotePrefixMatch = text.match(/^(\s*(?:> ?)+)/);
  const quotePrefix = quotePrefixMatch ? quotePrefixMatch[1] : "";
  const quoteLen = quotePrefix.length;
  const restText = text.slice(quoteLen);

  const orderedMatch = restText.match(/^(\s*)(\d+)(\.\s+)(.*)$/);
  if (orderedMatch) {
    const oldIndent = orderedMatch[1].replace(/\t/g, "  ");
    const oldNumStr = orderedMatch[2];
    const dotSpace = orderedMatch[3];

    if (isShift && oldIndent.length === 0) {
      return true;
    }

    const newIndent = isShift
      ? findParentListSpec(doc, line.number, quotePrefix, oldIndent.length).indent
      : `${" ".repeat(oldIndent.length - (oldIndent.length % 2))}  `;

    const newNum = computeExpectedOrderedNumber(
      doc,
      line.number,
      quotePrefix,
      newIndent.length
    );
    const newNumStr = String(newNum);

    const oldPrefixLen = quoteLen + orderedMatch[1].length + oldNumStr.length + dotSpace.length;
    const newPrefix = `${quotePrefix}${newIndent}${newNumStr}. `;
    const prefixDelta = newPrefix.length - oldPrefixLen;

    const changes: ChangeSpec[] = [
      {
        from: line.from,
        to: line.from + oldPrefixLen,
        insert: newPrefix,
      },
    ];

    const oldExpectedAtCurrent = computeExpectedOrderedNumber(
      doc,
      line.number,
      quotePrefix,
      oldIndent.length
    );
    changes.push(
      ...buildSubsequentRenumberChanges(
        doc,
        line.number + 1,
        quotePrefix,
        oldIndent.length,
        oldExpectedAtCurrent
      )
    );
    if (newIndent.length !== oldIndent.length) {
      changes.push(
        ...buildSubsequentRenumberChanges(
          doc,
          line.number + 1,
          quotePrefix,
          newIndent.length,
          newNum + 1
        )
      );
    }

    const newCursorHead = Math.max(
      line.from + newPrefix.length,
      selection.head + prefixDelta
    );

    view.dispatch({
      changes,
      selection: { anchor: newCursorHead },
      userEvent: isShift ? "delete.dedent" : "input.indent",
    });
    return true;
  }

  const unorderedMatch = restText.match(/^(\s*)([-*+]\s+(?:\[[ xX]\]\s+)?)/);
  if (unorderedMatch) {
    const insertPos = line.from + quoteLen;
    const oldIndentLen = unorderedMatch[1].length;
    const markerLen = unorderedMatch[2].length;
    if (isShift) {
      const rem = restText.startsWith("  ") ? 2 : restText.startsWith(" ") ? 1 : 0;
      if (rem > 0) {
        const minRightPos = insertPos + (oldIndentLen - rem) + markerLen;
        view.dispatch({
          changes: { from: insertPos, to: insertPos + rem, insert: "" },
          selection: { anchor: Math.max(minRightPos, selection.head - rem) },
        });
      }
      return true;
    } else {
      const minRightPos = insertPos + oldIndentLen + 2 + markerLen;
      view.dispatch({
        changes: { from: insertPos, insert: "  " },
        selection: { anchor: Math.max(minRightPos, selection.head + 2) },
      });
      return true;
    }
  }

  if (quotePrefix) {
    const quoteDepth = (quotePrefix.match(/>/g) || []).length;
    if (isShift) {
      if (quoteDepth > 1) {
        const reduced = "> ".repeat(quoteDepth - 1);
        const delta = reduced.length - quoteLen;
        view.dispatch({
          changes: { from: line.from, to: line.from + quoteLen, insert: reduced },
          selection: {
            anchor: Math.max(line.from + reduced.length, selection.head + delta),
          },
        });
        return true;
      }
    } else if (quoteDepth < 3) {
      const increased = "> ".repeat(quoteDepth + 1);
      const delta = increased.length - quoteLen;
      view.dispatch({
        changes: { from: line.from, to: line.from + quoteLen, insert: increased },
        selection: {
          anchor: Math.max(line.from + increased.length, selection.head + delta),
        },
      });
      return true;
    }
    return false;
  }

  return false;
}

/**
 * 切换当前行或多行选区的标题层级 (H1 ~ H6，支持引用块内标题切换及多块框选批量转换)
 * 彻底修复按 Ctrl+1~6 后光标落在 ## 左侧而非右侧的问题，以及框选多行点击 H1~H3 只转换第一行的问题
 */
export function toggleHeadingLevel(view: EditorView, level: number): boolean {
  const doc = view.state.doc;
  const selection = view.state.selection.main;
  const startLineNum = doc.lineAt(selection.from).number;
  const endLineNum = doc.lineAt(
    selection.to > selection.from && doc.lineAt(selection.to).from === selection.to
      ? selection.to - 1
      : selection.to
  ).number;

  // 多行框选：批量切换选区内所有非空行的标题级别
  if (endLineNum > startLineNum) {
    const struct = getDocStructureFromState(view.state);
    const changes: ChangeSpec[] = [];
    const targetLines: Array<{
      lineNum: number;
      basePos: number;
      oldPrefixEnd: number;
      currentLevel: number;
    }> = [];

    for (let ln = startLineNum; ln <= endLineNum; ln++) {
      if (struct.codeLineSet.has(ln)) continue;
      const line = doc.line(ln);
      if (!line.text.trim()) continue;
      const quoteMatch = line.text.match(/^(\s*(?:> ?)+)/);
      const quoteLen = quoteMatch ? quoteMatch[1].length : 0;
      const rest = line.text.slice(quoteLen);
      const existingPrefixMatch = rest.match(
        /^(?:(#{1,6})\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/
      );
      const oldPrefixLen = existingPrefixMatch ? existingPrefixMatch[0].length : 0;
      const curLvl = existingPrefixMatch?.[1] ? existingPrefixMatch[1].length : 0;
      targetLines.push({
        lineNum: ln,
        basePos: line.from + quoteLen,
        oldPrefixEnd: line.from + quoteLen + oldPrefixLen,
        currentLevel: curLvl,
      });
    }

    if (targetLines.length === 0) return false;
    const allAlreadyAtLevel =
      level > 0 && targetLines.every((t) => t.currentLevel === level);
    const newPrefix = level === 0 || allAlreadyAtLevel ? "" : `${"#".repeat(level)} `;

    for (const t of targetLines) {
      changes.push({
        from: t.basePos,
        to: t.oldPrefixEnd,
        insert: newPrefix,
      });
    }

    view.dispatch({
      changes,
      userEvent: "input.format",
    });
    return true;
  }

  const line = doc.lineAt(selection.head);
  const text = line.text;

  const quotePrefixMatch = text.match(/^(\s*(?:> ?)+)/);
  const quoteLen = quotePrefixMatch ? quotePrefixMatch[1].length : 0;
  const restText = text.slice(quoteLen);

  const currentMatch = restText.match(/^(#{1,6})\s+/);
  const oldPrefixLen = currentMatch ? currentMatch[0].length : 0;
  const currentLevel = currentMatch ? currentMatch[1].length : 0;

  const newPrefix =
    level === 0 || currentLevel === level ? "" : `${"#".repeat(level)} `;
  const basePos = line.from + quoteLen;
  const oldPrefixEnd = basePos + oldPrefixLen;
  const newPrefixEnd = basePos + newPrefix.length;

  const mapCursor = (pos: number) =>
    pos <= oldPrefixEnd ? newPrefixEnd : pos + (newPrefix.length - oldPrefixLen);

  view.dispatch({
    changes: {
      from: basePos,
      to: oldPrefixEnd,
      insert: newPrefix,
    },
    selection: {
      anchor: mapCursor(selection.anchor),
      head: mapCursor(selection.head),
    },
    userEvent: "input.format",
  });
  return true;
}

export const formattingKeymap: KeyBinding[] = [
  {
    key: "Enter",
    run: handleListEnter,
  },
  {
    key: "Backspace",
    run: handleListBackspace,
  },
  {
    key: "Tab",
    run: (view) => handleListTab(view, false),
  },
  {
    key: "Shift-Tab",
    run: (view) => handleListTab(view, true),
  },
  {
    key: "Alt-ArrowUp",
    run: (view) => moveCurrentSemanticBlock(view, -1),
  },
  {
    key: "Alt-ArrowDown",
    run: (view) => moveCurrentSemanticBlock(view, 1),
  },
  {
    key: "Mod-d",
    run: (view) => duplicateCurrentSemanticBlock(view),
  },
  {
    key: "Mod-b",
    run: (view) => smartToggleFormat(view, "**"),
  },
  {
    key: "Mod-i",
    run: (view) => smartToggleFormat(view, "*"),
  },
  {
    key: "Mod-Shift-x",
    run: (view) => smartToggleFormat(view, "~~"),
  },
  {
    key: "Mod-Shift-h",
    run: (view) => smartToggleFormat(view, "=="),
  },
  {
    key: "Mod-e",
    run: (view) => smartToggleFormat(view, "`"),
  },
  {
    key: "Mod-`",
    run: (view) => smartToggleFormat(view, "`"),
  },
  {
    key: "Mod-m",
    run: (view) => smartToggleFormat(view, "$"),
  },
  {
    key: "Mod-k",
    run: (view) => {
      const selection = view.state.selection.main;
      const from = selection.from;
      const to = selection.to;
      const text = view.state.sliceDoc(from, to);

      const balancedInSel = parseBalancedLinksAndImages(text, 0);
      if (
        balancedInSel.length === 1 &&
        !balancedInSel[0].isImage &&
        balancedInSel[0].start === 0 &&
        balancedInSel[0].end === text.length
      ) {
        const label = balancedInSel[0].label;
        view.dispatch({
          changes: { from, to, insert: label },
          selection: { anchor: from, head: from + label.length },
        });
        return true;
      }

      if (from === to) {
        const line = view.state.doc.lineAt(from);
        const relPos = from - line.from;
        const balancedLinks = parseBalancedLinksAndImages(line.text, 0);
        for (const bm of balancedLinks) {
          if (!bm.isImage && relPos >= bm.start && relPos <= bm.end) {
            const innerText = bm.label;
            const startInDoc = line.from + bm.start;
            const endInDoc = line.from + bm.end;
            view.dispatch({
              changes: { from: startInDoc, to: endInDoc, insert: innerText },
              selection: { anchor: startInDoc, head: startInDoc + innerText.length },
            });
            return true;
          }
        }
      }

      const linkText = text || "链接文字";
      const insertStr = `[${linkText}](https://)`;
      view.dispatch({
        changes: { from, to, insert: insertStr },
        selection: { anchor: from + linkText.length + 3, head: from + insertStr.length - 1 },
      });
      return true;
    },
  },
  {
    key: "Mod-Shift-i",
    run: (view) => {
      const selection = view.state.selection.main;
      const selectedAlt = view.state.sliceDoc(selection.from, selection.to).trim() || "图片说明";
      const insertStr = `![${selectedAlt}](url)`;
      const urlStart = selection.from + 4 + selectedAlt.length;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: insertStr },
        selection: { anchor: urlStart, head: urlStart + 3 },
      });
      return true;
    },
  },
  {
    key: "Mod-Shift-k",
    run: (view) => {
      const selection = view.state.selection.main;
      const line = view.state.doc.lineAt(selection.head);
      const isLineEmpty = line.text.trim().length === 0;
      const prefix = isLineEmpty ? "" : "\n";
      const insertPos = isLineEmpty ? line.from : line.to;
      const insertStr = `${prefix}\`\`\`\n\n\`\`\`\n`;
      const cursorOffset = prefix.length + 4;
      view.dispatch({
        changes: { from: insertPos, to: line.to, insert: insertStr },
        selection: { anchor: insertPos + cursorOffset },
      });
      return true;
    },
  },
  {
    key: "Mod-Shift-m",
    run: (view) => {
      const selection = view.state.selection.main;
      const line = view.state.doc.lineAt(selection.head);
      const isLineEmpty = line.text.trim().length === 0;
      const prefix = isLineEmpty ? "" : "\n";
      const insertPos = isLineEmpty ? line.from : line.to;
      const insertStr = `${prefix}$$\n\n$$\n`;
      const cursorOffset = prefix.length + 3;
      view.dispatch({
        changes: { from: insertPos, to: line.to, insert: insertStr },
        selection: { anchor: insertPos + cursorOffset },
      });
      return true;
    },
  },
  { key: "Mod-1", run: (view) => toggleHeadingLevel(view, 1) },
  { key: "Mod-2", run: (view) => toggleHeadingLevel(view, 2) },
  { key: "Mod-3", run: (view) => toggleHeadingLevel(view, 3) },
  { key: "Mod-4", run: (view) => toggleHeadingLevel(view, 4) },
  { key: "Mod-5", run: (view) => toggleHeadingLevel(view, 5) },
  { key: "Mod-6", run: (view) => toggleHeadingLevel(view, 6) },
  { key: "Mod-0", run: (view) => toggleHeadingLevel(view, 0) },
  { key: "Mod-Alt-1", run: (view) => toggleHeadingLevel(view, 1) },
  { key: "Mod-Alt-2", run: (view) => toggleHeadingLevel(view, 2) },
  { key: "Mod-Alt-3", run: (view) => toggleHeadingLevel(view, 3) },
  { key: "Mod-Alt-4", run: (view) => toggleHeadingLevel(view, 4) },
  { key: "Mod-Alt-5", run: (view) => toggleHeadingLevel(view, 5) },
  { key: "Mod-Alt-6", run: (view) => toggleHeadingLevel(view, 6) },
  { key: "Mod-Alt-0", run: (view) => toggleHeadingLevel(view, 0) },
];
