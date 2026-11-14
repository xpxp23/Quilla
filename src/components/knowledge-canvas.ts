import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import { renderMarkdownDocumentToHtmlSync } from "../editor/markdown-ast-renderer";
import {
  parseWikiLinksInLine,
  fetchTransclusionSectionContent,
  updateTransclusionSectionContent,
} from "../editor/extensions/wiki-link";
import { showToast } from "./save-dialog";

export type CanvasCardType = "note" | "section" | "block" | "text" | "group";
export type CanvasPortSide = "top" | "right" | "bottom" | "left";
export type CanvasColorId =
  | "paper"
  | "cinnabar"
  | "celadon"
  | "bamboo"
  | "amber"
  | "purple";

export interface CanvasCardNode {
  id: string;
  type: CanvasCardType;
  title: string;
  content: string;
  filePath?: string | null;
  headingAnchor?: string | null;
  blockId?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  color: CanvasColorId;
}

export interface CanvasEdgeConnection {
  id: string;
  fromNode: string;
  fromSide: CanvasPortSide;
  toNode: string;
  toSide: CanvasPortSide;
  label?: string;
  color?: CanvasColorId;
}

export interface KnowledgeCanvasBoard {
  version: string;
  title: string;
  updatedAt: number;
  panX: number;
  panY: number;
  zoom: number;
  snapToGrid: boolean;
  nodes: CanvasCardNode[];
  edges: CanvasEdgeConnection[];
}

const CANVAS_STORAGE_KEY = "quilla_knowledge_canvas_board_v1";

const INKSTONE_CARD_PALETTES: Array<{
  id: CanvasColorId;
  label: string;
  swatch: string;
}> = [
  { id: "paper", label: "宣纸素白", swatch: "#d6d0c4" },
  { id: "cinnabar", label: "朱砂丹红", swatch: "#c34435" },
  { id: "celadon", label: "天青瓷韵", swatch: "#2b73af" },
  { id: "bamboo", label: "竹青松翠", swatch: "#2f7d58" },
  { id: "amber", label: "缃叶秋金", swatch: "#b7791f" },
  { id: "purple", label: "紫檀暮云", swatch: "#6b46c1" },
];

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 从当前编辑器文档自动提取章节 (`# Heading`)、`^block-id` 块与 `[[双链]]`，生成初始无限白板卡片网络
 */
export function buildInitialCanvasFromDocument(
  docText: string,
  activeTitle: string,
  activeFilePath: string | null
): KnowledgeCanvasBoard {
  const lines = docText.replace(/\r\n/g, "\n").split("\n");
  const nodes: CanvasCardNode[] = [];
  const edges: CanvasEdgeConnection[] = [];

  const rootId = "card-root-note";
  const cleanTitle = activeTitle.replace(/\.(md|markdown|txt)$/i, "") || "当前核心笔记";

  // 中心分组框
  nodes.push({
    id: "group-main-topic",
    type: "group",
    title: `${cleanTitle} · 知识卡片编排区`,
    content: "",
    x: 60,
    y: 50,
    width: 980,
    height: 600,
    color: "celadon",
  });

  // 根节点卡片
  nodes.push({
    id: rootId,
    type: "note",
    title: cleanTitle,
    content: lines.slice(0, 14).join("\n"),
    filePath: activeFilePath,
    x: 100,
    y: 120,
    width: 280,
    height: 210,
    color: "cinnabar",
  });

  // 提取前 4 个二级/三级章节作为章节卡片
  let inFence = false;
  const sections: Array<{ heading: string; body: string[]; blockId?: string }> = [];
  let curSec: { heading: string; body: string[]; blockId?: string } | null = null;

  for (const line of lines) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
    }
    if (!inFence) {
      const hMatch = line.match(/^(#{2,3})\s+(.+?)\s*$/);
      if (hMatch) {
        if (curSec) sections.push(curSec);
        curSec = { heading: hMatch[2].trim(), body: [] };
        continue;
      }
      const blkMatch = line.match(/\s\^([A-Za-z0-9_-]+)\s*$/);
      if (blkMatch) {
        const blkId = blkMatch[1];
        const cleanLine = line.replace(/\s\^[A-Za-z0-9_-]+\s*$/, "").trim();
        nodes.push({
          id: `card-block-${blkId}`,
          type: "block",
          title: `块引用 #^${blkId}`,
          content: cleanLine,
          filePath: activeFilePath,
          headingAnchor: `^${blkId}`,
          blockId: blkId,
          x: 100,
          y: 380,
          width: 280,
          height: 170,
          color: "amber",
        });
        edges.push({
          id: `edge-root-blk-${blkId}`,
          fromNode: rootId,
          fromSide: "bottom",
          toNode: `card-block-${blkId}`,
          toSide: "top",
          label: `^${blkId}`,
          color: "amber",
        });
      }
    }
    if (curSec && curSec.body.length < 7 && line.trim()) {
      curSec.body.push(line);
    }
  }
  if (curSec) sections.push(curSec);

  const palettes: CanvasColorId[] = ["celadon", "bamboo", "purple", "paper"];
  sections.slice(0, 4).forEach((sec, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const cardId = `card-sec-${idx + 1}`;
    const color = palettes[idx % palettes.length];
    nodes.push({
      id: cardId,
      type: "section",
      title: sec.heading,
      content: sec.body.slice(0, 5).join("\n") || `章节：${sec.heading}`,
      filePath: activeFilePath,
      headingAnchor: sec.heading,
      x: 450 + col * 280,
      y: 100 + row * 235,
      width: 255,
      height: 195,
      color,
    });
    edges.push({
      id: `edge-root-sec-${idx + 1}`,
      fromNode: rootId,
      fromSide: "right",
      toNode: cardId,
      toSide: "left",
      label: `章节 #${idx + 1}`,
      color,
    });
  });

  return {
    version: "0.12.0",
    title: `${cleanTitle} - 无限白板`,
    updatedAt: Date.now(),
    panX: 20,
    panY: 16,
    zoom: 1,
    snapToGrid: true,
    nodes,
    edges,
  };
}

/**
 * 提取文档内所有章节标题与 `^block-id` 块供左侧拖拽抽屉使用
 */
export function extractDocumentLibraryItems(docText: string): {
  headings: Array<{ level: number; text: string; line: number; preview: string }>;
  blocks: Array<{ blockId: string; line: number; text: string }>;
  wikilinks: string[];
} {
  const lines = docText.replace(/\r\n/g, "\n").split("\n");
  const headings: Array<{ level: number; text: string; line: number; preview: string }> = [];
  const blocks: Array<{ blockId: string; line: number; text: string }> = [];
  const wikiSet = new Set<string>();
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const hMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (hMatch) {
      const previewLines: string[] = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        if (/^#{1,6}\s+/.test(lines[j])) break;
        if (lines[j].trim()) previewLines.push(lines[j]);
        if (previewLines.length >= 4) break;
      }
      headings.push({
        level: hMatch[1].length,
        text: hMatch[2].trim(),
        line: i + 1,
        preview: previewLines.join("\n") || hMatch[2].trim(),
      });
    }

    const blkMatch = line.match(/\s\^([A-Za-z0-9_-]+)\s*$/);
    if (blkMatch) {
      blocks.push({
        blockId: blkMatch[1],
        line: i + 1,
        text: line.replace(/\s\^[A-Za-z0-9_-]+\s*$/, "").trim(),
      });
    }

    const wls = parseWikiLinksInLine(line);
    for (const w of wls) {
      if (w.target) wikiSet.add(w.target);
    }
  }

  return {
    headings,
    blocks,
    wikilinks: Array.from(wikiSet),
  };
}

function getPortCoordinates(
  node: CanvasCardNode,
  side: CanvasPortSide
): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
  }
}

export function buildBezierPathD(
  p1: { x: number; y: number },
  side1: CanvasPortSide,
  p2: { x: number; y: number },
  side2: CanvasPortSide
): string {
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const offset = Math.max(48, Math.min(180, dist * 0.42));
  const dirVec = (s: CanvasPortSide) => {
    switch (s) {
      case "top":
        return { dx: 0, dy: -offset };
      case "right":
        return { dx: offset, dy: 0 };
      case "bottom":
        return { dx: 0, dy: offset };
      case "left":
        return { dx: -offset, dy: 0 };
    }
  };
  const v1 = dirVec(side1);
  const v2 = dirVec(side2);
  const c1x = Math.round(p1.x + v1.dx);
  const c1y = Math.round(p1.y + v1.dy);
  const c2x = Math.round(p2.x + v2.dx);
  const c2y = Math.round(p2.y + v2.dy);
  return `M ${Math.round(p1.x)} ${Math.round(p1.y)} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${Math.round(p2.x)} ${Math.round(p2.y)}`;
}

let canvasModalEl: HTMLElement | null = null;
let canvasCleanupAbort: AbortController | null = null;

export async function openKnowledgeCanvasModal(options: {
  view: EditorView | null;
  workspaceRoot: string | null;
  activeFilePath: string | null;
  activeTitle: string;
  workspaceFiles?: Array<{ path: string; name: string; stem: string }>;
  onOpenNote?: (filePath: string, headingOrBlockAnchor?: string) => void;
  onSwitchToGraph?: () => void;
}) {
  if (canvasCleanupAbort) {
    canvasCleanupAbort.abort();
    canvasCleanupAbort = null;
  }
  canvasCleanupAbort = new AbortController();
  const signal = canvasCleanupAbort.signal;

  if (!canvasModalEl) {
    canvasModalEl = document.createElement("div");
    canvasModalEl.id = "quilla-knowledge-canvas-modal";
    canvasModalEl.className = "ty-modal-overlay";
    document.body.appendChild(canvasModalEl);
  }

  const docText = options.view?.state.doc.toString() || "";
  const libItems = extractDocumentLibraryItems(docText);
  const boardKey = `${CANVAS_STORAGE_KEY}::${options.workspaceRoot || options.activeFilePath || "default"}`;

  let board: KnowledgeCanvasBoard | null = null;

  // 优先尝试从工作区 `.quilla-canvas.json` 或 localStorage 读取
  if (options.workspaceRoot) {
    const sep = options.workspaceRoot.includes("\\") ? "\\" : "/";
    const canvasFilePath = `${options.workspaceRoot.replace(/[\\/]+$/, "")}${sep}.quilla-canvas.json`;
    try {
      const rawFile = await invoke<string>("read_file_content", { path: canvasFilePath });
      const parsed = JSON.parse(rawFile);
      if (parsed && Array.isArray(parsed.nodes)) {
        board = parsed;
      }
    } catch {
      // ignore
    }
  }
  if (!board) {
    try {
      const cached = localStorage.getItem(boardKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.nodes)) {
          board = parsed;
        }
      }
    } catch {
      // ignore
    }
  }
  if (!board || board.nodes.length === 0) {
    board = buildInitialCanvasFromDocument(docText, options.activeTitle, options.activeFilePath);
  }

  let selectedNodeId: string | null = null;
  let selectedEdgeId: string | null = null;
  let editingNodeId: string | null = null;
  let isLibraryOpen = true;

  const persistBoard = async (showNotice = false) => {
    if (!board) return;
    board.updatedAt = Date.now();
    try {
      localStorage.setItem(boardKey, JSON.stringify(board));
    } catch {
      // ignore
    }
    if (options.workspaceRoot) {
      const sep = options.workspaceRoot.includes("\\") ? "\\" : "/";
      const canvasFilePath = `${options.workspaceRoot.replace(/[\\/]+$/, "")}${sep}.quilla-canvas.json`;
      await invoke("save_file_content", {
        path: canvasFilePath,
        content: JSON.stringify(board, null, 2),
      }).catch(() => {});
    }
    if (showNotice) {
      showToast("已保存 Canvas 无限白板编排状态", "success");
    }
  };

  canvasModalEl.classList.remove("hidden");
  canvasModalEl.innerHTML = `
    <div class="ty-modal-card canvas-modal-card" role="dialog" aria-modal="true">
      <div class="ty-modal-header">
        <div class="modal-title">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7" rx="1.5"></rect>
            <rect x="14" y="3" width="7" height="7" rx="1.5"></rect>
            <rect x="8" y="14" width="8" height="7" rx="1.5"></rect>
            <path d="M6.5 10v2a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2"></path>
          </svg>
          <span>Canvas 无限白板与多文档知识卡片编排</span>
          <span class="modal-badge">Ctrl + Alt + C</span>
        </div>
        <div class="canvas-top-toolbar">
          <button type="button" class="canvas-tool-btn" id="canvas-toggle-lib-btn" title="显示/收起左侧章节与块素材库">侧栏素材库</button>
          <button type="button" class="canvas-tool-btn" id="canvas-add-text-btn">+ 灵感便签</button>
          <button type="button" class="canvas-tool-btn" id="canvas-add-group-btn">+ 分组画框</button>
          <button type="button" class="canvas-tool-btn" id="canvas-auto-generate-btn" title="从当前文档章节与 ^block-id 重新生成卡片布局">智能重排</button>
          <button type="button" class="canvas-tool-btn ${board.snapToGrid ? "active" : ""}" id="canvas-snap-grid-btn">网格吸附</button>
          <div class="canvas-zoom-controls">
            <button type="button" class="canvas-zoom-btn" id="canvas-zoom-out-btn" title="缩小">−</button>
            <span class="canvas-zoom-label" id="canvas-zoom-label">100%</span>
            <button type="button" class="canvas-zoom-btn" id="canvas-zoom-in-btn" title="放大">+</button>
            <button type="button" class="canvas-zoom-btn" id="canvas-zoom-reset-btn" title="适应画布">重置</button>
          </div>
          <button type="button" class="canvas-tool-btn" id="canvas-switch-graph-btn" title="切换到力导向双链知识图谱">力导向图谱</button>
          <button type="button" class="ty-btn-primary compact" id="canvas-save-btn">保存白板</button>
          <button type="button" class="modal-close-btn" id="canvas-close-btn" title="关闭 (Esc)">✕</button>
        </div>
      </div>

      <div class="canvas-main-layout">
        <!-- 左侧可拖拽章节、^block-id 与多文档素材抽屉 -->
        <aside class="canvas-library-drawer" id="canvas-library-drawer">
          <div class="canvas-drawer-section">
            <div class="canvas-drawer-title">当前文档章节 (拖拽入画布)</div>
            <div class="canvas-drawer-list" id="canvas-drawer-headings">
              ${
                libItems.headings.length === 0
                  ? `<div class="canvas-drawer-empty">当前文档暂无标题章节</div>`
                  : libItems.headings
                      .map(
                        (h, idx) => `
                    <div class="canvas-drawer-item" draggable="true" data-drag-type="section" data-heading="${escapeHtml(h.text)}" data-preview="${escapeHtml(h.preview)}">
                      <span class="drawer-badge">H${h.level}</span>
                      <span class="drawer-item-label">${escapeHtml(h.text)}</span>
                      <button type="button" class="drawer-quick-add" data-quick-idx="sec-${idx}" title="添加到画布">+</button>
                    </div>`
                      )
                      .join("")
              }
            </div>
          </div>

          <div class="canvas-drawer-section">
            <div class="canvas-drawer-title">块级锚点 ^block-id (${libItems.blocks.length})</div>
            <div class="canvas-drawer-list" id="canvas-drawer-blocks">
              ${
                libItems.blocks.length === 0
                  ? `<div class="canvas-drawer-empty">在行尾添加 ^id 即可拖拽块引用</div>`
                  : libItems.blocks
                      .map(
                        (b, idx) => `
                    <div class="canvas-drawer-item" draggable="true" data-drag-type="block" data-block-id="${escapeHtml(b.blockId)}" data-preview="${escapeHtml(b.text)}">
                      <span class="drawer-badge block">^${escapeHtml(b.blockId)}</span>
                      <span class="drawer-item-label">${escapeHtml(b.text)}</span>
                      <button type="button" class="drawer-quick-add" data-quick-idx="blk-${idx}" title="添加到画布">+</button>
                    </div>`
                      )
                      .join("")
              }
            </div>
          </div>

          <div class="canvas-drawer-section">
            <div class="canvas-drawer-title">工作区多文档笔记</div>
            <div class="canvas-drawer-list" id="canvas-drawer-notes">
              ${
                !options.workspaceFiles || options.workspaceFiles.length === 0
                  ? `<div class="canvas-drawer-empty">打开工作区文件夹后可跨文档拖入笔记</div>`
                  : options.workspaceFiles
                      .slice(0, 30)
                      .map(
                        (f, idx) => `
                    <div class="canvas-drawer-item" draggable="true" data-drag-type="note" data-note-path="${escapeHtml(f.path)}" data-note-stem="${escapeHtml(f.stem)}">
                      <span class="drawer-badge note">MD</span>
                      <span class="drawer-item-label">${escapeHtml(f.stem)}</span>
                      <button type="button" class="drawer-quick-add" data-quick-idx="note-${idx}" title="添加到画布">+</button>
                    </div>`
                      )
                      .join("")
              }
            </div>
          </div>
        </aside>

        <!-- 右侧无限缩放点阵画布视口 -->
        <div class="canvas-viewport" id="canvas-viewport">
          <div class="canvas-transform-stage" id="canvas-transform-stage">
            <svg class="canvas-edges-svg" id="canvas-edges-svg" width="4000" height="3000" overflow="visible">
              <defs>
                <marker id="canvas-arrow-default" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor"></path>
                </marker>
              </defs>
              <g id="canvas-edges-group"></g>
              <path id="canvas-temp-wire" class="canvas-temp-wire hidden" d="" fill="none" stroke-width="2" stroke-dasharray="5,4"></path>
            </svg>
            <div class="canvas-nodes-layer" id="canvas-nodes-layer"></div>
          </div>

          <div class="canvas-hud-footer">
            <span>操作指南：从左侧拖入章节 / <code>^block-id</code> 块 · 拖拽卡片四边圆点连线 · 双击卡片正文原位编辑 · 滚轮缩放 / 拖拽空白平移</span>
          </div>
        </div>
      </div>
    </div>
  `;

  const viewportEl = canvasModalEl.querySelector("#canvas-viewport") as HTMLElement;
  const stageEl = canvasModalEl.querySelector("#canvas-transform-stage") as HTMLElement;
  const edgesGroupEl = canvasModalEl.querySelector("#canvas-edges-group") as SVGGElement;
  const tempWireEl = canvasModalEl.querySelector("#canvas-temp-wire") as SVGPathElement;
  const nodesLayerEl = canvasModalEl.querySelector("#canvas-nodes-layer") as HTMLElement;
  const zoomLabelEl = canvasModalEl.querySelector("#canvas-zoom-label") as HTMLElement;
  const drawerEl = canvasModalEl.querySelector("#canvas-library-drawer") as HTMLElement;

  const snapVal = (v: number): number => {
    if (!board?.snapToGrid) return Math.round(v);
    return Math.round(v / 16) * 16;
  };

  const applyTransform = () => {
    if (!board) return;
    stageEl.style.transform = `translate(${board.panX}px, ${board.panY}px) scale(${board.zoom})`;
    if (zoomLabelEl) {
      zoomLabelEl.textContent = `${Math.round(board.zoom * 100)}%`;
    }
  };

  const renderEdges = () => {
    if (!board) return;
    const nodeMap = new Map(board.nodes.map((n) => [n.id, n]));
    const parts: string[] = [];

    for (const edge of board.edges) {
      const fromNode = nodeMap.get(edge.fromNode);
      const toNode = nodeMap.get(edge.toNode);
      if (!fromNode || !toNode) continue;

      const p1 = getPortCoordinates(fromNode, edge.fromSide);
      const p2 = getPortCoordinates(toNode, edge.toSide);
      const d = buildBezierPathD(p1, edge.fromSide, p2, edge.toSide);
      const midX = Math.round((p1.x + p2.x) / 2);
      const midY = Math.round((p1.y + p2.y) / 2);
      const isSelected = edge.id === selectedEdgeId;

      parts.push(`
        <g class="canvas-edge-item color-${edge.color || "celadon"} ${isSelected ? "selected" : ""}" data-edge-id="${edge.id}">
          <path class="canvas-edge-hit" d="${d}" fill="none" stroke="transparent" stroke-width="14"></path>
          <path class="canvas-edge-path" d="${d}" fill="none" stroke-width="${isSelected ? "2.6" : "2"}" marker-end="url(#canvas-arrow-default)"></path>
          ${
            edge.label
              ? `<g transform="translate(${midX}, ${midY})">
                  <rect x="-38" y="-11" width="76" height="22" rx="6" class="canvas-edge-label-bg"></rect>
                  <text text-anchor="middle" dy="4" class="canvas-edge-label-text">${escapeHtml(edge.label)}</text>
                </g>`
              : ""
          }
        </g>
      `);
    }

    edgesGroupEl.innerHTML = parts.join("");

    edgesGroupEl.querySelectorAll(".canvas-edge-item").forEach((g) => {
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedEdgeId = (g as HTMLElement).dataset.edgeId || null;
        selectedNodeId = null;
        renderBoard();
      });
      g.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const edgeId = (g as HTMLElement).dataset.edgeId;
        if (!edgeId || !board) return;
        board.edges = board.edges.filter((ed) => ed.id !== edgeId);
        selectedEdgeId = null;
        persistBoard();
        renderBoard();
        showToast("已删除连线", "info");
      });
    });
  };

  const renderNodes = () => {
    if (!board) return;
    // 确保分组框 (group) 在底层渲染，普通卡片在上层
    const sortedNodes = [...board.nodes].sort((a, b) => {
      if (a.type === "group" && b.type !== "group") return -1;
      if (a.type !== "group" && b.type === "group") return 1;
      return 0;
    });

    nodesLayerEl.innerHTML = sortedNodes
      .map((node) => {
        const isSelected = node.id === selectedNodeId;
        const isEditing = node.id === editingNodeId;
        const typeBadge =
          node.type === "note"
            ? "笔记"
            : node.type === "section"
              ? "章节"
              : node.type === "block"
                ? "^块引用"
                : node.type === "group"
                  ? "分组框"
                  : "便签";

        const bodyHtml =
          node.type === "group"
            ? ""
            : isEditing
              ? `<textarea class="canvas-card-editor" data-edit-node="${node.id}" spellcheck="false">${escapeHtml(node.content)}</textarea>`
              : `<div class="canvas-card-markdown">${renderMarkdownDocumentToHtmlSync(node.content || "_双击卡片编辑内容_")}</div>`;

        return `
          <div class="canvas-card-node type-${node.type} palette-${node.color} ${isSelected ? "selected" : ""}"
               data-node-id="${node.id}"
               style="left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px;">
            <div class="canvas-card-header" data-drag-handle="${node.id}">
              <span class="canvas-card-type-pill">${typeBadge}</span>
              <span class="canvas-card-title" title="${escapeHtml(node.title)}">${escapeHtml(node.title)}</span>
              <div class="canvas-card-actions">
                ${
                  node.filePath || node.headingAnchor
                    ? `<button type="button" class="canvas-card-icon-btn" data-action="jump" data-node="${node.id}" title="跳转到源文档对应位置">↗</button>`
                    : ""
                }
                ${
                  (node.type === "section" || node.type === "block") && node.headingAnchor
                    ? `<button type="button" class="canvas-card-icon-btn" data-action="sync-back" data-node="${node.id}" title="将卡片改动双向写回源文档章节/块">⇄</button>`
                    : ""
                }
                <button type="button" class="canvas-card-icon-btn danger" data-action="delete" data-node="${node.id}" title="移除卡片">✕</button>
              </div>
            </div>
            ${
              isSelected
                ? `<div class="canvas-card-palette-bar">
                    ${INKSTONE_CARD_PALETTES.map(
                      (p) =>
                        `<button type="button" class="canvas-color-dot ${node.color === p.id ? "active" : ""}" data-color="${p.id}" data-node="${node.id}" title="${p.label}" style="background:${p.swatch}"></button>`
                    ).join("")}
                  </div>`
                : ""
            }
            ${node.type === "group" ? "" : `<div class="canvas-card-body" data-body-node="${node.id}">${bodyHtml}</div>`}
            <span class="canvas-port port-top" data-port="top" data-node="${node.id}" title="拖拽连线"></span>
            <span class="canvas-port port-right" data-port="right" data-node="${node.id}" title="拖拽连线"></span>
            <span class="canvas-port port-bottom" data-port="bottom" data-node="${node.id}" title="拖拽连线"></span>
            <span class="canvas-port port-left" data-port="left" data-node="${node.id}" title="拖拽连线"></span>
            <span class="canvas-resize-grip" data-resize-node="${node.id}" title="拖拽缩放尺寸"></span>
          </div>
        `;
      })
      .join("");

    // 绑定卡片内事件
    nodesLayerEl.querySelectorAll(".canvas-card-node").forEach((el) => {
      const nodeId = (el as HTMLElement).dataset.nodeId!;
      el.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        if (selectedNodeId !== nodeId) {
          selectedNodeId = nodeId;
          selectedEdgeId = null;
          renderNodes();
          renderEdges();
        }
      });
    });

    nodesLayerEl.querySelectorAll("[data-body-node]").forEach((bodyEl) => {
      bodyEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const nodeId = (bodyEl as HTMLElement).dataset.bodyNode!;
        editingNodeId = nodeId;
        renderNodes();
        const ta = nodesLayerEl.querySelector(
          `textarea[data-edit-node="${nodeId}"]`
        ) as HTMLTextAreaElement | null;
        ta?.focus();
      });
    });

    nodesLayerEl.querySelectorAll("textarea[data-edit-node]").forEach((ta) => {
      const el = ta as HTMLTextAreaElement;
      const nodeId = el.dataset.editNode!;
      el.addEventListener("mousedown", (e) => e.stopPropagation());
      el.addEventListener("input", () => {
        const target = board?.nodes.find((n) => n.id === nodeId);
        if (target) {
          target.content = el.value;
        }
      });
      el.addEventListener("blur", () => {
        editingNodeId = null;
        persistBoard();
        renderNodes();
      });
    });

    nodesLayerEl.querySelectorAll(".canvas-color-dot").forEach((dot) => {
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        const nodeId = (dot as HTMLElement).dataset.node!;
        const color = (dot as HTMLElement).dataset.color as CanvasColorId;
        const target = board?.nodes.find((n) => n.id === nodeId);
        if (target && color) {
          target.color = color;
          persistBoard();
          renderNodes();
          renderEdges();
        }
      });
    });

    nodesLayerEl.querySelectorAll(".canvas-card-icon-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const action = (btn as HTMLElement).dataset.action;
        const nodeId = (btn as HTMLElement).dataset.node!;
        const target = board?.nodes.find((n) => n.id === nodeId);
        if (!target || !board) return;

        if (action === "delete") {
          board.nodes = board.nodes.filter((n) => n.id !== nodeId);
          board.edges = board.edges.filter(
            (ed) => ed.fromNode !== nodeId && ed.toNode !== nodeId
          );
          selectedNodeId = null;
          persistBoard();
          renderBoard();
        } else if (action === "jump") {
          canvasModalEl?.classList.add("hidden");
          if (target.filePath) {
            options.onOpenNote?.(target.filePath, target.headingAnchor || undefined);
          } else if (target.headingAnchor && options.activeFilePath) {
            options.onOpenNote?.(options.activeFilePath, target.headingAnchor);
          }
        } else if (action === "sync-back" && target.headingAnchor) {
          const isSelf =
            !target.filePath ||
            (options.activeFilePath &&
              target.filePath.replace(/\\/g, "/").toLowerCase() ===
                options.activeFilePath.replace(/\\/g, "/").toLowerCase());
          const ok = await updateTransclusionSectionContent(
            isSelf ? "" : target.filePath || "",
            target.headingAnchor,
            target.content,
            options.view || undefined
          );
          if (ok) {
            showToast(`已将卡片改动双向写回「${target.headingAnchor}」`, "success");
          } else {
            showToast("未找到匹配的源章节或块锚点", "error");
          }
        }
      });
    });
  };

  const renderBoard = () => {
    applyTransform();
    renderNodes();
    renderEdges();
  };

  // 视口拖拽卡片、缩放尺寸、端口连线与画布平移交互
  let dragState:
    | {
        mode: "pan";
        startX: number;
        startY: number;
        origPanX: number;
        origPanY: number;
      }
    | {
        mode: "move-node";
        node: CanvasCardNode;
        startX: number;
        startY: number;
        origX: number;
        origY: number;
        containedChildren: Array<{ node: CanvasCardNode; origX: number; origY: number }>;
      }
    | {
        mode: "resize-node";
        node: CanvasCardNode;
        startX: number;
        startY: number;
        origW: number;
        origH: number;
      }
    | {
        mode: "connect-port";
        fromNode: CanvasCardNode;
        fromSide: CanvasPortSide;
      }
    | null = null;

  viewportEl.addEventListener(
    "mousedown",
    (e) => {
      if (!board) return;
      const target = e.target as HTMLElement;

      const portEl = target.closest(".canvas-port") as HTMLElement | null;
      if (portEl) {
        e.preventDefault();
        e.stopPropagation();
        const nodeId = portEl.dataset.node!;
        const side = portEl.dataset.port as CanvasPortSide;
        const fromNode = board.nodes.find((n) => n.id === nodeId);
        if (fromNode && side) {
          dragState = { mode: "connect-port", fromNode, fromSide: side };
          tempWireEl.classList.remove("hidden");
        }
        return;
      }

      const resizeEl = target.closest("[data-resize-node]") as HTMLElement | null;
      if (resizeEl) {
        e.preventDefault();
        e.stopPropagation();
        const nodeId = resizeEl.dataset.resizeNode!;
        const node = board.nodes.find((n) => n.id === nodeId);
        if (node) {
          dragState = {
            mode: "resize-node",
            node,
            startX: e.clientX,
            startY: e.clientY,
            origW: node.width,
            origH: node.height,
          };
        }
        return;
      }

      const headerEl = target.closest("[data-drag-handle]") as HTMLElement | null;
      if (headerEl && !target.closest(".canvas-card-icon-btn")) {
        e.preventDefault();
        e.stopPropagation();
        const nodeId = headerEl.dataset.dragHandle!;
        const node = board.nodes.find((n) => n.id === nodeId);
        if (node) {
          // 若拖动的是 group 分组框，找出框内的子卡片同步拖动
          const containedChildren =
            node.type === "group"
              ? board.nodes
                  .filter(
                    (c) =>
                      c.id !== node.id &&
                      c.x >= node.x &&
                      c.y >= node.y &&
                      c.x + c.width <= node.x + node.width &&
                      c.y + c.height <= node.y + node.height
                  )
                  .map((c) => ({ node: c, origX: c.x, origY: c.y }))
              : [];

          dragState = {
            mode: "move-node",
            node,
            startX: e.clientX,
            startY: e.clientY,
            origX: node.x,
            origY: node.y,
            containedChildren,
          };
        }
        return;
      }

      if (!target.closest(".canvas-card-node")) {
        selectedNodeId = null;
        selectedEdgeId = null;
        editingNodeId = null;
        renderBoard();
        dragState = {
          mode: "pan",
          startX: e.clientX,
          startY: e.clientY,
          origPanX: board.panX,
          origPanY: board.panY,
        };
      }
    },
    { signal }
  );

  window.addEventListener(
    "mousemove",
    (e) => {
      if (!dragState || !board) return;
      if (dragState.mode === "pan") {
        board.panX = Math.round(dragState.origPanX + (e.clientX - dragState.startX));
        board.panY = Math.round(dragState.origPanY + (e.clientY - dragState.startY));
        applyTransform();
      } else if (dragState.mode === "move-node") {
        const dx = (e.clientX - dragState.startX) / board.zoom;
        const dy = (e.clientY - dragState.startY) / board.zoom;
        const nextX = snapVal(dragState.origX + dx);
        const nextY = snapVal(dragState.origY + dy);
        const actualDx = nextX - dragState.origX;
        const actualDy = nextY - dragState.origY;
        dragState.node.x = nextX;
        dragState.node.y = nextY;

        const domCard = nodesLayerEl.querySelector(
          `.canvas-card-node[data-node-id="${dragState.node.id}"]`
        ) as HTMLElement | null;
        if (domCard) {
          domCard.style.left = `${nextX}px`;
          domCard.style.top = `${nextY}px`;
        }

        for (const child of dragState.containedChildren) {
          child.node.x = child.origX + actualDx;
          child.node.y = child.origY + actualDy;
          const childDom = nodesLayerEl.querySelector(
            `.canvas-card-node[data-node-id="${child.node.id}"]`
          ) as HTMLElement | null;
          if (childDom) {
            childDom.style.left = `${child.node.x}px`;
            childDom.style.top = `${child.node.y}px`;
          }
        }
        renderEdges();
      } else if (dragState.mode === "resize-node") {
        const dw = (e.clientX - dragState.startX) / board.zoom;
        const dh = (e.clientY - dragState.startY) / board.zoom;
        dragState.node.width = Math.max(180, snapVal(dragState.origW + dw));
        dragState.node.height = Math.max(110, snapVal(dragState.origH + dh));
        const domCard = nodesLayerEl.querySelector(
          `.canvas-card-node[data-node-id="${dragState.node.id}"]`
        ) as HTMLElement | null;
        if (domCard) {
          domCard.style.width = `${dragState.node.width}px`;
          domCard.style.height = `${dragState.node.height}px`;
        }
        renderEdges();
      } else if (dragState.mode === "connect-port") {
        const rect = viewportEl.getBoundingClientRect();
        const canvasX = (e.clientX - rect.left - board.panX) / board.zoom;
        const canvasY = (e.clientY - rect.top - board.panY) / board.zoom;
        const p1 = getPortCoordinates(dragState.fromNode, dragState.fromSide);
        const d = buildBezierPathD(
          p1,
          dragState.fromSide,
          { x: canvasX, y: canvasY },
          "left"
        );
        tempWireEl.setAttribute("d", d);
      }
    },
    { signal }
  );

  window.addEventListener(
    "mouseup",
    (e) => {
      if (!dragState || !board) return;
      if (dragState.mode === "connect-port") {
        tempWireEl.classList.add("hidden");
        const target = e.target as HTMLElement;
        const toPort = target.closest(".canvas-port") as HTMLElement | null;
        const toCard = target.closest(".canvas-card-node") as HTMLElement | null;
        const toNodeId = toPort?.dataset.node || toCard?.dataset.nodeId;
        const toSide: CanvasPortSide =
          (toPort?.dataset.port as CanvasPortSide) || "left";
        if (toNodeId && toNodeId !== dragState.fromNode.id) {
          board.edges.push({
            id: `edge-${Date.now()}`,
            fromNode: dragState.fromNode.id,
            fromSide: dragState.fromSide,
            toNode: toNodeId,
            toSide,
            color: dragState.fromNode.color,
          });
          persistBoard();
          renderEdges();
        }
      } else if (dragState.mode === "move-node" || dragState.mode === "resize-node") {
        persistBoard();
      }
      dragState = null;
    },
    { signal }
  );

  viewportEl.addEventListener(
    "wheel",
    (e) => {
      if (!board) return;
      if ((e.target as HTMLElement).closest(".canvas-card-body")) {
        return;
      }
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const nextZoom = Math.max(0.28, Math.min(2.4, Number((board.zoom * factor).toFixed(2))));
      board.zoom = nextZoom;
      applyTransform();
    },
    { passive: false, signal }
  );

  // 左侧抽屉拖拽到画布生成卡片
  const addLibraryCardToCanvas = async (
    dragType: "section" | "block" | "note",
    payload: {
      heading?: string;
      blockId?: string;
      preview?: string;
      notePath?: string;
      noteStem?: string;
    },
    dropX?: number,
    dropY?: number
  ) => {
    if (!board) return;
    const x = snapVal(dropX ?? 220 + (board.nodes.length % 4) * 60);
    const y = snapVal(dropY ?? 140 + (board.nodes.length % 4) * 50);

    if (dragType === "section" && payload.heading) {
      let body = payload.preview || "";
      const fetched = await fetchTransclusionSectionContent(
        options.activeFilePath || "",
        payload.heading,
        docText
      ).catch(() => null);
      if (fetched && fetched.found && fetched.content) body = fetched.content;
      board.nodes.push({
        id: `card-sec-${Date.now()}`,
        type: "section",
        title: payload.heading,
        content: body,
        filePath: options.activeFilePath,
        headingAnchor: payload.heading,
        x,
        y,
        width: 270,
        height: 205,
        color: "celadon",
      });
    } else if (dragType === "block" && payload.blockId) {
      board.nodes.push({
        id: `card-blk-${Date.now()}`,
        type: "block",
        title: `块引用 #^${payload.blockId}`,
        content: payload.preview || `![[#^${payload.blockId}]]`,
        filePath: options.activeFilePath,
        headingAnchor: `^${payload.blockId}`,
        blockId: payload.blockId,
        x,
        y,
        width: 265,
        height: 175,
        color: "amber",
      });
    } else if (dragType === "note" && payload.notePath) {
      let excerpt = `[[${payload.noteStem || "笔记"}]]`;
      try {
        const raw = await invoke<string>("read_file_content", { path: payload.notePath });
        excerpt = raw.replace(/\r\n/g, "\n").split("\n").slice(0, 10).join("\n");
      } catch {
        // ignore
      }
      board.nodes.push({
        id: `card-note-${Date.now()}`,
        type: "note",
        title: payload.noteStem || "文档卡片",
        content: excerpt,
        filePath: payload.notePath,
        x,
        y,
        width: 280,
        height: 210,
        color: "bamboo",
      });
    }
    persistBoard();
    renderBoard();
  };

  drawerEl.querySelectorAll(".canvas-drawer-item").forEach((item) => {
    item.addEventListener("dragstart", (e: Event) => {
      const de = e as DragEvent;
      const el = item as HTMLElement;
      de.dataTransfer?.setData(
        "application/quilla-canvas-item",
        JSON.stringify({
          dragType: el.dataset.dragType,
          heading: el.dataset.heading,
          blockId: el.dataset.blockId,
          preview: el.dataset.preview,
          notePath: el.dataset.notePath,
          noteStem: el.dataset.noteStem,
        })
      );
    });
  });

  drawerEl.querySelectorAll(".drawer-quick-add").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const parent = (btn as HTMLElement).closest(".canvas-drawer-item") as HTMLElement | null;
      if (!parent) return;
      addLibraryCardToCanvas(parent.dataset.dragType as any, {
        heading: parent.dataset.heading,
        blockId: parent.dataset.blockId,
        preview: parent.dataset.preview,
        notePath: parent.dataset.notePath,
        noteStem: parent.dataset.noteStem,
      });
    });
  });

  viewportEl.addEventListener("dragover", (e) => {
    e.preventDefault();
  });

  viewportEl.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!board) return;
    const raw = e.dataTransfer?.getData("application/quilla-canvas-item");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const rect = viewportEl.getBoundingClientRect();
      const dropX = (e.clientX - rect.left - board.panX) / board.zoom;
      const dropY = (e.clientY - rect.top - board.panY) / board.zoom;
      addLibraryCardToCanvas(parsed.dragType, parsed, dropX, dropY);
    } catch {
      // ignore
    }
  });

  // 顶部工具栏按钮绑定
  canvasModalEl.querySelector("#canvas-toggle-lib-btn")?.addEventListener("click", () => {
    isLibraryOpen = !isLibraryOpen;
    drawerEl.classList.toggle("collapsed", !isLibraryOpen);
  });

  canvasModalEl.querySelector("#canvas-add-text-btn")?.addEventListener("click", () => {
    if (!board) return;
    const id = `card-text-${Date.now()}`;
    board.nodes.push({
      id,
      type: "text",
      title: "灵感便签",
      content: "在此输入 Markdown 笔记或 `[[双链]]` 想法...",
      x: snapVal(260 + (board.nodes.length % 5) * 35),
      y: snapVal(160 + (board.nodes.length % 5) * 35),
      width: 250,
      height: 175,
      color: "paper",
    });
    selectedNodeId = id;
    editingNodeId = id;
    persistBoard();
    renderBoard();
  });

  canvasModalEl.querySelector("#canvas-add-group-btn")?.addEventListener("click", () => {
    if (!board) return;
    const id = `group-${Date.now()}`;
    board.nodes.unshift({
      id,
      type: "group",
      title: "主题分组区域",
      content: "",
      x: snapVal(120),
      y: snapVal(100),
      width: 520,
      height: 360,
      color: "bamboo",
    });
    selectedNodeId = id;
    persistBoard();
    renderBoard();
  });

  canvasModalEl.querySelector("#canvas-auto-generate-btn")?.addEventListener("click", () => {
    board = buildInitialCanvasFromDocument(
      options.view?.state.doc.toString() || docText,
      options.activeTitle,
      options.activeFilePath
    );
    persistBoard(true);
    renderBoard();
  });

  canvasModalEl.querySelector("#canvas-snap-grid-btn")?.addEventListener("click", (e) => {
    if (!board) return;
    board.snapToGrid = !board.snapToGrid;
    (e.currentTarget as HTMLElement).classList.toggle("active", board.snapToGrid);
    persistBoard();
  });

  canvasModalEl.querySelector("#canvas-zoom-in-btn")?.addEventListener("click", () => {
    if (!board) return;
    board.zoom = Math.min(2.4, Number((board.zoom + 0.15).toFixed(2)));
    applyTransform();
  });

  canvasModalEl.querySelector("#canvas-zoom-out-btn")?.addEventListener("click", () => {
    if (!board) return;
    board.zoom = Math.max(0.28, Number((board.zoom - 0.15).toFixed(2)));
    applyTransform();
  });

  canvasModalEl.querySelector("#canvas-zoom-reset-btn")?.addEventListener("click", () => {
    if (!board) return;
    board.panX = 20;
    board.panY = 16;
    board.zoom = 1;
    applyTransform();
  });

  canvasModalEl.querySelector("#canvas-switch-graph-btn")?.addEventListener("click", () => {
    canvasModalEl?.classList.add("hidden");
    options.onSwitchToGraph?.();
  });

  canvasModalEl.querySelector("#canvas-save-btn")?.addEventListener("click", () => {
    persistBoard(true);
  });

  canvasModalEl.querySelector("#canvas-close-btn")?.addEventListener("click", () => {
    persistBoard();
    canvasModalEl?.classList.add("hidden");
  });

  renderBoard();
}
