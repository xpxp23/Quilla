import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import {
  computeLineDiff,
  DiffRow,
  saveFallbackLocalHistorySnapshot,
} from "./time-machine";
import { showToast } from "./save-dialog";

export interface GitFileStatusEntry {
  path: string;
  relPath: string;
  status: string;
  isConflicted: boolean;
}

export interface GitWorkspaceStatus {
  isRepo: boolean;
  workspaceRoot: string;
  branch: string;
  remoteUrl: string;
  ahead: number;
  behind: number;
  changedFiles: GitFileStatusEntry[];
  conflictedFiles: string[];
  summary: string;
}

export interface GitSyncResult {
  success: boolean;
  message: string;
  hasConflicts: boolean;
  status: GitWorkspaceStatus;
}

export interface ConflictFilePayload {
  path: string;
  hasConflictMarkers: boolean;
  conflictCount: number;
  localLabel: string;
  remoteLabel: string;
  localContent: string;
  remoteContent: string;
  baseContent: string;
  rawContent: string;
}

export interface WebDavConflictItem {
  path: string;
  relPath: string;
  localContent: string;
  remoteContent: string;
}

export interface WebDavSyncResult {
  success: boolean;
  message: string;
  uploadedCount: number;
  downloadedCount: number;
  conflicts: WebDavConflictItem[];
}

export interface WebDavConfig {
  endpoint: string;
  username: string;
  password: string;
  remoteDir: string;
  direction: "bidirectional" | "push" | "pull";
}

export type HunkResolution =
  | "local"
  | "remote"
  | "both-local-first"
  | "both-remote-first";

export interface MergeHunk {
  id: number;
  type: "equal" | "conflict";
  localLines: string[];
  remoteLines: string[];
  localStartLine: number;
  remoteStartLine: number;
  resolution: HunkResolution;
}

const WEBDAV_CONFIG_KEY = "quilla_webdav_sync_config_v1";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function loadWebDavConfig(): WebDavConfig {
  try {
    const raw = localStorage.getItem(WEBDAV_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        endpoint: String(parsed.endpoint || ""),
        username: String(parsed.username || ""),
        password: String(parsed.password || ""),
        remoteDir: String(parsed.remoteDir || "QuillaNotes"),
        direction:
          parsed.direction === "push" || parsed.direction === "pull"
            ? parsed.direction
            : "bidirectional",
      };
    }
  } catch {
    // ignore
  }
  return {
    endpoint: "",
    username: "",
    password: "",
    remoteDir: "QuillaNotes",
    direction: "bidirectional",
  };
}

export function saveWebDavConfig(cfg: WebDavConfig) {
  try {
    localStorage.setItem(WEBDAV_CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    // ignore
  }
}

/**
 * 解析包含 Git 标准冲突标记 (`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`) 的内联文档
 */
export function parseInlineConflictMarkers(rawText: string): {
  hasMarkers: boolean;
  conflictCount: number;
  localLabel: string;
  remoteLabel: string;
  localContent: string;
  remoteContent: string;
} {
  const normalized = rawText.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const localLines: string[] = [];
  const remoteLines: string[] = [];
  let localLabel = "LOCAL (本地版本)";
  let remoteLabel = "REMOTE (远端版本)";
  let conflictCount = 0;
  let state: "normal" | "local" | "base" | "remote" = "normal";

  for (const line of lines) {
    if (line.startsWith("<<<<<<<")) {
      conflictCount++;
      const lbl = line.replace(/^<+\s*/, "").trim();
      if (lbl) localLabel = lbl;
      state = "local";
    } else if (line.startsWith("|||||||") && state === "local") {
      state = "base";
    } else if (line.startsWith("=======") && (state === "local" || state === "base")) {
      state = "remote";
    } else if (line.startsWith(">>>>>>>") && state === "remote") {
      const lbl = line.replace(/^>+\s*/, "").trim();
      if (lbl) remoteLabel = lbl;
      state = "normal";
    } else {
      if (state === "normal") {
        localLines.push(line);
        remoteLines.push(line);
      } else if (state === "local") {
        localLines.push(line);
      } else if (state === "remote") {
        remoteLines.push(line);
      }
    }
  }

  return {
    hasMarkers: conflictCount > 0,
    conflictCount,
    localLabel,
    remoteLabel,
    localContent: localLines.join("\n"),
    remoteContent: remoteLines.join("\n"),
  };
}

/**
 * 复用时间机器的 Myers O((M+N)D) 行级差分结果 (`computeLineDiff`)，
 * 将本地版本 (Ours) 与远端版本 (Theirs) 聚合成可视化三方合并块 (`MergeHunk[]`)。
 */
export function computeThreeWayMergeHunks(
  localText: string,
  remoteText: string
): { hunks: MergeHunk[]; diffRows: DiffRow[] } {
  const diffRows = computeLineDiff(localText, remoteText);
  const hunks: MergeHunk[] = [];
  let hunkId = 1;

  let curEqual: string[] = [];
  let curEqualLocalStart = 1;
  let curEqualRemoteStart = 1;

  let curLocal: string[] = [];
  let curRemote: string[] = [];
  let curConflictLocalStart = 1;
  let curConflictRemoteStart = 1;
  let inConflict = false;

  const flushEqual = () => {
    if (curEqual.length > 0) {
      hunks.push({
        id: hunkId++,
        type: "equal",
        localLines: [...curEqual],
        remoteLines: [...curEqual],
        localStartLine: curEqualLocalStart,
        remoteStartLine: curEqualRemoteStart,
        resolution: "local",
      });
      curEqual = [];
    }
  };

  const flushConflict = () => {
    if (inConflict && (curLocal.length > 0 || curRemote.length > 0)) {
      hunks.push({
        id: hunkId++,
        type: "conflict",
        localLines: [...curLocal],
        remoteLines: [...curRemote],
        localStartLine: curConflictLocalStart,
        remoteStartLine: curConflictRemoteStart,
        resolution: "local",
      });
      curLocal = [];
      curRemote = [];
      inConflict = false;
    }
  };

  for (const row of diffRows) {
    if (row.type === "equal") {
      flushConflict();
      if (curEqual.length === 0) {
        curEqualLocalStart = row.oldLine || 1;
        curEqualRemoteStart = row.newLine || 1;
      }
      curEqual.push(row.text);
    } else {
      flushEqual();
      if (!inConflict) {
        inConflict = true;
        curConflictLocalStart = row.oldLine || 1;
        curConflictRemoteStart = row.newLine || 1;
      }
      if (row.type === "del") {
        curLocal.push(row.text);
      } else if (row.type === "add") {
        curRemote.push(row.text);
      }
    }
  }
  flushConflict();
  flushEqual();

  return { hunks, diffRows };
}

/**
 * 根据每个冲突块的决策生成合并后的完整 Markdown 文本
 */
export function buildMergedDocumentFromHunks(hunks: MergeHunk[]): string {
  const outLines: string[] = [];
  for (const hunk of hunks) {
    if (hunk.type === "equal") {
      outLines.push(...hunk.localLines);
    } else {
      switch (hunk.resolution) {
        case "local":
          outLines.push(...hunk.localLines);
          break;
        case "remote":
          outLines.push(...hunk.remoteLines);
          break;
        case "both-local-first":
          outLines.push(...hunk.localLines, ...hunk.remoteLines);
          break;
        case "both-remote-first":
          outLines.push(...hunk.remoteLines, ...hunk.localLines);
          break;
      }
    }
  }
  return outLines.join("\n");
}

let syncModalEl: HTMLElement | null = null;

export async function openSyncCenterModal(options: {
  view: EditorView | null;
  workspaceRoot: string | null;
  activeFilePath: string | null;
  activeTitle: string;
  initialTab?: "git" | "webdav" | "merger";
  onDocumentMerged?: (newContent: string, targetPath: string | null) => void;
  onWorkspaceSynced?: () => void;
}) {
  if (!syncModalEl) {
    syncModalEl = document.createElement("div");
    syncModalEl.id = "quilla-sync-center-modal";
    syncModalEl.className = "ty-modal-overlay";
    document.body.appendChild(syncModalEl);
  }

  let currentTab: "git" | "webdav" | "merger" = options.initialTab || "git";
  let gitStatus: GitWorkspaceStatus | null = null;
  let webdavConfig = loadWebDavConfig();
  let pendingWebDavConflicts: WebDavConflictItem[] = [];

  // 三方合并器状态
  let activeMergePath: string | null = options.activeFilePath;
  let localLabel = "LOCAL · 本地当前版本";
  let remoteLabel = "REMOTE · 远端/对比版本";
  const initialEditorText = options.view?.state.doc.toString() || "";
  const inlineParsed = parseInlineConflictMarkers(initialEditorText);

  let localText = inlineParsed.hasMarkers ? inlineParsed.localContent : initialEditorText;
  let remoteText = inlineParsed.hasMarkers ? inlineParsed.remoteContent : initialEditorText;
  if (inlineParsed.hasMarkers) {
    localLabel = inlineParsed.localLabel;
    remoteLabel = inlineParsed.remoteLabel;
    if (!options.initialTab) {
      currentTab = "merger";
    }
  }

  let mergeState = computeThreeWayMergeHunks(localText, remoteText);
  let manualMergedOverride: string | null = null;

  syncModalEl.classList.remove("hidden");

  const rebuildHunks = (nextLocal: string, nextRemote: string) => {
    localText = nextLocal;
    remoteText = nextRemote;
    mergeState = computeThreeWayMergeHunks(localText, remoteText);
    manualMergedOverride = null;
  };

  const loadConflictFileIntoMerger = async (filePath: string) => {
    try {
      const payload = await invoke<ConflictFilePayload>("parse_git_conflict_file", {
        path: filePath,
      });
      activeMergePath = filePath;
      localLabel = payload.localLabel || "LOCAL (本地版本)";
      remoteLabel = payload.remoteLabel || "REMOTE (远端版本)";
      rebuildHunks(payload.localContent, payload.remoteContent);
      currentTab = "merger";
      renderModal();
    } catch (e) {
      showToast(`读取冲突文件失败: ${e}`, "error");
    }
  };

  const refreshGitStatus = async () => {
    if (!options.workspaceRoot) {
      gitStatus = null;
      renderModal();
      return;
    }
    try {
      gitStatus = await invoke<GitWorkspaceStatus>("workspace_git_status", {
        workspaceRoot: options.workspaceRoot,
      });
      if (gitStatus.conflictedFiles.length > 0 && !inlineParsed.hasMarkers) {
        const firstConflict = gitStatus.conflictedFiles[0];
        const payload = await invoke<ConflictFilePayload>("parse_git_conflict_file", {
          path: firstConflict,
        }).catch(() => null);
        if (payload && payload.hasConflictMarkers) {
          activeMergePath = firstConflict;
          localLabel = payload.localLabel;
          remoteLabel = payload.remoteLabel;
          rebuildHunks(payload.localContent, payload.remoteContent);
        }
      }
    } catch {
      gitStatus = null;
    }
    renderModal();
  };

  const renderGitTab = (): string => {
    if (!options.workspaceRoot) {
      return `
        <div class="sync-empty-panel">
          <div class="sync-empty-title">尚未打开本地工作区文件夹</div>
          <div class="sync-empty-sub">打开任意本地文件夹后，即可免插件使用内置 Git 增量拉取、自动提交推送与三方冲突合并。</div>
          <button type="button" class="ty-btn-primary" id="sync-switch-to-merger-btn">打开当前文档三方对比合并台</button>
        </div>
      `;
    }

    if (!gitStatus || !gitStatus.isRepo) {
      return `
        <div class="sync-empty-panel">
          <div class="sync-empty-title">当前工作区尚未初始化 Git 仓库</div>
          <div class="sync-empty-sub">目录：<code>${escapeHtml(options.workspaceRoot)}</code></div>
          <div class="sync-form-row" style="max-width:460px;width:100%;margin-top:10px;">
            <input type="text" class="sync-text-input" id="git-init-remote-input" placeholder="可选：远端仓库地址 (如 https://github.com/user/notes.git)" />
          </div>
          <button type="button" class="ty-btn-primary" id="git-init-repo-btn">一键初始化 Git 仓库</button>
        </div>
      `;
    }

    const conflictBanner =
      gitStatus.conflictedFiles.length > 0
        ? `<div class="sync-conflict-banner">
            <div class="sync-conflict-banner-info">
              <strong>检测到 ${gitStatus.conflictedFiles.length} 个文件存在合并冲突</strong>
              <span>点击右侧按钮直接进入可视化 Myers Diff 三方合并工作台逐段解决</span>
            </div>
            <button type="button" class="ty-btn-primary danger-accent" id="git-goto-merger-btn">进入三方冲突合并 (${gitStatus.conflictedFiles.length})</button>
          </div>`
        : "";

    const filesHtml =
      gitStatus.changedFiles.length === 0
        ? `<div class="sync-clean-placeholder">✓ 工作区所有笔记均已同步，无未提交改动</div>`
        : gitStatus.changedFiles
            .map(
              (f) => `
          <div class="sync-file-row ${f.isConflicted ? "is-conflicted" : ""}">
            <span class="sync-status-badge status-${escapeHtml(f.status.toLowerCase())}">${escapeHtml(f.status)}</span>
            <span class="sync-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.relPath)}</span>
            ${
              f.isConflicted
                ? `<button type="button" class="sync-mini-btn conflict-resolve-btn" data-conflict-path="${encodeURIComponent(f.path)}">三方合并</button>`
                : `<button type="button" class="sync-mini-btn compare-file-btn" data-compare-path="${encodeURIComponent(f.path)}">对比差异</button>`
            }
          </div>`
            )
            .join("");

    return `
      <div class="sync-tab-body">
        ${conflictBanner}
        <div class="sync-git-meta-grid">
          <div class="sync-meta-card">
            <span class="sync-meta-label">当前分支</span>
            <strong class="sync-meta-val">${escapeHtml(gitStatus.branch || "main")}</strong>
          </div>
          <div class="sync-meta-card">
            <span class="sync-meta-label">同步水位</span>
            <strong class="sync-meta-val">领先 ↑${gitStatus.ahead} · 落后 ↓${gitStatus.behind}</strong>
          </div>
          <div class="sync-meta-card wide">
            <span class="sync-meta-label">远端仓库 (origin)</span>
            <input type="text" class="sync-text-input compact" id="git-remote-url-input" value="${escapeHtml(gitStatus.remoteUrl)}" placeholder="https://github.com/your/vault.git 或 SSH 地址" />
          </div>
        </div>

        <div class="sync-action-bar">
          <input type="text" class="sync-text-input" id="git-commit-msg-input" placeholder="提交说明 (默认: docs(quilla): incremental workspace sync)" />
          <button type="button" class="tm-action-btn" id="git-pull-btn">↓ 拉取更新 (Pull)</button>
          <button type="button" class="tm-action-btn" id="git-push-btn">↑ 提交并推送 (Push)</button>
          <button type="button" class="ty-btn-primary" id="git-sync-all-btn">⇄ 一键增量同步</button>
        </div>

        <div class="sync-files-section">
          <div class="sync-files-header">
            <span>变更与待同步文件 (${gitStatus.changedFiles.length})</span>
            <button type="button" class="sync-link-btn" id="git-refresh-status-btn">刷新状态</button>
          </div>
          <div class="sync-files-list">
            ${filesHtml}
          </div>
        </div>
      </div>
    `;
  };

  const renderWebDavTab = (): string => {
    const conflictHtml =
      pendingWebDavConflicts.length > 0
        ? `<div class="sync-conflict-banner">
            <div class="sync-conflict-banner-info">
              <strong>检测到 ${pendingWebDavConflicts.length} 篇云端与本地同时修改的笔记</strong>
              <span>点击任一文件即可在三方合并视图中比对本地与 WebDAV 云端版本</span>
            </div>
            <div class="sync-conflict-chips">
              ${pendingWebDavConflicts
                .map(
                  (c, idx) =>
                    `<button type="button" class="sync-mini-btn webdav-conflict-btn" data-idx="${idx}">合并 ${escapeHtml(c.relPath)}</button>`
                )
                .join("")}
            </div>
          </div>`
        : "";

    return `
      <div class="sync-tab-body">
        ${conflictHtml}
        <div class="sync-webdav-grid">
          <div class="sync-form-group">
            <label>WebDAV 服务器地址 (支持坚果云 / Nextcloud / OwnCloud / Alist)</label>
            <input type="text" class="sync-text-input" id="webdav-endpoint-input" value="${escapeHtml(webdavConfig.endpoint)}" placeholder="例如 https://dav.jianguoyun.com/dav/" />
          </div>
          <div class="sync-form-group">
            <label>远端同步目录</label>
            <input type="text" class="sync-text-input" id="webdav-dir-input" value="${escapeHtml(webdavConfig.remoteDir)}" placeholder="QuillaNotes" />
          </div>
          <div class="sync-form-group">
            <label>账号 / 邮箱</label>
            <input type="text" class="sync-text-input" id="webdav-user-input" value="${escapeHtml(webdavConfig.username)}" placeholder="您的 WebDAV 账号" />
          </div>
          <div class="sync-form-group">
            <label>应用专用密码 / Token</label>
            <input type="password" class="sync-text-input" id="webdav-pass-input" value="${escapeHtml(webdavConfig.password)}" placeholder="应用授权密码" />
          </div>
          <div class="sync-form-group full-width">
            <label>同步策略</label>
            <div class="sync-radio-group" id="webdav-direction-group">
              <button type="button" class="sync-seg-btn ${webdavConfig.direction === "bidirectional" ? "active" : ""}" data-dir="bidirectional">⇄ 双向增量同步（差异自动转入三方合并）</button>
              <button type="button" class="sync-seg-btn ${webdavConfig.direction === "push" ? "active" : ""}" data-dir="push">↑ 仅上传本地笔记至云端</button>
              <button type="button" class="sync-seg-btn ${webdavConfig.direction === "pull" ? "active" : ""}" data-dir="pull">↓ 仅从云端拉取覆盖本地</button>
            </div>
          </div>
        </div>
        <div class="sync-webdav-footer">
          <span class="sync-webdav-tip">提示：所有凭据仅保存在本地设备配置中，基于原生 HTTP PROPFIND / PUT / GET 增量传输，无需安装任何第三方插件。</span>
          <div class="sync-webdav-btns">
            <button type="button" class="tm-action-btn" id="webdav-test-btn">测试连接</button>
            <button type="button" class="ty-btn-primary" id="webdav-sync-now-btn">立即执行 WebDAV 同步</button>
          </div>
        </div>
      </div>
    `;
  };

  const renderMergerTab = (): string => {
    const conflictHunks = mergeState.hunks.filter((h) => h.type === "conflict");
    const mergedPreviewText =
      manualMergedOverride !== null
        ? manualMergedOverride
        : buildMergedDocumentFromHunks(mergeState.hunks);

    // 左侧：本地行级视图，右侧：远端行级视图
    const localRowsHtml: string[] = [];
    const remoteRowsHtml: string[] = [];

    for (const h of mergeState.hunks) {
      if (h.type === "equal") {
        h.localLines.forEach((line, i) => {
          const ln = h.localStartLine + i;
          const rln = h.remoteStartLine + i;
          localRowsHtml.push(`
            <div class="tm-diff-row tm-diff-equal">
              <span class="tm-line-no">${ln}</span>
              <span class="tm-line-text">${escapeHtml(line) || " "}</span>
            </div>
          `);
          remoteRowsHtml.push(`
            <div class="tm-diff-row tm-diff-equal">
              <span class="tm-line-no">${rln}</span>
              <span class="tm-line-text">${escapeHtml(line) || " "}</span>
            </div>
          `);
        });
      } else {
        localRowsHtml.push(`
          <div class="merger-pane-hunk-block ${h.resolution === "local" || h.resolution.startsWith("both") ? "is-chosen" : "is-skipped"}">
            <div class="merger-pane-hunk-tag">冲突块 #${h.id} · 本地 (${h.localLines.length} 行)</div>
            ${
              h.localLines.length === 0
                ? `<div class="tm-diff-row tm-diff-empty">（本地此处为空）</div>`
                : h.localLines
                    .map(
                      (l, idx) => `
                  <div class="tm-diff-row tm-diff-del">
                    <span class="tm-line-no">${h.localStartLine + idx}</span>
                    <span class="tm-line-sign">-</span>
                    <span class="tm-line-text">${escapeHtml(l) || " "}</span>
                  </div>`
                    )
                    .join("")
            }
          </div>
        `);

        remoteRowsHtml.push(`
          <div class="merger-pane-hunk-block ${h.resolution === "remote" || h.resolution.startsWith("both") ? "is-chosen" : "is-skipped"}">
            <div class="merger-pane-hunk-tag">冲突块 #${h.id} · 远端 (${h.remoteLines.length} 行)</div>
            ${
              h.remoteLines.length === 0
                ? `<div class="tm-diff-row tm-diff-empty">（远端此处为空）</div>`
                : h.remoteLines
                    .map(
                      (l, idx) => `
                  <div class="tm-diff-row tm-diff-add">
                    <span class="tm-line-no">${h.remoteStartLine + idx}</span>
                    <span class="tm-line-sign">+</span>
                    <span class="tm-line-text">${escapeHtml(l) || " "}</span>
                  </div>`
                    )
                    .join("")
            }
          </div>
        `);
      }
    }

    const centerHunksHtml =
      conflictHunks.length === 0
        ? `<div class="merger-no-conflict-badge">✓ 当前本地版本与远端对比版本完全一致，无冲突行</div>`
        : conflictHunks
            .map(
              (h) => `
          <div class="merger-hunk-card" data-hunk-id="${h.id}">
            <div class="merger-hunk-card-head">
              <span class="merger-hunk-title">冲突段落 #${h.id} (L${h.localStartLine})</span>
              <div class="merger-hunk-btns">
                <button type="button" class="merger-resolve-chip ${h.resolution === "local" ? "active" : ""}" data-hunk="${h.id}" data-res="local">采用本地</button>
                <button type="button" class="merger-resolve-chip ${h.resolution === "remote" ? "active" : ""}" data-hunk="${h.id}" data-res="remote">采用远端</button>
                <button type="button" class="merger-resolve-chip ${h.resolution === "both-local-first" ? "active" : ""}" data-hunk="${h.id}" data-res="both-local-first">保留双方</button>
              </div>
            </div>
          </div>`
            )
            .join("");

    return `
      <div class="sync-merger-workbench">
        <div class="sync-merger-toolbar">
          <div class="sync-merger-file-info">
            <span class="merger-target-badge">目标文档：${escapeHtml(activeMergePath ? activeMergePath.split(/[\\/]/).pop()! : options.activeTitle)}</span>
            <span class="merger-conflict-count-pill ${conflictHunks.length > 0 ? "has-conflicts" : "clean"}">
              ${conflictHunks.length > 0 ? `${conflictHunks.length} 处差异/冲突块` : "0 处冲突"}
            </span>
          </div>
          <div class="sync-merger-global-actions">
            <button type="button" class="sync-mini-btn" id="merger-paste-remote-btn" title="从剪贴板或输入框加载外部版本进行三方比对">载入对比文本...</button>
            <button type="button" class="sync-mini-btn" id="merger-accept-all-local-btn">全部采用本地 (Ours)</button>
            <button type="button" class="sync-mini-btn" id="merger-accept-all-remote-btn">全部采用远端 (Theirs)</button>
            <button type="button" class="sync-mini-btn" id="merger-keep-all-both-btn">全部保留双方</button>
            <button type="button" class="ty-btn-primary" id="merger-apply-save-btn">✓ 应用合并结果并保存</button>
          </div>
        </div>

        <div class="sync-merger-three-columns">
          <!-- 左栏：本地版本 (Ours) -->
          <div class="merger-column">
            <div class="merger-column-header ours">
              <span>${escapeHtml(localLabel)}</span>
              <span class="merger-col-tag">Ours</span>
            </div>
            <div class="merger-column-body" id="merger-col-local">
              ${localRowsHtml.join("")}
            </div>
          </div>

          <!-- 中栏：三方合并决策与实时结果可编辑区 -->
          <div class="merger-column center-merged">
            <div class="merger-column-header merged">
              <span>合并结果预览与冲突逐段决策</span>
              <span class="merger-col-tag">Merged Output</span>
            </div>
            <div class="merger-center-hunks-strip">
              ${centerHunksHtml}
            </div>
            <textarea class="merger-result-textarea" id="merger-result-textarea" spellcheck="false">${escapeHtml(mergedPreviewText)}</textarea>
          </div>

          <!-- 右栏：远端版本 (Theirs) -->
          <div class="merger-column">
            <div class="merger-column-header theirs">
              <span>${escapeHtml(remoteLabel)}</span>
              <span class="merger-col-tag">Theirs</span>
            </div>
            <div class="merger-column-body" id="merger-col-remote">
              ${remoteRowsHtml.join("")}
            </div>
          </div>
        </div>
      </div>
    `;
  };

  const renderModal = () => {
    if (!syncModalEl) return;
    const conflictBadgeCount =
      (gitStatus?.conflictedFiles.length || 0) +
      pendingWebDavConflicts.length +
      (inlineParsed.hasMarkers ? inlineParsed.conflictCount : 0);

    syncModalEl.innerHTML = `
      <div class="ty-modal-card sync-center-modal-card" role="dialog" aria-modal="true">
        <div class="ty-modal-header">
          <div class="modal-title">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
            <span>原生 Git / WebDAV 增量同步与三方冲突合并台</span>
            <span class="modal-badge">Ctrl + Alt + S</span>
          </div>
          <div class="sync-header-tabs">
            <button type="button" class="sync-tab-btn ${currentTab === "git" ? "active" : ""}" data-tab="git">Git 仓库同步</button>
            <button type="button" class="sync-tab-btn ${currentTab === "webdav" ? "active" : ""}" data-tab="webdav">WebDAV 云同步</button>
            <button type="button" class="sync-tab-btn ${currentTab === "merger" ? "active" : ""}" data-tab="merger">
              三方冲突合并视图
              ${conflictBadgeCount > 0 ? `<span class="sync-tab-conflict-dot">${conflictBadgeCount}</span>` : ""}
            </button>
          </div>
          <button type="button" class="modal-close-btn" id="sync-center-close-btn" title="关闭 (Esc)">✕</button>
        </div>
        <div class="sync-center-content">
          ${
            currentTab === "git"
              ? renderGitTab()
              : currentTab === "webdav"
                ? renderWebDavTab()
                : renderMergerTab()
          }
        </div>
      </div>
    `;

    bindEvents();
  };

  const bindEvents = () => {
    if (!syncModalEl) return;

    syncModalEl.querySelector("#sync-center-close-btn")?.addEventListener("click", () => {
      syncModalEl?.classList.add("hidden");
    });

    syncModalEl.querySelectorAll(".sync-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = (btn as HTMLElement).dataset.tab as "git" | "webdav" | "merger";
        if (t) {
          currentTab = t;
          renderModal();
        }
      });
    });

    syncModalEl.querySelector("#sync-switch-to-merger-btn")?.addEventListener("click", () => {
      currentTab = "merger";
      renderModal();
    });

    syncModalEl.querySelector("#git-init-repo-btn")?.addEventListener("click", async () => {
      const remoteInput = syncModalEl?.querySelector(
        "#git-init-remote-input"
      ) as HTMLInputElement | null;
      try {
        const res = await invoke<GitSyncResult>("workspace_git_sync", {
          workspaceRoot: options.workspaceRoot,
          action: "init",
          remoteUrl: remoteInput?.value.trim() || null,
        });
        gitStatus = res.status;
        showToast(res.message, "success");
        renderModal();
      } catch (e) {
        showToast(`${e}`, "error");
      }
    });

    const runGitAction = async (action: "pull" | "commit_push" | "sync_all") => {
      const msgInput = syncModalEl?.querySelector(
        "#git-commit-msg-input"
      ) as HTMLInputElement | null;
      const remoteInput = syncModalEl?.querySelector(
        "#git-remote-url-input"
      ) as HTMLInputElement | null;
      try {
        const res = await invoke<GitSyncResult>("workspace_git_sync", {
          workspaceRoot: options.workspaceRoot,
          action,
          commitMessage: msgInput?.value.trim() || null,
          remoteUrl: remoteInput?.value.trim() || null,
        });
        gitStatus = res.status;
        showToast(res.message, res.hasConflicts ? "info" : "success");
        options.onWorkspaceSynced?.();
        if (res.hasConflicts && res.status.conflictedFiles.length > 0) {
          await loadConflictFileIntoMerger(res.status.conflictedFiles[0]);
        } else {
          renderModal();
        }
      } catch (e) {
        showToast(`${e}`, "error");
      }
    };

    syncModalEl.querySelector("#git-pull-btn")?.addEventListener("click", () => runGitAction("pull"));
    syncModalEl
      .querySelector("#git-push-btn")
      ?.addEventListener("click", () => runGitAction("commit_push"));
    syncModalEl
      .querySelector("#git-sync-all-btn")
      ?.addEventListener("click", () => runGitAction("sync_all"));
    syncModalEl
      .querySelector("#git-refresh-status-btn")
      ?.addEventListener("click", () => refreshGitStatus());

    syncModalEl.querySelector("#git-goto-merger-btn")?.addEventListener("click", () => {
      if (gitStatus && gitStatus.conflictedFiles.length > 0) {
        loadConflictFileIntoMerger(gitStatus.conflictedFiles[0]);
      } else {
        currentTab = "merger";
        renderModal();
      }
    });

    syncModalEl.querySelectorAll(".conflict-resolve-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = decodeURIComponent((btn as HTMLElement).dataset.conflictPath || "");
        if (p) loadConflictFileIntoMerger(p);
      });
    });

    syncModalEl.querySelectorAll(".compare-file-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = decodeURIComponent((btn as HTMLElement).dataset.comparePath || "");
        if (p) loadConflictFileIntoMerger(p);
      });
    });

    // WebDAV 事件绑定
    const collectWebDavForm = (): WebDavConfig => {
      const endpoint =
        (syncModalEl?.querySelector("#webdav-endpoint-input") as HTMLInputElement)?.value.trim() ||
        "";
      const remoteDir =
        (syncModalEl?.querySelector("#webdav-dir-input") as HTMLInputElement)?.value.trim() ||
        "QuillaNotes";
      const username =
        (syncModalEl?.querySelector("#webdav-user-input") as HTMLInputElement)?.value.trim() || "";
      const password =
        (syncModalEl?.querySelector("#webdav-pass-input") as HTMLInputElement)?.value || "";
      webdavConfig = {
        ...webdavConfig,
        endpoint,
        remoteDir,
        username,
        password,
      };
      saveWebDavConfig(webdavConfig);
      return webdavConfig;
    };

    syncModalEl.querySelectorAll("#webdav-direction-group .sync-seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        collectWebDavForm();
        const dir = (btn as HTMLElement).dataset.dir as "bidirectional" | "push" | "pull";
        if (dir) {
          webdavConfig.direction = dir;
          saveWebDavConfig(webdavConfig);
          renderModal();
        }
      });
    });

    syncModalEl.querySelector("#webdav-test-btn")?.addEventListener("click", async () => {
      const cfg = collectWebDavForm();
      try {
        const res = await invoke<WebDavSyncResult>("webdav_sync_workspace", {
          workspaceRoot: options.workspaceRoot,
          endpoint: cfg.endpoint,
          username: cfg.username,
          password: cfg.password,
          remoteDir: cfg.remoteDir,
          direction: "test",
        });
        showToast(res.message, "success");
      } catch (e) {
        showToast(`${e}`, "error");
      }
    });

    syncModalEl.querySelector("#webdav-sync-now-btn")?.addEventListener("click", async () => {
      const cfg = collectWebDavForm();
      try {
        const res = await invoke<WebDavSyncResult>("webdav_sync_workspace", {
          workspaceRoot: options.workspaceRoot,
          endpoint: cfg.endpoint,
          username: cfg.username,
          password: cfg.password,
          remoteDir: cfg.remoteDir,
          direction: cfg.direction,
        });
        pendingWebDavConflicts = res.conflicts || [];
        showToast(res.message, pendingWebDavConflicts.length > 0 ? "info" : "success");
        options.onWorkspaceSynced?.();
        if (pendingWebDavConflicts.length > 0) {
          const first = pendingWebDavConflicts[0];
          activeMergePath = first.path;
          localLabel = `LOCAL · ${first.relPath}`;
          remoteLabel = `WebDAV · ${first.relPath}`;
          rebuildHunks(first.localContent, first.remoteContent);
          currentTab = "merger";
        }
        renderModal();
      } catch (e) {
        showToast(`${e}`, "error");
      }
    });

    syncModalEl.querySelectorAll(".webdav-conflict-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number((btn as HTMLElement).dataset.idx || "0");
        const item = pendingWebDavConflicts[idx];
        if (item) {
          activeMergePath = item.path;
          localLabel = `LOCAL · ${item.relPath}`;
          remoteLabel = `WebDAV · ${item.relPath}`;
          rebuildHunks(item.localContent, item.remoteContent);
          currentTab = "merger";
          renderModal();
        }
      });
    });

    // 三方冲突合并视图事件绑定
    syncModalEl.querySelectorAll(".merger-resolve-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const hId = Number((chip as HTMLElement).dataset.hunk);
        const res = (chip as HTMLElement).dataset.res as HunkResolution;
        const target = mergeState.hunks.find((h) => h.id === hId);
        if (target && res) {
          target.resolution = res;
          manualMergedOverride = null;
          renderModal();
        }
      });
    });

    syncModalEl.querySelector("#merger-accept-all-local-btn")?.addEventListener("click", () => {
      mergeState.hunks.forEach((h) => {
        if (h.type === "conflict") h.resolution = "local";
      });
      manualMergedOverride = null;
      renderModal();
    });

    syncModalEl.querySelector("#merger-accept-all-remote-btn")?.addEventListener("click", () => {
      mergeState.hunks.forEach((h) => {
        if (h.type === "conflict") h.resolution = "remote";
      });
      manualMergedOverride = null;
      renderModal();
    });

    syncModalEl.querySelector("#merger-keep-all-both-btn")?.addEventListener("click", () => {
      mergeState.hunks.forEach((h) => {
        if (h.type === "conflict") h.resolution = "both-local-first";
      });
      manualMergedOverride = null;
      renderModal();
    });

    const resultTextarea = syncModalEl.querySelector(
      "#merger-result-textarea"
    ) as HTMLTextAreaElement | null;
    resultTextarea?.addEventListener("input", () => {
      manualMergedOverride = resultTextarea.value;
    });

    syncModalEl.querySelector("#merger-paste-remote-btn")?.addEventListener("click", async () => {
      try {
        const clip = await navigator.clipboard.readText();
        if (clip && clip.trim()) {
          remoteLabel = "CLIPBOARD · 剪贴板对比版本";
          rebuildHunks(localText, clip.replace(/\r\n/g, "\n"));
          renderModal();
          showToast("已载入剪贴板文本作为远端对比版本", "success");
          return;
        }
      } catch {
        // ignore
      }
      showToast("请先复制要对比的文本到剪贴板，再点击「载入对比文本」", "info");
    });

    syncModalEl.querySelector("#merger-apply-save-btn")?.addEventListener("click", async () => {
      const finalMerged =
        resultTextarea?.value ?? buildMergedDocumentFromHunks(mergeState.hunks);

      // 合并前自动在时间机器创建安全备份快照
      const docKey = activeMergePath || options.activeTitle || "unsaved-doc";
      saveFallbackLocalHistorySnapshot(docKey, localText, "三方冲突合并前自动备份");

      if (activeMergePath) {
        try {
          await invoke("create_file_history_snapshot", {
            path: activeMergePath,
            content: localText,
            label: "三方冲突合并前自动快照",
          }).catch(() => {});
          await invoke("save_file_content", {
            path: activeMergePath,
            content: finalMerged,
          });
        } catch (e) {
          showToast(`写入合并结果失败: ${e}`, "error");
          return;
        }
      }

      if (
        options.view &&
        (!activeMergePath ||
          !options.activeFilePath ||
          activeMergePath.replace(/\\/g, "/").toLowerCase() ===
            options.activeFilePath.replace(/\\/g, "/").toLowerCase())
      ) {
        const curLen = options.view.state.doc.length;
        options.view.dispatch({
          changes: { from: 0, to: curLen, insert: finalMerged },
        });
      }

      options.onDocumentMerged?.(finalMerged, activeMergePath);
      showToast("已完成三方冲突合并并更新文档", "success");
      syncModalEl?.classList.add("hidden");
    });
  };

  renderModal();
  if (options.workspaceRoot) {
    await refreshGitStatus();
  }
}
