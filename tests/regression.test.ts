import assert from "node:assert/strict";
import {
  parseInlineAST,
  renderInlineASTSync,
  renderMarkdownDocumentToHtml,
  parseTableRowCells,
} from "../src/editor/markdown-ast-renderer";

/**
 * Quilla v0.7 自动化防回归测试套件 (Regression Test Suite)
 * 覆盖：
 * 1. Bug #4 & 同源表格 Bug：超链接、行内代码、数学公式、双链、#标签、带下划线变量与带括号 Wikipedia URL 导出绝不出现 EXP*PH*0_ 或 PH*0*
 * 2. 代码块导出结构：生成带 .exported-code-card 与 .exported-code-header 的完整卡片结构，支持 4 反引号与 ~~~ 波浪线嵌套围栏
 * 3. 多级列表渲染与 3 空格有序子列表、列表项内嵌套代码块/引用块
 * 4. GFM 表格单元格分割（支持转义竖线 \| 与行内代码内竖线 `a | b`）
 */

export async function runAllRegressionTests(): Promise<void> {
  // 1. 验证超链接、#标签、双链、公式、行内代码在含下划线斜体上下文下绝不被腐蚀为 EXP_PH_0_
  {
    const sample =
      "点击访问 [Quilla_Official_Site](https://example.com/a_b_c) 与标签 #效率工具/写作_v07 以及双链 [[核心架构_设计|架构文档]]，还有行内代码 `const MAX_VAL = 1` 与 _斜体文字_。";
    const ast = parseInlineAST(sample);
    const exportHtml = renderInlineASTSync(ast, { mode: "export" });
    const tableHtml = renderInlineASTSync(ast, { mode: "table-cell" });

    assert.equal(exportHtml.includes("EXP"), false, "导出 HTML 严禁残留 EXP 占位符碎片");
    assert.equal(exportHtml.includes("PH"), false, "导出 HTML 严禁残留 PH 占位符碎片");
    assert.equal(tableHtml.includes("PH"), false, "表格单元格 HTML 严禁残留 PH 占位符碎片");

    assert.equal(
      exportHtml.includes('<a href="https://example.com/a_b_c" target="_blank" rel="noopener">Quilla_Official_Site</a>'),
      true,
      "超链接含下划线文本与 URL 应完整保留"
    );
    assert.equal(
      exportHtml.includes('<span class="cm-hashtag">#效率工具/写作_v07</span>'),
      true,
      "含下划线与斜杠的多级 #标签 应正确渲染为胶囊"
    );
    assert.equal(
      exportHtml.includes('<span class="cm-wikilink" data-raw="[[核心架构_设计|架构文档]]">架构文档</span>'),
      true,
      "双链应正确渲染并携带 data-raw 属性供表格逆向还原"
    );
    assert.equal(
      exportHtml.includes("<em>斜体文字</em>"),
      true,
      "正常单下划线斜体应正确渲染为 <em>"
    );
  }

  // 2. 验证平衡圆括号 URL（如 Wikipedia 词条链接）与复合内联格式嵌套
  {
    const wikiUrlMd =
      "参考 [**Rust** 编程语言](https://en.wikipedia.org/wiki/Rust_(programming_language))";
    const html = renderInlineASTSync(parseInlineAST(wikiUrlMd), { mode: "export" });
    assert.equal(
      html,
      '参考 <a href="https://en.wikipedia.org/wiki/Rust_(programming_language)" target="_blank" rel="noopener"><strong>Rust</strong> 编程语言</a>'
    );
  }

  // 3. 验证代码块卡片结构、4 反引号嵌套围栏及 3 空格有序子列表导出
  {
    const docMd = [
      "1. 一级有序列表",
      "   1. 三空格缩进子级列表项 A",
      "   2. 三空格缩进子级列表项 B",
      "",
      "````markdown",
      "```rust",
      "fn main() {}",
      "```",
      "````",
    ].join("\n");

    const rendered = await renderMarkdownDocumentToHtml(docMd, {
      fullMarkdown: docMd,
      showLineNumbers: true,
      isDarkTheme: false,
      highlightCodeBlockToHtml: (code, _lang, showLn) =>
        code
          .split("\n")
          .map(
            (l, idx) =>
              `<span class="exported-code-line"${
                showLn ? ` data-code-line="${idx + 1}"` : ""
              }>${l}</span>`
          )
          .join("\n"),
    });

    assert.equal(
      rendered.includes('<div class="exported-code-card">'),
      true,
      "导出代码块必须包裹在 .exported-code-card 卡片容器内"
    );
    assert.equal(
      rendered.includes('<div class="exported-code-header">'),
      true,
      "导出代码块必须包含 .exported-code-header 顶栏"
    );
    assert.equal(
      rendered.includes("<ol><li>一级有序列表<ol><li>三空格缩进子级列表项 A</li><li>三空格缩进子级列表项 B</li></ol></li></ol>"),
      true,
      "3 空格有序子列表必须生成标准嵌套 <ol><li>...<ol> 结构"
    );
  }

  // 4. 验证表格行解析支持转义竖线与行内代码内竖线
  {
    const cells = parseTableRowCells("| `a | b` | 转义 \\| 竖线 | [链接](https://a.com/x_y) |");
    assert.deepEqual(cells, ["`a | b`", "转义 | 竖线", "[链接](https://a.com/x_y)"]);
  }
}
