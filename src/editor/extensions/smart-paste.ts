import { EditorView } from "@codemirror/view";
import { isInsideCodeContextAST } from "./doc-structure";
import { isLikelyUrl, normalizeUrlForLink } from "./inline-boundary-guard";

/**
 * 递归解析 HTML DOM 节点为标准优雅的 Markdown 格式 (支持多级嵌套列表、引用块内列表、保留空表头、代码块与内联样式)
 */
export function htmlToMarkdown(htmlString: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  return processNode(doc.body, 0)
    .trim()
    .replace(/\n{3,}/g, "\n\n");
}

function processNode(node: Node, listDepth: number = 0): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (["script", "style", "meta", "link", "noscript"].includes(tag)) {
    return "";
  }

  const getChildrenText = (depth: number = listDepth) => {
    let res = "";
    el.childNodes.forEach((child) => {
      res += processNode(child, depth);
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
      return listDepth > 0 ? `${getChildrenText().trim()} ` : `\n\n${getChildrenText().trim()}\n\n`;
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
    case "mark": {
      const t = getChildrenText().trim();
      return t ? `==${t}==` : "";
    }
    case "sub": {
      const t = getChildrenText().trim();
      return t ? `~${t}~` : "";
    }
    case "sup": {
      const t = getChildrenText().trim();
      return t ? `^${t}^` : "";
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
      const lang = codeChild?.className.match(/language-([\w+-]+)/)?.[1] || "";
      const text = (codeChild ? codeChild.textContent : el.textContent) || "";
      return `\n\n\`\`\`${lang}\n${text.trim()}\n\`\`\`\n\n`;
    }
    case "blockquote": {
      const normalizedInner = getChildrenText()
        .trim()
        .replace(/\n{3,}/g, "\n\n");
      const lines = normalizedInner
        .split("\n")
        .map((l) => {
          const trimmedRight = l.replace(/\s+$/, "");
          if (!trimmedRight) return ">";
          return trimmedRight.startsWith(">") ? `>${trimmedRight}` : `> ${trimmedRight}`;
        })
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
    case "ul":
    case "ol": {
      const isOrdered = tag === "ol";
      const indent = "  ".repeat(listDepth);
      let res = listDepth === 0 ? "\n\n" : "\n";
      let idx = 1;
      Array.from(el.children).forEach((child) => {
        if (child.tagName.toLowerCase() !== "li") return;
        let inlineContent = "";
        let nestedListContent = "";
        child.childNodes.forEach((liChild) => {
          if (
            liChild.nodeType === Node.ELEMENT_NODE &&
            ["ul", "ol"].includes((liChild as HTMLElement).tagName.toLowerCase())
          ) {
            nestedListContent += processNode(liChild, listDepth + 1);
          } else {
            inlineContent += processNode(liChild, listDepth + 1);
          }
        });
        const checkbox = child.querySelector("input[type='checkbox']") as HTMLInputElement | null;
        const taskPrefix = checkbox ? (checkbox.checked ? "[x] " : "[ ] ") : "";
        const prefix = isOrdered ? `${idx++}. ` : `- ${taskPrefix}`;
        res += `${indent}${prefix}${inlineContent.trim()}${nestedListContent}\n`;
      });
      return listDepth === 0 ? `${res}\n` : res.trimEnd();
    }
    case "li":
      return getChildrenText();
    case "table": {
      const rows: string[][] = [];
      el.querySelectorAll("tr").forEach((tr) => {
        const row: string[] = [];
        tr.querySelectorAll("th, td").forEach((cell) => {
          row.push(
            processNode(cell)
              .trim()
              .replace(/\|/g, "\\|")
              .replace(/\r?\n/g, "<br>")
          );
        });
        if (row.length > 0) rows.push(row);
      });

      if (rows.length === 0) return "";
      const colCount = Math.max(...rows.map((r) => r.length));
      const headers = rows[0].map((h) => h || "");
      while (headers.length < colCount) headers.push("");

      let md = `\n\n| ${headers.join(" | ")} |\n`;
      md += `| ${new Array(colCount).fill(":---").join(" | ")} |\n`;
      for (let r = 1; r < rows.length; r++) {
        const row = [...rows[r]];
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
 * 监听剪贴板粘贴事件：
 * 1. 当选中了一段非空单行文本且剪贴板内容为 URL 网址时，自动将选中文本包裹为 `[选中文本](网址)` 超链接。
 * 2. 在普通 Ctrl+V 粘贴富文本时智能转换为 Markdown；若按下 Ctrl+Shift+V，则保留浏览器原生纯文本粘贴。
 */
export function initSmartPaste(view: EditorView) {
  view.dom.addEventListener(
    "paste",
    (e: ClipboardEvent) => {
      if (isShiftDown) return;

      const target = e.target as HTMLElement | null;
      if (target && target.closest(".in-place-edit")) {
        return;
      }

      const clipboardData = e.clipboardData;
      if (!clipboardData) return;

      if (clipboardData.files && clipboardData.files.length > 0) {
        for (let i = 0; i < clipboardData.files.length; i++) {
          if (clipboardData.files[i].type.startsWith("image/")) {
            return;
          }
        }
      }

      // 1. 选中文字粘贴 URL 自动合成超链接 `[选中文本](URL)`
      const sel = view.state.selection.main;
      const plainText = clipboardData.getData("text/plain")?.trim() || "";
      if (
        !sel.empty &&
        plainText &&
        isLikelyUrl(plainText) &&
        !isInsideCodeContextAST(view.state, sel.from)
      ) {
        const selectedText = view.state.sliceDoc(sel.from, sel.to);
        if (selectedText && !selectedText.includes("\n") && !isLikelyUrl(selectedText)) {
          e.preventDefault();
          e.stopPropagation();
          const normalizedUrl = normalizeUrlForLink(plainText);
          const mdLink = `[${selectedText}](${normalizedUrl})`;
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: mdLink },
            selection: { anchor: sel.from + mdLink.length },
            userEvent: "input.paste.link",
          });
          return;
        }
      }

      const html = clipboardData.getData("text/html");

      if (html && html.trim().length > 0) {
        const hasStructure =
          /<(h[1-6]|p|table|ul|ol|li|blockquote|pre|strong|b|em|i|del|mark|sub|sup|a|img)[^>]*>/i.test(
            html
          );
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
    },
    true
  );
}
