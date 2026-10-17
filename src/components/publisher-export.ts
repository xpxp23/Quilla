import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./save-dialog";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 将已渲染的 HTML 块转换为 100% 内联 CSS 样式树，专为微信公众号后台、知乎专栏、飞书/Notion 粘贴优化
 */
export function buildWeChatInlineHtml(bodyHtml: string, title: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<section id="quilla-wechat-root">${bodyHtml}</section>`,
    "text/html"
  );
  const root = doc.getElementById("quilla-wechat-root")!;
  root.setAttribute(
    "style",
    "font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; font-size: 15px; line-height: 1.8; color: #24292f; word-break: break-word; padding: 4px 2px;"
  );

  root.querySelectorAll("h1").forEach((el) => {
    el.setAttribute(
      "style",
      "font-size: 22px; font-weight: 700; color: #1f2328; margin: 26px 0 14px; padding-bottom: 8px; border-bottom: 2px solid #0969da; line-height: 1.35;"
    );
  });

  root.querySelectorAll("h2").forEach((el) => {
    el.setAttribute(
      "style",
      "font-size: 18px; font-weight: 700; color: #1f2328; margin: 22px 0 12px; padding-left: 10px; border-left: 4px solid #0969da; line-height: 1.4;"
    );
  });

  root.querySelectorAll("h3, h4, h5, h6").forEach((el) => {
    el.setAttribute(
      "style",
      "font-size: 16px; font-weight: 700; color: #1f2328; margin: 18px 0 8px; line-height: 1.45;"
    );
  });

  root.querySelectorAll("p").forEach((el) => {
    el.setAttribute(
      "style",
      "margin: 10px 0; line-height: 1.8; color: #24292f; font-size: 15px;"
    );
  });

  root.querySelectorAll("blockquote").forEach((el) => {
    el.setAttribute(
      "style",
      "margin: 14px 0; padding: 10px 16px; border-left: 4px solid #0969da; background-color: #f6f8fa; color: #57606a; border-radius: 0 6px 6px 0; font-size: 14.5px;"
    );
  });

  root.querySelectorAll(".cm-callout-export").forEach((el) => {
    el.setAttribute(
      "style",
      "margin: 14px 0; padding: 12px 16px; border-left: 4px solid #0969da; background-color: #f0f7ff; border-radius: 6px; color: #24292f;"
    );
  });

  root.querySelectorAll(".cm-callout-header-widget").forEach((el) => {
    el.setAttribute(
      "style",
      "font-weight: 700; color: #0969da; margin-bottom: 6px; font-size: 14.5px;"
    );
  });

  root.querySelectorAll("pre").forEach((el) => {
    el.setAttribute(
      "style",
      "margin: 14px 0; padding: 14px 16px; background-color: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; overflow-x: auto; font-family: Consolas, 'JetBrains Mono', Menlo, monospace; font-size: 13px; line-height: 1.6; color: #24292f;"
    );
  });

  root.querySelectorAll("code").forEach((el) => {
    if (el.parentElement?.tagName.toLowerCase() === "pre") {
      el.setAttribute(
        "style",
        "font-family: Consolas, 'JetBrains Mono', Menlo, monospace; font-size: 13px; background: transparent; padding: 0;"
      );
    } else {
      el.setAttribute(
        "style",
        "font-family: Consolas, Menlo, monospace; font-size: 13.5px; background-color: rgba(175, 184, 193, 0.2); color: #cf222e; padding: 2px 5px; border-radius: 4px;"
      );
    }
  });

  root.querySelectorAll("table").forEach((el) => {
    el.setAttribute(
      "style",
      "border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; border: 1px solid #d0d7de;"
    );
  });

  root.querySelectorAll("th").forEach((el) => {
    const align = (el as HTMLElement).style.textAlign || "left";
    el.setAttribute(
      "style",
      `border: 1px solid #d0d7de; padding: 8px 12px; background-color: #f6f8fa; font-weight: 600; text-align: ${align};`
    );
  });

  root.querySelectorAll("td").forEach((el) => {
    const align = (el as HTMLElement).style.textAlign || "left";
    el.setAttribute(
      "style",
      `border: 1px solid #d0d7de; padding: 8px 12px; text-align: ${align};`
    );
  });

  root.querySelectorAll("mark").forEach((el) => {
    el.setAttribute(
      "style",
      "background-color: #fff8c5; color: #24292f; padding: 1px 4px; border-radius: 3px;"
    );
  });

  root.querySelectorAll("a").forEach((el) => {
    el.setAttribute("style", "color: #0969da; text-decoration: none; border-bottom: 1px solid rgba(9,105,218,0.35);");
  });

  root.querySelectorAll("ul, ol").forEach((el) => {
    el.setAttribute("style", "margin: 8px 0; padding-left: 22px; line-height: 1.75;");
  });

  root.querySelectorAll("li").forEach((el) => {
    el.setAttribute("style", "margin: 4px 0;");
  });

  root.querySelectorAll(".cm-wikilink, .cm-hashtag").forEach((el) => {
    el.setAttribute(
      "style",
      "display: inline-block; padding: 1px 7px; border-radius: 10px; background-color: #eef6ff; color: #0969da; font-size: 13px; font-weight: 500;"
    );
  });

  // 添加底部优雅署名尾注
  const footer = doc.createElement("p");
  footer.setAttribute(
    "style",
    "margin-top: 24px; padding-top: 10px; border-top: 1px dashed #d0d7de; font-size: 12px; color: #8c959f; text-align: right;"
  );
  footer.textContent = `由 Quilla (羽墨) v0.5 排版生成 · ${title}`;
  root.appendChild(footer);

  return root.outerHTML;
}

/**
 * 一键复制为微信公众号 / 知乎专栏富文本
 */
export async function copyForWeChatOrZhihu(bodyHtml: string, title: string) {
  const inlineHtml = buildWeChatInlineHtml(bodyHtml, title);
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = inlineHtml;
  const plainText = tempDiv.innerText || tempDiv.textContent || "";

  try {
    if (navigator.clipboard && typeof ClipboardItem !== "undefined") {
      const htmlBlob = new Blob([inlineHtml], { type: "text/html" });
      const textBlob = new Blob([plainText], { type: "text/plain" });
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": htmlBlob,
          "text/plain": textBlob,
        }),
      ]);
      showToast("已复制公众号 / 知乎内联富文本，可直接粘贴至后台！", "success");
      return;
    }
  } catch {
    // 降级到选区复制
  }

  const mount = document.createElement("div");
  mount.style.position = "fixed";
  mount.style.left = "-9999px";
  mount.style.top = "0";
  mount.innerHTML = inlineHtml;
  document.body.appendChild(mount);

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(mount);
  selection?.removeAllRanges();
  selection?.addRange(range);
  try {
    document.execCommand("copy");
    showToast("已复制公众号 / 知乎内联富文本，可直接粘贴至后台！", "success");
  } catch {
    showToast("复制富文本失败，请重试", "error");
  } finally {
    selection?.removeAllRanges();
    mount.remove();
  }
}

/**
 * 导出为兼容 Microsoft Word / WPS 的标准 .doc 文档
 */
export async function exportWordDocument(bodyHtml: string, title: string) {
  const inlineHtml = buildWeChatInlineHtml(bodyHtml, title);
  const wordDocContent = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:w="urn:schemas-microsoft-com:office:word"
xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<!--[if gte mso 9]>
<xml>
  <w:WordDocument>
    <w:View>Print</w:View>
    <w:Zoom>100</w:Zoom>
    <w:DoNotOptimizeForBrowser/>
  </w:WordDocument>
</xml>
<![endif]-->
<style>
  @page { size: A4; margin: 2.54cm 2.54cm 2.54cm 2.54cm; }
  body { font-family: "PingFang SC", "Microsoft YaHei", SimSun, sans-serif; font-size: 11pt; line-height: 1.75; color: #24292f; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d0d7de; padding: 6pt 8pt; }
</style>
</head>
<body>
${inlineHtml}
</body>
</html>`;

  try {
    const selectedPath: string | null = await invoke("select_save_file_path", {
      defaultName: `${title}.doc`,
    });
    if (selectedPath && selectedPath.trim()) {
      const target = selectedPath.trim().replace(/\.(md|markdown)$/i, ".doc");
      await invoke("save_file_content", {
        path: target,
        content: wordDocContent,
      });
      showToast(`已导出 Word 文档：${target.split(/[\\/]/).pop()}`, "success");
      return;
    }
  } catch {
    // 浏览器下载兜底
  }

  const blob = new Blob(["\ufeff", wordDocContent], {
    type: "application/msword;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title}.doc`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`已导出 Word 文档：${title}.doc`, "success");
}

let posterModalEl: HTMLElement | null = null;

/**
 * 打开社交长图分享卡片工作台（支持切换主题配色并一键导出高清 PNG 长图）
 */
export function openSharePosterModal(options: {
  bodyHtml: string;
  title: string;
  wordCount: number;
  charCount: number;
}) {
  if (!posterModalEl) {
    posterModalEl = document.createElement("div");
    posterModalEl.id = "quilla-poster-modal";
    posterModalEl.className = "ty-modal-overlay";
    document.body.appendChild(posterModalEl);
  }

  let currentSkin: "ivory" | "dark" | "mint" = "ivory";
  const dateStr = new Date().toISOString().slice(0, 10);

  posterModalEl.classList.remove("hidden");

  const renderPosterView = () => {
    if (!posterModalEl) return;
    posterModalEl.innerHTML = `
      <div class="ty-modal-card poster-modal-card" role="dialog" aria-modal="true">
        <div class="ty-modal-header">
          <div class="modal-title">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            <span>导出社交长图分享卡片</span>
          </div>
          <div class="graph-toolbar-controls">
            <div class="graph-scope-Segment">
              <button type="button" class="graph-scope-btn ${currentSkin === "ivory" ? "active" : ""}" data-skin="ivory">羊皮书卷</button>
              <button type="button" class="graph-scope-btn ${currentSkin === "mint" ? "active" : ""}" data-skin="mint">清晨薄荷</button>
              <button type="button" class="graph-scope-btn ${currentSkin === "dark" ? "active" : ""}" data-skin="dark">极客暗夜</button>
            </div>
            <button type="button" class="modal-close-btn" id="poster-close-btn" title="关闭 (Esc)">✕</button>
          </div>
        </div>

        <div class="poster-preview-scroller">
          <div class="poster-card-stage skin-${currentSkin}" id="quilla-poster-stage">
            <div class="poster-card-header">
              <div class="poster-brand-pill">QUILLA · 羽墨笔记</div>
              <div class="poster-meta-line">${dateStr} · ${options.wordCount} 词 · 约 ${Math.max(1, Math.ceil(options.wordCount / 260))} 分钟阅读</div>
            </div>
            <div class="poster-card-body">
              ${options.bodyHtml}
            </div>
            <div class="poster-card-footer">
              <span>Written with Quilla (羽墨) v0.5</span>
              <span>Markdown Knowledge Studio</span>
            </div>
          </div>
        </div>

        <div class="ty-modal-footer">
          <span class="footer-tip">支持一键生成高清长图卡片，方便分享至社交平台或保存为知识卡片</span>
          <div class="tm-footer-btns">
            <button type="button" class="save-dialog-btn btn-discard" id="poster-cancel-btn">关闭</button>
            <button type="button" class="modal-confirm-btn" id="poster-download-btn">下载高清长图 (.png)</button>
          </div>
        </div>
      </div>
    `;

    const close = () => posterModalEl?.classList.add("hidden");
    posterModalEl.querySelector("#poster-close-btn")?.addEventListener("click", close);
    posterModalEl.querySelector("#poster-cancel-btn")?.addEventListener("click", close);

    posterModalEl.querySelectorAll<HTMLElement>("[data-skin]").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentSkin = (btn.dataset.skin as any) || "ivory";
        renderPosterView();
      });
    });

    posterModalEl.querySelector("#poster-download-btn")?.addEventListener("click", async () => {
      const stage = document.getElementById("quilla-poster-stage");
      if (!stage) return;
      await exportDomStageToPng(stage, options.title, currentSkin);
    });
  };

  posterModalEl.onclick = (e) => {
    if (e.target === posterModalEl) posterModalEl?.classList.add("hidden");
  };

  renderPosterView();
}

async function exportDomStageToPng(
  stage: HTMLElement,
  title: string,
  skin: "ivory" | "dark" | "mint"
) {
  const width = stage.offsetWidth || 640;
  const height = stage.offsetHeight || 800;

  const bgColors = {
    ivory: "#faf7f0",
    mint: "#f3faf7",
    dark: "#181b20",
  };
  const textColors = {
    ivory: "#2c2621",
    mint: "#1d312a",
    dark: "#e6edf3",
  };

  const cloned = stage.cloneNode(true) as HTMLElement;
  cloned.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  cloned.style.width = `${width}px`;
  cloned.style.height = `${height}px`;
  cloned.style.margin = "0";
  cloned.style.boxSizing = "border-box";
  cloned.style.background = bgColors[skin];
  cloned.style.color = textColors[skin];
  cloned.style.padding = "36px 40px";
  cloned.style.fontFamily =
    "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  cloned.style.lineHeight = "1.75";

  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <foreignObject width="100%" height="100%">
      ${new XMLSerializer().serializeToString(cloned)}
    </foreignObject>
  </svg>`;

  const svgDataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
  const img = new Image();
  img.crossOrigin = "anonymous";

  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);

    try {
      const pngUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = pngUrl;
      a.download = `${title}-card.png`;
      a.click();
      showToast("已导出高清分享长图 (.png)", "success");
    } catch {
      // 若包含跨域外链图片污染 canvas，优雅降级导出独立矢量 SVG 卡片
      const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title}-card.svg`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("已导出高清矢量分享卡片 (.svg)", "success");
    }
  };

  img.onerror = () => {
    const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}-card.svg`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("已导出高清矢量分享卡片 (.svg)", "success");
  };

  img.src = svgDataUrl;
}
