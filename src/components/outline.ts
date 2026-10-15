import { EditorView } from "@codemirror/view";

export interface OutlineHeading {
  level: number;
  text: string;
  line: number;
}

export type HeadingReorderHandler = (
  fromIndex: number,
  toIndex: number,
  insertAfter: boolean
) => void;

/**
 * 渲染侧边栏大纲树，支持鼠标点击快速定位与原生 HTML5 拖拽重排章节 (闭包子树整体迁移)
 */
export function renderOutline(
  container: HTMLElement,
  headings: OutlineHeading[],
  onHeadingClick: (line: number) => void,
  onHeadingReorder?: HeadingReorderHandler
) {
  container.innerHTML = "";

  if (headings.length === 0) {
    container.innerHTML = `<div style="padding: 24px 12px; color: var(--control-text-color); font-size: 12px; text-align: center;">当前文档无标题或大纲为空</div>`;
    return;
  }

  let draggedIndex: number | null = null;

  headings.forEach((heading, idx) => {
    const el = document.createElement("div");
    el.className = `outline-item outline-h${heading.level}`;
    el.title = `${heading.text} (可拖拽重排整章)`;
    el.draggable = true;
    el.dataset.index = String(idx);
    el.dataset.line = String(heading.line);

    const tag = document.createElement("span");
    tag.className = "outline-tag";
    tag.textContent = `H${heading.level}`;

    const title = document.createElement("span");
    title.className = "outline-title";
    title.textContent = heading.text;

    el.appendChild(tag);
    el.appendChild(title);

    // 单击快速定位
    el.addEventListener("click", () => {
      container.querySelectorAll(".outline-item").forEach((item) => item.classList.remove("active"));
      el.classList.add("active");
      onHeadingClick(heading.line);
    });

    // 拖拽重排
    if (onHeadingReorder) {
      el.addEventListener("dragstart", (e) => {
        draggedIndex = idx;
        el.classList.add("dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(idx));
        }
      });

      el.addEventListener("dragend", () => {
        draggedIndex = null;
        el.classList.remove("dragging");
        container.querySelectorAll(".outline-item").forEach((item) => {
          item.classList.remove("outline-drop-indicator-top", "outline-drop-indicator-bottom");
        });
      });

      el.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (draggedIndex === null || draggedIndex === idx) return;

        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = "move";
        }

        const rect = el.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const isBottom = e.clientY > midY;

        el.classList.toggle("outline-drop-indicator-top", !isBottom);
        el.classList.toggle("outline-drop-indicator-bottom", isBottom);
      });

      el.addEventListener("dragleave", () => {
        el.classList.remove("outline-drop-indicator-top", "outline-drop-indicator-bottom");
      });

      el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("outline-drop-indicator-top", "outline-drop-indicator-bottom");
        if (draggedIndex === null || draggedIndex === idx) return;

        const rect = el.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const insertAfter = e.clientY > midY;

        onHeadingReorder(draggedIndex, idx, insertAfter);
      });
    }

    container.appendChild(el);
  });
}

/**
 * 根据当前光标或视口顶部所在行，自动同步大纲面板的高亮项 (Scroll Spy)
 */
export function syncActiveOutlineHeading(
  container: HTMLElement | null,
  headings: OutlineHeading[],
  currentLine: number
) {
  if (!container || headings.length === 0) return;
  let activeIdx = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].line <= currentLine) {
      activeIdx = i;
    } else {
      break;
    }
  }

  const items = container.querySelectorAll<HTMLElement>(".outline-item");
  items.forEach((item, idx) => {
    item.classList.toggle("active", idx === activeIdx);
  });
}

/**
 * 根据大纲树节点索引，执行 CodeMirror 文档层面的章节原子重排 (闭包识别下属段落与子标题)
 */
export function reorderDocumentHeading(
  view: EditorView,
  headings: OutlineHeading[],
  fromIndex: number,
  toIndex: number,
  insertAfter: boolean
) {
  if (fromIndex < 0 || fromIndex >= headings.length || toIndex < 0 || toIndex >= headings.length) {
    return;
  }
  if (fromIndex === toIndex) return;

  const doc = view.state.doc;
  const sourceHeading = headings[fromIndex];
  const targetHeading = headings[toIndex];

  // 1. 计算源标题的章节闭包范围 (startLine ~ endLine)
  const sourceStartLine = sourceHeading.line;
  let sourceEndLine = doc.lines;
  for (let j = fromIndex + 1; j < headings.length; j++) {
    if (headings[j].level <= sourceHeading.level) {
      sourceEndLine = headings[j].line - 1;
      break;
    }
  }

  // 2. 计算目标位置的行号
  let targetInsertLine = targetHeading.line;
  if (insertAfter) {
    // 插入在目标章节闭包之后
    let targetEndLine = doc.lines;
    for (let k = toIndex + 1; k < headings.length; k++) {
      if (headings[k].level <= targetHeading.level) {
        targetEndLine = headings[k].line - 1;
        break;
      }
    }
    targetInsertLine = targetEndLine + 1;
  }

  // 3. 提取源文本块
  let delFrom = doc.line(sourceStartLine).from;
  const isSourceAtDocEnd = sourceEndLine >= doc.lines;
  let delTo = isSourceAtDocEnd ? doc.line(sourceEndLine).to : doc.line(sourceEndLine).to + 1;
  let sourceText = view.state.sliceDoc(delFrom, delTo);

  // 如果源块位于文档末尾且不是从第0位置开始，把前置换行一并删除，避免文档末尾留下空行
  if (isSourceAtDocEnd && delFrom > 0) {
    delFrom -= 1;
    sourceText = view.state.sliceDoc(delFrom + 1, delTo);
  }

  // 4. 计算插入目标坐标
  let insertPos = 0;
  if (targetInsertLine > doc.lines) {
    insertPos = doc.length;
  } else {
    insertPos = doc.line(targetInsertLine).from;
  }

  // 避免将自身移动到自身范围内部的无效操作
  if (insertPos >= delFrom && insertPos <= delTo) {
    return;
  }

  // 5. 规范化插入文本换行
  let finalInsertText = sourceText;
  if (!finalInsertText.endsWith("\n") && insertPos < doc.length) {
    finalInsertText += "\n";
  }
  if (insertPos === doc.length && !finalInsertText.startsWith("\n") && doc.length > 0) {
    finalInsertText = "\n" + finalInsertText;
  }

  // 6. 严格按坐标升序排序 changes，满足 CodeMirror 6 事务铁律
  const changes = [
    { from: delFrom, to: delTo, insert: "" },
    { from: insertPos, insert: finalInsertText },
  ].sort((a, b) => a.from - b.from);

  view.dispatch({
    changes,
    userEvent: "move.heading",
  });
}
