import { ChangeSet, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import {
  createEditor,
  createEditorStateForView,
  isTypewriterModeActive,
  toggleTypewriterMode,
  isFocusModeActive,
  toggleFocusMode,
} from "../editor";
import {
  TabFoldSnapshot,
  snapshotFoldState,
  restoreFoldState,
} from "../editor/extensions/live-preview";
import { initFloatingToolbars } from "../editor/extensions/floating-toolbars";
import { initSmartPaste } from "../editor/extensions/smart-paste";
import { showToast } from "./save-dialog";
import { formatModKey } from "./shortcut-guide";

export interface DocumentTab {
  id: string;
  filePath: string | null;
  title: string;
  savedContent: string;
  isModified: boolean;
  editorState: EditorState;
  scrollTop: number;
  foldSnapshot?: TabFoldSnapshot;
}

export interface TabsManagerCallbacks {
  getPrimaryView: () => EditorView | null;
  onActiveTabChanged: (tab: DocumentTab) => void;
  onTabCloseConfirm: (tab: DocumentTab) => Promise<"save" | "discard" | "cancel">;
  onNewBlankTabRequest: () => void;
  onOpenFileRequest: (filePath: string) => void;
  onSaveTabRequest?: (tab: DocumentTab) => Promise<void>;
  onSaveTabAsRequest?: (tab: DocumentTab) => Promise<void>;
  onOpenInNewWindowRequest?: (tab: DocumentTab) => Promise<void>;
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

let activeTabContextMenu: HTMLElement | null = null;
function closeTabContextMenu() {
  if (activeTabContextMenu) {
    activeTabContextMenu.remove();
    activeTabContextMenu = null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("mousedown", (e) => {
    if (activeTabContextMenu && !activeTabContextMenu.contains(e.target as Node)) {
      closeTabContextMenu();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTabContextMenu();
  });
}

/**
 * 多标签页（Tabs）与左右分屏对比编辑（Split View）控制器 v0.7
 * - 新增顶部标签右键菜单（保存、另存为/重命名、在右侧分屏打开、独立窗口打开、复制路径/文件名、定位文件夹、关闭其他/右侧/已保存标签）(Bug #2)
 * - 修复非激活脏标签关闭时的保存逻辑 (Homologous Bug #9)
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

    // 双击标签栏空白处快速新建空白标签
    this.tabsListEl?.addEventListener("dblclick", (e) => {
      if (e.target === this.tabsListEl) {
        this.callbacks.onNewBlankTabRequest();
      }
    });

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

    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        this.toggleSplitView();
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        this.cycleTab(e.shiftKey ? -1 : 1);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w" && !e.shiftKey) {
        if (this.tabs.length >= 1) {
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

  public snapshotActiveTabState() {
    const primaryView = this.callbacks.getPrimaryView();
    const activeTab = this.getActiveTab();
    if (primaryView && activeTab) {
      activeTab.editorState = primaryView.state;
      activeTab.scrollTop = primaryView.scrollDOM.scrollTop;
      activeTab.foldSnapshot = snapshotFoldState();
    }
    if (this.splitActive && this.secondaryView && this.secondaryTabId) {
      const secTab = this.getSecondaryTab();
      if (secTab && secTab.id !== activeTab?.id) {
        secTab.editorState = this.secondaryView.state;
      }
    }
  }

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

    // 激活主面板标签时始终将焦点归位至 primary，防止之前点击过右侧分屏导致保存命令误存副面板
    this.lastFocusedPane = "primary";
    this.splitContainerEl?.classList.remove("secondary-pane-focused");

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

    restoreFoldState(tab.foldSnapshot);
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

    this.snapshotActiveTabState();

    if (tab.isModified) {
      const choice = await this.callbacks.onTabCloseConfirm(tab);
      if (choice === "cancel") return false;
    }

    const currentIdx = this.tabs.findIndex((t) => t.id === tabId);
    if (currentIdx === -1) return true;

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

    this.tabs.splice(currentIdx, 1);
    if (this.activeTabId === tabId) {
      const nextTab = this.tabs[Math.min(currentIdx, this.tabs.length - 1)];
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

  /**
   * 当标签页已无损迁移至独立新窗口后，从当前窗口静默剥离该标签（不触发二次未保存弹窗）
   */
  public detachTabAfterTransfer(tabId: string) {
    const currentIdx = this.tabs.findIndex((t) => t.id === tabId);
    if (currentIdx === -1) return;

    if (this.tabs.length === 1) {
      const primaryView = this.callbacks.getPrimaryView();
      if (!primaryView) return;
      const tab = this.tabs[0];
      tab.filePath = null;
      tab.title = "未命名.md";
      tab.savedContent = "";
      tab.isModified = false;
      tab.scrollTop = 0;
      tab.foldSnapshot = undefined;
      tab.editorState = createEditorStateForView(primaryView, "");
      this.applyTabToPrimaryView(tab);
      this.renderTabs();
      this.callbacks.onActiveTabChanged(tab);
      return;
    }

    this.tabs.splice(currentIdx, 1);
    if (this.activeTabId === tabId) {
      const nextTab = this.tabs[Math.min(currentIdx, this.tabs.length - 1)];
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
  }

  /**
   * 跨窗口状态总线同步：当其他窗口保存了某个文件时，自动更新当前窗口内同路径标签页的基准内容
   */
  public syncExternalFileSaved(filePath: string, newContent: string) {
    const primaryView = this.callbacks.getPrimaryView();
    if (!primaryView) return;
    const normTarget = filePath.replace(/\\/g, "/").toLowerCase();

    for (const tab of this.tabs) {
      if (!tab.filePath || tab.filePath.replace(/\\/g, "/").toLowerCase() !== normTarget) {
        continue;
      }
      tab.savedContent = newContent;
      if (!tab.isModified) {
        tab.editorState = createEditorStateForView(primaryView, newContent);
        if (tab.id === this.activeTabId) {
          const prevScroll = primaryView.scrollDOM.scrollTop;
          primaryView.setState(tab.editorState);
          primaryView.scrollDOM.scrollTop = prevScroll;
        }
        if (this.splitActive && this.secondaryView && tab.id === this.secondaryTabId) {
          const prevSecScroll = this.secondaryView.scrollDOM.scrollTop;
          this.secondaryView.setState(
            createEditorStateForView(this.secondaryView, newContent)
          );
          this.secondaryView.scrollDOM.scrollTop = prevSecScroll;
        }
      } else {
        const curDoc =
          tab.id === this.activeTabId
            ? primaryView.state.doc.toString()
            : tab.editorState.doc.toString();
        tab.isModified = curDoc !== newContent;
      }
    }
    this.renderTabs();
  }

  public async closeOtherTabs(keepTabId: string) {
    const others = this.tabs.filter((t) => t.id !== keepTabId).map((t) => t.id);
    for (const id of others) {
      const ok = await this.closeTab(id);
      if (!ok) break;
    }
  }

  public async closeTabsToRight(fromIndex: number) {
    const rightIds = this.tabs.slice(fromIndex + 1).map((t) => t.id);
    for (const id of rightIds) {
      const ok = await this.closeTab(id);
      if (!ok) break;
    }
  }

  public async closeCleanTabs() {
    const cleanIds = this.tabs.filter((t) => !t.isModified).map((t) => t.id);
    if (cleanIds.length === this.tabs.length && this.tabs.length === 1) {
      await this.closeTab(this.tabs[0].id);
      return;
    }
    for (const id of cleanIds) {
      if (this.tabs.length <= 1 && !this.tabs[0].filePath && !this.tabs[0].isModified) break;
      await this.closeTab(id);
    }
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

    initFloatingToolbars(this.secondaryView, (filePath) =>
      this.callbacks.onOpenFileRequest(filePath)
    );
    initSmartPaste(this.secondaryView);

    this.secondaryView.dom.addEventListener("focusin", () => {
      this.lastFocusedPane = "secondary";
      this.splitContainerEl?.classList.add("secondary-pane-focused");
    });

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

  /**
   * 顶部文档标签（如 未命名.md）右键上下文菜单 (Bug #2)
   */
  private openTabContextMenu(
    clientX: number,
    clientY: number,
    tab: DocumentTab,
    tabIndex: number
  ) {
    closeTabContextMenu();
    const mod = formatModKey();
    const hasOthers = this.tabs.length > 1;
    const hasRight = tabIndex < this.tabs.length - 1;
    const hasClean = this.tabs.some((t) => !t.isModified);

    const menu = document.createElement("div");
    menu.className = "context-menu tab-context-menu";
    menu.innerHTML = `
      <div class="context-menu-item" data-act="save-tab">
        <span>保存${tab.filePath ? "" : "新文档..."}</span>
        <span class="menu-shortcut">${mod}+S</span>
      </div>
      <div class="context-menu-item" data-act="save-as-tab">
        <span>${tab.filePath ? "另存为 / 重命名..." : "指定文件名保存..."}</span>
        <span class="menu-shortcut">${mod}+Shift+S</span>
      </div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-act="split-right">
        <span>在右侧分屏中打开</span>
        <span class="menu-shortcut">${mod}+\\</span>
      </div>
      <div class="context-menu-item" data-act="open-new-window">
        <span>在独立新窗口中打开</span>
      </div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-act="copy-name">
        <span>复制文件名 (${escapeHtml(tab.title)})</span>
      </div>
      ${
        tab.filePath
          ? `
      <div class="context-menu-item" data-act="copy-path">
        <span>复制文件完整路径</span>
      </div>
      <div class="context-menu-item" data-act="reveal-folder">
        <span>在文件管理器中定位</span>
      </div>`
          : ""
      }
      <div class="context-menu-divider"></div>
      <div class="context-menu-item" data-act="close-this">
        <span>${this.tabs.length === 1 && !tab.filePath ? "清空并重置当前标签" : "关闭当前标签"}</span>
        <span class="menu-shortcut">${mod}+W</span>
      </div>
      <div class="context-menu-item ${hasOthers ? "" : "disabled"}" data-act="close-others">
        <span>关闭其他标签</span>
      </div>
      <div class="context-menu-item ${hasRight ? "" : "disabled"}" data-act="close-right">
        <span>关闭右侧全部标签</span>
      </div>
      <div class="context-menu-item ${hasClean ? "" : "disabled"}" data-act="close-clean">
        <span>关闭所有已保存标签</span>
      </div>
    `;

    document.body.appendChild(menu);
    activeTabContextMenu = menu;

    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    menu.addEventListener("click", async (e) => {
      e.stopPropagation();
      const item = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
      if (!item || item.classList.contains("disabled")) return;
      const act = item.dataset.act;
      closeTabContextMenu();

      if (act === "save-tab") {
        if (tab.id !== this.activeTabId) this.activateTab(tab.id);
        await this.callbacks.onSaveTabRequest?.(tab);
      } else if (act === "save-as-tab") {
        if (tab.id !== this.activeTabId) this.activateTab(tab.id);
        await this.callbacks.onSaveTabAsRequest?.(tab);
      } else if (act === "split-right") {
        this.toggleSplitView(true, tab.id);
      } else if (act === "open-new-window") {
        this.snapshotActiveTabState();
        await this.callbacks.onOpenInNewWindowRequest?.(tab);
      } else if (act === "copy-name") {
        navigator.clipboard.writeText(tab.title).catch(() => {});
        showToast("已复制文件名", "success");
      } else if (act === "copy-path" && tab.filePath) {
        navigator.clipboard.writeText(tab.filePath).catch(() => {});
        showToast("已复制文件完整路径", "success");
      } else if (act === "reveal-folder" && tab.filePath) {
        invoke("reveal_in_folder", { path: tab.filePath }).catch((err) => {
          showToast(`无法定位文件夹: ${err}`, "error");
        });
      } else if (act === "close-this") {
        await this.closeTab(tab.id);
      } else if (act === "close-others") {
        await this.closeOtherTabs(tab.id);
      } else if (act === "close-right") {
        await this.closeTabsToRight(tabIndex);
      } else if (act === "close-clean") {
        await this.closeCleanTabs();
      }
    });
  }

  public renderTabs() {
    const listEl = this.tabsListEl;
    if (!listEl) return;

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
      tabEl.title = `${tab.filePath || tab.title}\n右键打开标签操作菜单 · 中键关闭`;

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

      // 右键弹出标签页上下文菜单 (Bug #2)
      tabEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openTabContextMenu(e.clientX, e.clientY, tab, index);
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
