/**
 * 零外部依赖的高性能多语言代码词法高亮引擎
 * 同时服务于 CodeMirror 6 实时预览行内装饰与 HTML / PDF 出版级导出管线
 */

export interface CodeTokenSpan {
  from: number;
  to: number;
  cls:
    | "cm-syn-comment"
    | "cm-syn-string"
    | "cm-syn-keyword"
    | "cm-syn-type"
    | "cm-syn-function"
    | "cm-syn-number"
    | "cm-syn-attr"
    | "cm-syn-operator";
}

const COMMON_KEYWORDS = new Set([
  // Rust / C / C++ / Go / Swift / Kotlin / Java / C#
  "fn", "let", "mut", "pub", "priv", "impl", "trait", "struct", "enum", "union",
  "match", "if", "else", "elif", "for", "while", "loop", "in", "break", "continue",
  "return", "yield", "async", "await", "move", "ref", "where", "use", "mod", "crate",
  "super", "self", "Self", "const", "static", "unsafe", "extern", "type", "dyn", "as",
  "package", "import", "from", "export", "default", "func", "var", "val", "defer",
  "go", "chan", "select", "fallthrough", "switch", "case", "try", "catch", "finally",
  "throw", "throws", "new", "delete", "class", "interface", "extends", "implements",
  "abstract", "final", "override", "virtual", "protected", "private", "public",
  "internal", "companion", "object", "fun", "init", "guard", "protocol", "extension",
  "namespace", "using", "sizeof", "typedef", "template", "typename",
  // JS / TS / Python / Shell / SQL
  "function", "typeof", "instanceof", "void", "readonly", "keyof", "infer", "is",
  "def", "lambda", "pass", "with", "global", "nonlocal", "assert", "del", "except",
  "raise", "and", "or", "not", "then", "fi", "do", "done", "esac", "echo", "local",
  "select", "insert", "update", " into", "values", "where", "join", "left", "right",
  "inner", "outer", "on", "group", "by", "order", "having", "limit", "offset",
  "create", "table", "drop", "alter", "index", "primary", "key", "foreign", "distinct",
]);

const COMMON_TYPES_AND_CONSTS = new Set([
  "true", "false", "null", "nullptr", "undefined", "None", "True", "False", "nil", "NaN",
  "Some", "Ok", "Err", "Option", "Result", "Vec", "String", "str", "usize", "isize",
  "u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128", "f32", "f64",
  "bool", "char", "Box", "Rc", "Arc", "Mutex", "HashMap", "HashSet", "BTreeMap",
  "int", "long", "short", "float", "double", "byte", "boolean", " void", "any", "unknown",
  "never", "number", "string", "symbol", "bigint", "Promise", "Array", "Map", "Set",
  "Record", "Partial", "Required", "Readonly", "Pick", "Omit", "HTMLElement", "Document",
  "Window", "Event", "list", "dict", "tuple", "set", "bytes", "object",
]);

function isHashCommentLang(lang: string): boolean {
  return [
    "python", "py", "sh", "bash", "shell", "zsh", "yaml", "yml",
    "toml", "dockerfile", "ruby", "rb", "perl", "r", "powershell", "ps1", "conf", "ini",
  ].includes(lang);
}

function isSqlLang(lang: string): boolean {
  return ["sql", "mysql", "postgres", "postgresql", "sqlite"].includes(lang);
}

/**
 * 对单行代码进行快速词法扫描，输出互不重叠的高亮 Token 区间
 */
export function tokenizeCodeLine(lineText: string, rawLang: string): CodeTokenSpan[] {
  const lang = (rawLang || "").trim().toLowerCase();
  if (!lineText || lang === "plaintext" || lang === "text" || lang === "txt") {
    return [];
  }

  const spans: CodeTokenSpan[] = [];
  const len = lineText.length;
  let i = 0;

  const pushSpan = (from: number, to: number, cls: CodeTokenSpan["cls"]) => {
    if (to > from) {
      spans.push({ from, to, cls });
    }
  };

  // JSON / YAML / TOML 键值属性特化识别
  if (lang === "yaml" || lang === "yml" || lang === "toml") {
    const keyMatch = lineText.match(/^(\s*[\w.\-]+)(\s*[:=])/);
    if (keyMatch) {
      pushSpan(0, keyMatch[1].length, "cm-syn-attr");
      i = keyMatch[0].length;
    }
  }

  while (i < len) {
    const ch = lineText[i];
    const next = i + 1 < len ? lineText[i + 1] : "";

    // 1. 跳过空白
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // 2. 行注释识别 (//, #, --, <!--)
    if (ch === "/" && next === "/") {
      pushSpan(i, len, "cm-syn-comment");
      break;
    }
    if (ch === "/" && next === "*") {
      const closeIdx = lineText.indexOf("*/", i + 2);
      if (closeIdx !== -1) {
        pushSpan(i, closeIdx + 2, "cm-syn-comment");
        i = closeIdx + 2;
        continue;
      } else {
        pushSpan(i, len, "cm-syn-comment");
        break;
      }
    }
    if (ch === "#" && isHashCommentLang(lang)) {
      pushSpan(i, len, "cm-syn-comment");
      break;
    }
    if (ch === "-" && next === "-" && isSqlLang(lang)) {
      pushSpan(i, len, "cm-syn-comment");
      break;
    }
    if (lineText.startsWith("<!--", i)) {
      const closeIdx = lineText.indexOf("-->", i + 4);
      if (closeIdx !== -1) {
        pushSpan(i, closeIdx + 3, "cm-syn-comment");
        i = closeIdx + 3;
        continue;
      } else {
        pushSpan(i, len, "cm-syn-comment");
        break;
      }
    }

    // 3. Rust 属性宏 #[...] 或 Python/TS 装饰器 @decorator
    if (ch === "#" && (next === "[" || (next === "!" && lineText[i + 2] === "["))) {
      const closeBracket = lineText.indexOf("]", i + 2);
      const end = closeBracket !== -1 ? closeBracket + 1 : len;
      pushSpan(i, end, "cm-syn-attr");
      i = end;
      continue;
    }
    if (ch === "@" && /[a-zA-Z_]/.test(next)) {
      let end = i + 1;
      while (end < len && /[\w.]/.test(lineText[end])) end++;
      pushSpan(i, end, "cm-syn-attr");
      i = end;
      continue;
    }

    // 4. 字符串字面量 ("...", '...', `...`)
    if (ch === '"' || ch === "'" || ch === "`") {
      // Rust 生命周期 'a 或 'static 不作为字符串闭合
      if (ch === "'" && (lang === "rust" || lang === "rs")) {
        const lifeMatch = lineText.slice(i).match(/^'[a-zA-Z_]\w*(?!')/);
        if (lifeMatch) {
          pushSpan(i, i + lifeMatch[0].length, "cm-syn-attr");
          i += lifeMatch[0].length;
          continue;
        }
      }
      const quote = ch;
      let end = i + 1;
      while (end < len) {
        if (lineText[end] === "\\") {
          end += 2;
          continue;
        }
        if (lineText[end] === quote) {
          end++;
          break;
        }
        end++;
      }
      // JSON 对象键名 ("key":)
      let afterQuote = end;
      while (afterQuote < len && /\s/.test(lineText[afterQuote])) afterQuote++;
      if (quote === '"' && lineText[afterQuote] === ":") {
        pushSpan(i, end, "cm-syn-attr");
      } else {
        pushSpan(i, end, "cm-syn-string");
      }
      i = end;
      continue;
    }

    // 5. HTML / XML 标签 (<div class="...">)
    if ((lang === "html" || lang === "xml" || lang === "svg") && ch === "<") {
      const tagMatch = lineText.slice(i).match(/^<\/?[a-zA-Z0-9\-_]+/);
      if (tagMatch) {
        pushSpan(i, i + tagMatch[0].length, "cm-syn-keyword");
        i += tagMatch[0].length;
        continue;
      }
    }

    // 6. 数字字面量 (整数、浮点数、十六进制、二进制)
    if (/\d/.test(ch)) {
      const numMatch = lineText
        .slice(i)
        .match(/^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?[a-zA-Z0-9_]*)/);
      if (numMatch) {
        pushSpan(i, i + numMatch[0].length, "cm-syn-number");
        i += numMatch[0].length;
        continue;
      }
    }

    // 7. 标识符、关键字、类型、宏与函数调用
    if (/[a-zA-Z_$]/.test(ch)) {
      let end = i + 1;
      while (end < len && /[a-zA-Z0-9_$]/.test(lineText[end])) end++;
      const word = lineText.slice(i, end);

      // Rust 宏调用如 println! / vec! / format!
      if (lineText[end] === "!") {
        pushSpan(i, end + 1, "cm-syn-function");
        i = end + 1;
        continue;
      }

      const lowerWord = isSqlLang(lang) ? word.toLowerCase() : word;
      if (COMMON_KEYWORDS.has(lowerWord)) {
        pushSpan(i, end, "cm-syn-keyword");
      } else if (COMMON_TYPES_AND_CONSTS.has(word) || /^[A-Z][A-Za-z0-9_]*$/.test(word)) {
        pushSpan(i, end, "cm-syn-type");
      } else {
        let lookahead = end;
        while (lookahead < len && lineText[lookahead] === " ") lookahead++;
        if (lineText[lookahead] === "(") {
          pushSpan(i, end, "cm-syn-function");
        }
      }

      i = end;
      continue;
    }

    i++;
  }

  return spans;
}

function escapeHtmlBasic(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * 将多行代码块渲染为带语法高亮与行号的 HTML（供导出 HTML 与无损打印 PDF 使用）
 */
export function highlightCodeBlockToHtml(code: string, lang: string, showLineNumbers = true): string {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  const renderedLines = lines.map((lineText, idx) => {
    const spans = tokenizeCodeLine(lineText, lang);
    let html = "";
    let cursor = 0;
    for (const sp of spans) {
      if (sp.from > cursor) {
        html += escapeHtmlBasic(lineText.slice(cursor, sp.from));
      }
      html += `<span class="${sp.cls}">${escapeHtmlBasic(lineText.slice(sp.from, sp.to))}</span>`;
      cursor = sp.to;
    }
    if (cursor < lineText.length) {
      html += escapeHtmlBasic(lineText.slice(cursor));
    }
    const lineNumAttr = showLineNumbers ? ` data-code-line="${idx + 1}"` : "";
    return `<div class="exported-code-line"${lineNumAttr}>${html || " "}</div>`;
  });
  return renderedLines.join("");
}
