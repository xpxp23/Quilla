/**
 * 优雅的 Typora 风格全量快捷键速查指南组件 (Shortcut Guide Modal)
 */

interface ShortcutItem {
  category: "常用操作" | "文本排版" | "标题层级" | "表格与图表" | "视图切换";
  name: string;
  keys: string[];
  desc?: string;
}

const SHORTCUT_LIST: ShortcutItem[] = [
  // 常用操作
  { category: "常用操作", name: "新建文档", keys: ["Ctrl", "N"] },
  { category: "常用操作", name: "新建独立窗口", keys: ["Ctrl", "Shift", "N"] },
  { category: "常用操作", name: "打开文件", keys: ["Ctrl", "O"] },
  { category: "常用操作", name: "保存文档", keys: ["Ctrl", "S"] },
  { category: "常用操作", name: "另存为", keys: ["Ctrl", "Shift", "S"] },
  { category: "常用操作", name: "快速文件漫游", keys: ["Ctrl", "P"] },
  { category: "常用操作", name: "撤销 / 重做", keys: ["Ctrl", "Z"], desc: "重做 Ctrl+Y" },
  { category: "常用操作", name: "查找 / 替换", keys: ["Ctrl", "F"], desc: "替换 Ctrl+H" },
  { category: "常用操作", name: "打印 / 导出 PDF", keys: ["Ctrl", "Shift", "P"] },

  // 文本排版
  { category: "文本排版", name: "加粗", keys: ["Ctrl", "B"], desc: "**文本** (支持智能反解)" },
  { category: "文本排版", name: "斜体", keys: ["Ctrl", "I"], desc: "*文本* (支持智能反解)" },
  { category: "文本排版", name: "行内代码", keys: ["Ctrl", "E"], desc: "或 Ctrl+`" },
  { category: "文本排版", name: "删除线", keys: ["Ctrl", "Shift", "X"], desc: "~~删除文本~~" },
  { category: "文本排版", name: "荧光高亮", keys: ["Ctrl", "Shift", "H"], desc: "==高亮==" },
  { category: "文本排版", name: "插入超链接", keys: ["Ctrl", "K"], desc: "[文字](链接)" },
  { category: "文本排版", name: "插入图片", keys: ["Ctrl", "Shift", "I"], desc: "保留选中文本为说明" },

  // 标题层级
  { category: "标题层级", name: "一级标题 (H1)", keys: ["Ctrl", "1"], desc: "支持 Ctrl+Alt+1" },
  { category: "标题层级", name: "二级标题 (H2)", keys: ["Ctrl", "2"], desc: "支持 Ctrl+Alt+2" },
  { category: "标题层级", name: "三级标题 (H3)", keys: ["Ctrl", "3"], desc: "支持 Ctrl+Alt+3" },
  { category: "标题层级", name: "四级标题 (H4)", keys: ["Ctrl", "4"], desc: "支持 Ctrl+Alt+4" },
  { category: "标题层级", name: "五级标题 (H5)", keys: ["Ctrl", "5"], desc: "支持 Ctrl+Alt+5" },
  { category: "标题层级", name: "六级标题 (H6)", keys: ["Ctrl", "6"], desc: "支持 Ctrl+Alt+6" },
  { category: "标题层级", name: "清除标题 (正文)", keys: ["Ctrl", "0"], desc: "支持 Ctrl+Alt+0" },

  // 表格与图表
  { category: "表格与图表", name: "插入表格", keys: ["Ctrl", "Alt", "T"], desc: "插入可视化交互表格" },
  { category: "表格与图表", name: "表格下方插入行", keys: ["Ctrl", "Enter"], desc: "末格 Tab/Enter 自动加行" },
  { category: "表格与图表", name: "表格删除当前行", keys: ["Ctrl", "Shift", "Backspace"] },
  { category: "表格与图表", name: "单元格内换行", keys: ["Shift", "Enter"], desc: "自动插入安全 <br>" },
  { category: "表格与图表", name: "插入代码块", keys: ["Ctrl", "Shift", "K"], desc: "点击右上角切换语言" },
  { category: "表格与图表", name: "插入数学公式块", keys: ["Ctrl", "Shift", "M"], desc: "$$ 独立公式块 $$" },

  // 视图切换
  { category: "视图切换", name: "打字机模式", keys: ["F9"], desc: "当前行平滑锁频居中" },
  { category: "视图切换", name: "专注模式", keys: ["F8"], desc: "当前块高清高亮，其余淡化" },
  { category: "视图切换", name: "切换源码模式", keys: ["Ctrl", "/"], desc: "所见即所得 / 源码切换" },
  { category: "视图切换", name: "展开/收拢侧边栏", keys: ["Ctrl", "Shift", "L"] },
  { category: "视图切换", name: "快捷键速查指南", keys: ["F1"] },
];

let guideModalEl: HTMLElement | null = null;

export function openShortcutGuide() {
  if (guideModalEl) {
    guideModalEl.classList.remove("hidden");
    const input = guideModalEl.querySelector(".shortcut-search-input") as HTMLInputElement;
    if (input) {
      input.value = "";
      input.focus();
      filterShortcuts("");
    }
    return;
  }

  guideModalEl = document.createElement("div");
  guideModalEl.id = "shortcut-guide-modal";
  guideModalEl.className = "ty-modal-overlay";
  guideModalEl.innerHTML = `
    <div class="ty-modal-card">
      <div class="ty-modal-header">
        <div class="modal-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect><line x1="6" y1="8" x2="6.01" y2="8"></line><line x1="10" y1="8" x2="10.01" y2="8"></line><line x1="14" y1="8" x2="14.01" y2="8"></line><line x1="18" y1="8" x2="18.01" y2="8"></line><line x1="8" y1="16" x2="16" y2="16"></line></svg>
          <span>快捷键速查指南</span>
          <span class="modal-badge">Quilla</span>
        </div>
        <button type="button" class="modal-close-btn" title="关闭 (Esc)">✕</button>
      </div>

      <div class="shortcut-search-bar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" class="shortcut-search-input" placeholder="输入功能名称或快捷键搜索..." />
      </div>

      <div class="shortcut-categories-container" id="shortcut-items-grid"></div>

      <div class="ty-modal-footer">
        <span class="footer-tip">提示：在表格中支持四向方向键与 <kbd>Tab</kbd> 跳格，按 <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 快速插入新行</span>
        <button type="button" class="modal-confirm-btn">我知道了</button>
      </div>
    </div>
  `;

  document.body.appendChild(guideModalEl);

  const closeBtn = guideModalEl.querySelector(".modal-close-btn");
  const confirmBtn = guideModalEl.querySelector(".modal-confirm-btn");
  const searchInput = guideModalEl.querySelector(".shortcut-search-input") as HTMLInputElement;

  const closeModal = () => {
    guideModalEl?.classList.add("hidden");
  };

  closeBtn?.addEventListener("click", closeModal);
  confirmBtn?.addEventListener("click", closeModal);

  guideModalEl.addEventListener("click", (e) => {
    if (e.target === guideModalEl) {
      closeModal();
    }
  });

  searchInput?.addEventListener("input", () => {
    filterShortcuts(searchInput.value.trim().toLowerCase());
  });

  renderShortcutGrid(SHORTCUT_LIST);
  searchInput?.focus();
}

function filterShortcuts(query: string) {
  if (!query) {
    renderShortcutGrid(SHORTCUT_LIST);
    return;
  }
  const filtered = SHORTCUT_LIST.filter((item) => {
    return (
      item.name.toLowerCase().includes(query) ||
      item.category.toLowerCase().includes(query) ||
      item.keys.some((k) => k.toLowerCase().includes(query)) ||
      (item.desc && item.desc.toLowerCase().includes(query))
    );
  });
  renderShortcutGrid(filtered);
}

function renderShortcutGrid(items: ShortcutItem[]) {
  const container = document.getElementById("shortcut-items-grid");
  if (!container) return;

  container.innerHTML = "";

  if (items.length === 0) {
    container.innerHTML = `<div class="shortcut-empty">未找到匹配的快捷键</div>`;
    return;
  }

  const categories: Record<string, ShortcutItem[]> = {};
  items.forEach((item) => {
    if (!categories[item.category]) {
      categories[item.category] = [];
    }
    categories[item.category].push(item);
  });

  Object.entries(categories).forEach(([categoryName, groupItems]) => {
    const section = document.createElement("div");
    section.className = "shortcut-section";

    const header = document.createElement("div");
    header.className = "shortcut-section-title";
    header.textContent = categoryName;
    section.appendChild(header);

    const list = document.createElement("div");
    list.className = "shortcut-list";

    groupItems.forEach((item) => {
      const row = document.createElement("div");
      row.className = "shortcut-row";

      const nameBox = document.createElement("div");
      nameBox.className = "shortcut-name-box";

      const title = document.createElement("span");
      title.className = "shortcut-name";
      title.textContent = item.name;
      nameBox.appendChild(title);

      if (item.desc) {
        const desc = document.createElement("span");
        desc.className = "shortcut-desc";
        desc.textContent = item.desc;
        nameBox.appendChild(desc);
      }

      const keysBox = document.createElement("div");
      keysBox.className = "shortcut-keys";
      item.keys.forEach((k, idx) => {
        if (idx > 0) {
          const plus = document.createElement("span");
          plus.className = "key-plus";
          plus.textContent = "+";
          keysBox.appendChild(plus);
        }
        const kbd = document.createElement("kbd");
        kbd.textContent = k;
        keysBox.appendChild(kbd);
      });

      row.appendChild(nameBox);
      row.appendChild(keysBox);
      list.appendChild(row);
    });

    section.appendChild(list);
    container.appendChild(section);
  });
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (guideModalEl && !guideModalEl.classList.contains("hidden")) {
      guideModalEl.classList.add("hidden");
    }
  } else if (e.key === "F1") {
    e.preventDefault();
    openShortcutGuide();
  }
});
