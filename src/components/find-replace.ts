import { EditorView } from "@codemirror/view";
import { setSearchMatchesEffect } from "../editor/extensions/search-highlighter";
import { findTablesInDoc } from "../editor/extensions/table-editor";

export interface FindReplaceController {
  open: (replaceMode?: boolean) => void;
  close: () => void;
  notifyDocChanged: () => void;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function initFindReplace(view: EditorView): FindReplaceController {
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
        <button type="button" id="find-prev-btn" class="find-btn" title="上一个 (Shift+Enter)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="18 15 12 9 6 15"></polyline></svg>
        </button>
        <button type="button" id="find-next-btn" class="find-btn" title="下一个 (Enter)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
        <button type="button" id="find-case-btn" class="find-btn" title="区分大小写">Aa</button>
        <button type="button" id="find-word-btn" class="find-btn" title="全词匹配">W</button>
        <button type="button" id="find-regex-btn" class="find-btn" title="使用正则表达式">.*</button>
        <button type="button" id="find-toggle-replace" class="find-btn" title="展开/收起替换 (Ctrl+H)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>
        </button>
        <button type="button" id="find-close-btn" class="find-btn close-btn" title="关闭 (Esc)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
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
  const wordBtn = bar.querySelector("#find-word-btn") as HTMLElement;
  const regexBtn = bar.querySelector("#find-regex-btn") as HTMLElement;
  const toggleReplaceBtn = bar.querySelector("#find-toggle-replace") as HTMLElement;
  const closeBtn = bar.querySelector("#find-close-btn") as HTMLElement;
  const replaceRow = bar.querySelector("#replace-row") as HTMLElement;
  const replaceBtn = bar.querySelector("#replace-btn") as HTMLElement;
  const replaceAllBtn = bar.querySelector("#replace-all-btn") as HTMLElement;

  let isCaseSensitive = false;
  let isWholeWord = false;
  let isRegex = false;
  let matches: Array<{ from: number; to: number }> = [];
  let activeRegex: RegExp | null = null;
  let currentIndex = -1;

  function clearTableSearchHighlights() {
    view.dom.querySelectorAll(".tbl-search-hit").forEach((el) => {
      el.classList.remove("tbl-search-hit");
    });
  }

  function highlightTableCellIfInsideTable(matchFrom: number) {
    clearTableSearchHighlights();
    if (!activeRegex) return;
    const tables = findTablesInDoc(view.state);
    const hitTable = tables.find((t) => matchFrom >= t.from && matchFrom <= t.to);
    if (!hitTable) return;

    const fig =
      view.dom.querySelector<HTMLElement>(
        `figure.table-figure[data-from-pos="${hitTable.from}"], figure.table-figure[data-fromPos="${hitTable.from}"]`
      ) ||
      Array.from(view.dom.querySelectorAll<HTMLElement>("figure.table-figure")).find(
        (f) => Number(f.dataset.fromPos) === hitTable.from
      );
    if (!fig) return;

    const checkRe = new RegExp(activeRegex.source, activeRegex.flags.replace("g", ""));
    fig.querySelectorAll<HTMLElement>("th, td").forEach((cell) => {
      if (checkRe.test(cell.textContent || "")) {
        cell.classList.add("tbl-search-hit");
      }
    });
    fig.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function performSearch(moveSelection: boolean = true) {
    const query = findInput.value;
    matches = [];
    activeRegex = null;
    currentIndex = -1;
    clearTableSearchHighlights();
    findInput.classList.remove("regex-error");

    if (!query) {
      findCount.textContent = "0/0";
      view.dispatch({
        effects: [setSearchMatchesEffect.of(null)],
      });
      return;
    }

    const docText = view.state.doc.toString();

    try {
      let pattern = isRegex ? query : escapeRegExp(query);
      if (isWholeWord) {
        pattern = `\\b(?:${pattern})\\b`;
      }
      const flags = isCaseSensitive ? "g" : "gi";
      const re = new RegExp(pattern, flags);
      activeRegex = re;
      let m: RegExpExecArray | null;
      while ((m = re.exec(docText)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        matches.push({ from: m.index, to: m.index + m[0].length });
      }
    } catch {
      findInput.classList.add("regex-error");
      findCount.textContent = "语法错误";
      view.dispatch({
        effects: [setSearchMatchesEffect.of(null)],
      });
      return;
    }

    if (matches.length > 0) {
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
        effects: [setSearchMatchesEffect.of({ matches, currentIndex })],
      });
      highlightTableCellIfInsideTable(m.from);
    } else {
      view.dispatch({
        effects: [setSearchMatchesEffect.of({ matches, currentIndex })],
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

  wordBtn.addEventListener("click", () => {
    isWholeWord = !isWholeWord;
    wordBtn.classList.toggle("active", isWholeWord);
    performSearch(true);
  });

  regexBtn.addEventListener("click", () => {
    isRegex = !isRegex;
    regexBtn.classList.toggle("active", isRegex);
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

      const sel = view.state.selection.main;
      if (!sel.empty && sel.to - sel.from < 100) {
        const text = view.state.sliceDoc(sel.from, sel.to).trim();
        if (text && !text.includes("\n")) {
          findInput.value = text;
        }
      } else {
        const domSel = window.getSelection()?.toString().trim() || "";
        if (domSel && domSel.length < 100 && !domSel.includes("\n")) {
          findInput.value = domSel;
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
      clearTableSearchHighlights();
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
