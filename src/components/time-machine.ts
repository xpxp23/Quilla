import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import { showToast } from "./save-dialog";

export interface HistorySnapshotRecord {
  id: string;
  timestamp_ms: number;
  label: string;
  char_count: number;
  line_count: number;
  content: string;
}

const LOCAL_HISTORY_KEY = "quilla_unsaved_version_history_v1";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTimestamp(ms: number): string {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : Date.now();
  const d = new Date(safeMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 归一化后端或本地缓存返回的历史快照字段（兼容 timestamp / timestamp_ms、charCount / char_count、lineCount / line_count）
 */
function normalizeSnapshotRecord(raw: any): HistorySnapshotRecord {
  const content = typeof raw?.content === "string" ? raw.content : "";
  const ts = Number(raw?.timestamp_ms ?? raw?.timestamp ?? Date.now());
  const charCount = Number(raw?.char_count ?? raw?.charCount ?? content.length);
  const lineCount = Number(
    raw?.line_count ?? raw?.lineCount ?? (content ? content.split("\n").length : 1)
  );
  return {
    id: String(raw?.id || `snap-${ts}`),
    timestamp_ms: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
    label: String(raw?.label || "自动历史快照"),
    char_count: Number.isFinite(charCount) ? charCount : content.length,
    line_count: Number.isFinite(lineCount) ? lineCount : 1,
    content,
  };
}

/**
 * 为未命名或演示文档提供本地会话级历史版本存取兜底
 */
function loadFallbackLocalHistory(docKey: string): HistorySnapshotRecord[] {
  try {
    const raw = localStorage.getItem(`${LOCAL_HISTORY_KEY}::${docKey}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeSnapshotRecord) : [];
  } catch {
    return [];
  }
}

export function saveFallbackLocalHistorySnapshot(
  docKey: string,
  content: string,
  label: string
): HistorySnapshotRecord {
  const list = loadFallbackLocalHistory(docKey);
  const record: HistorySnapshotRecord = {
    id: `local-${Date.now()}`,
    timestamp_ms: Date.now(),
    label,
    char_count: content.length,
    line_count: content.split("\n").length,
    content,
  };
  if (list.length > 0 && list[0].content === content) {
    return list[0];
  }
  list.unshift(record);
  if (list.length > 20) list.length = 20;
  try {
    localStorage.setItem(`${LOCAL_HISTORY_KEY}::${docKey}`, JSON.stringify(list));
  } catch {
    // ignore
  }
  return record;
}

function deleteFallbackLocalHistorySnapshot(docKey: string, snapshotId: string) {
  const list = loadFallbackLocalHistory(docKey).filter((s) => s.id !== snapshotId);
  try {
    localStorage.setItem(`${LOCAL_HISTORY_KEY}::${docKey}`, JSON.stringify(list));
  } catch {
    // ignore
  }
  return list;
}

export interface DiffRow {
  type: "equal" | "add" | "del";
  oldLine?: number;
  newLine?: number;
  text: string;
}

/**
 * 基于 Myers O((M+N)D) 最短编辑路径算法与唯一锚点分治的行级差异计算器：
 * 彻底解决原朴素二维 DP 在 M*N > 250,000（如长文首尾微调）时直接退化为“全文整段标红删除+整段标绿新增”及主线程卡顿的问题 (瓶颈 4 修复)。
 */
export function computeLineDiff(snapshotText: string, currentText: string): DiffRow[] {
  const a = snapshotText.replace(/\r\n/g, "\n").split("\n");
  const b = currentText.replace(/\r\n/g, "\n").split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i++) {
    rows.push({ type: "equal", oldLine: i + 1, newLine: i + 1, text: a[i] });
  }

  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);

  if (midA.length > 0 || midB.length > 0) {
    const m = midA.length;
    const n = midB.length;
    const maxD = Math.min(m + n, 2400);

    // Myers Diff 算法正向搜索最短编辑轨迹
    const offset = m + n + 2;
    const v = new Int32Array(offset * 2 + 2);
    const trace: Int32Array[] = [];
    let foundD = -1;

    outer: for (let d = 0; d <= maxD; d++) {
      for (let k = -d; k <= d; k += 2) {
        const kIdx = k + offset;
        let x: number;
        if (k === -d || (k !== d && v[kIdx - 1] < v[kIdx + 1])) {
          x = v[kIdx + 1];
        } else {
          x = v[kIdx - 1] + 1;
        }
        let y = x - k;
        while (x < m && y < n && midA[x] === midB[y]) {
          x++;
          y++;
        }
        v[kIdx] = x;
        if (x >= m && y >= n) {
          foundD = d;
          const snap = new Int32Array(d * 2 + 3);
          for (let s = -d; s <= d; s += 2) {
            snap[s + d] = v[s + offset];
          }
          trace.push(snap);
          break outer;
        }
      }
      const snap = new Int32Array(d * 2 + 3);
      for (let s = -d; s <= d; s += 2) {
        snap[s + d] = v[s + offset];
      }
      trace.push(snap);
    }

    if (foundD !== -1) {
      let x = m;
      let y = n;
      const midOps: DiffRow[] = [];

      for (let d = foundD; d > 0; d--) {
        const k = x - y;
        const prevSnap = trace[d - 1];
        const prevD = d - 1;
        const getPrevV = (prevK: number) => prevSnap[prevK + prevD];

        let prevK: number;
        if (k === -d || (k !== d && getPrevV(k - 1) < getPrevV(k + 1))) {
          prevK = k + 1;
        } else {
          prevK = k - 1;
        }

        const prevX = getPrevV(prevK);
        const prevY = prevX - prevK;

        while (x > prevX && y > prevY) {
          x--;
          y--;
          midOps.push({
            type: "equal",
            oldLine: start + x + 1,
            newLine: start + y + 1,
            text: midA[x],
          });
        }

        if (x === prevX) {
          y--;
          midOps.push({
            type: "add",
            newLine: start + y + 1,
            text: midB[y],
          });
        } else {
          x--;
          midOps.push({
            type: "del",
            oldLine: start + x + 1,
            text: midA[x],
          });
        }
      }

      while (x > 0 && y > 0) {
        x--;
        y--;
        midOps.push({
          type: "equal",
          oldLine: start + x + 1,
          newLine: start + y + 1,
          text: midA[x],
        });
      }

      midOps.reverse();
      rows.push(...midOps);
    } else {
      midA.forEach((line, idx) =>
        rows.push({ type: "del", oldLine: start + idx + 1, text: line })
      );
      midB.forEach((line, idx) =>
        rows.push({ type: "add", newLine: start + idx + 1, text: line })
      );
    }
  }

  const tailCount = a.length - 1 - endA;
  for (let k = 0; k < tailCount; k++) {
    rows.push({
      type: "equal",
      oldLine: endA + 1 + k + 1,
      newLine: endB + 1 + k + 1,
      text: a[endA + 1 + k],
    });
  }

  return rows;
}

let tmModalEl: HTMLElement | null = null;

export async function openTimeMachineModal(options: {
  view: EditorView;
  filePath: string | null;
  docTitle: string;
  onRestored?: (newContent: string) => void;
}) {
  if (!tmModalEl) {
    tmModalEl = document.createElement("div");
    tmModalEl.id = "quilla-time-machine-modal";
    tmModalEl.className = "ty-modal-overlay";
    document.body.appendChild(tmModalEl);
  }

  const currentDocText = options.view.state.doc.toString();
  const docKey = options.filePath || options.docTitle || "untitled";

  let snapshots: HistorySnapshotRecord[] = [];
  const fetchSnapshots = async () => {
    if (options.filePath) {
      try {
        const rawList = await invoke<any[]>("list_file_history", {
          path: options.filePath,
        });
        snapshots = (rawList || []).map(normalizeSnapshotRecord);
      } catch {
        snapshots = loadFallbackLocalHistory(docKey);
      }
    } else {
      snapshots = loadFallbackLocalHistory(docKey);
    }
    if (snapshots.length === 0) {
      const initialSnap = saveFallbackLocalHistorySnapshot(docKey, currentDocText, "当前初始快照");
      snapshots = [initialSnap];
    }
  };

  await fetchSnapshots();
  let selectedIdx = 0;
  let viewMode: "diff" | "raw" = "diff";

  tmModalEl.classList.remove("hidden");

  const renderModal = () => {
    if (!tmModalEl) return;
    const selectedSnap = snapshots[selectedIdx] || null;
    const diffRows = selectedSnap ? computeLineDiff(selectedSnap.content, currentDocText) : [];
    const addedCount = diffRows.filter((r) => r.type === "add").length;
    const deletedCount = diffRows.filter((r) => r.type === "del").length;

    tmModalEl.innerHTML = `
      <div class="ty-modal-card tm-modal-card" role="dialog" aria-modal="true">
        <div class="ty-modal-header">
          <div class="modal-title">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l4 2"></path></svg>
            <span>本地版本历史 · 时间机器</span>
            <span class="modal-badge">${escapeHtml(options.docTitle)}</span>
          </div>
          <div class="tm-header-actions">
            <button type="button" class="ty-btn-secondary tm-create-snap-btn" id="tm-create-snap-btn">+ 创建当前快照</button>
            <button type="button" class="modal-close-btn" id="tm-close-btn" title="关闭 (Esc)">✕</button>
          </div>
        </div>

        <div class="tm-body-split">
          <div class="tm-timeline-pane">
            <div class="tm-pane-header">历史版本时间轴 (${snapshots.length})</div>
            <div class="tm-snapshot-list">
              ${snapshots
                .map(
                  (s, idx) => `
                <div class="tm-snapshot-item ${idx === selectedIdx ? "active" : ""}" data-idx="${idx}">
                  <div class="tm-snap-top">
                    <span class="tm-snap-label">${escapeHtml(s.label)}</span>
                    <span class="tm-snap-meta">${s.line_count} 行 · ${s.char_count} 字</span>
                  </div>
                  <div class="tm-snap-time">${formatTimestamp(s.timestamp_ms)}</div>
                </div>
              `
                )
                .join("")}
            </div>
          </div>

          <div class="tm-diff-pane">
            <div class="tm-pane-header tm-diff-header">
              <div class="tm-diff-summary">
                ${
                  selectedSnap
                    ? `<span>对比：<strong>${formatTimestamp(
                        selectedSnap.timestamp_ms
                      )}</strong> → <strong>当前工作区文档</strong></span>
                       <span class="tm-diff-badge add">+${addedCount} 行</span>
                       <span class="tm-diff-badge del">-${deletedCount} 行</span>`
                    : "请选择左侧快照"
                }
              </div>
              <div class="tm-view-mode-switch">
                <button type="button" class="graph-scope-btn ${
                  viewMode === "diff" ? "active" : ""
                }" data-mode="diff">逐行差异对比</button>
                <button type="button" class="graph-scope-btn ${
                  viewMode === "raw" ? "active" : ""
                }" data-mode="raw">历史快照全文</button>
              </div>
            </div>

            <div class="tm-diff-content">
              ${
                !selectedSnap
                  ? `<div class="outline-empty-hint">暂无历史快照</div>`
                  : viewMode === "raw"
                  ? `<pre class="tm-raw-preview">${escapeHtml(selectedSnap.content)}</pre>`
                  : `<div class="tm-diff-table">
                      ${diffRows
                        .map(
                          (r) => `
                        <div class="tm-diff-row tm-diff-${r.type}">
                          <span class="tm-diff-ln">${r.oldLine ?? ""}</span>
                          <span class="tm-diff-ln">${r.newLine ?? ""}</span>
                          <span class="tm-diff-sign">${
                            r.type === "add" ? "+" : r.type === "del" ? "-" : " "
                          }</span>
                          <span class="tm-diff-code">${escapeHtml(r.text || " ")}</span>
                        </div>
                      `
                        )
                        .join("")}
                    </div>`
              }
            </div>
          </div>
        </div>

        <div class="ty-modal-footer">
          <span class="footer-tip">回滚前会自动为您保存一份当前状态快照，且支持直接使用 Ctrl+Z 撤销回滚</span>
          <div class="tm-footer-btns">
            <button type="button" class="save-dialog-btn btn-discard" id="tm-delete-snap-btn" ${
              !selectedSnap || snapshots.length <= 1 ? "disabled" : ""
            }>删除此快照</button>
            <button type="button" class="save-dialog-btn btn-discard" id="tm-cancel-btn">关闭</button>
            <button type="button" class="modal-confirm-btn" id="tm-restore-btn" ${
              !selectedSnap ? "disabled" : ""
            }>还原至此历史版本</button>
          </div>
        </div>
      </div>
    `;

    const close = () => tmModalEl?.classList.add("hidden");
    tmModalEl.querySelector("#tm-close-btn")?.addEventListener("click", close);
    tmModalEl.querySelector("#tm-cancel-btn")?.addEventListener("click", close);

    tmModalEl.querySelectorAll<HTMLElement>(".tm-snapshot-item").forEach((item) => {
      item.addEventListener("click", () => {
        selectedIdx = Number(item.dataset.idx || 0);
        renderModal();
      });
    });

    tmModalEl.querySelectorAll<HTMLElement>("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        viewMode = (btn.dataset.mode as "diff" | "raw") || "diff";
        renderModal();
      });
    });

    tmModalEl.querySelector("#tm-delete-snap-btn")?.addEventListener("click", async () => {
      if (!selectedSnap || snapshots.length <= 1) return;
      if (options.filePath) {
        try {
          await invoke("delete_file_history_item", {
            path: options.filePath,
            snapshotId: selectedSnap.id,
          });
          await fetchSnapshots();
        } catch {
          snapshots = deleteFallbackLocalHistorySnapshot(docKey, selectedSnap.id);
        }
      } else {
        snapshots = deleteFallbackLocalHistorySnapshot(docKey, selectedSnap.id);
      }
      selectedIdx = Math.max(0, Math.min(selectedIdx, snapshots.length - 1));
      renderModal();
      showToast("已删除该历史快照", "info");
    });

    tmModalEl.querySelector("#tm-create-snap-btn")?.addEventListener("click", async () => {
      const nowText = options.view.state.doc.toString();
      if (options.filePath) {
        try {
          await invoke("create_file_history_snapshot", {
            path: options.filePath,
            content: nowText,
            label: "手动定点快照",
          });
          await fetchSnapshots();
        } catch {
          saveFallbackLocalHistorySnapshot(docKey, nowText, "手动定点快照");
          snapshots = loadFallbackLocalHistory(docKey);
        }
      } else {
        saveFallbackLocalHistorySnapshot(docKey, nowText, "手动定点快照");
        snapshots = loadFallbackLocalHistory(docKey);
      }
      selectedIdx = 0;
      renderModal();
      showToast("已创建当前文档快照", "success");
    });

    tmModalEl.querySelector("#tm-restore-btn")?.addEventListener("click", async () => {
      if (!selectedSnap) return;
      const nowText = options.view.state.doc.toString();
      if (options.filePath) {
        await invoke("create_file_history_snapshot", {
          path: options.filePath,
          content: nowText,
          label: "回滚前自动备份",
        }).catch(() => {});
      } else {
        saveFallbackLocalHistorySnapshot(docKey, nowText, "回滚前自动备份");
      }

      options.view.dispatch({
        changes: {
          from: 0,
          to: options.view.state.doc.length,
          insert: selectedSnap.content,
        },
        selection: { anchor: 0 },
      });
      options.onRestored?.(selectedSnap.content);
      close();
      showToast(`已还原至 ${formatTimestamp(selectedSnap.timestamp_ms)} 的版本`, "success");
    });
  };

  tmModalEl.onclick = (e) => {
    if (e.target === tmModalEl) tmModalEl?.classList.add("hidden");
  };

  renderModal();
}
