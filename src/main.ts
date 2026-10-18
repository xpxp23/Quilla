import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "katex/dist/katex.min.css";
import katex from "katex";
import mermaid from "mermaid";
import {
  createEditor,
  createEditorStateForView,
  resetEditorDocument,
  toggleTypewriterMode,
  isTypewriterModeActive,
  toggleFocusMode,
  isFocusModeActive,
  countMixedWords,
  extractOutlineHeadings,
} from "./editor";
import { themeLoader, BUILTIN_THEMES } from "./themes/theme-loader";
import { initTitlebar, updateWindowTitle } from "./components/titlebar";
import {
  renderOutline,
  OutlineHeading,
  reorderDocumentHeading,
  syncActiveOutlineHeading,
  toggleAllOutlineFold,
  registerOutlineEditorGetter,
} from "./components/outline";
import {
  renderFileTree,
  FileItem,
  syncActiveTreeItem,
  triggerInlineCreateInTree,
  toggleTreeSortMode,
} from "./components/file-tree";
import { initMenus } from "./components/menu";
import { initQuickOpen, addRecentFile } from "./components/quick-open";
import { initStatsPopover } from "./components/stats-popover";
import {
  getPreferences,
  applyPreferencesToDOM,
  onPreferencesChange,
  openPreferencesModal,
} from "./components/preferences";
import { initFloatingToolbars } from "./editor/extensions/floating-toolbars";
import { initSmartPaste } from "./editor/extensions/smart-paste";
import {
  setActiveDocumentPath,
  clearImageCache,
  stripInlineMarkdown,
  restoreFoldState,
} from "./editor/extensions/live-preview";
import { highlightCodeBlockToHtml } from "./editor/extensions/code-highlighter";
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
  TextDeltaPayload,
} from "./components/auto-recovery";
import { TabsManager, DocumentTab } from "./components/tabs-manager";
import {
  registerWikiWorkspaceProvider,
  BacklinksController,
  parseWikiLinksInLine,
  fetchTransclusionSectionContent,
} from "./editor/extensions/wiki-link";
import { navigateToAnchor } from "./editor/extensions/anchor-navigator";
import {
  openKnowledgeGraphModal,
  renderSidebarTagsCloud,
} from "./components/knowledge-graph";
import {
  openTimeMachineModal,
  saveFallbackLocalHistorySnapshot,
} from "./components/time-machine";
import {
  copyForWeChatOrZhihu,
  exportWordDocument,
  openSharePosterModal,
  openPdfExportModal,
} from "./components/publisher-export";
import { renderMarkdownDocumentToHtml } from "./editor/markdown-ast-renderer";
import { quillaPluginRegistry } from "./editor/plugin-system";

const INITIAL_DEMO_DOC = `---
title: Quilla (羽墨) v0.7 全景工作台指南
author: Quilla Studio
tags: [Markdown, 双链知识库, 思源大纲, 效率工具/写作]
version: 0.7.0
---

# 欢迎使用 Quilla (羽墨) v0.7

这是一个基于 **Rust + Tauri v2 + CodeMirror 6 Lezer AST** 打造的极速、现代化的 Markdown 所见即所得编辑器与本地知识库系统。支持内联标签如 #知识管理/双链笔记 与 #Markdown写作（点击标签可直接在侧边栏聚合检索）。

> [!TIP] Quilla v0.7 全景深度精进与架构升级
> - **第一阶段 · 块级与大纲深度操控**：左侧 6 点抓手采用真实 DOM 几何与悬停桥接锁，点击或右键唤起 **块级命令菜单（Turn Into / 克隆 / 移动 / 章节折叠）**；侧边栏大纲支持右键 **单标题升降级、带子标题整体升级/降级（思源笔记风格）、复制章节双链与整章操作**。
> - **第二阶段 · 块级嵌入与知识图谱**：支持 \`![[文档#标题]]\` 块级/章节实时嵌入卡片、YAML Front Matter 可视化属性面板、多级 \`#父标签/子标签\` 胶囊检索，以及按 \`Ctrl+G\` 唤起 **交互式双链知识图谱**。
> - **第三阶段 · 时间机器与多渠道发布**：按 \`Ctrl+Alt+H\` 打开 **本地版本历史（Time Machine）** 进行逐行 Diff 对比与一键无损回滚；支持 **一键复制微信公众号/知乎内联富文本**、导出 **Word (\`.doc\`)** 及 **社交长图分享卡片 (\`.png\`)**。

---

## 体验 1：章节折叠、块级嵌入与多级列表

点击任意标题右侧的折叠图标（或通过大纲右键菜单）即可收起整章正文。您还可以使用 \`![[#体验 4：一体式代码块卡片与数学公式]]\` 在任意位置实时嵌入其他章节或笔记内容：

![[#体验 4：一体式代码块卡片与数学公式]]

1. 一级核心架构：Rust Ropey 增量缓冲 + CodeMirror 6 Lezer 语法树
2. 多级列表智能编号（在任意层级按 \`Tab\` / \`Shift+Tab\` 自动归零并重排后续序号，光标始终精准落于文本右侧）：
   1. 子级列表项自动从 \`1.\` 独立起算
   2. 按 \`Alt + ↑/↓\` 可整块上下移动，按 \`Ctrl + D\` 一键克隆当前块
3. 可视化交互表格（支持拖拽行列换位、拖拽列边缘调宽与 \`Ctrl+K\` 插入超链接）：

| 模块名称 | 核心技术 | 关键特性 | 性能指标 |
| :--- | :---: | :--- | ---: |
| Lezer AST Engine | CodeMirror 6 | 增量语法树与单趟结构缓存 | < 0.5ms |
| Block & Outline | Real DOM Geometry | 抓手右键菜单 + 思源式子树整体升降级 | 零偏移 |
| Knowledge Graph | Force SVG + Rayon | \`[[双链]]\` / \`![[嵌入块]]\` / 交互式力导向图谱 | 60 FPS |
| Time Machine | LCS Visual Diff | 本地历史版本时间轴对比与一键回滚 | 零丢失 |

---

## 体验 2：GitHub 风格 Callout 高亮卡片

> [!NOTE] 笔记与提示 (Note / Tip / Important / Warning / Caution)
> 光标移出时自动渲染为带四周边框、矢量图标与主题色的精致卡片，点击头部或移入首行即可原位修改类型与标题。

> [!WARNING] 多渠道一键发布提示
> 点击左上角主菜单或编辑器右键菜单中的 **「复制为公众号 / 知乎富文本」**，即可将全文转化为带内联样式的精美排版，直接粘贴至微信公众号后台！

---

## 体验 3：Mermaid 流程图渲染 (实时边写边预览)

\`\`\`mermaid
flowchart LR
    Start["Quilla v0.7"] --> Phase1["块手柄菜单 & 思源式大纲右键"]
    Start --> Phase2["![[块级嵌入]] & 双链知识图谱"]
    Start --> Phase3["时间机器 Diff & 公众号/长图发布"]
\`\`\`

---

## 体验 4：一体式代码块卡片与数学公式

\`\`\`rust
fn main() {
    println!("Hello, Quilla (羽墨) v0.7!");
    let rope = ropey::Rope::from_str("支持代码块一键折叠、自动缩进格式化与点击左侧行号整行选中");
    println!("文档字符数: {}", rope.len_chars());
}
\`\`\`

- 质能方程：$E = mc^2$，欧拉恒等式：$e^{i\\pi} + 1 = 0$
- 高斯正态分布积分公式：
$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$
`;

function sanitizeHref(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (/^(javascript:|vbscript:|data:text\/html)/i.test(trimmed)) {
    return "#";
  }
  return trimmed;
}

class App {
  private currentFilePath: string | null = null;
  private currentWorkspaceRoot: string | null = null;
  private workspaceFileCache: Array<{ path: string; name: string; stem: string }> = [];
  private isModified: boolean = false;
  private savedContent: string = INITIAL_DEMO_DOC;
  private loadSequence: number = 0;
  private editorView: EditorView | null = null;
  private findReplaceCtrl: FindReplaceController | null = null;
  private tabsManager: TabsManager | null = null;
  private backlinksCtrl: BacklinksController | null = null;
  private currentHeadings: OutlineHeading[] = [];
  private autoSaveTimer: any = null;
  private isClosingConfirmationOpen: boolean = false;
  private searchCaseSensitive: boolean = false;
  private searchDebounceTimer: any = null;

  async init() {
    applyPreferencesToDOM();
    themeLoader.init();

    initTitlebar({
      onClose: () => this.handleWindowClose(),
    });

    document.getElementById("w-settings")?.addEventListener("click", () => {
      openPreferencesModal();
    });
    document.getElementById("w-graph-btn")?.addEventListener("click", () => {
      this.openKnowledgeGraph();
    });
    document.getElementById("w-history-btn")?.addEventListener("click", () => {
      this.openTimeMachine();
    });
    document.getElementById("footer-open-graph")?.addEventListener("click", () => {
      this.openKnowledgeGraph();
    });
    document.getElementById("footer-open-history")?.addEventListener("click", () => {
      this.openTimeMachine();
    });
    document.getElementById("footer-save-status")?.addEventListener("click", () => {
      this.openTimeMachine();
    });

    this.initSidebarResizer();
    this.initSidebarTabs();
    this.initSidebarActions();

    // 注册 [[Wiki Links]] 工作区上下文提供器
    registerWikiWorkspaceProvider({
      getWorkspaceRoot: () => this.currentWorkspaceRoot,
      getActiveFilePath: () => this.currentFilePath,
      getWorkspaceMarkdownFiles: async () => {
        if (this.workspaceFileCache.length > 0) {
          return this.workspaceFileCache;
        }
        return this.refreshWorkspaceMarkdownIndex();
      },
      onOpenWikiTarget: async (filePath, headingAnchor) => {
        const loaded = await this.loadFile(filePath);
        if (loaded && headingAnchor && this.editorView) {
          setTimeout(() => {
            if (this.editorView) {
              navigateToAnchor(this.editorView, headingAnchor);
            }
          }, 50);
        }
      },
      onCreateAndOpenWikiFile: async (targetName, headingAnchor) => {
        if (!this.currentWorkspaceRoot) {
          showToast("请先打开工作区文件夹以创建双链笔记", "info");
          return;
        }
        const cleanName = targetName.replace(/[\\/:*?"<>|]/g, "_").trim();
        const fileName = cleanName.toLowerCase().endsWith(".md")
          ? cleanName
          : `${cleanName}.md`;
        const sep = this.currentWorkspaceRoot.includes("\\") ? "\\" : "/";
        const fullPath = `${this.currentWorkspaceRoot.replace(/[\\/]+$/, "")}${sep}${fileName}`;
        const initialHeading = headingAnchor ? `\n\n## ${headingAnchor}\n\n` : "\n\n";
        const initialMd = `# ${cleanName.replace(/\.md$/i, "")}${initialHeading}`;
        try {
          await invoke("save_file_content", {
            path: fullPath,
            content: initialMd,
          });
          await this.loadWorkspace(this.currentWorkspaceRoot, true);
          await this.loadFile(fullPath);
          showToast(`已自动创建并打开笔记：${fileName}`, "success");
        } catch (err) {
          showToast(`创建双链笔记失败: ${err}`, "error");
        }
      },
      onFilterByTag: (tag: string) => {
        document.body.classList.add("pin-outline");
        document.getElementById("tab-search")?.click();
        const searchInput = document.getElementById(
          "workspace-search-input"
        ) as HTMLInputElement | null;
        if (searchInput) {
          searchInput.value = `#${tag}`;
          this.performSearch(`#${tag}`);
        }
      },
      onSearchTag: (tag: string) => {
        document.body.classList.add("pin-outline");
        document.getElementById("tab-search")?.click();
        const searchInput = document.getElementById(
          "workspace-search-input"
        ) as HTMLInputElement | null;
        if (searchInput) {
          searchInput.value = `#${tag}`;
          this.performSearch(`#${tag}`);
        }
      },
      onOpenGraphModal: () => {
        this.openKnowledgeGraph();
      },
    });

    // 监听反向链接面板知识图谱按钮与全局标签点击事件
    window.addEventListener("quilla-open-graph-view", () => {
      this.openKnowledgeGraph();
    });
    window.addEventListener("quilla-filter-by-tag", (e: any) => {
      const tag = e.detail?.tag;
      if (!tag) return;
      document.body.classList.add("pin-outline");
      document.getElementById("tab-search")?.click();
      const searchInput = document.getElementById(
        "workspace-search-input"
      ) as HTMLInputElement | null;
      if (searchInput) {
        searchInput.value = `#${tag}`;
        this.performSearch(`#${tag}`);
      }
    });

    const writeContainer = document.getElementById("write")!;
    this.editorView = createEditor(writeContainer, INITIAL_DEMO_DOC, {
      onChange: (content, deltas) => this.handleContentChange(content, deltas),
      onStatsUpdate: (words, chars) => this.updateStats(words, chars),
      onOutlineUpdate: (headings) => this.updateOutline(headings),
      onCursorLineChange: (line) => {
        const outlineContainer = document.getElementById("outline-content");
        syncActiveOutlineHeading(outlineContainer, this.currentHeadings, line);
      },
      onOpenFile: (filePath) => this.loadFile(filePath),
      onOpenWorkspace: (dirPath) => this.loadWorkspace(dirPath),
    });

    // 初始化多文档标签栏与左右分屏控制器
    this.tabsManager = new TabsManager({
      getPrimaryView: () => this.editorView,
      onActiveTabChanged: (tab) => this.syncFromActiveTab(tab),
      onTabCloseConfirm: async (tab) => {
        if (!tab.isModified) return "discard";
        this.tabsManager?.activateTab(tab.id);
        return this.confirmDiscardOrSave();
      },
      onNewBlankTabRequest: () => {
        this.newFile();
      },
      onOpenFileRequest: (filePath) => {
        this.loadFile(filePath);
      },
      onSaveTabRequest: async (tab) => {
        if (this.tabsManager && tab.id !== this.tabsManager.getActiveTab()?.id) {
          this.tabsManager.activateTab(tab.id);
        }
        await this.saveFile(false);
      },
      onSaveTabAsRequest: async (tab) => {
        if (this.tabsManager && tab.id !== this.tabsManager.getActiveTab()?.id) {
          this.tabsManager.activateTab(tab.id);
        }
        await this.saveFileAs();
      },
      onOpenInNewWindowRequest: async (tab) => {
        await this.openTabInNewWindow(tab);
      },
      onSecondaryDocChanged: (tab, content) => {
        saveRecoverySnapshot(tab.filePath, content, tab.title);
      },
    });
    this.tabsManager.init(null, "未命名.md", INITIAL_DEMO_DOC);

    // 注册大纲右键菜单编辑器获取器
    registerOutlineEditorGetter(() => this.tabsManager?.getFocusedView() || this.editorView);

    // 初始化底部 [[Wiki Links]] 反向链接面板
    const writeWrapper = document.getElementById("write-wrapper");
    if (writeWrapper) {
      this.backlinksCtrl = new BacklinksController(writeWrapper, (filePath, line, targetName) => {
        this.loadFile(filePath).then((ok) => {
          if (ok && this.editorView) {
            pulseSearchMatch(this.editorView, line, targetName);
          }
        });
      });
    }

    this.findReplaceCtrl = initFindReplace(this.editorView);

    const quickOpen = initQuickOpen({
      onOpenFile: (filePath) => this.loadFile(filePath),
      getWorkspaceFiles: async () => {
        const list = await this.refreshWorkspaceMarkdownIndex();
        return list.map((f) => f.path);
      },
    });

    initStatsPopover(this.editorView);
    initFloatingToolbars(this.editorView, (filePath) => this.loadFile(filePath));
    initSmartPaste(this.editorView);

    // 监听偏好设置变更并实时刷新编辑器装饰器与自动保存策略
    onPreferencesChange(() => {
      if (this.editorView) {
        this.editorView.dispatch({
          effects: forceRefreshEffect.of(true),
        });
      }
      const secView = this.tabsManager?.getSecondaryView();
      if (secView) {
        secView.dispatch({
          effects: forceRefreshEffect.of(true),
        });
      }
      this.setupAutoSaveTimer();
    });
    window.addEventListener("app-theme-changed", () => {
      if (this.editorView) {
        this.editorView.dispatch({
          effects: forceRefreshEffect.of(true),
        });
      }
      const secView = this.tabsManager?.getSecondaryView();
      if (secView) {
        secView.dispatch({
          effects: forceRefreshEffect.of(true),
        });
      }
    });
    this.setupAutoSaveTimer();

    // 窗口失焦自动保存 (当偏好设置为 onBlur 时)
    window.addEventListener("blur", () => {
      const prefs = getPreferences();
      if (prefs.autoSaveMode === "onBlur" && this.isModified && this.currentFilePath) {
        this.saveFile(true);
      }
    });

    // 监听来自多窗口状态总线的实时保存广播 (Multi-Window State Bus)
    listen<{ path: string; sourceWindow: string }>(
      "quilla-cross-window-file-saved",
      async (event) => {
        const savedPath = event.payload?.path;
        if (!savedPath) return;
        try {
          const diskContent = await invoke<string>("read_file_content", {
            path: savedPath,
          });
          this.tabsManager?.syncExternalFileSaved(savedPath, diskContent);
          if (
            this.currentFilePath &&
            this.currentFilePath.replace(/\\/g, "/").toLowerCase() ===
              savedPath.replace(/\\/g, "/").toLowerCase() &&
            !this.isModified
          ) {
            this.savedContent = diskContent;
          }
        } catch {
          // ignore
        }
      }
    ).catch(() => {});

    // 监听来自 Rust WorkspaceWatcher 的工作区与当前文件外部磁盘变动事件
    listen<{ paths: string[]; kind: string }>("workspace-fs-changed", async (event) => {
      if (this.currentWorkspaceRoot) {
        this.loadWorkspace(this.currentWorkspaceRoot, true);
      }
      if (this.currentFilePath && event.payload?.paths) {
        const normActive = this.currentFilePath.replace(/\\/g, "/").toLowerCase();
        const isCurrentModifiedExternally = event.payload.paths.some(
          (p) => p.replace(/\\/g, "/").toLowerCase() === normActive
        );
        if (isCurrentModifiedExternally && event.payload.kind === "modify") {
          try {
            const diskContent = await invoke<string>("read_file_content", {
              path: this.currentFilePath,
            });
            const currentDoc = this.editorView?.state.doc.toString() || "";
            if (diskContent !== currentDoc) {
              if (!this.isModified && this.editorView) {
                this.savedContent = diskContent;
                resetEditorDocument(this.editorView, diskContent);
                this.tabsManager?.updateActiveTabSavedMeta(
                  this.currentFilePath,
                  this.currentFilePath.split(/[\\/]/).pop() || "未命名.md",
                  diskContent
                );
                showToast("外部文件已更新，内容已自动同步", "info");
              } else {
                showToast("注意：当前文档在外部被修改，保存时将覆盖外部改动", "info");
              }
            }
          } catch {
            // ignore
          }
        }
      }
    }).catch(() => {});

    document.getElementById("footer-toggle-sidebar")?.addEventListener("click", () => {
      document.body.classList.toggle("pin-outline");
    });

    const toggleSourceBtn = document.getElementById("footer-toggle-source");
    const toggleSourceMode = () => {
      const isSource = document.body.classList.toggle("source-mode");
      if (toggleSourceBtn) {
        toggleSourceBtn.classList.toggle("active-mode", isSource);
        const labelSpan = toggleSourceBtn.querySelector(".footer-btn-label");
        if (labelSpan) {
          labelSpan.textContent = isSource ? "实时预览" : "源码模式";
        } else {
          toggleSourceBtn.innerHTML = isSource ? "&lt;/&gt; 实时预览" : "&lt;/&gt; 源码模式";
        }
      }
      const activeView = this.tabsManager?.getFocusedView() || this.editorView;
      if (activeView) {
        activeView.dispatch({
          effects: forceRefreshEffect.of(true),
        });
        activeView.focus();
      }
    };
    toggleSourceBtn?.addEventListener("click", toggleSourceMode);

    const typewriterBtn = document.getElementById("footer-toggle-typewriter");
    const focusBtn = document.getElementById("footer-toggle-focus");

    const syncModeButtons = () => {
      const targetView = this.tabsManager?.getFocusedView() || this.editorView;
      if (targetView) {
        const isTW = isTypewriterModeActive(targetView);
        const isFC = isFocusModeActive(targetView);
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
      const targetView = this.tabsManager?.getFocusedView() || this.editorView;
      if (targetView) {
        toggleTypewriterMode(targetView);
        syncModeButtons();
        targetView.focus();
      }
    };

    const toggleFC = () => {
      const targetView = this.tabsManager?.getFocusedView() || this.editorView;
      if (targetView) {
        toggleFocusMode(targetView);
        syncModeButtons();
        targetView.focus();
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
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        this.openKnowledgeGraph();
      } else if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        this.openTimeMachine();
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
        const targetView = this.tabsManager?.getFocusedView() || this.editorView;
        if (targetView && targetView.hasFocus) {
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
        if (targetView) {
          e.preventDefault();
          undo(targetView);
        }
      } else if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
      ) {
        const targetView = this.tabsManager?.getFocusedView() || this.editorView;
        if (targetView && targetView.hasFocus) {
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
        if (targetView) {
          e.preventDefault();
          redo(targetView);
        }
      }
    });

    initMenus(this.editorView, {
      getActiveView: () => this.tabsManager?.getFocusedView() || this.editorView!,
      onNewFile: () => this.newFile(),
      onNewWindow: () => this.createNewWindow(),
      onOpenFile: () => this.promptOpenFile(),
      onOpenFileByPath: (filePath) => this.loadFile(filePath),
      onOpenFolder: () => this.openWorkspaceFolder(),
      onSaveFile: () => this.saveFile(),
      onSaveFileAs: () => this.saveFileAs(),
      onOpenTimeMachine: () => this.openTimeMachine(),
      onOpenKnowledgeGraph: () => this.openKnowledgeGraph(),
      onCopyWeChatHtml: () => this.handleCopyWeChatHtml(),
      onExportWordDoc: () => this.handleExportWordDoc(),
      onExportSharePoster: () => this.handleExportSharePoster(),
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
      const anyDirty =
        this.isModified || (this.tabsManager?.getAllTabs().some((t) => t.isModified) ?? false);
      if (anyDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    // 全文搜索：支持输入防抖实时检索、回车立即检索及大小写敏感切换
    const searchInput = document.getElementById("workspace-search-input") as HTMLInputElement;
    const searchCaseBtn = document.getElementById("workspace-search-case-btn");

    searchCaseBtn?.addEventListener("click", () => {
      this.searchCaseSensitive = !this.searchCaseSensitive;
      searchCaseBtn.classList.toggle("active", this.searchCaseSensitive);
      if (searchInput && searchInput.value.trim()) {
        this.performSearch(searchInput.value.trim());
      }
    });

    searchInput?.addEventListener("input", () => {
      clearTimeout(this.searchDebounceTimer);
      const val = searchInput.value.trim();
      if (!val) {
        const resultsContainer = document.getElementById("workspace-search-results");
        const metaEl = document.getElementById("workspace-search-meta");
        if (resultsContainer) resultsContainer.innerHTML = "";
        if (metaEl) metaEl.classList.add("hidden");
        return;
      }
      this.searchDebounceTimer = setTimeout(() => {
        this.performSearch(val);
      }, 220);
    });

    searchInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        clearTimeout(this.searchDebounceTimer);
        this.performSearch(searchInput.value.trim());
      }
    });

    const isNewWin = await invoke<boolean>("is_blank_new_window").catch(() => false);
    const cliFile = await invoke<string | null>("get_cli_open_file").catch(() => null);

    const urlParams = new URLSearchParams(window.location.search);
    const urlTransfer = urlParams.get("transfer");
    const urlOpen = urlParams.get("open");
    const urlNew = urlParams.get("new");

    if (urlTransfer) {
      const transferKey = `quilla_window_transfer_${decodeURIComponent(urlTransfer)}`;
      const rawTransfer = localStorage.getItem(transferKey);
      localStorage.removeItem(transferKey);
      if (rawTransfer) {
        try {
          const payload = JSON.parse(rawTransfer);
          const active = this.tabsManager?.getActiveTab();
          if (active && this.editorView) {
            active.filePath = payload.filePath || null;
            active.title = payload.title || "未命名.md";
            active.savedContent = payload.savedContent ?? "";
            active.isModified = Boolean(payload.isModified);
            active.foldSnapshot = payload.foldSnapshot;
            restoreFoldState(active.foldSnapshot);
            active.editorState = createEditorStateForView(
              this.editorView,
              payload.content ?? ""
            );
            this.editorView.setState(active.editorState);
            this.tabsManager?.renderTabs();
            this.syncFromActiveTab(active);
          }
        } catch (e) {
          console.warn("解析跨窗口标签迁移数据失败:", e);
        }
      }
    } else if (cliFile || urlOpen) {
      const target = cliFile || decodeURIComponent(urlOpen!);
      await this.loadFile(target);
    } else if (isNewWin || urlNew === "1") {
      const active = this.tabsManager?.getActiveTab();
      if (active && this.editorView) {
        active.filePath = null;
        active.title = "未命名.md";
        active.savedContent = "";
        active.isModified = false;
        active.editorState = createEditorStateForView(this.editorView, "");
        this.editorView.setState(active.editorState);
        this.tabsManager?.renderTabs();
        this.syncFromActiveTab(active);
      } else {
        await this.newFile();
      }
    } else {
      const lastWorkspace = localStorage.getItem("typora_last_workspace");
      if (lastWorkspace) {
        await this.loadWorkspace(lastWorkspace).catch(() => {
          this.closeWorkspace();
        });
      } else {
        this.closeWorkspace();
      }

      // 自动恢复上次打开的文档，若不存在或已被删除则优雅降级展示欢迎演示文档
      const lastFile = localStorage.getItem("typora_last_file");
      if (lastFile) {
        const loaded = await this.loadFile(lastFile, true);
        if (!loaded) {
          localStorage.removeItem("typora_last_file");
          setActiveDocumentPath(null);
          updateWindowTitle("未命名.md", false);
        }
      } else {
        setActiveDocumentPath(null);
        updateWindowTitle("未命名.md", false);
      }
    }

    // 刷新侧边栏标签云
    this.refreshSidebarTags();

    await checkAndPromptRecovery(async (snapshot) => {
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
      if (this.tabsManager) {
        const active = this.tabsManager.getActiveTab();
        if (active && this.editorView) {
          active.filePath = snapshot.filePath;
          active.title =
            snapshot.title ||
            (snapshot.filePath ? snapshot.filePath.split(/[\\/]/).pop()! : "未命名.md");
          active.savedContent = this.savedContent;
          active.editorState = this.editorView.state;
          active.isModified = true;
          this.tabsManager.renderTabs();
        }
      }
      const treeContainer = document.getElementById("file-library-tree");
      syncActiveTreeItem(treeContainer, snapshot.filePath);
      this.handleContentChange(snapshot.content);
      showToast("已恢复未保存的文档草稿", "success");
    });
  }

  private refreshSidebarTags() {
    const tagsCloudEl = document.getElementById("workspace-tags-cloud");
    const docText = this.editorView?.state.doc.toString() || "";
    renderSidebarTagsCloud(tagsCloudEl, docText, (tag) => {
      const searchInput = document.getElementById(
        "workspace-search-input"
      ) as HTMLInputElement | null;
      if (searchInput) {
        searchInput.value = `#${tag}`;
        this.performSearch(`#${tag}`);
      }
    });
  }

  private openKnowledgeGraph() {
    const activeTab = this.tabsManager?.getActiveTab();
    const activeTitle =
      activeTab?.title ||
      (this.currentFilePath ? this.currentFilePath.split(/[\\/]/).pop()! : "未命名.md");
    openKnowledgeGraphModal({
      view: this.tabsManager?.getFocusedView() || this.editorView,
      activeFilePath: this.currentFilePath,
      activeTitle,
      hasWorkspace: Boolean(this.currentWorkspaceRoot),
      onOpenNote: async (pathOrName, exists) => {
        if (exists) {
          await this.loadFile(pathOrName);
        } else if (this.currentWorkspaceRoot) {
          const cleanName = pathOrName.replace(/[\\/:*?"<>|]/g, "_").trim();
          const fileName = cleanName.toLowerCase().endsWith(".md")
            ? cleanName
            : `${cleanName}.md`;
          const sep = this.currentWorkspaceRoot.includes("\\") ? "\\" : "/";
          const fullPath = `${this.currentWorkspaceRoot.replace(/[\\/]+$/, "")}${sep}${fileName}`;
          try {
            await invoke("save_file_content", {
              path: fullPath,
              content: `# ${cleanName.replace(/\.md$/i, "")}\n\n`,
            });
            await this.loadWorkspace(this.currentWorkspaceRoot, true);
            await this.loadFile(fullPath);
            showToast(`已创建并打开双链节点：${fileName}`, "success");
          } catch (e) {
            showToast(`创建节点失败: ${e}`, "error");
          }
        } else {
          showToast(`节点「${pathOrName}」尚未创建本地文件（请先打开工作区文件夹）`, "info");
        }
      },
    });
  }

  private openTimeMachine() {
    const focusedView = this.tabsManager?.getFocusedView() || this.editorView;
    const focusedTab = this.tabsManager?.getFocusedTab();
    if (!focusedView) return;

    const filePath = focusedTab ? focusedTab.filePath : this.currentFilePath;
    const docTitle =
      focusedTab?.title ||
      (filePath ? filePath.split(/[\\/]/).pop()! : "未命名.md");

    openTimeMachineModal({
      view: focusedView,
      filePath,
      docTitle,
      onRestored: (newContent) => {
        if (focusedView === this.editorView) {
          this.handleContentChange(newContent);
        }
      },
    });
  }

  private async handleCopyWeChatHtml() {
    const targetView = this.tabsManager?.getFocusedView() || this.editorView;
    if (!targetView) return;
    const docText = targetView.state.doc.toString();
    const title = this.currentFilePath
      ? this.currentFilePath.split(/[\\/]/).pop()!.replace(/\.(md|markdown|txt)$/i, "")
      : "羽墨笔记";
    const bodyHtml = await this.renderMarkdownToHtmlBody(docText);
    await copyForWeChatOrZhihu(bodyHtml, title);
  }

  private async handleExportWordDoc() {
    const targetView = this.tabsManager?.getFocusedView() || this.editorView;
    if (!targetView) return;
    const docText = targetView.state.doc.toString();
    const title = this.currentFilePath
      ? this.currentFilePath.split(/[\\/]/).pop()!.replace(/\.(md|markdown|txt)$/i, "")
      : "document-export";
    const bodyHtml = await this.renderMarkdownToHtmlBody(docText);
    await exportWordDocument(bodyHtml, title);
  }

  private async handleExportSharePoster() {
    const targetView = this.tabsManager?.getFocusedView() || this.editorView;
    if (!targetView) return;
    const docText = targetView.state.doc.toString();
    const title = this.currentFilePath
      ? this.currentFilePath.split(/[\\/]/).pop()!.replace(/\.(md|markdown|txt)$/i, "")
      : "羽墨分享卡片";
    const bodyHtml = await this.renderMarkdownToHtmlBody(docText);
    const words = countMixedWords(docText);
    openSharePosterModal({
      bodyHtml,
      title,
      wordCount: words,
      charCount: docText.length,
    });
  }

  /**
   * 当通过多标签栏切换当前激活标签时，完整同步 App 状态、标题栏、文件树高亮、大纲、字数与反向链接
   */
  private syncFromActiveTab(tab: DocumentTab) {
    this.currentFilePath = tab.filePath;
    this.savedContent = tab.savedContent;
    this.isModified = tab.isModified;
    clearImageCache();
    setActiveDocumentPath(tab.filePath);
    if (tab.filePath) {
      localStorage.setItem("typora_last_file", tab.filePath);
    }

    updateWindowTitle(tab.title, tab.isModified);
    const saveStatus = document.getElementById("footer-save-status");
    if (saveStatus) {
      saveStatus.textContent = tab.isModified ? "● 未保存" : "已保存";
      saveStatus.classList.toggle("is-dirty", tab.isModified);
    }

    const treeContainer = document.getElementById("file-library-tree");
    syncActiveTreeItem(treeContainer, tab.filePath);

    if (this.editorView) {
      const doc = this.editorView.state.doc;
      const text = doc.toString();
      this.updateStats(countMixedWords(text), text.length);
      this.updateOutline(extractOutlineHeadings(doc, this.editorView.state));
      this.editorView.focus();
    }

    this.findReplaceCtrl?.notifyDocChanged();
    this.backlinksCtrl?.refresh();
    this.refreshSidebarTags();
  }

  private async refreshWorkspaceMarkdownIndex(): Promise<
    Array<{ path: string; name: string; stem: string }>
  > {
    if (!this.currentWorkspaceRoot) {
      this.workspaceFileCache = [];
      return [];
    }
    try {
      const res = await invoke<any[]>("list_workspace_files", {
        root: this.currentWorkspaceRoot,
      });
      const list: Array<{ path: string; name: string; stem: string }> = [];
      const traverse = (items: any[]) => {
        for (const item of items) {
          if (!item.is_dir && /\.(md|markdown|txt)$/i.test(item.name)) {
            list.push({
              path: item.path,
              name: item.name,
              stem: item.name.replace(/\.(md|markdown|txt)$/i, ""),
            });
          }
          if (item.children) traverse(item.children);
        }
      };
      traverse(res);
      this.workspaceFileCache = list;
      return list;
    } catch {
      return [];
    }
  }

  private setupAutoSaveTimer() {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    const prefs = getPreferences();
    if (prefs.autoSaveMode === "interval") {
      const ms = Math.max(5, prefs.autoSaveIntervalSec || 30) * 1000;
      this.autoSaveTimer = setInterval(() => {
        if (this.isModified && this.currentFilePath) {
          this.saveFile(true);
        }
      }, ms);
    }
  }

  private async createNewWindow(filePath?: string | null, transferId?: string | null) {
    try {
      await invoke("create_new_window", {
        filePath: filePath || null,
        transferId: transferId || null,
      });
    } catch (err) {
      console.error("新建窗口失败:", err);
      showToast(`新建窗口失败: ${err}`, "error");
    }
  }

  private async openTabInNewWindow(tab: DocumentTab) {
    this.tabsManager?.snapshotActiveTabState();
    const isActive = this.tabsManager?.getActiveTab()?.id === tab.id;
    const currentContent =
      isActive && this.editorView
        ? this.editorView.state.doc.toString()
        : tab.editorState.doc.toString();

    let savedContent = tab.savedContent;
    let isModified = tab.isModified;

    // 若该标签已关联磁盘文件且存在未保存改动，先自动原子落盘，确保文件状态与新窗口完全一致
    if (tab.filePath && isModified) {
      try {
        await invoke("save_file_content", {
          path: tab.filePath,
          content: currentContent,
        });
        savedContent = currentContent;
        isModified = false;
        this.tabsManager?.updateTabSavedMetaById(
          tab.id,
          tab.filePath,
          tab.title,
          currentContent
        );
      } catch (e) {
        console.warn("独立窗口打开前自动保存失败，将直接迁移内存草稿:", e);
      }
    }

    const transferId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const transferKey = `quilla_window_transfer_${transferId}`;
    try {
      localStorage.setItem(
        transferKey,
        JSON.stringify({
          filePath: tab.filePath,
          title: tab.title,
          content: currentContent,
          savedContent,
          isModified,
          foldSnapshot: tab.foldSnapshot,
        })
      );
    } catch {}

    await this.createNewWindow(tab.filePath, transferId);
    this.tabsManager?.detachTabAfterTransfer(tab.id);
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
        if (tab === "search") {
          this.refreshSidebarTags();
          const searchInput = document.getElementById("workspace-search-input") as HTMLInputElement;
          searchInput?.focus();
        }
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
    document.getElementById("sidebar-action-sort")?.addEventListener("click", () => {
      const nextSort = toggleTreeSortMode();
      this.refreshWorkspace();
      showToast(
        nextSort === "modified" ? "文件树已按最近修改时间排序" : "文件树已按名称 A-Z 排序",
        "info"
      );
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

    document.getElementById("outline-toggle-all-btn")?.addEventListener("click", () => {
      const outlineContainer = document.getElementById("outline-content");
      toggleAllOutlineFold(outlineContainer, this.currentHeadings);
    });
  }

  private async handleWindowClose() {
    if (this.isClosingConfirmationOpen) return;
    this.isClosingConfirmationOpen = true;
    try {
      this.tabsManager?.snapshotActiveTabState();
      const allTabs = this.tabsManager?.getAllTabs() || [];
      for (const tab of allTabs) {
        if (tab.isModified) {
          this.tabsManager?.activateTab(tab.id);
          const choice = await this.confirmDiscardOrSave();
          if (choice === "cancel") return;
        }
      }
      await invoke("window_close");
    } catch (e) {
      console.error("关闭窗口失败:", e);
    } finally {
      this.isClosingConfirmationOpen = false;
    }
  }

  private async confirmDiscardOrSave(): Promise<"save" | "discard" | "cancel"> {
    if (!this.isModified) {
      return "discard";
    }

    const activeTab = this.tabsManager?.getActiveTab();
    const fileName = this.currentFilePath
      ? this.currentFilePath.split(/[\\/]/).pop()!
      : activeTab?.title || "未命名.md";

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

  public async saveFile(silent: boolean = false): Promise<boolean> {
    // 若用户当前焦点位于分屏右侧副面板且副面板打开的是另一篇已命名文档，优先保存副面板对应标签
    if (
      !silent &&
      this.tabsManager?.isSecondaryPaneFocused() &&
      this.tabsManager.getSecondaryTab() &&
      this.tabsManager.getSecondaryTab()?.id !== this.tabsManager.getActiveTab()?.id
    ) {
      const secTab = this.tabsManager.getSecondaryTab()!;
      const secView = this.tabsManager.getSecondaryView();
      if (secTab.filePath && secView) {
        const secContent = secView.state.doc.toString();
        try {
          await invoke("save_file_content", {
            path: secTab.filePath,
            content: secContent,
          });
          this.tabsManager.updateTabSavedMetaById(
            secTab.id,
            secTab.filePath,
            secTab.title,
            secContent
          );
          clearRecoverySnapshot(secTab.filePath);
          showToast(`已保存右侧分屏文档：${secTab.title}`, "success");
          return true;
        } catch (err) {
          showToast(`保存分屏文件失败: ${err}`, "error");
          return false;
        }
      }
    }

    if (!this.currentFilePath) {
      if (silent) return false;
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
      localStorage.setItem("typora_last_file", this.currentFilePath);
      clearRecoverySnapshot(this.currentFilePath);
      const fileName = this.currentFilePath.split(/[\\/]/).pop() || "未命名.md";
      this.tabsManager?.updateActiveTabSavedMeta(this.currentFilePath, fileName, content);
      updateWindowTitle(fileName, false);
      if (saveStatus) {
        saveStatus.textContent = silent ? "已自动保存" : "已保存";
        saveStatus.classList.remove("is-dirty");
      }
      quillaPluginRegistry.notifyDocumentSaved(this.currentFilePath, content);
      this.backlinksCtrl?.refresh();
      this.refreshSidebarTags();
      return true;
    } catch (err) {
      if (!silent) {
        showToast(`保存文件失败: ${err}`, "error");
      }
      if (saveStatus) saveStatus.textContent = "保存失败";
      return false;
    }
  }

  public async saveFileAs(): Promise<boolean> {
    const activeTab = this.tabsManager?.getActiveTab();
    const defaultName = this.currentFilePath
      ? this.currentFilePath.split(/[\\/]/).pop()!
      : activeTab?.title || "未命名.md";

    try {
      const selectedPath: string | null = await invoke("select_save_file_path", {
        defaultName,
      });
      if (!selectedPath || !selectedPath.trim()) {
        return false;
      }
      const targetPath = selectedPath.trim();
      let content = this.editorView ? this.editorView.state.doc.toString() : this.savedContent;

      // 若原先是未保存文档且粘贴过临时目录图片 (quilla-unsaved)，自动迁移至新文档配置的 assets 目录
      if (!this.currentFilePath && content.includes("quilla-unsaved")) {
        const tempImgRegex = /(!\[[^\]]*\]\()([^)\n]*quilla-unsaved[^)\n]*)(\))/g;
        const matches = Array.from(content.matchAll(tempImgRegex));
        const folderMode = getPreferences().imageFolderMode;
        for (const m of matches) {
          const oldTempPath = m[2];
          try {
            const newRelPath = await invoke<string>("copy_image_to_assets", {
              docPath: targetPath,
              sourcePath: oldTempPath,
              folderMode,
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
      localStorage.setItem("typora_last_file", targetPath);
      clearRecoverySnapshot(oldPath);
      clearRecoverySnapshot(targetPath);

      const fileName = targetPath.split(/[\\/]/).pop() || "未命名.md";
      this.tabsManager?.updateActiveTabSavedMeta(targetPath, fileName, content);
      updateWindowTitle(fileName, false);

      const saveStatus = document.getElementById("footer-save-status");
      if (saveStatus) {
        saveStatus.textContent = "已保存";
        saveStatus.classList.remove("is-dirty");
      }

      if (this.editorView) {
        this.editorView.dispatch({
          effects: forceRefreshEffect.of(true),
        });
      }

      if (
        this.currentWorkspaceRoot &&
        targetPath
          .replace(/\\/g, "/")
          .toLowerCase()
          .startsWith(this.currentWorkspaceRoot.replace(/\\/g, "/").toLowerCase())
      ) {
        await this.loadWorkspace(this.currentWorkspaceRoot, true);
      }
      const treeContainer = document.getElementById("file-library-tree");
      syncActiveTreeItem(treeContainer, targetPath);
      this.backlinksCtrl?.refresh();
      this.refreshSidebarTags();

      showToast(`已保存至 ${fileName}`, "success");
      return true;
    } catch (err) {
      showToast(`另存为失败: ${err}`, "error");
      return false;
    }
  }

  private async newFile() {
    if (this.tabsManager) {
      const tab = this.tabsManager.createNewBlankTab("");
      this.syncFromActiveTab(tab);
      return;
    }

    const choice = await this.confirmDiscardOrSave();
    if (choice === "cancel") return;

    this.currentFilePath = null;
    localStorage.removeItem("typora_last_file");
    clearImageCache();
    setActiveDocumentPath(null);
    const initialText = "";
    this.savedContent = initialText;
    this.isModified = false;
    updateWindowTitle("未命名.md", false);
    const saveStatus = document.getElementById("footer-save-status");
    if (saveStatus) {
      saveStatus.textContent = "已保存";
      saveStatus.classList.remove("is-dirty");
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
      this.loadWorkspace(this.currentWorkspaceRoot, true);
    }
  }

  private closeWorkspace() {
    this.currentWorkspaceRoot = null;
    this.workspaceFileCache = [];
    localStorage.removeItem("typora_last_workspace");
    document.body.classList.remove("has-workspace");
    invoke("close_workspace_watcher").catch(() => {});

    const emptyState = document.getElementById("sidebar-empty-state");
    const wsContainer = document.getElementById("sidebar-workspace-container");
    if (emptyState) emptyState.style.display = "flex";
    if (wsContainer) wsContainer.style.display = "none";

    const treeContainer = document.getElementById("file-library-tree");
    if (treeContainer) treeContainer.innerHTML = "";
    this.backlinksCtrl?.refresh();
    this.refreshSidebarTags();
  }

  private async promptOpenFile() {
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
   * 完整出版级 Markdown -> HTML 递归异步渲染管线：
   * 支持：连续段落合并、引用块内递归块级语法、GitHub 风格 Callout 高亮卡片、[[Wiki Links]] 双链胶囊、
   * ![[文档#标题]] 块级嵌入卡片、#多级标签、标准 W3C 嵌套列表树、Mermaid 矢量 SVG、KaTeX 公式及内联 Base64 图片。
   */
  private async renderMarkdownToHtmlBody(md: string): Promise<string> {
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

    const showLineNumbers = getPreferences().showCodeLineNumbers;
    const isDarkTheme = document.body.classList.contains("theme-night");

    return renderMarkdownDocumentToHtml(md, {
      fullMarkdown: md,
      showLineNumbers,
      isDarkTheme,
      resolveImageSrc: resolveImgSrc,
      highlightCodeBlockToHtml,
      fetchTransclusionContent: fetchTransclusionSectionContent,
    });
  }

  /**
   * 全量无损打印 / 导出 PDF
   */
  private async printDocument() {
    const targetView = this.tabsManager?.getFocusedView() || this.editorView;
    if (!targetView) return;
    const docText = targetView.state.doc.toString();
    const title = this.currentFilePath
      ? this.currentFilePath.split(/[\\/]/).pop()!.replace(/\.(md|markdown|txt)$/i, "")
      : this.tabsManager?.getActiveTab()?.title.replace(/\.(md|markdown|txt)$/i, "") ||
        "document-export";
    const rawBodyHtml = await this.renderMarkdownToHtmlBody(docText);
    const bodyHtml = quillaPluginRegistry.runExportHtmlTransformers(rawBodyHtml, "pdf");
    const themeMeta = themeLoader.getThemeMeta();

    openPdfExportModal({
      title,
      bodyHtml,
      wordCount: countMixedWords(docText),
      themeCss: themeMeta.css,
      isDark: themeMeta.id === "night",
      onSystemPrintFallback: (compiledBodyHtml, pageCss) => {
        let printStyle = document.getElementById("quilla-print-page-style") as HTMLStyleElement | null;
        if (!printStyle) {
          printStyle = document.createElement("style");
          printStyle.id = "quilla-print-page-style";
          document.head.appendChild(printStyle);
        }
        printStyle.textContent = pageCss;

        let printMount = document.getElementById("quilla-print-mount");
        if (!printMount) {
          printMount = document.createElement("div");
          printMount.id = "quilla-print-mount";
          document.body.appendChild(printMount);
        }
        printMount.innerHTML = compiledBodyHtml;

        const cleanup = () => {
          if (printMount) printMount.innerHTML = "";
          window.removeEventListener("afterprint", cleanup);
        };
        window.addEventListener("afterprint", cleanup);

        setTimeout(() => {
          window.print();
        }, 60);
      },
    });
  }

  private async exportHtml() {
    if (!this.editorView) return;
    const docText = this.editorView.state.doc.toString();
    const title = this.currentFilePath
      ? this.currentFilePath.split(/[\\/]/).pop()!.replace(/\.(md|markdown|txt)$/i, "")
      : "document-export";
    const themeMeta = themeLoader.getThemeMeta();
    const themeCss = themeMeta.css;
    const isNight = themeMeta.id === "night";
    const bodyClass = isNight ? `theme-${themeMeta.id} theme-night` : `theme-${themeMeta.id}`;
    const bodyHtml = await this.renderMarkdownToHtmlBody(docText);

    const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${this.escapeHtml(title)}</title>
  <style>
    ${themeCss}
    body { max-width: 860px; margin: 40px auto; padding: 0 24px; line-height: 1.75; background-color: var(--bg-color, #ffffff); color: var(--text-color, #24292f); }
    table.md-table { border-collapse: collapse; width: 100%; margin: 1.2rem 0; }
    table.md-table th, table.md-table td { border: 1px solid var(--border-color, #dfe2e5); padding: 8px 14px; }
    table.md-table th { background-color: rgba(127, 127, 127, 0.06); font-weight: 600; }
    .exported-code-card { margin: 1.2rem 0; border-radius: 8px; background: rgba(127, 127, 127, 0.06); border: 1px solid var(--border-color, #dfe2e5); overflow: hidden; }
    .exported-code-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 14px; background: rgba(127, 127, 127, 0.08); border-bottom: 1px solid var(--border-color, #dfe2e5); font-family: -apple-system, BlinkMacSystemFont, Consolas, sans-serif; font-size: 12px; color: var(--control-text-color, #57606a); }
    .exported-code-dots { display: inline-flex; align-items: center; gap: 5px; margin-right: 8px; }
    .exported-code-dots i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; }
    .exported-code-dots i.dot-red { background: #ff5f56; }
    .exported-code-dots i.dot-amber { background: #ffbd2e; }
    .exported-code-dots i.dot-green { background: #27c93f; }
    .exported-code-lang { font-weight: 700; letter-spacing: 0.05em; color: var(--primary-color, #0969da); background: rgba(9, 105, 218, 0.1); padding: 1px 7px; border-radius: 999px; font-size: 11px; }
    .exported-code-meta { margin-left: auto; font-size: 11px; opacity: 0.72; }
    pre { margin: 0; padding: 12px 16px; background: transparent; border: none; overflow-x: auto; font-family: Consolas, "JetBrains Mono", monospace; font-size: 13px; line-height: 1.65; }
    pre > code { background: transparent !important; border: none !important; padding: 0 !important; font-size: inherit !important; }
    :not(pre) > code { font-family: Consolas, "JetBrains Mono", monospace; font-size: 87%; background-color: rgba(127, 127, 127, 0.1); padding: 2px 5px; border-radius: 4px; border: 1px solid var(--border-color, #dfe2e5); }
    .exported-code-line[data-code-line]::before {
      content: attr(data-code-line);
      display: inline-block;
      width: 28px;
      margin-right: 14px;
      text-align: right;
      color: var(--control-text-color, #8c959f);
      opacity: 0.6;
      user-select: none;
    }
    .cm-syn-keyword { color: #cf222e; font-weight: 600; }
    .cm-syn-string { color: #0a3069; }
    .cm-syn-comment { color: #6e7781; font-style: italic; }
    .cm-syn-number { color: #0550ae; }
    .cm-syn-type { color: #953800; }
    .cm-syn-function { color: #8250df; }
    .cm-syn-attr { color: #116329; }
    body.theme-night .cm-syn-keyword { color: #c678dd; }
    body.theme-night .cm-syn-string { color: #98c379; }
    body.theme-night .cm-syn-comment { color: #7f848e; }
    body.theme-night .cm-syn-number { color: #d19a66; }
    body.theme-night .cm-syn-type { color: #e5c07b; }
    body.theme-night .cm-syn-function { color: #61afef; }
    body.theme-night .cm-syn-attr { color: #56b6c2; }
    blockquote { border-left: 3.5px solid var(--quote-border-color, #d0d7de); margin: 1rem 0; padding: 4px 16px; color: var(--control-text-color, #57606a); background: rgba(127, 127, 127, 0.03); }
    .cm-callout-export { border: 1px solid rgba(9, 105, 218, 0.22); border-left: 4px solid #0969da; border-radius: 6px; padding: 10px 16px; margin: 1rem 0; background: rgba(9, 105, 218, 0.06); }
    .cm-callout-export.cm-callout-tip { border-color: rgba(26, 127, 55, 0.22); border-left-color: #1a7f37; background: rgba(26, 127, 55, 0.06); }
    .cm-callout-export.cm-callout-important { border-color: rgba(130, 80, 223, 0.22); border-left-color: #8250df; background: rgba(130, 80, 223, 0.06); }
    .cm-callout-export.cm-callout-warning { border-color: rgba(154, 103, 0, 0.22); border-left-color: #9a6700; background: rgba(154, 103, 0, 0.07); }
    .cm-callout-export.cm-callout-caution { border-color: rgba(207, 34, 46, 0.22); border-left-color: #cf222e; background: rgba(207, 34, 46, 0.07); }
    .cm-callout-header-widget { font-weight: 700; margin-bottom: 4px; color: #0969da; }
    .cm-callout-header-tip { color: #1a7f37; }
    .cm-callout-header-important { color: #8250df; }
    .cm-callout-header-warning { color: #9a6700; }
    .cm-callout-header-caution { color: #cf222e; }
    .cm-wikilink, .cm-hashtag { color: var(--primary-color, #0969da); background: rgba(9, 105, 218, 0.08); padding: 1px 7px; border-radius: 10px; font-weight: 500; font-size: 0.92em; }
    li.task-list-item { list-style: none; }
    .md-mermaid-card { text-align: center; margin: 1.4rem 0; }
    .cm-footnote-def { margin: 6px 0; padding-left: 12px; border-left: 2px solid var(--border-color, #d0d7de); font-size: 0.92em; color: var(--control-text-color, #57606a); }
    .fn-backref { text-decoration: none; margin-left: 4px; color: var(--primary-color, #0969da); }
    s, del { text-decoration: line-through; opacity: 0.75; }
    .katex-mathml { display: none; }
  </style>
</head>
<body id="write" class="${bodyClass}">
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

  private handleContentChange(content: string, deltas?: TextDeltaPayload[]) {
    const isDirty = content !== this.savedContent;
    this.isModified = isDirty;
    const activeTab = this.tabsManager?.getActiveTab();
    const fileName = this.currentFilePath
      ? this.currentFilePath.split(/[\\/]/).pop()!
      : activeTab?.title || "未命名.md";
    updateWindowTitle(fileName, isDirty);

    const saveStatus = document.getElementById("footer-save-status");
    if (saveStatus) {
      saveStatus.textContent = isDirty ? "● 未保存" : "已保存";
      saveStatus.classList.toggle("is-dirty", isDirty);
    }

    this.tabsManager?.notifyPrimaryDocChanged(content, isDirty);
    this.findReplaceCtrl?.notifyDocChanged();

    if (isDirty) {
      saveRecoverySnapshot(this.currentFilePath, content, fileName, deltas);
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

  private async loadWorkspace(folderPath: string, silent: boolean = false) {
    try {
      const files: FileItem[] = await invoke("list_workspace_files", { root: folderPath });
      this.currentWorkspaceRoot = folderPath;
      localStorage.setItem("typora_last_workspace", folderPath);
      document.body.classList.add("has-workspace");

      // 更新扁平工作区文档索引缓存供 [[Wiki Links]] 极速补全
      const flatList: Array<{ path: string; name: string; stem: string }> = [];
      const walk = (items: FileItem[]) => {
        for (const it of items) {
          if (!it.is_dir && /\.(md|markdown|txt)$/i.test(it.name)) {
            flatList.push({
              path: it.path,
              name: it.name,
              stem: it.name.replace(/\.(md|markdown|txt)$/i, ""),
            });
          }
          if (it.children) walk(it.children);
        }
      };
      walk(files);
      this.workspaceFileCache = flatList;

      const folderName = folderPath.split(/[\\/]/).pop() || folderPath;
      const nameEl = document.getElementById("workspace-folder-name");
      if (nameEl) {
        nameEl.textContent = folderName;
        nameEl.title = folderPath;
      }

      const emptyState = document.getElementById("sidebar-empty-state");
      const wsContainer = document.getElementById("sidebar-workspace-container");
      if (emptyState) emptyState.style.display = "none";
      if (wsContainer) wsContainer.style.display = "block";

      const treeContainer = document.getElementById("file-library-tree")!;
      // 若当前正在进行内联重命名或新建输入，静默刷新暂缓以防打断用户输入
      if (silent && treeContainer.querySelector(".tree-inline-input")) {
        return;
      }

      renderFileTree(treeContainer, files, {
        workspaceRoot: folderPath,
        activeFilePath: this.currentFilePath,
        onFileSelect: (filePath) => this.loadFile(filePath),
        onRefresh: () => this.loadWorkspace(folderPath, true),
        onFileRenamed: (oldPath, newPath) => this.handleFileRenamed(oldPath, newPath),
        onFileDeleted: (deletedPath) => this.handleFileDeleted(deletedPath),
      });

      this.backlinksCtrl?.refresh();
      this.refreshSidebarTags();
    } catch (e) {
      console.error("加载工作区失败:", e);
      if (!silent) {
        this.closeWorkspace();
      }
    }
  }

  private handleFileRenamed(oldPath: string, newPath: string) {
    this.tabsManager?.handleFileRenamed(oldPath, newPath);
    if (!this.currentFilePath) return;
    const normCur = this.currentFilePath.replace(/\\/g, "/").toLowerCase();
    const normOld = oldPath.replace(/\\/g, "/").toLowerCase();
    if (normCur === normOld) {
      this.currentFilePath = newPath;
      setActiveDocumentPath(newPath);
      localStorage.setItem("typora_last_file", newPath);
      const fileName = newPath.split(/[\\/]/).pop() || "未命名.md";
      updateWindowTitle(fileName, this.isModified);
    } else if (normCur.startsWith(normOld + "/")) {
      const rest = this.currentFilePath.slice(oldPath.length);
      const updated = newPath + rest;
      this.currentFilePath = updated;
      setActiveDocumentPath(updated);
      localStorage.setItem("typora_last_file", updated);
      const fileName = updated.split(/[\\/]/).pop() || "未命名.md";
      updateWindowTitle(fileName, this.isModified);
    }
    const treeContainer = document.getElementById("file-library-tree");
    syncActiveTreeItem(treeContainer, this.currentFilePath);
    this.backlinksCtrl?.refresh();
  }

  private handleFileDeleted(deletedPath: string) {
    this.tabsManager?.handleFileDeleted(deletedPath);
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
    this.backlinksCtrl?.refresh();
  }

  public async loadFile(filePath: string, silentOnError: boolean = false): Promise<boolean> {
    if (!filePath) return false;
    const normTarget = filePath.replace(/\\/g, "/").toLowerCase();
    const normCurrent = (this.currentFilePath || "").replace(/\\/g, "/").toLowerCase();
    if (normTarget === normCurrent) {
      const treeContainer = document.getElementById("file-library-tree");
      syncActiveTreeItem(treeContainer, filePath);
      return true;
    }

    // 若该文件已在某个标签页中打开，直接激活该标签页，无需重复读取磁盘或打断其他未保存标签
    const existingTab = this.tabsManager
      ?.getAllTabs()
      .find((t) => t.filePath && t.filePath.replace(/\\/g, "/").toLowerCase() === normTarget);
    if (existingTab && this.tabsManager) {
      this.tabsManager.activateTab(existingTab.id);
      return true;
    }

    const seq = ++this.loadSequence;
    try {
      const content: string = await invoke("read_file_content", { path: filePath });
      if (seq !== this.loadSequence) {
        return false;
      }

      const fileName = filePath.split(/[\\/]/).pop() || "未命名.md";
      this.currentFilePath = filePath;
      this.savedContent = content;
      this.isModified = false;
      clearImageCache();
      setActiveDocumentPath(filePath);
      addRecentFile(filePath);
      localStorage.setItem("typora_last_file", filePath);
      saveFallbackLocalHistorySnapshot(filePath, content, "打开文件初始快照");

      if (this.tabsManager) {
        const tab = this.tabsManager.openOrActivateFileTab(filePath, fileName, content, true);
        this.syncFromActiveTab(tab);
      } else {
        updateWindowTitle(fileName, false);
        const saveStatus = document.getElementById("footer-save-status");
        if (saveStatus) {
          saveStatus.textContent = "已保存";
          saveStatus.classList.remove("is-dirty");
        }
        if (this.editorView) {
          resetEditorDocument(this.editorView, content);
        }
        const treeContainer = document.getElementById("file-library-tree");
        syncActiveTreeItem(treeContainer, filePath);
        this.backlinksCtrl?.refresh();
        this.refreshSidebarTags();
      }
      return true;
    } catch (e) {
      if (!silentOnError) {
        console.error("Failed to load file:", e);
        showToast(`无法打开文件: ${e}`, "error");
      }
      return false;
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

  private highlightKeywordHtml(text: string, keyword: string): string {
    if (!keyword) return this.escapeHtml(text);
    const escapedKw = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${escapedKw})`, this.searchCaseSensitive ? "g" : "gi");
    const parts = text.split(re);
    return parts
      .map((part, idx) =>
        idx % 2 === 1
          ? `<mark class="search-keyword-hit">${this.escapeHtml(part)}</mark>`
          : this.escapeHtml(part)
      )
      .join("");
  }

  private async performSearch(keyword: string) {
    const resultsContainer = document.getElementById("workspace-search-results");
    const metaEl = document.getElementById("workspace-search-meta");
    if (!resultsContainer) return;

    if (!keyword) {
      resultsContainer.innerHTML = "";
      metaEl?.classList.add("hidden");
      return;
    }

    resultsContainer.innerHTML = `<div class="search-status-hint">搜索中...</div>`;
    metaEl?.classList.add("hidden");

    try {
      const matches: Array<{ file: string; line: number; text: string }> = await invoke(
        "search_workspace_content",
        { keyword, caseSensitive: this.searchCaseSensitive }
      );
      resultsContainer.innerHTML = "";
      if (matches.length === 0) {
        // 若未打开工作区但在当前文档中有匹配，展示当前文档内匹配行
        const localDoc = this.editorView?.state.doc;
        const localHits: Array<{ line: number; text: string }> = [];
        if (localDoc) {
          const kwCmp = this.searchCaseSensitive ? keyword : keyword.toLowerCase();
          for (let i = 1; i <= localDoc.lines; i++) {
            const lText = localDoc.line(i).text;
            const hay = this.searchCaseSensitive ? lText : lText.toLowerCase();
            if (hay.includes(kwCmp)) {
              localHits.push({ line: i, text: lText.trim() });
            }
          }
        }
        if (localHits.length === 0) {
          resultsContainer.innerHTML = `<div class="search-status-hint">无匹配结果</div>`;
          return;
        }
        if (metaEl) {
          metaEl.textContent = `当前文档内共 ${localHits.length} 处匹配`;
          metaEl.classList.remove("hidden");
        }
        localHits.forEach((h) => {
          const item = document.createElement("div");
          item.className = "search-result-item";
          item.innerHTML = `
            <div class="search-result-file">当前文档</div>
            <div class="search-result-text"><span class="search-result-line">L${h.line}</span> ${this.highlightKeywordHtml(h.text, keyword)}</div>
          `;
          item.addEventListener("click", () => {
            if (this.editorView) {
              pulseSearchMatch(this.editorView, h.line, keyword);
            }
          });
          resultsContainer.appendChild(item);
        });
        return;
      }

      const fileSet = new Set(matches.map((m) => m.file));
      if (metaEl) {
        metaEl.textContent =
          matches.length >= 500
            ? `已展示前 500 处匹配（分布在 ${fileSet.size} 个文件中）`
            : `共 ${matches.length} 处匹配（${fileSet.size} 个文件）`;
        metaEl.classList.remove("hidden");
      }

      matches.forEach((m) => {
        const item = document.createElement("div");
        item.className = "search-result-item";
        const fileName = m.file.split(/[\\/]/).pop() || m.file;
        item.innerHTML = `
          <div class="search-result-file" title="${this.escapeHtml(m.file)}">${this.escapeHtml(fileName)}</div>
          <div class="search-result-text"><span class="search-result-line">L${m.line}</span> ${this.highlightKeywordHtml(m.text, keyword)}</div>
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
      resultsContainer.innerHTML = `<div class="search-status-hint">请先打开工作区文件夹</div>`;
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
          <div class="menu-item theme-choice ${t.id === cur ? "active" : ""}" data-theme="${t.id}">
            <div class="menu-item-left">
              <span class="m-icon">${t.id === cur ? "✓" : ""}</span>
              <span>${this.escapeHtml(t.label)}</span>
            </div>
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
