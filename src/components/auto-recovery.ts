export interface RecoverySnapshot {
  sessionId: string;
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
    // 兼容迁移旧版单键快照
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    console.error("写入自动恢复快照失败:", e);
  }
}

/**
 * 实时在后台按当前窗口会话与文件路径保存脏内容快照，多窗口互不干扰
 */
export function saveRecoverySnapshot(filePath: string | null, content: string, title: string) {
  const map = readSnapshotMap();
  const bucketKey = filePath ? `file::${filePath.replace(/\\/g, "/").toLowerCase()}` : CURRENT_SESSION_ID;
  map[bucketKey] = {
    sessionId: CURRENT_SESSION_ID,
    filePath,
    content,
    timestamp: Date.now(),
    title,
  };
  writeSnapshotMap(map);
}

/**
 * 当当前窗口的文件正常保存或放弃更改时，仅清除当前文件/会话对应的快照，绝不误删其他窗口快照
 */
export function clearRecoverySnapshot(filePath?: string | null) {
  const map = readSnapshotMap();
  delete map[CURRENT_SESSION_ID];
  delete map["legacy"];
  if (filePath) {
    const fileKey = `file::${filePath.replace(/\\/g, "/").toLowerCase()}`;
    delete map[fileKey];
  }
  writeSnapshotMap(map);
}

export function getRecoverySnapshot(): { key: string; snapshot: RecoverySnapshot } | null {
  const map = readSnapshotMap();
  const entries = Object.entries(map);
  if (entries.length === 0) return null;
  // 按时间戳降序取最近的一份未保存快照
  entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
  const [key, snapshot] = entries[0];
  return { key, snapshot };
}

/**
 * 应用启动时检查是否存在未正常保存的快照，若存在则提示一键恢复
 */
export function checkAndPromptRecovery(
  onRecover: (snapshot: RecoverySnapshot) => void,
  onDiscard?: () => void
) {
  const found = getRecoverySnapshot();
  if (!found || !found.snapshot.content || !found.snapshot.content.trim()) return;

  const { key, snapshot } = found;

  if (Date.now() - snapshot.timestamp > 7 * 24 * 3600 * 1000) {
    const map = readSnapshotMap();
    delete map[key];
    writeSnapshotMap(map);
    return;
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

  const removeSpecificKey = () => {
    const map = readSnapshotMap();
    delete map[key];
    writeSnapshotMap(map);
  };

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
