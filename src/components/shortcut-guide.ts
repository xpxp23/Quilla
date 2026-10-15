/**
 * 优雅的 Typora 风格全量快捷键速查指南组件 (Shortcut Guide Modal)
 */

interface ShortcutItem {
  category: "常用操作" | "文本排版" | "标题层级" | "段落与图表" | "视图切换";
  name: string;
  keys: string[];
  desc?: string;
}

const SHORTCUT_LIST: ShortcutItem[] = [
  // 常用操作
  { category: "常用操作", name: "新建文档", keys: ["Ctrl", "N"] },
  { category: "常用操作", name: "打开文件", keys: ["Ctrl", "O"] },
  { category: "常用操作", name: "保存文档", keys: ["Ctrl", "S"] },
  { category: "常用操作", name: "撤销操作", keys: ["Ctrl", "Z"] },
  { category: "常用操作", name: "重做操作", keys: ["Ctrl", "Y"], desc: "或 Ctrl+Shift+Z" },
  { category: "常用操作", name: "查找内容", keys: ["Ctrl", "F"] },
  { category: "常用操作", name: "查找与替换", keys: ["Ctrl", "H"] },

  // 文本排版
  { category: "文本排版", name: "加粗", keys: ["Ctrl", "B"], desc: "**文本** 或 __文本__" },
  { category: "文本排版", name: "斜体", keys: ["Ctrl", "I"], desc: "*文本* 或 _文本_" },
  { category: "文本排版", name: "行内代码", keys: ["Ctrl", "E"], desc: "`代码`" },
  { category: "文本排版", name: "删除线", keys: ["Ctrl", "Shift", "X"], desc: "~~删除文本~~" },
  { category: "文本排版", name: "高亮标记", keys: ["Ctrl", "Shift", "H"], desc: "==高亮==" },
  { category: "文本排版", name: "插入超链接", keys: ["Ctrl", "K"], desc: "[文字](链接)" },
  { category: "文本排版", name: "插入图片", keys: ["Ctrl", "Shift", "I"], desc: "![说明](路径)" },

  // 标题层级
  { category: "标题层级", name: "一级标题 (H1)", keys: ["Ctrl", "1"], desc: "支持 Ctrl+Alt+1" },
  { category: "标题层级", name: "二级标题 (H2)", keys: ["Ctrl", "2"], desc: "支持 Ctrl+Alt+2" },
  { category: "标题层级", name: "三级标题 (H3)", keys: ["Ctrl", "3"], desc: "支持 Ctrl+Alt+3" },
  { category: "标题层级", name: "四级标题 (H4)", keys: ["Ctrl", "4"], desc: "支持 Ctrl+Alt+4" },
  { category: "标题层级", name: "五级标题 (H5)", keys: ["Ctrl", "5"], desc: "支持 Ctrl+Alt+5" },
  { category: "标题层级", name: "六级标题 (H6)", keys: ["Ctrl", "6"], desc: "支持 Ctrl+Alt+6" },
  { category: "标题层级", name: "清除标题(正文)", keys: ["Ctrl", "0"], desc: "支持 Ctrl+Alt+0" },

  // 段落与图表
  { category: "段落与图表", name: "插入表格", keys: ["Ctrl", "Alt", "T"], desc: "自动插入 3x3 交互表格" },
  { category: "段落与图表", name: "插入代码块", keys: ["Ctrl", "Shift", "K"], desc: "```语言" },
  { category: "段落与图表", name: "插入数学公式块", keys: ["Ctrl", "Shift", "M"], desc: "$$ 公式 $$" },
  { category: "段落与图表", name: "流程图渲染", keys: ["```mermaid"], desc: "自动生成矢量流程图" },
  { category: "段落与图表", name: "表格单元格跳格", keys: ["Tab"], desc: "末格回车自动加行" },

  // 视图切换
  { category: "视图切换", name: "打字机模式", keys: ["F9"], desc: "视线垂直软居中锁定，滚轮自由浏览" },
  { category: "视图切换", name: "专注模式", keys: ["F8"], desc: "段落级视差聚焦，淡化无关文本" },
  { category: "视图切换", name: "切换源码模式", keys: ["Ctrl", "/"], desc: "即时切换所见即所得/源码" },
  { category: "视图切换", name: "展开/收拢侧边栏", keys: ["Ctrl", "Shift", "L"], desc: "或点击底部状态栏" },
  { category: "视图切换", name: "快捷键速查指南", keys: ["F1"], desc: "即刻呼出本指南" },
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

  // 首次创建浮层
  guideModalEl = document.createElement("div");
  guideModalEl.id = "shortcut-guide-modal";
  guideModalEl.className = "ty-modal-overlay";
  guideModalEl.innerHTML = `
    <div class="ty-modal-card">
      <div class="ty-modal-header">
        <div class="modal-title">
          <span class="modal-icon">⌨️</span>
          <span>快捷键速查指南</span>
          <span class="modal-badge">Quilla Pro</span>
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
        <span class="footer-tip">💡 提示：在表格中按 <kbd>Tab</kbd> 可快速跳格，按 <kbd>Esc</kbd> 随时退出指南</span>
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

  // 按分类分组
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

// 绑定全局 Esc 关闭指南弹窗与 F1 开启
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
