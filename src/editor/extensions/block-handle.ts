import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

/**
 * Typora 经典段落/块级左侧拖拽手柄 (⋮⋮ Block Handle)
 * 鼠标悬浮在任意段落/块左侧显示拖拽点，单击全选该段落，拖动可上下重排段落位置。
 */
export const blockHandlePlugin = ViewPlugin.fromClass(
  class {
    private handle: HTMLElement;
    private dropIndicator: HTMLElement;
    private activeLineEl: HTMLElement | null = null;
    private sourceLineNum: number = -1;
    private targetLineNum: number = -1;

    constructor(private view: EditorView) {
      // 1. 创建悬浮手柄
      this.handle = document.createElement("div");
      this.handle.className = "cm-block-handle";
      this.handle.setAttribute("draggable", "true");
      this.handle.title = "点击全选段落，拖动重排段落";
      this.handle.innerHTML = `
        <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
          <circle cx="3" cy="2" r="1.5" />
          <circle cx="9" cy="2" r="1.5" />
          <circle cx="3" cy="7" r="1.5" />
          <circle cx="9" cy="7" r="1.5" />
          <circle cx="3" cy="12" r="1.5" />
          <circle cx="9" cy="12" r="1.5" />
        </svg>
      `;

      // 2. 创建拖拽目标指示线
      this.dropIndicator = document.createElement("div");
      this.dropIndicator.className = "cm-block-drop-indicator";
      this.dropIndicator.style.display = "none";

      const scroller = view.scrollDOM;
      scroller.appendChild(this.handle);
      scroller.appendChild(this.dropIndicator);

      this.setupListeners();
    }

    private setupListeners() {
      const scroller = this.view.scrollDOM;

      // 监听鼠标移动，准确定位段落手柄
      scroller.addEventListener("mousemove", (e: MouseEvent) => {
        if (typeof document !== "undefined" && document.body.classList.contains("source-mode")) {
          this.hideHandle();
          return;
        }

        const target = e.target as HTMLElement;
        if (target === this.handle || this.handle.contains(target)) return;

        const lineEl = target.closest(
          ".cm-line, .cm-math-block, .cm-mermaid-container, .cm-table-widget, .cm-toc-card"
        ) as HTMLElement | null;

        if (!lineEl || !lineEl.offsetParent) {
          // 如果离开编辑内容区一定距离则淡出手柄
          const contentRect = this.view.contentDOM.getBoundingClientRect();
          if (e.clientX < contentRect.left - 40 || e.clientX > contentRect.right + 20) {
            this.hideHandle();
          }
          return;
        }

        this.activeLineEl = lineEl;
        this.updateHandlePosition(lineEl);
      });

      scroller.addEventListener("mouseleave", () => {
        this.hideHandle();
      });

      // 单击手柄：全选当前段落
      this.handle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!this.activeLineEl) return;
        try {
          const pos = this.view.posAtDOM(this.activeLineEl);
          const line = this.view.state.doc.lineAt(pos);
          this.view.dispatch({
            selection: { anchor: line.from, head: line.to },
          });
          this.view.focus();
        } catch {
          // ignore
        }
      });

      // 拖拽手柄开始
      this.handle.addEventListener("dragstart", (e) => {
        if (!this.activeLineEl) return;
        try {
          const pos = this.view.posAtDOM(this.activeLineEl);
          this.sourceLineNum = this.view.state.doc.lineAt(pos).number;
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", `cm-block-line:${this.sourceLineNum}`);
          }
          this.handle.classList.add("dragging");
        } catch {
          // ignore
        }
      });

      this.handle.addEventListener("dragend", () => {
        this.handle.classList.remove("dragging");
        this.dropIndicator.style.display = "none";
        this.sourceLineNum = -1;
        this.targetLineNum = -1;
      });

      // 编辑区监听拖拽经过
      scroller.addEventListener("dragover", (e: DragEvent) => {
        if (this.sourceLineNum === -1) return;
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = "move";
        }

        const clientY = e.clientY;
        const pos = this.view.posAtCoords({ x: e.clientX, y: clientY });
        if (pos === null) return;

        const line = this.view.state.doc.lineAt(pos);
        this.targetLineNum = line.number;

        // 计算目标指示线位置
        const coords = this.view.coordsAtPos(line.from);
        if (coords) {
          const scrollerRect = scroller.getBoundingClientRect();
          const top = coords.top - scrollerRect.top + scroller.scrollTop;
          this.dropIndicator.style.display = "block";
          this.dropIndicator.style.top = `${top}px`;
          this.dropIndicator.style.left = `${this.view.contentDOM.offsetLeft}px`;
          this.dropIndicator.style.width = `${this.view.contentDOM.clientWidth}px`;
        }
      });

      // 放置并重排段落文本
      scroller.addEventListener("drop", (e: DragEvent) => {
        if (this.sourceLineNum === -1 || this.targetLineNum === -1) return;
        e.preventDefault();
        e.stopPropagation();

        const srcNum = this.sourceLineNum;
        const tgtNum = this.targetLineNum;
        this.dropIndicator.style.display = "none";

        if (srcNum === tgtNum) return;

        const doc = this.view.state.doc;
        const srcLine = doc.line(srcNum);
        const tgtLine = doc.line(tgtNum);
        const srcText = srcLine.text;

        let delFrom = srcLine.from;
        let delTo = srcNum === doc.lines ? srcLine.to : srcLine.to + 1;
        let insertPos = 0;
        let insertText = "";

        if (srcNum < tgtNum) {
          // 向下移动：插入在目标行末尾
          insertPos = tgtLine.to;
          insertText = "\n" + srcText;
        } else {
          // 向上移动：插入在目标行开头
          if (srcNum === doc.lines && delFrom > 0) {
            delFrom -= 1;
          }
          insertPos = tgtLine.from;
          insertText = srcText + "\n";
        }

        const changes = [
          { from: delFrom, to: delTo, insert: "" },
          { from: insertPos, insert: insertText },
        ].sort((a, b) => a.from - b.from);

        this.view.dispatch({ changes });

        this.view.focus();
      });
    }

    private updateHandlePosition(lineEl: HTMLElement) {
      const scroller = this.view.scrollDOM;
      const lineRect = lineEl.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();

      const top = lineRect.top - scrollerRect.top + scroller.scrollTop;
      const contentLeft = this.view.contentDOM.offsetLeft;
      const left = Math.max(8, contentLeft - 24);

      this.handle.style.top = `${top + 4}px`;
      this.handle.style.left = `${left}px`;
      this.handle.style.opacity = "0.75";
      this.handle.style.pointerEvents = "auto";
    }

    private hideHandle() {
      this.handle.style.opacity = "0";
      this.handle.style.pointerEvents = "none";
    }

    update(_update: ViewUpdate) {
      // 视口更新
    }

    destroy() {
      this.handle.remove();
      this.dropIndicator.remove();
    }
  }
);
