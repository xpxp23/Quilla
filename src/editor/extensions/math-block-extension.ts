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

export function findMathBlocks(state: EditorState): MathBlock[] {
  const doc = state.doc;
  const blocks: MathBlock[] = [];
  let inBlock = false;
  let startLine = 0;
  let latexLines: string[] = [];

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const trimmed = line.text.trim();

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
    readonly isLivePreview: boolean = false
  ) {
    super();
  }

  // 动态预估独立公式卡片物理高度，杜绝 HeightMap 塌陷导致的鼠标向下偏移
  get estimatedHeight(): number {
    const lineCount = this.latex.split("\n").length;
    return Math.max(80, lineCount * 30 + 40);
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }

  updateDOM(_dom: HTMLElement): boolean {
    return false;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("figure");
    container.className = this.isLivePreview ? "md-math-block-card live-preview-card" : "md-math-block-card";
    container.title = this.isLivePreview ? "实时渲染公式预览" : "点击进入多行公式编辑";

    const content = document.createElement("div");
    content.className = "math-card-rendered";

    try {
      katex.render(this.latex.trim(), content, {
        displayMode: true,
        throwOnError: false,
        output: "html",
      });
    } catch (err: any) {
      content.innerHTML = `<span class="math-error">⚠️ 公式语法解析错误: ${err.message || String(err)}</span>`;
    }

    const header = document.createElement("div");
    header.className = "mermaid-header math-header";
    if (this.isLivePreview) {
      header.innerHTML = `
        <span class="mermaid-badge math-badge" style="background: #0969da; color: #ffffff;">∑ 实时公式预览</span>
        <span style="font-size: 11px; opacity: 0.7;">编辑上方 LaTeX 源码即时生效</span>
      `;
    } else {
      header.innerHTML = `
        <span class="mermaid-badge math-badge">∑ 数学公式</span>
        <button type="button" class="mermaid-edit-btn math-edit-btn" title="点击编辑 LaTeX 源码">✏️ 编辑</button>
      `;
    }

    if (!this.isLivePreview) {
      const editBtn = header.querySelector(".math-edit-btn") as HTMLElement;
      const enterEditMode = (e: Event) => {
        e.stopPropagation();
        view.dispatch({
          selection: { anchor: Math.min(this.fromPos + 3, view.state.doc.length) },
        });
        view.focus();
      };

      editBtn?.addEventListener("click", enterEditMode);
      container.addEventListener("dblclick", enterEditMode);
    }

    // 单击公式卡片：在打字机模式下平滑缓动居中供查阅，杜绝误触乱跳
    container.addEventListener("click", (e) => {
      e.stopPropagation();
      centerElementInTypewriter(view, container);
    });

    container.appendChild(header);
    container.appendChild(content);
    return container;
  }

  eq(other: MathBlockWidget): boolean {
    return (
      other.latex === this.latex &&
      other.fromPos === this.fromPos &&
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
    // 光标位于多行公式块内时，展开为源码供编辑，并在下方保留实时矢量渲染卡片
    if (cursorLine >= b.startLine && cursorLine <= b.endLine) {
      builder.add(
        b.to,
        b.to,
        Decoration.widget({
          widget: new MathBlockWidget(b.latex, b.from, true),
          side: 1,
          block: true,
        })
      );
      continue;
    }

    // 光标离开时，折叠为居中矢量 KaTeX 卡片
    builder.add(
      b.from,
      b.to,
      Decoration.replace({
        widget: new MathBlockWidget(b.latex, b.from, false),
        block: true,
      })
    );
  }

  return builder.finish();
}

/**
 * 多行独立数学公式块实时预览 StateField
 */
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
