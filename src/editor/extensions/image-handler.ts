import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { activeDocumentPath } from "./live-preview";
import { getPreferences } from "../../components/preferences";
import { showToast } from "../../components/save-dialog";

export interface DragDropCallbacks {
  onOpenFile?: (filePath: string) => void;
  onOpenWorkspace?: (dirPath: string) => void;
}

/**
 * 将本地图片或 Base64 图像一键上传至当前配置的图床 (PicGo / GitHub / 自定义 Webhook)
 */
export async function uploadImageAssetToBed(options: {
  localPath?: string;
  base64Data?: string;
  filename: string;
}): Promise<string> {
  const prefs = getPreferences();
  const cfg = prefs.imageBedConfig;
  if (!cfg || cfg.provider === "none") {
    throw new Error("请先在「偏好设置 -> 图片资产与图床服务」中配置图床通道 (PicGo / GitHub / 自定义)");
  }

  return await invoke<string>("upload_image_to_bed", {
    localPath: options.localPath || null,
    base64Data: options.base64Data || null,
    filename: options.filename,
    config: {
      provider: cfg.provider,
      picgoUrl: cfg.picgoUrl || "http://127.0.0.1:36677/upload",
      githubRepo: cfg.githubRepo || "",
      githubBranch: cfg.githubBranch || "main",
      githubToken: cfg.githubToken || "",
      githubPathPrefix: cfg.githubPathPrefix || "assets",
      githubCustomDomain: cfg.githubCustomDomain || "",
      customUploadUrl: cfg.customUploadUrl || "",
      customAuthHeader: cfg.customAuthHeader || "",
    },
  });
}

/**
 * 注册剪贴板图片粘贴与外部文件拖入管道（支持 ./assets、./${filename}.assets、同级目录与自定义目录策略，
 * 支持粘贴/拖入时自动上传至 PicGo / GitHub / 自定义图床，并通过 Rust check_is_directory 精准区分文件夹与附件）
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
      const prefs = getPreferences();

      // 若开启了自动上传图床，优先尝试上传图床并直接插入远端 URL
      if (prefs.autoUploadImageToBed && prefs.imageBedConfig?.provider !== "none") {
        try {
          showToast(`正在上传图片至 ${prefs.imageBedConfig.provider.toUpperCase()} 图床...`, "info");
          const remoteUrl = await uploadImageAssetToBed({
            localPath: filePath,
            filename: fileName,
          });
          const insertText = `![${fileName}](${remoteUrl})\n`;
          view.dispatch({
            changes: { from: insertPos, insert: insertText },
            selection: { anchor: insertPos + insertText.length },
          });
          showToast("图片已自动上传图床并插入外链", "success");
          return;
        } catch (uploadErr) {
          showToast(`图床上传失败，已自动降级存为本地相对路径 (${uploadErr})`, "info");
        }
      }

      try {
        const relPath: string = await invoke("copy_image_to_assets", {
          docPath: activeDocumentPath,
          sourcePath: filePath,
          folderMode: prefs.imageFolderMode,
          customFolder: prefs.customImageFolder || null,
          namingMode: prefs.imageNamingMode || "original",
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
      lowerName.endsWith(".mdown") ||
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
          const prefs = getPreferences();

          try {
            const relPath: string = await invoke("save_image_asset", {
              docPath: activeDocumentPath,
              filename,
              base64Data,
              folderMode: prefs.imageFolderMode,
              customFolder: prefs.customImageFolder || null,
              namingMode: prefs.imageNamingMode || "timestamp",
            });

            let finalUrl = relPath;
            if (prefs.autoUploadImageToBed && prefs.imageBedConfig?.provider !== "none") {
              try {
                showToast(`正在上传粘贴图片至 ${prefs.imageBedConfig.provider.toUpperCase()} 图床...`, "info");
                let resolvedLocalPath: string | undefined;
                if (activeDocumentPath && !relPath.startsWith("http")) {
                  const parentDir = activeDocumentPath.replace(/[\\/][^\\/]+$/, "");
                  resolvedLocalPath = `${parentDir}/${relPath.replace(/^\.\//, "")}`;
                }
                finalUrl = await uploadImageAssetToBed({
                  localPath: resolvedLocalPath,
                  base64Data,
                  filename,
                });
                showToast("粘贴图片已自动上传图床", "success");
              } catch (uploadErr) {
                showToast(`图床上传失败，已保留本地相对路径 (${uploadErr})`, "info");
              }
            }

            const insertText = `![${filename}](${finalUrl})\n`;
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
