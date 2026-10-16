import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import { EditorView, WidgetType, Decoration, DecorationSet } from "@codemirror/view";
import katex from "katex";
import { forceRefreshEffect } from "./refresh-effect";
import { centerElementInTypewriter } from "./typewriter-mode";

export interface MathBlock {
  startLine: number;
  endLine: number;
  from: number;
  to: number;
  latex: string;
}

/**
 * 扫描文档中的多行独立公式块 $$ ... $$ (自动跳过围栏代码块内部)
 */
export function findMathBlocks(state: EditorState): MathBlock[] {
  const doc = state.doc;
  const blocks: MathBlock[] = [];
  let inBlock = false;
  let inFence = false;
  let fenceChar = "";
  let startLine = 0;
  let latexLines: string[] = [];

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const trimmed = line.text.trim();

    if (/^(```+|~~~+)/.test(trimmed)) {
      const marker = trimmed.startsWith("`") ? "`" : "~";
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        inFence = false;
      }
      continue;
    }

    if (inFence) continue;

    if (!inBlock) {
      if (trimmed === "$$") {
        inBlock = true;
        startLine = i;
        latexLines = [];
      }
    } else {
      if (trimmed === "$$") {
        inBlock = false;
        const from = doc.line(startLine).from;
        const to = line.to;
        blocks.push({
          startLine,
          endLine: i,
          from,
          to,
          latex: latexLines.join("\n"),
        });
      } else {
        latexLines.push(line.text);
      }
    }
  }

  return blocks;
}

class MathBlockWidget extends WidgetType {
  constructor(
    readonly latex: string,
    readonly fromPos: number,
    readonly toPos: number,
    readonly isLivePreview: boolean = false
  ) {
    super();
  }

  get estimatedHeight(): number {
    const lineCount = this.latex.split("\n").length;
    return Math.max(64, lineCount * 26 + 28);
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  updateDOM(dom: HTMLElement): boolean {
    if (
      dom.dataset.isLive === String(this.isLivePreview) &&
      dom.dataset.latex === this.latex
    ) {
      dom.dataset.fromPos = String(this.fromPos);
      dom.dataset.toPos = String(this.toPos);
      return true;
    }
    return false;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("figure");
    container.className = this.isLivePreview
      ? "md-math-block-card live-preview-card cm-math-block"
      : "md-math-block-card clean-figure-card cm-math-block";
    container.dataset.fromPos = String(this.fromPos);
    container.dataset.toPos = String(this.toPos);
    container.dataset.isLive = String(this.isLivePreview);
    container.dataset.latex = this.latex;
    container.title = this.isLivePreview ? "实时渲染公式预览" : "点击编辑 LaTeX 公式";

    const content = document.createElement("div");
    content.className = "math-card-rendered";

    try {
      katex.render(this.latex.trim() || "\\text{(空公式块)}", content, {
        displayMode: true,
        throwOnError: false,
        output: "html",
      });
    } catch (err: any) {
      content.innerHTML = `<span class="math-error">公式语法解析错误: ${err.message || String(err)}</span>`;
    }

    if (this.isLivePreview) {
      const header = document.createElement("div");
      header.className = "mermaid-header math-header live-preview-header";
      header.innerHTML = `
        <span class="mermaid-badge math-badge">∑ LaTeX 实时预览</span>
        <button type="button" class="live-preview-fold-btn" title="完成编辑并收起源码">✓ 完成收起</button>
      `;
      header.querySelector(".live-preview-fold-btn")?.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const afterPos = Math.min(view.state.doc.length, this.toPos + 1);
        view.dispatch({ selection: { anchor: afterPos } });
        view.focus();
      });
      container.appendChild(header);
    } else {
      const floatingEditBtn = document.createElement("button");
      floatingEditBtn.type = "button";
      floatingEditBtn.className = "floating-corner-edit-btn";
      floatingEditBtn.title = "点击编辑 LaTeX 源码";
      floatingEditBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;

      const enterEditMode = (e: Event) => {
        e.stopPropagation();
        const firstLine = view.state.doc.lineAt(Math.min(this.fromPos, view.state.doc.length));
        const targetLine = view.state.doc.line(Math.min(firstLine.number + 1, view.state.doc.lines));
        view.dispatch({
          selection: { anchor: targetLine.to },
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

    container.appendChild(content);
    return container;
  }

  eq(other: MathBlockWidget): boolean {
    return (
      other.latex === this.latex &&
      other.fromPos === this.fromPos &&
      other.toPos === this.toPos &&
      other.isLivePreview === this.isLivePreview
    );
  }
}

function computeMathBlockDecorations(state: EditorState): DecorationSet {
  if (typeof document !== "undefined" && document.body.classList.contains("source-mode")) {
    return Decoration.none;
  }

  const blocks = findMathBlocks(state);
  if (blocks.length === 0) return Decoration.none;

  const selection = state.selection.main;
  const cursorHead = selection.head;
  const cursorLine = state.doc.lineAt(cursorHead).number;

  const builder = new RangeSetBuilder<Decoration>();

  for (const b of blocks) {
    if (cursorLine >= b.startLine && cursorLine <= b.endLine) {
      builder.add(
        b.to,
        b.to,
        Decoration.widget({
          widget: new MathBlockWidget(b.latex, b.from, b.to, true),
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
        widget: new MathBlockWidget(b.latex, b.from, b.to, false),
        block: true,
      })
    );
  }

  return builder.finish();
}

export const mathBlockLiveViewField = StateField.define<DecorationSet>({
  create(state) {
    return computeMathBlockDecorations(state);
  },
  update(decorations, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(forceRefreshEffect))
    ) {
      return computeMathBlockDecorations(tr.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});
