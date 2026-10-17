import { ChangeSet, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createEditor,
  createEditorStateForView,
  isTypewriterModeActive,
  toggleTypewriterMode,
  isFocusModeActive,
  toggleFocusMode,
} from "../editor";
import { initFloatingToolbars } from "../editor/extensions/floating-toolbars";
import { initSmartPaste } from "../editor/extensions/smart-paste";

export interface DocumentTab {
  id: string;
  filePath: string | null;
  title: string;
  savedContent: string;
  isModified: boolean;
  editorState: EditorState;
  scrollTop: number;
}

export interface TabsManagerCallbacks {
  getPrimaryView: () => EditorView | null;
  onActiveTabChanged: (tab: DocumentTab) => void;
  onTabCloseConfirm: (tab: DocumentTab) => Promise<"save" | "discard" | "cancel">;
  onNewBlankTabRequest: () => void;
  onOpenFileRequest: (filePath: string) => void;
  onSecondaryDocChanged?: (tab: DocumentTab, content: string) => void;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * 计算两段文本之间的最小公共前后缀增量区间，避免双栏同步时整篇替换导致 Undo 栈与选区丢失
 */
function computeMinimalTextDiff(
  oldText: string,
  newText: string
): { from: number; to: number; insert: string } | null {
  if (oldText === newText) return null;
  const oldLen = oldText.length;
  const newLen = newText.length;
  const minLen = Math.min(oldLen, newLen);

  let prefix = 0;
  while (prefix < minLen && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLen - prefix &&
    suffix < newLen - prefix &&
    oldText.charCodeAt(oldLen - 1 - suffix) === newText.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++;
  }

  return {
    from: prefix,
    to: oldLen - suffix,
    insert: newText.slice(prefix, newLen - suffix),
  };
}

/**
 * 多标签页（Tabs）与左右分屏对比编辑（Split View）控制器
 * - 每个标签独立保存自己的 EditorState（含独立 Undo/Redo 历史栈与选区）和 scrollTop
 * - 支持 Pointer Events 标签拖拽排序、鼠标中键关闭、Ctrl+Tab 循环切换、Ctrl+W 关闭当前标签
 * - 支持一键开启左右分屏（Ctrl+\），右侧副编辑器具备完整的悬浮气泡栏、智能粘贴与焦点感知保存能力
 */
export class TabsManager {
  private tabs: DocumentTab[] = [];
  private activeTabId: string = "";
  private splitActive: boolean = false;
  private secondaryTabId: string = "";
  private syncScrollEnabled: boolean = false;
  private secondaryView: EditorView | null = null;
  private lastFocusedPane: "primary" | "secondary" = "primary";
  private isSyncingDualDoc: boolean = false;
  private isSyncingScroll: boolean = false;
  private callbacks: TabsManagerCallbacks;

  private tabsBarEl: HTMLElement | null = null;
  private tabsListEl: HTMLElement | null = null;
  private splitContainerEl: HTMLElement | null = null;
  private secondaryPaneEl: HTMLElement | null = null;
  private secondaryWriteEl: HTMLElement | null = null;
  private secondarySelectEl: HTMLSelectElement | null = null;
  private splitResizerEl: HTMLElement | null = null;

  constructor(callbacks: TabsManagerCallbacks) {
    this.callbacks = callbacks;
  }

  public init(initialFilePath: string | null, initialTitle: string, initialContent: string) {
    this.tabsBarEl = document.getElementById("doc-tabs-bar");
    this.tabsListEl = document.getElementById("doc-tabs-list");
    this.splitContainerEl = document.getElementById("editor-split-container");
    this.secondaryPaneEl = document.getElementById("write-secondary-pane");
    this.secondaryWriteEl = document.getElementById("write-secondary");
    this.secondarySelectEl = document.getElementById(
      "split-doc-select"
    ) as HTMLSelectElement | null;
    this.splitResizerEl = document.getElementById("split-resizer");

    const primaryView = this.callbacks.getPrimaryView();
    if (!primaryView) return;

    primaryView.dom.addEventListener("focusin", () => {
      this.lastFocusedPane = "primary";
      this.splitContainerEl?.classList.remove("secondary-pane-focused");
    });

    const firstTab: DocumentTab = {
      id: `tab-${Date.now()}-1`,
      filePath: initialFilePath,
      title: initialTitle,
      savedContent: initialContent,
      isModified: false,
      editorState: primaryView.state,
      scrollTop: 0,
    };

    this.tabs = [firstTab];
    this.activeTabId = firstTab.id;
    this.secondaryTabId = firstTab.id;

    this.bindUIEvents();
    this.initSplitResizer();
    this.renderTabs();
  }

  private bindUIEvents() {
    document.getElementById("doc-tab-new-btn")?.addEventListener("click", () => {
      this.callbacks.onNewBlankTabRequest();
    });

    document.getElementById("doc-tab-split-btn")?.addEventListener("click", () => {
      this.toggleSplitView();
    });

    document.getElementById("footer-toggle-split")?.addEventListener("click", () => {
      this.toggleSplitView();
    });

    document.getElementById("split-close-btn")?.addEventListener("click", () => {
      if (this.splitActive) {
        this.toggleSplitView(false);
      }
    });

    const syncScrollBtn = document.getElementById("split-sync-scroll-btn");
    syncScrollBtn?.addEventListener("click", () => {
      this.syncScrollEnabled = !this.syncScrollEnabled;
      syncScrollBtn.classList.toggle("active", this.syncScrollEnabled);
    });

    this.secondarySelectEl?.addEventListener("change", () => {
      const targetId = this.secondarySelectEl?.value || "";
      if (targetId) {
        this.setSecondaryTab(targetId);
      }
    });

    // 绑定主编辑器滚动事件，当开启同步滚动且处于分屏模式时按比例联动副视图
    const primaryView = this.callbacks.getPrimaryView();
    if (primaryView) {
      primaryView.scrollDOM.addEventListener(
        "scroll",
        () => {
          if (
            !this.splitActive ||
            !this.syncScrollEnabled ||
            !this.secondaryView ||
            this.isSyncingScroll
          ) {
            return;
          }
          this.isSyncingScroll = true;
          const pDom = primaryView.scrollDOM;
          const sDom = this.secondaryView.scrollDOM;
          const maxP = Math.max(1, pDom.scrollHeight - pDom.clientHeight);
          const maxS = Math.max(1, sDom.scrollHeight - sDom.clientHeight);
          const ratio = pDom.scrollTop / maxP;
          sDom.scrollTop = ratio * maxS;
          requestAnimationFrame(() => {
            this.isSyncingScroll = false;
          });
        },
        { passive: true }
      );
    }

    // 快捷键：Ctrl+\ 切换分屏，Ctrl+Tab 切换下一标签，Ctrl+W 关闭当前标签
    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        this.toggleSplitView();
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        this.cycleTab(e.shiftKey ? -1 : 1);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w" && !e.shiftKey) {
        if (this.tabs.length > 1) {
          e.preventDefault();
          this.closeTab(this.activeTabId);
        }
      }
    });
  }

  private initSplitResizer() {
    const resizer = this.splitResizerEl;
    const container = this.splitContainerEl;
    if (!resizer || !container) return;

    resizer.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        resizer.setPointerCapture(e.pointerId);
      } catch {}
      resizer.classList.add("resizing");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const onMove = (moveEvt: PointerEvent) => {
        const rect = container.getBoundingClientRect();
        if (rect.width <= 100) return;
        const ratio = ((moveEvt.clientX - rect.left) / rect.width) * 100;
        const clamped = Math.max(25, Math.min(75, ratio));
        container.style.setProperty("--split-left-width", `${clamped.toFixed(1)}%`);
      };

      const onUp = (upEvt: PointerEvent) => {
        try {
          resizer.releasePointerCapture(upEvt.pointerId);
        } catch {}
        resizer.classList.remove("resizing");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onUp);
        resizer.removeEventListener("pointercancel", onUp);
      };

      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
      resizer.addEventListener("pointercancel", onUp);
    });

    resizer.addEventListener("dblclick", () => {
      container.style.setProperty("--split-left-width", "50%");
    });
  }

  public getActiveTab(): DocumentTab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
  }

  public getSecondaryTab(): DocumentTab | undefined {
    return this.tabs.find((t) => t.id === this.secondaryTabId);
  }

  /**
   * 获取当前实际拥有焦点的编辑器视图（支持分屏副视图焦点感知）
   */
  public getFocusedView(): EditorView | null {
    if (
      this.splitActive &&
      this.secondaryView &&
      (this.secondaryView.hasFocus || this.lastFocusedPane === "secondary")
    ) {
      return this.secondaryView;
    }
    return this.callbacks.getPrimaryView();
  }

  /**
   * 获取当前实际拥有焦点的文档标签页（当用户在右侧分屏按 Ctrl+S 时可精准定位副面板所属标签）
   */
  public getFocusedTab(): DocumentTab | undefined {
    if (
      this.splitActive &&
      this.secondaryView &&
      (this.secondaryView.hasFocus || this.lastFocusedPane === "secondary")
    ) {
      return this.getSecondaryTab() || this.getActiveTab();
    }
    return this.getActiveTab();
  }

  public getSecondaryView(): EditorView | null {
    return this.secondaryView;
  }

  public isSecondaryPaneFocused(): boolean {
    return Boolean(
      this.splitActive &&
        this.secondaryView &&
        (this.secondaryView.hasFocus || this.lastFocusedPane === "secondary")
    );
  }

  public getAllTabs(): DocumentTab[] {
    return this.tabs;
  }

  public isSplitViewActive(): boolean {
    return this.splitActive;
  }

  /**
   * 同步保存主编辑器的最新 EditorState 与 scrollTop 到当前活动标签
   */
  public snapshotActiveTabState() {
    const primaryView = this.callbacks.getPrimaryView();
    const activeTab = this.getActiveTab();
    if (!primaryView || !activeTab) return;
    activeTab.editorState = primaryView.state;
    activeTab.scrollTop = primaryView.scrollDOM.scrollTop;
  }

  /**
   * 当主编辑器内容发生变更时，更新当前标签脏状态，并在双栏同文档模式下使用增量 Diff 同步至副编辑器
   */
  public notifyPrimaryDocChanged(content: string, isModified: boolean) {
    const activeTab = this.getActiveTab();
    if (!activeTab) return;
    const prevModified = activeTab.isModified;
    activeTab.isModified = isModified;
    const primaryView = this.callbacks.getPrimaryView();
    if (primaryView) {
      activeTab.editorState = primaryView.state;
    }

    if (prevModified !== isModified) {
      this.renderTabs();
    }

    // 若处于分屏模式且右侧副视图正在展示同一标签，实时做最小增量同步（保护副编辑器 Undo 栈与光标偏移）
    if (
      this.splitActive &&
      this.secondaryView &&
      this.secondaryTabId === activeTab.id &&
      !this.isSyncingDualDoc
    ) {
      const secDoc = this.secondaryView.state.doc.toString();
      const diff = computeMinimalTextDiff(secDoc, content);
      if (diff) {
        this.isSyncingDualDoc = true;
        try {
          const prevScroll = this.secondaryView.scrollDOM.scrollTop;
          const changeDesc = ChangeSet.of(
            [{ from: diff.from, to: diff.to, insert: diff.insert }],
            secDoc.length
          );
          const mappedSel = this.secondaryView.state.selection.map(changeDesc);
          this.secondaryView.dispatch({
            changes: diff,
            selection: mappedSel,
          });
          this.secondaryView.scrollDOM.scrollTop = prevScroll;
        } finally {
          this.isSyncingDualDoc = false;
        }
      }
    }
  }

  /**
   * 打开或激活指定文件路径的标签页（若已打开则直接丝滑切换，保留原有 Undo 栈与滚动位置）
   */
  public openOrActivateFileTab(
    filePath: string,
    title: string,
    content: string,
    replaceCurrentIfCleanUntitled: boolean = true
  ): DocumentTab {
    const primaryView = this.callbacks.getPrimaryView()!;
    this.snapshotActiveTabState();

    const normTarget = filePath.replace(/\\/g, "/").toLowerCase();
    const existing = this.tabs.find(
      (t) => t.filePath && t.filePath.replace(/\\/g, "/").toLowerCase() === normTarget
    );
    if (existing) {
      this.activateTab(existing.id);
      return existing;
    }

    const active = this.getActiveTab();
    // 若当前活动标签是未修改的空白或初始演示未命名标签，直接原位复用该标签
    if (
      replaceCurrentIfCleanUntitled &&
      active &&
      !active.filePath &&
      !active.isModified &&
      this.tabs.length === 1
    ) {
      active.filePath = filePath;
      active.title = title;
      active.savedContent = content;
      active.isModified = false;
      active.scrollTop = 0;
      active.editorState = createEditorStateForView(primaryView, content);
      this.applyTabToPrimaryView(active);
      this.renderTabs();
      return active;
    }

    const newTab: DocumentTab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      filePath,
      title,
      savedContent: content,
      isModified: false,
      editorState: createEditorStateForView(primaryView, content),
      scrollTop: 0,
    };

    this.tabs.push(newTab);
    this.activateTab(newTab.id);
    return newTab;
  }

  /**
   * 新建一个空白未命名文档标签页
   */
  public createNewBlankTab(initialText: string = ""): DocumentTab {
    const primaryView = this.callbacks.getPrimaryView()!;
    this.snapshotActiveTabState();

    const untitledCount = this.tabs.filter((t) => !t.filePath).length;
    const title = untitledCount === 0 ? "未命名.md" : `未命名-${untitledCount + 1}.md`;

    const newTab: DocumentTab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      filePath: null,
      title,
      savedContent: initialText,
      isModified: false,
      editorState: createEditorStateForView(primaryView, initialText),
      scrollTop: 0,
    };

    this.tabs.push(newTab);
    this.activateTab(newTab.id);
    return newTab;
  }

  public activateTab(tabId: string) {
    const target = this.tabs.find((t) => t.id === tabId);
    if (!target) return;

    if (this.activeTabId && this.activeTabId !== tabId) {
      this.snapshotActiveTabState();
    }

    this.activeTabId = target.id;
    this.applyTabToPrimaryView(target);
    this.renderTabs();
    this.callbacks.onActiveTabChanged(target);
  }

  private applyTabToPrimaryView(tab: DocumentTab) {
    const primaryView = this.callbacks.getPrimaryView();
    if (!primaryView) return;

    const wasTW = isTypewriterModeActive(primaryView);
    const wasFC = isFocusModeActive(primaryView);

    primaryView.setState(tab.editorState);

    if (wasTW) toggleTypewriterMode(primaryView, true);
    if (wasFC) toggleFocusMode(primaryView, true);

    requestAnimationFrame(() => {
      primaryView.scrollDOM.scrollTop = tab.scrollTop || 0;
    });
  }

  public cycleTab(direction: 1 | -1) {
    if (this.tabs.length <= 1) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeTabId);
    if (idx === -1) return;
    const nextIdx = (idx + direction + this.tabs.length) % this.tabs.length;
    this.activateTab(this.tabs[nextIdx].id);
  }

  public async closeTab(tabId: string): Promise<boolean> {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return false;
    const tab = this.tabs[idx];

    if (tab.id === this.activeTabId) {
      this.snapshotActiveTabState();
    }

    if (tab.isModified) {
      const choice = await this.callbacks.onTabCloseConfirm(tab);
      if (choice === "cancel") return false;
    }

    if (this.tabs.length === 1) {
      const primaryView = this.callbacks.getPrimaryView()!;
      tab.filePath = null;
      tab.title = "未命名.md";
      tab.savedContent = "";
      tab.isModified = false;
      tab.scrollTop = 0;
      tab.editorState = createEditorStateForView(primaryView, "");
      this.applyTabToPrimaryView(tab);
      this.renderTabs();
      this.callbacks.onActiveTabChanged(tab);
      return true;
    }

    this.tabs.splice(idx, 1);
    if (this.activeTabId === tabId) {
      const nextTab = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activeTabId = nextTab.id;
      this.applyTabToPrimaryView(nextTab);
      this.callbacks.onActiveTabChanged(nextTab);
    }

    if (this.secondaryTabId === tabId) {
      const fallback =
        this.tabs.find((t) => t.id !== this.activeTabId) || this.tabs[0];
      this.setSecondaryTab(fallback.id);
    }

    this.renderTabs();
    return true;
  }

  public updateTabSavedMetaById(
    tabId: string,
    filePath: string | null,
    title: string,
    savedContent: string
  ) {
    const target = this.tabs.find((t) => t.id === tabId);
    if (!target) return;
    target.filePath = filePath;
    target.title = title;
    target.savedContent = savedContent;
    target.isModified = false;
    this.renderTabs();
  }

  public updateActiveTabSavedMeta(filePath: string | null, title: string, savedContent: string) {
    const active = this.getActiveTab();
    if (!active) return;
    this.updateTabSavedMetaById(active.id, filePath, title, savedContent);
  }

  public handleFileRenamed(oldPath: string, newPath: string) {
    const normOld = oldPath.replace(/\\/g, "/").toLowerCase();
    for (const tab of this.tabs) {
      if (!tab.filePath) continue;
      const normTab = tab.filePath.replace(/\\/g, "/").toLowerCase();
      if (normTab === normOld) {
        tab.filePath = newPath;
        tab.title = newPath.split(/[\\/]/).pop() || "未命名.md";
      } else if (normTab.startsWith(normOld + "/")) {
        const rest = tab.filePath.slice(oldPath.length);
        tab.filePath = newPath + rest;
        tab.title = tab.filePath.split(/[\\/]/).pop() || "未命名.md";
      }
    }
    this.renderTabs();
  }

  public handleFileDeleted(deletedPath: string) {
    const normDel = deletedPath.replace(/\\/g, "/").toLowerCase();
    for (const tab of this.tabs) {
      if (!tab.filePath) continue;
      const normTab = tab.filePath.replace(/\\/g, "/").toLowerCase();
      if (normTab === normDel || normTab.startsWith(normDel + "/")) {
        tab.filePath = null;
        tab.isModified = true;
      }
    }
    this.renderTabs();
  }

  /**
   * 开启或关闭左右分屏对比编辑视图 (Split View)
   */
  public toggleSplitView(forceState?: boolean, targetSecondaryTabId?: string) {
    this.splitActive = forceState !== undefined ? forceState : !this.splitActive;

    this.splitContainerEl?.classList.toggle("split-active", this.splitActive);
    this.secondaryPaneEl?.classList.toggle("hidden", !this.splitActive);
    this.splitResizerEl?.classList.toggle("hidden", !this.splitActive);
    document.getElementById("doc-tab-split-btn")?.classList.toggle("active", this.splitActive);
    document.getElementById("footer-toggle-split")?.classList.toggle("active-mode", this.splitActive);

    if (!this.splitActive) {
      this.lastFocusedPane = "primary";
      this.splitContainerEl?.classList.remove("secondary-pane-focused");
    }

    if (this.splitActive) {
      this.snapshotActiveTabState();
      if (targetSecondaryTabId) {
        this.secondaryTabId = targetSecondaryTabId;
      } else if (
        !this.secondaryTabId ||
        !this.tabs.some((t) => t.id === this.secondaryTabId)
      ) {
        const otherTab = this.tabs.find((t) => t.id !== this.activeTabId);
        this.secondaryTabId = otherTab ? otherTab.id : this.activeTabId;
      } else if (this.secondaryTabId === this.activeTabId && this.tabs.length > 1) {
        const otherTab = this.tabs.find((t) => t.id !== this.activeTabId);
        if (otherTab) this.secondaryTabId = otherTab.id;
      }

      this.ensureSecondaryEditor();
      this.setSecondaryTab(this.secondaryTabId);
      this.renderTabs();
    }
  }

  private ensureSecondaryEditor() {
    if (this.secondaryView || !this.secondaryWriteEl) return;
    const secTab =
      this.tabs.find((t) => t.id === this.secondaryTabId) || this.getActiveTab();
    const initialText = secTab ? secTab.editorState.doc.toString() : "";

    this.secondaryView = createEditor(this.secondaryWriteEl, initialText, {
      onChange: (content) => {
        if (this.isSyncingDualDoc) return;
        const targetTab = this.tabs.find((t) => t.id === this.secondaryTabId);
        if (!targetTab || !this.secondaryView) return;

        targetTab.editorState = this.secondaryView.state;
        const isDirty = content !== targetTab.savedContent;
        const prevDirty = targetTab.isModified;
        targetTab.isModified = isDirty;
        if (prevDirty !== isDirty) {
          this.renderTabs();
        }

        // 若左右分屏打开的是同一个文档标签，将副编辑器的改动通过最小增量 Diff 实时同步回主编辑器
        const primaryView = this.callbacks.getPrimaryView();
        if (primaryView && this.secondaryTabId === this.activeTabId) {
          const primDoc = primaryView.state.doc.toString();
          const diff = computeMinimalTextDiff(primDoc, content);
          if (diff) {
            this.isSyncingDualDoc = true;
            try {
              const prevScroll = primaryView.scrollDOM.scrollTop;
              const changeDesc = ChangeSet.of(
                [{ from: diff.from, to: diff.to, insert: diff.insert }],
                primDoc.length
              );
              const mappedSel = primaryView.state.selection.map(changeDesc);
              primaryView.dispatch({
                changes: diff,
                selection: mappedSel,
              });
              primaryView.scrollDOM.scrollTop = prevScroll;
            } finally {
              this.isSyncingDualDoc = false;
            }
          }
          this.callbacks.onSecondaryDocChanged?.(targetTab, content);
        } else {
          this.callbacks.onSecondaryDocChanged?.(targetTab, content);
        }
      },
      onStatsUpdate: () => {},
      onOutlineUpdate: () => {},
      onOpenFile: (filePath) => this.callbacks.onOpenFileRequest(filePath),
    });

    // 为右侧分屏副编辑器完整挂载悬浮气泡工具栏、图片/链接悬浮栏与智能 HTML 转 Markdown 粘贴引擎
    initFloatingToolbars(this.secondaryView, (filePath) =>
      this.callbacks.onOpenFileRequest(filePath)
    );
    initSmartPaste(this.secondaryView);

    this.secondaryView.dom.addEventListener("focusin", () => {
      this.lastFocusedPane = "secondary";
      this.splitContainerEl?.classList.add("secondary-pane-focused");
    });

    // 副编辑器滚动时若开启同步滚动，反向联动主编辑器
    this.secondaryView.scrollDOM.addEventListener(
      "scroll",
      () => {
        const primaryView = this.callbacks.getPrimaryView();
        if (
          !this.splitActive ||
          !this.syncScrollEnabled ||
          !primaryView ||
          !this.secondaryView ||
          this.isSyncingScroll
        ) {
          return;
        }
        this.isSyncingScroll = true;
        const sDom = this.secondaryView.scrollDOM;
        const pDom = primaryView.scrollDOM;
        const maxS = Math.max(1, sDom.scrollHeight - sDom.clientHeight);
        const maxP = Math.max(1, pDom.scrollHeight - pDom.clientHeight);
        const ratio = sDom.scrollTop / maxS;
        pDom.scrollTop = ratio * maxP;
        requestAnimationFrame(() => {
          this.isSyncingScroll = false;
        });
      },
      { passive: true }
    );
  }

  public setSecondaryTab(tabId: string) {
    const target = this.tabs.find((t) => t.id === tabId);
    if (!target) return;
    this.secondaryTabId = target.id;

    if (this.secondaryView) {
      this.isSyncingDualDoc = true;
      try {
        const docText =
          target.id === this.activeTabId
            ? this.callbacks.getPrimaryView()?.state.doc.toString() ||
              target.editorState.doc.toString()
            : target.editorState.doc.toString();
        this.secondaryView.setState(
          createEditorStateForView(this.secondaryView, docText)
        );
      } finally {
        this.isSyncingDualDoc = false;
      }
    }

    this.updateSecondarySelector();
  }

  private updateSecondarySelector() {
    if (!this.secondarySelectEl) return;
    this.secondarySelectEl.innerHTML = this.tabs
      .map((t) => {
        const selected = t.id === this.secondaryTabId ? " selected" : "";
        const suffix = t.id === this.activeTabId ? " (同文档双视口对照)" : "";
        const dirtyMark = t.isModified ? " ●" : "";
        return `<option value="${escapeHtml(t.id)}"${selected}>${escapeHtml(t.title)}${dirtyMark}${suffix}</option>`;
      })
      .join("");
  }

  public renderTabs() {
    const listEl = this.tabsListEl;
    if (!listEl) return;

    // 同步单标签自动隐藏状态
    if (this.tabsBarEl) {
      this.tabsBarEl.classList.toggle(
        "single-tab-only",
        this.tabs.length <= 1 && !this.splitActive
      );
    }

    listEl.innerHTML = "";

    this.tabs.forEach((tab, index) => {
      const tabEl = document.createElement("div");
      tabEl.className = `doc-tab-item${tab.id === this.activeTabId ? " active" : ""}${
        tab.isModified ? " is-dirty" : ""
      }`;
      tabEl.dataset.tabId = tab.id;
      tabEl.dataset.index = String(index);
      tabEl.title = tab.filePath || tab.title;

      tabEl.innerHTML = `
        <span class="doc-tab-icon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
        </span>
        <span class="doc-tab-title">${escapeHtml(tab.title)}</span>
        <span class="doc-tab-dirty-dot" title="未保存修改"></span>
        <button type="button" class="doc-tab-split-open" title="在右侧分屏中打开此标签">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2"></rect>
            <line x1="12" y1="3" x2="12" y2="21"></line>
          </svg>
        </button>
        <button type="button" class="doc-tab-close" title="关闭标签页 (Ctrl+W)">✕</button>
      `;

      // 点击切换标签
      tabEl.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (target.closest(".doc-tab-close") || target.closest(".doc-tab-split-open")) {
          return;
        }
        if (tab.id !== this.activeTabId) {
          this.activateTab(tab.id);
        }
      });

      // 鼠标中键关闭标签
      tabEl.addEventListener("auxclick", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          this.closeTab(tab.id);
        }
      });

      // 点击在右侧分屏打开
      tabEl.querySelector(".doc-tab-split-open")?.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleSplitView(true, tab.id);
      });

      // 点击关闭按钮
      tabEl.querySelector(".doc-tab-close")?.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(tab.id);
      });

      // Pointer Events 标签拖拽排序
      this.bindTabPointerDrag(tabEl, index);

      listEl.appendChild(tabEl);
    });

    this.updateSecondarySelector();
  }

  private bindTabPointerDrag(tabEl: HTMLElement, fromIndex: number) {
    let startX = 0;
    let isDragging = false;
    let targetIndex = -1;

    tabEl.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;

      startX = e.clientX;
      isDragging = false;
      targetIndex = -1;

      const onMove = (moveEvt: PointerEvent) => {
        if (!isDragging) {
          if (Math.abs(moveEvt.clientX - startX) < 6) return;
          isDragging = true;
          tabEl.classList.add("dragging");
          try {
            tabEl.setPointerCapture(moveEvt.pointerId);
          } catch {}
        }

        const siblings = Array.from(
          this.tabsListEl?.querySelectorAll<HTMLElement>(".doc-tab-item") || []
        );
        siblings.forEach((s) => s.classList.remove("tab-drop-left", "tab-drop-right"));

        const hit = siblings.find((s) => {
          const r = s.getBoundingClientRect();
          return moveEvt.clientX >= r.left && moveEvt.clientX <= r.right;
        });

        if (hit && hit !== tabEl) {
          const hitIdx = Number(hit.dataset.index);
          const r = hit.getBoundingClientRect();
          const isRight = moveEvt.clientX > r.left + r.width / 2;
          hit.classList.add(isRight ? "tab-drop-right" : "tab-drop-left");
          targetIndex = isRight ? hitIdx + 1 : hitIdx;
        }
      };

      const onUp = (upEvt: PointerEvent) => {
        tabEl.removeEventListener("pointermove", onMove);
        tabEl.removeEventListener("pointerup", onUp);
        tabEl.removeEventListener("pointercancel", onUp);
        if (!isDragging) return;

        try {
          tabEl.releasePointerCapture(upEvt.pointerId);
        } catch {}
        tabEl.classList.remove("dragging");
        this.tabsListEl
          ?.querySelectorAll(".tab-drop-left, .tab-drop-right")
          .forEach((s) => s.classList.remove("tab-drop-left", "tab-drop-right"));

        if (targetIndex !== -1 && targetIndex !== fromIndex) {
          const [moved] = this.tabs.splice(fromIndex, 1);
          const adj = targetIndex > fromIndex ? targetIndex - 1 : targetIndex;
          this.tabs.splice(adj, 0, moved);
          this.renderTabs();
        }
      };

      tabEl.addEventListener("pointermove", onMove);
      tabEl.addEventListener("pointerup", onUp);
      tabEl.addEventListener("pointercancel", onUp);
    });
  }
}
