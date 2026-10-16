export interface AppPreferences {
  fontSize: number;
  lineHeight: number;
  maxWidth: "740px" | "860px" | "1020px" | "100%";
  showCodeLineNumbers: boolean;
  compactLinkExpansion: boolean;
  inlineMathTooltip: boolean;
  autoSaveMode: "off" | "onBlur" | "interval";
  autoSaveIntervalSec: number;
  imageFolderMode: "assets" | "filename.assets";
}

const PREF_STORAGE_KEY = "quilla_preferences_v1";

const DEFAULT_PREFERENCES: AppPreferences = {
  fontSize: 15,
  lineHeight: 1.75,
  maxWidth: "860px",
  showCodeLineNumbers: true,
  compactLinkExpansion: true,
  inlineMathTooltip: true,
  autoSaveMode: "off",
  autoSaveIntervalSec: 30,
  imageFolderMode: "assets",
};

let currentPrefs: AppPreferences = loadPreferencesFromStorage();
const listeners: Array<(prefs: AppPreferences) => void> = [];

function loadPreferencesFromStorage(): AppPreferences {
  try {
    const raw = localStorage.getItem(PREF_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_PREFERENCES,
      ...parsed,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function getPreferences(): AppPreferences {
  return currentPrefs;
}

export function updatePreferences(partial: Partial<AppPreferences>) {
  currentPrefs = { ...currentPrefs, ...partial };
  try {
    localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(currentPrefs));
  } catch (e) {
    console.error("保存偏好设置失败:", e);
  }
  applyPreferencesToDOM(currentPrefs);
  listeners.forEach((fn) => fn(currentPrefs));
}

export function onPreferencesChange(cb: (prefs: AppPreferences) => void) {
  listeners.push(cb);
}

export function applyPreferencesToDOM(prefs: AppPreferences = currentPrefs) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--editor-font-size", `${prefs.fontSize}px`);
  root.style.setProperty("--editor-line-height", String(prefs.lineHeight));
  root.style.setProperty("--editor-max-width", prefs.maxWidth);
  document.body.classList.toggle("show-code-line-numbers", prefs.showCodeLineNumbers);
}

let prefModalEl: HTMLElement | null = null;

export function openPreferencesModal() {
  if (prefModalEl) {
    syncFormWithPreferences(prefModalEl, currentPrefs);
    prefModalEl.classList.remove("hidden");
    return;
  }

  prefModalEl = document.createElement("div");
  prefModalEl.id = "quilla-preferences-modal";
  prefModalEl.className = "ty-modal-overlay";
  prefModalEl.innerHTML = `
    <div class="ty-modal-card pref-modal-card" role="dialog" aria-modal="true">
      <div class="ty-modal-header">
        <div class="modal-title">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          <span>偏好设置</span>
          <span class="modal-badge">Ctrl + ,</span>
        </div>
        <button type="button" class="modal-close-btn" id="pref-close-btn" title="关闭 (Esc)">✕</button>
      </div>

      <div class="pref-modal-body">
        <div class="pref-section">
          <div class="pref-section-title">排版与阅读视口</div>
          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">正文字号大小</span>
              <span class="pref-desc">调整编辑区基础字号 (13px ~ 22px)</span>
            </div>
            <div class="pref-control">
              <input type="range" id="pref-font-size" min="13" max="22" step="1" />
              <span class="pref-val-badge" id="pref-font-size-val">15px</span>
            </div>
          </div>

          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">段落行高比例</span>
              <span class="pref-desc">控制正文垂直呼吸感 (1.5 ~ 2.1)</span>
            </div>
            <div class="pref-control">
              <input type="range" id="pref-line-height" min="1.5" max="2.1" step="0.05" />
              <span class="pref-val-badge" id="pref-line-height-val">1.75</span>
            </div>
          </div>

          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">版心最大宽度</span>
              <span class="pref-desc">适配专注阅读或宽屏大表格展示</span>
            </div>
            <div class="pref-control">
              <select id="pref-max-width" class="pref-select">
                <option value="740px">紧凑书页 (740px)</option>
                <option value="860px">标准版心 (860px)</option>
                <option value="1020px">宽屏学术 (1020px)</option>
                <option value="100%">全宽铺满 (100%)</option>
              </select>
            </div>
          </div>
        </div>

        <div class="pref-section">
          <div class="pref-section-title">所见即所得与代码块</div>
          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">显示代码块行号</span>
              <span class="pref-desc">在多语言围栏代码块左侧展示对齐行号</span>
            </div>
            <div class="pref-control">
              <input type="checkbox" id="pref-code-linenum" class="pref-checkbox" />
            </div>
          </div>

          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">超链接防抖动紧凑模式</span>
              <span class="pref-desc">光标在链接文字内移动时不展开长 URL，仅在边界或点击编辑时展开</span>
            </div>
            <div class="pref-control">
              <input type="checkbox" id="pref-compact-link" class="pref-checkbox" />
            </div>
          </div>

          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">行内数学公式实时浮窗预览</span>
              <span class="pref-desc">编辑 $...$ 行内公式源码时在上方浮出 KaTeX 渲染预览</span>
            </div>
            <div class="pref-control">
              <input type="checkbox" id="pref-math-tooltip" class="pref-checkbox" />
            </div>
          </div>
        </div>

        <div class="pref-section">
          <div class="pref-section-title">自动保存与图片资产</div>
          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">自动保存策略</span>
              <span class="pref-desc">对已命名本地文档自动执行原子写入落盘</span>
            </div>
            <div class="pref-control">
              <select id="pref-autosave-mode" class="pref-select">
                <option value="off">仅手动保存 (附带崩溃快照保护)</option>
                <option value="onBlur">窗口失焦时自动保存</option>
                <option value="interval">定时自动保存 (每 30 秒)</option>
              </select>
            </div>
          </div>

          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">粘贴/拖入图片存储目录</span>
              <span class="pref-desc">设置本地图片相对路径的文件夹命名规则</span>
            </div>
            <div class="pref-control">
              <select id="pref-img-folder" class="pref-select">
                <option value="assets">统一存放至 ./assets/</option>
                <option value="filename.assets">按文档名存放至 ./\${filename}.assets/</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div class="ty-modal-footer">
        <button type="button" class="save-dialog-btn btn-discard" id="pref-reset-btn">恢复默认设置</button>
        <button type="button" class="modal-confirm-btn" id="pref-done-btn">完成</button>
      </div>
    </div>
  `;

  document.body.appendChild(prefModalEl);
  syncFormWithPreferences(prefModalEl, currentPrefs);

  const close = () => prefModalEl?.classList.add("hidden");
  prefModalEl.querySelector("#pref-close-btn")?.addEventListener("click", close);
  prefModalEl.querySelector("#pref-done-btn")?.addEventListener("click", close);
  prefModalEl.addEventListener("click", (e) => {
    if (e.target === prefModalEl) close();
  });

  const fontSizeInput = prefModalEl.querySelector("#pref-font-size") as HTMLInputElement;
  const fontSizeVal = prefModalEl.querySelector("#pref-font-size-val") as HTMLElement;
  fontSizeInput.addEventListener("input", () => {
    const val = Number(fontSizeInput.value);
    fontSizeVal.textContent = `${val}px`;
    updatePreferences({ fontSize: val });
  });

  const lineHeightInput = prefModalEl.querySelector("#pref-line-height") as HTMLInputElement;
  const lineHeightVal = prefModalEl.querySelector("#pref-line-height-val") as HTMLElement;
  lineHeightInput.addEventListener("input", () => {
    const val = Number(lineHeightInput.value);
    lineHeightVal.textContent = val.toFixed(2).replace(/\.00$/, "");
    updatePreferences({ lineHeight: val });
  });

  const maxWidthSelect = prefModalEl.querySelector("#pref-max-width") as HTMLSelectElement;
  maxWidthSelect.addEventListener("change", () => {
    updatePreferences({ maxWidth: maxWidthSelect.value as AppPreferences["maxWidth"] });
  });

  const codeLineNumCheck = prefModalEl.querySelector("#pref-code-linenum") as HTMLInputElement;
  codeLineNumCheck.addEventListener("change", () => {
    updatePreferences({ showCodeLineNumbers: codeLineNumCheck.checked });
  });

  const compactLinkCheck = prefModalEl.querySelector("#pref-compact-link") as HTMLInputElement;
  compactLinkCheck.addEventListener("change", () => {
    updatePreferences({ compactLinkExpansion: compactLinkCheck.checked });
  });

  const mathTooltipCheck = prefModalEl.querySelector("#pref-math-tooltip") as HTMLInputElement;
  mathTooltipCheck.addEventListener("change", () => {
    updatePreferences({ inlineMathTooltip: mathTooltipCheck.checked });
  });

  const autoSaveSelect = prefModalEl.querySelector("#pref-autosave-mode") as HTMLSelectElement;
  autoSaveSelect.addEventListener("change", () => {
    updatePreferences({ autoSaveMode: autoSaveSelect.value as AppPreferences["autoSaveMode"] });
  });

  const imgFolderSelect = prefModalEl.querySelector("#pref-img-folder") as HTMLSelectElement;
  imgFolderSelect.addEventListener("change", () => {
    updatePreferences({
      imageFolderMode: imgFolderSelect.value as AppPreferences["imageFolderMode"],
    });
  });

  prefModalEl.querySelector("#pref-reset-btn")?.addEventListener("click", () => {
    updatePreferences({ ...DEFAULT_PREFERENCES });
    if (prefModalEl) syncFormWithPreferences(prefModalEl, currentPrefs);
  });
}

function syncFormWithPreferences(modal: HTMLElement, prefs: AppPreferences) {
  const fontSizeInput = modal.querySelector("#pref-font-size") as HTMLInputElement;
  const fontSizeVal = modal.querySelector("#pref-font-size-val") as HTMLElement;
  if (fontSizeInput && fontSizeVal) {
    fontSizeInput.value = String(prefs.fontSize);
    fontSizeVal.textContent = `${prefs.fontSize}px`;
  }

  const lineHeightInput = modal.querySelector("#pref-line-height") as HTMLInputElement;
  const lineHeightVal = modal.querySelector("#pref-line-height-val") as HTMLElement;
  if (lineHeightInput && lineHeightVal) {
    lineHeightInput.value = String(prefs.lineHeight);
    lineHeightVal.textContent = String(prefs.lineHeight);
  }

  const maxWidthSelect = modal.querySelector("#pref-max-width") as HTMLSelectElement;
  if (maxWidthSelect) maxWidthSelect.value = prefs.maxWidth;

  const codeLineNumCheck = modal.querySelector("#pref-code-linenum") as HTMLInputElement;
  if (codeLineNumCheck) codeLineNumCheck.checked = prefs.showCodeLineNumbers;

  const compactLinkCheck = modal.querySelector("#pref-compact-link") as HTMLInputElement;
  if (compactLinkCheck) compactLinkCheck.checked = prefs.compactLinkExpansion;

  const mathTooltipCheck = modal.querySelector("#pref-math-tooltip") as HTMLInputElement;
  if (mathTooltipCheck) mathTooltipCheck.checked = prefs.inlineMathTooltip;

  const autoSaveSelect = modal.querySelector("#pref-autosave-mode") as HTMLSelectElement;
  if (autoSaveSelect) autoSaveSelect.value = prefs.autoSaveMode;

  const imgFolderSelect = modal.querySelector("#pref-img-folder") as HTMLSelectElement;
  if (imgFolderSelect) imgFolderSelect.value = prefs.imageFolderMode;
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && prefModalEl && !prefModalEl.classList.contains("hidden")) {
    prefModalEl.classList.add("hidden");
  } else if ((e.ctrlKey || e.metaKey) && e.key === ",") {
    e.preventDefault();
    openPreferencesModal();
  }
});
