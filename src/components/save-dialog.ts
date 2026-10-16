/**
 * 优雅的非阻塞全局轻提示 (Toast Notification)，彻底替代生硬的浏览器原生 alert()
 */
export function showToast(
  message: string,
  type: "info" | "success" | "error" = "info",
  durationMs: number = 2800
) {
  let container = document.getElementById("ty-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "ty-toast-container";
    container.className = "ty-toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `ty-toast ty-toast-${type}`;
  const iconSvg =
    type === "error"
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`
      : type === "success"
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"></polyline></svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;

  const span = document.createElement("span");
  span.textContent = message;
  toast.innerHTML = iconSvg;
  toast.appendChild(span);

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 220);
  }, durationMs);
}

/**
 * 弹出非阻塞删除确认模态框，彻底替代原生 confirm()
 */
export function showDeleteConfirmDialog(itemName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const existing = document.getElementById("ty-delete-confirm-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "ty-delete-confirm-modal";
    overlay.className = "ty-modal-overlay";

    overlay.innerHTML = `
      <div class="ty-modal-card save-confirm-dialog" role="dialog" aria-modal="true">
        <div class="save-dialog-header">删除确认</div>
        <div class="save-dialog-body">
          <div class="save-dialog-primary-text">确定要永久删除 “${itemName.replace(/</g, "&lt;")}” 吗？</div>
          <div class="save-dialog-secondary-text">此操作将直接从磁盘移除该项，无法撤销。</div>
        </div>
        <div class="save-dialog-footer">
          <div class="save-footer-left"></div>
          <div class="save-footer-right" style="display:flex; gap: 8px;">
            <button type="button" class="save-dialog-btn btn-cancel" id="del-dlg-btn-cancel">取消</button>
            <button type="button" class="save-dialog-btn btn-danger" id="del-dlg-btn-confirm">确认删除</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const cleanup = () => {
      window.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
    };

    const finish = (ok: boolean) => {
      cleanup();
      resolve(ok);
    };

    const confirmBtn = overlay.querySelector("#del-dlg-btn-confirm") as HTMLButtonElement;
    const cancelBtn = overlay.querySelector("#del-dlg-btn-cancel") as HTMLButtonElement;

    confirmBtn.addEventListener("click", () => finish(true));
    cancelBtn.addEventListener("click", () => finish(false));
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) finish(false);
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    setTimeout(() => confirmBtn?.focus(), 20);
  });
}

/**
 * 弹出 Typora / Word 风格的保存确认弹窗
 * 返回:
 * - "save": 用户确认保存
 * - "discard": 放弃更改
 * - "cancel": 取消当前动作，留在原文档
 */
export function showSaveConfirmDialog(options?: {
  fileName?: string;
}): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    const existing = document.getElementById("ty-save-confirm-modal");
    if (existing) existing.remove();

    const fileName = (options?.fileName || "当前文档").replace(/</g, "&lt;");

    const overlay = document.createElement("div");
    overlay.id = "ty-save-confirm-modal";
    overlay.className = "ty-modal-overlay";

    overlay.innerHTML = `
      <div class="ty-modal-card save-confirm-dialog" role="dialog" aria-modal="true">
        <div class="save-dialog-header">保存</div>
        <div class="save-dialog-body">
          <div class="save-dialog-primary-text">是否保存更改？</div>
          <div class="save-dialog-secondary-text">如果不保存，您对 “${fileName}” 的更改将会丢失。</div>
        </div>
        <div class="save-dialog-footer">
          <div class="save-footer-left">
            <button type="button" class="save-dialog-btn btn-save" id="save-dlg-btn-save">保存</button>
            <button type="button" class="save-dialog-btn btn-discard" id="save-dlg-btn-discard">放弃更改</button>
          </div>
          <div class="save-footer-right">
            <button type="button" class="save-dialog-btn btn-cancel" id="save-dlg-btn-cancel">取消</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const cleanup = () => {
      window.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
    };

    const handleChoice = (choice: "save" | "discard" | "cancel") => {
      cleanup();
      resolve(choice);
    };

    const saveBtn = overlay.querySelector("#save-dlg-btn-save") as HTMLButtonElement;
    const discardBtn = overlay.querySelector("#save-dlg-btn-discard") as HTMLButtonElement;
    const cancelBtn = overlay.querySelector("#save-dlg-btn-cancel") as HTMLButtonElement;

    saveBtn.addEventListener("click", () => handleChoice("save"));
    discardBtn.addEventListener("click", () => handleChoice("discard"));
    cancelBtn.addEventListener("click", () => handleChoice("cancel"));

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) {
        handleChoice("cancel");
      }
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleChoice("cancel");
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        handleChoice("save");
      }
    };
    window.addEventListener("keydown", onKeyDown, true);

    setTimeout(() => saveBtn?.focus(), 20);
  });
}
