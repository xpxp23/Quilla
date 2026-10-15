import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { livePreviewPlugin } from "./extensions/live-preview";
import { imeGuardPlugin } from "./extensions/ime-guard";
import { tableKeymap, tableLiveViewField } from "./extensions/table-editor";
import { formattingKeymap } from "./extensions/formatting-keymap";
import { setupImageAndDropHandlers } from "./extensions/image-handler";

export interface EditorCallbacks {
  onChange: (content: string) => void;
  onStatsUpdate: (words: number, chars: number) => void;
  onOutlineUpdate: (headings: Array<{ level: number; text: string; line: number }>) => void;
  onOpenFile?: (filePath: string) => void;
  onOpenWorkspace?: (dirPath: string) => void;
}

// 消除 CodeMirror 默认外聚焦虚线边框与杂色
const cleanFocusTheme = EditorView.theme({
  "&": {
    outline: "none !important",
    border: "none !important",
  },
  "&.cm-focused": {
    outline: "none !important",
    boxShadow: "none !important",
  },
  ".cm-scroller": {
    outline: "none !important",
  },
  ".cm-content": {
    outline: "none !important",
  },
});

import { mermaidLiveViewField } from "./extensions/mermaid-extension";
import { mathBlockLiveViewField } from "./extensions/math-block-extension";
import { undo, redo } from "@codemirror/commands";

import { searchHighlightField } from "./extensions/search-highlighter";
import { navigateToAnchor } from "./extensions/anchor-navigator";
import { preciseCursorExtension, getExactPosAtCoords } from "./extensions/precise-cursor";
import { typewriterModeExtension, toggleTypewriterMode, isTypewriterModeActive } from "./extensions/typewriter-mode";
import { focusModeExtension, toggleFocusMode, isFocusModeActive } from "./extensions/focus-mode";
import { boundaryTraversalExtension } from "./extensions/boundary-traversal";
import { emojiAutocompletion } from "./extensions/emoji-autocomplete";
import { smartAutopairExtension } from "./extensions/smart-autopair";
import { blockHandlePlugin } from "./extensions/block-handle";
import { invoke } from "@tauri-apps/api/core";

export function handleOpenLink(href: string, onOpenFile?: (filePath: string) => void) {
  const trimmed = href.trim();
  if (!trimmed) return;

  const isWebScheme = /^(https?:\/\/|mailto:|ftp:\/\/)/i.test(trimmed);
  const isDomainPattern = /^(www\.|[a-zA-Z0-9-]+\.(com|cn|org|net|io|edu|gov|cc|me|app|dev|info|vip|xyz|tech|top))/i.test(trimmed);

  if (isWebScheme) {
    invoke("open_external_url", { url: trimmed }).catch((e) => {
      console.error("打开外部链接失败:", e);
      window.open(trimmed, "_blank");
    });
  } else if (isDomainPattern) {
    const fullUrl = `https://${trimmed}`;
    invoke("open_external_url", { url: fullUrl }).catch((e) => {
      console.error("打开外部链接失败:", e);
      window.open(fullUrl, "_blank");
    });
  } else if (onOpenFile) {
    onOpenFile(trimmed);
  }
}

export { toggleTypewriterMode, isTypewriterModeActive, toggleFocusMode, isFocusModeActive };

export function createEditor(
  parent: HTMLElement,
  initialDoc: string,
  callbacks: EditorCallbacks
): EditorView {
  let debounceTimer: any = null;

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      const doc = update.state.doc;
      const text = doc.toString();

      // 1. 统计字数与字符数
      const chars = text.length;
      const words = (text.match(/[\w\d\u4e00-\u9fa5]+/g) || []).length;
      callbacks.onStatsUpdate(words, chars);

      // 2. 提取大纲数据
      const headings: Array<{ level: number; text: string; line: number }> = [];
      for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        const match = line.text.match(/^(#{1,6})\s+(.*)$/);
        if (match) {
          headings.push({
            level: match[1].length,
            text: match[2],
            line: i,
          });
        }
      }
      callbacks.onOutlineUpdate(headings);

      // 3. 50ms 即时同步状态给上层应用
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        callbacks.onChange(text);
      }, 50);
    }
  });

  const state = EditorState.create({
    doc: initialDoc,
    extensions: [
      cleanFocusTheme,
      history(),
      markdown(),
      imeGuardPlugin,
      ...smartAutopairExtension(),
      emojiAutocompletion,
      blockHandlePlugin,
      tableLiveViewField,
      mermaidLiveViewField,
      mathBlockLiveViewField,
      searchHighlightField,
      preciseCursorExtension,
      typewriterModeExtension,
      focusModeExtension,
      boundaryTraversalExtension,
      livePreviewPlugin,
      EditorView.domEventHandlers({
        click: (event, view) => {
          const linkElem = (event.target as HTMLElement).closest(".cm-link") as HTMLElement;
          if (linkElem && linkElem.dataset.href) {
            const href = linkElem.dataset.href.trim();
            // 1. 文档内部目录锚点：无论是直接单击还是 Ctrl+点击均即时平滑跳转
            if (href.startsWith("#")) {
              event.preventDefault();
              event.stopPropagation();
              return navigateToAnchor(view, href.slice(1));
            }

            // 2. 外部超链接或跨文件引用：Ctrl+点击触发打开
            if (event.ctrlKey || event.metaKey) {
              event.preventDefault();
              event.stopPropagation();
              handleOpenLink(href, callbacks.onOpenFile);
              return true;
            }
          }
          return false;
        },
      }),
      keymap.of([
        { key: "Ctrl-z", run: undo },
        { key: "Ctrl-y", run: redo },
        { key: "Ctrl-Shift-z", run: redo },
        ...formattingKeymap,
        ...tableKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      updateListener,
      EditorView.lineWrapping,
    ],
  });

  const view = new EditorView({
    state,
    parent,
  });

  const origPosAtCoords = view.posAtCoords.bind(view);
  const origPosAndSideAtCoords = view.posAndSideAtCoords.bind(view);
  (view as any)._origPosAndSideAtCoords = origPosAndSideAtCoords;

  view.posAtCoords = (coords: { x: number; y: number }, precise?: any) => {
    const exact = getExactPosAtCoords(view, coords.x, coords.y);
    if (exact) return exact.pos;
    return (origPosAtCoords as any)(coords, precise);
  };

  view.posAndSideAtCoords = (coords: { x: number; y: number }, precise?: any) => {
    const exact = getExactPosAtCoords(view, coords.x, coords.y);
    if (exact) return exact;
    return (origPosAndSideAtCoords as any)(coords, precise);
  };

  // 绑定图片粘贴与外部拖放管道
  setupImageAndDropHandlers(view, {
    onOpenFile: callbacks.onOpenFile,
    onOpenWorkspace: callbacks.onOpenWorkspace,
  });

  // 初次触发一次统计
  const words = (initialDoc.match(/[\w\d\u4e00-\u9fa5]+/g) || []).length;
  callbacks.onStatsUpdate(words, initialDoc.length);

  return view;
}
