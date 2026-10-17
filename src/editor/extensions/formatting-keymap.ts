import { EditorView, KeyBinding } from "@codemirror/view";
import { ChangeSpec, Text } from "@codemirror/state";
import { moveCurrentSemanticBlock, duplicateCurrentSemanticBlock } from "./block-handle";

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
 * 包装或插入定界符 (如 **bold**, *italic*, `code`, ~~del~~, ==mark==)
 * 智能支持反选 (再次按下快捷键取消格式，包括光标处于词内时的精确探测解包及 *** 复合解包)
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
      });
      return true;
    }

    view.dispatch({
      changes: { from, to, insert: `${before}${selectedText}${after}` },
      selection: { anchor: from + before.length, head: to + before.length },
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
      });
      return true;
    }
  }

  view.dispatch({
    changes: { from, insert: `${before}${after}` },
    selection: { anchor: from + before.length },
  });
  return true;
}

/**
 * 列表与引用块智能回车续行与退出状态机
 */
export function handleListEnter(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;

  const doc = view.state.doc;
  const line = doc.lineAt(selection.head);
  const text = line.text;

  const quotePrefixMatch = text.match(/^(\s*(?:> ?)+)/);
  const quotePrefix = quotePrefixMatch ? quotePrefixMatch[1] : "";
  const quoteLen = quotePrefix.length;
  const restText = text.slice(quoteLen);

  // 1. 匹配任务列表
  const taskMatch = restText.match(/^(\s*)([-*+]\s+\[[ xX]\]\s+)(.*)$/);
  if (taskMatch) {
    const indent = taskMatch[1];
    const prefix = taskMatch[2];
    const content = taskMatch[3];
    const prefixEndPos = line.from + quoteLen + indent.length + prefix.length;

    if (content.trim() === "") {
      if (indent.length >= 2) {
        const newIndent = indent.slice(2);
        const updatedLine = `${quotePrefix}${newIndent}${prefix}`;
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: updatedLine },
          selection: { anchor: line.from + updatedLine.length },
        });
        return true;
      }
      const fallbackLine = quotePrefix ? quotePrefix : "";
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: fallbackLine },
        selection: { anchor: line.from + fallbackLine.length },
      });
      return true;
    }

    if (selection.head < prefixEndPos) {
      view.dispatch({
        changes: { from: line.from, insert: `${quotePrefix}\n` },
        selection: { anchor: selection.head + quotePrefix.length + 1 },
      });
      return true;
    }

    const bulletChar = prefix.trim()[0] || "-";
    const nextPrefix = `${quotePrefix}${indent}${bulletChar} [ ] `;
    view.dispatch({
      changes: { from: selection.head, insert: `\n${nextPrefix}` },
      selection: { anchor: selection.head + 1 + nextPrefix.length },
    });
    return true;
  }

  // 2. 匹配有序列表
  const orderedMatch = restText.match(/^(\s*)(\d+)(\.\s+)(.*)$/);
  if (orderedMatch) {
    const indent = orderedMatch[1];
    const num = parseInt(orderedMatch[2], 10);
    const dotSpace = orderedMatch[3];
    const content = orderedMatch[4];
    const prefixEndPos =
      line.from + quoteLen + indent.length + orderedMatch[2].length + dotSpace.length;

    if (content.trim() === "") {
      if (indent.length >= 2) {
        const newIndent = indent.slice(2);
        const parentNextNum = computeExpectedOrderedNumber(
          doc,
          line.number,
          quotePrefix,
          newIndent.length
        );
        const newPrefix = `${quotePrefix}${newIndent}${parentNextNum}. `;
        const changes: ChangeSpec[] = [
          { from: line.from, to: line.to, insert: newPrefix },
          ...buildSubsequentRenumberChanges(
            doc,
            line.number + 1,
            quotePrefix,
            newIndent.length,
            parentNextNum + 1
          ),
        ];
        view.dispatch({
          changes,
          selection: { anchor: line.from + newPrefix.length },
        });
        return true;
      }
      const fallbackLine = quotePrefix ? quotePrefix : "";
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: fallbackLine },
        selection: { anchor: line.from + fallbackLine.length },
      });
      return true;
    }

    if (selection.head < prefixEndPos) {
      view.dispatch({
        changes: { from: line.from, insert: `${quotePrefix}\n` },
        selection: { anchor: selection.head + quotePrefix.length + 1 },
      });
      return true;
    }

    const nextNum = num + 1;
    const nextPrefix = `${quotePrefix}${indent}${nextNum}. `;
    const changes: ChangeSpec[] = [
      { from: selection.head, insert: `\n${nextPrefix}` },
      ...buildSubsequentRenumberChanges(
        doc,
        line.number + 1,
        quotePrefix,
        indent.length,
        nextNum + 1
      ),
    ];

    view.dispatch({
      changes,
      selection: { anchor: selection.head + 1 + nextPrefix.length },
    });
    return true;
  }

  // 3. 匹配无序列表
  const bulletMatch = restText.match(/^(\s*)([-*+])(\s+)(.*)$/);
  if (bulletMatch) {
    const indent = bulletMatch[1];
    const bullet = bulletMatch[2];
    const space = bulletMatch[3];
    const content = bulletMatch[4];
    const prefixEndPos = line.from + quoteLen + indent.length + bullet.length + space.length;

    if (content.trim() === "") {
      if (indent.length >= 2) {
        const newIndent = indent.slice(2);
        const newPrefix = `${quotePrefix}${newIndent}${bullet} `;
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: newPrefix },
          selection: { anchor: line.from + newPrefix.length },
        });
        return true;
      }
      const fallbackLine = quotePrefix ? quotePrefix : "";
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: fallbackLine },
        selection: { anchor: line.from + fallbackLine.length },
      });
      return true;
    }

    if (selection.head < prefixEndPos) {
      view.dispatch({
        changes: { from: line.from, insert: `${quotePrefix}\n` },
        selection: { anchor: selection.head + quotePrefix.length + 1 },
      });
      return true;
    }

    const nextPrefix = `${quotePrefix}${indent}${bullet} `;
    view.dispatch({
      changes: { from: selection.head, insert: `\n${nextPrefix}` },
      selection: { anchor: selection.head + 1 + nextPrefix.length },
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
        });
        return true;
      }
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: "" },
        selection: { anchor: line.from },
      });
      return true;
    }

    view.dispatch({
      changes: { from: selection.head, insert: `\n${normalizedPrefix}` },
      selection: { anchor: selection.head + 1 + normalizedPrefix.length },
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

  const quotePrefixMatch = text.match(/^(\s*(?:> ?)+)/);
  const quotePrefix = quotePrefixMatch ? quotePrefixMatch[1] : "";
  const quoteLen = quotePrefix.length;
  const restText = text.slice(quoteLen);

  const listMatch = restText.match(/^(\s*)([-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d+\.\s+)/);
  if (listMatch && selection.head === line.from + quoteLen + listMatch[0].length) {
    const indent = listMatch[1];
    const prefix = listMatch[2];
    const isOrdered = /^\d+\.\s+$/.test(prefix);

    if (indent.length >= 2) {
      const newIndent = indent.slice(2);
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
    const oldIndent = orderedMatch[1];
    const oldNumStr = orderedMatch[2];
    const dotSpace = orderedMatch[3];

    if (isShift && oldIndent.length === 0) {
      return true;
    }

    const newIndent = isShift
      ? oldIndent.slice(Math.min(2, oldIndent.length))
      : `${oldIndent}  `;

    const newNum = computeExpectedOrderedNumber(
      doc,
      line.number,
      quotePrefix,
      newIndent.length
    );
    const newNumStr = String(newNum);

    const oldPrefixLen = quoteLen + oldIndent.length + oldNumStr.length + dotSpace.length;
    const newPrefix = `${quotePrefix}${newIndent}${newNumStr}${dotSpace}`;
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
 * 切换当前行的标题层级 (H1 ~ H6，支持引用块内标题切换)
 * 彻底修复按 Ctrl+1~6 后光标落在 ## 左侧而非右侧的问题
 */
export function toggleHeadingLevel(view: EditorView, level: number): boolean {
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.head);
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
    key: "Mod-k",
    run: (view) => {
      const selection = view.state.selection.main;
      const from = selection.from;
      const to = selection.to;
      const text = view.state.sliceDoc(from, to);

      const linkMatch = text.match(/^\[(.*?)\]\((.*?)\)$/);
      if (linkMatch) {
        view.dispatch({
          changes: { from, to, insert: linkMatch[1] },
          selection: { anchor: from, head: from + linkMatch[1].length },
        });
        return true;
      }

      if (from === to) {
        const line = view.state.doc.lineAt(from);
        const relPos = from - line.from;
        const lineText = line.text;
        const regex = /\[(.*?)\]\((.*?)\)/g;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(lineText)) !== null) {
          if (relPos >= m.index && relPos <= m.index + m[0].length) {
            const innerText = m[1];
            const startInDoc = line.from + m.index;
            const endInDoc = line.from + m.index + m[0].length;
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
