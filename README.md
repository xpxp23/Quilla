# Quilla (羽墨) v0.4 🖋️

> **轻巧灵动，落墨成章** —— 基于 Rust + Tauri v2 + CodeMirror 6 Lezer AST 打造的高性能现代化所见即所得（WYSIWYG）Markdown 编辑器与轻量级本地双链知识库。

---

## 📖 项目简介 (Introduction)

**Quilla（羽墨）** 是一款追求极致书写沉浸感、毫秒级冷启动与本地知识网络连接的现代 Markdown 桌面编辑器。

传统 Markdown 编辑器往往在双栏预览与源码模式间反复切换，割裂了阅读与写作的流畅性；而基于重型框架构建的应用通常伴随显著的内存消耗与缓慢的启动速度。

**Quilla v0.4** 选用 **Rust** 作为底层系统核心（基于 `ropey` $O(\log N)$ 增量文本绳与 `rayon` 多线程检索引擎），依托 **Tauri v2** 轻量级系统 WebView 架构，并在前端全面接入 **CodeMirror 6 原生 Lezer 增量语法树（`syntaxTree(state)`）** 与统一 **Pointer Events 拖拽引擎**，实现了优雅丝滑的 **Token 级微观行内局部展开**、**多标签与左右分屏对照写作**、**`/` 斜杠命令面板**、**GitHub Callout 原生卡片渲染** 与 **`[[Wiki Links]]` 双向链接知识库**。

---

## ✨ 核心特性 (Key Features)

### 1. ⚡ Lezer 增量语法树与极速 Rust 核心 (Lezer AST & Rust Core)
- **CodeMirror 6 Lezer AST 驱动**：全面接入 `syntaxTree(state)` 增量语法树与单趟结构缓存（`doc-structure.ts`），彻底解决复杂嵌套语法（代码块内伪标题、列表内代码块、含平衡括号 URL、转义字符）边界解析问题，长文档编辑性能提升一个数量级。
- **Rust Ropey 增量缓冲与 SafeIO**：支持前端增量 `TextDelta` 同步与双模式原子写入（后台草稿快照免硬件 `fsync` 阻塞、用户保存强制 `sync_all` 持久化）。

### 2. ✍️ 纯粹所见即所得与 GitHub Callout 渲染 (Pure WYSIWYG & Callouts)
- **Token 级微观局部展开**：光标仅在移入当前词段标记（如 `**加粗**`、`*斜体*`、`~~删除线~~`、`` `行内代码` ``、`$E=mc^2$`）时才精准展示语法定界符，同行其他元素始终保持优雅渲染。
- **GitHub 风格 Callout / Admonition 原生卡片**：原生解析并渲染 `> [!NOTE]`、`> [!TIP]`、`> [!IMPORTANT]`、`> [!WARNING]`、`> [!CAUTION]`，提供带彩色矢量图标头部的卡片化展示，光标移入首行即可原位编辑类型与自定义标题。
- **斜杠命令菜单 (`/` Slash Command)**：在空行或行内输入 `/` 即刻弹出轻量级命令面板，支持方向键、首字母/拼音首拼过滤，一键插入多级标题、交互表格、Mermaid 模板（流程图/时序图/甘特图）、数学公式块、Callout 提示框、目录 `[TOC]` 与当前日期时间。

### 3. 🖱️ Pointer Events 统一拖拽引擎 (Unified Pointer Drag Engine)
- **全场景 Pointer Events 重构**：彻底摒弃 Tauri WebView 下易失效的 HTML5 原生 Drag API，统一使用 `pointerdown` / `pointermove` / `pointerup` + `setPointerCapture` 驱动大纲章节拖拽、正文左侧 6 点抓手块级拖拽与表格行列拖拽。
- **多块框选批量拖拽与精准基线对齐**：正文 6 点抓手实时读取行高与 `paddingTop` 精准居中对齐各级标题首行文字，支持框选多段内容后整体拖拽换位，并配备带圆点锚点的插入指示线与半透明浮动残影预览。

### 4. 📊 交互式表格与多级列表微交互 (Table & List Micro-interactions)
- **完美支持 `Ctrl+Z` 撤销与视口锁定**：表格组件采用 `keepAlive` DOM 复用与 `isUndoingOrRedoing` 事务感知，删除行或结构变更后按 `Ctrl+Z` 即刻无损还原且视口绝不乱跳。
- **表格行列拖拽换位、列宽拖拽与 `Ctrl+K` 链接**：表头顶部与行首内置微抓手支持拖拽换位，表头右侧边缘支持拖拽实时调节列宽，表格底部与右侧边缘提供 `+` 快捷加行/加列按钮，单元格内按 `Ctrl+K` 可直接弹出链接插入框。
- **多级有序列表智能重排与批量缩进**：按 `Tab` / `Shift+Tab` 增减缩进时自动按缩进栈计算当前层级期望序号（子级自动归 `1.`，退回父级自动续接父级序号），并实时重排后续同级列表项；支持框选多行批量缩进。

### 5. 🗂️ 多标签页与左右分屏对比编辑 (Multi-Tabs & Split View)
- **多文档标签栏 (Tabs Bar)**：支持同时打开多篇文档快速切换，每篇文档独立保存专属 `EditorState`（含独立 Undo/Redo 历史栈与选区）与滚动位置（`scrollTop`），支持 Pointer 拖拽排序、鼠标中键关闭与 `Ctrl+Tab` 切换。
- **左右分屏对比编辑 (`Ctrl+\` Split View)**：一键开启左右双栏对照视图，右侧副编辑器可自由选择任意已打开标签页或同文档双视口对照写作，支持双向实时同步、同步滚动开关与拖拽调节分屏宽度比例。

### 6. 🔗 双向链接 `[[Wiki Links]]` 与反向链接面板 (Wiki Knowledge Base)
- **`[[文件名#标题|别名]]` 智能补全**：输入 `[[` 自动检索工作区全部 Markdown 文档，输入 `#` 自动提取目标文档标题锚点。
- **悬停预览卡片与一键新建**：鼠标悬停于双链胶囊即刻弹出异步内容摘要预览卡片；点击已存在文档直接跳转并定位章节，点击未创建文档自动在工作区生成对应笔记。
- **Rust `rayon` 多线程反向链接面板**：编辑器底部内置可折叠反向引用面板，实时扫描工作区中所有引用当前文档的笔记位置与上下文片段，点击即可跳转溯源。

---

## 🛠️ 技术架构 (Architecture)

```
Quilla (羽墨) v0.4
├── Frontend (TypeScript + Vite)
│   ├── CodeMirror 6 (核心编辑引擎)
│   │   ├── Doc Structure (Lezer syntaxTree 增量解析 + 单趟 AST 缓存)
│   │   ├── Live Preview (Token 级微观展开、Callout 卡片、有序列表序号校准、WikiLink 胶囊)
│   │   ├── Slash Command (/ 斜杠命令快捷面板)
│   │   ├── Wiki Link ([[双链补全]]、悬停预览卡片、底部反向链接面板)
│   │   ├── Table Editor (Keep-Alive 可视化表格、Pointer 行列拖拽与列宽调节、Ctrl+K 链接)
│   │   ├── Block Handle (Pointer Events 块级/多选拖拽手柄与圆点锚点指示线)
│   │   ├── Mermaid / Math Block (基于 AST 缓存的 O(1) 实时双向图表与 KaTeX 公式)
│   │   └── Typewriter & Focus Mode (视口缓动与 AST 语义块视觉聚焦)
│   └── Components (多文档标签栏 Tabs & 左右分屏 Split View、大纲 Pointer 拖拽、文件树、全文搜索)
└── Backend (Rust + Tauri v2)
    ├── SafeIO (双模式原子写入与非阻塞草稿快照保护)
    ├── Rope Core (基于 ropey 的 O(log N) TextDelta 增量文档缓冲区)
    ├── Search Engine (基于 rayon 的多线程全文搜索与 [[Wiki Links]] 反向引用扫描)
    ├── Theme Watcher (外部样式与工作区文件变动监听)
    └── OS Integration (目录校验、文件标题提取、系统外链调起、无边框窗口控制)
```

---

## ⌨️ 常用快捷键 (Shortcuts)

| 快捷键 | 功能描述 |
| :--- | :--- |
| `/` | 唤起斜杠命令面板（一键插入表格/流程图/Callout/公式/时间） |
| `[[` | 唤起双向链接自动补全（支持 `[[文档名#标题\|别名]]`） |
| `Ctrl + \` | 开启 / 关闭左右分屏对比编辑视图 (Split View) |
| `Ctrl + N` | 新建文档标签页 |
| `Ctrl + Tab` / `Ctrl + W` | 切换下一个文档标签页 / 关闭当前标签页 |
| `Ctrl + Shift + N` | 新建独立窗口 |
| `Ctrl + O` / `Ctrl + S` | 打开本地 Markdown 文件 / 保存当前文件 |
| `Ctrl + P` | 快速文件漫游 |
| `Ctrl + F` / `Ctrl + H` | 查找与替换（支持正则表达式与 `$1` 捕获组替换） |
| `Ctrl + /` | 切换源码模式 / 所见即所得模式 |
| `F9` / `F8` / `F1` | 打字机居中模式 / 专注阅读模式 / 完整快捷键指南 |
| `Ctrl + B` / `I` / `K` | 加粗 / 斜体 / 插入超链接（正文与表格单元格内均支持） |
| `Tab` / `Shift + Tab` | 表格跳格 / 多级列表智能缩进与序号自动重排 / 多行批量缩进 |

---

## 📄 开源许可证 (License)

本项目采用 [MIT License](LICENSE) 开源协议。
