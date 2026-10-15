import { EditorView } from "@codemirror/view";

/**
 * 递归解析 HTML DOM 节点为标准优雅的 Markdown 格式 (Typora 级别 Smart Paste)
 */
export function htmlToMarkdown(htmlString: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  return processNode(doc.body).trim().replace(/\n{3,}/g, "\n\n");
}

function processNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  // 忽略不可视标签
  if (["script", "style", "meta", "link", "noscript"].includes(tag)) {
    return "";
  }

  const getChildrenText = () => {
    let res = "";
    el.childNodes.forEach((child) => {
      res += processNode(child);
    });
    return res;
  };

  switch (tag) {
    case "h1":
      return `\n\n# ${getChildrenText().trim()}\n\n`;
    case "h2":
      return `\n\n## ${getChildrenText().trim()}\n\n`;
    case "h3":
      return `\n\n### ${getChildrenText().trim()}\n\n`;
    case "h4":
      return `\n\n#### ${getChildrenText().trim()}\n\n`;
    case "h5":
      return `\n\n##### ${getChildrenText().trim()}\n\n`;
    case "h6":
      return `\n\n###### ${getChildrenText().trim()}\n\n`;
    case "p":
      return `\n\n${getChildrenText().trim()}\n\n`;
    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";
    case "strong":
    case "b": {
      const t = getChildrenText().trim();
      return t ? `**${t}**` : "";
    }
    case "em":
    case "i": {
      const t = getChildrenText().trim();
      return t ? `*${t}*` : "";
    }
    case "del":
    case "s":
    case "strike": {
      const t = getChildrenText().trim();
      return t ? `~~${t}~~` : "";
    }
    case "code": {
      if (el.parentElement?.tagName.toLowerCase() === "pre") {
        return getChildrenText();
      }
      const t = getChildrenText();
      return t ? `\`${t}\`` : "";
    }
    case "pre": {
      const codeChild = el.querySelector("code");
      const lang = codeChild?.className.match(/language-(\w+)/)?.[1] || "";
      const text = (codeChild ? codeChild.textContent : el.textContent) || "";
      return `\n\n\`\`\`${lang}\n${text.trim()}\n\`\`\`\n\n`;
    }
    case "blockquote": {
      const lines = getChildrenText()
        .trim()
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      return `\n\n${lines}\n\n`;
    }
    case "a": {
      const href = el.getAttribute("href") || "";
      const text = getChildrenText().trim() || href;
      return href ? `[${text}](${href})` : text;
    }
    case "img": {
      const src = el.getAttribute("src") || "";
      const alt = el.getAttribute("alt") || "";
      const width = el.getAttribute("width");
      const align = el.getAttribute("align");
      if (width || align) {
        const wAttr = width ? ` width="${width}"` : "";
        const aAttr = align ? ` align="${align}"` : "";
        const altAttr = alt ? ` alt="${alt}"` : "";
        return `<img src="${src}"${altAttr}${wAttr}${aAttr} />`;
      }
      return src ? `![${alt}](${src})` : "";
    }
    case "ul": {
      let res = "\n\n";
      el.querySelectorAll(":scope > li").forEach((li) => {
        res += `- ${processNode(li).trim()}\n`;
      });
      return `${res}\n`;
    }
    case "ol": {
      let res = "\n\n";
      let i = 1;
      el.querySelectorAll(":scope > li").forEach((li) => {
        res += `${i++}. ${processNode(li).trim()}\n`;
      });
      return `${res}\n`;
    }
    case "li":
      return getChildrenText();
    case "table": {
      const rows: string[][] = [];
      el.querySelectorAll("tr").forEach((tr) => {
        const row: string[] = [];
        tr.querySelectorAll("th, td").forEach((cell) => {
          row.push(processNode(cell).trim().replace(/\|/g, "\\|").replace(/\n/g, " "));
        });
        if (row.length > 0) rows.push(row);
      });

      if (rows.length === 0) return "";
      const colCount = Math.max(...rows.map((r) => r.length));
      const headers = rows[0].map((h, i) => h || `列 ${i + 1}`);
      while (headers.length < colCount) headers.push(`列 ${headers.length + 1}`);

      let md = `\n\n| ${headers.join(" | ")} |\n`;
      md += `| ${new Array(colCount).fill("---").join(" | ")} |\n`;
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        while (row.length < colCount) row.push("");
        md += `| ${row.join(" | ")} |\n`;
      }
      return `${md}\n`;
    }
    default:
      return getChildrenText();
  }
}

let isShiftDown = false;
window.addEventListener("keydown", (e) => {
  if (e.key === "Shift") isShiftDown = true;
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Shift") isShiftDown = false;
});

/**
 * 监听剪贴板粘贴事件，在普通 Ctrl+V 粘贴富文本时智能转换为 Markdown
 * 若按下 Ctrl+Shift+V，则保留浏览器原生纯文本粘贴
 */
export function initSmartPaste(view: EditorView) {
  view.dom.addEventListener("paste", (e: ClipboardEvent) => {
    // 若用户按了 Shift (Ctrl+Shift+V)，则执行纯文本粘贴
    if (isShiftDown) return;

    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    // 如果剪贴板含有图片文件，优先由已有的本地图片资产落盘管道 (image-handler) 处理
    if (clipboardData.files && clipboardData.files.length > 0) {
      for (let i = 0; i < clipboardData.files.length; i++) {
        if (clipboardData.files[i].type.startsWith("image/")) {
          return;
        }
      }
    }

    const html = clipboardData.getData("text/html");
    const plainText = clipboardData.getData("text/plain");

    if (html && html.trim().length > 0) {
      // 检验 HTML 是否包含富文本结构 (避免无意义的纯 span 嵌套)
      const hasStructure = /<(h[1-6]|p|table|ul|ol|li|blockquote|pre|strong|b|em|i|del|a|img)[^>]*>/i.test(html);
      if (hasStructure) {
        try {
          const md = htmlToMarkdown(html);
          if (md && md.trim().length > 0) {
            e.preventDefault();
            e.stopPropagation();
            const { from, to } = view.state.selection.main;
            view.dispatch({
              changes: { from, to, insert: md },
              selection: { anchor: from + md.length },
              userEvent: "input.paste.markdown",
            });
            return;
          }
        } catch (err) {
          console.warn("Smart paste HTML 转 Markdown 容错回退纯文本:", err);
        }
      }
    }
  }, true);
}
