import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./save-dialog";

export interface ImageBedPreferences {
  provider: "none" | "picgo" | "github" | "custom";
  picgoUrl: string;
  githubRepo: string;
  githubBranch: string;
  githubToken: string;
  githubPathPrefix: string;
  githubCustomDomain: string;
  customUploadUrl: string;
  customAuthHeader: string;
}

export interface AppPreferences {
  fontSize: number;
  lineHeight: number;
  maxWidth: "740px" | "860px" | "1020px" | "100%";
  showCodeLineNumbers: boolean;
  compactLinkExpansion: boolean;
  inlineMathTooltip: boolean;
  autoHideSingleTab: boolean;
  autoSaveMode: "off" | "onBlur" | "interval";
  autoSaveIntervalSec: number;
  imageFolderMode: "assets" | "filename.assets" | "current_dir" | "custom";
  customImageFolder: string;
  imageNamingMode: "timestamp" | "original";
  autoUploadImageToBed: boolean;
  imageBedConfig: ImageBedPreferences;
  inlineExportImages: boolean;
  fileAssociationExtensions: string[];
  registerContextMenu: boolean;
}

const PREF_STORAGE_KEY = "quilla_preferences_v1";

const DEFAULT_IMAGE_BED_CONFIG: ImageBedPreferences = {
  provider: "none",
  picgoUrl: "http://127.0.0.1:36677/upload",
  githubRepo: "",
  githubBranch: "main",
  githubToken: "",
  githubPathPrefix: "assets",
  githubCustomDomain: "",
  customUploadUrl: "",
  customAuthHeader: "",
};

const DEFAULT_PREFERENCES: AppPreferences = {
  fontSize: 15,
  lineHeight: 1.75,
  maxWidth: "860px",
  showCodeLineNumbers: true,
  compactLinkExpansion: true,
  inlineMathTooltip: true,
  autoHideSingleTab: false,
  autoSaveMode: "off",
  autoSaveIntervalSec: 30,
  imageFolderMode: "assets",
  customImageFolder: "./assets",
  imageNamingMode: "timestamp",
  autoUploadImageToBed: false,
  imageBedConfig: { ...DEFAULT_IMAGE_BED_CONFIG },
  inlineExportImages: true,
  fileAssociationExtensions: [".md", ".markdown", ".mdown"],
  registerContextMenu: true,
};

let currentPrefs: AppPreferences = loadPreferencesFromStorage();
const listeners: Array<(prefs: AppPreferences) => void> = [];

function loadPreferencesFromStorage(): AppPreferences {
  try {
    const raw = localStorage.getItem(PREF_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES, imageBedConfig: { ...DEFAULT_IMAGE_BED_CONFIG } };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_PREFERENCES,
      ...parsed,
      imageBedConfig: {
        ...DEFAULT_IMAGE_BED_CONFIG,
        ...(parsed.imageBedConfig || {}),
      },
    };
  } catch {
    return { ...DEFAULT_PREFERENCES, imageBedConfig: { ...DEFAULT_IMAGE_BED_CONFIG } };
  }
}

export function getPreferences(): AppPreferences {
  return currentPrefs;
}

export function updatePreferences(partial: Partial<AppPreferences>) {
  currentPrefs = {
    ...currentPrefs,
    ...partial,
    imageBedConfig: partial.imageBedConfig
      ? { ...currentPrefs.imageBedConfig, ...partial.imageBedConfig }
      : currentPrefs.imageBedConfig,
  };
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
  root.classList.toggle("show-code-line-numbers", prefs.showCodeLineNumbers);
  document.body?.classList.toggle("show-code-line-numbers", prefs.showCodeLineNumbers);
  document.body?.classList.toggle("auto-hide-single-tab", prefs.autoHideSingleTab);
}

let prefModalEl: HTMLElement | null = null;

async function refreshFileAssociationStatus(modal: HTMLElement) {
  const badgeEl = modal.querySelector("#pref-assoc-status-badge") as HTMLElement | null;
  const contextCheck = modal.querySelector("#pref-context-menu-check") as HTMLInputElement | null;
  if (!badgeEl) return;

  try {
    const status = await invoke<{
      isRegistered: boolean;
      hasContextMenu: boolean;
      userChoiceProgId: string;
      platform: string;
    }>("get_file_association_status");

    if (contextCheck && typeof status.hasContextMenu === "boolean") {
      contextCheck.checked = status.hasContextMenu;
    }

    if (status.isRegistered) {
      if (
        status.userChoiceProgId &&
        !status.userChoiceProgId.toLowerCase().includes("quilla") &&
        status.platform === "windows"
      ) {
        badgeEl.className = "pref-status-pill warn";
        badgeEl.textContent = `已注册 ProgID · 需在系统弹窗勾选“始终使用” (当前: ${status.userChoiceProgId})`;
      } else {
        badgeEl.className = "pref-status-pill ok";
        badgeEl.textContent = "已关联为系统默认 Markdown 程序";
      }
    } else {
      badgeEl.className = "pref-status-pill idle";
      badgeEl.textContent = "尚未关联为系统默认程序";
    }
  } catch {
    badgeEl.className = "pref-status-pill idle";
    badgeEl.textContent = "桌面环境就绪";
  }
}

export function openPreferencesModal() {
  if (prefModalEl) {
    syncFormWithPreferences(prefModalEl, currentPrefs);
    refreshFileAssociationStatus(prefModalEl);
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

          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">单标签时自动收起顶部标签栏</span>
              <span class="pref-desc">仅打开 1 篇文档且未开启分屏时自动隐藏标签栏，呈现极致留白</span>
            </div>
            <div class="pref-control">
              <input type="checkbox" id="pref-autohide-tab" class="pref-checkbox" />
            </div>
          </div>
        </div>

        <div class="pref-section">
          <div class="pref-section-title">所见即所得与代码块</div>
          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">显示代码块行号</span>
              <span class="pref-desc">在多语言围栏代码块左侧展示对齐行号（点击行号可选中整行）</span>
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
          <div class="pref-section-title">系统文件接管与自动保存 (单实例秒开架构)</div>
          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">
                默认打开 Markdown 文件
                <span class="pref-status-pill idle" id="pref-assoc-status-badge">检测中...</span>
              </span>
              <span class="pref-desc">写入系统 ProgID / OpenWithProgids 注册表并唤起 OpenWith.exe 原生打开方式弹窗；双击任意 .md 自动由当前运行实例单窗口秒开</span>
              <div class="pref-ext-checks" id="pref-ext-checks">
                <label class="pref-ext-chip"><input type="checkbox" value=".md" checked /> .md</label>
                <label class="pref-ext-chip"><input type="checkbox" value=".markdown" checked /> .markdown</label>
                <label class="pref-ext-chip"><input type="checkbox" value=".mdown" checked /> .mdown</label>
                <label class="pref-ext-chip"><input type="checkbox" value=".txt" /> .txt</label>
              </div>
            </div>
            <div class="pref-control">
              <button type="button" class="pref-action-btn" id="pref-set-default-md-btn">设为默认打开程序</button>
            </div>
          </div>

          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">资源管理器右键菜单集成</span>
              <span class="pref-desc">在 Windows 文件资源管理器右键菜单中添加「用 Quilla (羽墨) 打开」快捷入口</span>
            </div>
            <div class="pref-control">
              <input type="checkbox" id="pref-context-menu-check" class="pref-checkbox" />
            </div>
          </div>

          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">自动保存策略</span>
              <span class="pref-desc">对已命名本地文档自动执行原子写入落盘（配合时间机器历史快照与符号链接保护）</span>
            </div>
            <div class="pref-control">
              <select id="pref-autosave-mode" class="pref-select">
                <option value="off">仅手动保存 (附带崩溃快照保护)</option>
                <option value="onBlur">窗口失焦时自动保存</option>
                <option value="interval">定时自动保存 (每 30 秒)</option>
              </select>
            </div>
          </div>
        </div>

        <div class="pref-section">
          <div class="pref-section-title">图片资产管家与云端图床服务</div>
          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">粘贴/拖入图片本地存储目录</span>
              <span class="pref-desc">完全兼容 Typora 习惯，重命名或删除文档时自动同步迁移或清理专属资源目录</span>
            </div>
            <div class="pref-control">
              <select id="pref-img-folder" class="pref-select">
                <option value="assets">统一存放至 ./assets/</option>
                <option value="filename.assets">按文档名存放至 ./\${filename}.assets/ (Typora 习惯)</option>
                <option value="current_dir">存放至当前文档同级目录 ./</option>
                <option value="custom">自定义相对路径文件夹...</option>
              </select>
            </div>
          </div>

          <div class="pref-row hidden" id="pref-custom-img-folder-row">
            <div class="pref-label-group">
              <span class="pref-label">自定义图片相对目录模板</span>
              <span class="pref-desc">支持使用 \${filename} 占位符（例如：./images/\${filename}）</span>
            </div>
            <div class="pref-control">
              <input type="text" id="pref-custom-img-folder" class="pref-text-input" placeholder="./images/\${filename}" />
            </div>
          </div>

          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">图床服务通道 (PicGo / GitHub / S3 Webhook)</span>
              <span class="pref-desc">配置后可通过图片悬浮工具栏「上传图床」一键转换，或开启粘贴时自动上传</span>
            </div>
            <div class="pref-control">
              <select id="pref-img-bed-provider" class="pref-select">
                <option value="none">仅本地相对路径存储 (不启用图床)</option>
                <option value="picgo">PicGo 本地服务 (127.0.0.1:36677)</option>
                <option value="github">GitHub 仓库图床 (API + jsDelivr)</option>
                <option value="custom">自定义 S3 / HTTP Webhook 图床</option>
              </select>
            </div>
          </div>

          <div class="pref-bed-config-box hidden" id="pref-bed-picgo-box">
            <div class="pref-bed-field">
              <label>PicGo Server 接口地址</label>
              <input type="text" id="pref-bed-picgo-url" class="pref-text-input" placeholder="http://127.0.0.1:36677/upload" />
            </div>
          </div>

          <div class="pref-bed-config-box hidden" id="pref-bed-github-box">
            <div class="pref-bed-grid">
              <div class="pref-bed-field">
                <label>GitHub 仓库 (owner/repo)</label>
                <input type="text" id="pref-bed-gh-repo" class="pref-text-input" placeholder="username/blog-images" />
              </div>
              <div class="pref-bed-field">
                <label>分支名 (Branch)</label>
                <input type="text" id="pref-bed-gh-branch" class="pref-text-input" placeholder="main" />
              </div>
              <div class="pref-bed-field">
                <label>Personal Access Token</label>
                <input type="password" id="pref-bed-gh-token" class="pref-text-input" placeholder="ghp_xxxxxxxxxxxx" />
              </div>
              <div class="pref-bed-field">
                <label>自定义 CDN 域名 (可选，默认 jsDelivr)</label>
                <input type="text" id="pref-bed-gh-domain" class="pref-text-input" placeholder="https://cdn.jsdelivr.net/gh/user/repo@main" />
              </div>
            </div>
          </div>

          <div class="pref-bed-config-box hidden" id="pref-bed-custom-box">
            <div class="pref-bed-grid">
              <div class="pref-bed-field">
                <label>Webhook / S3 签名上传接口 URL (POST JSON)</label>
                <input type="text" id="pref-bed-custom-url" class="pref-text-input" placeholder="https://img.example.com/api/upload" />
              </div>
              <div class="pref-bed-field">
                <label>Authorization 请求头 (可选)</label>
                <input type="password" id="pref-bed-custom-auth" class="pref-text-input" placeholder="Bearer xxxxx" />
              </div>
            </div>
          </div>

          <div class="pref-row" id="pref-auto-upload-row">
            <div class="pref-label-group">
              <span class="pref-label">粘贴或拖入图片时自动上传图床</span>
              <span class="pref-desc">开启后粘贴/拖入图片自动上传至所选图床并插入远程链接（失败时自动降级存为本地相对路径）</span>
            </div>
            <div class="pref-control">
              <input type="checkbox" id="pref-auto-upload-bed" class="pref-checkbox" />
            </div>
          </div>

          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">导出 HTML / Word 时内联本地图片</span>
              <span class="pref-desc">导出时自动将本地相对路径图片转换为 Base64 DataURL 内嵌，保证单文件跨设备分享不裂图</span>
            </div>
            <div class="pref-control">
              <input type="checkbox" id="pref-inline-export-img" class="pref-checkbox" />
            </div>
          </div>

          <div class="pref-row">
            <div class="pref-label-group">
              <span class="pref-label">清理未引用的孤儿图片资源</span>
              <span class="pref-desc">扫描当前工作区或文档目录下的 assets / *.assets 文件夹，清理未被任何笔记引用的冗余图片</span>
            </div>
            <div class="pref-control">
              <button type="button" class="pref-action-btn secondary" id="pref-cleanup-assets-btn">清理孤儿图片</button>
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
  refreshFileAssociationStatus(prefModalEl);

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

  const autoHideTabCheck = prefModalEl.querySelector("#pref-autohide-tab") as HTMLInputElement;
  autoHideTabCheck.addEventListener("change", () => {
    updatePreferences({ autoHideSingleTab: autoHideTabCheck.checked });
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
  const customFolderRow = prefModalEl.querySelector("#pref-custom-img-folder-row") as HTMLElement;
  const customFolderInput = prefModalEl.querySelector("#pref-custom-img-folder") as HTMLInputElement;

  imgFolderSelect.addEventListener("change", () => {
    const mode = imgFolderSelect.value as AppPreferences["imageFolderMode"];
    customFolderRow?.classList.toggle("hidden", mode !== "custom");
    updatePreferences({ imageFolderMode: mode });
  });

  customFolderInput?.addEventListener("change", () => {
    updatePreferences({ customImageFolder: customFolderInput.value.trim() || "./assets" });
  });

  const bedProviderSelect = prefModalEl.querySelector("#pref-img-bed-provider") as HTMLSelectElement;
  const syncBedBoxes = (provider: string) => {
    prefModalEl?.querySelector("#pref-bed-picgo-box")?.classList.toggle("hidden", provider !== "picgo");
    prefModalEl?.querySelector("#pref-bed-github-box")?.classList.toggle("hidden", provider !== "github");
    prefModalEl?.querySelector("#pref-bed-custom-box")?.classList.toggle("hidden", provider !== "custom");
  };

  bedProviderSelect?.addEventListener("change", () => {
    const provider = bedProviderSelect.value as ImageBedPreferences["provider"];
    syncBedBoxes(provider);
    updatePreferences({
      imageBedConfig: {
        ...currentPrefs.imageBedConfig,
        provider,
      },
    });
  });

  const bindBedInput = (selector: string, key: keyof ImageBedPreferences) => {
    const inp = prefModalEl?.querySelector(selector) as HTMLInputElement | null;
    inp?.addEventListener("change", () => {
      updatePreferences({
        imageBedConfig: {
          ...currentPrefs.imageBedConfig,
          [key]: inp.value.trim(),
        },
      });
    });
  };
  bindBedInput("#pref-bed-picgo-url", "picgoUrl");
  bindBedInput("#pref-bed-gh-repo", "githubRepo");
  bindBedInput("#pref-bed-gh-branch", "githubBranch");
  bindBedInput("#pref-bed-gh-token", "githubToken");
  bindBedInput("#pref-bed-gh-domain", "githubCustomDomain");
  bindBedInput("#pref-bed-custom-url", "customUploadUrl");
  bindBedInput("#pref-bed-custom-auth", "customAuthHeader");

  const autoUploadCheck = prefModalEl.querySelector("#pref-auto-upload-bed") as HTMLInputElement;
  autoUploadCheck?.addEventListener("change", () => {
    updatePreferences({ autoUploadImageToBed: autoUploadCheck.checked });
  });

  const inlineExportImgCheck = prefModalEl.querySelector(
    "#pref-inline-export-img"
  ) as HTMLInputElement;
  inlineExportImgCheck?.addEventListener("change", () => {
    updatePreferences({ inlineExportImages: inlineExportImgCheck.checked });
  });

  prefModalEl.querySelectorAll<HTMLInputElement>("#pref-ext-checks input[type='checkbox']").forEach((cb) => {
    cb.addEventListener("change", () => {
      const checkedExts = Array.from(
        prefModalEl!.querySelectorAll<HTMLInputElement>("#pref-ext-checks input[type='checkbox']:checked")
      ).map((el) => el.value);
      updatePreferences({
        fileAssociationExtensions: checkedExts.length > 0 ? checkedExts : [".md"],
      });
    });
  });

  const contextMenuCheck = prefModalEl.querySelector("#pref-context-menu-check") as HTMLInputElement | null;
  contextMenuCheck?.addEventListener("change", async () => {
    const enabled = contextMenuCheck.checked;
    updatePreferences({ registerContextMenu: enabled });
    try {
      const msg = await invoke<string>("toggle_explorer_context_menu", {
        enable: enabled,
        extensions: currentPrefs.fileAssociationExtensions,
      });
      showToast(msg, "success");
    } catch (err) {
      showToast(`更新右键菜单失败: ${err}`, "error");
    }
  });

  const setDefaultMdBtn = prefModalEl.querySelector(
    "#pref-set-default-md-btn"
  ) as HTMLButtonElement | null;
  setDefaultMdBtn?.addEventListener("click", async () => {
    try {
      setDefaultMdBtn.disabled = true;
      setDefaultMdBtn.textContent = "正在注册关联...";
      const msg = await invoke<string>("register_default_markdown_app", {
        openSystemSettings: true,
        extensions: currentPrefs.fileAssociationExtensions,
        registerContextMenu: currentPrefs.registerContextMenu,
      });
      showToast(msg || "已注册 .md 文件关联", "success");
      setDefaultMdBtn.textContent = "重新唤起系统打开方式";
      if (prefModalEl) refreshFileAssociationStatus(prefModalEl);
    } catch (err) {
      showToast(`设置默认程序失败: ${err}`, "error");
      setDefaultMdBtn.textContent = "设为默认打开程序";
    } finally {
      setDefaultMdBtn.disabled = false;
    }
  });

  const cleanupAssetsBtn = prefModalEl.querySelector(
    "#pref-cleanup-assets-btn"
  ) as HTMLButtonElement | null;
  cleanupAssetsBtn?.addEventListener("click", async () => {
    try {
      cleanupAssetsBtn.disabled = true;
      cleanupAssetsBtn.textContent = "正在扫描...";
      const res = await invoke<{ removedCount: number; freedBytes: number }>(
        "cleanup_orphan_assets",
        {
          currentFilePath: localStorage.getItem("typora_last_file") || null,
        }
      );
      if (res.removedCount > 0) {
        const kb = (res.freedBytes / 1024).toFixed(1);
        showToast(
          `已清理 ${res.removedCount} 张未引用孤儿图片，释放 ${kb} KB 空间`,
          "success"
        );
      } else {
        showToast("扫描完成，当前没有未引用的孤儿图片", "info");
      }
    } catch (err) {
      showToast(`${err}`, "info");
    } finally {
      cleanupAssetsBtn.disabled = false;
      cleanupAssetsBtn.textContent = "清理孤儿图片";
    }
  });

  prefModalEl.querySelector("#pref-reset-btn")?.addEventListener("click", () => {
    updatePreferences({
      ...DEFAULT_PREFERENCES,
      imageBedConfig: { ...DEFAULT_IMAGE_BED_CONFIG },
    });
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

  const autoHideTabCheck = modal.querySelector("#pref-autohide-tab") as HTMLInputElement;
  if (autoHideTabCheck) autoHideTabCheck.checked = prefs.autoHideSingleTab;

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

  const customFolderRow = modal.querySelector("#pref-custom-img-folder-row") as HTMLElement;
  if (customFolderRow) {
    customFolderRow.classList.toggle("hidden", prefs.imageFolderMode !== "custom");
  }
  const customFolderInput = modal.querySelector("#pref-custom-img-folder") as HTMLInputElement;
  if (customFolderInput) customFolderInput.value = prefs.customImageFolder || "./assets";

  const bedCfg = prefs.imageBedConfig || DEFAULT_IMAGE_BED_CONFIG;
  const bedProviderSelect = modal.querySelector("#pref-img-bed-provider") as HTMLSelectElement;
  if (bedProviderSelect) bedProviderSelect.value = bedCfg.provider;

  modal.querySelector("#pref-bed-picgo-box")?.classList.toggle("hidden", bedCfg.provider !== "picgo");
  modal.querySelector("#pref-bed-github-box")?.classList.toggle("hidden", bedCfg.provider !== "github");
  modal.querySelector("#pref-bed-custom-box")?.classList.toggle("hidden", bedCfg.provider !== "custom");

  const setVal = (sel: string, val: string) => {
    const el = modal.querySelector(sel) as HTMLInputElement | null;
    if (el) el.value = val || "";
  };
  setVal("#pref-bed-picgo-url", bedCfg.picgoUrl);
  setVal("#pref-bed-gh-repo", bedCfg.githubRepo);
  setVal("#pref-bed-gh-branch", bedCfg.githubBranch);
  setVal("#pref-bed-gh-token", bedCfg.githubToken);
  setVal("#pref-bed-gh-domain", bedCfg.githubCustomDomain);
  setVal("#pref-bed-custom-url", bedCfg.customUploadUrl);
  setVal("#pref-bed-custom-auth", bedCfg.customAuthHeader);

  const autoUploadCheck = modal.querySelector("#pref-auto-upload-bed") as HTMLInputElement;
  if (autoUploadCheck) autoUploadCheck.checked = Boolean(prefs.autoUploadImageToBed);

  const inlineExportImgCheck = modal.querySelector(
    "#pref-inline-export-img"
  ) as HTMLInputElement;
  if (inlineExportImgCheck) {
    inlineExportImgCheck.checked = prefs.inlineExportImages !== false;
  }

  const exts = prefs.fileAssociationExtensions || [".md", ".markdown", ".mdown"];
  modal.querySelectorAll<HTMLInputElement>("#pref-ext-checks input[type='checkbox']").forEach((cb) => {
    cb.checked = exts.includes(cb.value);
  });

  const contextMenuCheck = modal.querySelector("#pref-context-menu-check") as HTMLInputElement;
  if (contextMenuCheck) contextMenuCheck.checked = prefs.registerContextMenu !== false;
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && prefModalEl && !prefModalEl.classList.contains("hidden")) {
    prefModalEl.classList.add("hidden");
  } else if ((e.ctrlKey || e.metaKey) && e.key === ",") {
    e.preventDefault();
    openPreferencesModal();
  }
});
