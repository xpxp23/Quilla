import { EditorView, KeyBinding } from "@codemirror/view";

/**
 * 转义正则特殊字符
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 包装或插入定界符 (如 **bold**, *italic*, `code`, ~~del~~)
 * 智能支持反选 (再次按下快捷键取消格式，包括光标处于词内时的自动探测解包)
 */
export function smartToggleFormat(view: EditorView, before: string, after: string = before): boolean {
  const selection = view.state.selection.main;
  const from = selection.from;
  const to = selection.to;
  const selectedText = view.state.sliceDoc(from, to);

  if (selectedText.length > 0) {
    // 1. 检查选中文本是否已被定界符包裹，若已包裹则解开
    if (selectedText.startsWith(before) && selectedText.endsWith(after) && selectedText.length >= before.length + after.length) {
      view.dispatch({
        changes: { from, to, insert: selectedText.slice(before.length, selectedText.length - after.length) },
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

  const escB = escapeRegex(before);
  const escA = escapeRegex(after);
  const regex = new RegExp(`${escB}(.+?)${escA}`, "g");
  let m: RegExpExecArray | null;

  while ((m = regex.exec(lineText)) !== null) {
    const matchStart = m.index;
    const matchEnd = m.index + m[0].length;
    // 如果光标在该匹配区间内部 (包括定界符自身边缘)
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
 * 列表智能回车续行与退出状态机 (Typora 原生交互: 支持多级缩进逐级退出)
 */
export function handleListEnter(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;

  const line = view.state.doc.lineAt(selection.head);
  const text = line.text;

  // 1. 匹配任务列表: ^(\s*)([-*+]\s+\[[ xX]\]\s*)(.*)$
  const taskMatch = text.match(/^(\s*)([-*+]\s+\[[ xX]\]\s*)(.*)$/);
  if (taskMatch) {
    const indent = taskMatch[1];
    const prefix = taskMatch[2];
    const content = taskMatch[3];

    // 如果任务项内容为空
    if (content.trim() === "") {
      if (indent.length >= 2) {
        // 多级缩进：回车逐级减少缩进
        const newIndent = indent.slice(2);
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: `${newIndent}${prefix}` },
          selection: { anchor: line.from + newIndent.length + prefix.length },
        });
        return true;
      }
      // 顶层空任务项：再次按回车清除标记退出列表
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: "" },
        selection: { anchor: line.from },
      });
      return true;
    }

    // 自动续行下一任务项 - [ ]
    const nextPrefix = `${indent}- [ ] `;
    view.dispatch({
      changes: { from: selection.head, insert: `\n${nextPrefix}` },
      selection: { anchor: selection.head + 1 + nextPrefix.length },
    });
    return true;
  }

  // 2. 匹配有序列表: ^(\s*)(\d+)\.\s+(.*)$
  const orderedMatch = text.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (orderedMatch) {
    const indent = orderedMatch[1];
    const num = parseInt(orderedMatch[2], 10);
    const content = orderedMatch[3];

    if (content.trim() === "") {
      if (indent.length >= 2) {
        const newIndent = indent.slice(2);
        const newPrefix = `${newIndent}${num}. `;
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: newPrefix },
          selection: { anchor: line.from + newPrefix.length },
        });
        return true;
      }
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: "" },
        selection: { anchor: line.from },
      });
      return true;
    }

    const nextPrefix = `${indent}${num + 1}. `;
    view.dispatch({
      changes: { from: selection.head, insert: `\n${nextPrefix}` },
      selection: { anchor: selection.head + 1 + nextPrefix.length },
    });
    return true;
  }

  // 3. 匹配无序列表: ^(\s*)([-*+])\s+(.*)$
  const bulletMatch = text.match(/^(\s*)([-*+])\s+(.*)$/);
  if (bulletMatch) {
    const indent = bulletMatch[1];
    const bullet = bulletMatch[2];
    const content = bulletMatch[3];

    if (content.trim() === "") {
      if (indent.length >= 2) {
        const newIndent = indent.slice(2);
        const newPrefix = `${newIndent}${bullet} `;
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: newPrefix },
          selection: { anchor: line.from + newPrefix.length },
        });
        return true;
      }
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: "" },
        selection: { anchor: line.from },
      });
      return true;
    }

    const nextPrefix = `${indent}${bullet} `;
    view.dispatch({
      changes: { from: selection.head, insert: `\n${nextPrefix}` },
      selection: { anchor: selection.head + 1 + nextPrefix.length },
    });
    return true;
  }

  // 4. 匹配引用块: ^(\s*>)\s*(.*)$
  const quoteMatch = text.match(/^(\s*>)\s*(.*)$/);
  if (quoteMatch) {
    const prefix = quoteMatch[1];
    const content = quoteMatch[2];

    if (content.trim() === "") {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: "" },
        selection: { anchor: line.from },
      });
      return true;
    }

    const nextPrefix = `${prefix} `;
    view.dispatch({
      changes: { from: selection.head, insert: `\n${nextPrefix}` },
      selection: { anchor: selection.head + 1 + nextPrefix.length },
    });
    return true;
  }

  return false;
}

/**
 * 列表退格键智能回退 (Backspace)
 */
export function handleListBackspace(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;

  const line = view.state.doc.lineAt(selection.head);
  const text = line.text;

  // 仅当整行全为列表标记且光标正处于标记末尾时触发
  const match = text.match(/^(\s*)([-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d+\.\s+|> )/);
  if (match && selection.head === line.from + match[0].length) {
    const indent = match[1];
    const prefix = match[2];
    if (indent.length >= 2) {
      // 减一层缩进
      const newIndent = indent.slice(2);
      view.dispatch({
        changes: { from: line.from, to: line.from + match[0].length, insert: `${newIndent}${prefix}` },
        selection: { anchor: line.from + newIndent.length + prefix.length },
      });
      return true;
    } else {
      // 清空整行列表符号
      view.dispatch({
        changes: { from: line.from, to: line.from + match[0].length, insert: "" },
        selection: { anchor: line.from },
      });
      return true;
    }
  }
  return false;
}

/**
 * 列表缩进/反缩进 (Tab / Shift-Tab)
 */
export function handleListTab(view: EditorView, isShift: boolean): boolean {
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.head);
  const text = line.text;

  const isListLine = /^(\s*)([-*+]|\d+\.|>)/.test(text);
  if (!isListLine) return false;

  if (isShift) {
    // 反缩进：若行首有空格，去除最多 2 个空格
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
    // 缩进：在行首增加 2 个空格
    view.dispatch({
      changes: { from: line.from, insert: "  " },
    });
    return true;
  }

  return false;
}

/**
 * 切换当前行的标题层级 (H1 ~ H6)
 */
function toggleHeadingLevel(view: EditorView, level: number): boolean {
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.head);
  const text = line.text;

  const currentMatch = text.match(/^(#{1,6})\s+/);
  const targetPrefix = level > 0 ? `${"#".repeat(level)} ` : "";

  if (currentMatch) {
    const currentLevel = currentMatch[1].length;
    if (currentLevel === level || level === 0) {
      // 级别相同或为 0：取消标题，恢复普通段落
      view.dispatch({
        changes: { from: line.from, to: line.from + currentMatch[0].length, insert: "" },
      });
    } else {
      // 切换为目标标题层级
      view.dispatch({
        changes: { from: line.from, to: line.from + currentMatch[0].length, insert: targetPrefix },
      });
    }
  } else if (level > 0) {
    // 当前为普通段落：在行首插入 #
    view.dispatch({
      changes: { from: line.from, insert: targetPrefix },
    });
  }
  return true;
}

export const formattingKeymap: KeyBinding[] = [
  // 列表回车智能续行与缩进 (Typora 核心交互状态机)
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
  // 1. 加粗 (Ctrl+B)
  {
    key: "Ctrl-b",
    run: (view) => smartToggleFormat(view, "**"),
  },
  // 2. 斜体 (Ctrl-I)
  {
    key: "Ctrl-i",
    run: (view) => smartToggleFormat(view, "*"),
  },
  // 2.1 删除线 (Ctrl-Shift-X)
  {
    key: "Ctrl-Shift-x",
    run: (view) => smartToggleFormat(view, "~~"),
  },
  // 2.2 高亮 (Ctrl-Shift-H)
  {
    key: "Ctrl-Shift-h",
    run: (view) => smartToggleFormat(view, "=="),
  },
  // 3. 行内代码 (Ctrl-` 或 Ctrl-E)
  {
    key: "Ctrl-e",
    run: (view) => smartToggleFormat(view, "`"),
  },
  {
    key: "Ctrl-`",
    run: (view) => smartToggleFormat(view, "`"),
  },
  // 4. 超链接 (Ctrl-K) - 智能包裹与解包
  {
    key: "Ctrl-k",
    run: (view) => {
      const selection = view.state.selection.main;
      const from = selection.from;
      const to = selection.to;
      const text = view.state.sliceDoc(from, to);

      // 检查选区是否已经是完整链接 [text](url) -> 解开为 text
      const linkMatch = text.match(/^\[(.*?)\]\((.*?)\)$/);
      if (linkMatch) {
        view.dispatch({
          changes: { from, to, insert: linkMatch[1] },
          selection: { anchor: from, head: from + linkMatch[1].length },
        });
        return true;
      }

      // 检查光标所在位置是否在链接内部 -> 解开为 text
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
  // 5. 插入图片 (Ctrl-Shift-I)
  {
    key: "Ctrl-Shift-i",
    run: (view) => {
      const selection = view.state.selection.main;
      const insertStr = `![图片说明](url)`;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: insertStr },
        selection: { anchor: selection.from + 9, head: selection.from + insertStr.length - 1 },
      });
      return true;
    },
  },
  // 6. 插入多行代码块 (Ctrl-Shift-K)
  {
    key: "Ctrl-Shift-k",
    run: (view) => {
      const selection = view.state.selection.main;
      const insertStr = `\n\`\`\`javascript\n\n\`\`\`\n`;
      view.dispatch({
        changes: { from: selection.head, insert: insertStr },
        selection: { anchor: selection.head + 15 },
      });
      return true;
    },
  },
  // 7. 插入数学公式块 (Ctrl-Shift-M)
  {
    key: "Ctrl-Shift-m",
    run: (view) => {
      const selection = view.state.selection.main;
      const insertStr = `\n$$\n\n$$\n`;
      view.dispatch({
        changes: { from: selection.head, insert: insertStr },
        selection: { anchor: selection.head + 4 },
      });
      return true;
    },
  },
  // 8. 标题级别快捷切换 (Ctrl-1 ~ Ctrl-6 / Ctrl-Alt-1 ~ Ctrl-Alt-6) 与正文 (Ctrl-0 / Ctrl-Alt-0)
  { key: "Ctrl-1", run: (view) => toggleHeadingLevel(view, 1) },
  { key: "Ctrl-2", run: (view) => toggleHeadingLevel(view, 2) },
  { key: "Ctrl-3", run: (view) => toggleHeadingLevel(view, 3) },
  { key: "Ctrl-4", run: (view) => toggleHeadingLevel(view, 4) },
  { key: "Ctrl-5", run: (view) => toggleHeadingLevel(view, 5) },
  { key: "Ctrl-6", run: (view) => toggleHeadingLevel(view, 6) },
  { key: "Ctrl-0", run: (view) => toggleHeadingLevel(view, 0) },
  { key: "Ctrl-Alt-1", run: (view) => toggleHeadingLevel(view, 1) },
  { key: "Ctrl-Alt-2", run: (view) => toggleHeadingLevel(view, 2) },
  { key: "Ctrl-Alt-3", run: (view) => toggleHeadingLevel(view, 3) },
  { key: "Ctrl-Alt-4", run: (view) => toggleHeadingLevel(view, 4) },
  { key: "Ctrl-Alt-5", run: (view) => toggleHeadingLevel(view, 5) },
  { key: "Ctrl-Alt-6", run: (view) => toggleHeadingLevel(view, 6) },
  { key: "Ctrl-Alt-0", run: (view) => toggleHeadingLevel(view, 0) },
];
