import { ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  toggleHeadingFoldAtLine,
  isHeadingFoldedAtLine,
  setHeadingFoldAtLine,
  activeDocumentPath,
} from "../editor/extensions/live-preview";
import { showToast } from "./save-dialog";

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
const selectedOutlineIndices = new Set<number>();
let lastClickedOutlineIdx = -1;
let outlineFilterQuery = "";
let allCollapsedMode = false;
let lastRenderedSignature = "";
let activeOutlineContextMenu: HTMLElement | null = null;
let registeredEditorViewGetter: (() => EditorView | null) | null = null;

/**
 * 大纲点击跳转锁：防止点击大纲条目触发编辑器滚动时，被视口顶部 Scroll Spy 反向覆盖高亮导致大纲视图乱跳 (Bug #7)
 */
let outlineJumpLockUntil = 0;

export function markOutlineJumpLock(durationMs: number = 580) {
  outlineJumpLockUntil = performance.now() + durationMs;
}

export function isOutlineJumpLocked(): boolean {
  return performance.now() < outlineJumpLockUntil;
}

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
 * 带子标题整体点选转换到指定目标层级 (Bug #6 核心优化)
 * 将当前章节设为 targetRootLevel (1~6)，并按相同相对层级差值自动缩放其下属所有子标题，保持子树层级结构不乱
 */
export function setHeadingSubtreeTargetLevel(
  view: EditorView,
  headings: OutlineHeading[],
  headingIdx: number,
  targetRootLevel: number
) {
  if (headingIdx < 0 || headingIdx >= headings.length) return;
  const rootHeading = headings[headingIdx];
  const clampedTarget = Math.min(6, Math.max(1, targetRootLevel));
  const delta = clampedTarget - rootHeading.level;
  if (delta === 0) return;

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
 * 兼容旧接口：带子标题整体相对升降级
 */
export function shiftHeadingSubtreeLevel(
  view: EditorView,
  headings: OutlineHeading[],
  headingIdx: number,
  delta: -1 | 1
) {
  if (headingIdx < 0 || headingIdx >= headings.length) return;
  setHeadingSubtreeTargetLevel(view, headings, headingIdx, headings[headingIdx].level + delta);
}

/**
 * 批量设置多选大纲标题为统一级别 (level = 0 表示转为正文，1~6 表示 H1~H6) (Bug #8)
 */
export function batchSetSelectedHeadingsLevel(
  view: EditorView,
  headings: OutlineHeading[],
  indices: number[],
  newLevel: number
) {
  const doc = view.state.doc;
  const sortedIndices = [...new Set(indices)]
    .filter((i) => i >= 0 && i < headings.length)
    .sort((a, b) => headings[a].line - headings[b].line);

  const changes: ChangeSpec[] = [];
  for (const idx of sortedIndices) {
    const h = headings[idx];
    if (h.line < 1 || h.line > doc.lines) continue;
    const line = doc.line(h.line);
    const m = line.text.match(/^(\s*(?:>\s*)*)(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const replacement =
      newLevel <= 0
        ? `${m[1]}${m[3]}`
        : `${m[1]}${"#".repeat(Math.min(6, Math.max(1, newLevel)))} ${m[3]}`;
    if (replacement !== line.text) {
      changes.push({ from: line.from, to: line.to, insert: replacement });
    }
  }

  if (changes.length > 0) {
    lastRenderedSignature = "";
    view.dispatch({ changes, userEvent: "input.format" });
  }
}

/**
 * 批量相对升降级多选大纲标题（保持各选中标题之间的相对层级关系） (Bug #8)
 */
export function batchShiftSelectedHeadingsLevel(
  view: EditorView,
  headings: OutlineHeading[],
  indices: number[],
  delta: number
) {
  if (delta === 0) return;
  const doc = view.state.doc;
  const sortedIndices = [...new Set(indices)]
    .filter((i) => i >= 0 && i < headings.length)
    .sort((a, b) => headings[a].line - headings[b].line);

  const changes: ChangeSpec[] = [];
  for (const idx of sortedIndices) {
    const h = headings[idx];
    if (h.line < 1 || h.line > doc.lines) continue;
    const line = doc.line(h.line);
    const m = line.text.match(/^(\s*(?:>\s*)*)(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const curLvl = m[2].length;
    const nextLvl = Math.min(6, Math.max(1, curLvl + delta));
    if (nextLvl !== curLvl) {
      changes.push({
        from: line.from,
        to: line.to,
        insert: `${m[1]}${"#".repeat(nextLvl)} ${m[3]}`,
      });
    }
  }

  if (changes.length > 0) {
    lastRenderedSignature = "";
    view.dispatch({ changes, userEvent: "input.format" });
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
 * 弹出大纲多选批量右键菜单 (Bug #8：支持多选后右键一起更改层级/折叠/复制/删除)
 */
function openBatchOutlineContextMenu(
  clientX: number,
  clientY: number,
  container: HTMLElement,
  headings: OutlineHeading[],
  selectedIndices: number[]
) {
  closeOutlineContextMenu();
  const view = registeredEditorViewGetter ? registeredEditorViewGetter() : null;
  if (!view || selectedIndices.length === 0) return;

  const count = selectedIndices.length;
  const menu = document.createElement("div");
  menu.className = "context-menu outline-context-menu";
  menu.innerHTML = `
    <div class="block-menu-section-title">已选 ${count} 个章节 · 批量设为同级</div>
    <div class="block-turn-into-grid">
      ${[1, 2, 3, 4, 5, 6]
        .map(
          (lvl) =>
            `<button type="button" class="block-turn-btn" data-action="batch-set-level" data-level="${lvl}" title="将所选 ${count} 个标题统一设为 H${lvl}">H${lvl}</button>`
        )
        .join("")}
      <button type="button" class="block-turn-btn" data-action="batch-set-level" data-level="0" title="将所选标题全部转为普通正文">正文</button>
    </div>
    <div class="context-menu-divider"></div>
    <div class="block-menu-section-title">保持相对层级 · 批量整体缩放</div>
    <div class="block-turn-into-grid">
      <button type="button" class="block-turn-btn" data-action="batch-shift" data-delta="-2" title="所选标题整体提升 2 级">-2 级</button>
      <button type="button" class="block-turn-btn" data-action="batch-shift" data-delta="-1" title="所选标题整体提升 1 级">升级 -1</button>
      <button type="button" class="block-turn-btn" data-action="batch-shift" data-delta="1" title="所选标题整体降低 1 级">降级 +1</button>
      <button type="button" class="block-turn-btn" data-action="batch-shift" data-delta="2" title="所选标题整体降低 2 级">+2 级</button>
    </div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item" data-action="batch-fold-editor">
      <span>折叠所选正文章节</span>
    </div>
    <div class="context-menu-item" data-action="batch-unfold-editor">
      <span>展开所选正文章节</span>
    </div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item" data-action="batch-copy-titles">
      <span>复制所选章节标题列表</span>
    </div>
    <div class="context-menu-item" data-action="batch-clear-selection">
      <span>取消多选状态</span>
      <span class="menu-shortcut">Esc</span>
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
    if (!target) return;
    const action = target.dataset.action;
    closeOutlineContextMenu();

    if (action === "batch-set-level") {
      const lvl = parseInt(target.dataset.level || "0", 10);
      batchSetSelectedHeadingsLevel(view, headings, selectedIndices, lvl);
      if (lvl === 0) {
        selectedOutlineIndices.clear();
      }
      return;
    }

    if (action === "batch-shift") {
      const delta = parseInt(target.dataset.delta || "0", 10);
      batchShiftSelectedHeadingsLevel(view, headings, selectedIndices, delta);
      return;
    }

    if (action === "batch-fold-editor" || action === "batch-unfold-editor") {
      const shouldFold = action === "batch-fold-editor";
      for (const idx of selectedIndices) {
        const h = headings[idx];
        if (h) setHeadingFoldAtLine(view, h.line, shouldFold);
      }
      return;
    }

    if (action === "batch-copy-titles") {
      const sorted = [...selectedIndices].sort((a, b) => a - b);
      const text = sorted
        .map((i) => `${"#".repeat(headings[i].level)} ${headings[i].text}`)
        .join("\n");
      navigator.clipboard.writeText(text).catch(() => {});
      showToast(`已复制 ${sorted.length} 个章节标题`, "success");
      return;
    }

    if (action === "batch-clear-selection") {
      selectedOutlineIndices.clear();
      container
        .querySelectorAll(".outline-item.multi-selected")
        .forEach((el) => el.classList.remove("multi-selected"));
    }
  });
}

/**
 * 弹出单个大纲节点右键菜单 (Bug #6 优化：移除冗余的单标题升级/降级菜单项，将“带子标题整体转换”升级为直观的 H1~H6 点选矩阵)
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
  const subtreeCount = endHeadingIdx - idx + 1;
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
    <div class="block-menu-section-title">当前标题级别转换 · H${heading.level}</div>
    <div class="block-turn-into-grid">
      ${[1, 2, 3, 4, 5, 6]
        .map(
          (lvl) =>
            `<button type="button" class="block-turn-btn ${
              heading.level === lvl ? "active" : ""
            }" data-action="set-level" data-level="${lvl}" title="仅将当前标题转为 H${lvl}">H${lvl}</button>`
        )
        .join("")}
      <button type="button" class="block-turn-btn" data-action="set-level" data-level="0" title="将当前标题转为普通正文段落">正文</button>
    </div>
    ${
      hasSubheadings
        ? `
    <div class="context-menu-divider"></div>
    <div class="block-menu-section-title">带子标题整体转换 (共 ${subtreeCount} 节)</div>
    <div class="block-turn-into-grid">
      ${[1, 2, 3, 4, 5, 6]
        .map((lvl) => {
          const delta = lvl - heading.level;
          const sign = delta > 0 ? `+${delta}` : `${delta}`;
          return `<button type="button" class="block-turn-btn ${
            heading.level === lvl ? "active" : ""
          }" data-action="set-subtree-level" data-level="${lvl}" title="将本节设为 H${lvl}，并同步缩放下属子标题 (${
            delta === 0 ? "当前级别" : `整体 ${sign} 级`
          })">H${lvl}</button>`;
        })
        .join("")}
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

    if (action === "set-subtree-level") {
      const lvl = parseInt(target.dataset.level || String(heading.level), 10);
      setHeadingSubtreeTargetLevel(view, headings, idx, lvl);
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
      showToast("已复制整章 Markdown", "success");
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
      showToast(`已复制 ${syntax}`, "success");
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

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeOutlineContextMenu();
    if (selectedOutlineIndices.size > 0) {
      selectedOutlineIndices.clear();
      document
        .querySelectorAll(".outline-item.multi-selected")
        .forEach((el) => el.classList.remove("multi-selected"));
    }
  }
});

let outlineFilterBound = false;
function ensureOutlineSearchFilterBinding(container: HTMLElement) {
  if (outlineFilterBound) return;
  const searchInput = document.getElementById("outline-search-input") as HTMLInputElement | null;
  if (!searchInput) return;
  outlineFilterBound = true;
  searchInput.addEventListener("input", () => {
    outlineFilterQuery = searchInput.value.trim().toLowerCase();
    applyOutlineFilter(container);
  });
}

function applyOutlineFilter(container: HTMLElement) {
  const itemEls = container.querySelectorAll<HTMLElement>(".outline-item");
  if (!outlineFilterQuery) {
    itemEls.forEach((el) => {
      el.classList.remove("outline-filter-hidden", "outline-filter-match");
    });
    return;
  }
  itemEls.forEach((el) => {
    const titleText = (el.querySelector(".outline-title")?.textContent || "").toLowerCase();
    const matched = titleText.includes(outlineFilterQuery);
    el.classList.toggle("outline-filter-hidden", !matched);
    el.classList.toggle("outline-filter-match", matched);
  });
}

/**
 * 渲染侧边栏大纲树：
 * - 采用签名比对增量更新 + 保持滚动位置，彻底消除大纲视图乱跳 (Bug #7)
 * - 支持 Ctrl/Cmd+Click 与 Shift+Click 多选章节并右键批量修改层级 (Bug #8)
 * - 支持带子标题整体点选转换 H1~H6 (Bug #6)
 */
export function renderOutline(
  container: HTMLElement,
  headings: OutlineHeading[],
  onHeadingClick: (line: number) => void,
  onHeadingReorder?: HeadingReorderHandler
) {
  ensureOutlineSearchFilterBinding(container);

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

  // 保存大纲滚动容器的当前滚动位置，防止重绘时跳回顶部 (Bug #7)
  const sidebarScroller = container.closest(".sidebar-content") as HTMLElement | null;
  const prevContainerScrollTop = container.scrollTop;
  const prevSidebarScrollTop = sidebarScroller ? sidebarScroller.scrollTop : 0;

  container.innerHTML = "";

  if (headings.length === 0) {
    selectedOutlineIndices.clear();
    container.innerHTML = `<div class="outline-empty-hint">当前文档无标题或大纲为空</div>`;
    return;
  }

  // 清理越界的多选索引
  for (const selIdx of Array.from(selectedOutlineIndices)) {
    if (selIdx < 0 || selIdx >= headings.length) {
      selectedOutlineIndices.delete(selIdx);
    }
  }

  const stableKeys = buildStableHeadingKeys(headings);
  const minLevel = Math.min(...headings.map((h) => h.level));
  const hasChildren: boolean[] = new Array(headings.length).fill(false);
  for (let i = 0; i < headings.length; i++) {
    if (i + 1 < headings.length && headings[i + 1].level > headings[i].level) {
      hasChildren[i] = true;
    }
  }

  const syncMultiSelectClasses = () => {
    const itemEls = container.querySelectorAll<HTMLElement>(".outline-item");
    itemEls.forEach((item, i) => {
      item.classList.toggle("multi-selected", selectedOutlineIndices.has(i));
    });
  };

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
    applyOutlineFilter(container);
  };

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
    el.className = `outline-item outline-h${heading.level} outline-depth-${Math.min(5, relDepth)}${
      selectedOutlineIndices.has(idx) ? " multi-selected" : ""
    }`;
    el.style.paddingLeft = `${relDepth * 13 + 8}px`;
    el.title = `H${heading.level}: ${heading.text}\n左键跳转 · Ctrl/Shift+左键多选 · 拖拽重排 · 右键打开菜单`;
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

    // 右键菜单支持（自动识别单选与多选批量模式）
    el.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const currentIdx = Number(el.dataset.index ?? idx);

      if (selectedOutlineIndices.size > 1 && selectedOutlineIndices.has(currentIdx)) {
        openBatchOutlineContextMenu(
          e.clientX,
          e.clientY,
          container,
          headings,
          Array.from(selectedOutlineIndices)
        );
        return;
      }

      openOutlineItemContextMenu(
        e.clientX,
        e.clientY,
        headings,
        currentIdx,
        (targetLine) => {
          markOutlineJumpLock(580);
          onHeadingClick(targetLine);
        },
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
          const currentIdx = Number(el.dataset.index ?? idx);
          // 支持 Ctrl/Cmd+Click 多选与 Shift+Click 连续区间多选 (Bug #8)
          if (e.ctrlKey || e.metaKey) {
            if (selectedOutlineIndices.has(currentIdx)) {
              selectedOutlineIndices.delete(currentIdx);
            } else {
              if (selectedOutlineIndices.size === 0 && lastClickedOutlineIdx >= 0) {
                selectedOutlineIndices.add(lastClickedOutlineIdx);
              }
              selectedOutlineIndices.add(currentIdx);
            }
            lastClickedOutlineIdx = currentIdx;
            syncMultiSelectClasses();
            return;
          }

          if (e.shiftKey && lastClickedOutlineIdx !== -1) {
            const start = Math.min(lastClickedOutlineIdx, currentIdx);
            const end = Math.max(lastClickedOutlineIdx, currentIdx);
            selectedOutlineIndices.clear();
            for (let k = start; k <= end; k++) {
              selectedOutlineIndices.add(k);
            }
            syncMultiSelectClasses();
            return;
          }

          // 普通单选点击：清除多选态、锁定 Scroll Spy 580ms、定位跳转正文 (Bug #7)
          selectedOutlineIndices.clear();
          lastClickedOutlineIdx = currentIdx;
          syncMultiSelectClasses();

          container
            .querySelectorAll(".outline-item")
            .forEach((item) => item.classList.remove("active"));
          el.classList.add("active");
          markOutlineJumpLock(580);
          const currentLine = Number(el.dataset.line) || heading.line;
          onHeadingClick(currentLine);
        }
        return;
      }

      isDragging = false;
      if (commit && onHeadingReorder && hoverTargetIdx !== null && hoverTargetIdx !== idx) {
        markOutlineJumpLock(580);
        onHeadingReorder(idx, hoverTargetIdx, hoverInsertAfter);
      }
    };

    el.addEventListener("pointerup", (e) => endPointer(e, true));
    el.addEventListener("pointercancel", (e) => endPointer(e, false));

    container.appendChild(el);
  });

  updateVisibility();

  // 恢复滚动位置，防止大纲列表刷新时乱跳
  container.scrollTop = prevContainerScrollTop;
  if (sidebarScroller) {
    sidebarScroller.scrollTop = prevSidebarScrollTop;
  }
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
  if (activeIdx === -1 && headings.length > 0) {
    activeIdx = 0;
  }

  const items = container.querySelectorAll<HTMLElement>(".outline-item");
  let activeEl: HTMLElement | null = null;
  items.forEach((item, idx) => {
    const isAct = idx === activeIdx;
    item.classList.toggle("active", isAct);
    if (isAct) activeEl = item;
  });

  // 仅当未处于手动点击大纲锁定期间，且当前激活项超出侧边栏可视范围时，才平滑微调可见性
  if (activeEl && !isOutlineJumpLocked()) {
    const scroller = (container.closest(".sidebar-content") as HTMLElement) || container;
    const scrollerRect = scroller.getBoundingClientRect();
    const itemRect = (activeEl as HTMLElement).getBoundingClientRect();
    if (itemRect.height > 0) {
      if (itemRect.top < scrollerRect.top + 8) {
        scroller.scrollTop -= scrollerRect.top + 8 - itemRect.top;
      } else if (itemRect.bottom > scrollerRect.bottom - 8) {
        scroller.scrollTop += itemRect.bottom - (scrollerRect.bottom - 8);
      }
    }
  }
}

/**
 * 根据大纲树节点索引，执行 CodeMirror 文档层面的局部章节原子重排
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

  const sourceStartLine = sourceHeading.line;
  let sourceEndLine = doc.lines;
  for (let j = fromIndex + 1; j < headings.length; j++) {
    if (headings[j].level <= sourceHeading.level) {
      sourceEndLine = headings[j].line - 1;
      break;
    }
  }

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

  if (targetInsertLine >= sourceStartLine && targetInsertLine <= sourceEndLine + 1) {
    return;
  }

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
  const linesBeforeNewHeading = remainingLines.slice(
    0,
    adjustedInsertIdx + headingOffsetInExtracted
  );
  const newHeadingPos =
    replaceFrom +
    (linesBeforeNewHeading.length > 0 ? linesBeforeNewHeading.join("\n").length + 1 : 0);

  lastRenderedSignature = "";
  markOutlineJumpLock(580);
  view.dispatch({
    changes: { from: replaceFrom, to: replaceTo, insert: newSegment },
    selection: { anchor: Math.min(newHeadingPos, replaceFrom + newSegment.length) },
    effects: [EditorView.scrollIntoView(newHeadingPos, { y: "start", yMargin: 48 })],
    userEvent: "move.heading",
  });
}
