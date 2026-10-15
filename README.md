# Quilla (羽墨) 🖋️

> **轻巧灵动，落墨成章** —— 基于 Rust + Tauri v2 + CodeMirror 6 打造的高性能现代化所见即所得（WYSIWYG）Markdown 编辑器。

---

## 📖 项目简介 (Introduction)

**Quilla（羽墨）** 是一款追求极致书写沉浸感与极速冷启动的现代 Markdown 桌面编辑器。

传统 Markdown 编辑器往往在双栏预览与源码模式间反复切换，割裂了阅读与写作的流畅性；而基于重型框架构建的应用通常伴随显著的内存消耗与缓慢的启动速度。

**Quilla** 选用 **Rust** 作为底层系统核心，依托 **Tauri v2** 轻量级系统 WebView 架构，并在前端深度定制了 **CodeMirror 6** 的分层装饰体系，实现了优雅丝滑的 **Token 级微观行内局部展开** 与 **原生无缝富文本渲染**，让思绪与排版一气呵成。

---

## ✨ 核心特性 (Key Features)

### 1. ⚡ 极速启动与轻盈内存 (Fast & Lightweight)
- **Rust 系统级核心**：基于 Ropey 高效数据结构实现大文档低延迟缓冲与原子级安全写入（SafeIO），杜绝写入中断导致的数据丢失。
- **极致资源占用**：摆脱重型运行时捆绑，便携包体积轻巧，毫秒级冷启动，打字响应零延迟。

### 2. ✍️ 纯粹所见即所得 (Pure WYSIWYG & Micro-Expansion)
- **Token 级微观局部展开**：光标仅在移入当前词段标记（如 `**加粗**`、`*斜体*`、`~~删除线~~`、`\`行内代码\``、`$E=mc^2$`）时才精准展示语法定界符，同行其他元素始终保持优雅渲染，阅读与书写浑然一体。
- **智能标点自动成对**：按需自动补全括号、引号与 Markdown 强调符号，支持选中文字直接加套格式及反选剥离。

### 3. 📊 交互式表格编辑 (Interactive Table Editor)
- **所见即所写**：文档中的表格始终呈现为规范排版表格，点击任意单元格即可直接打字。
- **键盘流导航**：支持 `Tab` 顺序跳格、首尾回车智能续行。
- **聚焦操作栏**：点击单元格时自动浮出对齐（左/中/右）与增删行列工具条，非编辑状态下保持版面纯净。

### 4. 📐 数学公式与图表边写边预览 (Live Math & Mermaid)
- **KaTeX 矢量公式**：支持行内公式 `$ ... $` 与独立公式块 `$$ ... $$`。
- **Mermaid 流程图引擎**：支持 ```` ```mermaid ```` 矢量流程图、序列图、状态图等。
- **双向实时预览**：在编辑公式或流程图代码时，上方展示源码输入区，下方同步实时渲染图表与矢量公式，移出后平滑折叠为成品卡片。

### 5. 🎯 沉浸式创作模式 (Focus & Typewriter Mode)
- **打字机模式 (F9)**：输入行始终平滑自动缓动居中在屏幕黄金视线范围。
- **专注模式 (F8)**：弱化当前段落以外的其他文本透明度，屏蔽一切视觉干扰，沉浸于当下构思。
- **源码模式 (Ctrl+/)**：一键无损切换至纯正 Markdown 源码视图。

### 6. 🎨 5 套优雅内置主题 (Built-in Themes)
- **经典浅色 (GitHub)**：经典雅致的白底黑灰排版，阅读舒适自然。
- **夜间深色 (Night)**：专为暗光环境调校的高对比深灰底色与高亮加粗，不刺眼、无眩光。
- **报刊衬线 (Newsprint)**：温润米黄纸张质感与精致宋体/衬线排版，带来实体书报般的温和质感。
- **清新商务 (Clear)**：干练明快的现代科技天蓝配色。
- **极简灰阶 (Whitey)**：去除杂色的极简灰阶美学。
- **用户自定支持**：支持加载外部 `base.user.css` 实现完全个性化定制。

### 7. 📂 完备文件树、大纲与全局漫游 (Workspace & Outline)
- **工作区文件树**：支持打开本地文件夹、目录折叠展开、新建/重命名/删除与右键快捷操作。
- **大纲层级导航**：自动提取 H1~H6 标题层级，支持跨章节鼠标平滑拖拽重排（原子事务保证并支持 Ctrl+Z 撤销）。
- **快速文件漫游 (Ctrl+P)**：快速检索并即刻跳转至工作区内的任何文件。
- **全局全文检索**：毫秒级多线程匹配工作区内容。

### 8. 🛡️ 数据安全与快照自愈 (Safety & Auto-Recovery)
- **原子落盘 (Atomic Write)**：临时文件校验替换机制，断电或意外退出绝不损坏源文档。
- **崩溃快照保护**：实时在本地存储保留近期编辑快照，若遭遇意外重启可一键弹出提示恢复未保存草稿。

---

## 🛠️ 技术架构 (Architecture)

```
Quilla (羽墨)
├── Frontend (TypeScript + Vite)
│   ├── CodeMirror 6 (核心编辑引擎)
│   │   ├── Live Preview 装饰器 (Token 级微观展开)
│   │   ├── Table Editor (可视化内联表格)
│   │   ├── Mermaid / Math Block (实时双向图表与 KaTeX 公式)
│   │   ├── Typewriter & Focus Mode (视口缓动与视觉聚焦)
│   │   └── Block Handle (段落拖拽手柄)
│   └── Components (文件树、大纲拖拽重排、快捷键指南、快速漫游)
└── Backend (Rust + Tauri v2)
    ├── SafeIO (原子写入与崩溃保护)
    ├── Rope Core (文档缓冲区)
    ├── Search Engine (多线程全文搜索)
    ├── Theme Watcher (外部样式热重载)
    └── OS Integration (系统外链调起、文件对话框、窗口无边框拖拽控制)
```

---

## 🚀 快速上手与本地编译 (Getting Started)

### 前置环境需求
- **Node.js**：v18+
- **pnpm**：推荐使用 `pnpm`（或 npm / yarn）
- **Rust**：最新稳定版（Rust 1.78+）与 Cargo

### 1. 克隆代码仓库
```bash
git clone https://github.com/your-username/quilla.git
cd quilla
```

### 2. 安装前端依赖
```bash
pnpm install
```

### 3. 开发模式运行
```bash
pnpm tauri dev
```

### 4. 编译生产版本
```bash
# 1. 编译前端产物
pnpm build

# 2. 编译 Rust Release 可执行程序
cargo build --release --manifest-path src-tauri/Cargo.toml
```
编译产物生成于 `src-tauri/target/release/quilla.exe`，为完全独立的单文件便携可执行程序。

---

## ⌨️ 常用快捷键 (Shortcuts)

| 快捷键 | 功能描述 |
| :--- | :--- |
| `Ctrl + N` | 新建文件 |
| `Ctrl + Shift + N` | 新建独立窗口 |
| `Ctrl + O` | 打开本地 Markdown 文件 |
| `Ctrl + S` | 保存当前文件 |
| `Ctrl + Shift + S` | 另存为... |
| `Ctrl + P` | 快速文件漫游 |
| `Ctrl + F` / `Ctrl + H` | 查找与替换 |
| `Ctrl + /` | 切换源码模式 / 所见即所得模式 |
| `F9` | 切换打字机居中模式 |
| `F8` | 切换专注阅读模式 |
| `F1` | 打开完整快捷键指南 |
| `Ctrl + B` | 加粗选中文本 |
| `Ctrl + I` | 斜体选中文本 |
| `Ctrl + K` | 插入超链接 |
| `Tab` / `Shift + Tab` | 表格跳格 / 列表层级增减缩进 |

---

## 📄 开源许可证 (License)

本项目采用 [MIT License](LICENSE) 开源协议。
