import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { isInsideCodeContextAST } from "./doc-structure";

export interface SlashCommandItem {
  id: string;
  title: string;
  subtitle: string;
  keywords: string[];
  icon: string;
  shortcut?: string;
  execute: (view: EditorView, slashFrom: number, slashTo: number) => void;
}

function insertBlockReplacement(
  view: EditorView,
  from: number,
  to: number,
  template: string,
  cursorOffsetFromStart: number
) {
  const line = view.state.doc.lineAt(from);
  const beforeSlash = view.state.sliceDoc(line.from, from);
  const needLeadingNewline = beforeSlash.trim().length > 0;
  const finalInsert = needLeadingNewline ? `\n${template}` : template;
  const cursorAnchor = from + (needLeadingNewline ? 1 : 0) + cursorOffsetFromStart;

  view.dispatch({
    changes: { from, to, insert: finalInsert },
    selection: { anchor: cursorAnchor },
    scrollIntoView: true,
  });
  view.focus();
}

const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: "h1",
    title: "一级标题 (Heading 1)",
    subtitle: "插入大章节主标题",
    keywords: ["h1", "heading1", "title", "biaoti", "yijibiaoti"],
    icon: "H1",
    shortcut: "# ",
    execute: (view, from, to) => {
      insertBlockReplacement(view, from, to, "# ", 2);
    },
  },
  {
    id: "h2",
    title: "二级标题 (Heading 2)",
    subtitle: "插入中章节次级标题",
    keywords: ["h2", "heading2", "subtitle", "erjibiaoti"],
    icon: "H2",
    shortcut: "## ",
    execute: (view, from, to) => {
      insertBlockReplacement(view, from, to, "## ", 3);
    },
  },
  {
    id: "h3",
    title: "三级标题 (Heading 3)",
    subtitle: "插入小节标题",
    keywords: ["h3", "heading3", "sanjibiaoti"],
    icon: "H3",
    shortcut: "### ",
    execute: (view, from, to) => {
      insertBlockReplacement(view, from, to, "### ", 4);
    },
  },
  {
    id: "task",
    title: "待办任务列表 (Task List)",
    subtitle: "带复选框的待办事项",
    keywords: ["todo", "task", "checkbox", "daiban", "renwu"],
    icon: "☑",
    shortcut: "- [ ]",
    execute: (view, from, to) => {
      insertBlockReplacement(view, from, to, "- [ ] ", 6);
    },
  },
  {
    id: "OrderedList",
    title: "有序列表 (Ordered List)",
    subtitle: "支持多级自动编号的列表",
    keywords: ["ol", "ordered", "number", "list", "youxuliebiao"],
    icon: "1.",
    shortcut: "1. ",
    execute: (view, from, to) => {
      insertBlockReplacement(view, from, to, "1. ", 3);
    },
  },
  {
    id: "BulletList",
    title: "无序列表 (Bullet List)",
    subtitle: "项目符号圆点列表",
    keywords: ["ul", "bullet", "list", "wuxuliebiao"],
    icon: "•",
    shortcut: "- ",
    execute: (view, from, to) => {
      insertBlockReplacement(view, from, to, "- ", 2);
    },
  },
  {
    id: "table",
    title: "可视化表格 (Table 3×3)",
    subtitle: "插入支持内联编辑与行列拖拽的表格",
    keywords: ["table", "grid", "biaoge", "tbl"],
    icon: "⊞",
    shortcut: "Ctrl+Alt+T",
    execute: (view, from, to) => {
      const tpl =
        "| 列标题 1 | 列标题 2 | 列标题 3 |\n| :--- | :--- | :--- |\n| 内容 1 | 内容 2 | 内容 3 |\n| 内容 4 | 内容 5 | 内容 6 |\n";
      insertBlockReplacement(view, from, to, tpl, 2);
    },
  },
  {
    id: "callout-note",
    title: "提示卡片：笔记 (Callout Note)",
    subtitle: "GitHub 风格蓝色信息高亮框 > [!NOTE]",
    keywords: ["callout", "note", "info", "admonition", "tishi", "biji"],
    icon: "ℹ",
    shortcut: "> [!NOTE]",
    execute: (view, from, to) => {
      const tpl = "> [!NOTE] 核心要点\n> 在此输入提示内容...";
      insertBlockReplacement(view, from, to, tpl, 17);
    },
  },
  {
    id: "callout-tip",
    title: "提示卡片：技巧 (Callout Tip)",
    subtitle: "GitHub 风格绿色技巧提示框 > [!TIP]",
    keywords: ["callout", "tip", "hint", "jiqiao"],
    icon: "💡",
    shortcut: "> [!TIP]",
    execute: (view, from, to) => {
      const tpl = "> [!TIP] 实用技巧\n> 在此输入技巧说明...";
      insertBlockReplacement(view, from, to, tpl, 16);
    },
  },
  {
    id: "callout-important",
    title: "提示卡片：重要 (Callout Important)",
    subtitle: "GitHub 风格紫色重要高亮框 > [!IMPORTANT]",
    keywords: ["callout", "important", "key", "zhongyao"],
    icon: "★",
    shortcut: "> [!IMPORTANT]",
    execute: (view, from, to) => {
      const tpl = "> [!IMPORTANT] 关键信息\n> 在此输入重要内容...";
      insertBlockReplacement(view, from, to, tpl, 22);
    },
  },
  {
    id: "callout-warning",
    title: "提示卡片：警告 (Callout Warning)",
    subtitle: "GitHub 风格橙色警告提示框 > [!WARNING]",
    keywords: ["callout", "warning", "warn", "jinggao", "zhuyi"],
    icon: "⚠",
    shortcut: "> [!WARNING]",
    execute: (view, from, to) => {
      const tpl = "> [!WARNING] 注意事项\n> 在此输入警告信息...";
      insertBlockReplacement(view, from, to, tpl, 20);
    },
  },
  {
    id: "callout-caution",
    title: "提示卡片：危险 (Callout Caution)",
    subtitle: "GitHub 风格红色高危警示框 > [!CAUTION]",
    keywords: ["callout", "caution", "danger", "alert", "weixian"],
    icon: "⛔",
    shortcut: "> [!CAUTION]",
    execute: (view, from, to) => {
      const tpl = "> [!CAUTION] 高危操作警示\n> 在此输入风险提示...";
      insertBlockReplacement(view, from, to, tpl, 22);
    },
  },
  {
    id: "codeblock",
    title: "多语言代码块 (Code Block)",
    subtitle: "带行号、语法高亮与语言切换的代码卡片",
    keywords: ["code", "fence", "daima", "pre"],
    icon: "</>",
    shortcut: "```",
    execute: (view, from, to) => {
      const tpl = "```rust\n\n```\n";
      insertBlockReplacement(view, from, to, tpl, 8);
    },
  },
  {
    id: "mathblock",
    title: "数学公式块 (LaTeX Math Block)",
    subtitle: "KaTeX 独立矢量数学公式卡片 $$",
    keywords: ["math", "latex", "formula", "katex", "gongshi", "shuxue"],
    icon: "∑",
    shortcut: "$$",
    execute: (view, from, to) => {
      const tpl = "$$\n\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}\n$$\n";
      insertBlockReplacement(view, from, to, tpl, 3);
    },
  },
  {
    id: "mermaid-flow",
    title: "Mermaid 流程图 (Flowchart)",
    subtitle: "插入矢量节点流程图模板",
    keywords: ["mermaid", "flowchart", "diagram", "liuchengtu", "chart"],
    icon: "flowchart",
    execute: (view, from, to) => {
      const tpl =
        '```mermaid\nflowchart LR\n    A["开始"] --> B{"条件判断"}\n    B -->|"是"| C["执行操作"]\n    B -->|"否"| D["结束"]\n```\n';
      insertBlockReplacement(view, from, to, tpl, 24);
    },
  },
  {
    id: "mermaid-seq",
    title: "Mermaid 时序图 (Sequence Diagram)",
    subtitle: "插入服务交互时序图模板",
    keywords: ["mermaid", "sequence", "shixutu", "uml"],
    icon: "⇄",
    execute: (view, from, to) => {
      const tpl =
        "```mermaid\nsequenceDiagram\n    participant Client as 客户端\n    participant Server as 服务端\n    Client->>Server: 发起请求\n    Server-->>Client: 返回响应\n```\n";
      insertBlockReplacement(view, from, to, tpl, 27);
    },
  },
  {
    id: "mermaid-gantt",
    title: "Mermaid 甘特图 (Gantt Chart)",
    subtitle: "插入项目进度排期甘特图模板",
    keywords: ["mermaid", "gantt", "schedule", "gantetu", "paiqi"],
    icon: "📅",
    execute: (view, from, to) => {
      const tpl =
        "```mermaid\ngantt\n    title 项目迭代排期\n    dateFormat YYYY-MM-DD\n    section 核心研发\n    架构设计 :a1, 2026-10-01, 5d\n    功能实现 :after a1, 7d\n```\n";
      insertBlockReplacement(view, from, to, tpl, 17);
    },
  },
  {
    id: "wikilink",
    title: "双向链接 (Wiki Link)",
    subtitle: "插入 [[文档名#标题]] 本地知识库双链",
    keywords: ["wiki", "link", "backlink", "shuanglian", "[["],
    icon: "[[",
    shortcut: "[[",
    execute: (view, from, to) => {
      view.dispatch({
        changes: { from, to, insert: "[[]]" },
        selection: { anchor: from + 2 },
      });
      view.focus();
    },
  },
  {
    id: "toc",
    title: "文档目录 ([TOC])",
    subtitle: "自动提取全文标题生成交互式目录卡片",
    keywords: ["toc", "contents", "outline", "mulu"],
    icon: "☰",
    shortcut: "[TOC]",
    execute: (view, from, to) => {
      insertBlockReplacement(view, from, to, "[TOC]\n", 6);
    },
  },
  {
    id: "hr",
    title: "水平分割线 (Divider)",
    subtitle: "插入章节视觉分隔线 ---",
    keywords: ["hr", "divider", "line", "fengexian"],
    icon: "—",
    shortcut: "---",
    execute: (view, from, to) => {
      insertBlockReplacement(view, from, to, "---\n", 4);
    },
  },
  {
    id: "datetime",
    title: "当前日期与时间 (Date & Time)",
    subtitle: "插入格式化的本地日期时间戳",
    keywords: ["date", "time", "now", "today", "riqi", "shijian"],
    icon: "🕒",
    execute: (view, from, to) => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const str = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
        now.getHours()
      )}:${pad(now.getMinutes())}`;
      view.dispatch({
        changes: { from, to, insert: str },
        selection: { anchor: from + str.length },
      });
      view.focus();
    },
  },
];

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

class SlashMenuOverlay {
  private dom: HTMLElement;
  private isOpen = false;
  private activeIndex = 0;
  private filteredItems: SlashCommandItem[] = [];
  private slashFrom = 0;
  private slashTo = 0;
  private currentView: EditorView | null = null;

  constructor() {
    this.dom = document.createElement("div");
    this.dom.className = "ty-slash-menu hidden";
    document.body.appendChild(this.dom);

    this.dom.addEventListener("mousedown", (e) => {
      const itemEl = (e.target as HTMLElement).closest(".slash-menu-item") as HTMLElement | null;
      if (!itemEl || !this.currentView) return;
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(itemEl.dataset.index);
      if (!Number.isNaN(idx) && this.filteredItems[idx]) {
        this.executeItem(this.filteredItems[idx]);
      }
    });
  }

  public checkUpdate(update: ViewUpdate) {
    if (!update.docChanged && !update.selectionSet) return;
    const view = update.view;
    const state = view.state;
    const sel = state.selection.main;
    if (!sel.empty) {
      this.close();
      return;
    }

    const head = sel.head;
    if (isInsideCodeContextAST(state, head)) {
      this.close();
      return;
    }

    const line = state.doc.lineAt(head);
    const beforeCursor = line.text.slice(0, head - line.from);

    // 匹配行首或空白字符后的 `/query`（排除 URL 如 https:// 或路径 a/b）
    const slashMatch = beforeCursor.match(/(?:^|\s)\/([a-zA-Z0-9_\-\u4e00-\u9fa5]{0,20})$/);
    if (!slashMatch) {
      this.close();
      return;
    }

    const query = (slashMatch[1] || "").toLowerCase();
    const slashOffsetInLine = beforeCursor.lastIndexOf("/");
    this.slashFrom = line.from + slashOffsetInLine;
    this.slashTo = head;
    this.currentView = view;

    this.filteredItems = SLASH_COMMANDS.filter((item) => {
      if (!query) return true;
      return (
        item.id.toLowerCase().includes(query) ||
        item.title.toLowerCase().includes(query) ||
        item.subtitle.toLowerCase().includes(query) ||
        item.keywords.some((k) => k.toLowerCase().includes(query))
      );
    });

    if (this.filteredItems.length === 0) {
      this.close();
      return;
    }

    this.activeIndex = 0;
    this.isOpen = true;
    this.render();
    this.positionNearCursor(view, this.slashFrom);
  }

  private render() {
    this.dom.classList.remove("hidden");
    this.dom.innerHTML = `
      <div class="slash-menu-header">
        <span>快捷插入块与模板</span>
        <span class="slash-menu-hint">↑↓ 选择 · Enter 确认 · Esc 关闭</span>
      </div>
      <div class="slash-menu-list">
        ${this.filteredItems
          .map(
            (item, idx) => `
          <div class="slash-menu-item${idx === this.activeIndex ? " active" : ""}" data-index="${idx}">
            <div class="slash-item-icon">${escapeHtml(
              item.icon === "flowchart" ? "❖" : item.icon
            )}</div>
            <div class="slash-item-body">
              <div class="slash-item-title">${escapeHtml(item.title)}</div>
              <div class="slash-item-desc">${escapeHtml(item.subtitle)}</div>
            </div>
            ${
              item.shortcut
                ? `<kbd class="slash-item-kbd">${escapeHtml(item.shortcut)}</kbd>`
                : ""
            }
          </div>
        `
          )
          .join("")}
      </div>
    `;

    const activeEl = this.dom.querySelector(".slash-menu-item.active") as HTMLElement | null;
    activeEl?.scrollIntoView({ block: "nearest" });
  }

  private positionNearCursor(view: EditorView, pos: number) {
    requestAnimationFrame(() => {
      if (!this.isOpen) return;
      const coords = view.coordsAtPos(pos);
      if (!coords) return;

      const menuWidth = 288;
      const menuHeight = Math.min(320, this.dom.offsetHeight || 280);
      let left = coords.left;
      let top = coords.bottom + 6;

      if (left + menuWidth > window.innerWidth - 12) {
        left = window.innerWidth - menuWidth - 12;
      }
      if (top + menuHeight > window.innerHeight - 16) {
        top = Math.max(12, coords.top - menuHeight - 8);
      }

      this.dom.style.left = `${Math.max(12, left)}px`;
      this.dom.style.top = `${top}px`;
    });
  }

  public handleKeyDown(e: KeyboardEvent, view: EditorView): boolean {
    if (!this.isOpen || this.filteredItems.length === 0) return false;
    this.currentView = view;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      this.activeIndex = (this.activeIndex + 1) % this.filteredItems.length;
      this.render();
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      this.activeIndex =
        (this.activeIndex - 1 + this.filteredItems.length) % this.filteredItems.length;
      this.render();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      const chosen = this.filteredItems[this.activeIndex];
      if (chosen) {
        this.executeItem(chosen);
        return true;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return true;
    }
    return false;
  }

  private executeItem(item: SlashCommandItem) {
    const view = this.currentView;
    const from = this.slashFrom;
    const to = this.slashTo;
    this.close();
    if (view) {
      item.execute(view, from, to);
    }
  }

  public close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.dom.classList.add("hidden");
  }

  public destroy() {
    this.dom.remove();
  }
}

export function slashCommandExtension(): Extension {
  let overlay: SlashMenuOverlay | null = null;

  const plugin = ViewPlugin.fromClass(
    class {
      constructor() {
        if (!overlay) {
          overlay = new SlashMenuOverlay();
        }
      }
      update(update: ViewUpdate) {
        overlay?.checkUpdate(update);
      }
      destroy() {
        overlay?.close();
      }
    },
    {
      eventHandlers: {
        keydown(e, view) {
          return overlay ? overlay.handleKeyDown(e, view) : false;
        },
        blur() {
          setTimeout(() => overlay?.close(), 150);
          return false;
        },
      },
    }
  );

  return plugin;
}
