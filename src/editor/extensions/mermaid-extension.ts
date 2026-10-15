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

interface MermaidBlock {
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
  let startLine = 0;
  let codeLines: string[] = [];

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const trimmed = line.text.trim();

    if (!inBlock) {
      if (/^```+\s*mermaid/i.test(trimmed)) {
        inBlock = true;
        startLine = i;
        codeLines = [];
      }
    } else {
      if (/^```+$/.test(trimmed)) {
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

class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly fromPos: number,
    readonly isLivePreview: boolean = false
  ) {
    super();
  }

  // 动态预估 Mermaid 图表物理高度，杜绝 CodeMirror HeightMap 塌陷导致的鼠标向下偏移
  get estimatedHeight(): number {
    const lineCount = this.code.split("\n").length;
    return Math.max(200, lineCount * 28 + 60);
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  updateDOM(_dom: HTMLElement): boolean {
    return false;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("figure");
    container.className = this.isLivePreview ? "md-mermaid-card live-preview-card" : "md-mermaid-card";

    const header = document.createElement("div");
    header.className = "mermaid-header";
    if (this.isLivePreview) {
      header.innerHTML = `
        <span class="mermaid-badge" style="background: #0969da; color: #ffffff;">📊 实时流程图预览</span>
        <span style="font-size: 11px; opacity: 0.7;">编辑上方源码即时更新</span>
      `;
    } else {
      header.innerHTML = `
        <span class="mermaid-badge">MERMAID 流程图</span>
        <button type="button" class="mermaid-edit-btn" title="点击编辑源码">✏️ 编辑</button>
      `;
    }

    const chartBox = document.createElement("div");
    chartBox.className = "mermaid-chart-box";
    chartBox.innerHTML = `<div class="mermaid-loading">图表渲染中...</div>`;

    const id = "mmd-" + Math.random().toString(36).substring(2, 9);
    try {
      mermaid
        .render(id, this.code.trim())
        .then(({ svg }) => {
          chartBox.innerHTML = svg;
          view.requestMeasure();
        })
        .catch((err) => {
          chartBox.innerHTML = `
            <div class="mermaid-error">
              <div class="err-title">⚠️ 流程图语法解析失败</div>
              <pre class="err-detail">${err.message || String(err)}</pre>
            </div>
          `;
          view.requestMeasure();
        });
    } catch (e: any) {
      chartBox.innerHTML = `
        <div class="mermaid-error">
          <div class="err-title">⚠️ 语法错误</div>
          <pre class="err-detail">${e.message || String(e)}</pre>
        </div>
      `;
      view.requestMeasure();
    }

    if (!this.isLivePreview) {
      // 显式点击【✏️ 编辑】按钮或双击图表卡片展开源码
      const editBtn = header.querySelector(".mermaid-edit-btn") as HTMLElement;
      const enterEditMode = (e: Event) => {
        e.stopPropagation();
        view.dispatch({
          selection: { anchor: Math.min(this.fromPos + 10, view.state.doc.length) },
        });
        view.focus();
      };

      editBtn?.addEventListener("click", enterEditMode);
      container.addEventListener("dblclick", enterEditMode);
    }

    // 单击流程图：在打字机模式下平滑缓动居中供查阅，杜绝误触乱跳
    container.addEventListener("click", (e) => {
      e.stopPropagation();
      centerElementInTypewriter(view, container);
    });

    container.appendChild(header);
    container.appendChild(chartBox);
    return container;
  }

  eq(other: MermaidWidget): boolean {
    return (
      other.code === this.code &&
      other.fromPos === this.fromPos &&
      other.isLivePreview === this.isLivePreview
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

  const builder = new RangeSetBuilder<Decoration>();

  for (const b of blocks) {
    // 光标位于流程图块内时，展开上方源码供编辑，并在下方保留实时渲染预览卡片
    if (cursorLine >= b.startLine && cursorLine <= b.endLine) {
      builder.add(
        b.to,
        b.to,
        Decoration.widget({
          widget: new MermaidWidget(b.code, b.from, true),
          side: 1,
          block: true,
        })
      );
      continue;
    }

    // 光标离开时，折叠为原生 Mermaid 流程图卡片
    builder.add(
      b.from,
      b.to,
      Decoration.replace({
        widget: new MermaidWidget(b.code, b.from, false),
        block: true,
      })
    );
  }

  return builder.finish();
}

/**
 * 流程图实时预览 StateField
 */
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
