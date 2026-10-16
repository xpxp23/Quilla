import { invoke } from "@tauri-apps/api/core";
import "katex/dist/katex.min.css";
import katex from "katex";
import mermaid from "mermaid";
import {
  createEditor,
  resetEditorDocument,
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
import {
  renderFileTree,
  FileItem,
  syncActiveTreeItem,
  triggerInlineCreateInTree,
} from "./components/file-tree";
import { initMenus } from "./components/menu";
import { initQuickOpen, addRecentFile } from "./components/quick-open";
import { initStatsPopover } from "./components/stats-popover";
import { initFloatingToolbars } from "./editor/extensions/floating-toolbars";
import { initSmartPaste } from "./editor/extensions/smart-paste";
import {
  setActiveDocumentPath,
  clearImageCache,
  stripInlineMarkdown,
} from "./editor/extensions/live-preview";
import { forceRefreshEffect } from "./editor/extensions/refresh-effect";
import { initFindReplace, FindReplaceController } from "./components/find-replace";
import { undo, redo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { pulseSearchMatch } from "./editor/extensions/search-highlighter";
import { showSaveConfirmDialog, showToast } from "./components/save-dialog";
import { isTableDelimiter } from "./editor/extensions/table-editor";
import {
  saveRecoverySnapshot,
  clearRecoverySnapshot,
  checkAndPromptRecovery,
} from "./components/auto-recovery";

const INITIAL_DEMO_DOC = `# 欢迎使用 Quilla (羽墨)

这是一个基于 **Rust + Tauri v2 + CodeMirror 6** 打造的极速、现代化的 Markdown 所见即所得编辑器。

## 核心特色与沉浸式体验

- **Token 级微观局部展开 (Micro-expansion)**：光标仅在进入特定单词标记（如 **加粗**、*优雅斜体*、***加粗斜体***、\`行内代码\`、公式 $E = mc^2$）内部时才展开源码，同行其他元素各自保持优雅渲染！
- **可视化表格内联编辑 (In-Place Table Editor)**：表格自始至终是标准排版表格，点击任意单元格直接打字，支持四向方向键导航、\`Tab\` 跳格、\`Ctrl+Enter\` 续行，聚焦时浮出工具条一键增删行列、切换对齐与删除整表！
- **Mermaid 流程图矢量渲染**：支持 \`\`\`mermaid 语法自动生成矢量流程图，编辑时上方显示源码，下方实时保留渲染预览，移出后平滑收起为无边框画布！
- **多行 LaTeX 数学公式块**：内置矢量 KaTeX 引擎，编辑时实时双向渲染。
- **多语言代码块卡片**：支持右上角点击搜索切换语言标签与一键复制代码。
- **全链路图片资产与拖放管道**：支持截图 \`Ctrl+V\` 自动在本地 \`assets/\` 落盘并插入，外部图片/文件直接拖入编辑器即可导入！

---

## 体验 1：可视化交互表格 (点击即可直接输入)

点击任意单元格直接打字；按 \`Tab\` 或方向键自由跳格，在最后一格按 \`Tab\` 自动新增一行：

| 模块名称 | 核心语言 | 职责说明 | 性能指标 |
| :--- | :---: | :--- | ---: |
| Rope Core | Rust | 文档缓冲原子持久化 | < 1ms |
| Micro Live View | TypeScript | Token 级微观局部展开 | 60 FPS |
| Visual Table | CSS/DOM | 可视化表格内联双向同步 | 即时响应 |
| Mermaid Engine | Mermaid.js | 响应式矢量流程图渲染 | 即时响应 |

---

## 体验 2：Mermaid 流程图渲染 (实时边写边预览)

\`\`\`mermaid
flowchart TD
    Start["启动 Quilla (羽墨)"] --> Parse["CodeMirror 6 极速排版"]
    Parse --> Mode{"视图模式?"}
    Mode -->|"实时预览"| Live["所见即所得渲染 (表格/公式/流程图)"]
    Mode -->|"源码模式"| Source["极简纯文本编辑"]
    Live --> Edit["双击或点击右上角图标进入源码编辑"]
    Edit --> Live
\`\`\`

---

## 体验 3：多语言代码块卡片 (右上角切换语言与复制)

\`\`\`rust
fn main() {
    println!("Hello, Quilla (羽墨)!");
    let rope = ropey::Rope::from_str("极速 Markdown 所见即所得引擎");
    println!("文档字数: {}", rope.len_chars());
}
\`\`\`

---

## 体验 4：数学公式与行内排版

- 质能方程：$E = mc^2$
- 行内斜体测试：*星号斜体 (Italic)* 与 _下划线斜体 (Underline Italic)_ 与 ***加粗斜体 (Bold Italic)***
- 高斯正态分布积分公式：
$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

---

## 体验 5：优雅引用块与快捷操作

> **快捷操作指南**
> - 打字机模式：按 \`F9\` 或点击底部状态栏【打字机】，光标垂直软居中锁频，滚轮可自由翻阅
> - 专注模式：按 \`F8\` 或点击底部状态栏【专注】，当前段落聚焦高亮，其余文本平滑淡化
> - 5 套内置主题：点击底部状态栏【主题】，一键在 GitHub、Night、Newsprint、Clear、Whitey 之间自由切换
> - 列表智能状态机：按 \`Enter\` 智能续行编号与任务框，按 \`Tab\` / \`Shift+Tab\` 缩进与降级，空项按 \`Enter\` 或 \`Backspace\` 智能退出
> - 选中文本气泡栏：鼠标划选任意文字自动浮出快捷格式化气泡工具条
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
    themeLoader.init();

    initTitlebar({
      onClose: () => this.handleWindowClose(),
    });

    this.initSidebarResizer();
    this.initSidebarTabs();
    this.initSidebarActions();

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

    this.findReplaceCtrl = initFindReplace(this.editorView);

    const quickOpen = initQuickOpen({
      onOpenFile: (filePath) => this.loadFile(filePath),
      getWorkspaceFiles: async () => {
        if (!this.currentWorkspaceRoot) return [];
        try {
          const res = await invoke<any[]>("list_workspace_files", {
            root: this.currentWorkspaceRoot,
          });
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

    document.getElementById("footer-toggle-sidebar")?.addEventListener("click", () => {
      document.body.classList.toggle("pin-outline");
    });

    const toggleSourceBtn = document.getElementById("footer-toggle-source");
    const toggleSourceMode = () => {
      const isSource = document.body.classList.toggle("source-mode");
      if (toggleSourceBtn) {
        const labelSpan = toggleSourceBtn.querySelector(".footer-btn-label");
        if (labelSpan) {
          labelSpan.textContent = isSource ? "实时预览" : "源码模式";
        } else {
          toggleSourceBtn.innerHTML = isSource ? "&lt;/&gt; 实时预览" : "&lt;/&gt; 源码模式";
        }
      }
      if (this.editorView) {
        this.editorView.dispatch({
          effects: forceRefreshEffect.of(true),
        });
        this.editorView.focus();
      }
    };
    toggleSourceBtn?.addEventListener("click", toggleSourceMode);

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
        this.printDocument();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (this.editorView && this.editorView.hasFocus) {
          return;
        }
        const active = document.activeElement as HTMLElement;
        if (
          active &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.isContentEditable)
        ) {
          return;
        }
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
        if (
          active &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.isContentEditable)
        ) {
          return;
        }
        if (this.editorView) {
          e.preventDefault();
          redo(this.editorView);
        }
      }
    });

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
      onPrint: () => this.printDocument(),
      onQuickOpen: () => quickOpen.open(),
    });

    window.addEventListener("beforeunload", (e) => {
      if (this.isModified) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    const searchInput = document.getElementById("workspace-search-input") as HTMLInputElement;
    searchInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.performSearch(searchInput.value.trim());
      }
    });

    const isNewWin = await invoke<boolean>("is_blank_new_window").catch(() => false);
    const cliFile = await invoke<string | null>("get_cli_open_file").catch(() => null);

    const urlParams = new URLSearchParams(window.location.search);
    const urlOpen = urlParams.get("open");
    const urlNew = urlParams.get("new");

    if (cliFile || urlOpen) {
      const target = cliFile || decodeURIComponent(urlOpen!);
      await this.loadFile(target);
    } else if (isNewWin || urlNew === "1") {
      await this.newFile();
    } else {
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

    checkAndPromptRecovery(async (snapshot) => {
      this.currentFilePath = snapshot.filePath;
      setActiveDocumentPath(snapshot.filePath);
      if (snapshot.filePath) {
        try {
          this.savedContent = await invoke<string>("read_file_content", {
            path: snapshot.filePath,
          });
        } catch {
          this.savedContent = "";
        }
      } else {
        this.savedContent = "";
      }
      if (this.editorView) {
        resetEditorDocument(this.editorView, snapshot.content);
        this.editorView.focus();
      }
      const treeContainer = document.getElementById("file-library-tree");
      syncActiveTreeItem(treeContainer, snapshot.filePath);
      this.handleContentChange(snapshot.content);
      showToast("已恢复未保存的文档草稿", "success");
    });
  }

  private async createNewWindow(filePath?: string | null) {
    try {
      await invoke("create_new_window", { filePath: filePath || null });
    } catch (err) {
      console.error("新建窗口失败:", err);
      showToast(`新建窗口失败: ${err}`, "error");
    }
  }

  private initSidebarResizer() {
    const resizer = document.getElementById("sidebar-resizer");
    if (!resizer) return;

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
    document.getElementById("open-folder-empty-btn")?.addEventListener("click", () => {
      this.openWorkspaceFolder();
    });

    document.getElementById("workspace-folder-trigger")?.addEventListener("click", () => {
      this.openWorkspaceFolder();
    });

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
      clearRecoverySnapshot(this.currentFilePath);
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
      clearRecoverySnapshot(this.currentFilePath);
      const fileName = this.currentFilePath.split(/[\\/]/).pop() || "Untitled.md";
      updateWindowTitle(fileName, false);
      if (saveStatus) {
        saveStatus.textContent = "已保存";
        saveStatus.style.color = "var(--control-text-color)";
      }
      return true;
    } catch (err) {
      showToast(`保存文件失败: ${err}`, "error");
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
      let content = this.editorView ? this.editorView.state.doc.toString() : this.savedContent;

      // 若原先是未保存文档且粘贴过临时目录图片 (quilla-unsaved)，自动迁移至新文档同级 assets/ 目录
      if (!this.currentFilePath && content.includes("quilla-unsaved")) {
        const tempImgRegex = /(!\[[^\]]*\]\()([^)\n]*quilla-unsaved[^)\n]*)(\))/g;
        const matches = Array.from(content.matchAll(tempImgRegex));
        for (const m of matches) {
          const oldTempPath = m[2];
          try {
            const newRelPath = await invoke<string>("copy_image_to_assets", {
              docPath: targetPath,
              sourcePath: oldTempPath,
            });
            content = content.split(oldTempPath).join(newRelPath);
          } catch {
            // ignore migration error for missing temp image
          }
        }
        if (this.editorView && content !== this.editorView.state.doc.toString()) {
          this.editorView.dispatch({
            changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
          });
        }
      }

      await invoke("save_file_content", {
        path: targetPath,
        content,
      });

      const oldPath = this.currentFilePath;
      this.currentFilePath = targetPath;
      this.savedContent = content;
      this.isModified = false;
      clearImageCache();
      setActiveDocumentPath(targetPath);
      addRecentFile(targetPath);
      clearRecoverySnapshot(oldPath);
      clearRecoverySnapshot(targetPath);

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

      if (
        this.currentWorkspaceRoot &&
        targetPath.toLowerCase().startsWith(this.currentWorkspaceRoot.toLowerCase())
      ) {
        await this.loadWorkspace(this.currentWorkspaceRoot);
      }
      const treeContainer = document.getElementById("file-library-tree");
      syncActiveTreeItem(treeContainer, targetPath);

      showToast(`已保存至 ${fileName}`, "success");
      return true;
    } catch (err) {
      showToast(`另存为失败: ${err}`, "error");
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
      resetEditorDocument(this.editorView, initialText);
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
    document.body.classList.add("pin-outline");
    document.getElementById("tab-files")?.click();
    const treeContainer = document.getElementById("file-library-tree");
    triggerInlineCreateInTree(treeContainer, false, this.currentWorkspaceRoot, 0);
  }

  private async createSidebarNewFolder() {
    if (!this.currentWorkspaceRoot) {
      showToast("请先打开工作区文件夹", "info");
      return;
    }
    document.body.classList.add("pin-outline");
    document.getElementById("tab-files")?.click();
    const treeContainer = document.getElementById("file-library-tree");
    triggerInlineCreateInTree(treeContainer, true, this.currentWorkspaceRoot, 0);
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
      showToast(`打开文件对话框失败: ${err}`, "error");
    }
  }

  /**
   * 完整出版级 Markdown -> HTML 异步渲染管线：
   * 支持：Mermaid 矢量 SVG 预渲染、KaTeX 公式、多级嵌套列表与任务列表、表格、[TOC] 目录、脚注、
   * 保留 <img width/align> 属性，并将本地相对路径图片自动转换为内联 Base64，实现 100% 自包含 HTML 与无损打印！
   */
  private async renderMarkdownToHtmlBody(md: string): Promise<string> {
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

    const resolveImgSrc = async (rawSrc: string): Promise<string> => {
      if (
        rawSrc.startsWith("http://") ||
        rawSrc.startsWith("https://") ||
        rawSrc.startsWith("data:")
      ) {
        return rawSrc;
      }
      try {
        return await invoke<string>("read_image_base64", {
          docPath: this.currentFilePath,
          relPath: rawSrc,
        });
      } catch {
        return rawSrc;
      }
    };

    const renderInline = async (raw: string): Promise<string> => {
      const placeholders: string[] = [];
      const pushPh = (html: string) => {
        const token = `\u0000EXP_PH_${placeholders.length}_\u0000`;
        placeholders.push(html);
        return token;
      };

      let working = raw;

      // 0. 保护换行 <br> 与 HTML <img ...> 标签（防止被 escapeHtml 转义成源码文本）
      working = working.replace(/<br\s*\/?>/gi, () => pushPh("<br />"));

      const htmlImgMatches = Array.from(
        working.matchAll(/<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)\/?>/gi)
      );
      for (const m of htmlImgMatches) {
        const fullTag = m[0];
        const fullAttrs = `${m[1]} ${m[3]}`;
        const rawSrc = m[2];
        const resolvedSrc = await resolveImgSrc(rawSrc);
        const altMatch = fullAttrs.match(/alt=["']([^"']*)["']/i);
        const widthMatch = fullAttrs.match(/width=["']([^"']*)["']/i);
        const alignMatch = fullAttrs.match(/align=["']([^"']*)["']/i);
        const alt = this.escapeHtml(altMatch ? altMatch[1] : "");
        const widthStyle = widthMatch ? `width:${this.escapeHtml(widthMatch[1])};` : "";
        const align = alignMatch ? alignMatch[1] : "left";
        const wrapStyle =
          align === "center"
            ? "text-align:center;"
            : align === "right"
            ? "text-align:right;"
            : "text-align:left;";
        const imgHtml = `<figure class="md-image-card" style="${wrapStyle}"><img src="${resolvedSrc}" alt="${alt}" style="${widthStyle}max-width:100%;" /></figure>`;
        working = working.replace(fullTag, () => pushPh(imgHtml));
      }

      // 1. 提取 Markdown 图片 ![alt](src)
      const mdImgMatches = Array.from(working.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g));
      for (const m of mdImgMatches) {
        const fullMatch = m[0];
        const alt = this.escapeHtml(m[1]);
        const resolvedSrc = await resolveImgSrc(m[2]);
        const imgHtml = `<img alt="${alt}" src="${resolvedSrc}" style="max-width:100%;" />`;
        working = working.replace(fullMatch, () => pushPh(imgHtml));
      }

      // 2. 转义普通文本中的 HTML 特殊字符
      working = this.escapeHtml(working);

      // 3. 提取行内代码 `code`
      working = working.replace(/`([^`\n]+)`/g, (_m, code) => pushPh(`<code>${code}</code>`));

      // 4. 提取行内公式 $...$
      working = working.replace(/(?<![\\$\d])\$([^\s$\\](?:[^$\n]*?[^\s$\\])?)\$(?!\d)/g, (_m, tex) => {
        const unescapedTex = tex
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#039;/g, "'");
        try {
          return pushPh(
            katex.renderToString(unescapedTex, {
              displayMode: false,
              throwOnError: false,
              output: "html",
            })
          );
        } catch {
          return pushPh(`<code>$${tex}$</code>`);
        }
      });

      // 5. 超链接与脚注角标
      working = working.replace(/\[\^([^\]\n]+)\]/g, (_m, fn) =>
        pushPh(`<sup class="cm-footnote-ref">[${fn}]</sup>`)
      );
      working = working.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_m, text, url) =>
        pushPh(`<a href="${url}" target="_blank" rel="noopener">${text}</a>`)
      );

      // 6. 加粗斜体 / 加粗 / 斜体 / 删除线 / 高亮 / 上下标
      working = working.replace(/(\*{3}|_{3})([^*_\n]+?)\1/g, "<strong><em>$2</em></strong>");
      working = working.replace(/(\*{2}|_{2})([^*_\n]+?)\1/g, "<strong>$2</strong>");
      working = working.replace(
        /(?<!\*)\*([^*\s\n][^*\n]*?)\*(?!\*)|(?<!_)_([^_\s\n][^_\n]*?)_(?!_)/g,
        "<em>$1$2</em>"
      );
      working = working.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
      working = working.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
      working = working.replace(/(?<!~)~([^~\s\n][^~\n]*?)~(?!~)/g, "<sub>$1</sub>");
      working = working.replace(/\^([^\^\s\n][^\^\n]*?)\^/g, "<sup>$1</sup>");

      // 7. 还原占位符
      working = working.replace(
        /\u0000EXP_PH_(\d+)_\u0000/g,
        (_m, idx) => placeholders[Number(idx)] || ""
      );
      return working;
    };

    // 预先收集全文标题供 [TOC] 渲染
    const allDocHeadings: Array<{ level: number; text: string; id: string }> = [];
    {
      let inF = false;
      let fChar = "";
      for (let k = i; k < lines.length; k++) {
        const t = lines[k].trim();
        if (/^(```+|~~~+)/.test(t)) {
          const mChar = t[0];
          if (!inF) {
            inF = true;
            fChar = mChar;
          } else if (mChar === fChar) {
            inF = false;
          }
          continue;
        }
        if (inF) continue;
        const hm = lines[k].match(/^(#{1,6})\s+(.*)$/);
        if (hm) {
          const clean = stripInlineMarkdown(hm[2]);
          const id = `heading-${k}-${clean.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}`;
          allDocHeadings.push({ level: hm[1].length, text: clean, id });
        }
      }
    }

    let headingCursor = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      // 1. 围栏代码块与 Mermaid 矢量图渲染
      const fenceMatch = trimmed.match(/^(```+|~~~+)\s*([^\s`~]*).*$/);
      if (fenceMatch) {
        const fenceChar = fenceMatch[1][0];
        const lang = (fenceMatch[2] || "").toLowerCase();
        const codeLines: string[] = [];
        i++;
        while (i < lines.length) {
          const t = lines[i].trim();
          if (
            (fenceChar === "`" && /^```+$/.test(t)) ||
            (fenceChar === "~" && /^~~~+$/.test(t))
          ) {
            i++;
            break;
          }
          codeLines.push(lines[i]);
          i++;
        }
        const rawCode = codeLines.join("\n");
        if (lang === "mermaid") {
          try {
            const id = "mmd-exp-" + Math.random().toString(36).substring(2, 9);
            const { svg } = await mermaid.render(id, rawCode.trim());
            out.push(`<figure class="md-mermaid-card"><div class="mermaid-chart-box">${svg}</div></figure>`);
          } catch {
            out.push(`<pre><code class="language-mermaid">${this.escapeHtml(rawCode)}</code></pre>`);
          }
        } else {
          out.push(
            `<pre><code class="language-${this.escapeHtml(lang)}">${this.escapeHtml(rawCode)}</code></pre>`
          );
        }
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
        i++;
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

      // 3.5 [TOC] 目录块
      if (/^\[TOC\]$/i.test(trimmed)) {
        const tocItems = allDocHeadings
          .map(
            (h) =>
              `<li style="padding-left:${(h.level - 1) * 16}px"><a href="#${h.id}">${this.escapeHtml(h.text)}</a></li>`
          )
          .join("");
        out.push(
          `<nav class="cm-toc-card"><div class="cm-toc-title">目录</div><ul class="cm-toc-list">${tocItems}</ul></nav>`
        );
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
        const thRendered = await Promise.all(
          headers.map(
            async (h, idx) =>
              `<th style="text-align:${aligns[idx]}">${await renderInline(h)}</th>`
          )
        );
        const tbodyRowsRendered: string[] = [];
        for (const r of bodyRows) {
          const tds = await Promise.all(
            headers.map(
              async (_h, idx) =>
                `<td style="text-align:${aligns[idx]}">${await renderInline(r[idx] || "")}</td>`
            )
          );
          tbodyRowsRendered.push(`<tr>${tds.join("")}</tr>`);
        }
        out.push(
          `<table class="md-table"><thead><tr>${thRendered.join("")}</tr></thead><tbody>${tbodyRowsRendered.join("")}</tbody></table>`
        );
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
        const hMeta = allDocHeadings[headingCursor++];
        const idAttr = hMeta ? ` id="${hMeta.id}"` : "";
        out.push(`<h${lvl}${idAttr}>${await renderInline(hMatch[2].trim())}</h${lvl}>`);
        i++;
        continue;
      }

      // 7. 引用块
      if (trimmed.startsWith(">")) {
        const qLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          qLines.push(await renderInline(lines[i].replace(/^\s*>\s?/, "")));
          i++;
        }
        out.push(`<blockquote><p>${qLines.join("<br/>")}</p></blockquote>`);
        continue;
      }

      // 8. 多级无序/有序/任务列表（支持缩进层级嵌套）
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const listLines: Array<{
          indent: number;
          ordered: boolean;
          html: string;
        }> = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          const cur = lines[i];
          const indent = (cur.match(/^\s*/)?.[0] || "").length;
          const taskM = cur.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/);
          const ordM = cur.match(/^\s*\d+\.\s+(.*)$/);
          if (taskM) {
            const checked = taskM[1].toLowerCase() === "x" ? " checked disabled" : " disabled";
            listLines.push({
              indent,
              ordered: false,
              html: `<li class="task-list-item"><input type="checkbox"${checked} /> ${await renderInline(taskM[2])}</li>`,
            });
          } else if (ordM) {
            listLines.push({
              indent,
              ordered: true,
              html: `<li>${await renderInline(ordM[1])}</li>`,
            });
          } else {
            const itemTxt = cur.replace(/^\s*[-*+]\s+/, "");
            listLines.push({
              indent,
              ordered: false,
              html: `<li>${await renderInline(itemTxt)}</li>`,
            });
          }
          i++;
        }

        // 根据缩进层级构建嵌套列表树
        let listHtml = "";
        const tagStack: Array<{ tag: "ul" | "ol"; indent: number }> = [];
        for (const item of listLines) {
          const tag = item.ordered ? "ol" : "ul";
          if (tagStack.length === 0 || item.indent > tagStack[tagStack.length - 1].indent) {
            listHtml += `<${tag}>`;
            tagStack.push({ tag, indent: item.indent });
          } else {
            while (
              tagStack.length > 1 &&
              item.indent < tagStack[tagStack.length - 1].indent
            ) {
              const popped = tagStack.pop()!;
              listHtml += `</${popped.tag}>`;
            }
            if (tagStack[tagStack.length - 1].tag !== tag) {
              const popped = tagStack.pop()!;
              listHtml += `</${popped.tag}><${tag}>`;
              tagStack.push({ tag, indent: item.indent });
            }
          }
          listHtml += item.html;
        }
        while (tagStack.length > 0) {
          const popped = tagStack.pop()!;
          listHtml += `</${popped.tag}>`;
        }
        out.push(listHtml);
        continue;
      }

      // 9. 普通段落
      out.push(`<p>${await renderInline(line)}</p>`);
      i++;
    }

    return out.join("\n");
  }

  /**
   * 全量无损打印 / 导出 PDF：
   * 将全文渲染至独立打印容器 #quilla-print-mount，彻底规避 CodeMirror 虚拟视口只渲染当前屏幕几十行导致长文档截断的缺陷
   */
  private async printDocument() {
    if (!this.editorView) return;
    const docText = this.editorView.state.doc.toString();
    const bodyHtml = await this.renderMarkdownToHtmlBody(docText);

    let printMount = document.getElementById("quilla-print-mount");
    if (!printMount) {
      printMount = document.createElement("div");
      printMount.id = "quilla-print-mount";
      document.body.appendChild(printMount);
    }
    printMount.innerHTML = bodyHtml;

    const cleanup = () => {
      if (printMount) printMount.innerHTML = "";
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);

    setTimeout(() => {
      window.print();
    }, 60);
  }

  private async exportHtml() {
    if (!this.editorView) return;
    const docText = this.editorView.state.doc.toString();
    const title = this.currentFilePath
      ? this.currentFilePath.split(/[\\/]/).pop()!.replace(/\.(md|markdown|txt)$/i, "")
      : "document-export";
    const themeCss = themeLoader.getThemeMeta().css;
    const bodyHtml = await this.renderMarkdownToHtmlBody(docText);

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
    li.task-list-item { list-style: none; }
    .md-mermaid-card { text-align: center; margin: 1.4rem 0; }
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
        showToast("HTML 导出成功", "success");
      }
      return;
    } catch {
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
      clearRecoverySnapshot(this.currentFilePath);
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
          reorderDocumentHeading(
            this.editorView,
            this.currentHeadings,
            fromIdx,
            toIdx,
            insertAfter
          );
        }
      }
    );

    if (this.editorView) {
      const curLine = this.editorView.state.doc.lineAt(
        this.editorView.state.selection.main.head
      ).number;
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
        resetEditorDocument(this.editorView, content);
      }

      const treeContainer = document.getElementById("file-library-tree");
      syncActiveTreeItem(treeContainer, filePath);
    } catch (e) {
      console.error("Failed to load file:", e);
      showToast(`无法打开文件: ${e}`, "error");
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
    } catch {
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
              t.id === cur ? "color: var(--primary-color, #0969da); font-weight: 600;" : ""
            }">
            <span>${t.id === cur ? "✓ " : "  "}${t.label}</span>
          </div>
        `
          )
          .join("")}
      </div>
    `;

    picker.classList.remove("hidden");
    const targetEl =
      document.getElementById("footer-theme-selector") || (e.target as HTMLElement);
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
