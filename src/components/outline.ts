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

// 记录大纲中折叠的标题稳定键（基于层级+标题名+同名序号，避免前文增删标题导致折叠状态错位）
const collapsedOutlineKeys = new Set<string>();
let allCollapsedMode = false;

function buildStableHeadingKeys(headings: OutlineHeading[]): string[] {
  const counts = new Map<string, number>();
  return headings.map((h) => {
    const base = `${h.level}::${h.text}`;
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    return `${base}::${n}`;
  });
}

/**
 * 一键展开或折叠所有包含子章节的大纲项
 */
export function toggleAllOutlineFold(
  container: HTMLElement | null,
  headings: OutlineHeading[]
): boolean {
  const keys = buildStableHeadingKeys(headings);
  const parentKeys: string[] = [];
  for (let i = 0; i < headings.length; i++) {
    if (i + 1 < headings.length && headings[i + 1].level > headings[i].level) {
      parentKeys.push(keys[i]);
    }
  }
  if (parentKeys.length === 0) return false;

  const anyExpanded = parentKeys.some((k) => !collapsedOutlineKeys.has(k));
  if (anyExpanded) {
    parentKeys.forEach((k) => collapsedOutlineKeys.add(k));
    allCollapsedMode = true;
  } else {
    collapsedOutlineKeys.clear();
    allCollapsedMode = false;
  }

  if (container) {
    const carets = container.querySelectorAll<HTMLElement>(".outline-caret.has-children");
    carets.forEach((c) => {
      c.classList.toggle("collapsed", allCollapsedMode);
      c.classList.toggle("expanded", !allCollapsedMode);
    });
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
      if (
        i + 1 < headings.length &&
        headings[i + 1].level > h.level &&
        collapsedOutlineKeys.has(keys[i])
      ) {
        hiddenBelowLevel = h.level;
      }
    });
  }
  return allCollapsedMode;
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
    container.innerHTML = `<div class="outline-empty-hint">当前文档无标题或大纲为空</div>`;
    return;
  }

  let draggedIndex: number | null = null;
  const stableKeys = buildStableHeadingKeys(headings);

  // 计算每个标题是否拥有下属子标题，以及最小标题层级用于相对缩进归一化
  const minLevel = Math.min(...headings.map((h) => h.level));
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
      const key = stableKeys[i];
      if (hasChildren[i] && collapsedOutlineKeys.has(key)) {
        hiddenBelowLevel = h.level;
      }
    });
  };

  headings.forEach((heading, idx) => {
    const key = stableKeys[idx];
    const isCollapsed = collapsedOutlineKeys.has(key);
    const relDepth = Math.max(0, heading.level - minLevel);

    const el = document.createElement("div");
    el.className = `outline-item outline-h${heading.level}`;
    el.style.paddingLeft = `${relDepth * 12 + 6}px`;
    el.title = `H${heading.level}: ${heading.text} (点击跳转，拖拽重排整章)`;
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

    const title = document.createElement("span");
    title.className = "outline-title";
    title.textContent = heading.text;

    const tag = document.createElement("span");
    tag.className = "outline-tag";
    tag.textContent = `H${heading.level}`;

    el.appendChild(caret);
    el.appendChild(title);
    el.appendChild(tag);

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
 * 根据大纲树节点索引，执行 CodeMirror 文档层面的章节原子重排 (闭包识别下属段落与子标题，无损维护章节间空行)
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

  // 若目标插入行落入源章节闭包内部，视为无效移动
  if (targetInsertLine >= sourceStartLine && targetInsertLine <= sourceEndLine + 1) {
    return;
  }

  // 3. 基于行数组执行无损切片重排，彻底消除字符级偏移误吞前文换行符的问题
  const allLines: string[] = [];
  for (let i = 1; i <= doc.lines; i++) {
    allLines.push(doc.line(i).text);
  }

  const srcZeroStart = sourceStartLine - 1;
  const srcCount = sourceEndLine - sourceStartLine + 1;
  const extractedLines = allLines.slice(srcZeroStart, srcZeroStart + srcCount);
  while (extractedLines.length > 1 && extractedLines[extractedLines.length - 1].trim() === "") {
    extractedLines.pop();
  }
  extractedLines.push("");

  const remainingLines = [
    ...allLines.slice(0, srcZeroStart),
    ...allLines.slice(srcZeroStart + srcCount),
  ];

  let adjustedInsertIdx = targetInsertLine - 1;
  if (targetInsertLine > sourceEndLine) {
    adjustedInsertIdx -= srcCount;
  }
  adjustedInsertIdx = Math.max(0, Math.min(remainingLines.length, adjustedInsertIdx));

  // 若插入在文档末尾且前一行非空，补一个空行保持段落呼吸感
  if (
    adjustedInsertIdx > 0 &&
    remainingLines[adjustedInsertIdx - 1] !== undefined &&
    remainingLines[adjustedInsertIdx - 1].trim() !== ""
  ) {
    extractedLines.unshift("");
  }

  remainingLines.splice(adjustedInsertIdx, 0, ...extractedLines);
  const newDocText = remainingLines.join("\n").replace(/\n{3,}/g, "\n\n");

  view.dispatch({
    changes: { from: 0, to: doc.length, insert: newDocText },
    userEvent: "move.heading",
  });
}
