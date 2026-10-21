import { invoke } from "@tauri-apps/api/core";

export interface RecoverySnapshot {
  sessionId: string;
  filePath: string | null;
  content: string;
  timestamp: number;
  title: string;
}

export interface TextDeltaPayload {
  fromChar: number;
  toChar: number;
  insert: string;
}

interface DiskDraftRecord {
  key: string;
  filePath: string | null;
  content: string;
  timestamp: number;
  title: string;
}

const STORAGE_KEY = "typora_auto_recovery_snapshots_v2";
const LEGACY_KEY = "typora_auto_recovery_snapshot";

// 当前窗口实例唯一会话 ID，确保多窗口并发编辑不同文件时快照互不覆盖
const CURRENT_SESSION_ID = `win-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function readSnapshotMap(): Record<string, RecoverySnapshot> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const map: Record<string, RecoverySnapshot> = raw ? JSON.parse(raw) : {};
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw) {
      try {
        const legacy = JSON.parse(legacyRaw);
        if (legacy && legacy.content) {
          map["legacy"] = {
            sessionId: "legacy",
            filePath: legacy.filePath || null,
            content: legacy.content,
            timestamp: legacy.timestamp || Date.now(),
            title: legacy.title || "未命名文档",
          };
        }
      } catch {}
      localStorage.removeItem(LEGACY_KEY);
    }
    return map;
  } catch {
    return {};
  }
}

function writeSnapshotMap(map: Record<string, RecoverySnapshot>) {
  try {
    const entries = Object.entries(map).sort((a, b) => b[1].timestamp - a[1].timestamp);
    const trimmedMap: Record<string, RecoverySnapshot> = {};
    for (const [k, v] of entries.slice(0, 8)) {
      trimmedMap[k] = v;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmedMap));
  } catch (e) {
    try {
      const entries = Object.entries(map).sort((a, b) => b[1].timestamp - a[1].timestamp);
      if (entries.length > 0) {
        const [k, v] = entries[0];
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ [k]: v }));
      }
    } catch {
      console.warn("本地存储配额已满，已自动交由 Rust 磁盘快照兜底:", e);
    }
  }
}

let pendingPersistTimer: any = null;
let pendingSnapshotData: {
  bucketKey: string;
  filePath: string | null;
  content: string;
  title: string;
} | null = null;

function flushPendingRecoverySnapshot() {
  if (pendingPersistTimer) {
    clearTimeout(pendingPersistTimer);
    pendingPersistTimer = null;
  }
  if (!pendingSnapshotData) return;
  const { bucketKey, filePath, content, title } = pendingSnapshotData;
  pendingSnapshotData = null;

  const map = readSnapshotMap();
  map[bucketKey] = {
    sessionId: CURRENT_SESSION_ID,
    filePath,
    content,
    timestamp: Date.now(),
    title,
  };
  writeSnapshotMap(map);

  // 同步至 Rust Ropey 缓冲区与磁盘级快照文件
  invoke("sync_document_buffer", {
    content,
    fileId: bucketKey,
    filePath,
    title,
  }).catch(() => {});
}

// 窗口失焦或关闭前立即落盘防丢
if (typeof window !== "undefined") {
  window.addEventListener("blur", () => {
    flushPendingRecoverySnapshot();
  });
  window.addEventListener("beforeunload", () => {
    flushPendingRecoverySnapshot();
  });
}

/**
 * 实时在后台按当前窗口会话与文件路径保存脏内容快照（采用 1500ms 闲置防抖与失焦立即刷盘，
 * 彻底解耦高频打字与 localStorage / 磁盘 I/O 序列化）
 */
export function saveRecoverySnapshot(
  filePath: string | null,
  content: string,
  title: string,
  deltas?: TextDeltaPayload[],
  tabId?: string
) {
  const bucketKey = filePath
    ? `file::${filePath.replace(/\\/g, "/").toLowerCase()}`
    : tabId
    ? `${CURRENT_SESSION_ID}::${tabId}`
    : CURRENT_SESSION_ID;

  // 若携带增量字符区间变更，先轻量更新内存 Ropey 缓冲区
  if (deltas && deltas.length > 0) {
    invoke("sync_document_buffer", {
      deltas,
      fileId: "memory_only",
    }).catch(() => {});
  }

  pendingSnapshotData = {
    bucketKey,
    filePath,
    content,
    title,
  };

  if (pendingPersistTimer) {
    clearTimeout(pendingPersistTimer);
  }
  pendingPersistTimer = setTimeout(() => {
    flushPendingRecoverySnapshot();
  }, 1500);
}

/**
 * 当当前窗口的文件正常保存或放弃更改时，仅清除当前文件/会话对应的快照
 */
export function clearRecoverySnapshot(filePath?: string | null, tabId?: string) {
  if (pendingPersistTimer) {
    clearTimeout(pendingPersistTimer);
    pendingPersistTimer = null;
  }
  pendingSnapshotData = null;

  const map = readSnapshotMap();
  delete map[CURRENT_SESSION_ID];
  delete map["legacy"];
  invoke("clear_draft_snapshot", { fileId: CURRENT_SESSION_ID }).catch(() => {});
  if (tabId) {
    const tabKey = `${CURRENT_SESSION_ID}::${tabId}`;
    delete map[tabKey];
    invoke("clear_draft_snapshot", { fileId: tabKey }).catch(() => {});
  }
  if (filePath) {
    const fileKey = `file::${filePath.replace(/\\/g, "/").toLowerCase()}`;
    delete map[fileKey];
    invoke("clear_draft_snapshot", { fileId: fileKey }).catch(() => {});
  }
  writeSnapshotMap(map);
}

/**
 * 合并读取 localStorage 与 Rust 磁盘兜底快照，返回最新的一份有效未保存草稿
 */
export async function getRecoverySnapshotAsync(): Promise<{
  key: string;
  snapshot: RecoverySnapshot;
} | null> {
  const map = readSnapshotMap();

  try {
    const diskRecords = await invoke<DiskDraftRecord[]>("load_draft_snapshots");
    if (Array.isArray(diskRecords)) {
      for (const rec of diskRecords) {
        if (!rec || !rec.key || !rec.content) continue;
        const existing = map[rec.key];
        if (!existing || rec.timestamp >= existing.timestamp) {
          map[rec.key] = {
            sessionId: existing?.sessionId || "disk-recovery",
            filePath: rec.filePath ?? null,
            content: rec.content,
            timestamp: rec.timestamp,
            title: rec.title || "未命名文档",
          };
        }
      }
    }
  } catch {
    // 浏览器环境或后端不可用时静默回退到 localStorage
  }

  const entries = Object.entries(map);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
  const [key, snapshot] = entries[0];
  return { key, snapshot };
}

/**
 * 应用启动时检查是否存在未正常保存的快照，若存在且与磁盘原文件确实不同则提示一键恢复
 */
export async function checkAndPromptRecovery(
  onRecover: (snapshot: RecoverySnapshot) => void,
  onDiscard?: () => void
) {
  const found = await getRecoverySnapshotAsync();
  if (!found || !found.snapshot.content || !found.snapshot.content.trim()) return;

  const { key, snapshot } = found;

  const removeSpecificKey = () => {
    const map = readSnapshotMap();
    delete map[key];
    writeSnapshotMap(map);
    invoke("clear_draft_snapshot", { fileId: key }).catch(() => {});
  };

  if (Date.now() - snapshot.timestamp > 7 * 24 * 3600 * 1000) {
    removeSpecificKey();
    return;
  }

  // 若快照关联了本地文件且快照内容与磁盘文件内容完全一致，说明已保存，直接静默清理
  if (snapshot.filePath) {
    try {
      const diskContent = await invoke<string>("read_file_content", {
        path: snapshot.filePath,
      });
      if (diskContent === snapshot.content) {
        removeSpecificKey();
        return;
      }
    } catch {
      // 文件可能已被移动或删除，继续展示恢复横幅
    }
  }

  if (document.querySelector(".ty-recovery-banner")) return;

  const banner = document.createElement("div");
  banner.className = "ty-recovery-banner";
  const dateObj = new Date(snapshot.timestamp);
  const timeStr = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日 ${dateObj.toLocaleTimeString(
    [],
    { hour: "2-digit", minute: "2-digit", second: "2-digit" }
  )}`;
  const safeTitle = escapeHtml(snapshot.title || "未命名文档");

  banner.innerHTML = `
    <div class="recovery-text">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
      <span>发现未正常保存的文档快照: <strong>${safeTitle}</strong> (${timeStr})</span>
    </div>
    <div class="recovery-actions">
      <button type="button" class="recovery-btn btn-restore" title="恢复上次编辑内容">恢复草稿</button>
      <button type="button" class="recovery-btn btn-discard" title="永久丢弃此快照">丢弃</button>
    </div>
  `;

  banner.querySelector(".btn-restore")?.addEventListener("click", () => {
    removeSpecificKey();
    onRecover(snapshot);
    banner.remove();
  });

  banner.querySelector(".btn-discard")?.addEventListener("click", () => {
    removeSpecificKey();
    banner.remove();
    onDiscard?.();
  });

  const editorPane =
    document.getElementById("content") ||
    document.getElementById("write-wrapper") ||
    document.getElementById("editor-pane");
  if (editorPane) {
    editorPane.insertBefore(banner, editorPane.firstChild);
  }
}
