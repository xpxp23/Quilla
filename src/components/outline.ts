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

const collapsedOutlineKeys = new Set<string>();
let allCollapsedMode = false;
let lastRenderedSignature = "";

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
 * 渲染侧边栏大纲树：
 * - 采用签名比对增量更新（若仅行号偏移而标题层级与文字未变，仅原位更新 dataset.line，彻底消除打字时大纲闪烁与重排卡顿）
 * - 基于 Pointer Events 实现丝滑的跨章节拖拽排序（附带半透明残影与圆点指示线，彻底规避 Tauri 原生拖拽冲突）
 */
export function renderOutline(
  container: HTMLElement,
  headings: OutlineHeading[],
  onHeadingClick: (line: number) => void,
  onHeadingReorder?: HeadingReorderHandler
) {
  const newSignature = headings.map((h) => `${h.level}:${h.text}`).join("|");
  const existingItems = container.querySelectorAll<HTMLElement>(".outline-item");

  if (
    headings.length > 0 &&
    newSignature === lastRenderedSignature &&
    existingItems.length === headings.length
  ) {
    headings.forEach((h, idx) => {
      existingItems[idx].dataset.line = String(h.line);
    });
    return;
  }
  lastRenderedSignature = newSignature;

  container.innerHTML = "";

  if (headings.length === 0) {
    container.innerHTML = `<div class="outline-empty-hint">当前文档无标题或大纲为空</div>`;
    return;
  }

  const stableKeys = buildStableHeadingKeys(headings);
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

  // 创建统一的 Pointer 拖拽残影
  let ghostEl = document.getElementById("quilla-outline-drag-ghost");
  if (!ghostEl) {
    ghostEl = document.createElement("div");
    ghostEl.id = "quilla-outline-drag-ghost";
    ghostEl.className = "quilla-drag-ghost hidden";
    document.body.appendChild(ghostEl);
  }

  headings.forEach((heading, idx) => {
    const key = stableKeys[idx];
    const isCollapsed = collapsedOutlineKeys.has(key);
    const relDepth = Math.max(0, heading.level - minLevel);

    const el = document.createElement("div");
    el.className = `outline-item outline-h${heading.level} outline-depth-${Math.min(5, relDepth)}`;
    el.style.paddingLeft = `${relDepth * 13 + 8}px`;
    el.title = `H${heading.level}: ${heading.text} (点击跳转，按住上下拖动重排整章)`;
    el.dataset.index = String(idx);
    el.dataset.line = String(heading.line);

    const grip = document.createElement("span");
    grip.className = "outline-drag-grip";
    grip.innerHTML = `<svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor"><circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/><circle cx="2" cy="5" r="1"/><circle cx="6" cy="5" r="1"/><circle cx="2" cy="8" r="1"/><circle cx="6" cy="8" r="1"/></svg>`;

    const caret = document.createElement("span");
    caret.className = `outline-caret ${hasChildren[idx] ? "has-children" : "empty"} ${
      isCollapsed ? "collapsed" : "expanded"
    }`;
    if (hasChildren[idx]) {
      caret.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
      caret.title = "折叠/展开子章节";
      caret.addEventListener("pointerdown", (e) => e.stopPropagation());
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

    el.appendChild(grip);
    el.appendChild(caret);
    el.appendChild(title);
    el.appendChild(tag);

    let isPointerDown = false;
    let isDragging = false;
    let startY = 0;
    let hoverTargetIdx: number | null = null;
    let hoverInsertAfter = false;

    const clearDropIndicators = () => {
      container.querySelectorAll(".outline-item").forEach((item) => {
        item.classList.remove("outline-drop-indicator-top", "outline-drop-indicator-bottom");
      });
    };

    el.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(".outline-caret.has-children")) return;
      e.preventDefault();
      isPointerDown = true;
      isDragging = false;
      startY = e.clientY;
      hoverTargetIdx = null;
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener("pointermove", (e: PointerEvent) => {
      if (!isPointerDown || !onHeadingReorder) return;
      if (!isDragging) {
        if (Math.abs(e.clientY - startY) < 5) return;
        isDragging = true;
        el.classList.add("dragging");
        if (ghostEl) {
          ghostEl.textContent = `H${heading.level} · ${heading.text}`;
          ghostEl.classList.remove("hidden");
        }
      }

      if (ghostEl) {
        ghostEl.style.left = `${e.clientX + 12}px`;
        ghostEl.style.top = `${e.clientY - 12}px`;
      }

      // 侧边栏边缘自动滚动
      const sidebarScroller = container.closest(".sidebar-content") as HTMLElement | null;
      if (sidebarScroller) {
        const sbRect = sidebarScroller.getBoundingClientRect();
        if (e.clientY < sbRect.top + 32) sidebarScroller.scrollTop -= 6;
        else if (e.clientY > sbRect.bottom - 32) sidebarScroller.scrollTop += 6;
      }

      clearDropIndicators();
      hoverTargetIdx = null;

      const items = Array.from(container.querySelectorAll<HTMLElement>(".outline-item"));
      for (const candidate of items) {
        if (candidate.style.display === "none") continue;
        const cIdx = Number(candidate.dataset.index);
        if (cIdx === idx) continue;
        const rect = candidate.getBoundingClientRect();
        if (e.clientY >= rect.top - 2 && e.clientY <= rect.bottom + 2) {
          hoverTargetIdx = cIdx;
          hoverInsertAfter = e.clientY > rect.top + rect.height / 2;
          candidate.classList.toggle("outline-drop-indicator-top", !hoverInsertAfter);
          candidate.classList.toggle("outline-drop-indicator-bottom", hoverInsertAfter);
          break;
        }
      }
    });

    const endPointer = (e: PointerEvent, commit: boolean) => {
      if (!isPointerDown) return;
      isPointerDown = false;
      try {
        if (el.hasPointerCapture(e.pointerId)) {
          el.releasePointerCapture(e.pointerId);
        }
      } catch {
        // ignore
      }

      el.classList.remove("dragging");
      clearDropIndicators();
      ghostEl?.classList.add("hidden");

      if (!isDragging) {
        if (commit) {
          container
            .querySelectorAll(".outline-item")
            .forEach((item) => item.classList.remove("active"));
          el.classList.add("active");
          const currentLine = Number(el.dataset.line) || heading.line;
          onHeadingClick(currentLine);
        }
        return;
      }

      isDragging = false;
      if (commit && onHeadingReorder && hoverTargetIdx !== null && hoverTargetIdx !== idx) {
        onHeadingReorder(idx, hoverTargetIdx, hoverInsertAfter);
      }
    };

    el.addEventListener("pointerup", (e) => endPointer(e, true));
    el.addEventListener("pointercancel", (e) => endPointer(e, false));

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
 * 根据大纲树节点索引，执行 CodeMirror 文档层面的局部章节原子重排
 * - 识别章节闭包范围（包含下属段落与子标题）
 * - 仅替换受影响的最小行区间（绝不触碰前文 YAML 或无关代码块内的空行）
 * - 自动将光标跟随至重排后的章节标题，确保 Ctrl+Z 撤销时视口不乱跳
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

  // 1. 计算源标题的章节闭包范围 (sourceStartLine ~ sourceEndLine)
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
  let targetSectionEndLine = targetHeading.line;
  for (let k = toIndex + 1; k < headings.length; k++) {
    if (headings[k].level <= targetHeading.level) {
      targetSectionEndLine = headings[k].line - 1;
      break;
    }
    if (k === headings.length - 1) {
      targetSectionEndLine = doc.lines;
    }
  }
  if (toIndex === headings.length - 1) {
    targetSectionEndLine = doc.lines;
  }

  if (insertAfter) {
    targetInsertLine = targetSectionEndLine + 1;
  }

  // 若目标插入行落入源章节闭包内部，视为无效移动
  if (targetInsertLine >= sourceStartLine && targetInsertLine <= sourceEndLine + 1) {
    return;
  }

  // 3. 仅在最小受影响行区间 [minLine, maxLine] 内做局部重排，严禁替换全文或破坏代码块内空行
  const minLine = Math.min(sourceStartLine, targetHeading.line);
  const maxLine = Math.max(sourceEndLine, targetSectionEndLine);

  const rangeLines: string[] = [];
  for (let i = minLine; i <= maxLine; i++) {
    rangeLines.push(doc.line(i).text);
  }

  const relSrcStart = sourceStartLine - minLine;
  const srcCount = sourceEndLine - sourceStartLine + 1;
  const extractedLines = rangeLines.slice(relSrcStart, relSrcStart + srcCount);
  while (extractedLines.length > 1 && extractedLines[extractedLines.length - 1].trim() === "") {
    extractedLines.pop();
  }
  extractedLines.push("");

  const remainingLines = [
    ...rangeLines.slice(0, relSrcStart),
    ...rangeLines.slice(relSrcStart + srcCount),
  ];

  let adjustedInsertIdx = targetInsertLine - minLine;
  if (targetInsertLine > sourceEndLine) {
    adjustedInsertIdx -= srcCount;
  }
  adjustedInsertIdx = Math.max(0, Math.min(remainingLines.length, adjustedInsertIdx));

  if (
    adjustedInsertIdx > 0 &&
    remainingLines[adjustedInsertIdx - 1] !== undefined &&
    remainingLines[adjustedInsertIdx - 1].trim() !== ""
  ) {
    extractedLines.unshift("");
  }

  remainingLines.splice(adjustedInsertIdx, 0, ...extractedLines);

  const replaceFrom = doc.line(minLine).from;
  const replaceTo = doc.line(maxLine).to;
  const newSegment = remainingLines.join("\n");

  const headingOffsetInExtracted = extractedLines[0] === "" ? 1 : 0;
  const linesBeforeNewHeading = remainingLines.slice(0, adjustedInsertIdx + headingOffsetInExtracted);
  const newHeadingPos =
    replaceFrom +
    (linesBeforeNewHeading.length > 0 ? linesBeforeNewHeading.join("\n").length + 1 : 0);

  lastRenderedSignature = "";
  view.dispatch({
    changes: { from: replaceFrom, to: replaceTo, insert: newSegment },
    selection: { anchor: Math.min(newHeadingPos, replaceFrom + newSegment.length) },
    effects: [EditorView.scrollIntoView(newHeadingPos, { y: "start", yMargin: 48 })],
    userEvent: "move.heading",
  });
}
