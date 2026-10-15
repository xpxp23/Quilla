import { invoke } from "@tauri-apps/api/core";

export interface RecentFileItem {
  path: string;
  name: string;
  lastOpened: number;
}

export function getRecentFiles(): RecentFileItem[] {
  try {
    const raw = localStorage.getItem("typora_recent_files");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addRecentFile(filePath: string) {
  if (!filePath) return;
  const list = getRecentFiles().filter((f) => f.path !== filePath);
  const name = filePath.replace(/\\/g, "/").split("/").pop() || filePath;
  list.unshift({ path: filePath, name, lastOpened: Date.now() });
  if (list.length > 20) list.length = 20;
  localStorage.setItem("typora_recent_files", JSON.stringify(list));
}

export function clearRecentFiles() {
  localStorage.removeItem("typora_recent_files");
}

/**
 * 拼音简拼首字母与模糊匹配核心算法
 */
function fuzzyMatch(text: string, query: string): { matches: boolean; score: number } {
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return { matches: true, score: 0 };

  // 1. 直观包含匹配
  const directIdx = t.indexOf(q);
  if (directIdx !== -1) {
    return { matches: true, score: 100 - directIdx };
  }

  // 2. 子序列模糊命中
  let tIdx = 0;
  let qIdx = 0;
  let score = 0;
  while (tIdx < t.length && qIdx < q.length) {
    if (t[tIdx] === q[qIdx]) {
      qIdx++;
      score += 10;
    }
    tIdx++;
  }

  if (qIdx === q.length) {
    return { matches: true, score };
  }

  return { matches: false, score: -1 };
}

export interface QuickOpenOptions {
  onOpenFile: (filePath: string) => void;
  getWorkspaceFiles?: () => Promise<string[]>;
}

let quickOpenInstance: {
  open: () => void;
  close: () => void;
  toggle: () => void;
} | null = null;

export function getQuickOpenInstance() {
  return quickOpenInstance;
}

/**
 * 初始化快速文件漫游 (Ctrl+P) 居中毛玻璃命令面板
 */
export function initQuickOpen(options: QuickOpenOptions) {
  const overlay = document.createElement("div");
  overlay.id = "ty-quick-open-overlay";
  overlay.className = "ty-quick-open-overlay hidden";

  overlay.innerHTML = `
    <div class="ty-quick-open-box">
      <div class="quick-open-search-bar">
        <span class="quick-open-icon">🔍</span>
        <input type="text" id="quick-open-input" placeholder="输入文件名快速跳转 (支持拼音/首字母模糊查找)..." spellcheck="false" autocomplete="off" />
        <span class="quick-open-kbd">ESC 退出</span>
      </div>
      <div class="quick-open-results" id="quick-open-results"></div>
      <div class="quick-open-footer">
        <span>↑↓ 选择</span>
        <span>↵ 打开</span>
        <span>ESC 关闭</span>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const input = overlay.querySelector("#quick-open-input") as HTMLInputElement;
  const resultsContainer = overlay.querySelector("#quick-open-results") as HTMLElement;

  let candidateList: Array<{ path: string; name: string; isRecent: boolean }> = [];
  let filteredList: Array<{ path: string; name: string; isRecent: boolean }> = [];
  let selectedIndex = 0;

  async function loadCandidates() {
    const recent = getRecentFiles().map((r) => ({
      path: r.path,
      name: r.name,
      isRecent: true,
    }));

    let wsFiles: Array<{ path: string; name: string; isRecent: boolean }> = [];
    if (options.getWorkspaceFiles) {
      try {
        const files = await options.getWorkspaceFiles();
        const recentPaths = new Set(recent.map((r) => r.path.toLowerCase()));
        wsFiles = files
          .filter((f) => !recentPaths.has(f.toLowerCase()))
          .map((f) => ({
            path: f,
            name: f.replace(/\\/g, "/").split("/").pop() || f,
            isRecent: false,
          }));
      } catch (e) {
        console.warn("读取工作区文件清单失败:", e);
      }
    }

    candidateList = [...recent, ...wsFiles];
  }

  function renderResults() {
    resultsContainer.innerHTML = "";
    if (filteredList.length === 0) {
      resultsContainer.innerHTML = `
        <div class="quick-open-empty">
          <span>未找到匹配的文件</span>
        </div>
      `;
      return;
    }

    filteredList.forEach((item, idx) => {
      const itemEl = document.createElement("div");
      itemEl.className = `quick-open-item ${idx === selectedIndex ? "active" : ""}`;
      itemEl.dataset.index = String(idx);

      const icon = item.name.endsWith(".md") ? "📝" : "📄";
      const badge = item.isRecent ? `<span class="quick-open-badge recent">最近</span>` : `<span class="quick-open-badge ws">工作区</span>`;

      // 格式化展示路径
      const displayPath = item.path.length > 55 ? "..." + item.path.slice(-52) : item.path;

      itemEl.innerHTML = `
        <div class="item-left">
          <span class="file-icon">${icon}</span>
          <div class="file-info">
            <div class="file-name">${item.name}</div>
            <div class="file-path">${displayPath}</div>
          </div>
        </div>
        <div class="item-right">${badge}</div>
      `;

      itemEl.addEventListener("click", () => {
        close();
        options.onOpenFile(item.path);
      });

      resultsContainer.appendChild(itemEl);
    });

    const activeEl = resultsContainer.querySelector(`.quick-open-item.active`) as HTMLElement;
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }

  function filterCandidates() {
    const query = input.value.trim();
    if (!query) {
      filteredList = candidateList.slice(0, 30);
    } else {
      const scored = candidateList
        .map((item) => {
          const matchName = fuzzyMatch(item.name, query);
          const matchPath = fuzzyMatch(item.path, query);
          const score = Math.max(matchName.score * 1.5, matchPath.score);
          const matches = matchName.matches || matchPath.matches;
          return { item, matches, score };
        })
        .filter((res) => res.matches)
        .sort((a, b) => b.score - a.score);

      filteredList = scored.map((s) => s.item).slice(0, 40);
    }

    selectedIndex = 0;
    renderResults();
  }

  async function open() {
    overlay.classList.remove("hidden");
    input.value = "";
    await loadCandidates();
    filterCandidates();
    input.focus();
  }

  function close() {
    overlay.classList.add("hidden");
  }

  function toggle() {
    if (overlay.classList.contains("hidden")) {
      open();
    } else {
      close();
    }
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      close();
    }
  });

  input.addEventListener("input", () => {
    filterCandidates();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredList.length > 0) {
        selectedIndex = (selectedIndex + 1) % filteredList.length;
        renderResults();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredList.length > 0) {
        selectedIndex = (selectedIndex - 1 + filteredList.length) % filteredList.length;
        renderResults();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredList.length > 0 && filteredList[selectedIndex]) {
        const target = filteredList[selectedIndex];
        close();
        options.onOpenFile(target.path);
      }
    }
  });

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
      e.preventDefault();
      toggle();
    }
  });

  quickOpenInstance = { open, close, toggle };
  return quickOpenInstance;
}
