import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { activeDocumentPath } from "./live-preview";
import { getPreferences } from "../../components/preferences";

export interface DragDropCallbacks {
  onOpenFile?: (filePath: string) => void;
  onOpenWorkspace?: (dirPath: string) => void;
}

/**
 * 注册剪贴板图片粘贴与外部文件拖入管道（支持按偏好设置自动选择 ./assets 或 ./${filename}.assets，
 * 并通过 Rust check_is_directory 精准区分拖入文件夹与普通附件）
 */
export function setupImageAndDropHandlers(
  view: EditorView,
  callbacks?: DragDropCallbacks
) {
  const dom = view.dom;
  let lastDroppedPathTime = 0;

  const handleDroppedPath = async (filePath: string, insertPos: number) => {
    const now = Date.now();
    if (now - lastDroppedPathTime < 250) return;
    lastDroppedPathTime = now;

    const lowerName = filePath.toLowerCase();
    const fileName = filePath.split(/[\\/]/).pop() || "file";

    if (
      lowerName.endsWith(".png") ||
      lowerName.endsWith(".jpg") ||
      lowerName.endsWith(".jpeg") ||
      lowerName.endsWith(".gif") ||
      lowerName.endsWith(".svg") ||
      lowerName.endsWith(".webp") ||
      lowerName.endsWith(".bmp") ||
      lowerName.endsWith(".avif")
    ) {
      try {
        const folderMode = getPreferences().imageFolderMode;
        const relPath: string = await invoke("copy_image_to_assets", {
          docPath: activeDocumentPath,
          sourcePath: filePath,
          folderMode,
        });
        const insertText = `![${fileName}](${relPath})\n`;
        view.dispatch({
          changes: { from: insertPos, insert: insertText },
          selection: { anchor: insertPos + insertText.length },
        });
      } catch (err) {
        console.error("复制拖入图片失败:", err);
      }
      return;
    }

    if (
      lowerName.endsWith(".md") ||
      lowerName.endsWith(".markdown") ||
      lowerName.endsWith(".txt")
    ) {
      if (callbacks?.onOpenFile) {
        callbacks.onOpenFile(filePath);
      }
      return;
    }

    // 校验是否为真实文件夹：仅文件夹才切换工作区，其他类型文件作为 Markdown 链接插入
    const isDir = await invoke<boolean>("check_is_directory", { path: filePath }).catch(
      () => false
    );
    if (isDir) {
      if (callbacks?.onOpenWorkspace) {
        callbacks.onOpenWorkspace(filePath);
      }
    } else {
      const normalizedHref = filePath.replace(/\\/g, "/");
      const insertText = `[${fileName}](${normalizedHref})`;
      view.dispatch({
        changes: { from: insertPos, insert: insertText },
        selection: { anchor: insertPos + insertText.length },
      });
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
            const folderMode = getPreferences().imageFolderMode;
            const relPath: string = await invoke("save_image_asset", {
              docPath: activeDocumentPath,
              filename,
              base64Data,
              folderMode,
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
          dom.classList.remove("drag-hover");
          const paths = event.payload.paths;
          if (!paths || paths.length === 0) return;
          const sel = view.state.selection.main;
          paths.forEach((filePath) => {
            handleDroppedPath(filePath, sel.head);
          });
        } else if (event.payload.type === "leave") {
          dom.classList.remove("drag-hover");
        }
      });
    })
    .catch(() => {
      // 标准浏览器环境静默降级
    });

  // 3. 浏览器原生外部文件 drag/drop 事件兜底
  dom.addEventListener("dragover", (e: DragEvent) => {
    const types = e.dataTransfer?.types;
    if (!types || !Array.from(types).includes("Files")) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
    dom.classList.add("drag-hover");
  });

  dom.addEventListener("dragleave", (e: DragEvent) => {
    if (!dom.contains(e.relatedTarget as Node | null)) {
      dom.classList.remove("drag-hover");
    }
  });

  dom.addEventListener("drop", async (e: DragEvent) => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    dom.classList.remove("drag-hover");

    const dropPos =
      view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const localPath = (file as any).path || "";
      if (localPath) {
        handleDroppedPath(localPath, dropPos);
      }
    }
  });
}
