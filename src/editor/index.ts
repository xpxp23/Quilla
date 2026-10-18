import { EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, undo, redo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  livePreviewPlugin,
  activeDocumentPath,
  stripInlineMarkdown,
  toggleHeadingFoldAtLine,
  isHeadingFoldedAtLine,
} from "./extensions/live-preview";
import { docStructureField } from "./extensions/doc-structure";
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
import { slashCommandExtension } from "./extensions/slash-command";
import { setupWikiLinkInteractions, handleTagClickTrigger } from "./extensions/wiki-link";
import { isOutlineJumpLocked } from "../components/outline";
import { TextDeltaPayload } from "../components/auto-recovery";
import { invoke } from "@tauri-apps/api/core";

export interface EditorCallbacks {
  onChange: (content: string, deltas?: TextDeltaPayload[]) => void;
  onStatsUpdate: (words: number, chars: number) => void;
  onOutlineUpdate: (headings: Array<{ level: number; text: string; line: number }>) => void;
  onCursorLineChange?: (line: number) => void;
  onOpenFile?: (filePath: string) => void;
  onOpenWorkspace?: (dirPath: string) => void;
}

/**
 * 精准统计中英文混合词数：单个汉字/日文假名计 1 词，连续英文单词/数字计 1 词，
 * 与 stats-popover.ts 详情弹窗口径完全一致
 */
export function countMixedWords(text: string): number {
  const matches = text.match(/[\u4e00-\u9fa5\u3040-\u30ff]|[a-zA-Z0-9_\-]+/g);
  return matches ? matches.length : 0;
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

export function extractOutlineHeadings(
  doc: {
    lines: number;
    line: (n: number) => { text: string };
  },
  state?: EditorState
): Array<{ level: number; text: string; line: number }> {
  if (state) {
    const cached = state.field(docStructureField, false);
    if (cached) {
      return cached.headings.map((h) => ({
        level: h.level,
        text: h.text,
        line: h.line,
      }));
    }
  }

  const headings: Array<{ level: number; text: string; line: number }> = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

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
    const strippedQuote = lineText.replace(/^\s*(?:>\s*)*/, "").trim();
    const fenceM = strippedQuote.match(/^(`{3,}|~{3,})/);
    if (fenceM) {
      const marker = fenceM[1][0];
      const len = fenceM[1].length;
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
        fenceLen = len;
      } else if (
        marker === fenceChar &&
        len >= fenceLen &&
        /^(`{3,}|~{3,})\s*$/.test(strippedQuote)
      ) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const match = lineText.match(/^\s*(?:>\s*)*(#{1,6})\s+(.*)$/);
    if (match) {
      const cleanedText = stripInlineMarkdown(match[2]);
      if (cleanedText) {
        headings.push({
          level: match[1].length,
          text: cleanedText,
          line: i,
        });
      }
    }
  }
  return headings;
}

export {
  toggleTypewriterMode,
  isTypewriterModeActive,
  toggleFocusMode,
  isFocusModeActive,
  toggleHeadingFoldAtLine,
  isHeadingFoldedAtLine,
};

/**
 * 为指定编辑器实例创建全新的 EditorState（含独立 Undo/Redo 历史栈，供多标签页切换或文件重置使用）
 */
export function createEditorStateForView(view: EditorView, newContent: string): EditorState {
  const extensions: Extension[] = (view as any)._quillaExtensions || [];
  return EditorState.create({
    doc: newContent,
    extensions,
  });
}

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
  let pendingDeltas: TextDeltaPayload[] = [];
  let lastEditTime = 0;

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      lastEditTime = performance.now();
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        pendingDeltas.push({
          fromChar: fromA,
          toChar: toA,
          insert: inserted.toString(),
        });
      });

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const state = update.view.state;
        const doc = state.doc;
        const text = doc.toString();

        const chars = text.length;
        const words = countMixedWords(text);
        callbacks.onStatsUpdate(words, chars);

        const headings = extractOutlineHeadings(doc, state);
        callbacks.onOutlineUpdate(headings);

        const flushedDeltas = pendingDeltas;
        pendingDeltas = [];
        callbacks.onChange(text, flushedDeltas);
      }, 65);
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
    docStructureField,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    imeGuardPlugin,
    ...smartAutopairExtension(),
    emojiAutocompletion,
    slashCommandExtension(),
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
      mousedown: (event, view) => {
        if (
          event.button === 0 &&
          document.documentElement.classList.contains("show-code-line-numbers")
        ) {
          const codeLineEl = (event.target as HTMLElement).closest(
            ".cm-code-block-line"
          ) as HTMLElement | null;
          if (codeLineEl) {
            const rect = codeLineEl.getBoundingClientRect();
            const relX = event.clientX - rect.left;
            if (relX >= 0 && relX <= 42) {
              try {
                const pos = view.posAtDOM(codeLineEl, 0);
                const line = view.state.doc.lineAt(pos);
                event.preventDefault();
                event.stopPropagation();
                view.dispatch({
                  selection: { anchor: line.from, head: line.to },
                });
                view.focus();
                return true;
              } catch {
                // ignore
              }
            }
          }
        }
        return false;
      },
      click: (event, view) => {
        const target = event.target as HTMLElement;

        const tagElem = target.closest(".cm-hashtag") as HTMLElement | null;
        if (tagElem && tagElem.dataset.tag) {
          event.preventDefault();
          event.stopPropagation();
          handleTagClickTrigger(tagElem.dataset.tag);
          return true;
        }

        const linkElem = target.closest(".cm-link") as HTMLElement;
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
      { key: "Mod-z", run: undo },
      { key: "Mod-y", run: redo },
      { key: "Mod-Shift-z", run: redo },
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

  // 视口滚动联动大纲 Scroll Spy (Bug #7 彻底修复)：
  // 1. 当用户刚刚点击左侧大纲跳转 (isOutlineJumpLocked()) 时，严禁 Scroll Spy 反向覆盖大纲高亮。
  // 2. 当处于打字机模式或非滚轮触发的编辑/跳转时，以光标所在行为准。
  let scrollSpyRaf: number | null = null;
  let lastWheelTime = 0;
  view.scrollDOM.addEventListener(
    "wheel",
    () => {
      lastWheelTime = performance.now();
    },
    { passive: true }
  );

  view.scrollDOM.addEventListener(
    "scroll",
    () => {
      if (!callbacks.onCursorLineChange || scrollSpyRaf !== null) return;
      if (isOutlineJumpLocked()) return;
      if (performance.now() - lastEditTime < 450 && performance.now() - lastWheelTime > 400) {
        return;
      }
      if (isTypewriterModeActive(view) && performance.now() - lastWheelTime > 300) {
        return;
      }
      scrollSpyRaf = requestAnimationFrame(() => {
        scrollSpyRaf = null;
        if (isOutlineJumpLocked()) return;
        try {
          const scroller = view.scrollDOM;
          const scrollerRect = scroller.getBoundingClientRect();
          const probeY = scrollerRect.top + 64;
          const children = view.contentDOM.children;
          for (let i = 0; i < children.length; i++) {
            const child = children[i] as HTMLElement;
            const rect = child.getBoundingClientRect();
            if (rect.height > 0 && rect.bottom >= probeY) {
              const pos = view.posAtDOM(child, 0);
              const lineNum = view.state.doc.lineAt(pos).number;
              callbacks.onCursorLineChange?.(lineNum);
              return;
            }
          }
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

  // 绑定 [[Wiki Links]] 悬停预览卡片与点击跳转交互
  setupWikiLinkInteractions(view);

  // 初次触发一次统计与大纲构建
  const words = countMixedWords(initialDoc);
  callbacks.onStatsUpdate(words, initialDoc.length);
  callbacks.onOutlineUpdate(extractOutlineHeadings(view.state.doc, view.state));

  return view;
}
