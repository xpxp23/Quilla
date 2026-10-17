import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { isInsideCodeContextAST } from "./doc-structure";

export interface SlashCommandItem {
  id: string;
  title: string;
  subtitle: string;
  keywords: string[];
  iconSvg: string;
  shortcut?: string;
  execute: (view: EditorView, slashFrom: number, slashTo: number) => void;
}

const SLASH_ICONS = {
  h1: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="m17 12 3-2v8"/></svg>`,
  h2: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/></svg>`,
  h3: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"/><path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"/></svg>`,
  task: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>`,
  ol: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>`,
  ul: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  table: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`,
  note: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  tip: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>`,
  important: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  warning: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  caution: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  code: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  math: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 4H6l6 8-6 8h12"/></svg>`,
  flow: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h6v9"/></svg>`,
  seq: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 4v16"/><path d="M17 4v16"/><path d="m7 9 10 0"/><path d="m17 15-10 0"/></svg>`,
  gantt: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  wiki: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  embed: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M14 9h4"/><path d="M14 15h4"/></svg>`,
  yaml: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/></svg>`,
  toc: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="7" y1="12" x2="21" y2="12"/><line x1="11" y1="18" x2="21" y2="18"/></svg>`,
  hr: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/></svg>`,
  clock: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
};

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
    iconSvg: SLASH_ICONS.h1,
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
    iconSvg: SLASH_ICONS.h2,
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
    iconSvg: SLASH_ICONS.h3,
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
    iconSvg: SLASH_ICONS.task,
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
    iconSvg: SLASH_ICONS.ol,
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
    iconSvg: SLASH_ICONS.ul,
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
    iconSvg: SLASH_ICONS.table,
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
    iconSvg: SLASH_ICONS.note,
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
    iconSvg: SLASH_ICONS.tip,
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
    iconSvg: SLASH_ICONS.important,
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
    iconSvg: SLASH_ICONS.warning,
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
    iconSvg: SLASH_ICONS.caution,
    shortcut: "> [!CAUTION]",
    execute: (view, from, to) => {
      const tpl = "> [!CAUTION] 高危操作警示\n> 在此输入风险提示...";
      insertBlockReplacement(view, from, to, tpl, 22);
    },
  },
  {
    id: "codeblock",
    title: "多语言代码块 (Code Block)",
    subtitle: "带行号、语法高亮、折叠与格式化的代码卡片",
    keywords: ["code", "fence", "daima", "pre"],
    iconSvg: SLASH_ICONS.code,
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
    iconSvg: SLASH_ICONS.math,
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
    iconSvg: SLASH_ICONS.flow,
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
    iconSvg: SLASH_ICONS.seq,
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
    iconSvg: SLASH_ICONS.gantt,
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
    iconSvg: SLASH_ICONS.wiki,
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
    id: "transclusion",
    title: "块级嵌入引用 (Block Embed)",
    subtitle: "插入 ![[文档名#标题]] 原位嵌入章节卡片",
    keywords: ["embed", "transclusion", "qianru", "yinyong", "![["],
    iconSvg: SLASH_ICONS.embed,
    shortcut: "![[",
    execute: (view, from, to) => {
      view.dispatch({
        changes: { from, to, insert: "![[]]" },
        selection: { anchor: from + 3 },
      });
      view.focus();
    },
  },
  {
    id: "frontmatter",
    title: "YAML 文档属性面板 (Front Matter)",
    subtitle: "在文档顶部插入可视化元数据属性卡片",
    keywords: ["yaml", "frontmatter", "properties", "meta", "shuxing"],
    iconSvg: SLASH_ICONS.yaml,
    shortcut: "---",
    execute: (view, from, to) => {
      const now = new Date().toISOString().slice(0, 10);
      const tpl = `---\ntitle: 未命名笔记\ndate: ${now}\ntags: [笔记, 知识库]\n---\n\n`;
      view.dispatch({
        changes: [
          { from, to, insert: "" },
          { from: 0, to: 0, insert: tpl },
        ],
        selection: { anchor: tpl.length },
      });
      view.focus();
    },
  },
  {
    id: "toc",
    title: "文档目录 ([TOC])",
    subtitle: "自动提取全文标题生成交互式目录卡片",
    keywords: ["toc", "contents", "outline", "mulu"],
    iconSvg: SLASH_ICONS.toc,
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
    iconSvg: SLASH_ICONS.hr,
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
    iconSvg: SLASH_ICONS.clock,
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
            <div class="slash-item-icon">${item.iconSvg}</div>
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

      const menuWidth = 296;
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
