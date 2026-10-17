import { EditorView, KeyBinding } from "@codemirror/view";
import { ChangeSpec } from "@codemirror/state";

/**
 * 转义正则特殊字符
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    // 1. 检查选中文本是否已被定界符包裹，若已包裹则解开
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

    // 2. 检查选区外部紧邻是否正是定界符
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

    // 3. 正常包裹
    view.dispatch({
      changes: { from, to, insert: `${before}${selectedText}${after}` },
      selection: { anchor: from + before.length, head: to + before.length },
    });
    return true;
  }

  // 选区为空：检查光标是否停留在定界符包裹的词语内部 (智能解包)
  const line = view.state.doc.lineAt(from);
  const relPos = from - line.from;
  const lineText = line.text;

  // 优先处理 ***加粗斜体*** 内部切换 ** 或 *
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

  // 选区为空且不在格式块内：插入成对定界符并将光标置于中间
  view.dispatch({
    changes: { from, insert: `${before}${after}` },
    selection: { anchor: from + before.length },
  });
  return true;
}

/**
 * 列表与引用块智能回车续行与退出状态机
 * 完美支持：顶层列表、引用块内嵌套列表 (> - item / > 1. item / > - [ ] task)、多级缩进逐级退回、有序列表自动重编号
 */
export function handleListEnter(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;

  const doc = view.state.doc;
  const line = doc.lineAt(selection.head);
  const text = line.text;

  // 先提取可选的引用块前缀 (如 `> ` 或 `>> `)，保证每个 `>` 后只吃 1 个空格，保留后续列表缩进
  const quotePrefixMatch = text.match(/^(\s*(?:> ?)+)/);
  const quotePrefix = quotePrefixMatch ? quotePrefixMatch[1] : "";
  const quoteLen = quotePrefix.length;
  const restText = text.slice(quoteLen);

  // 1. 匹配任务列表 (支持顶层及引用块内部): ^(\s*)([-*+]\s+\[[ xX]\]\s+)(.*)$
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
      // 退出列表，若在引用块中则保留引用前缀 `> `，否则清空整行
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

  // 2. 匹配有序列表 (支持顶层及引用块内部): ^(\s*)(\d+)(\.\s+)(.*)$
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
        const newPrefix = `${quotePrefix}${newIndent}1. `;
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

    const nextNum = num + 1;
    const nextPrefix = `${quotePrefix}${indent}${nextNum}. `;
    const changes: ChangeSpec[] = [{ from: selection.head, insert: `\n${nextPrefix}` }];

    // 自动递增后续同级有序列表项的编号
    let expectedNum = nextNum + 1;
    for (let ln = line.number + 1; ln <= doc.lines; ln++) {
      const nextLine = doc.line(ln);
      if (!nextLine.text.startsWith(quotePrefix)) break;
      const subText = nextLine.text.slice(quoteLen);
      const m = subText.match(/^(\s*)(\d+)\.\s+/);
      if (!m) {
        if (subText.trim() === "") break;
        if ((subText.match(/^\s*/)?.[0].length || 0) > indent.length) continue;
        break;
      }
      if (m[1].length < indent.length) break;
      if (m[1].length === indent.length) {
        const oldNumStr = m[2];
        const numFrom = nextLine.from + quoteLen + m[1].length;
        changes.push({
          from: numFrom,
          to: numFrom + oldNumStr.length,
          insert: String(expectedNum),
        });
        expectedNum++;
      }
    }

    view.dispatch({
      changes,
      selection: { anchor: selection.head + 1 + nextPrefix.length },
    });
    return true;
  }

  // 3. 匹配无序列表 (支持顶层及引用块内部): ^(\s*)([-*+])(\s+)(.*)$
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

  // 4. 匹配纯引用块: ^(\s*(?:> ?)+)(.*)$
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

  const line = view.state.doc.lineAt(selection.head);
  const text = line.text;

  const quotePrefixMatch = text.match(/^(\s*(?:> ?)+)/);
  const quotePrefix = quotePrefixMatch ? quotePrefixMatch[1] : "";
  const quoteLen = quotePrefix.length;
  const restText = text.slice(quoteLen);

  // 优先检查引用块内部或顶层的列表前缀退格
  const listMatch = restText.match(/^(\s*)([-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d+\.\s+)/);
  if (listMatch && selection.head === line.from + quoteLen + listMatch[0].length) {
    const indent = listMatch[1];
    const prefix = listMatch[2];
    if (indent.length >= 2) {
      const newIndent = indent.slice(2);
      const replacement = `${quotePrefix}${newIndent}${prefix}`;
      view.dispatch({
        changes: {
          from: line.from,
          to: line.from + quoteLen + listMatch[0].length,
          insert: replacement,
        },
        selection: { anchor: line.from + replacement.length },
      });
      return true;
    } else {
      view.dispatch({
        changes: {
          from: line.from + quoteLen,
          to: line.from + quoteLen + listMatch[0].length,
          insert: "",
        },
        selection: { anchor: line.from + quoteLen },
      });
      return true;
    }
  }

  // 检查纯引用块前缀退格
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
 */
export function handleListTab(view: EditorView, isShift: boolean): boolean {
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.head);
  const text = line.text;

  const quotePrefixMatch = text.match(/^(\s*(?:> ?)+)/);
  const quotePrefix = quotePrefixMatch ? quotePrefixMatch[1] : "";
  const quoteLen = quotePrefix.length;
  const restText = text.slice(quoteLen);

  const isInnerList = /^(\s*)([-*+]|\d+\.)\s+/.test(restText);

  if (quotePrefix && isInnerList) {
    const insertPos = line.from + quoteLen;
    if (isShift) {
      if (restText.startsWith("  ")) {
        view.dispatch({
          changes: { from: insertPos, to: insertPos + 2, insert: "" },
        });
        return true;
      } else if (restText.startsWith(" ")) {
        view.dispatch({
          changes: { from: insertPos, to: insertPos + 1, insert: "" },
        });
        return true;
      }
    } else {
      view.dispatch({
        changes: { from: insertPos, insert: "  " },
      });
      return true;
    }
    return false;
  }

  if (quotePrefix && !isInnerList) {
    const quoteDepth = (quotePrefix.match(/>/g) || []).length;
    if (isShift) {
      if (quoteDepth > 1) {
        const reduced = "> ".repeat(quoteDepth - 1);
        view.dispatch({
          changes: { from: line.from, to: line.from + quoteLen, insert: reduced },
        });
        return true;
      }
    } else if (quoteDepth < 3) {
      const increased = "> ".repeat(quoteDepth + 1);
      view.dispatch({
        changes: { from: line.from, to: line.from + quoteLen, insert: increased },
      });
      return true;
    }
    return false;
  }

  if (isInnerList) {
    if (isShift) {
      if (text.startsWith("  ")) {
        view.dispatch({
          changes: { from: line.from, to: line.from + 2, insert: "" },
        });
        return true;
      } else if (text.startsWith(" ")) {
        view.dispatch({
          changes: { from: line.from, to: line.from + 1, insert: "" },
        });
        return true;
      }
    } else {
      view.dispatch({
        changes: { from: line.from, insert: "  " },
      });
      return true;
    }
  }

  return false;
}

/**
 * 切换当前行的标题层级 (H1 ~ H6，支持引用块内标题切换)
 */
export function toggleHeadingLevel(view: EditorView, level: number): boolean {
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.head);
  const text = line.text;

  const quotePrefixMatch = text.match(/^(\s*(?:> ?)+)/);
  const quoteLen = quotePrefixMatch ? quotePrefixMatch[1].length : 0;
  const restText = text.slice(quoteLen);

  const currentMatch = restText.match(/^(#{1,6})\s+/);
  const targetPrefix = level > 0 ? `${"#".repeat(level)} ` : "";
  const basePos = line.from + quoteLen;

  if (currentMatch) {
    const currentLevel = currentMatch[1].length;
    if (currentLevel === level || level === 0) {
      view.dispatch({
        changes: { from: basePos, to: basePos + currentMatch[0].length, insert: "" },
      });
    } else {
      view.dispatch({
        changes: {
          from: basePos,
          to: basePos + currentMatch[0].length,
          insert: targetPrefix,
        },
      });
    }
  } else if (level > 0) {
    view.dispatch({
      changes: { from: basePos, insert: targetPrefix },
    });
  }
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
  // 1. 加粗 (Mod+B)
  {
    key: "Mod-b",
    run: (view) => smartToggleFormat(view, "**"),
  },
  // 2. 斜体 (Mod+I)
  {
    key: "Mod-i",
    run: (view) => smartToggleFormat(view, "*"),
  },
  // 2.1 删除线 (Mod+Shift+X)
  {
    key: "Mod-Shift-x",
    run: (view) => smartToggleFormat(view, "~~"),
  },
  // 2.2 高亮 (Mod+Shift+H)
  {
    key: "Mod-Shift-h",
    run: (view) => smartToggleFormat(view, "=="),
  },
  // 3. 行内代码 (Mod+` 或 Mod+E)
  {
    key: "Mod-e",
    run: (view) => smartToggleFormat(view, "`"),
  },
  {
    key: "Mod-`",
    run: (view) => smartToggleFormat(view, "`"),
  },
  // 4. 超链接 (Mod+K) - 智能包裹与解包
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
  // 5. 插入图片 (Mod+Shift+I) - 保留选中文本作为 alt 说明
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
  // 6. 插入多行代码块 (Mod+Shift+K) - 定位至行尾避免截断当前句子
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
  // 7. 插入数学公式块 (Mod+Shift+M) - 定位至行尾避免截断当前句子
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
  // 8. 标题级别快捷切换 (Mod-1 ~ Mod-6 / Mod-Alt-1 ~ Mod-Alt-6) 与正文 (Mod-0 / Mod-Alt-0)
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
