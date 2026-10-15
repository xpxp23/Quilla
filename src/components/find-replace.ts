import { EditorView } from "@codemirror/view";
import { setSearchMatchesEffect } from "../editor/extensions/search-highlighter";

export interface FindReplaceController {
  open: (replaceMode?: boolean) => void;
  close: () => void;
  notifyDocChanged: () => void;
}

export function initFindReplace(view: EditorView): FindReplaceController {
  // 1. 创建吸顶查找替换浮层 DOM
  const bar = document.createElement("div");
  bar.id = "ty-find-replace";
  bar.className = "ty-find-replace-bar hidden";
  bar.innerHTML = `
    <div class="find-row">
      <div class="find-input-wrap">
        <input type="text" id="find-input" class="find-input" placeholder="在文档中查找..." spellcheck="false" autocomplete="off" />
        <span id="find-count" class="find-count">0/0</span>
      </div>
      <div class="find-actions">
        <button type="button" id="find-prev-btn" class="find-btn" title="上一个 (Shift+Enter)">▲</button>
        <button type="button" id="find-next-btn" class="find-btn" title="下一个 (Enter)">▼</button>
        <button type="button" id="find-case-btn" class="find-btn" title="区分大小写">Aa</button>
        <button type="button" id="find-toggle-replace" class="find-btn" title="切换替换模式">⇄</button>
        <button type="button" id="find-close-btn" class="find-btn close-btn" title="关闭 (Esc)">✕</button>
      </div>
    </div>
    <div id="replace-row" class="replace-row hidden">
      <input type="text" id="replace-input" class="replace-input" placeholder="替换为..." spellcheck="false" autocomplete="off" />
      <div class="replace-actions">
        <button type="button" id="replace-btn" class="find-btn text-btn">替换</button>
        <button type="button" id="replace-all-btn" class="find-btn text-btn">全部替换</button>
      </div>
    </div>
  `;
  document.body.appendChild(bar);

  const findInput = bar.querySelector("#find-input") as HTMLInputElement;
  const replaceInput = bar.querySelector("#replace-input") as HTMLInputElement;
  const findCount = bar.querySelector("#find-count") as HTMLElement;
  const prevBtn = bar.querySelector("#find-prev-btn") as HTMLElement;
  const nextBtn = bar.querySelector("#find-next-btn") as HTMLElement;
  const caseBtn = bar.querySelector("#find-case-btn") as HTMLElement;
  const toggleReplaceBtn = bar.querySelector("#find-toggle-replace") as HTMLElement;
  const closeBtn = bar.querySelector("#find-close-btn") as HTMLElement;
  const replaceRow = bar.querySelector("#replace-row") as HTMLElement;
  const replaceBtn = bar.querySelector("#replace-btn") as HTMLElement;
  const replaceAllBtn = bar.querySelector("#replace-all-btn") as HTMLElement;

  let isCaseSensitive = false;
  let matches: Array<{ from: number; to: number }> = [];
  let currentIndex = -1;

  function performSearch(moveSelection: boolean = true) {
    const query = findInput.value;
    matches = [];
    currentIndex = -1;

    if (!query) {
      findCount.textContent = "0/0";
      view.dispatch({
        effects: [setSearchMatchesEffect.of(null)],
      });
      return;
    }

    const docText = view.state.doc.toString();
    const searchTarget = isCaseSensitive ? docText : docText.toLowerCase();
    const needle = isCaseSensitive ? query : query.toLowerCase();

    let pos = 0;
    while ((pos = searchTarget.indexOf(needle, pos)) !== -1) {
      matches.push({ from: pos, to: pos + needle.length });
      pos += needle.length;
    }

    if (matches.length > 0) {
      // 找出距离光标最近的匹配项
      const cursorPos = view.state.selection.main.head;
      let closestIdx = matches.findIndex((m) => m.from >= cursorPos);
      if (closestIdx === -1) closestIdx = 0;
      currentIndex = closestIdx;
      highlightMatch(currentIndex, moveSelection);
    } else {
      findCount.textContent = "0/0";
      view.dispatch({
        effects: [setSearchMatchesEffect.of(null)],
      });
    }
  }

  function highlightMatch(index: number, moveSelection: boolean = true) {
    if (matches.length === 0 || index < 0 || index >= matches.length) {
      findCount.textContent = "0/0";
      view.dispatch({
        effects: [setSearchMatchesEffect.of(null)],
      });
      return;
    }
    currentIndex = index;
    findCount.textContent = `${currentIndex + 1}/${matches.length}`;

    const m = matches[currentIndex];
    if (moveSelection) {
      view.dispatch({
        selection: { anchor: m.from, head: m.to },
        scrollIntoView: true,
        effects: [
          setSearchMatchesEffect.of({ matches, currentIndex }),
        ],
      });
    } else {
      view.dispatch({
        effects: [
          setSearchMatchesEffect.of({ matches, currentIndex }),
        ],
      });
    }
  }

  function nextMatch() {
    if (matches.length === 0) return;
    const nextIdx = (currentIndex + 1) % matches.length;
    highlightMatch(nextIdx, true);
  }

  function prevMatch() {
    if (matches.length === 0) return;
    const prevIdx = (currentIndex - 1 + matches.length) % matches.length;
    highlightMatch(prevIdx, true);
  }

  function replaceCurrent() {
    if (matches.length === 0 || currentIndex < 0) return;
    const m = matches[currentIndex];
    const rep = replaceInput.value;
    view.dispatch({
      changes: { from: m.from, to: m.to, insert: rep },
      selection: { anchor: m.from + rep.length },
    });
    performSearch(true);
  }

  function replaceAll() {
    if (matches.length === 0) return;
    const rep = replaceInput.value;
    const changes = matches.map((m) => ({ from: m.from, to: m.to, insert: rep }));
    view.dispatch({ changes });
    performSearch(true);
  }

  // 事件监听
  findInput.addEventListener("input", () => performSearch(true));

  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        prevMatch();
      } else {
        nextMatch();
      }
    } else if (e.key === "Escape") {
      controller.close();
    }
  });

  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceCurrent();
    } else if (e.key === "Escape") {
      controller.close();
    }
  });

  prevBtn.addEventListener("click", prevMatch);
  nextBtn.addEventListener("click", nextMatch);

  caseBtn.addEventListener("click", () => {
    isCaseSensitive = !isCaseSensitive;
    caseBtn.classList.toggle("active", isCaseSensitive);
    performSearch(true);
  });

  toggleReplaceBtn.addEventListener("click", () => {
    replaceRow.classList.toggle("hidden");
    if (!replaceRow.classList.contains("hidden")) {
      replaceInput.focus();
    }
  });

  closeBtn.addEventListener("click", () => controller.close());
  replaceBtn.addEventListener("click", replaceCurrent);
  replaceAllBtn.addEventListener("click", replaceAll);

  const controller: FindReplaceController = {
    open(replaceMode = false) {
      bar.classList.remove("hidden");
      if (replaceMode) {
        replaceRow.classList.remove("hidden");
      }

      // 如果编辑器当前有选中文本，自动填充进搜索框
      const sel = view.state.selection.main;
      if (!sel.empty && sel.to - sel.from < 100) {
        const text = view.state.sliceDoc(sel.from, sel.to).trim();
        if (text) {
          findInput.value = text;
        }
      }

      if (replaceMode && findInput.value) {
        replaceInput.focus();
        replaceInput.select();
      } else {
        findInput.focus();
        findInput.select();
      }

      performSearch(true);
    },
    close() {
      bar.classList.add("hidden");
      view.dispatch({
        effects: [setSearchMatchesEffect.of(null)],
      });
      view.focus();
    },
    notifyDocChanged() {
      if (!bar.classList.contains("hidden") && findInput.value) {
        performSearch(false);
      }
    },
  };

  // 全局快捷键拦截
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      controller.open(false);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") {
      e.preventDefault();
      controller.open(true);
    }
  });

  return controller;
}
