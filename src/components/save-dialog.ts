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
    // 移除已有的弹窗
    const existing = document.getElementById("ty-save-confirm-modal");
    if (existing) existing.remove();

    const fileName = options?.fileName || "当前文档";

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

    // 点击遮罩空白区 = 取消
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

    // 默认聚焦在 [保存] 按钮上
    setTimeout(() => saveBtn?.focus(), 20);
  });
}
