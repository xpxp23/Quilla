import { EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, undo, redo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  livePreviewPlugin,
  activeDocumentPath,
  stripInlineMarkdown,
} from "./extensions/live-preview";
import { imeGuardPlugin } from "./extensions/ime-guard";
import { tableKeymap, tableLiveViewField } from "./extensions/table-editor";
import { formattingKeymap } from "./extensions/formatting-keymap";
import { setupImageAndDropHandlers } from "./extensions/image-handler";
import { mermaidLiveViewField } from "./extensions/mermaid-extension";
import { mathBlockLiveViewField } from "./extensions/math-block-extension";
import { searchHighlightField } from "./extensions/search-highlighter";
import { navigateToAnchor } from "./extensions/anchor-navigator";
import { preciseCursorExtension, getExactPosAtCoords } from "./extensions/precise-cursor";
import {
  typewriterModeExtension,
  toggleTypewriterMode,
  isTypewriterModeActive,
} from "./extensions/typewriter-mode";
import {
  focusModeExtension,
  toggleFocusMode,
  isFocusModeActive,
} from "./extensions/focus-mode";
import { boundaryTraversalExtension } from "./extensions/boundary-traversal";
import { emojiAutocompletion } from "./extensions/emoji-autocomplete";
import { smartAutopairExtension } from "./extensions/smart-autopair";
import { blockHandlePlugin } from "./extensions/block-handle";
import { invoke } from "@tauri-apps/api/core";

export interface EditorCallbacks {
  onChange: (content: string) => void;
  onStatsUpdate: (words: number, chars: number) => void;
  onOutlineUpdate: (headings: Array<{ level: number; text: string; line: number }>) => void;
  onCursorLineChange?: (line: number) => void;
  onOpenFile?: (filePath: string) => void;
  onOpenWorkspace?: (dirPath: string) => void;
}

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

function resolveRelativeFilePath(baseDocPath: string | null, relHref: string): string {
  const cleaned = decodeURIComponent(relHref.split("#")[0].split("?")[0]).trim();
  if (!baseDocPath) return cleaned;
  if (/^[a-zA-Z]:[\\/]/.test(cleaned) || cleaned.startsWith("/")) {
    return cleaned;
  }
  const sep = baseDocPath.includes("\\") ? "\\" : "/";
  const baseParts = baseDocPath.replace(/\\/g, "/").split("/");
  baseParts.pop();
  const relParts = cleaned.replace(/\\/g, "/").split("/");
  for (const part of relParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (baseParts.length > 1) baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return baseParts.join(sep);
}

export function handleOpenLink(href: string, onOpenFile?: (filePath: string) => void) {
  const trimmed = href.trim();
  if (!trimmed) return;

  const isWebScheme = /^(https?:\/\/|mailto:|ftp:\/\/)/i.test(trimmed);
  const isDomainPattern =
    /^(www\.|[a-zA-Z0-9-]+\.(com|cn|org|net|io|edu|gov|cc|me|app|dev|info|vip|xyz|tech|top))(\/|$)/i.test(
      trimmed
    );

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
    const resolved = resolveRelativeFilePath(activeDocumentPath, trimmed);
    onOpenFile(resolved);
  }
}

export function extractOutlineHeadings(doc: {
  lines: number;
  line: (n: number) => { text: string };
}): Array<{ level: number; text: string; line: number }> {
  const headings: Array<{ level: number; text: string; line: number }> = [];
  let inFence = false;
  let fenceChar = "";

  // 跳过顶部 YAML Front Matter
  let startScanLine = 1;
  if (doc.lines >= 3 && doc.line(1).text.trim() === "---") {
    const limit = Math.min(doc.lines, 35);
    for (let k = 2; k <= limit; k++) {
      const t = doc.line(k).text.trim();
      if (t === "---" || t === "...") {
        startScanLine = k + 1;
        break;
      }
    }
  }

  for (let i = startScanLine; i <= doc.lines; i++) {
    const lineText = doc.line(i).text;
    const trimmed = lineText.trim();
    if (/^(```+|~~~+)/.test(trimmed)) {
      const marker = trimmed.startsWith("`") ? "`" : "~";
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const match = lineText.match(/^(#{1,6})\s+(.*)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: stripInlineMarkdown(match[2]),
        line: i,
      });
    }
  }
  return headings;
}

export { toggleTypewriterMode, isTypewriterModeActive, toggleFocusMode, isFocusModeActive };

/**
 * 彻底重置编辑器文档与 Undo/Redo 历史栈（用于切换文件或新建文件时隔离历史栈，严防 Ctrl+Z 跨文件串线）
 */
export function resetEditorDocument(view: EditorView, newContent: string) {
  const wasTW = isTypewriterModeActive(view);
  const wasFC = isFocusModeActive(view);
  const extensions: Extension[] = (view as any)._quillaExtensions || [];
  if (extensions.length > 0) {
    view.setState(
      EditorState.create({
        doc: newContent,
        extensions,
      })
    );
    if (wasTW) toggleTypewriterMode(view, true);
    if (wasFC) toggleFocusMode(view, true);
  } else {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: newContent },
    });
  }
}

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

      // 2. 提取大纲数据 (跳过代码块内注释并剥离行内格式符)
      const headings = extractOutlineHeadings(doc);
      callbacks.onOutlineUpdate(headings);

      // 3. 50ms 即时同步状态给上层应用
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        callbacks.onChange(text);
      }, 50);
    }

    if ((update.selectionSet || update.docChanged) && callbacks.onCursorLineChange) {
      const headLine = update.state.doc.lineAt(update.state.selection.main.head).number;
      callbacks.onCursorLineChange(headLine);
    }
  });

  const extensions: Extension[] = [
    cleanFocusTheme,
    history(),
    markdown(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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
          if (href.startsWith("#")) {
            event.preventDefault();
            event.stopPropagation();
            return navigateToAnchor(view, href.slice(1));
          }

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
  ];

  const state = EditorState.create({
    doc: initialDoc,
    extensions,
  });

  const view = new EditorView({
    state,
    parent,
  });

  (view as any)._quillaExtensions = extensions;

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

  // 视口滚动联动大纲 Scroll Spy：鼠标滚轮阅读长文时实时高亮当前视口顶部章节
  let scrollSpyRaf: number | null = null;
  view.scrollDOM.addEventListener(
    "scroll",
    () => {
      if (!callbacks.onCursorLineChange || scrollSpyRaf !== null) return;
      scrollSpyRaf = requestAnimationFrame(() => {
        scrollSpyRaf = null;
        try {
          const topY = view.scrollDOM.scrollTop + 60;
          const block = view.lineBlockAtHeight(topY);
          const lineNum = view.state.doc.lineAt(block.from).number;
          callbacks.onCursorLineChange?.(lineNum);
        } catch {
          // ignore
        }
      });
    },
    { passive: true }
  );

  // 绑定图片粘贴与外部拖放管道
  setupImageAndDropHandlers(view, {
    onOpenFile: callbacks.onOpenFile,
    onOpenWorkspace: callbacks.onOpenWorkspace,
  });

  // 初次触发一次统计与大纲构建
  const words = (initialDoc.match(/[\w\d\u4e00-\u9fa5]+/g) || []).length;
  callbacks.onStatsUpdate(words, initialDoc.length);
  callbacks.onOutlineUpdate(extractOutlineHeadings(view.state.doc));

  return view;
}
