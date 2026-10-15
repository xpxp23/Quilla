export interface RecoverySnapshot {
  filePath: string | null;
  content: string;
  timestamp: number;
  title: string;
}

const STORAGE_KEY = "typora_auto_recovery_snapshot";

/**
 * 实时/定时在后台保存脏内容快照，杜绝意外闪退或断电导致内容丢失
 */
export function saveRecoverySnapshot(filePath: string | null, content: string, title: string) {
  try {
    const data: RecoverySnapshot = {
      filePath,
      content,
      timestamp: Date.now(),
      title,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error("保存自动恢复快照失败:", e);
  }
}

/**
 * 当文件正常保存或丢弃时，清除后台暂存快照
 */
export function clearRecoverySnapshot() {
  localStorage.removeItem(STORAGE_KEY);
}

export function getRecoverySnapshot(): RecoverySnapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 应用启动时检查是否存在未正常保存的快照，若存在则提示一键恢复
 */
export function checkAndPromptRecovery(
  onRecover: (snapshot: RecoverySnapshot) => void,
  onDiscard?: () => void
) {
  const snapshot = getRecoverySnapshot();
  if (!snapshot || !snapshot.content || !snapshot.content.trim()) return;

  // 若快照超过 7 天则自动废弃清理
  if (Date.now() - snapshot.timestamp > 7 * 24 * 3600 * 1000) {
    clearRecoverySnapshot();
    return;
  }

  // 避免重复挂载
  if (document.querySelector(".ty-recovery-banner")) return;

  const banner = document.createElement("div");
  banner.className = "ty-recovery-banner";
  const dateObj = new Date(snapshot.timestamp);
  const timeStr = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日 ${dateObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;

  banner.innerHTML = `
    <div class="recovery-text">
      <span class="recovery-icon">⚠️</span>
      <span>发现未正常保存的文档快照: <strong>${snapshot.title || "未命名文档"}</strong> (${timeStr})</span>
    </div>
    <div class="recovery-actions">
      <button class="recovery-btn btn-restore" title="恢复上次编辑内容">恢复草稿</button>
      <button class="recovery-btn btn-discard" title="永久丢弃此快照">丢弃</button>
    </div>
  `;

  banner.querySelector(".btn-restore")?.addEventListener("click", () => {
    onRecover(snapshot);
    banner.remove();
    clearRecoverySnapshot();
  });

  banner.querySelector(".btn-discard")?.addEventListener("click", () => {
    banner.remove();
    clearRecoverySnapshot();
    onDiscard?.();
  });

  const editorPane = document.getElementById("editor-pane");
  if (editorPane) {
    editorPane.insertBefore(banner, editorPane.firstChild);
  }
}
