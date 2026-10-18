import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./save-dialog";

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
      lineDiv.setAttribute(
        "style",
        "display: block; margin: 0; padding: 0; line-height: 1.65; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; font-family: Consolas, 'JetBrains Mono', 'Courier New', monospace; font-size: 13px;"
      );

      if (showLn) {
        const lnAttr = lineSpan.getAttribute("data-code-line") || String(idx + 1);
        const lnSpan = root.ownerDocument.createElement("span");
        lnSpan.setAttribute(
          "style",
          `display: inline-block; min-width: 26px; padding-right: 12px; margin-right: 8px; text-align: right; color: ${lnColor}; border-right: 1px solid ${
            options.isDark ? "#30363d" : "#e1e4e8"
          }; user-select: none; font-size: 12px;`
        );
        lnSpan.textContent = options.preserveSpacesWithNbsp
          ? `${lnAttr.padStart(2, "\u00A0")}\u00A0│\u00A0`
          : lnAttr;
        lineDiv.appendChild(lnSpan);
      }

      const contentSpan = root.ownerDocument.createElement("span");
      let inner = lineSpan.innerHTML;
      if (options.preserveSpacesWithNbsp) {
        // 将行首与连续空格替换为 &nbsp; 防止 Word 吞噬代码缩进
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

  // 移除 KaTeX 隐藏的 MathML 辅助层，避免粘贴到外部编辑器或导出时公式重复显示两遍
  root.querySelectorAll(".katex-mathml").forEach((el) => el.remove());

  // 转换 <del> 为带内联删除线的 <s>，防止外部富文本编辑器误判为修订批注
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
      "font-weight: 700; letter-spacing: 0.05em; color: #0969da; background-color: rgba(9, 105, 218, 0.1); padding: 1px 7px; border-radius: 999px; font-size: 11px;"
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
        "font-family: Consolas, Menlo, monospace; font-size: 13.5px; background-color: #eff1f3; color: #cf222e; padding: 2px 5px; border-radius: 4px;"
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
    el.setAttribute("style", "color: #0969da; text-decoration: none; border-bottom: 1px solid #80b3ff;");
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

  const footer = doc.createElement("p");
  footer.setAttribute(
    "style",
    "margin-top: 24px; padding-top: 10px; border-top: 1px dashed #d0d7de; font-size: 12px; color: #8c959f; text-align: right;"
  );
  footer.textContent = `由 Quilla (羽墨) v0.7 排版生成 · ${title}`;
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
 * 专门面向 Microsoft Word / WPS 构建深度兼容的 HTML DOM 树 (Bug #10 彻底修复)：
 * 1. 将所有 <del>/<strike> 转为 <s style="text-decoration:line-through">，根治 Word 将删除线识别为“修订/批注气泡”的问题。
 * 2. 将代码块 <pre> 转为 Word 完美支持的单格 <table> 布局，保留行号、缩进空格 (&nbsp;) 与全量语法高亮色值。
 * 3. 将任务列表 <input type="checkbox"> 替换为 ☑ / ☐ 符号，避免 Word 生成丑陋的旧版表单控件。
 * 4. 将 Mermaid <svg> 自动栅格化为高清 PNG <img>，解决 Word 无法直接解析内联 SVG 的问题。
 * 5. 清理 KaTeX 重复的 .katex-html / <annotation>，保留纯净的公式展示，杜绝公式乱码或双份文本。
 * 6. 将全部 rgba(...) 替换为纯 Hex 颜色，防止 Word 渲染成全黑背景。
 */
async function buildWordCompatibleHtml(bodyHtml: string, title: string): Promise<string> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<div id="quilla-word-root">${bodyHtml}</div>`,
    "text/html"
  );
  const root = doc.getElementById("quilla-word-root")!;

  // 1. 彻底替换 <del> 为 <s>，杜绝触发 Word 修订模式与右侧批注框 (Bug #10)
  root.querySelectorAll("del, s, strike").forEach((el) => {
    const sEl = doc.createElement("s");
    sEl.setAttribute("style", "text-decoration: line-through; color: #6e7781;");
    sEl.innerHTML = el.innerHTML;
    el.replaceWith(sEl);
  });

  // 2. 替换任务复选框 <input type="checkbox"> 为精致 Unicode 符号
  root.querySelectorAll("input[type='checkbox']").forEach((inp) => {
    const isChecked = inp.hasAttribute("checked") || (inp as HTMLInputElement).checked;
    const span = doc.createElement("span");
    span.setAttribute(
      "style",
      `font-family: 'Segoe UI Symbol', 'Microsoft YaHei', sans-serif; font-weight: bold; color: ${
        isChecked ? "#0969da" : "#57606a"
      }; margin-right: 4pt;`
    );
    span.textContent = isChecked ? "☑ " : "☐ ";
    inp.replaceWith(span);
  });

  // 3. 清理 KaTeX 公式双层 DOM，移除 <annotation> 与 .katex-mathml 防止 Word 出现两遍公式文本
  root.querySelectorAll(".katex-mathml, annotation").forEach((el) => el.remove());
  root.querySelectorAll(".md-math-block-preview").forEach((el) => {
    el.setAttribute(
      "style",
      "margin: 10pt 0; padding: 8pt 12pt; background-color: #f8fafc; border: 1pt solid #e2e8f0; text-align: center; font-family: 'Cambria Math', 'Times New Roman', serif; font-size: 12pt;"
    );
  });

  // 4. 将 Mermaid <svg> 转换为高清 Base64 PNG 图片嵌入 Word
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

  // 5. 内联代码语法高亮色值并将代码块 <pre> 转换为 Word 原生兼容的单格边框表格
  inlineCodeSyntaxColors(root, false);
  materializeCodeBlockLines(root, {
    isDark: false,
    preserveSpacesWithNbsp: true,
    showLineNumbers: true,
  });

  // 先对所有非代码块内的行内 <code> 写入 MSO 兼容底色样式（确保表格、引用块、Callout 内的行内代码同样生效）
  root.querySelectorAll("code").forEach((el) => {
    if (!el.closest("pre") && !el.closest(".exported-code-card")) {
      el.setAttribute(
        "style",
        "font-family: Consolas, 'Courier New', monospace; font-size: 9.5pt; background-color: #eff1f3; color: #cf222e; padding: 1pt 3pt; border: 1pt solid #d0d7de;"
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
      "width: 100%; border-collapse: collapse; margin: 10pt 0; background-color: #f6f8fa; border: 1pt solid #d0d7de;"
    );

    const headerTr = doc.createElement("tr");
    const headerTd = doc.createElement("td");
    headerTd.setAttribute(
      "style",
      "padding: 4pt 10pt; background-color: #eef1f5; border-bottom: 1pt solid #d0d7de; font-family: Consolas, Arial, sans-serif; font-size: 8.5pt; color: #57606a;"
    );
    headerTd.innerHTML = `<span style="color:#ff5f56;">●</span> <span style="color:#ffbd2e;">●</span> <span style="color:#27c93f;">●</span>&nbsp;&nbsp;<strong style="color:#0969da;">${langText}</strong>${
      metaText ? `&nbsp;·&nbsp;<span>${metaText}</span>` : ""
    }`;
    headerTr.appendChild(headerTd);
    codeTable.appendChild(headerTr);

    const tr = doc.createElement("tr");
    const td = doc.createElement("td");
    td.setAttribute(
      "style",
      "padding: 9pt 12pt; background-color: #f6f8fa; border: 1pt solid #d0d7de; font-family: Consolas, 'Courier New', monospace; font-size: 9.5pt; line-height: 1.55; color: #24292f;"
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
      "font-size: 18pt; font-weight: bold; color: #1f2328; margin: 18pt 0 10pt; padding-bottom: 4pt; border-bottom: 1.5pt solid #0969da;"
    );
  });

  root.querySelectorAll("h2").forEach((el) => {
    el.setAttribute(
      "style",
      "font-size: 14.5pt; font-weight: bold; color: #1f2328; margin: 15pt 0 8pt; padding-left: 6pt; border-left: 3pt solid #0969da;"
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
      : "#0969da";
    const bgColor = isCallout ? "#f0f7ff" : "#f6f8fa";

    const quoteTable = doc.createElement("table");
    quoteTable.setAttribute("width", "100%");
    quoteTable.setAttribute("cellspacing", "0");
    quoteTable.setAttribute("cellpadding", "0");
    quoteTable.setAttribute(
      "style",
      `width: 100%; border-collapse: collapse; margin: 9pt 0; background-color: ${bgColor}; border: 1pt solid #e1e4e8; border-left: 3.5pt solid ${borderColor};`
    );
    const tr = doc.createElement("tr");
    const td = doc.createElement("td");
    td.setAttribute(
      "style",
      `padding: 7pt 11pt; background-color: ${bgColor}; color: #24292f; font-size: 10.5pt; line-height: 1.65;`
    );
    td.innerHTML = el.innerHTML;
    tr.appendChild(td);
    quoteTable.appendChild(tr);
    el.replaceWith(quoteTable);
  });

  root.querySelectorAll(".cm-callout-header-widget").forEach((el) => {
    el.setAttribute(
      "style",
      "font-weight: bold; color: #0969da; margin-bottom: 4pt; font-size: 10.5pt;"
    );
  });

  root.querySelectorAll("table.md-table").forEach((el) => {
    el.setAttribute("width", "100%");
    el.setAttribute("cellspacing", "0");
    el.setAttribute("cellpadding", "6");
    el.setAttribute(
      "style",
      "border-collapse: collapse; width: 100%; margin: 10pt 0; font-size: 10.5pt; border: 1pt solid #d0d7de;"
    );
  });

  root.querySelectorAll("table.md-table th").forEach((el) => {
    const align = (el as HTMLElement).style.textAlign || "left";
    el.setAttribute(
      "style",
      `border: 1pt solid #d0d7de; padding: 6pt 9pt; background-color: #f6f8fa; font-weight: bold; text-align: ${align};`
    );
  });

  root.querySelectorAll("table.md-table td").forEach((el) => {
    const align = (el as HTMLElement).style.textAlign || "left";
    el.setAttribute(
      "style",
      `border: 1pt solid #d0d7de; padding: 6pt 9pt; text-align: ${align};`
    );
  });

  root.querySelectorAll("mark").forEach((el) => {
    el.setAttribute("style", "background-color: #fff8c5; color: #24292f; padding: 0 2pt;");
  });

  root.querySelectorAll(".cm-wikilink, .cm-hashtag").forEach((el) => {
    el.setAttribute(
      "style",
      "background-color: #eef6ff; color: #0969da; padding: 1pt 5pt; font-weight: bold; font-size: 10pt;"
    );
  });

  const footer = doc.createElement("p");
  footer.setAttribute(
    "style",
    "margin-top: 18pt; padding-top: 8pt; border-top: 1pt dashed #d0d7de; font-size: 9pt; color: #8c959f; text-align: right;"
  );
  footer.textContent = `由 Quilla (羽墨) v0.7 导出 · ${title}`;
  root.appendChild(footer);

  return root.innerHTML;
}

/**
 * 导出为兼容 Microsoft Word / WPS 的标准 .doc 文档 (Bug #10)
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
  table { border-collapse: collapse; width: 100%; }
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

let posterModalEl: HTMLElement | null = null;

/**
 * 打开社交长图分享卡片工作台（支持切换主题配色、海报宽度，并弹出系统保存对话框选择保存位置）(Bug #9)
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
  let posterWidth: 640 | 820 = 640;
  const dateStr = new Date().toISOString().slice(0, 10);

  // 预处理长图 HTML：移除 KaTeX 重复的 .katex-mathml，物化代码行号与语法着色
  const preparePosterHtml = (rawHtml: string, skin: "ivory" | "dark" | "mint"): string => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="poster-prep">${rawHtml}</div>`, "text/html");
    const root = doc.getElementById("poster-prep")!;
    root.querySelectorAll(".katex-mathml").forEach((el) => el.remove());

    // 若正文第一个元素就是与 options.title 完全相同的 H1，避免与海报头部大标题重复
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
            <div class="graph-scope-Segment">
              <button type="button" class="graph-scope-btn ${posterWidth === 640 ? "active" : ""}" data-width="640">标准 640px</button>
              <button type="button" class="graph-scope-btn ${posterWidth === 820 ? "active" : ""}" data-width="820">宽屏 820px</button>
            </div>
            <button type="button" class="modal-close-btn" id="poster-close-btn" title="关闭 (Esc)">✕</button>
          </div>
        </div>

        <div class="poster-preview-scroller">
          <div class="poster-card-stage skin-${currentSkin}" id="quilla-poster-stage" style="width: ${posterWidth}px;">
            <div class="poster-card-header">
              <div class="poster-header-top">
                <div class="poster-brand-pill">QUILLA · 羽墨笔记</div>
                <div class="poster-meta-line">${dateStr} · ${options.wordCount} 词 · 约 ${Math.max(1, Math.ceil(options.wordCount / 260))} 分钟阅读</div>
              </div>
              <h1 class="poster-doc-main-title">${escapeHtml(options.title)}</h1>
            </div>
            <div class="poster-card-body">
              ${preparedBody}
            </div>
            <div class="poster-card-footer">
              <span>Written with Quilla (羽墨) v0.7</span>
              <span>Markdown Knowledge Studio</span>
            </div>
          </div>
        </div>

        <div class="ty-modal-footer">
          <span class="footer-tip">点击保存将打开系统文件对话框，由您自由选择保存目录与文件名</span>
          <div class="tm-footer-btns">
            <button type="button" class="save-dialog-btn btn-discard" id="poster-cancel-btn">关闭</button>
            <button type="button" class="modal-confirm-btn" id="poster-download-btn">选择位置并导出长图 (.png)...</button>
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
        posterWidth = Number(btn.dataset.width) === 820 ? 820 : 640;
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

/**
 * 递归将真实 DOM 节点的计算样式内联到克隆节点上，
 * 确保在 SVG <foreignObject> 隔离沙箱内标题、代码块、Callout、表格、公式全部 100% 还原 (Bug #9)
 */
function inlineComputedStylesRecursive(origEl: Element, cloneEl: Element) {
  if (origEl instanceof HTMLElement && cloneEl instanceof HTMLElement) {
    const tag = origEl.tagName;
    const isCodeInsidePre = tag === "CODE" && origEl.parentElement?.tagName === "PRE";
    const cs = window.getComputedStyle(origEl);
    const props = [
      "font-family",
      "font-size",
      "font-weight",
      "font-style",
      "line-height",
      "letter-spacing",
      "color",
      "background-color",
      "padding",
      "margin",
      "border-top",
      "border-right",
      "border-bottom",
      "border-left",
      "border-radius",
      "border-collapse",
      "box-sizing",
      "display",
      "flex-direction",
      "align-items",
      "justify-content",
      "gap",
      "text-align",
      "text-decoration",
      "white-space",
      "word-break",
      "overflow-wrap",
      "max-width",
    ];
    let inlineStr = "";
    for (const p of props) {
      if (isCodeInsidePre && (p.startsWith("border") || p.startsWith("background") || p === "padding")) {
        continue;
      }
      const val = cs.getPropertyValue(p);
      if (val && val !== "none" && val !== "normal" && val !== "0px" && val !== "rgba(0, 0, 0, 0)") {
        inlineStr += `${p}:${val};`;
      }
    }
    if (tag === "PRE" || tag === "CODE") {
      inlineStr += "white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;overflow:visible;";
      if (isCodeInsidePre) {
        inlineStr += "background:transparent;border:none;padding:0;border-radius:0;display:block;";
      }
    }
    const existing = cloneEl.getAttribute("style") || "";
    cloneEl.setAttribute("style", `${inlineStr}${existing}`);
  }

  const origChildren = origEl.children;
  const cloneChildren = cloneEl.children;
  const len = Math.min(origChildren.length, cloneChildren.length);
  for (let i = 0; i < len; i++) {
    inlineComputedStylesRecursive(origChildren[i], cloneChildren[i]);
  }
}


async function exportDomStageToPng(
  stage: HTMLElement,
  title: string,
  skin: "ivory" | "dark" | "mint"
) {
  // 1. 先弹出系统原生保存对话框让用户自由选择保存路径与文件名 (Bug #9)
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

  const width = stage.offsetWidth || 640;
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
  inlineComputedStylesRecursive(stage, cloned);

  const height = Math.max(stage.scrollHeight, stage.offsetHeight, 400);
  cloned.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  cloned.style.width = `${width}px`;
  cloned.style.minHeight = `${height}px`;
  cloned.style.margin = "0";
  cloned.style.boxSizing = "border-box";
  cloned.style.background = bgColors[skin];
  cloned.style.color = textColors[skin];
  cloned.style.padding = "38px 44px";
  cloned.style.fontFamily =
    "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  cloned.style.lineHeight = "1.75";

  const embeddedCss = `
    * { box-sizing: border-box; }
    .poster-card-header { margin-bottom: 22px; padding-bottom: 16px; border-bottom: 1px solid ${borderColors[skin]}; }
    .poster-header-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .poster-brand-pill { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: #0969da; background: rgba(9, 105, 218, 0.1); padding: 3px 10px; border-radius: 999px; }
    .poster-meta-line { font-size: 12px; opacity: 0.72; }
    .poster-doc-main-title { font-size: 26px; font-weight: 800; line-height: 1.35; margin: 4px 0 0; color: ${textColors[skin]}; }
    .poster-card-body h1 { font-size: 22px; font-weight: 700; margin: 22px 0 12px; padding-bottom: 6px; border-bottom: 2px solid #0969da; color: ${textColors[skin]}; }
    .poster-card-body h2 { font-size: 18px; font-weight: 700; margin: 18px 0 10px; padding-left: 10px; border-left: 4px solid #0969da; color: ${textColors[skin]}; }
    .poster-card-body h3, .poster-card-body h4 { font-size: 16px; font-weight: 700; margin: 14px 0 8px; color: ${textColors[skin]}; }
    .poster-card-body p { margin: 10px 0; line-height: 1.8; font-size: 15px; }
    .poster-card-body .exported-code-card { margin: 14px 0; border-radius: 8px; background: ${codeBgColors[skin]}; border: 1px solid ${borderColors[skin]}; overflow: hidden; }
    .poster-card-body .exported-code-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 14px; border-bottom: 1px solid ${borderColors[skin]}; font-size: 11.5px; opacity: 0.85; }
    .poster-card-body .exported-code-dots { display: inline-flex; gap: 5px; margin-right: 8px; }
    .poster-card-body .exported-code-dots i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; }
    .poster-card-body .exported-code-dots i.dot-red { background: #ff5f56; }
    .poster-card-body .exported-code-dots i.dot-amber { background: #ffbd2e; }
    .poster-card-body .exported-code-dots i.dot-green { background: #27c93f; }
    .poster-card-body .exported-code-lang { font-weight: 700; color: #0969da; font-size: 11px; }
    .poster-card-body .exported-code-meta { margin-left: auto; font-size: 11px; opacity: 0.7; }
    .poster-card-body pre { margin: 0; padding: 12px 16px; background: ${codeBgColors[skin]}; border: none; white-space: pre-wrap !important; word-break: break-word !important; overflow-wrap: anywhere !important; font-family: Consolas, 'JetBrains Mono', monospace; font-size: 13px; line-height: 1.65; }
    .poster-card-body :not(pre) > code { font-family: Consolas, 'JetBrains Mono', monospace; font-size: 13px; background: rgba(127, 127, 127, 0.12); padding: 2px 5px; border-radius: 4px; border: 1px solid ${borderColors[skin]}; }
    .poster-card-body pre > code { font-family: Consolas, 'JetBrains Mono', monospace; font-size: 13px; background: transparent !important; border: none !important; padding: 0 !important; }
    .poster-card-body blockquote, .poster-card-body .cm-callout-export { margin: 14px 0; padding: 12px 16px; border-left: 4px solid #0969da; background: ${codeBgColors[skin]}; border-radius: 6px; }
    .poster-card-body table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13.5px; }
    .poster-card-body th, .poster-card-body td { border: 1px solid ${borderColors[skin]}; padding: 7px 10px; }
    .poster-card-body th { background: ${codeBgColors[skin]}; font-weight: 600; }
    .poster-card-body s, .poster-card-body del { text-decoration: line-through; opacity: 0.68; }
    .poster-card-body mark { background: #fff8c5; color: #24292f; padding: 1px 4px; border-radius: 3px; }
    .poster-card-footer { margin-top: 28px; padding-top: 14px; border-top: 1px dashed ${borderColors[skin]}; display: flex; justify-content: space-between; font-size: 12px; opacity: 0.65; }
  `;

  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <style>${embeddedCss}</style>
    <foreignObject width="100%" height="100%">
      ${new XMLSerializer().serializeToString(cloned)}
    </foreignObject>
  </svg>`;

  const saveSvgFallback = async () => {
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
  };

  const svgDataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
  const img = new Image();
  img.crossOrigin = "anonymous";

  img.onload = async () => {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = bgColors[skin];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);

    try {
      const pngDataUrl = canvas.toDataURL("image/png");
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
    } catch {
      await saveSvgFallback();
    }
  };

  img.onerror = async () => {
    await saveSvgFallback();
  };

  img.src = svgDataUrl;
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
 * 构建出版级独立矢量 PDF 完整 HTML 文档（内置精确分页保护、色彩保持、代码块卡片与公式样式）
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
        <span>由 Quilla (羽墨) v0.7 矢量排版引擎生成</span>
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
      font-size: 10.5pt;
      line-height: 1.75;
    }
    .pdf-container {
      max-width: 100%;
      margin: 0 auto;
    }
    .pdf-doc-banner {
      margin-bottom: 18pt;
      padding-bottom: 10pt;
      border-bottom: 1.5pt solid #0969da;
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
      color: #0969da;
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
    h2 { font-size: 14pt; border-left: 3pt solid #0969da; padding-left: 8pt; margin-top: 15pt; }
    h3 { font-size: 12pt; margin-top: 12pt; }
    table.md-table {
      width: 100%;
      border-collapse: collapse;
      margin: 10pt 0;
      page-break-inside: avoid !important;
      break-inside: avoid !important;
    }
    table.md-table th, table.md-table td {
      border: 1px solid #d0d7de;
      padding: 6pt 10pt;
      font-size: 9.5pt;
    }
    table.md-table th {
      background-color: #f6f8fa !important;
      font-weight: 600;
    }
    .exported-code-card {
      margin: 10pt 0;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      background-color: #f6f8fa !important;
      overflow: hidden;
      page-break-inside: avoid !important;
      break-inside: avoid !important;
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
      color: #0969da;
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
    }
    .exported-code-line[data-code-line]::before {
      content: attr(data-code-line);
      display: inline-block;
      width: 24px;
      margin-right: 10px;
      padding-right: 8px;
      text-align: right;
      color: #8c959f;
      border-right: 1px solid #d0d7de;
      user-select: none;
    }
    blockquote, .cm-callout-export, .md-math-block-preview, .md-mermaid-card, figure, img {
      page-break-inside: avoid !important;
      break-inside: avoid !important;
    }
    blockquote {
      border-left: 3pt solid #0969da;
      margin: 8pt 0;
      padding: 4pt 12pt;
      background-color: #f6f8fa !important;
      color: #57606a;
    }
    .cm-callout-export {
      border: 1px solid rgba(9, 105, 218, 0.25);
      border-left: 3.5pt solid #0969da;
      border-radius: 5px;
      padding: 8pt 12pt;
      margin: 8pt 0;
      background-color: #f0f7ff !important;
    }
    .cm-wikilink, .cm-hashtag {
      color: #0969da;
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
 * 打开出版级矢量 PDF 导出工作台 (支持纸张规格、页边距预设、页眉页脚开关、Rust 原生无头矢量导出与系统打印双引擎)
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
  let includeHeaderFooter = true;

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
    inlineCodeSyntaxColors(root, false);
    return root.innerHTML;
  };

  pdfModalEl.classList.remove("hidden");

  const renderModal = () => {
    if (!pdfModalEl) return;
    const previewBody = preparePreviewHtml();
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
          </div>
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
            <button type="button" class="graph-scope-btn ${includeHeaderFooter ? "active" : ""}" id="pdf-toggle-hf-btn" title="切换文档抬头与页脚水印">页眉页脚</button>
            <button type="button" class="modal-close-btn" id="pdf-close-btn" title="关闭 (Esc)">✕</button>
          </div>
        </div>

        <div class="poster-preview-scroller">
          <div class="poster-card-stage skin-ivory" style="width: ${widthPx}px; padding: ${paddingMap[marginPreset]}; background: #ffffff; color: #1f2328;">
            ${
              includeHeaderFooter
                ? `<div class="poster-card-header" style="border-bottom: 2px solid #0969da;">
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
                    <span>由 Quilla (羽墨) v0.7 矢量排版引擎生成</span>
                    <span>${escapeHtml(options.title)}</span>
                  </div>`
                : ""
            }
          </div>
        </div>

        <div class="ty-modal-footer">
          <span class="footer-tip">自动保留代码块卡片底色、语法高亮、矢量公式与防截断分页 (break-inside: avoid)</span>
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
          exportBtn.textContent = "正在生成矢量 PDF...";
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
        });

        close();
        showToast(`PDF 导出成功：${savePath.trim().split(/[\\/]/).pop()}`, "success");
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
