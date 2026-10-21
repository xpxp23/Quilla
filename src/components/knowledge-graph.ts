import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import { parseWikiLinksInLine } from "../editor/extensions/wiki-link";

export interface GraphNodeItem {
  id: string;
  label: string;
  path: string | null;
  exists: boolean;
  is_active: boolean;
  in_degree: number;
  out_degree: number;
}

export interface GraphEdgeItem {
  source: string;
  target: string;
}

export interface KnowledgeGraphData {
  nodes: GraphNodeItem[];
  edges: GraphEdgeItem[];
}

export interface TagCountItem {
  tag: string;
  count: number;
  files: string[];
}

interface SimNode extends GraphNodeItem {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeGraphData(raw: any): KnowledgeGraphData {
  const rawNodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
  const rawEdges = Array.isArray(raw?.edges) ? raw.edges : [];
  const nodes: GraphNodeItem[] = rawNodes.map((n: any) => {
    const inDeg = Number(n?.in_degree ?? n?.inDegree ?? n?.degree ?? 0);
    const outDeg = Number(n?.out_degree ?? n?.outDegree ?? 0);
    return {
      id: String(n?.id || ""),
      label: String(n?.label || n?.id || ""),
      path: n?.path || null,
      exists: Boolean(n?.exists),
      is_active: Boolean(n?.is_active ?? n?.isCenter),
      in_degree: Number.isFinite(inDeg) ? inDeg : 0,
      out_degree: Number.isFinite(outDeg) ? outDeg : 0,
    };
  });
  const edges: GraphEdgeItem[] = rawEdges.map((e: any) => ({
    source: String(e?.source || ""),
    target: String(e?.target || ""),
  }));
  return { nodes, edges };
}

/**
 * 当未打开工作区或仅单篇文档时，从当前编辑器文档实时提取双链、嵌入块与章节结构构建知识图谱
 */
function buildFallbackGraphFromEditor(
  view: EditorView | null,
  activeTitle: string,
  activeFilePath: string | null
): KnowledgeGraphData {
  const centerId = activeTitle.replace(/\.(md|markdown|txt)$/i, "") || "当前笔记";
  const nodesMap = new Map<string, GraphNodeItem>();
  const edges: GraphEdgeItem[] = [];

  nodesMap.set(centerId.toLowerCase(), {
    id: centerId.toLowerCase(),
    label: centerId,
    path: activeFilePath,
    exists: true,
    is_active: true,
    in_degree: 0,
    out_degree: 0,
  });

  if (view) {
    const doc = view.state.doc;
    const seenEdges = new Set<string>();
    for (let i = 1; i <= doc.lines; i++) {
      const text = doc.line(i).text;
      const links = parseWikiLinksInLine(text);
      for (const wl of links) {
        const targetLabel = (wl.target || wl.heading || "").trim();
        if (!targetLabel) continue;
        const targetId = targetLabel.toLowerCase();
        if (targetId === centerId.toLowerCase()) continue;

        if (!nodesMap.has(targetId)) {
          nodesMap.set(targetId, {
            id: targetId,
            label: targetLabel,
            path: null,
            exists: false,
            is_active: false,
            in_degree: 0,
            out_degree: 0,
          });
        }
        const edgeKey = `${centerId.toLowerCase()}->${targetId}`;
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          edges.push({ source: centerId.toLowerCase(), target: targetId });
          nodesMap.get(centerId.toLowerCase())!.out_degree++;
          nodesMap.get(targetId)!.in_degree++;
        }
      }
    }
  }

  return {
    nodes: Array.from(nodesMap.values()),
    edges,
  };
}

let graphModalEl: HTMLElement | null = null;
let animFrameId: number | null = null;
let graphWindowListenersAbort: AbortController | null = null;

export async function openKnowledgeGraphModal(options: {
  view: EditorView | null;
  activeFilePath: string | null;
  activeTitle: string;
  hasWorkspace: boolean;
  onOpenNote: (pathOrName: string, exists: boolean) => void;
}) {
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (graphWindowListenersAbort) {
    graphWindowListenersAbort.abort();
    graphWindowListenersAbort = null;
  }

  if (!graphModalEl) {
    graphModalEl = document.createElement("div");
    graphModalEl.id = "quilla-knowledge-graph-modal";
    graphModalEl.className = "ty-modal-overlay";
    document.body.appendChild(graphModalEl);
  }

  let currentScope: "local-1" | "local-2" | "global" = options.hasWorkspace ? "local-2" : "global";
  let filterKeyword = "";

  graphModalEl.classList.remove("hidden");
  graphModalEl.innerHTML = `
    <div class="ty-modal-card graph-modal-card" role="dialog" aria-modal="true">
      <div class="ty-modal-header">
        <div class="modal-title">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="6" r="3"></circle><circle cx="12" cy="18" r="3"></circle><line x1="8.6" y1="7.5" x2="15.4" y2="7.5"></line><line x1="7.5" y1="8.6" x2="10.5" y2="15.4"></line><line x1="16.5" y1="8.6" x2="13.5" y2="15.4"></line></svg>
          <span>双向链接知识图谱</span>
          <span class="modal-badge">Ctrl + G</span>
        </div>
        <div class="graph-toolbar-controls">
          <div class="graph-scope-Segment">
            <button type="button" class="graph-scope-btn ${(currentScope as string) === "local-1" ? "active" : ""}" data-scope="local-1">1 跳邻域</button>
            <button type="button" class="graph-scope-btn ${currentScope === "local-2" ? "active" : ""}" data-scope="local-2">2 跳关系</button>
            <button type="button" class="graph-scope-btn ${currentScope === "global" ? "active" : ""}" data-scope="global">全局图谱</button>
          </div>
          <input type="text" class="graph-filter-input" id="graph-node-filter" placeholder="筛选节点名称..." />
          <button type="button" class="modal-close-btn" id="graph-close-btn" title="关闭 (Esc)">✕</button>
        </div>
      </div>

      <div class="graph-canvas-wrapper" id="graph-canvas-wrapper">
        <svg id="quilla-graph-svg" class="quilla-graph-svg" width="100%" height="100%"></svg>
        <div class="graph-legend-bar">
          <span class="graph-legend-item"><i class="dot active-dot"></i>当前文档</span>
          <span class="graph-legend-item"><i class="dot exists-dot"></i>已存在笔记</span>
          <span class="graph-legend-item"><i class="dot ghost-dot"></i>待创建双链节点</span>
          <span class="graph-stats-text" id="graph-stats-text"></span>
        </div>
      </div>

      <div class="ty-modal-footer">
        <span class="footer-tip">提示：滚轮缩放画布 · 按住空白处平移 · 拖拽节点调整布局 · 点击任意节点直接跳转或新建对应笔记</span>
        <button type="button" class="modal-confirm-btn" id="graph-done-btn">完成</button>
      </div>
    </div>
  `;

  const closeModal = () => {
    if (animFrameId !== null) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    graphModalEl?.classList.add("hidden");
  };

  graphModalEl.querySelector("#graph-close-btn")?.addEventListener("click", closeModal);
  graphModalEl.querySelector("#graph-done-btn")?.addEventListener("click", closeModal);
  graphModalEl.addEventListener("click", (e) => {
    if (e.target === graphModalEl) closeModal();
  });

  const loadAndSimulate = async () => {
    if (animFrameId !== null) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }

    let graphData: KnowledgeGraphData;
    if (options.hasWorkspace) {
      const localDepth =
        currentScope === "local-1" ? 1 : currentScope === "local-2" ? 2 : 0;
      try {
        const rawRes = await invoke<any>("get_workspace_graph", {
          centerPath: options.activeFilePath,
          activeFilePath: options.activeFilePath,
          localDepth,
        });
        graphData = normalizeGraphData(rawRes);
        if (graphData.nodes.length === 0) {
          graphData = buildFallbackGraphFromEditor(
            options.view,
            options.activeTitle,
            options.activeFilePath
          );
        }
      } catch {
        graphData = buildFallbackGraphFromEditor(
          options.view,
          options.activeTitle,
          options.activeFilePath
        );
      }
    } else {
      graphData = buildFallbackGraphFromEditor(
        options.view,
        options.activeTitle,
        options.activeFilePath
      );
    }

    const kw = filterKeyword.trim().toLowerCase();
    let filteredNodes = graphData.nodes;
    let filteredEdges = graphData.edges;
    if (kw) {
      const matchedIds = new Set(
        graphData.nodes
          .filter((n) => n.label.toLowerCase().includes(kw) || n.is_active)
          .map((n) => n.id)
      );
      filteredEdges = graphData.edges.filter(
        (e) => matchedIds.has(e.source) && matchedIds.has(e.target)
      );
      filteredNodes = graphData.nodes.filter((n) => matchedIds.has(n.id));
    }

    const statsEl = graphModalEl?.querySelector("#graph-stats-text");
    if (statsEl) {
      statsEl.textContent = `共 ${filteredNodes.length} 个节点 · ${filteredEdges.length} 条双向引用`;
    }

    renderInteractiveSvgGraph(filteredNodes, filteredEdges, (node) => {
      closeModal();
      options.onOpenNote(node.path || node.label, node.exists);
    });
  };

  graphModalEl.querySelectorAll<HTMLElement>(".graph-scope-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentScope = (btn.dataset.scope as any) || "global";
      graphModalEl
        ?.querySelectorAll(".graph-scope-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      loadAndSimulate();
    });
  });

  const filterInput = graphModalEl.querySelector("#graph-node-filter") as HTMLInputElement | null;
  filterInput?.addEventListener("input", () => {
    filterKeyword = filterInput.value;
    loadAndSimulate();
  });

  await loadAndSimulate();
}

function renderInteractiveSvgGraph(
  nodes: GraphNodeItem[],
  edges: GraphEdgeItem[],
  onNodeClick: (node: GraphNodeItem) => void
) {
  const svg = document.getElementById("quilla-graph-svg") as SVGSVGElement | null;
  const wrapper = document.getElementById("graph-canvas-wrapper");
  if (!svg || !wrapper) return;

  const width = wrapper.clientWidth || 760;
  const height = wrapper.clientHeight || 460;
  const cx = width / 2;
  const cy = height / 2;

  const simNodes: SimNode[] = nodes.map((n, idx) => {
    const angle = (2 * Math.PI * idx) / Math.max(1, nodes.length);
    const dist = n.is_active ? 0 : Math.min(width, height) * 0.28;
    const deg = Math.max(0, (Number(n.in_degree) || 0) + (Number(n.out_degree) || 0));
    const computedRadius = n.is_active ? 11 : Math.min(13, 6.5 + Math.sqrt(deg) * 1.6);
    return {
      ...n,
      x: cx + Math.cos(angle) * dist + (Math.random() - 0.5) * 20,
      y: cy + Math.sin(angle) * dist + (Math.random() - 0.5) * 20,
      vx: 0,
      vy: 0,
      radius: Number.isFinite(computedRadius) ? computedRadius : 7,
    };
  });

  const nodeById = new Map<string, SimNode>();
  simNodes.forEach((n) => nodeById.set(n.id, n));

  const validEdges = edges
    .map((e) => ({
      source: nodeById.get(e.source),
      target: nodeById.get(e.target),
    }))
    .filter((e): e is { source: SimNode; target: SimNode } => Boolean(e.source && e.target));

  let panX = 0;
  let panY = 0;
  let scale = 1;

  svg.innerHTML = `
    <defs>
      <marker id="graph-arrow" viewBox="0 0 10 10" refX="17" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="currentColor" opacity="0.45" />
      </marker>
    </defs>
    <g id="graph-viewport-g">
      <g id="graph-edges-g"></g>
      <g id="graph-nodes-g"></g>
    </g>
  `;

  const viewportG = svg.querySelector("#graph-viewport-g") as SVGGElement;
  const edgesG = svg.querySelector("#graph-edges-g") as SVGGElement;
  const nodesG = svg.querySelector("#graph-nodes-g") as SVGGElement;

  const updateViewportTransform = () => {
    viewportG.setAttribute("transform", `translate(${panX}, ${panY}) scale(${scale})`);
  };

  const edgeEls = validEdges.map((edge) => {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "graph-edge-line");
    line.setAttribute("marker-end", "url(#graph-arrow)");
    edgesG.appendChild(line);
    return { el: line, edge };
  });

  let draggedNode: SimNode | null = null;
  let dragMoved = false;

  const nodeEls = simNodes.map((node) => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute(
      "class",
      `graph-node-group ${node.is_active ? "is-active" : ""} ${
        node.exists ? "is-exists" : "is-ghost"
      }`
    );

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", String(node.radius));
    circle.setAttribute("class", "graph-node-circle");

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("y", String(node.radius + 13));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("class", "graph-node-label");
    text.textContent = node.label;

    g.appendChild(circle);
    g.appendChild(text);
    nodesG.appendChild(g);

    g.addEventListener("mouseenter", () => {
      const neighborIds = new Set<string>([node.id]);
      edgeEls.forEach(({ el, edge }) => {
        const connected = edge.source.id === node.id || edge.target.id === node.id;
        el.classList.toggle("is-highlighted", connected);
        el.classList.toggle("is-dimmed", !connected);
        if (connected) {
          neighborIds.add(edge.source.id);
          neighborIds.add(edge.target.id);
        }
      });
      nodeEls.forEach((other) => {
        const isNeighbor = neighborIds.has(other.node.id);
        other.el.classList.toggle("is-highlighted", isNeighbor);
        other.el.classList.toggle("is-dimmed", !isNeighbor);
      });
    });

    g.addEventListener("mouseleave", () => {
      edgeEls.forEach(({ el }) => {
        el.classList.remove("is-highlighted", "is-dimmed");
      });
      nodeEls.forEach((other) => {
        other.el.classList.remove("is-highlighted", "is-dimmed");
      });
    });

    g.addEventListener("pointerdown", (e: PointerEvent) => {
      e.stopPropagation();
      draggedNode = node;
      dragMoved = false;
      alpha = Math.max(alpha, 0.35);
      startTicking();
    });

    g.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      if (!dragMoved) {
        onNodeClick(node);
      }
    });

    return { el: g, node };
  });

  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;

  svg.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.target === svg || (e.target as Element).id === "graph-viewport-g") {
      isPanning = true;
      panStartX = e.clientX - panX;
      panStartY = e.clientY - panY;
    }
  });

  if (graphWindowListenersAbort) {
    graphWindowListenersAbort.abort();
  }
  graphWindowListenersAbort = new AbortController();
  const listenerSignal = graphWindowListenersAbort.signal;

  window.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      if (draggedNode) {
        dragMoved = true;
        const rect = svg.getBoundingClientRect();
        draggedNode.x = (e.clientX - rect.left - panX) / scale;
        draggedNode.y = (e.clientY - rect.top - panY) / scale;
        draggedNode.vx = 0;
        draggedNode.vy = 0;
        return;
      }
      if (isPanning) {
        panX = e.clientX - panStartX;
        panY = e.clientY - panStartY;
        updateViewportTransform();
      }
    },
    { signal: listenerSignal }
  );

  window.addEventListener(
    "pointerup",
    () => {
      draggedNode = null;
      isPanning = false;
    },
    { signal: listenerSignal }
  );

  svg.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const nextScale = Math.max(0.35, Math.min(2.8, scale * zoomFactor));
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      panX = mx - ((mx - panX) / scale) * nextScale;
      panY = my - ((my - panY) / scale) * nextScale;
      scale = nextScale;
      updateViewportTransform();
    },
    { passive: false }
  );

  let alpha = 1.0;
  const tick = () => {
    if (alpha < 0.008 && !draggedNode) {
      animFrameId = null;
      return;
    }

    for (let i = 0; i < simNodes.length; i++) {
      for (let j = i + 1; j < simNodes.length; j++) {
        const a = simNodes[i];
        const b = simNodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) {
          dx = (Math.random() - 0.5) * 2;
          dy = (Math.random() - 0.5) * 2;
          distSq = dx * dx + dy * dy;
        }
        const repulse = (1800 * alpha) / distSq;
        const fx = dx * repulse;
        const fy = dy * repulse;
        if (a !== draggedNode) {
          a.vx -= fx;
          a.vy -= fy;
        }
        if (b !== draggedNode) {
          b.vx += fx;
          b.vy += fy;
        }
      }
    }

    const idealLen = 115;
    for (const { source, target } of validEdges) {
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = ((dist - idealLen) / dist) * 0.045 * alpha;
      const fx = dx * force;
      const fy = dy * force;
      if (source !== draggedNode) {
        source.vx += fx;
        source.vy += fy;
      }
      if (target !== draggedNode) {
        target.vx -= fx;
        target.vy -= fy;
      }
    }

    for (const n of simNodes) {
      if (n === draggedNode) continue;
      const gravity = n.is_active ? 0.04 : 0.012;
      n.vx += (cx - n.x) * gravity * alpha;
      n.vy += (cy - n.y) * gravity * alpha;
      n.vx *= 0.82;
      n.vy *= 0.82;
      n.x += n.vx;
      n.y += n.vy;
    }

    alpha *= 0.96;

    for (const { el, edge } of edgeEls) {
      el.setAttribute("x1", edge.source.x.toFixed(1));
      el.setAttribute("y1", edge.source.y.toFixed(1));
      el.setAttribute("x2", edge.target.x.toFixed(1));
      el.setAttribute("y2", edge.target.y.toFixed(1));
    }
    for (const { el, node } of nodeEls) {
      el.setAttribute("transform", `translate(${node.x.toFixed(1)}, ${node.y.toFixed(1)})`);
    }

    animFrameId = requestAnimationFrame(tick);
  };

  const startTicking = () => {
    if (animFrameId === null) {
      animFrameId = requestAnimationFrame(tick);
    }
  };

  startTicking();
}

/**
 * 扫描并渲染侧边栏 #标签 聚合面板
 */
export async function renderSidebarTagsCloud(
  container: HTMLElement | null,
  activeDocText: string,
  onTagSelect: (tag: string) => void
) {
  if (!container) return;

  let tags: TagCountItem[] = [];
  try {
    tags = await invoke<TagCountItem[]>("scan_workspace_tags");
  } catch {
    tags = [];
  }

  const localTagSet = new Set<string>();
  const matches = activeDocText.matchAll(
    /(?:^|[\s,，。；;（(])#([\u4e00-\u9fa5a-zA-Z0-9_\-]+(?:\/[\u4e00-\u9fa5a-zA-Z0-9_\-]+)*)/g
  );
  for (const m of matches) {
    const tag = m[1];
    if (!/^\d+$/.test(tag) && !/^[0-9a-fA-F]{3,8}$/.test(tag)) {
      localTagSet.add(tag);
    }
  }

  const mergedMap = new Map<string, TagCountItem>();
  tags.forEach((t) => mergedMap.set(t.tag, { ...t }));
  localTagSet.forEach((t) => {
    if (!mergedMap.has(t)) {
      mergedMap.set(t, { tag: t, count: 1, files: [] });
    }
  });

  const finalTags = Array.from(mergedMap.values()).sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag)
  );

  if (finalTags.length === 0) {
    container.innerHTML = "";
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");
  container.innerHTML = `
    <div class="sidebar-tags-header">
      <span>标签索引 (${finalTags.length})</span>
    </div>
    <div class="sidebar-tags-pills">
      ${finalTags
        .slice(0, 24)
        .map(
          (item) => `
        <button type="button" class="sidebar-tag-chip" data-tag="${escapeHtml(item.tag)}" title="点击检索标签 #${escapeHtml(item.tag)} (${item.count} 篇)">
          <span class="tag-hash">#</span>
          <span class="tag-name">${escapeHtml(item.tag)}</span>
          <span class="tag-count">${item.count}</span>
        </button>
      `
        )
        .join("")}
    </div>
  `;

  container.querySelectorAll<HTMLElement>(".sidebar-tag-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const t = chip.dataset.tag;
      if (t) onTagSelect(t);
    });
  });
}
