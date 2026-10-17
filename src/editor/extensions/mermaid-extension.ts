import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import { EditorView, WidgetType, Decoration, DecorationSet } from "@codemirror/view";
import mermaid from "mermaid";
import { forceRefreshEffect } from "./refresh-effect";
import { centerElementInTypewriter } from "./typewriter-mode";

// 初始化 Mermaid 图表配置
mermaid.initialize({
  startOnLoad: false,
  theme: "default",
  securityLevel: "loose",
  flowchart: {
    useMaxWidth: true,
    htmlLabels: true,
    curve: "basis",
  },
});

export interface MermaidBlock {
  startLine: number;
  endLine: number;
  from: number;
  to: number;
  code: string;
}

export function findMermaidBlocks(state: EditorState): MermaidBlock[] {
  const doc = state.doc;
  const blocks: MermaidBlock[] = [];
  let inBlock = false;
  let fenceChar = "";
  let startLine = 0;
  let codeLines: string[] = [];

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const trimmed = line.text.trim();

    if (!inBlock) {
      const m = trimmed.match(/^(```+|~~~+)\s*mermaid\s*$/i);
      if (m) {
        inBlock = true;
        fenceChar = m[1][0];
        startLine = i;
        codeLines = [];
      }
    } else {
      const isClose =
        (fenceChar === "`" && /^```+$/.test(trimmed)) ||
        (fenceChar === "~" && /^~~~+$/.test(trimmed));
      if (isClose) {
        inBlock = false;
        const from = doc.line(startLine).from;
        const to = line.to;
        blocks.push({
          startLine,
          endLine: i,
          from,
          to,
          code: codeLines.join("\n"),
        });
      } else {
        codeLines.push(line.text);
      }
    }
  }

  return blocks;
}

const svgRenderCache = new Map<string, string>();

function getCurrentMermaidThemeMode(): "dark" | "light" {
  const isDark =
    typeof document !== "undefined" && document.body.classList.contains("theme-night");
  return isDark ? "dark" : "light";
}

class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly fromPos: number,
    readonly toPos: number,
    readonly isLivePreview: boolean = false,
    readonly themeMode: "dark" | "light" = getCurrentMermaidThemeMode()
  ) {
    super();
  }

  get estimatedHeight(): number {
    const lineCount = this.code.split("\n").length;
    return Math.max(160, lineCount * 24 + 40);
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  updateDOM(dom: HTMLElement): boolean {
    if (
      dom.dataset.isLive === String(this.isLivePreview) &&
      dom.dataset.code === this.code &&
      dom.dataset.themeMode === this.themeMode
    ) {
      dom.dataset.fromPos = String(this.fromPos);
      dom.dataset.toPos = String(this.toPos);
      return true;
    }
    return false;
  }

  toDOM(view: EditorView): HTMLElement {
    const isDark = this.themeMode === "dark";

    const container = document.createElement("figure");
    container.className = this.isLivePreview
      ? "md-mermaid-card live-preview-card cm-mermaid-container"
      : "md-mermaid-card clean-figure-card cm-mermaid-container";
    container.dataset.fromPos = String(this.fromPos);
    container.dataset.toPos = String(this.toPos);
    container.dataset.isLive = String(this.isLivePreview);
    container.dataset.code = this.code;
    container.dataset.themeMode = this.themeMode;
    container.title = this.isLivePreview ? "实时渲染流程图预览" : "点击编辑 Mermaid 流程图源码";

    const chartBox = document.createElement("div");
    chartBox.className = "mermaid-chart-box";

    const cacheKey = `${this.themeMode}::${this.code.trim()}`;
    const cachedSvg = svgRenderCache.get(cacheKey);

    if (cachedSvg) {
      chartBox.innerHTML = cachedSvg;
    } else {
      chartBox.innerHTML = `<div class="mermaid-loading">图表渲染中...</div>`;
      const id = "mmd-" + Math.random().toString(36).substring(2, 9);
      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? "dark" : "default",
          securityLevel: "loose",
        });
        mermaid
          .render(id, this.code.trim())
          .then(({ svg }) => {
            svgRenderCache.set(cacheKey, svg);
            chartBox.innerHTML = svg;
            view.requestMeasure();
          })
          .catch((err) => {
            chartBox.innerHTML = `
              <div class="mermaid-error">
                <div class="err-title">流程图语法解析失败</div>
                <pre class="err-detail"></pre>
              </div>
            `;
            const detail = chartBox.querySelector(".err-detail");
            if (detail) detail.textContent = err.message || String(err);
            view.requestMeasure();
          });
      } catch (e: any) {
        chartBox.innerHTML = `
          <div class="mermaid-error">
            <div class="err-title">语法错误</div>
            <pre class="err-detail"></pre>
          </div>
        `;
        const detail = chartBox.querySelector(".err-detail");
        if (detail) detail.textContent = e.message || String(e);
        view.requestMeasure();
      }
    }

    if (this.isLivePreview) {
      const header = document.createElement("div");
      header.className = "mermaid-header live-preview-header";
      header.innerHTML = `
        <span class="mermaid-badge">MERMAID 实时预览</span>
        <button type="button" class="live-preview-fold-btn" title="完成编辑并收起源码">✓ 完成收起</button>
      `;
      header.querySelector(".live-preview-fold-btn")?.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const currentTo = Number(container.dataset.toPos ?? this.toPos);
        const afterPos = Math.min(view.state.doc.length, currentTo + 1);
        view.dispatch({ selection: { anchor: afterPos } });
        view.focus();
      });
      container.appendChild(header);
    } else {
      const floatingEditBtn = document.createElement("button");
      floatingEditBtn.type = "button";
      floatingEditBtn.className = "floating-corner-edit-btn";
      floatingEditBtn.title = "点击编辑 Mermaid 源码";
      floatingEditBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`;

      const enterEditMode = (e: Event) => {
        e.stopPropagation();
        const currentFrom = Number(container.dataset.fromPos ?? this.fromPos);
        const firstLineEnd = view.state.doc.lineAt(
          Math.min(currentFrom, view.state.doc.length)
        ).to;
        const targetAnchor = Math.min(firstLineEnd + 1, view.state.doc.length);
        view.dispatch({
          selection: { anchor: targetAnchor },
        });
        view.focus();
      };

      floatingEditBtn.addEventListener("click", enterEditMode);
      container.addEventListener("click", enterEditMode);
      container.appendChild(floatingEditBtn);
    }

    container.addEventListener("click", (e) => {
      e.stopPropagation();
      centerElementInTypewriter(view, container);
    });

    container.appendChild(chartBox);
    return container;
  }

  eq(other: MermaidWidget): boolean {
    return (
      other.code === this.code &&
      other.fromPos === this.fromPos &&
      other.toPos === this.toPos &&
      other.isLivePreview === this.isLivePreview &&
      other.themeMode === this.themeMode
    );
  }
}

function computeMermaidDecorations(state: EditorState): DecorationSet {
  if (typeof document !== "undefined" && document.body.classList.contains("source-mode")) {
    return Decoration.none;
  }

  const blocks = findMermaidBlocks(state);
  if (blocks.length === 0) return Decoration.none;

  const selection = state.selection.main;
  const cursorHead = selection.head;
  const cursorLine = state.doc.lineAt(cursorHead).number;
  const themeMode = getCurrentMermaidThemeMode();

  const builder = new RangeSetBuilder<Decoration>();

  for (const b of blocks) {
    if (cursorLine >= b.startLine && cursorLine <= b.endLine) {
      builder.add(
        b.to,
        b.to,
        Decoration.widget({
          widget: new MermaidWidget(b.code, b.from, b.to, true, themeMode),
          side: 1,
          block: true,
        })
      );
      continue;
    }

    builder.add(
      b.from,
      b.to,
      Decoration.replace({
        widget: new MermaidWidget(b.code, b.from, b.to, false, themeMode),
        block: true,
      })
    );
  }

  return builder.finish();
}

export const mermaidLiveViewField = StateField.define<DecorationSet>({
  create(state) {
    return computeMermaidDecorations(state);
  },
  update(decorations, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(forceRefreshEffect))
    ) {
      return computeMermaidDecorations(tr.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});
