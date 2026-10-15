import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { activeDocumentPath } from "./live-preview";

export interface DragDropCallbacks {
  onOpenFile?: (filePath: string) => void;
  onOpenWorkspace?: (dirPath: string) => void;
}

/**
 * 注册剪贴板图片粘贴与外部文件拖入管道
 */
export function setupImageAndDropHandlers(
  view: EditorView,
  callbacks?: DragDropCallbacks
) {
  const dom = view.dom;

  const handleDroppedPath = async (filePath: string, insertPos: number) => {
    const lowerName = filePath.toLowerCase();
    const fileName = filePath.split(/[\\/]/).pop() || "image.png";

    if (
      lowerName.endsWith(".png") ||
      lowerName.endsWith(".jpg") ||
      lowerName.endsWith(".jpeg") ||
      lowerName.endsWith(".gif") ||
      lowerName.endsWith(".svg") ||
      lowerName.endsWith(".webp") ||
      lowerName.endsWith(".bmp")
    ) {
      try {
        const relPath: string = await invoke("copy_image_to_assets", {
          docPath: activeDocumentPath,
          sourcePath: filePath,
        });
        const insertText = `![${fileName}](${relPath})\n`;
        view.dispatch({
          changes: { from: insertPos, insert: insertText },
          selection: { anchor: insertPos + insertText.length },
        });
      } catch (err) {
        console.error("复制拖入图片失败:", err);
      }
    } else if (
      lowerName.endsWith(".md") ||
      lowerName.endsWith(".markdown") ||
      lowerName.endsWith(".txt")
    ) {
      if (callbacks?.onOpenFile) {
        callbacks.onOpenFile(filePath);
      }
    } else if (callbacks?.onOpenWorkspace) {
      callbacks.onOpenWorkspace(filePath);
    }
  };

  // 1. 拦截剪贴板图片粘贴 (Ctrl+V)
  dom.addEventListener("paste", async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        e.stopPropagation();

        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = async () => {
          const base64Data = reader.result as string;
          const ext = item.type.split("/")[1] || "png";
          const filename = `image-${Date.now()}.${ext}`;

          try {
            const relPath: string = await invoke("save_image_asset", {
              docPath: activeDocumentPath,
              filename,
              base64Data,
            });

            const insertText = `![${filename}](${relPath})\n`;
            const sel = view.state.selection.main;
            view.dispatch({
              changes: { from: sel.from, to: sel.to, insert: insertText },
              selection: { anchor: sel.from + insertText.length },
            });
          } catch (err) {
            console.error("保存粘贴图片失败:", err);
          }
        };
        reader.readAsDataURL(file);
        return;
      }
    }
  });

  // 2. 外部文件拖拽交互 (优先接入 Tauri 原生 onDragDropEvent 事件)
  import("@tauri-apps/api/webview")
    .then(({ getCurrentWebview }) => {
      const webview = getCurrentWebview();
      webview.onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          const paths = event.payload.paths;
          if (!paths || paths.length === 0) return;
          const sel = view.state.selection.main;
          paths.forEach((filePath) => {
            handleDroppedPath(filePath, sel.head);
          });
        }
      });
    })
    .catch(() => {
      console.log("Running in standard browser mode (fallback drop enabled)");
    });

  // 3. 浏览器原生 drag/drop 事件兜底
  dom.addEventListener("dragover", (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
    dom.classList.add("drag-hover");
  });

  dom.addEventListener("dragleave", () => {
    dom.classList.remove("drag-hover");
  });

  dom.addEventListener("drop", async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dom.classList.remove("drag-hover");

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const dropPos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const localPath = (file as any).path || "";
      if (localPath) {
        handleDroppedPath(localPath, dropPos);
      }
    }
  });
}
