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

// 记录大纲中折叠的标题行号（或标题键）
const collapsedOutlineKeys = new Set<string>();

function getHeadingKey(h: OutlineHeading, idx: number): string {
  return `${h.level}:${h.text}:${idx}`;
}

/**
 * 渲染侧边栏大纲树，支持多级折叠/展开、鼠标点击快速定位与原生 HTML5 拖拽重排章节 (闭包子树整体迁移)
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

  // 计算每个标题是否拥有下属子标题，以及是否被祖先标题折叠隐藏
  const hasChildren: boolean[] = new Array(headings.length).fill(false);
  for (let i = 0; i < headings.length; i++) {
    if (i + 1 < headings.length && headings[i + 1].level > headings[i].level) {
      hasChildren[i] = true;
    }
  }

  const updateVisibility = () => {
    const itemEls = container.querySelectorAll<HTMLElement>(".outline-item");
    let hiddenBelowLevel: number | null = null;

    headings.forEach((h, i) => {
      const el = itemEls[i];
      if (!el) return;

      if (hiddenBelowLevel !== null) {
        if (h.level > hiddenBelowLevel) {
          el.style.display = "none";
          return;
        } else {
          hiddenBelowLevel = null;
        }
      }

      el.style.display = "flex";
      const key = getHeadingKey(h, i);
      if (hasChildren[i] && collapsedOutlineKeys.has(key)) {
        hiddenBelowLevel = h.level;
      }
    });
  };

  headings.forEach((heading, idx) => {
    const key = getHeadingKey(heading, idx);
    const isCollapsed = collapsedOutlineKeys.has(key);

    const el = document.createElement("div");
    el.className = `outline-item outline-h${heading.level}`;
    el.title = `${heading.text} (点击跳转，拖拽重排整章)`;
    el.draggable = true;
    el.dataset.index = String(idx);
    el.dataset.line = String(heading.line);

    const caret = document.createElement("span");
    caret.className = `outline-caret ${hasChildren[idx] ? "has-children" : "empty"} ${
      isCollapsed ? "collapsed" : "expanded"
    }`;
    if (hasChildren[idx]) {
      caret.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
      caret.title = "折叠/展开子章节";
      caret.addEventListener("click", (e) => {
        e.stopPropagation();
        if (collapsedOutlineKeys.has(key)) {
          collapsedOutlineKeys.delete(key);
          caret.classList.remove("collapsed");
          caret.classList.add("expanded");
        } else {
          collapsedOutlineKeys.add(key);
          caret.classList.add("collapsed");
          caret.classList.remove("expanded");
        }
        updateVisibility();
      });
    }

    const tag = document.createElement("span");
    tag.className = "outline-tag";
    tag.textContent = `H${heading.level}`;

    const title = document.createElement("span");
    title.className = "outline-title";
    title.textContent = heading.text;

    el.appendChild(caret);
    el.appendChild(tag);
    el.appendChild(title);

    el.addEventListener("click", () => {
      container.querySelectorAll(".outline-item").forEach((item) => item.classList.remove("active"));
      el.classList.add("active");
      onHeadingClick(heading.line);
    });

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

  updateVisibility();
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
    const isAct = idx === activeIdx;
    item.classList.toggle("active", isAct);
  });
}

/**
 * 根据大纲树节点索引，执行 CodeMirror 文档层面的章节原子重排 (闭包识别下属段落与子标题，并确保章节间空行)
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
  let sourceText = view.state.sliceDoc(delFrom, delTo).trimEnd();

  if (isSourceAtDocEnd && delFrom > 0) {
    delFrom -= 1;
  }

  // 4. 计算插入目标坐标
  let insertPos = 0;
  if (targetInsertLine > doc.lines) {
    insertPos = doc.length;
  } else {
    insertPos = doc.line(targetInsertLine).from;
  }

  if (insertPos >= delFrom && insertPos <= delTo) {
    return;
  }

  // 5. 规范化插入文本换行与段落间距保护
  let finalInsertText = sourceText + "\n\n";
  if (insertPos === doc.length && doc.length > 0) {
    const prevChar = view.state.sliceDoc(doc.length - 1, doc.length);
    finalInsertText = (prevChar === "\n" ? "\n" : "\n\n") + sourceText + "\n";
  }

  const changes = [
    { from: delFrom, to: delTo, insert: "" },
    { from: insertPos, insert: finalInsertText },
  ].sort((a, b) => a.from - b.from);

  view.dispatch({
    changes,
    userEvent: "move.heading",
  });
}
