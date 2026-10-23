import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./save-dialog";
import {
  getActiveThemeStudioPreset,
  buildThemeStudioExportVariablesCss,
} from "./theme-studio";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SYNTAX_COLOR_MAP_LIGHT: Record<string, string> = {
  "cm-syn-keyword": "color: #cf222e; font-weight: 600;",
  "cm-syn-string": "color: #0a3069;",
  "cm-syn-comment": "color: #6e7781; font-style: italic;",
  "cm-syn-number": "color: #0550ae;",
  "cm-syn-type": "color: #953800;",
  "cm-syn-function": "color: #8250df;",
  "cm-syn-attr": "color: #116329;",
};

const SYNTAX_COLOR_MAP_DARK: Record<string, string> = {
  "cm-syn-keyword": "color: #ff7b72; font-weight: 600;",
  "cm-syn-string": "color: #a5d6ff;",
  "cm-syn-comment": "color: #8b949e; font-style: italic;",
  "cm-syn-number": "color: #79c0ff;",
  "cm-syn-type": "color: #ffa657;",
  "cm-syn-function": "color: #d2a8ff;",
  "cm-syn-attr": "color: #7ee787;",
};

/**
 * 为根节点内的代码语法高亮 span 写入内联色彩样式
 */
function inlineCodeSyntaxColors(root: HTMLElement, isDark: boolean = false) {
  const map = isDark ? SYNTAX_COLOR_MAP_DARK : SYNTAX_COLOR_MAP_LIGHT;
  Object.entries(map).forEach(([cls, styleStr]) => {
    root.querySelectorAll<HTMLElement>(`.${cls}`).forEach((el) => {
      el.setAttribute("style", styleStr);
    });
  });
}

/**
 * 将 .exported-code-line[data-code-line] 的伪元素行号物化为真实 DOM 节点，
 * 解决微信公众号、Word (.doc) 与 SVG foreignObject 长图导出无法渲染 ::before 伪元素或断行混乱的问题
 */
function materializeCodeBlockLines(
  root: HTMLElement,
  options: { isDark?: boolean; preserveSpacesWithNbsp?: boolean; showLineNumbers?: boolean }
) {
  const showLn = options.showLineNumbers !== false;
  const lnColor = options.isDark ? "#6e7681" : "#8c959f";

  root.querySelectorAll<HTMLElement>("pre").forEach((pre) => {
    const codeLines = Array.from(pre.querySelectorAll<HTMLElement>(".exported-code-line"));
    if (codeLines.length === 0) return;

    const codeEl = pre.querySelector("code") || pre;
    codeEl.innerHTML = "";

    codeLines.forEach((lineSpan, idx) => {
      const lineDiv = root.ownerDocument.createElement("div");
      const isWordMode = Boolean(options.preserveSpacesWithNbsp);
      lineDiv.setAttribute(
        "style",
        isWordMode
          ? "display: block; margin: 0; padding: 0 0 0 34pt; text-indent: -34pt; line-height: 1.65; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; font-family: Consolas, 'JetBrains Mono', 'Courier New', monospace; font-size: 9.5pt;"
          : "display: flex; align-items: stretch; margin: 0; padding: 0; line-height: 1.65; font-family: Consolas, 'JetBrains Mono', 'Courier New', monospace; font-size: 13px;"
      );

      if (showLn) {
        const lnAttr = lineSpan.getAttribute("data-code-line") || String(idx + 1);
        const lnSpan = root.ownerDocument.createElement("span");
        if (isWordMode) {
          lnSpan.setAttribute(
            "style",
            `display: inline-block; min-width: 24pt; color: ${lnColor}; user-select: none; font-size: 9pt;`
          );
          lnSpan.textContent = `${lnAttr.padStart(2, "\u00A0")}\u00A0│\u00A0`;
        } else {
          lnSpan.setAttribute(
            "style",
            `flex: 0 0 34px; width: 34px; padding-right: 8px; margin-right: 12px; text-align: right; color: ${lnColor}; border-right: 1px solid ${
              options.isDark ? "#30363d" : "#d0d7de"
            }; user-select: none; font-size: 12px; line-height: 1.65; box-sizing: border-box;`
          );
          lnSpan.textContent = lnAttr;
        }
        lineDiv.appendChild(lnSpan);
      }

      const contentSpan = root.ownerDocument.createElement("span");
      if (!isWordMode) {
        contentSpan.setAttribute(
          "style",
          "flex: 1 1 0%; min-width: 0; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; line-height: 1.65;"
        );
      }
      let inner = lineSpan.innerHTML;
      if (isWordMode) {
        inner = inner.replace(/\t/g, "    ");
        inner = inner.replace(/^( +)/, (m) => "&nbsp;".repeat(m.length));
        inner = inner.replace(/ {2}/g, "&nbsp; ");
      }
      contentSpan.innerHTML = inner || "&nbsp;";
      lineDiv.appendChild(contentSpan);
      codeEl.appendChild(lineDiv);
    });
  });
}

/**
 * 将 SVG 元素栅格化为高清 Base64 PNG DataURL，供 Word (.doc) 导出嵌入 Mermaid 图表
 */
async function rasterizeSvgElementToPngDataUrl(
  svgEl: SVGElement
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const viewBox = svgEl.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
    const attrW = parseFloat(svgEl.getAttribute("width") || "0");
    const attrH = parseFloat(svgEl.getAttribute("height") || "0");
    const w = Math.max(240, Math.round(attrW || (viewBox && viewBox[2]) || 560));
    const h = Math.max(120, Math.round(attrH || (viewBox && viewBox[3]) || 280));

    const clonedSvg = svgEl.cloneNode(true) as SVGElement;
    clonedSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clonedSvg.setAttribute("width", String(w));
    clonedSvg.setAttribute("height", String(h));

    const svgXml = new XMLSerializer().serializeToString(clonedSvg);
    const svgDataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgXml);

    return await new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const scale = 2;
          const canvas = document.createElement("canvas");
          canvas.width = w * scale;
          canvas.height = h * scale;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(null);
            return;
          }
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.scale(scale, scale);
          ctx.drawImage(img, 0, 0, w, h);
          resolve({
            dataUrl: canvas.toDataURL("image/png"),
            width: Math.min(580, w),
            height: Math.round((Math.min(580, w) / w) * h),
          });
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = svgDataUrl;
    });
  } catch {
    return null;
  }
}

/**
 * 将已渲染的 HTML 块转换为 100% 内联 CSS 样式树，专为微信公众号后台、知乎专栏、飞书/Notion 粘贴优化
 * (集成 Theme Studio 强调色与水印签名，并彻底修复宽表文字溢出问题 Bug #2)
 */
export function buildWeChatInlineHtml(bodyHtml: string, title: string): string {
  const studio = getActiveThemeStudioPreset();
  const accent = studio.primaryAccentColor || "#0969da";
  const quoteColor = studio.quoteBorderColor || accent;
  const lineHeight = studio.lineHeight || 1.8;
  const paraMargin = `${Math.round((studio.paragraphSpacingEm || 0.45) * 22)}px 0`;

  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<section id="quilla-wechat-root">${bodyHtml}</section>`,
    "text/html"
  );
  const root = doc.getElementById("quilla-wechat-root")!;
  root.setAttribute(
    "style",
    `font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; font-size: ${Math.round(
      15 * (studio.fontSizeScale || 1)
    )}px; line-height: ${lineHeight}; color: #24292f; word-break: break-word; overflow-wrap: anywhere; padding: 4px 2px;`
  );

  root.querySelectorAll(".katex-mathml").forEach((el) => el.remove());

  root.querySelectorAll("del, s, strike").forEach((el) => {
    const sEl = doc.createElement("s");
    sEl.setAttribute("style", "text-decoration: line-through; color: #6e7781;");
    sEl.innerHTML = el.innerHTML;
    el.replaceWith(sEl);
  });

  inlineCodeSyntaxColors(root, false);
  materializeCodeBlockLines(root, { isDark: false, showLineNumbers: true });

  root.querySelectorAll("h1").forEach((el) => {
    el.setAttribute(
      "style",
      `font-size: 22px; font-weight: 700; color: #1f2328; margin: 26px 0 14px; padding-bottom: 8px; border-bottom: 2px solid ${accent}; line-height: 1.35;`
    );
  });

  root.querySelectorAll("h2").forEach((el) => {
    el.setAttribute(
      "style",
      `font-size: 18px; font-weight: 700; color: #1f2328; margin: 22px 0 12px; padding-left: 10px; border-left: 4px solid ${accent}; line-height: 1.4;`
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
      `margin: ${paraMargin}; line-height: ${lineHeight}; color: #24292f; font-size: 15px;`
    );
  });

  root.querySelectorAll("blockquote").forEach((el) => {
    el.setAttribute(
      "style",
      `margin: 14px 0; padding: 10px 16px; border-left: 4px solid ${quoteColor}; background-color: #f6f8fa; color: #57606a; border-radius: 0 6px 6px 0; font-size: 14.5px;`
    );
  });

  root.querySelectorAll(".cm-callout-export").forEach((el) => {
    el.setAttribute(
      "style",
      `margin: 14px 0; padding: 12px 16px; border-left: 4px solid ${accent}; background-color: #f0f7ff; border-radius: 6px; color: #24292f;`
    );
  });

  root.querySelectorAll(".cm-callout-header-widget").forEach((el) => {
    el.setAttribute(
      "style",
      `font-weight: 700; color: ${accent}; margin-bottom: 6px; font-size: 14.5px;`
    );
  });

  root.querySelectorAll(".exported-code-card").forEach((el) => {
    el.setAttribute(
      "style",
      "margin: 14px 0; background-color: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden;"
    );
  });

  root.querySelectorAll(".exported-code-header").forEach((el) => {
    el.setAttribute(
      "style",
      "display: flex; align-items: center; justify-content: space-between; padding: 6px 14px; background-color: #eef1f5; border-bottom: 1px solid #d0d7de; font-family: -apple-system, BlinkMacSystemFont, Consolas, sans-serif; font-size: 11.5px; color: #57606a;"
    );
  });

  root.querySelectorAll(".exported-code-dots").forEach((el) => {
    if (studio.codeCardStyle === "minimal") {
      el.remove();
      return;
    }
    el.setAttribute("style", "display: inline-flex; align-items: center; gap: 5px; margin-right: 8px;");
    const dots = el.querySelectorAll("i");
    const colors = ["#ff5f56", "#ffbd2e", "#27c93f"];
    dots.forEach((d, idx) => {
      d.setAttribute(
        "style",
        `display: inline-block; width: 9px; height: 9px; border-radius: 50%; background-color: ${colors[idx % 3]};`
      );
    });
  });

  root.querySelectorAll(".exported-code-lang").forEach((el) => {
    el.setAttribute(
      "style",
      `font-weight: 700; letter-spacing: 0.05em; color: ${accent}; background-color: rgba(9, 105, 218, 0.1); padding: 1px 7px; border-radius: 999px; font-size: 11px;`
    );
  });

  root.querySelectorAll(".exported-code-meta").forEach((el) => {
    el.setAttribute("style", "margin-left: auto; font-size: 11px; color: #8c959f;");
  });

  root.querySelectorAll("pre").forEach((el) => {
    const inCard = Boolean(el.closest(".exported-code-card"));
    el.setAttribute(
      "style",
      inCard
        ? "margin: 0; padding: 12px 16px; background-color: #f6f8fa; border: none; border-radius: 0; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-family: Consolas, 'JetBrains Mono', Menlo, monospace; font-size: 13px; line-height: 1.6; color: #24292f;"
        : "margin: 14px 0; padding: 14px 16px; background-color: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-family: Consolas, 'JetBrains Mono', Menlo, monospace; font-size: 13px; line-height: 1.6; color: #24292f;"
    );
  });

  root.querySelectorAll("code").forEach((el) => {
    if (el.parentElement?.tagName.toLowerCase() === "pre") {
      el.setAttribute(
        "style",
        "font-family: Consolas, 'JetBrains Mono', Menlo, monospace; font-size: 13px; background: transparent; padding: 0; white-space: pre-wrap; word-break: break-word;"
      );
    } else {
      el.setAttribute(
        "style",
        "font-family: Consolas, Menlo, monospace; font-size: 13px; background-color: #eff1f3; color: #cf222e; padding: 2px 5px; border-radius: 4px; word-break: break-all; overflow-wrap: anywhere;"
      );
    }
  });

  // 修复大表格溢出 Bug #2：固定布局 + 自动断词 + 多列紧凑字号与内边距
  root.querySelectorAll("table").forEach((el) => {
    const colCount = Number(el.getAttribute("data-col-count") || "3");
    const fontSize = colCount >= 8 ? "11.5px" : colCount >= 5 ? "12.5px" : "13.5px";
    el.setAttribute(
      "style",
      `border-collapse: collapse; table-layout: fixed; width: 100%; max-width: 100%; margin: 16px 0; font-size: ${fontSize}; border: 1px solid #d0d7de; word-break: break-word; overflow-wrap: anywhere;`
    );
  });

  root.querySelectorAll("th").forEach((el) => {
    const htmlEl = el as HTMLElement;
    const align = htmlEl.style.textAlign || "left";
    const widthProp = htmlEl.style.width ? ` width: ${htmlEl.style.width};` : "";
    const colCount = Number(el.closest("table")?.getAttribute("data-col-count") || "3");
    const pad = colCount >= 6 ? "5px 6px" : "7px 10px";
    el.setAttribute(
      "style",
      `border: 1px solid #d0d7de; padding: ${pad}; background-color: #f6f8fa; font-weight: 600; text-align: ${align};${widthProp} min-width: 0; word-break: break-word; overflow-wrap: anywhere;`
    );
  });

  root.querySelectorAll("td").forEach((el) => {
    const htmlEl = el as HTMLElement;
    const align = htmlEl.style.textAlign || "left";
    const widthProp = htmlEl.style.width ? ` width: ${htmlEl.style.width};` : "";
    const colCount = Number(el.closest("table")?.getAttribute("data-col-count") || "3");
    const pad = colCount >= 6 ? "5px 6px" : "7px 10px";
    el.setAttribute(
      "style",
      `border: 1px solid #d0d7de; padding: ${pad}; text-align: ${align};${widthProp} min-width: 0; word-break: break-word; overflow-wrap: anywhere;`
    );
  });

  root.querySelectorAll("mark").forEach((el) => {
    el.setAttribute(
      "style",
      "background-color: #fff8c5; color: #24292f; padding: 1px 4px; border-radius: 3px;"
    );
  });

  root.querySelectorAll("a").forEach((el) => {
    el.setAttribute("style", `color: ${accent}; text-decoration: none; border-bottom: 1px solid #80b3ff;`);
  });

  root.querySelectorAll("ul, ol").forEach((el) => {
    el.setAttribute("style", "margin: 8px 0; padding-left: 24px; line-height: 1.75;");
  });

  root.querySelectorAll("li").forEach((el) => {
    el.setAttribute("style", "margin: 4px 0;");
  });

  root.querySelectorAll(".cm-wikilink, .cm-hashtag").forEach((el) => {
    el.setAttribute(
      "style",
      `display: inline-block; padding: 1px 7px; border-radius: 10px; background-color: #eef6ff; color: ${accent}; font-size: 13px; font-weight: 500;`
    );
  });

  if (studio.watermarkSignature) {
    const footer = doc.createElement("p");
    footer.setAttribute(
      "style",
      "margin-top: 24px; padding-top: 10px; border-top: 1px dashed #d0d7de; font-size: 12px; color: #8c959f; text-align: right;"
    );
    footer.textContent = `${studio.watermarkSignature} · ${title}`;
    root.appendChild(footer);
  }

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
 * 专门面向 Microsoft Word / WPS 构建深度兼容的 HTML DOM 树 (修复大表格溢出 Bug #2 & Bug #10)
 */
async function buildWordCompatibleHtml(bodyHtml: string, title: string): Promise<string> {
  const studio = getActiveThemeStudioPreset();
  const accent = studio.primaryAccentColor || "#0969da";

  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<div id="quilla-word-root">${bodyHtml}</div>`,
    "text/html"
  );
  const root = doc.getElementById("quilla-word-root")!;

  root.querySelectorAll("del, s, strike").forEach((el) => {
    const sEl = doc.createElement("s");
    sEl.setAttribute("style", "text-decoration: line-through; color: #6e7781;");
    sEl.innerHTML = el.innerHTML;
    el.replaceWith(sEl);
  });

  root.querySelectorAll("input[type='checkbox']").forEach((inp) => {
    const isChecked = inp.hasAttribute("checked") || (inp as HTMLInputElement).checked;
    const span = doc.createElement("span");
    span.setAttribute(
      "style",
      `font-family: 'Segoe UI Symbol', 'Microsoft YaHei', sans-serif; font-weight: bold; color: ${
        isChecked ? accent : "#57606a"
      }; margin-right: 4pt;`
    );
    span.textContent = isChecked ? "☑ " : "☐ ";
    inp.replaceWith(span);
  });

  root.querySelectorAll(".katex-mathml, annotation").forEach((el) => el.remove());
  root.querySelectorAll(".md-math-block-preview").forEach((el) => {
    el.setAttribute(
      "style",
      "margin: 10pt 0; padding: 8pt 12pt; background-color: #f8fafc; border: 1pt solid #e2e8f0; text-align: center; font-family: 'Cambria Math', 'Times New Roman', serif; font-size: 12pt;"
    );
  });

  const localImgs = Array.from(root.querySelectorAll<HTMLImageElement>("img"));
  for (const img of localImgs) {
    const rawSrc = img.getAttribute("src") || "";
    if (
      rawSrc &&
      !rawSrc.startsWith("http://") &&
      !rawSrc.startsWith("https://") &&
      !rawSrc.startsWith("data:")
    ) {
      try {
        const b64 = await invoke<string>("read_image_base64", {
          docPath: localStorage.getItem("typora_last_file") || null,
          relPath: rawSrc,
        });
        if (b64) img.setAttribute("src", b64);
      } catch {
        // keep original src on fallback
      }
    }
  }

  const mermaidCards = Array.from(root.querySelectorAll<HTMLElement>(".md-mermaid-card"));
  for (const card of mermaidCards) {
    const svgEl = card.querySelector("svg");
    if (svgEl) {
      const pngInfo = await rasterizeSvgElementToPngDataUrl(svgEl);
      if (pngInfo) {
        card.innerHTML = `<p style="text-align:center; margin: 12pt 0;"><img src="${pngInfo.dataUrl}" width="${pngInfo.width}" height="${pngInfo.height}" style="max-width:100%; height:auto;" /></p>`;
      }
    }
  }

  inlineCodeSyntaxColors(root, false);
  materializeCodeBlockLines(root, {
    isDark: false,
    preserveSpacesWithNbsp: true,
    showLineNumbers: true,
  });

  root.querySelectorAll("code").forEach((el) => {
    if (!el.closest("pre") && !el.closest(".exported-code-card")) {
      el.setAttribute(
        "style",
        "font-family: Consolas, 'Courier New', monospace; font-size: 9pt; background-color: #eff1f3; color: #cf222e; padding: 1pt 3pt; border: 1pt solid #d0d7de; word-break: break-all; overflow-wrap: break-word;"
      );
    }
  });

  root.querySelectorAll("pre").forEach((pre) => {
    const cardWrap = pre.closest(".exported-code-card");
    const langText =
      cardWrap?.querySelector(".exported-code-lang")?.textContent?.trim() || "CODE";
    const metaText =
      cardWrap?.querySelector(".exported-code-meta")?.textContent?.trim() || "";

    const codeTable = doc.createElement("table");
    codeTable.setAttribute("width", "100%");
    codeTable.setAttribute("cellspacing", "0");
    codeTable.setAttribute("cellpadding", "0");
    codeTable.setAttribute(
      "style",
      "width: 100%; table-layout: fixed; border-collapse: collapse; margin: 10pt 0; background-color: #f6f8fa; border: 1pt solid #d0d7de;"
    );

    const headerTr = doc.createElement("tr");
    const headerTd = doc.createElement("td");
    headerTd.setAttribute(
      "style",
      "padding: 4pt 10pt; background-color: #eef1f5; border-bottom: 1pt solid #d0d7de; font-family: Consolas, Arial, sans-serif; font-size: 8.5pt; color: #57606a;"
    );
    headerTd.innerHTML = `<span style="color:#ff5f56;">●</span> <span style="color:#ffbd2e;">●</span> <span style="color:#27c93f;">●</span>&nbsp;&nbsp;<strong style="color:${accent};">${langText}</strong>${
      metaText ? `&nbsp;·&nbsp;<span>${metaText}</span>` : ""
    }`;
    headerTr.appendChild(headerTd);
    codeTable.appendChild(headerTr);

    const tr = doc.createElement("tr");
    const td = doc.createElement("td");
    td.setAttribute(
      "style",
      "padding: 9pt 12pt; background-color: #f6f8fa; border: 1pt solid #d0d7de; font-family: Consolas, 'Courier New', monospace; font-size: 9.5pt; line-height: 1.55; color: #24292f; word-break: break-word; overflow-wrap: break-word;"
    );
    const innerCode = pre.querySelector("code");
    td.innerHTML = innerCode ? innerCode.innerHTML : pre.innerHTML;
    tr.appendChild(td);
    codeTable.appendChild(tr);

    if (cardWrap) {
      cardWrap.replaceWith(codeTable);
    } else {
      pre.replaceWith(codeTable);
    }
  });

  root.querySelectorAll("h1").forEach((el) => {
    el.setAttribute(
      "style",
      `font-size: 18pt; font-weight: bold; color: #1f2328; margin: 18pt 0 10pt; padding-bottom: 4pt; border-bottom: 1.5pt solid ${accent};`
    );
  });

  root.querySelectorAll("h2").forEach((el) => {
    el.setAttribute(
      "style",
      `font-size: 14.5pt; font-weight: bold; color: #1f2328; margin: 15pt 0 8pt; padding-left: 6pt; border-left: 3pt solid ${accent};`
    );
  });

  root.querySelectorAll("h3, h4, h5, h6").forEach((el) => {
    el.setAttribute(
      "style",
      "font-size: 12pt; font-weight: bold; color: #1f2328; margin: 12pt 0 6pt;"
    );
  });

  root.querySelectorAll("p").forEach((el) => {
    if (!el.getAttribute("style")) {
      el.setAttribute(
        "style",
        "margin: 6pt 0; line-height: 1.75; color: #24292f; font-size: 11pt;"
      );
    }
  });

  root.querySelectorAll("blockquote, .cm-callout-export").forEach((el) => {
    const isCallout = el.classList.contains("cm-callout-export");
    const borderColor = el.classList.contains("cm-callout-tip")
      ? "#1a7f37"
      : el.classList.contains("cm-callout-important")
      ? "#8250df"
      : el.classList.contains("cm-callout-warning")
      ? "#9a6700"
      : el.classList.contains("cm-callout-caution")
      ? "#cf222e"
      : accent;
    const bgColor = isCallout ? "#f0f7ff" : "#f6f8fa";

    const quoteTable = doc.createElement("table");
    quoteTable.setAttribute("width", "100%");
    quoteTable.setAttribute("cellspacing", "0");
    quoteTable.setAttribute("cellpadding", "0");
    quoteTable.setAttribute(
      "style",
      `width: 100%; table-layout: fixed; border-collapse: collapse; margin: 9pt 0; background-color: ${bgColor}; border: 1pt solid #e1e4e8; border-left: 3.5pt solid ${borderColor};`
    );
    const tr = doc.createElement("tr");
    const td = doc.createElement("td");
    td.setAttribute(
      "style",
      `padding: 7pt 11pt; background-color: ${bgColor}; color: #24292f; font-size: 10.5pt; line-height: 1.65; word-break: break-word;`
    );
    td.innerHTML = el.innerHTML;
    tr.appendChild(td);
    quoteTable.appendChild(tr);
    el.replaceWith(quoteTable);
  });

  root.querySelectorAll(".cm-callout-header-widget").forEach((el) => {
    el.setAttribute(
      "style",
      `font-weight: bold; color: ${accent}; margin-bottom: 4pt; font-size: 10.5pt;`
    );
  });

  // 修复 Word 大表格文字溢出 Bug #2：固定布局 + 自动断词 + 列数自适应字号
  root.querySelectorAll("table.md-table").forEach((el) => {
    const colCount = Number(el.getAttribute("data-col-count") || "3");
    const fontSize = colCount >= 8 ? "8pt" : colCount >= 5 ? "9pt" : "10pt";
    el.setAttribute("width", "100%");
    el.setAttribute("cellspacing", "0");
    el.setAttribute("cellpadding", colCount >= 6 ? "4" : "6");
    el.setAttribute(
      "style",
      `border-collapse: collapse; table-layout: fixed; width: 100%; max-width: 100%; margin: 10pt 0; font-size: ${fontSize}; border: 1pt solid #d0d7de; word-wrap: break-word; word-break: break-word;`
    );
  });

  root.querySelectorAll("table.md-table th").forEach((el) => {
    const htmlEl = el as HTMLElement;
    const align = htmlEl.style.textAlign || "left";
    const widthStyle = htmlEl.style.width ? ` width: ${htmlEl.style.width};` : "";
    const colCount = Number(el.closest("table")?.getAttribute("data-col-count") || "3");
    const pad = colCount >= 6 ? "4pt 5pt" : "6pt 8pt";
    el.setAttribute(
      "style",
      `border: 1pt solid #d0d7de; padding: ${pad}; background-color: #f6f8fa; font-weight: bold; text-align: ${align};${widthStyle} word-break: break-word; overflow-wrap: break-word;`
    );
  });

  root.querySelectorAll("table.md-table td").forEach((el) => {
    const htmlEl = el as HTMLElement;
    const align = htmlEl.style.textAlign || "left";
    const widthStyle = htmlEl.style.width ? ` width: ${htmlEl.style.width};` : "";
    const colCount = Number(el.closest("table")?.getAttribute("data-col-count") || "3");
    const pad = colCount >= 6 ? "4pt 5pt" : "6pt 8pt";
    el.setAttribute(
      "style",
      `border: 1pt solid #d0d7de; padding: ${pad}; text-align: ${align};${widthStyle} word-break: break-word; overflow-wrap: break-word;`
    );
  });

  root.querySelectorAll("mark").forEach((el) => {
    el.setAttribute("style", "background-color: #fff8c5; color: #24292f; padding: 0 2pt;");
  });

  root.querySelectorAll(".cm-wikilink, .cm-hashtag").forEach((el) => {
    el.setAttribute(
      "style",
      `background-color: #eef6ff; color: ${accent}; padding: 1pt 5pt; font-weight: bold; font-size: 10pt;`
    );
  });

  if (studio.watermarkSignature) {
    const footer = doc.createElement("p");
    footer.setAttribute(
      "style",
      "margin-top: 18pt; padding-top: 8pt; border-top: 1pt dashed #d0d7de; font-size: 9pt; color: #8c959f; text-align: right;"
    );
    footer.textContent = `${studio.watermarkSignature} · ${title}`;
    root.appendChild(footer);
  }

  return root.innerHTML;
}

/**
 * 导出为兼容 Microsoft Word / WPS 的标准 .doc 文档
 */
export async function exportWordDocument(bodyHtml: string, title: string) {
  const wordBodyHtml = await buildWordCompatibleHtml(bodyHtml, title);
  const wordDocContent = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:w="urn:schemas-microsoft-com:office:word"
xmlns:m="http://schemas.microsoft.com/office/2004/12/omml"
xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<title>${escapeHtml(title)}</title>
<!--[if gte mso 9]>
<xml>
  <w:WordDocument>
    <w:View>Print</w:View>
    <w:Zoom>100</w:Zoom>
    <w:TrackMoves>false</w:TrackMoves>
    <w:TrackFormatting/>
    <w:DoNotOptimizeForBrowser/>
  </w:WordDocument>
</xml>
<![endif]-->
<style>
  @page { size: 21cm 29.7cm; margin: 2.54cm 2.54cm 2.54cm 2.54cm; }
  body { font-family: "PingFang SC", "Microsoft YaHei", SimSun, sans-serif; font-size: 11pt; line-height: 1.75; color: #24292f; }
  s, strike { text-decoration: line-through; color: #6e7781; }
  table { border-collapse: collapse; table-layout: fixed; width: 100%; word-wrap: break-word; }
  img { max-width: 100%; height: auto; }
</style>
</head>
<body>
${wordBodyHtml}
</body>
</html>`;

  try {
    let selectedPath: string | null = null;
    try {
      selectedPath = await invoke<string | null>("select_export_word_path", {
        defaultName: `${title}.doc`,
      });
    } catch {
      selectedPath = await invoke<string | null>("select_save_file_path", {
        defaultName: `${title}.doc`,
      });
    }
    if (!selectedPath || !selectedPath.trim()) {
      return;
    }
    const target = selectedPath.trim().replace(/\.(md|markdown)$/i, ".doc");
    await invoke("save_file_content", {
      path: target,
      content: "\ufeff" + wordDocContent,
    });
    showToast(`已成功导出 Word 文档：${target.split(/[\\/]/).pop()}`, "success");
    return;
  } catch {
    // 浏览器环境兜底
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

/**
 * 移动端长图多卡片自动切片算法 (Carousel Card Slicer — Phase 2.2)
 * 按小红书 (3:4) 或朋友圈竖屏 (9:16) 黄金比例，沿着标题 (H1/H2/H3) 与段落边界智能将长文切分为多张精美卡片 HTML
 */
export function sliceHtmlIntoCarouselCards(
  preparedBodyHtml: string,
  options: {
    aspectRatio: "3:4" | "9:16";
    widthPx: number;
  }
): string[] {
  const targetCardHeight =
    options.aspectRatio === "3:4"
      ? Math.round((options.widthPx * 4) / 3)
      : Math.round((options.widthPx * 16) / 9);
  const maxBodyBudgetPx = Math.max(240, targetCardHeight - 170);
  const charsPerLine = Math.max(16, Math.floor((options.widthPx - 48) / 15.5));

  if (typeof DOMParser === "undefined") {
    return [preparedBodyHtml];
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="slicer-root">${preparedBodyHtml}</div>`, "text/html");
  const root = doc.getElementById("slicer-root");
  if (!root || root.children.length === 0) {
    return [preparedBodyHtml];
  }

  const estimateNodeHeight = (el: Element): number => {
    const tag = el.tagName.toLowerCase();
    const textLen = (el.textContent || "").trim().length;
    const estLines = Math.max(1, Math.ceil(textLen / charsPerLine));
    if (tag === "h1") return 56 + estLines * 28;
    if (tag === "h2") return 46 + estLines * 24;
    if (tag === "h3" || tag === "h4") return 36 + estLines * 22;
    if (tag === "pre" || el.classList.contains("exported-code-card")) {
      const codeLines = el.querySelectorAll(".exported-code-line").length || Math.max(2, estLines);
      return 48 + codeLines * 22;
    }
    if (tag === "table") {
      const rows = el.querySelectorAll("tr").length || 2;
      return 32 + rows * 34;
    }
    if (tag === "figure" || tag === "img" || el.querySelector("img, svg")) {
      return 210;
    }
    if (tag === "blockquote" || el.classList.contains("cm-callout-export")) {
      return 36 + estLines * 25;
    }
    if (tag === "ul" || tag === "ol") {
      const items = el.querySelectorAll("li").length || 1;
      return 20 + items * 16 + estLines * 24;
    }
    return 18 + estLines * 25;
  };

  const cards: string[] = [];
  let currentGroup: string[] = [];
  let currentHeight = 0;

  const flushCard = () => {
    if (currentGroup.length > 0) {
      cards.push(currentGroup.join("\n"));
      currentGroup = [];
      currentHeight = 0;
    }
  };

  const children = Array.from(root.children);
  for (const child of children) {
    const tag = child.tagName.toLowerCase();
    const h = estimateNodeHeight(child);
    const isMajorHeading = tag === "h1" || tag === "h2";

    // 遇到一级/二级大标题且当前卡片已使用超过 38% 容量时，自动开启新卡片保持章节完整
    if (
      currentGroup.length > 0 &&
      ((isMajorHeading && currentHeight > maxBodyBudgetPx * 0.38) ||
        currentHeight + h > maxBodyBudgetPx)
    ) {
      flushCard();
    }

    currentGroup.push(child.outerHTML);
    currentHeight += h;
  }

  flushCard();
  return cards.length > 0 ? cards : [preparedBodyHtml];
}

let posterModalEl: HTMLElement | null = null;

export type PosterWidthPreset = 375 | 430 | 640 | 820;
export type PosterSliceMode = "single" | "xhs-3-4" | "story-9-16";

/**
 * 打开社交长图分享卡片工作台
 * - 新增手机端专属窄宽预设：375px (手机紧凑) 与 430px (手机舒适阅读)，搭配响应式窄内边距与 3x Retina 超采样 (Bug #4)
 * - 新增小红书 (3:4) 与朋友圈 (9:16) 多图自动分页切片模式 (Phase 2.2)
 * - 重构为优雅的双层分段式头部工具栏 (Phase 1.10)
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

  const studio = getActiveThemeStudioPreset();
  let currentSkin: "ivory" | "dark" | "mint" = "ivory";
  let posterWidth: PosterWidthPreset = studio.posterDefaultWidth || 430;
  let sliceMode: PosterSliceMode = "single";
  const dateStr = new Date().toISOString().slice(0, 10);

  const preparePosterHtml = (rawHtml: string, skin: "ivory" | "dark" | "mint"): string => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="poster-prep">${rawHtml}</div>`, "text/html");
    const root = doc.getElementById("poster-prep")!;
    root.querySelectorAll(".katex-mathml").forEach((el) => el.remove());

    const firstChild = root.firstElementChild;
    if (
      firstChild &&
      firstChild.tagName.toLowerCase() === "h1" &&
      (firstChild.textContent || "").trim() === options.title.trim()
    ) {
      firstChild.remove();
    }

    inlineCodeSyntaxColors(root, skin === "dark");
    materializeCodeBlockLines(root, {
      isDark: skin === "dark",
      showLineNumbers: true,
    });
    return root.innerHTML;
  };

  posterModalEl.classList.remove("hidden");

  const renderPosterView = () => {
    if (!posterModalEl) return;
    const preparedBody = preparePosterHtml(options.bodyHtml, currentSkin);
    const isMobileNarrow = posterWidth <= 430;
    const stagePadding =
      posterWidth <= 375 ? "22px 18px" : posterWidth <= 430 ? "26px 22px" : "36px 40px";
    const watermark = studio.watermarkSignature || "Written with Quilla (羽墨) v0.10.0";

    const cardBodies =
      sliceMode === "single"
        ? [preparedBody]
        : sliceHtmlIntoCarouselCards(preparedBody, {
            aspectRatio: sliceMode === "xhs-3-4" ? "3:4" : "9:16",
            widthPx: posterWidth,
          });

    const totalCards = cardBodies.length;
    const minCardHeightStyle =
      sliceMode === "xhs-3-4"
        ? `min-height: ${Math.round((posterWidth * 4) / 3)}px;`
        : sliceMode === "story-9-16"
        ? `min-height: ${Math.round((posterWidth * 16) / 9)}px;`
        : "";

    const cardsHtml = cardBodies
      .map(
        (cardHtml, idx) => `
          <div class="poster-card-stage skin-${currentSkin} ${
            isMobileNarrow ? "poster-stage-mobile" : ""
          } ${sliceMode !== "single" ? "poster-stage-sliced" : ""}"
               id="${idx === 0 ? "quilla-poster-stage" : `quilla-poster-stage-${idx + 1}`}"
               data-card-index="${idx + 1}"
               style="width: ${posterWidth}px; padding: ${stagePadding}; ${minCardHeightStyle}">
            <div class="poster-card-header">
              <div class="poster-header-top">
                <div class="poster-brand-pill">QUILLA · 羽墨笔记</div>
                <div class="poster-meta-line">${
                  totalCards > 1
                    ? `<span class="poster-slice-page-pill">${String(idx + 1).padStart(2, "0")} / ${String(
                        totalCards
                      ).padStart(2, "0")}</span>`
                    : `${dateStr} · ${options.wordCount} 词`
                }</div>
              </div>
              ${
                idx === 0
                  ? `<h1 class="poster-doc-main-title">${escapeHtml(options.title)}</h1>`
                  : `<div class="poster-doc-sub-header">${escapeHtml(options.title)} · 续页 ${
                      idx + 1
                    }</div>`
              }
            </div>
            <div class="poster-card-body">
              ${cardHtml}
            </div>
            <div class="poster-card-footer">
              <span>${escapeHtml(watermark)}</span>
              <span>${totalCards > 1 ? `Card ${idx + 1} of ${totalCards}` : "Markdown Knowledge Studio"}</span>
            </div>
          </div>
        `
      )
      .join("");

    posterModalEl.innerHTML = `
      <div class="ty-modal-card poster-modal-card" role="dialog" aria-modal="true">
        <div class="ty-modal-header">
          <div class="modal-title">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            <span>导出社交长图与多卡片工作台</span>
            <span class="modal-badge">${isMobileNarrow ? "3x Retina 高清手机适配" : "2x 矢量超采样"}</span>
          </div>
          <button type="button" class="modal-close-btn" id="poster-close-btn" title="关闭 (Esc)">✕</button>
        </div>

        <div class="export-toolbar-ribbon">
          <div class="graph-toolbar-controls">
            <div class="graph-scope-Segment" title="切换海报主题配色">
              <button type="button" class="graph-scope-btn ${currentSkin === "ivory" ? "active" : ""}" data-skin="ivory">羊皮书卷</button>
              <button type="button" class="graph-scope-btn ${currentSkin === "mint" ? "active" : ""}" data-skin="mint">清晨薄荷</button>
              <button type="button" class="graph-scope-btn ${currentSkin === "dark" ? "active" : ""}" data-skin="dark">极客暗夜</button>
            </div>
            <div class="graph-scope-Segment" title="选择长图宽度（375px/430px 专为手机竖屏免缩放阅读优化）">
              <button type="button" class="graph-scope-btn ${posterWidth === 375 ? "active" : ""}" data-width="375">手机紧凑 375px</button>
              <button type="button" class="graph-scope-btn ${posterWidth === 430 ? "active" : ""}" data-width="430">手机舒适 430px</button>
              <button type="button" class="graph-scope-btn ${posterWidth === 640 ? "active" : ""}" data-width="640">标准 640px</button>
              <button type="button" class="graph-scope-btn ${posterWidth === 820 ? "active" : ""}" data-width="820">宽屏 820px</button>
            </div>
            <div class="graph-scope-Segment" title="一镜到底长图 或 小红书/朋友圈多图自动分页卡片切片">
              <button type="button" class="graph-scope-btn ${sliceMode === "single" ? "active" : ""}" data-slice="single">单张长图</button>
              <button type="button" class="graph-scope-btn ${sliceMode === "xhs-3-4" ? "active" : ""}" data-slice="xhs-3-4">小红书 3:4 (${
                sliceMode === "xhs-3-4" ? `${totalCards}张` : "切片"
              })</button>
              <button type="button" class="graph-scope-btn ${sliceMode === "story-9-16" ? "active" : ""}" data-slice="story-9-16">朋友圈 9:16 (${
                sliceMode === "story-9-16" ? `${totalCards}张` : "切片"
              })</button>
            </div>
          </div>
        </div>

        <div class="poster-preview-scroller ${totalCards > 1 ? "poster-carousel-grid" : ""}">
          ${cardsHtml}
        </div>

        <div class="ty-modal-footer">
          <span class="footer-tip">${
            totalCards > 1
              ? `已按章节与段落边界智能切分为 ${totalCards} 张卡片，点击导出将自动按序号批量保存`
              : "手机端分享推荐使用 375px 或 430px 预设，文字清晰免双指缩放"
          }</span>
          <div class="tm-footer-btns">
            <button type="button" class="save-dialog-btn btn-discard" id="poster-cancel-btn">关闭</button>
            <button type="button" class="modal-confirm-btn" id="poster-download-btn">${
              totalCards > 1
                ? `批量导出全部 ${totalCards} 张卡片 (.png)...`
                : "选择位置并导出长图 (.png)..."
            }</button>
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

    posterModalEl.querySelectorAll<HTMLElement>("[data-width]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const w = Number(btn.dataset.width);
        posterWidth = (w === 375 || w === 430 || w === 640 || w === 820 ? w : 430) as PosterWidthPreset;
        renderPosterView();
      });
    });

    posterModalEl.querySelectorAll<HTMLElement>("[data-slice]").forEach((btn) => {
      btn.addEventListener("click", () => {
        sliceMode = (btn.dataset.slice as PosterSliceMode) || "single";
        renderPosterView();
      });
    });

    posterModalEl.querySelector("#poster-download-btn")?.addEventListener("click", async () => {
      const stages = Array.from(
        posterModalEl!.querySelectorAll<HTMLElement>(".poster-card-stage")
      );
      if (stages.length === 0) return;
      if (stages.length === 1) {
        await exportDomStageToPng(stages[0], options.title, currentSkin);
      } else {
        await exportMultipleDomStagesToPng(stages, options.title, currentSkin);
      }
    });
  };

  posterModalEl.onclick = (e) => {
    if (e.target === posterModalEl) posterModalEl?.classList.add("hidden");
  };

  renderPosterView();
}

/**
 * 构建自包含的海报 SVG 字符串（消除数千次 getComputedStyle 同步重排卡顿 Bottleneck #3，
 * 并强化宽表与窄屏手机阅读自适应样式 Bug #2 & Bug #4）
 */
function buildPosterStageSvgString(
  stage: HTMLElement,
  skin: "ivory" | "dark" | "mint"
): { svgStr: string; width: number; height: number; bgColor: string } {
  const studio = getActiveThemeStudioPreset();
  const accent = studio.primaryAccentColor || "#0969da";
  const width = stage.offsetWidth || 430;
  const isNarrowMobile = width <= 430;

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
  const codeBgColors = {
    ivory: "#f2ede2",
    mint: "#e6f4ee",
    dark: "#21262d",
  };
  const borderColors = {
    ivory: "#e4dccf",
    mint: "#cde5dc",
    dark: "#30363d",
  };

  const cloned = stage.cloneNode(true) as HTMLElement;
  cloned.querySelectorAll(".katex-mathml").forEach((el) => el.remove());

  const height = Math.max(stage.scrollHeight, stage.offsetHeight, 360);
  const pad = width <= 375 ? "22px 18px" : width <= 430 ? "26px 22px" : "38px 44px";

  cloned.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  cloned.style.width = `${width}px`;
  cloned.style.minHeight = `${height}px`;
  cloned.style.margin = "0";
  cloned.style.boxSizing = "border-box";
  cloned.style.background = bgColors[skin];
  cloned.style.color = textColors[skin];
  cloned.style.padding = pad;
  cloned.style.fontFamily =
    "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  cloned.style.lineHeight = String(studio.lineHeight || 1.75);

  const embeddedCss = `
    * { box-sizing: border-box; }
    .poster-card-header { margin-bottom: ${isNarrowMobile ? "16px" : "22px"}; padding-bottom: 14px; border-bottom: 1px solid ${borderColors[skin]}; }
    .poster-header-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .poster-brand-pill { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: ${accent}; background: rgba(9, 105, 218, 0.1); padding: 3px 10px; border-radius: 999px; }
    .poster-meta-line { font-size: 11.5px; opacity: 0.75; }
    .poster-slice-page-pill { font-family: Consolas, monospace; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: rgba(127, 127, 127, 0.14); }
    .poster-doc-main-title { font-size: ${isNarrowMobile ? "21px" : "26px"}; font-weight: 800; line-height: 1.35; margin: 4px 0 0; color: ${textColors[skin]}; word-break: break-word; }
    .poster-doc-sub-header { font-size: 14px; font-weight: 700; opacity: 0.8; margin-top: 2px; }
    .poster-card-body h1 { font-size: ${isNarrowMobile ? "19px" : "22px"}; font-weight: 700; margin: 18px 0 10px; padding-bottom: 6px; border-bottom: 2px solid ${accent}; color: ${textColors[skin]}; }
    .poster-card-body h2 { font-size: ${isNarrowMobile ? "17px" : "18px"}; font-weight: 700; margin: 16px 0 9px; padding-left: 10px; border-left: 4px solid ${accent}; color: ${textColors[skin]}; }
    .poster-card-body h3, .poster-card-body h4 { font-size: 15.5px; font-weight: 700; margin: 12px 0 6px; color: ${textColors[skin]}; }
    .poster-card-body p { margin: 10px 0; line-height: ${studio.lineHeight || 1.78}; font-size: 15px; word-break: break-word; overflow-wrap: anywhere; }
    .poster-card-body ul, .poster-card-body ol { margin: 8px 0; padding-left: 22px; }
    .poster-card-body li { margin: 4px 0; line-height: 1.72; font-size: 14.5px; }
    .poster-card-body .exported-code-card { margin: 12px 0; border-radius: 8px; background: ${codeBgColors[skin]}; border: 1px solid ${borderColors[skin]}; overflow: hidden; }
    .poster-card-body .exported-code-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; border-bottom: 1px solid ${borderColors[skin]}; font-size: 11px; opacity: 0.85; }
    .poster-card-body .exported-code-dots { display: inline-flex; gap: 5px; margin-right: 8px; }
    .poster-card-body .exported-code-dots i { display: inline-block; width: 8.5px; height: 8.5px; border-radius: 50%; }
    .poster-card-body .exported-code-dots i.dot-red { background: #ff5f56; }
    .poster-card-body .exported-code-dots i.dot-amber { background: #ffbd2e; }
    .poster-card-body .exported-code-dots i.dot-green { background: #27c93f; }
    .poster-card-body .exported-code-lang { font-weight: 700; color: ${accent}; font-size: 11px; }
    .poster-card-body .exported-code-meta { margin-left: auto; font-size: 10.5px; opacity: 0.7; }
    .poster-card-body pre { margin: 0; padding: 10px 12px; background: ${codeBgColors[skin]}; border: none; white-space: pre-wrap !important; word-break: break-word !important; overflow-wrap: anywhere !important; font-family: Consolas, 'JetBrains Mono', monospace; font-size: ${isNarrowMobile ? "12px" : "13px"}; line-height: 1.62; }
    .poster-card-body :not(pre) > code { font-family: Consolas, 'JetBrains Mono', monospace; font-size: 12.5px; background: rgba(127, 127, 127, 0.12); padding: 1px 4px; border-radius: 4px; border: 1px solid ${borderColors[skin]}; word-break: break-all; overflow-wrap: anywhere; }
    .poster-card-body pre > code { font-family: Consolas, 'JetBrains Mono', monospace; font-size: inherit; background: transparent !important; border: none !important; padding: 0 !important; }
    .poster-card-body blockquote, .poster-card-body .cm-callout-export { margin: 12px 0; padding: 10px 14px; border-left: 4px solid ${accent}; background: ${codeBgColors[skin]}; border-radius: 6px; }
    .poster-card-body table { width: 100% !important; max-width: 100% !important; table-layout: fixed !important; border-collapse: collapse; margin: 12px 0; font-size: ${isNarrowMobile ? "12px" : "13px"}; word-break: break-word !important; overflow-wrap: anywhere !important; }
    .poster-card-body table.md-table-dense { font-size: 11.5px; }
    .poster-card-body table.md-table-ultra-dense { font-size: 10.5px; }
    .poster-card-body th, .poster-card-body td { min-width: 0 !important; border: 1px solid ${borderColors[skin]}; padding: ${isNarrowMobile ? "5px 6px" : "6px 8px"}; word-break: break-word !important; overflow-wrap: anywhere !important; vertical-align: top; }
    .poster-card-body th { background: ${codeBgColors[skin]}; font-weight: 600; }
    .poster-card-body s, .poster-card-body del { text-decoration: line-through; opacity: 0.68; }
    .poster-card-body mark { background: #fff8c5; color: #24292f; padding: 1px 4px; border-radius: 3px; }
    .poster-card-body img { max-width: 100%; height: auto; border-radius: 6px; }
    .poster-card-footer { margin-top: 22px; padding-top: 12px; border-top: 1px dashed ${borderColors[skin]}; display: flex; justify-content: space-between; font-size: 11px; opacity: 0.65; }
  `;

  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <style>${embeddedCss}</style>
    <foreignObject width="100%" height="100%">
      ${new XMLSerializer().serializeToString(cloned)}
    </foreignObject>
  </svg>`;

  return { svgStr, width, height, bgColor: bgColors[skin] };
}

function renderSvgToPngDataUrl(
  svgStr: string,
  width: number,
  height: number,
  bgColor: string,
  scale: number
): Promise<string | null> {
  const svgDataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = svgDataUrl;
  });
}

async function exportDomStageToPng(
  stage: HTMLElement,
  title: string,
  skin: "ivory" | "dark" | "mint"
) {
  let targetSavePath: string | null = null;
  try {
    targetSavePath = await invoke<string | null>("select_save_image_path", {
      defaultName: `${title}-长图卡片.png`,
    });
    if (!targetSavePath || !targetSavePath.trim()) {
      return;
    }
    targetSavePath = targetSavePath.trim();
  } catch {
    targetSavePath = null;
  }

  const { svgStr, width, height, bgColor } = buildPosterStageSvgString(stage, skin);
  // 窄宽手机模式 (375px / 430px) 自动启用 3x Retina 超采样，保证手机放大阅读依然锐利清晰
  const scale = width <= 430 ? 3 : 2;
  const pngDataUrl = await renderSvgToPngDataUrl(svgStr, width, height, bgColor, scale);

  if (pngDataUrl) {
    try {
      if (targetSavePath) {
        if (targetSavePath.toLowerCase().endsWith(".svg")) {
          await invoke("save_file_content", {
            path: targetSavePath,
            content: svgStr,
          });
        } else {
          const finalPngPath = targetSavePath.toLowerCase().endsWith(".png")
            ? targetSavePath
            : `${targetSavePath}.png`;
          await invoke("save_base64_file", {
            path: finalPngPath,
            base64Data: pngDataUrl,
          });
        }
        showToast(`已导出高清长图：${targetSavePath.split(/[\\/]/).pop()}`, "success");
        posterModalEl?.classList.add("hidden");
        return;
      }

      const a = document.createElement("a");
      a.href = pngDataUrl;
      a.download = `${title}-card.png`;
      a.click();
      showToast("已导出高清分享长图 (.png)", "success");
      posterModalEl?.classList.add("hidden");
      return;
    } catch {
      // fallback to SVG below
    }
  }

  if (targetSavePath) {
    const svgPath = targetSavePath.replace(/\.png$/i, ".svg");
    await invoke("save_file_content", {
      path: svgPath,
      content: svgStr,
    });
    showToast(`已保存矢量长图卡片：${svgPath.split(/[\\/]/).pop()}`, "success");
    posterModalEl?.classList.add("hidden");
    return;
  }
  const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title}-card.svg`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("已导出高清矢量分享卡片 (.svg)", "success");
}

/**
 * 批量导出小红书 (3:4) / 朋友圈 (9:16) 多图切片卡片序列 (Phase 2.2)
 */
async function exportMultipleDomStagesToPng(
  stages: HTMLElement[],
  title: string,
  skin: "ivory" | "dark" | "mint"
) {
  let baseSavePath: string | null = null;
  try {
    baseSavePath = await invoke<string | null>("select_save_image_path", {
      defaultName: `${title}-卡片01.png`,
    });
    if (!baseSavePath || !baseSavePath.trim()) return;
    baseSavePath = baseSavePath.trim();
  } catch {
    baseSavePath = null;
  }

  const stemPath = baseSavePath
    ? baseSavePath.replace(/(-卡片\d+|\d+)?\.(png|svg)$/i, "")
    : title;

  let exportedCount = 0;
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const pageNum = String(i + 1).padStart(2, "0");
    const { svgStr, width, height, bgColor } = buildPosterStageSvgString(stage, skin);
    const scale = width <= 430 ? 3 : 2;
    const pngDataUrl = await renderSvgToPngDataUrl(svgStr, width, height, bgColor, scale);

    if (baseSavePath && pngDataUrl) {
      const cardPath = `${stemPath}-${pageNum}.png`;
      await invoke("save_base64_file", {
        path: cardPath,
        base64Data: pngDataUrl,
      });
      exportedCount++;
    } else if (pngDataUrl) {
      const a = document.createElement("a");
      a.href = pngDataUrl;
      a.download = `${title}-${pageNum}.png`;
      a.click();
      exportedCount++;
    }
  }

  posterModalEl?.classList.add("hidden");
  showToast(`已成功批量导出 ${exportedCount} 张高清社交卡片！`, "success");
}

export interface PdfBookmarkNode {
  level: number;
  title: string;
  id: string;
}

/**
 * 从已渲染的 HTML 根节点提取 H1 ~ H6 标题大纲结构，供原生 PDF 矢量书签树 (/Outlines) 注入使用 (Phase 2.3)
 */
export function extractPdfBookmarkOutline(root: HTMLElement): PdfBookmarkNode[] {
  const headings = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
  return headings
    .map((h, idx) => {
      const level = Number(h.tagName.slice(1)) || 1;
      const title = (h.textContent || "").trim();
      if (!h.id) {
        h.id = `quilla-pdf-heading-${idx + 1}`;
      }
      return {
        level,
        title,
        id: h.id,
      };
    })
    .filter((item) => item.title.length > 0);
}

export interface PdfExportOptions {
  title: string;
  bodyHtml: string;
  wordCount: number;
  themeCss: string;
  isDark: boolean;
  onSystemPrintFallback?: (compiledBodyHtml: string, pageCss: string) => void;
}

let pdfModalEl: HTMLElement | null = null;

/**
 * 构建出版级独立矢量 PDF 完整 HTML 文档
 * - 修复大表格跨页截断与水平文字溢出 Bug #2（table 级允许跨页 + tr 级防截断 + thead 跨页重复表头 + 固定布局断词）
 * - 集成 Theme Studio 自定义排版变量与页脚签名 (Phase 3.2)
 */
export function buildStandalonePdfDocumentHtml(
  title: string,
  bodyHtml: string,
  themeCss: string,
  config: {
    pageSize: "A4" | "Letter" | "A5";
    marginPreset: "standard" | "compact" | "academic";
    includeHeaderFooter: boolean;
    wordCount: number;
  }
): string {
  const studio = getActiveThemeStudioPreset();
  const accent = studio.primaryAccentColor || "#0969da";
  const watermark = studio.watermarkSignature || "由 Quilla (羽墨) v0.10.0 矢量排版引擎生成";

  const marginMap = {
    standard: "16mm 18mm",
    compact: "10mm 12mm",
    academic: "24mm 26mm",
  };
  const dateStr = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const headerHtml = config.includeHeaderFooter
    ? `<header class="pdf-doc-banner">
        <div class="pdf-banner-meta">
          <span class="pdf-brand">QUILLA · 羽墨出版级文档</span>
          <span>${dateStr} · ${config.wordCount} 词</span>
        </div>
        <h1 class="pdf-banner-title">${escapeHtml(title)}</h1>
      </header>`
    : "";

  const footerHtml = config.includeHeaderFooter
    ? `<footer class="pdf-doc-footer">
        <span>${escapeHtml(watermark)}</span>
        <span>${escapeHtml(title)}</span>
      </footer>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    ${themeCss}
    ${buildThemeStudioExportVariablesCss(studio)}
    @page {
      size: ${config.pageSize} portrait;
      margin: ${marginMap[config.marginPreset]};
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff !important;
      color: #1f2328 !important;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", serif;
      font-size: ${Math.round(10.5 * (studio.fontSizeScale || 1) * 10) / 10}pt;
      line-height: ${studio.lineHeight || 1.75};
    }
    .pdf-container {
      max-width: 100%;
      margin: 0 auto;
    }
    .pdf-doc-banner {
      margin-bottom: 18pt;
      padding-bottom: 10pt;
      border-bottom: 1.5pt solid ${accent};
    }
    .pdf-banner-meta {
      display: flex;
      justify-content: space-between;
      font-size: 8.5pt;
      color: #57606a;
      margin-bottom: 6pt;
    }
    .pdf-brand {
      font-weight: 700;
      color: ${accent};
      letter-spacing: 0.05em;
    }
    .pdf-banner-title {
      font-size: 20pt;
      font-weight: 800;
      margin: 0;
      color: #1f2328;
      border: none;
      padding: 0;
    }
    h1, h2, h3, h4, h5, h6 {
      page-break-after: avoid !important;
      break-after: avoid !important;
      color: #1f2328;
    }
    h1 { font-size: 17pt; border-bottom: 1pt solid #d0d7de; padding-bottom: 4pt; margin-top: 18pt; }
    h2 { font-size: 14pt; border-left: 3pt solid ${accent}; padding-left: 8pt; margin-top: 15pt; }
    h3 { font-size: 12pt; margin-top: 12pt; }
    /* 大表格防溢出与跨页表头重复保护 (Bug #2 Fix) */
    table.md-table {
      width: 100% !important;
      max-width: 100% !important;
      table-layout: fixed !important;
      border-collapse: collapse;
      margin: 10pt 0;
      page-break-inside: auto !important;
      break-inside: auto !important;
    }
    table.md-table thead {
      display: table-header-group;
    }
    table.md-table tr {
      page-break-inside: avoid !important;
      break-inside: avoid !important;
    }
    table.md-table th, table.md-table td {
      min-width: 0 !important;
      border: 1px solid #d0d7de;
      padding: 5pt 7pt;
      font-size: 9pt;
      line-height: 1.45;
      word-break: break-word !important;
      overflow-wrap: anywhere !important;
      white-space: normal !important;
      vertical-align: top;
    }
    table.md-table.md-table-dense th, table.md-table.md-table-dense td {
      padding: 4pt 5pt;
      font-size: 8pt;
    }
    table.md-table.md-table-ultra-dense th, table.md-table.md-table-ultra-dense td {
      padding: 3pt 4pt;
      font-size: 7.2pt;
    }
    table.md-table th {
      background-color: #f6f8fa !important;
      font-weight: 600;
    }
    table.md-table th code, table.md-table td code {
      white-space: pre-wrap !important;
      word-break: break-all !important;
    }
    .exported-code-card {
      margin: 10pt 0;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      background-color: #f6f8fa !important;
      overflow: hidden;
    }
    .exported-code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4pt 10pt;
      background-color: #eef1f5 !important;
      border-bottom: 1px solid #d0d7de;
      font-family: -apple-system, BlinkMacSystemFont, Consolas, sans-serif;
      font-size: 8pt;
      color: #57606a;
      page-break-after: avoid !important;
      break-after: avoid !important;
    }
    .exported-code-dots {
      display: inline-flex;
      gap: 4px;
      margin-right: 8px;
    }
    .exported-code-dots i {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .exported-code-dots i.dot-red { background-color: #ff5f56 !important; }
    .exported-code-dots i.dot-amber { background-color: #ffbd2e !important; }
    .exported-code-dots i.dot-green { background-color: #27c93f !important; }
    .exported-code-lang {
      font-weight: 700;
      color: ${accent};
      background: rgba(9, 105, 218, 0.1) !important;
      padding: 1px 6px;
      border-radius: 999px;
    }
    .exported-code-meta {
      margin-left: auto;
      color: #8c959f;
    }
    pre.exported-code-block {
      margin: 0 !important;
      padding: 8pt 12pt !important;
      background-color: #f6f8fa !important;
      border: none !important;
      white-space: pre-wrap !important;
      word-break: break-word !important;
      font-family: Consolas, "JetBrains Mono", "Courier New", monospace;
      font-size: 9pt;
      line-height: 1.55;
    }
    pre > code {
      background: transparent !important;
      border: none !important;
      padding: 0 !important;
      font-size: inherit !important;
    }
    :not(pre) > code {
      font-family: Consolas, "JetBrains Mono", monospace;
      font-size: 9pt;
      background-color: #eff1f3 !important;
      color: #cf222e;
      padding: 1pt 4pt;
      border-radius: 3px;
      border: 1px solid #d0d7de;
      word-break: break-all;
    }
    .exported-code-line {
      position: relative;
      display: block;
      min-height: 1.55em;
      line-height: 1.55;
      white-space: pre-wrap !important;
      word-break: break-word !important;
      overflow-wrap: anywhere !important;
      page-break-inside: avoid !important;
      break-inside: avoid !important;
    }
    .exported-code-line[data-code-line] {
      padding-left: 40px !important;
    }
    .exported-code-line[data-code-line]::before {
      content: attr(data-code-line);
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 28px;
      padding-right: 7px;
      margin: 0;
      text-align: right;
      color: #8c959f;
      border-right: 1px solid #d0d7de;
      user-select: none;
      box-sizing: border-box;
    }
    blockquote, .cm-callout-export, .md-math-block-preview, .md-mermaid-card, figure, img {
      page-break-inside: avoid !important;
      break-inside: avoid !important;
    }
    blockquote {
      border-left: 3pt solid ${ studio.quoteBorderColor || accent };
      margin: 8pt 0;
      padding: 4pt 12pt;
      background-color: #f6f8fa !important;
      color: #57606a;
    }
    .cm-callout-export {
      border: 1px solid rgba(9, 105, 218, 0.25);
      border-left: 3.5pt solid ${accent};
      border-radius: 5px;
      padding: 8pt 12pt;
      margin: 8pt 0;
      background-color: #f0f7ff !important;
    }
    .cm-wikilink, .cm-hashtag {
      color: ${accent};
      background-color: #eef6ff !important;
      padding: 1pt 5pt;
      border-radius: 8px;
      font-size: 9pt;
    }
    .katex-mathml { display: none !important; }
    .pdf-doc-footer {
      margin-top: 20pt;
      padding-top: 8pt;
      border-top: 1px dashed #d0d7de;
      display: flex;
      justify-content: space-between;
      font-size: 8pt;
      color: #8c959f;
    }
  </style>
</head>
<body>
  <div class="pdf-container">
    ${headerHtml}
    ${bodyHtml}
    ${footerHtml}
  </div>
</body>
</html>`;
}

/**
 * 打开出版级矢量 PDF 导出工作台 (支持原生 PDF 矢量书签树注入 Phase 2.3 与双层工具栏 UI Phase 1.10)
 */
export function openPdfExportModal(options: PdfExportOptions) {
  if (!pdfModalEl) {
    pdfModalEl = document.createElement("div");
    pdfModalEl.id = "ty-pdf-export-modal";
    pdfModalEl.className = "ty-modal-overlay hidden";
    document.body.appendChild(pdfModalEl);
  }

  let pageSize: "A4" | "Letter" | "A5" = "A4";
  let marginPreset: "standard" | "compact" | "academic" = "standard";
  let includeHeaderFooter = false;
  let generateOutline = true;
  let includeToc = false;
  let currentBookmarks: PdfBookmarkNode[] = [];

  const preparePreviewHtml = (): string => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="pdf-root">${options.bodyHtml}</div>`, "text/html");
    const root = doc.getElementById("pdf-root")!;
    if (includeHeaderFooter) {
      const firstChild = root.firstElementChild;
      if (
        firstChild &&
        firstChild.tagName.toLowerCase() === "h1" &&
        (firstChild.textContent || "").trim() === options.title.trim()
      ) {
        firstChild.remove();
      }
    }

    currentBookmarks = extractPdfBookmarkOutline(root);

    if (includeToc && currentBookmarks.length > 0) {
      const tocBox = doc.createElement("nav");
      tocBox.className = "pdf-auto-toc";
      tocBox.setAttribute(
        "style",
        "margin: 0 0 18pt 0; padding: 12pt 16pt; border: 1px solid #d0d7de; border-radius: 6px; background-color: #f6f8fa; page-break-inside: avoid;"
      );
      const tocItems = currentBookmarks
        .filter((h) => h.level <= 4)
        .map((h) => {
          const indentPt = (h.level - 1) * 14;
          const titleTxt = escapeHtml(h.title);
          return `<div style="padding-left:${indentPt}pt; margin: 3pt 0; font-size: ${
            h.level === 1 ? "10.5pt; font-weight:600" : "9.5pt"
          };"><a href="#${h.id}" style="color:#0969da; text-decoration:none;">${titleTxt}</a></div>`;
        })
        .join("");
      tocBox.innerHTML = `<div style="font-size:11pt; font-weight:700; margin-bottom:6pt; color:#1f2328; border-bottom:1px solid #d0d7de; padding-bottom:4pt;">目录大纲 (Table of Contents)</div>${tocItems}`;
      root.insertBefore(tocBox, root.firstChild);
    }

    inlineCodeSyntaxColors(root, false);
    return root.innerHTML;
  };

  pdfModalEl.classList.remove("hidden");

  const renderModal = () => {
    if (!pdfModalEl) return;
    const previewBody = preparePreviewHtml();
    const studio = getActiveThemeStudioPreset();
    const watermark = studio.watermarkSignature || "由 Quilla (羽墨) v0.10.0 矢量排版引擎生成";
    const widthPx = pageSize === "A5" ? 520 : 680;
    const paddingMap = {
      standard: "36px 42px",
      compact: "22px 26px",
      academic: "50px 56px",
    };
    const dateStr = new Date().toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    pdfModalEl.innerHTML = `
      <div class="ty-modal-card poster-modal-card" role="dialog" aria-modal="true">
        <div class="ty-modal-header">
          <div class="modal-title">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
            <span>导出出版级矢量 PDF 文档</span>
            <span class="modal-badge">${currentBookmarks.length} 个章节书签已就绪</span>
          </div>
          <button type="button" class="modal-close-btn" id="pdf-close-btn" title="关闭 (Esc)">✕</button>
        </div>

        <div class="export-toolbar-ribbon">
          <div class="graph-toolbar-controls">
            <div class="graph-scope-Segment" title="纸张规格">
              <button type="button" class="graph-scope-btn ${pageSize === "A4" ? "active" : ""}" data-pdf-size="A4">A4 标准</button>
              <button type="button" class="graph-scope-btn ${pageSize === "Letter" ? "active" : ""}" data-pdf-size="Letter">Letter</button>
              <button type="button" class="graph-scope-btn ${pageSize === "A5" ? "active" : ""}" data-pdf-size="A5">A5 电子书</button>
            </div>
            <div class="graph-scope-Segment" title="页边距预设">
              <button type="button" class="graph-scope-btn ${marginPreset === "standard" ? "active" : ""}" data-pdf-margin="standard">标准边距</button>
              <button type="button" class="graph-scope-btn ${marginPreset === "compact" ? "active" : ""}" data-pdf-margin="compact">紧凑</button>
              <button type="button" class="graph-scope-btn ${marginPreset === "academic" ? "active" : ""}" data-pdf-margin="academic">学术宽距</button>
            </div>
            <div class="graph-scope-Segment" title="PDF 目录书签与页眉选项">
              <button type="button" class="graph-scope-btn ${generateOutline ? "active" : ""}" id="pdf-toggle-outline-btn" title="自动将 H1~H6 标题注入为 PDF 阅读器侧边栏可折叠目录书签 (/Outlines)">PDF 矢量书签树 (${currentBookmarks.length})</button>
              <button type="button" class="graph-scope-btn ${includeToc ? "active" : ""}" id="pdf-toggle-toc-btn" title="在文档顶部插入可点击跳转的章节目录">内嵌目录</button>
              <button type="button" class="graph-scope-btn ${includeHeaderFooter ? "active" : ""}" id="pdf-toggle-hf-btn" title="切换文档抬头与页脚水印">装饰页眉</button>
            </div>
          </div>
        </div>

        <div class="poster-preview-scroller">
          <div class="poster-card-stage skin-ivory" style="width: ${widthPx}px; padding: ${paddingMap[marginPreset]}; background: #ffffff; color: #1f2328;">
            ${
              includeHeaderFooter
                ? `<div class="poster-card-header" style="border-bottom: 2px solid ${
                    studio.primaryAccentColor || "#0969da"
                  };">
                    <div class="poster-header-top">
                      <div class="poster-brand-pill">QUILLA · 羽墨出版级 PDF</div>
                      <div class="poster-meta-line">${dateStr} · ${options.wordCount} 词 · ${pageSize}</div>
                    </div>
                    <h1 class="poster-doc-main-title" style="color:#1f2328;">${escapeHtml(options.title)}</h1>
                  </div>`
                : ""
            }
            <div class="poster-card-body">
              ${previewBody}
            </div>
            ${
              includeHeaderFooter
                ? `<div class="poster-card-footer">
                    <span>${escapeHtml(watermark)}</span>
                    <span>${escapeHtml(options.title)}</span>
                  </div>`
                : ""
            }
          </div>
        </div>

        <div class="ty-modal-footer">
          <span class="footer-tip">自动保留表格列宽比例、跨页表头重复、代码高亮与原生 PDF 侧边栏矢量书签 (/Outlines)</span>
          <div class="tm-footer-btns">
            <button type="button" class="save-dialog-btn btn-discard" id="pdf-sys-print-btn">系统打印预览</button>
            <button type="button" class="modal-confirm-btn" id="pdf-native-export-btn">直接导出矢量 PDF (.pdf)...</button>
          </div>
        </div>
      </div>
    `;

    const close = () => pdfModalEl?.classList.add("hidden");
    pdfModalEl.querySelector("#pdf-close-btn")?.addEventListener("click", close);

    pdfModalEl.querySelectorAll<HTMLElement>("[data-pdf-size]").forEach((btn) => {
      btn.addEventListener("click", () => {
        pageSize = (btn.dataset.pdfSize as any) || "A4";
        renderModal();
      });
    });

    pdfModalEl.querySelectorAll<HTMLElement>("[data-pdf-margin]").forEach((btn) => {
      btn.addEventListener("click", () => {
        marginPreset = (btn.dataset.pdfMargin as any) || "standard";
        renderModal();
      });
    });

    pdfModalEl.querySelector("#pdf-toggle-outline-btn")?.addEventListener("click", () => {
      generateOutline = !generateOutline;
      renderModal();
    });

    pdfModalEl.querySelector("#pdf-toggle-toc-btn")?.addEventListener("click", () => {
      includeToc = !includeToc;
      renderModal();
    });

    pdfModalEl.querySelector("#pdf-toggle-hf-btn")?.addEventListener("click", () => {
      includeHeaderFooter = !includeHeaderFooter;
      renderModal();
    });

    pdfModalEl.querySelector("#pdf-sys-print-btn")?.addEventListener("click", () => {
      close();
      const marginMap = {
        standard: "16mm 18mm",
        compact: "10mm 12mm",
        academic: "24mm 26mm",
      };
      const pageCss = `@page { size: ${pageSize} portrait; margin: ${marginMap[marginPreset]}; }`;
      options.onSystemPrintFallback?.(previewBody, pageCss);
    });

    pdfModalEl.querySelector("#pdf-native-export-btn")?.addEventListener("click", async () => {
      const exportBtn = pdfModalEl?.querySelector("#pdf-native-export-btn") as HTMLButtonElement | null;
      try {
        const savePath = await invoke<string | null>("select_export_pdf_path", {
          defaultName: `${options.title}.pdf`,
        });
        if (!savePath || !savePath.trim()) return;

        if (exportBtn) {
          exportBtn.disabled = true;
          exportBtn.textContent = "正在生成矢量 PDF 与书签树...";
        }

        const fullHtml = buildStandalonePdfDocumentHtml(
          options.title,
          previewBody,
          options.themeCss,
          {
            pageSize,
            marginPreset,
            includeHeaderFooter,
            wordCount: options.wordCount,
          }
        );

        await invoke("export_pdf_document", {
          path: savePath.trim(),
          htmlContent: fullHtml,
          pageSize,
          generateOutline,
          outlineItems: generateOutline ? currentBookmarks : [],
        });

        close();
        showToast(
          `PDF 导出成功（含 ${generateOutline ? currentBookmarks.length : 0} 个侧边栏目录书签）：${savePath
            .trim()
            .split(/[\\/]/)
            .pop()}`,
          "success"
        );
      } catch (err) {
        console.warn("原生无头 PDF 引擎回退至系统打印预览:", err);
        close();
        const marginMap = {
          standard: "16mm 18mm",
          compact: "10mm 12mm",
          academic: "24mm 26mm",
        };
        const pageCss = `@page { size: ${pageSize} portrait; margin: ${marginMap[marginPreset]}; }`;
        options.onSystemPrintFallback?.(previewBody, pageCss);
      } finally {
        if (exportBtn) {
          exportBtn.disabled = false;
          exportBtn.textContent = "直接导出矢量 PDF (.pdf)...";
        }
      }
    });
  };

  pdfModalEl.onclick = (e) => {
    if (e.target === pdfModalEl) pdfModalEl?.classList.add("hidden");
  };

  renderModal();
}
