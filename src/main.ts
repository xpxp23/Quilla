import { invoke } from "@tauri-apps/api/core";
import "katex/dist/katex.min.css";
import katex from "katex";
import {
  createEditor,
  toggleTypewriterMode,
  isTypewriterModeActive,
  toggleFocusMode,
  isFocusModeActive,
} from "./editor";
import { themeLoader, BUILTIN_THEMES } from "./themes/theme-loader";
import { initTitlebar, updateWindowTitle } from "./components/titlebar";
import {
  renderOutline,
  OutlineHeading,
  reorderDocumentHeading,
  syncActiveOutlineHeading,
} from "./components/outline";
import { renderFileTree, FileItem, syncActiveTreeItem } from "./components/file-tree";
import { initMenus } from "./components/menu";
import { initQuickOpen, addRecentFile } from "./components/quick-open";
import { initStatsPopover } from "./components/stats-popover";
import { initFloatingToolbars } from "./editor/extensions/floating-toolbars";
import { initSmartPaste } from "./editor/extensions/smart-paste";
import { setActiveDocumentPath, clearImageCache } from "./editor/extensions/live-preview";
import { forceRefreshEffect } from "./editor/extensions/refresh-effect";
import { initFindReplace, FindReplaceController } from "./components/find-replace";
import { undo, redo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { pulseSearchMatch } from "./editor/extensions/search-highlighter";
import { showSaveConfirmDialog } from "./components/save-dialog";
import { isTableDelimiter } from "./editor/extensions/table-editor";
import {
  saveRecoverySnapshot,
  clearRecoverySnapshot,
  checkAndPromptRecovery,
} from "./components/auto-recovery";

const INITIAL_DEMO_DOC = `# ✍️ 欢迎使用 Quilla (羽墨)

这是一个基于 **Rust + Tauri v2 + CodeMirror 6** 打造的极速、现代化的 Markdown 所见即所得编辑器。

## 🌟 核心特色与沉浸式体验

- **Token 级微观局部展开 (Micro-expansion)**：光标仅在进入特定单词标记（如 **加粗**、*优雅斜体*、***加粗斜体***、\`行内代码\`、公式 $E = mc^2$）内部时才展开源码，同行其他元素各自保持优雅渲染！
- **可视化表格内联编辑 (In-Place Table Editor)**：告别 ASCII 乱码！表格自始至终是标准表格，点击单元格直接打字，按 \`Tab\` 跳格，聚焦时浮出工具条一键增减行列与对齐！
- **Mermaid 流程图矢量渲染**：支持 \`\`\`mermaid 语法自动生成优雅流程图，编辑时上方显示代码，下方实时保留渲染图表！
- **多行 LaTeX 数学公式块**：内置矢量 KaTeX 引擎，编辑时实时双向渲染。
- **多语言代码块卡片**：支持主流语言语法高亮、右上角语言标签与【一键复制代码】。
- **全链路图片资产与拖放管道**：支持截图 \`Ctrl+V\` 自动在本地 \`assets/\` 落盘并插入，外部图片/文件直接拖入编辑器即可导入！

---

## 📐 体验 1：可视化交互表格 (点击即可直接输入)

点击任意单元格直接打字；按 \`Tab\` 键自动跳往下一格，在最后一格按 \`Tab\` 自动新增一行：

| 模块名称 | 核心语言 | 职责说明 | 性能指标 |
| :--- | :---: | :--- | ---: |
| Rope Core | Rust | 文档缓冲原子持久化 | < 1ms |
| Micro Live View | TypeScript | Token 级微观局部展开 | 60 FPS |
| Visual Table | CSS/DOM | 可视化表格内联双向同步 | 即时响应 |
| Mermaid Engine | Mermaid.js | 响应式矢量流程图渲染 | 即时响应 |

---

## 📊 体验 2：Mermaid 流程图渲染 (实时边写边预览)

\`\`\`mermaid
flowchart TD
    Start["🚀 启动 Quilla (羽墨)"] --> Parse["⚡ CodeMirror 6 极速排版"]
    Parse --> Mode{"视图模式?"}
    Mode -->|"实时预览"| Live["🎨 所见即所得渲染 (表格/公式/流程图)"]
    Mode -->|"源码模式"| Source["📝 极简纯文本编辑"]
    Live --> Edit["✏️ 点击流程图展开源码微观编辑"]
    Edit --> Live
\`\`\`

---

## 📐 体验 3：多语言代码块卡片 (右上角一键复制)

\`\`\`rust
fn main() {
    println!("Hello, Quilla (羽墨)!");
    let rope = ropey::Rope::from_str("极速 Markdown 所见即所得引擎");
    println!("文档字数: {}", rope.len_chars());
}
\`\`\`

---

## 📐 体验 4：数学公式与行内排版

- 质能方程：$E = mc^2$
- 行内斜体测试：*星号斜体 (Italic)* 与 _下划线斜体 (Underline Italic)_ 与 ***加粗斜体 (Bold Italic)***
- 高斯正态分布积分公式：
$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

---

## 📌 体验 5：优雅引用块与快捷操作

> 游戏核心定位:
> 一款以“商业视讯勘察、口供搜证填表、双轨逻辑质询、击破老板执念”为核心体验的黑色幽默直播打假/救市 Rogue-lite 策略游戏。

> 快捷操作指南:
> - 打字机模式：按 \`F9\` 或点击底部状态栏【🖮 打字机】，光标垂直软居中锁频，滚轮可自由翻阅
> - 专注模式：按 \`F8\` 或点击底部状态栏【🎯 专注】，当前段落聚焦高亮，其余文本平滑淡化
> - 5 套官方同款主题：点击左上角 ☰ 菜单，一键在 GitHub、Night、Newsprint、Clear、Whitey 之间自由切换
> - 列表智能状态机：按 \`Enter\` 智能续行编号与任务框，按 \`Tab\` / \`Shift+Tab\` 缩进与降级，空项按 \`Enter\` 或 \`Backspace\` 智能退出
> - 成对格式智能反解：按 \`Ctrl+B / Ctrl+I / Ctrl+E / Ctrl+K\` 选区包裹，光标处于词内时再次按下即刻智能解包
> - 快捷键速查指南：按 \`F1\` 随时呼出全量快捷键指南卡片
> - 标题快速切换：按 \`Ctrl+1~6\` 或 \`Ctrl+Alt+1~6\` 快速切换标题，按 \`Ctrl+0\` 恢复正文
> - 保存与另存为：按 \`Ctrl+S\` 保存当前文档，按 \`Ctrl+Shift+S\` 另存为新文件
> - 打开文件与新建窗口：按 \`Ctrl+O\` 打开文件，按 \`Ctrl+Shift+N\` 唤出独立新窗口
`;

class App {
  private currentFilePath: string | null = null;
  private currentWorkspaceRoot: string | null = null;
  private isModified: boolean = false;
  private savedContent: string = INITIAL_DEMO_DOC;
  private loadSequence: number = 0;
  private editorView: EditorView | null = null;
  private findReplaceCtrl: FindReplaceController | null = null;
  private currentHeadings: OutlineHeading[] = [];

  async init() {
    // 0. 初始化主题系统 (恢复上次选中的 5 套同款内置主题或外部 custom.css)
    themeLoader.init();

    // 1. 初始化原生窗口控制（右上角关闭按钮支持未保存脏状态拦截确认）
    initTitlebar({
      onClose: () => this.handleWindowClose(),
    });

    // 2. 初始化侧边栏拖拽调宽与 Tab 切换
    this.initSidebarResizer();
    this.initSidebarTabs();
    this.initSidebarActions();

    // 3. 挂载编辑器
    const writeContainer = document.getElementById("write")!;
    this.editorView = createEditor(writeContainer, INITIAL_DEMO_DOC, {
      onChange: (content) => this.handleContentChange(content),
      onStatsUpdate: (words, chars) => this.updateStats(words, chars),
      onOutlineUpdate: (headings) => this.updateOutline(headings),
      onCursorLineChange: (line) => {
        const outlineContainer = document.getElementById("outline-content");
        syncActiveOutlineHeading(outlineContainer, this.currentHeadings, line);
      },
      onOpenFile: (filePath) => this.loadFile(filePath),
      onOpenWorkspace: (dirPath) => this.loadWorkspace(dirPath),
    });

    // 3.1 挂载顶部吸顶查找与替换浮动控制器 (Ctrl+F / Ctrl+H)
    this.findReplaceCtrl = initFindReplace(this.editorView);

    // 3.2 挂载快速文件漫游、图片/链接微型浮层、富文本智能粘贴、字数阅读卡片
    const quickOpen = initQuickOpen({
      onOpenFile: (filePath) => this.loadFile(filePath),
      getWorkspaceFiles: async () => {
        if (!this.currentWorkspaceRoot) return [];
        try {
          const res = await invoke<any[]>("list_workspace_files", { root: this.currentWorkspaceRoot });
          const paths: string[] = [];
          const traverse = (items: any[]) => {
            for (const item of items) {
              if (!item.is_dir) paths.push(item.path);
              if (item.children) traverse(item.children);
            }
          };
          traverse(res);
          return paths;
        } catch {
          return [];
        }
      },
    });

    initStatsPopover(this.editorView);
    initFloatingToolbars(this.editorView, (filePath) => this.loadFile(filePath));
    initSmartPaste(this.editorView);

    // 4. 底部状态栏事件
    document.getElementById("footer-toggle-sidebar")?.addEventListener("click", () => {
      document.body.classList.toggle("pin-outline");
    });

    const toggleSourceBtn = document.getElementById("footer-toggle-source");
    const toggleSourceMode = () => {
      const isSource = document.body.classList.toggle("source-mode");
      if (toggleSourceBtn) {
        toggleSourceBtn.innerHTML = isSource ? "&lt;/&gt; 实时预览" : "&lt;/&gt; 源码模式";
      }
      if (this.editorView) {
        this.editorView.dispatch({
          effects: forceRefreshEffect.of(true),
        });
        this.editorView.focus();
      }
    };
    toggleSourceBtn?.addEventListener("click", toggleSourceMode);

    // 4.1 打字机模式与专注模式状态同步与控制
    const typewriterBtn = document.getElementById("footer-toggle-typewriter");
    const focusBtn = document.getElementById("footer-toggle-focus");

    const syncModeButtons = () => {
      if (this.editorView) {
        const isTW = isTypewriterModeActive(this.editorView);
        const isFC = isFocusModeActive(this.editorView);
        if (typewriterBtn) {
          typewriterBtn.classList.toggle("active-mode", isTW);
          typewriterBtn.title = isTW ? "打字机模式 (已开启, 按 F9 关闭)" : "打字机模式 (F9)";
        }
        if (focusBtn) {
          focusBtn.classList.toggle("active-mode", isFC);
          focusBtn.title = isFC ? "专注模式 (已开启, 按 F8 关闭)" : "专注模式 (F8)";
        }
      }
    };

    const toggleTW = () => {
      if (this.editorView) {
        toggleTypewriterMode(this.editorView);
        syncModeButtons();
        this.editorView.focus();
      }
    };

    const toggleFC = () => {
      if (this.editorView) {
        toggleFocusMode(this.editorView);
        syncModeButtons();
        this.editorView.focus();
      }
    };

    typewriterBtn?.addEventListener("click", toggleTW);
    focusBtn?.addEventListener("click", toggleFC);
    syncModeButtons();

    const themeBtn = document.getElementById("footer-theme-selector");
    themeBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showThemePicker(e);
    });

    // 快捷键监听
    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        toggleSourceMode();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        document.body.classList.toggle("pin-outline");
      } else if (e.key === "F9") {
        e.preventDefault();
        toggleTW();
      } else if (e.key === "F8") {
        e.preventDefault();
        toggleFC();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        this.newFile();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n" && e.shiftKey) {
        e.preventDefault();
        this.createNewWindow();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !e.shiftKey) {
        e.preventDefault();
        this.saveFile();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && e.shiftKey) {
        e.preventDefault();
        this.saveFileAs();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o" && !e.shiftKey) {
        e.preventDefault();
        this.promptOpenFile();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        window.print();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (this.editorView && this.editorView.hasFocus) {
          return;
        }
        const active = document.activeElement as HTMLElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
        if (this.editorView) {
          e.preventDefault();
          undo(this.editorView);
        }
      } else if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
      ) {
        if (this.editorView && this.editorView.hasFocus) {
          return;
        }
        const active = document.activeElement as HTMLElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
        if (this.editorView) {
          e.preventDefault();
          redo(this.editorView);
        }
      }
    });

    // 5. 初始化汉堡弹出菜单与右键上下文菜单
    initMenus(this.editorView, {
      onNewFile: () => this.newFile(),
      onNewWindow: () => this.createNewWindow(),
      onOpenFile: () => this.promptOpenFile(),
      onOpenFileByPath: (filePath) => this.loadFile(filePath),
      onOpenFolder: () => this.openWorkspaceFolder(),
      onSaveFile: () => this.saveFile(),
      onSaveFileAs: () => this.saveFileAs(),
      onToggleSidebar: () => document.body.classList.toggle("pin-outline"),
      onToggleSourceMode: toggleSourceMode,
      onToggleTypewriterMode: toggleTW,
      onToggleFocusMode: toggleFC,
      onSwitchTheme: (theme) => {
        themeLoader.setTheme(theme);
      },
      onExportHtml: () => this.exportHtml(),
      onPrint: () => window.print(),
      onQuickOpen: () => quickOpen.open(),
    });

    // 窗口关闭前脏检查守卫
    window.addEventListener("beforeunload", (e) => {
      if (this.isModified) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    // 6. 全文搜索事件
    const searchInput = document.getElementById("workspace-search-input") as HTMLInputElement;
    searchInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.performSearch(searchInput.value.trim());
      }
    });

    // 7. 检查是否有 CLI 外部传入打开文件或新建独立窗口
    const isNewWin = await invoke<boolean>("is_blank_new_window").catch(() => false);
    const cliFile = await invoke<string | null>("get_cli_open_file").catch(() => null);

    const urlParams = new URLSearchParams(window.location.search);
    const urlOpen = urlParams.get("open");
    const urlNew = urlParams.get("new");

    if (cliFile || urlOpen) {
      const target = cliFile || urlOpen!;
      await this.loadFile(target);
    } else if (isNewWin || urlNew === "1") {
      this.newFile();
    } else {
      // 正常恢复上次打开的工作区或展示优雅空状态
      const lastWorkspace = localStorage.getItem("typora_last_workspace");
      if (lastWorkspace) {
        this.loadWorkspace(lastWorkspace).catch(() => {
          this.closeWorkspace();
        });
      } else {
        this.closeWorkspace();
      }
      setActiveDocumentPath(null);
      updateWindowTitle("Untitled.md", false);
    }

    // 8. 检查是否有未保存的崩溃恢复快照
    checkAndPromptRecovery((snapshot) => {
      this.currentFilePath = snapshot.filePath;
      setActiveDocumentPath(snapshot.filePath);
      if (this.editorView) {
        this.editorView.dispatch({
          changes: { from: 0, to: this.editorView.state.doc.length, insert: snapshot.content },
        });
        this.editorView.focus();
      }
      this.handleContentChange(snapshot.content);
    });
  }

  private async createNewWindow(filePath?: string | null) {
    try {
      await invoke("create_new_window", { filePath: filePath || null });
    } catch (err) {
      console.error("新建窗口失败:", err);
      alert(`新建窗口失败: ${err}`);
    }
  }

  private initSidebarResizer() {
    const resizer = document.getElementById("sidebar-resizer");
    if (!resizer) return;

    // 恢复上次用户调整的宽度
    const savedWidth = localStorage.getItem("typora_sidebar_width");
    if (savedWidth) {
      document.documentElement.style.setProperty("--sidebar-width", savedWidth);
    }

    let isResizing = false;

    resizer.addEventListener("mousedown", () => {
      isResizing = true;
      resizer.classList.add("resizing");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    });

    window.addEventListener("mousemove", (e) => {
      if (!isResizing) return;
      const clampedWidth = Math.max(180, Math.min(e.clientX, 550));
      document.documentElement.style.setProperty("--sidebar-width", `${clampedWidth}px`);
    });

    window.addEventListener("mouseup", () => {
      if (!isResizing) return;
      isResizing = false;
      resizer.classList.remove("resizing");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const currentWidth = getComputedStyle(document.documentElement)
        .getPropertyValue("--sidebar-width")
        .trim();
      localStorage.setItem("typora_sidebar_width", currentWidth);
    });
  }

  private initSidebarTabs() {
    const tabs = ["files", "outline", "search"];
    tabs.forEach((tab) => {
      document.getElementById(`tab-${tab}`)?.addEventListener("click", () => {
        tabs.forEach((t) => {
          document.getElementById(`tab-${t}`)?.classList.remove("active");
          document.getElementById(`panel-${t}`)?.classList.remove("active");
        });
        document.getElementById(`tab-${tab}`)?.classList.add("active");
        document.getElementById(`panel-${tab}`)?.classList.add("active");
      });
    });
  }

  private initSidebarActions() {
    // 空状态卡片：打开文件夹
    document.getElementById("open-folder-empty-btn")?.addEventListener("click", () => {
      this.openWorkspaceFolder();
    });

    // 标题栏：点击更换工作区
    document.getElementById("workspace-folder-trigger")?.addEventListener("click", () => {
      this.openWorkspaceFolder();
    });

    // 工作区顶部按钮：新建文件、新建文件夹、刷新、关闭
    document.getElementById("sidebar-action-new-file")?.addEventListener("click", () => {
      this.createSidebarNewFile();
    });
    document.getElementById("sidebar-action-new-folder")?.addEventListener("click", () => {
      this.createSidebarNewFolder();
    });
    document.getElementById("sidebar-action-refresh")?.addEventListener("click", () => {
      this.refreshWorkspace();
    });
    document.getElementById("sidebar-action-close")?.addEventListener("click", () => {
      this.closeWorkspace();
    });

    // 侧边栏底部操作栏
    document.getElementById("sidebar-footer-new-file")?.addEventListener("click", () => {
      this.createSidebarNewFile();
    });
    document.getElementById("sidebar-footer-open-folder")?.addEventListener("click", () => {
      this.openWorkspaceFolder();
    });
  }

  private async handleWindowClose() {
    const choice = await this.confirmDiscardOrSave();
    if (choice === "cancel") return;
    try {
      await invoke("window_close");
    } catch (e) {
      console.error("关闭窗口失败:", e);
    }
  }

  private async confirmDiscardOrSave(): Promise<"save" | "discard" | "cancel"> {
    if (!this.isModified) {
      return "discard";
    }

    const fileName = this.currentFilePath
      ? this.currentFilePath.split(/[\\/]/).pop()!
      : "未命名.md";

    const choice = await showSaveConfirmDialog({ fileName });
    if (choice === "save") {
      const success = await this.saveFile();
      return success ? "save" : "cancel";
    }
    if (choice === "discard") {
      clearRecoverySnapshot();
    }
    return choice;
  }

  public async saveFile(): Promise<boolean> {
    if (!this.currentFilePath) {
      return this.saveFileAs();
    }
    const content = this.editorView ? this.editorView.state.doc.toString() : this.savedContent;
    const saveStatus = document.getElementById("footer-save-status");
    if (saveStatus) saveStatus.textContent = "保存中...";

    try {
      await invoke("save_file_content", {
        path: this.currentFilePath,
        content,
      });
      this.savedContent = content;
      this.isModified = false;
      addRecentFile(this.currentFilePath);
      clearRecoverySnapshot();
      const fileName = this.currentFilePath.split(/[\\/]/).pop() || "Untitled.md";
      updateWindowTitle(fileName, false);
      if (saveStatus) {
        saveStatus.textContent = "已保存";
        saveStatus.style.color = "var(--control-text-color)";
      }
      return true;
    } catch (err) {
      alert(`保存文件失败: ${err}`);
      if (saveStatus) saveStatus.textContent = "保存失败";
      return false;
    }
  }

  public async saveFileAs(): Promise<boolean> {
    const defaultName = this.currentFilePath
      ? this.currentFilePath.split(/[\\/]/).pop()!
      : "未命名.md";

    try {
      const selectedPath: string | null = await invoke("select_save_file_path", {
        defaultName,
      });
      if (!selectedPath || !selectedPath.trim()) {
        return false;
      }
      const targetPath = selectedPath.trim();
      const content = this.editorView ? this.editorView.state.doc.toString() : this.savedContent;
      await invoke("save_file_content", {
        path: targetPath,
        content,
      });

      this.currentFilePath = targetPath;
      this.savedContent = content;
      this.isModified = false;
      clearImageCache();
      setActiveDocumentPath(targetPath);
      addRecentFile(targetPath);
      clearRecoverySnapshot();

      const fileName = targetPath.split(/[\\/]/).pop() || "Untitled.md";
      updateWindowTitle(fileName, false);

      const saveStatus = document.getElementById("footer-save-status");
      if (saveStatus) {
        saveStatus.textContent = "已保存";
        saveStatus.style.color = "var(--control-text-color)";
      }

      if (this.editorView) {
        this.editorView.dispatch({
          effects: forceRefreshEffect.of(true),
        });
      }

      // 如果当前工作区包含了此文件，刷新文件树
      if (
        this.currentWorkspaceRoot &&
        targetPath.toLowerCase().startsWith(this.currentWorkspaceRoot.toLowerCase())
      ) {
        await this.loadWorkspace(this.currentWorkspaceRoot);
      }
      const treeContainer = document.getElementById("file-library-tree");
      syncActiveTreeItem(treeContainer, targetPath);

      return true;
    } catch (err) {
      alert(`另存为失败: ${err}`);
      return false;
    }
  }

  private async newFile() {
    const choice = await this.confirmDiscardOrSave();
    if (choice === "cancel") return;

    this.currentFilePath = null;
    clearImageCache();
    setActiveDocumentPath(null);
    const initialText = "# Untitled\n\n";
    this.savedContent = initialText;
    this.isModified = false;
    updateWindowTitle("未命名.md", false);
    const saveStatus = document.getElementById("footer-save-status");
    if (saveStatus) {
      saveStatus.textContent = "已保存";
      saveStatus.style.color = "var(--control-text-color)";
    }

    if (this.editorView) {
      this.editorView.dispatch({
        changes: { from: 0, to: this.editorView.state.doc.length, insert: initialText },
      });
      this.editorView.focus();
    }

    const treeContainer = document.getElementById("file-library-tree");
    syncActiveTreeItem(treeContainer, null);
  }

  private async createSidebarNewFile() {
    if (!this.currentWorkspaceRoot) {
      this.newFile();
      return;
    }
    const choice = await this.confirmDiscardOrSave();
    if (choice === "cancel") return;

    const rawName = prompt("请输入新建文件名 (例如: note.md):", "untitled.md");
    if (!rawName || !rawName.trim()) return;
    let fileName = rawName.trim();
    if (!fileName.includes(".")) {
      fileName += ".md";
    }
    const sep = this.currentWorkspaceRoot.includes("\\") ? "\\" : "/";
    const fullPath = `${this.currentWorkspaceRoot}${sep}${fileName}`;
    try {
      await invoke("create_file", { path: fullPath });
      await this.loadWorkspace(this.currentWorkspaceRoot);
      await this.loadFile(fullPath);
    } catch (err) {
      alert(`新建文件失败: ${err}`);
    }
  }

  private async createSidebarNewFolder() {
    if (!this.currentWorkspaceRoot) {
      alert("请先打开工作区文件夹");
      return;
    }
    const rawName = prompt("请输入新建文件夹名称:", "新文件夹");
    if (!rawName || !rawName.trim()) return;
    const folderName = rawName.trim();
    const sep = this.currentWorkspaceRoot.includes("\\") ? "\\" : "/";
    const fullPath = `${this.currentWorkspaceRoot}${sep}${folderName}`;
    try {
      await invoke("create_folder", { path: fullPath });
      await this.loadWorkspace(this.currentWorkspaceRoot);
    } catch (err) {
      alert(`创建文件夹失败: ${err}`);
    }
  }

  private refreshWorkspace() {
    if (this.currentWorkspaceRoot) {
      this.loadWorkspace(this.currentWorkspaceRoot);
    }
  }

  private closeWorkspace() {
    this.currentWorkspaceRoot = null;
    localStorage.removeItem("typora_last_workspace");

    const emptyState = document.getElementById("sidebar-empty-state");
    const wsContainer = document.getElementById("sidebar-workspace-container");
    if (emptyState) emptyState.style.display = "flex";
    if (wsContainer) wsContainer.style.display = "none";

    const treeContainer = document.getElementById("file-library-tree");
    if (treeContainer) treeContainer.innerHTML = "";
  }

  private async promptOpenFile() {
    const choice = await this.confirmDiscardOrSave();
    if (choice === "cancel") return;

    try {
      const selectedPath: string | null = await invoke("select_open_file_path");
      if (selectedPath && selectedPath.trim()) {
        await this.loadFile(selectedPath.trim());
      }
    } catch (err) {
      const p = prompt("请输入要打开的 Markdown 本地绝对路径:");
      if (p) this.loadFile(p);
    }
  }

  private renderMarkdownToHtmlBody(md: string): string {
    const lines = md.replace(/\r\n/g, "\n").split("\n");
    const out: string[] = [];
    let i = 0;

    // 跳过顶部 YAML Front Matter
    if (lines.length >= 3 && lines[0].trim() === "---") {
      for (let k = 1; k < Math.min(lines.length, 35); k++) {
        if (lines[k].trim() === "---" || lines[k].trim() === "...") {
          i = k + 1;
          break;
        }
      }
    }

    const renderInline = (raw: string): string => {
      let s = this.escapeHtml(raw);
      // 行内公式 $...$
      s = s.replace(/\$([^$\n]+)\$/g, (_m, tex) => {
        try {
          return katex.renderToString(tex, { displayMode: false, throwOnError: false, output: "html" });
        } catch {
          return `<code>${tex}</code>`;
        }
      });
      // 行内代码
      s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
      // 图片
      s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%;" />');
      // 链接
      s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      // 加粗斜体 / 加粗 / 斜体 / 删除线 / 高亮 / 上下标
      s = s.replace(/(\*{3}|_{3})([^*_\n]+?)\1/g, "<strong><em>$2</em></strong>");
      s = s.replace(/(\*{2}|_{2})([^*_\n]+?)\1/g, "<strong>$2</strong>");
      s = s.replace(/(?<!\*)\*([^*\s\n][^*\n]*?)\*(?!\*)|(?<!_)_([^_\s\n][^_\n]*?)_(?!_)/g, "<em>$1$2</em>");
      s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
      s = s.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
      s = s.replace(/(?<!~)~([^~\s\n][^~\n]*?)~(?!~)/g, "<sub>$1</sub>");
      s = s.replace(/\^([^\^\s\n][^\^\n]*?)\^/g, "<sup>$1</sup>");
      return s;
    };

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      // 1. 围栏代码块
      const fenceMatch = trimmed.match(/^(```+|~~~+)\s*([^\s`~]*).*$/);
      if (fenceMatch) {
        const fenceChar = fenceMatch[1][0];
        const lang = fenceMatch[2] || "";
        const codeLines: string[] = [];
        i++;
        while (i < lines.length) {
          const t = lines[i].trim();
          if ((fenceChar === "`" && /^```+$/.test(t)) || (fenceChar === "~" && /^~~~+$/.test(t))) {
            i++;
            break;
          }
          codeLines.push(lines[i]);
          i++;
        }
        out.push(
          `<pre><code class="language-${this.escapeHtml(lang)}">${this.escapeHtml(codeLines.join("\n"))}</code></pre>`
        );
        continue;
      }

      // 2. 多行公式块 $$
      if (trimmed === "$$") {
        const mathLines: string[] = [];
        i++;
        while (i < lines.length && lines[i].trim() !== "$$") {
          mathLines.push(lines[i]);
          i++;
        }
        i++; // 跳过结束 $$
        try {
          const rendered = katex.renderToString(mathLines.join("\n"), {
            displayMode: true,
            throwOnError: false,
            output: "html",
          });
          out.push(`<div class="md-math-block-preview">${rendered}</div>`);
        } catch {
          out.push(`<pre>${this.escapeHtml(mathLines.join("\n"))}</pre>`);
        }
        continue;
      }

      // 3. 单行公式块 $$ ... $$
      const singleMath = trimmed.match(/^\$\$\s*(.+?)\s*\$\$$/);
      if (singleMath) {
        try {
          const rendered = katex.renderToString(singleMath[1], {
            displayMode: true,
            throwOnError: false,
            output: "html",
          });
          out.push(`<div class="md-math-block-preview">${rendered}</div>`);
        } catch {
          out.push(`<pre>${this.escapeHtml(singleMath[1])}</pre>`);
        }
        i++;
        continue;
      }

      // 4. 表格块
      if (trimmed.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
        const parseCells = (rowStr: string) => {
          let t = rowStr.trim();
          if (t.startsWith("|")) t = t.slice(1);
          if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
          return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
        };
        const headers = parseCells(lines[i]);
        const delimParts = parseCells(lines[i + 1]);
        const aligns = headers.map((_h, idx) => {
          const d = delimParts[idx] || "";
          if (d.startsWith(":") && d.endsWith(":")) return "center";
          if (d.endsWith(":")) return "right";
          return "left";
        });
        i += 2;
        const bodyRows: string[][] = [];
        while (i < lines.length && lines[i].trim().includes("|")) {
          bodyRows.push(parseCells(lines[i]));
          i++;
        }
        const thHtml = headers
          .map((h, idx) => `<th style="text-align:${aligns[idx]}">${renderInline(h)}</th>`)
          .join("");
        const tbodyHtml = bodyRows
          .map(
            (r) =>
              `<tr>${headers
                .map((_h, idx) => `<td style="text-align:${aligns[idx]}">${renderInline(r[idx] || "")}</td>`)
                .join("")}</tr>`
          )
          .join("");
        out.push(`<table class="md-table"><thead><tr>${thHtml}</tr></thead><tbody>${tbodyHtml}</tbody></table>`);
        continue;
      }

      // 5. 水平分割线
      if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        out.push("<hr />");
        i++;
        continue;
      }

      // 6. 标题
      const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (hMatch) {
        const lvl = hMatch[1].length;
        out.push(`<h${lvl}>${renderInline(hMatch[2].trim())}</h${lvl}>`);
        i++;
        continue;
      }

      // 7. 引用块
      if (trimmed.startsWith(">")) {
        const qLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          qLines.push(renderInline(lines[i].replace(/^\s*>\s?/, "")));
          i++;
        }
        out.push(`<blockquote><p>${qLines.join("<br/>")}</p></blockquote>`);
        continue;
      }

      // 8. 无序/任务列表
      if (/^\s*[-*+]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          const taskM = lines[i].match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/);
          if (taskM) {
            const checked = taskM[1].toLowerCase() === "x" ? " checked disabled" : " disabled";
            items.push(`<li><input type="checkbox"${checked} /> ${renderInline(taskM[2])}</li>`);
          } else {
            const itemTxt = lines[i].replace(/^\s*[-*+]\s+/, "");
            items.push(`<li>${renderInline(itemTxt)}</li>`);
          }
          i++;
        }
        out.push(`<ul>${items.join("")}</ul>`);
        continue;
      }

      // 9. 有序列表
      if (/^\s*\d+\.\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          const itemTxt = lines[i].replace(/^\s*\d+\.\s+/, "");
          items.push(`<li>${renderInline(itemTxt)}</li>`);
          i++;
        }
        out.push(`<ol>${items.join("")}</ol>`);
        continue;
      }

      // 10. 普通段落
      out.push(`<p>${renderInline(line)}</p>`);
      i++;
    }

    return out.join("\n");
  }

  private async exportHtml() {
    if (!this.editorView) return;
    const docText = this.editorView.state.doc.toString();
    const title = this.currentFilePath
      ? this.currentFilePath.split(/[\\/]/).pop()!.replace(/\.(md|markdown|txt)$/i, "")
      : "document-export";
    const themeCss = themeLoader.getThemeMeta().css;
    const bodyHtml = this.renderMarkdownToHtmlBody(docText);

    const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${this.escapeHtml(title)}</title>
  <style>
    ${themeCss}
    body { max-width: 860px; margin: 40px auto; padding: 0 24px; line-height: 1.7; }
    table.md-table { border-collapse: collapse; width: 100%; margin: 1.2rem 0; }
    table.md-table th, table.md-table td { border: 1px solid #dfe2e5; padding: 8px 14px; }
    table.md-table th { background-color: #f6f8fa; font-weight: 600; }
    pre { padding: 14px 16px; border-radius: 6px; background: #f6f8fa; overflow-x: auto; }
    blockquote { border-left: 4px solid #dfe2e5; margin: 1rem 0; padding: 2px 16px; color: #6a737d; }
  </style>
</head>
<body id="write">
${bodyHtml}
</body>
</html>`;

    try {
      const savePath: string | null = await invoke("select_export_html_path", {
        defaultName: `${title}.html`,
      });
      if (savePath && savePath.trim()) {
        await invoke("save_file_content", {
          path: savePath.trim(),
          content: fullHtml,
        });
      }
      return;
    } catch {
      // 浏览器模式降级下载
      const blob = new Blob([fullHtml], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title}.html`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  private handleContentChange(content: string) {
    const isDirty = content !== this.savedContent;
    this.isModified = isDirty;
    const fileName = this.currentFilePath
      ? this.currentFilePath.split(/[\\/]/).pop()!
      : "未命名.md";
    updateWindowTitle(fileName, isDirty);

    const saveStatus = document.getElementById("footer-save-status");
    if (saveStatus) {
      saveStatus.textContent = isDirty ? "● 未保存" : "已保存";
      saveStatus.style.color = isDirty ? "#e36209" : "var(--control-text-color)";
    }

    this.findReplaceCtrl?.notifyDocChanged();

    if (isDirty) {
      saveRecoverySnapshot(this.currentFilePath, content, fileName);
    } else {
      clearRecoverySnapshot();
    }
  }

  private updateStats(words: number, chars: number) {
    const wEl = document.getElementById("footer-word-count");
    const cEl = document.getElementById("footer-char-count");
    if (wEl) wEl.textContent = `${words} 词`;
    if (cEl) cEl.textContent = `${chars} 字符`;
  }

  private updateOutline(headings: OutlineHeading[]) {
    this.currentHeadings = headings;
    const outlineContainer = document.getElementById("outline-content");
    if (!outlineContainer) return;

    renderOutline(
      outlineContainer,
      headings,
      (targetLine) => {
        if (this.editorView) {
          const linePos = this.editorView.state.doc.line(targetLine).from;
          this.editorView.dispatch({
            selection: { anchor: linePos },
            effects: [
              EditorView.scrollIntoView(linePos, { y: "start", yMargin: 40 }),
            ],
          });
          this.editorView.focus();
        }
      },
      (fromIdx, toIdx, insertAfter) => {
        if (this.editorView) {
          reorderDocumentHeading(this.editorView, this.currentHeadings, fromIdx, toIdx, insertAfter);
        }
      }
    );

    if (this.editorView) {
      const curLine = this.editorView.state.doc.lineAt(this.editorView.state.selection.main.head).number;
      syncActiveOutlineHeading(outlineContainer, headings, curLine);
    }
  }

  private async openWorkspaceFolder() {
    try {
      const folderPath: string = await invoke("select_workspace_folder");
      if (folderPath && folderPath.trim()) {
        await this.loadWorkspace(folderPath);
      }
    } catch (e) {
      console.error("选择工作区文件夹失败:", e);
    }
  }

  private async loadWorkspace(folderPath: string) {
    try {
      const files: FileItem[] = await invoke("list_workspace_files", { root: folderPath });
      this.currentWorkspaceRoot = folderPath;
      localStorage.setItem("typora_last_workspace", folderPath);

      const folderName = folderPath.split(/[\\/]/).pop() || folderPath;
      const nameEl = document.getElementById("workspace-folder-name");
      if (nameEl) nameEl.textContent = folderName;

      const emptyState = document.getElementById("sidebar-empty-state");
      const wsContainer = document.getElementById("sidebar-workspace-container");
      if (emptyState) emptyState.style.display = "none";
      if (wsContainer) wsContainer.style.display = "block";

      const treeContainer = document.getElementById("file-library-tree")!;
      renderFileTree(treeContainer, files, {
        workspaceRoot: folderPath,
        activeFilePath: this.currentFilePath,
        onFileSelect: (filePath) => this.loadFile(filePath),
        onRefresh: () => this.loadWorkspace(folderPath),
        onFileRenamed: (oldPath, newPath) => this.handleFileRenamed(oldPath, newPath),
        onFileDeleted: (deletedPath) => this.handleFileDeleted(deletedPath),
      });
    } catch (e) {
      console.error("加载工作区失败:", e);
      this.closeWorkspace();
    }
  }

  private handleFileRenamed(oldPath: string, newPath: string) {
    if (!this.currentFilePath) return;
    const normCur = this.currentFilePath.replace(/\\/g, "/").toLowerCase();
    const normOld = oldPath.replace(/\\/g, "/").toLowerCase();
    if (normCur === normOld) {
      this.currentFilePath = newPath;
      setActiveDocumentPath(newPath);
      localStorage.setItem("typora_last_file", newPath);
      const fileName = newPath.split(/[\\/]/).pop() || "Untitled.md";
      updateWindowTitle(fileName, this.isModified);
    } else if (normCur.startsWith(normOld + "/")) {
      const rest = this.currentFilePath.slice(oldPath.length);
      const updated = newPath + rest;
      this.currentFilePath = updated;
      setActiveDocumentPath(updated);
      localStorage.setItem("typora_last_file", updated);
      const fileName = updated.split(/[\\/]/).pop() || "Untitled.md";
      updateWindowTitle(fileName, this.isModified);
    }
    const treeContainer = document.getElementById("file-library-tree");
    syncActiveTreeItem(treeContainer, this.currentFilePath);
  }

  private handleFileDeleted(deletedPath: string) {
    if (!this.currentFilePath) return;
    const normCur = this.currentFilePath.replace(/\\/g, "/").toLowerCase();
    const normDel = deletedPath.replace(/\\/g, "/").toLowerCase();
    if (normCur === normDel || normCur.startsWith(normDel + "/")) {
      this.currentFilePath = null;
      setActiveDocumentPath(null);
      localStorage.removeItem("typora_last_file");
      updateWindowTitle("未命名.md", this.isModified);
      const treeContainer = document.getElementById("file-library-tree");
      syncActiveTreeItem(treeContainer, null);
    }
  }

  public async loadFile(filePath: string) {
    if (!filePath) return;
    const normTarget = filePath.replace(/\\/g, "/").toLowerCase();
    const normCurrent = (this.currentFilePath || "").replace(/\\/g, "/").toLowerCase();
    if (normTarget === normCurrent) {
      const treeContainer = document.getElementById("file-library-tree");
      syncActiveTreeItem(treeContainer, filePath);
      return;
    }

    const choice = await this.confirmDiscardOrSave();
    if (choice === "cancel") {
      const treeContainer = document.getElementById("file-library-tree");
      syncActiveTreeItem(treeContainer, this.currentFilePath);
      return;
    }

    const seq = ++this.loadSequence;
    try {
      const content: string = await invoke("read_file_content", { path: filePath });
      if (seq !== this.loadSequence) {
        return;
      }

      this.currentFilePath = filePath;
      this.savedContent = content;
      this.isModified = false;
      clearImageCache();
      setActiveDocumentPath(filePath);
      addRecentFile(filePath);

      const fileName = filePath.split(/[\\/]/).pop() || "Untitled.md";
      updateWindowTitle(fileName, false);

      const saveStatus = document.getElementById("footer-save-status");
      if (saveStatus) {
        saveStatus.textContent = "已保存";
        saveStatus.style.color = "var(--control-text-color)";
      }

      if (this.editorView) {
        this.editorView.dispatch({
          changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
        });
      }

      const treeContainer = document.getElementById("file-library-tree");
      syncActiveTreeItem(treeContainer, filePath);
    } catch (e) {
      console.error("Failed to load file:", e);
      alert(`无法打开文件: ${e}`);
    }
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  private async performSearch(keyword: string) {
    if (!keyword) return;
    const resultsContainer = document.getElementById("workspace-search-results");
    if (!resultsContainer) return;

    resultsContainer.innerHTML = `<div style="padding: 12px; color: var(--control-text-color); font-size: 12px; text-align: center;">搜索中...</div>`;

    try {
      const matches: Array<{ file: string; line: number; text: string }> = await invoke(
        "search_workspace_content",
        { keyword }
      );
      resultsContainer.innerHTML = "";
      if (matches.length === 0) {
        resultsContainer.innerHTML = `<div style="padding: 12px; color: var(--control-text-color); font-size: 12px; text-align: center;">无匹配结果</div>`;
        return;
      }

      matches.forEach((m) => {
        const item = document.createElement("div");
        item.className = "search-result-item";
        const fileName = m.file.split(/[\\/]/).pop() || m.file;
        item.innerHTML = `
          <div class="search-result-file" title="${this.escapeHtml(m.file)}">${this.escapeHtml(fileName)}</div>
          <div class="search-result-text"><span class="search-result-line">L${m.line}</span> ${this.escapeHtml(m.text)}</div>
        `;
        item.addEventListener("click", () => {
          this.loadFile(m.file).then(() => {
            if (this.editorView) {
              pulseSearchMatch(this.editorView, m.line, keyword);
            }
          });
        });
        resultsContainer.appendChild(item);
      });
    } catch (e) {
      resultsContainer.innerHTML = `<div style="padding: 12px; color: var(--control-text-color); font-size: 12px; text-align: center;">请先打开工作区文件夹</div>`;
    }
  }

  private showThemePicker(e: MouseEvent) {
    let picker = document.getElementById("app-theme-picker-popover");
    if (!picker) {
      picker = document.createElement("div");
      picker.id = "app-theme-picker-popover";
      picker.className = "ty-dropdown-menu hidden";
      document.body.appendChild(picker);

      picker.addEventListener("click", (evt) => {
        const item = (evt.target as HTMLElement).closest(".menu-item") as HTMLElement;
        if (!item || !item.dataset.theme) return;
        themeLoader.setTheme(item.dataset.theme);
        picker?.classList.add("hidden");
      });

      document.addEventListener("click", () => {
        picker?.classList.add("hidden");
      });
    }

    const cur = themeLoader.getTheme();
    picker.innerHTML = `
      <div class="menu-section">
        <div class="menu-item-group-title">切换内置主题</div>
        ${Object.values(BUILTIN_THEMES)
          .map(
            (t) => `
          <div class="menu-item theme-choice ${t.id === cur ? "active" : ""}" data-theme="${t.id}" style="${
              t.id === cur ? "color: #0969da; font-weight: 600;" : ""
            }">
            <span>${t.id === cur ? "✓ " : "  "}${t.label}</span>
          </div>
        `
          )
          .join("")}
      </div>
    `;

    picker.classList.remove("hidden");
    const targetEl = document.getElementById("footer-theme-selector") || (e.target as HTMLElement);
    const rect = targetEl.getBoundingClientRect();
    picker.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    picker.style.left = `${rect.left}px`;
    picker.style.top = "auto";
  }
}

const app = new App();
window.addEventListener("DOMContentLoaded", () => {
  app.init();
});
