import { ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  toggleHeadingFoldAtLine,
  isHeadingFoldedAtLine,
  activeDocumentPath,
} from "../editor/extensions/live-preview";

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
let activeOutlineContextMenu: HTMLElement | null = null;
let registeredEditorViewGetter: (() => EditorView | null) | null = null;

export function registerOutlineEditorGetter(getter: () => EditorView | null) {
  registeredEditorViewGetter = getter;
}

function closeOutlineContextMenu() {
  if (activeOutlineContextMenu) {
    activeOutlineContextMenu.remove();
    activeOutlineContextMenu = null;
  }
}

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
 * 计算某个大纲节点的章节闭包行区间 [startLine, endLine] 及下属子标题索引区间 [fromIdx, endIdx]
 */
export function getHeadingSubtreeBounds(
  docLines: number,
  headings: OutlineHeading[],
  headingIdx: number
): { startLine: number; endLine: number; endHeadingIdx: number } {
  const target = headings[headingIdx];
  const startLine = target.line;
  let endLine = docLines;
  let endHeadingIdx = headings.length - 1;

  for (let j = headingIdx + 1; j < headings.length; j++) {
    if (headings[j].level <= target.level) {
      endLine = headings[j].line - 1;
      endHeadingIdx = j - 1;
      break;
    }
  }
  return { startLine, endLine, endHeadingIdx };
}

/**
 * 单独调整某个标题行的级别 (level = 0 表示转为普通正文段落)
 */
export function setSingleHeadingLevel(
  view: EditorView,
  lineNumber: number,
  newLevel: number
) {
  const doc = view.state.doc;
  if (lineNumber < 1 || lineNumber > doc.lines) return;
  const line = doc.line(lineNumber);
  const m = line.text.match(/^(\s*(?:>\s*)*)(#{1,6})\s+(.*)$/);
  if (!m) return;
  const prefix = m[1];
  const body = m[3];
  const replacement =
    newLevel <= 0
      ? `${prefix}${body}`
      : `${prefix}${"#".repeat(Math.min(6, Math.max(1, newLevel)))} ${body}`;

  lastRenderedSignature = "";
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: replacement },
    userEvent: "input.format",
  });
}

/**
 * 思源笔记风格：带子标题整体升级 (delta = -1) 或整体降级 (delta = +1)
 * 自动校验边界：若子树内已有 H1 则整体升级时保持最小为 H1；若已有 H6 则最大保持 H6
 */
export function shiftHeadingSubtreeLevel(
  view: EditorView,
  headings: OutlineHeading[],
  headingIdx: number,
  delta: -1 | 1
) {
  if (headingIdx < 0 || headingIdx >= headings.length) return;
  const doc = view.state.doc;
  const { endHeadingIdx } = getHeadingSubtreeBounds(doc.lines, headings, headingIdx);

  const changes: ChangeSpec[] = [];
  for (let i = headingIdx; i <= endHeadingIdx; i++) {
    const h = headings[i];
    if (h.line < 1 || h.line > doc.lines) continue;
    const line = doc.line(h.line);
    const m = line.text.match(/^(\s*(?:>\s*)*)(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const currentLvl = m[2].length;
    const nextLvl = Math.min(6, Math.max(1, currentLvl + delta));
    if (nextLvl === currentLvl) continue;
    changes.push({
      from: line.from,
      to: line.to,
      insert: `${m[1]}${"#".repeat(nextLvl)} ${m[3]}`,
    });
  }

  if (changes.length > 0) {
    lastRenderedSignature = "";
    view.dispatch({
      changes,
      userEvent: "input.format",
    });
  }
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
 * 弹出大纲节点右键菜单（参考思源笔记/Obsidian 设计：支持单标题升降级、带子标题整体升降级、直达 H1-H6、折叠正文章节、章节移动、复制章节与双链引用、删除整章）
 */
function openOutlineItemContextMenu(
  clientX: number,
  clientY: number,
  headings: OutlineHeading[],
  idx: number,
  onHeadingClick: (line: number) => void,
  onHeadingReorder?: HeadingReorderHandler
) {
  closeOutlineContextMenu();
  const view = registeredEditorViewGetter ? registeredEditorViewGetter() : null;
  if (!view) return;

  const heading = headings[idx];
  if (!heading) return;

  const doc = view.state.doc;
  const { startLine, endLine, endHeadingIdx } = getHeadingSubtreeBounds(doc.lines, headings, idx);
  const hasSubheadings = endHeadingIdx > idx;
  const isSectionFolded = isHeadingFoldedAtLine(view, startLine);

  // 寻找上一个/下一个同级章节索引（用于整章上移/下移）
  let prevSiblingIdx = -1;
  for (let i = idx - 1; i >= 0; i--) {
    if (headings[i].level < heading.level) break;
    if (headings[i].level === heading.level) {
      prevSiblingIdx = i;
      break;
    }
  }
  let nextSiblingIdx = -1;
  for (let i = endHeadingIdx + 1; i < headings.length; i++) {
    if (headings[i].level < heading.level) break;
    if (headings[i].level === heading.level) {
      nextSiblingIdx = i;
      break;
    }
  }

  const menu = document.createElement("div");
  menu.className = "context-menu outline-context-menu";
  menu.innerHTML = `
    <div class="block-menu-section-title">章节级别转换 · H${heading.level}</div>
    <div class="block-turn-into-grid">
      ${[1, 2, 3, 4, 5, 6]
        .map(
          (lvl) =>
            `<button type="button" class="block-turn-btn ${
              heading.level === lvl ? "active" : ""
            }" data-action="set-level" data-level="${lvl}" title="转为 ${lvl} 级标题">H${lvl}</button>`
        )
        .join("")}
      <button type="button" class="block-turn-btn" data-action="set-level" data-level="0" title="转为普通正文段落">正文</button>
    </div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item ${heading.level <= 1 ? "disabled" : ""}" data-action="promote-single">
      <span>升级当前标题 (${heading.level > 1 ? `H${heading.level} → H${heading.level - 1}` : "已最高"})</span>
      <span class="menu-shortcut">Shift+Tab</span>
    </div>
    <div class="context-menu-item ${heading.level >= 6 ? "disabled" : ""}" data-action="demote-single">
      <span>降级当前标题 (${heading.level < 6 ? `H${heading.level} → H${heading.level + 1}` : "已最低"})</span>
      <span class="menu-shortcut">Tab</span>
    </div>
    ${
      hasSubheadings
        ? `
    <div class="context-menu-item" data-action="promote-subtree">
      <span>带子标题整体升级 (共 ${endHeadingIdx - idx + 1} 节)</span>
      <span class="menu-shortcut">子树 -1</span>
    </div>
    <div class="context-menu-item" data-action="demote-subtree">
      <span>带子标题整体降级 (共 ${endHeadingIdx - idx + 1} 节)</span>
      <span class="menu-shortcut">子树 +1</span>
    </div>`
        : ""
    }
    <div class="context-menu-divider"></div>
    <div class="context-menu-item" data-action="toggle-editor-fold">
      <span>${isSectionFolded ? "展开正文章节内容" : "折叠正文章节内容"}</span>
      <span class="menu-shortcut">${endLine - startLine} 行</span>
    </div>
    <div class="context-menu-item" data-action="insert-sibling-below">
      <span>在下方新建同级章节 (H${heading.level})</span>
    </div>
    <div class="context-menu-item" data-action="insert-child-below">
      <span>新建下属子章节 (H${Math.min(6, heading.level + 1)})</span>
    </div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item ${prevSiblingIdx < 0 ? "disabled" : ""}" data-action="move-section-up">
      <span>整章上移一节</span>
      <span class="menu-shortcut">↑</span>
    </div>
    <div class="context-menu-item ${nextSiblingIdx < 0 ? "disabled" : ""}" data-action="move-section-down">
      <span>整章下移一节</span>
      <span class="menu-shortcut">↓</span>
    </div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item" data-action="copy-section-md">
      <span>复制整章 Markdown</span>
    </div>
    <div class="context-menu-item" data-action="copy-wikilink">
      <span>复制章节双链 [[#标题]]</span>
    </div>
    <div class="context-menu-item" data-action="copy-transclusion">
      <span>复制章节嵌入引用 ![[#标题]]</span>
    </div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item danger" data-action="delete-section">
      <span>删除整章内容 (${startLine}~${endLine} 行)</span>
    </div>
  `;

  document.body.appendChild(menu);
  activeOutlineContextMenu = menu;

  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menu.addEventListener("click", (e) => {
    e.stopPropagation();
    const target = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!target || target.classList.contains("disabled")) return;

    const action = target.dataset.action;
    closeOutlineContextMenu();

    if (action === "set-level") {
      const lvl = parseInt(target.dataset.level || "0", 10);
      setSingleHeadingLevel(view, heading.line, lvl);
      return;
    }

    if (action === "promote-single" && heading.level > 1) {
      setSingleHeadingLevel(view, heading.line, heading.level - 1);
      return;
    }

    if (action === "demote-single" && heading.level < 6) {
      setSingleHeadingLevel(view, heading.line, heading.level + 1);
      return;
    }

    if (action === "promote-subtree") {
      shiftHeadingSubtreeLevel(view, headings, idx, -1);
      return;
    }

    if (action === "demote-subtree") {
      shiftHeadingSubtreeLevel(view, headings, idx, 1);
      return;
    }

    if (action === "toggle-editor-fold") {
      toggleHeadingFoldAtLine(view, startLine);
      return;
    }

    if (action === "insert-sibling-below" || action === "insert-child-below") {
      const targetLvl =
        action === "insert-child-below" ? Math.min(6, heading.level + 1) : heading.level;
      const insertPos = doc.line(endLine).to;
      const prefixHashes = "#".repeat(targetLvl);
      const insertStr = `\n\n${prefixHashes} 新章节标题\n`;
      lastRenderedSignature = "";
      view.dispatch({
        changes: { from: insertPos, to: insertPos, insert: insertStr },
        selection: {
          anchor: insertPos + 2 + prefixHashes.length + 1,
          head: insertPos + insertStr.length - 1,
        },
        effects: [EditorView.scrollIntoView(insertPos + 2, { y: "center" })],
      });
      view.focus();
      return;
    }

    if (action === "move-section-up" && prevSiblingIdx >= 0 && onHeadingReorder) {
      onHeadingReorder(idx, prevSiblingIdx, false);
      return;
    }

    if (action === "move-section-down" && nextSiblingIdx >= 0 && onHeadingReorder) {
      onHeadingReorder(idx, nextSiblingIdx, true);
      return;
    }

    if (action === "copy-section-md") {
      const fromPos = doc.line(startLine).from;
      const toPos = doc.line(endLine).to;
      const sectionMd = view.state.sliceDoc(fromPos, toPos);
      navigator.clipboard.writeText(sectionMd).catch(() => {});
      return;
    }

    if (action === "copy-wikilink" || action === "copy-transclusion") {
      const docName = activeDocumentPath
        ? activeDocumentPath
            .replace(/\\/g, "/")
            .split("/")
            .pop()
            ?.replace(/\.(md|markdown|txt)$/i, "") || ""
        : "";
      const refBody = docName ? `${docName}#${heading.text}` : `#${heading.text}`;
      const syntax = action === "copy-transclusion" ? `![[${refBody}]]` : `[[${refBody}]]`;
      navigator.clipboard.writeText(syntax).catch(() => {});
      return;
    }

    if (action === "delete-section") {
      const fromPos = doc.line(startLine).from;
      const toPos = endLine < doc.lines ? doc.line(endLine + 1).from : doc.line(endLine).to;
      lastRenderedSignature = "";
      view.dispatch({
        changes: { from: fromPos, to: toPos, insert: "" },
        userEvent: "delete.section",
      });
      onHeadingClick(Math.max(1, startLine - 1));
    }
  });
}

window.addEventListener("mousedown", (e) => {
  if (activeOutlineContextMenu && !activeOutlineContextMenu.contains(e.target as Node)) {
    closeOutlineContextMenu();
  }
});

/**
 * 渲染侧边栏大纲树：
 * - 采用签名比对增量更新（若仅行号偏移而标题层级与文字未变，仅原位更新 dataset.line，彻底消除打字时大纲闪烁与重排卡顿）
 * - 基于 Pointer Events 实现丝滑的跨章节拖拽排序
 * - 支持右键上下文菜单（升级/降级/带子标题整体转换/正文折叠/章节复制删除）
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
    el.title = `H${heading.level}: ${heading.text}\n左键跳转 · 拖拽重排整章 · 右键打开大纲菜单`;
    el.dataset.index = String(idx);
    el.dataset.line = String(heading.line);

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
    } else {
      caret.innerHTML = `<span class="outline-leaf-dot"></span>`;
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

    // 右键菜单支持
    el.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const currentIdx = Number(el.dataset.index ?? idx);
      openOutlineItemContextMenu(
        e.clientX,
        e.clientY,
        headings,
        currentIdx,
        onHeadingClick,
        onHeadingReorder
      );
    });

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
