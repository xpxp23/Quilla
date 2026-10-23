import assert from "node:assert/strict";
import {
  parseInlineAST,
  renderInlineASTSync,
  renderMarkdownDocumentToHtml,
  parseTableRowCells,
  saveTableColumnWidthRatios,
  getSavedTableColumnWidthRatios,
} from "../src/editor/markdown-ast-renderer";
import {
  extractLineInlineTokens,
  isValidSubOrSupPair,
  isNumericRangeTildeAt,
} from "../src/editor/inline-tokenizer";
import {
  buildSmartMarkdownLink,
  isLikelyUrl,
} from "../src/editor/extensions/inline-boundary-guard";
import { computeLineDiff } from "../src/components/time-machine";

/**
 * Quilla v0.10.0 自动化防回归测试套件 (Regression Test Suite)
 * 覆盖：
 * 1. Bug #4 & 同源表格 Bug：超链接、行内代码、数学公式、双链、#标签、带下划线变量与带括号 Wikipedia URL 导出绝不出现 EXP*PH*0_ 或 PH*0*
 * 2. 代码块导出结构：生成带 .exported-code-card 与 .exported-code-header 的完整卡片结构，支持 4 反引号与 ~~~ 波浪线嵌套围栏
 * 3. 多级列表渲染与 3 空格有序子列表、列表项内嵌套代码块/引用块
 * 4. GFM 表格单元格分割（支持转义竖线 \| 与行内代码内竖线 `a | b`）及列宽比例持久化导出
 * 5. Bug #7 智能网址转超链接：网址自动填入 (url) 链接栏并选中 [链接文字] 名称栏
 * 6. [v0.10.0 Bug 5 & Phase 1.7] 统一内联词法解析器 `inline-tokenizer.ts` 与中文数值区间（1~2周...3~6个月）3 层边界守卫验证
 * 7. [v0.10.0 瓶颈 4] 时间机器 Myers Diff 算法在 >500 行大文档首尾微调时绝不退化为整篇标红/标绿
 */

export async function runAllRegressionTests(): Promise<void> {
  // 1. 验证超链接、#标签、双链、公式、行内代码在含下划线斜体上下文下绝不被腐蚀为 EXP_PH_0_
  {
    const sample =
      "点击访问 [Quilla_Official_Site](https://example.com/a_b_c) 与标签 #效率工具/写作_v08 以及双链 [[核心架构_设计|架构文档]]，还有行内代码 `const MAX_VAL = 1` 与 _斜体文字_。";
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
      exportHtml.includes('<span class="cm-hashtag">#效率工具/写作_v08</span>'),
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
              `<div class="exported-code-line"${
                showLn ? ` data-code-line="${idx + 1}"` : ""
              }>${l}</div>`
          )
          .join(""),
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

  // 4. 验证表格行解析支持转义竖线、行内代码内竖线以及列宽权重比例持久化导出 (Phase 2.1)
  {
    const cells = parseTableRowCells("| `a | b` | 转义 \\| 竖线 | [链接](https://a.com/x_y) |");
    assert.deepEqual(cells, ["`a | b`", "转义 | 竖线", "[链接](https://a.com/x_y)"]);

    saveTableColumnWidthRatios(["模块", "说明", "指标"], [25, 50, 25]);
    const savedRatios = getSavedTableColumnWidthRatios(["模块", "说明", "指标"]);
    assert.deepEqual(savedRatios, [25, 50, 25]);
  }

  // 5. 验证选中网址转超链接自动填入链接栏而非名称栏 (Bug #7)
  {
    assert.equal(isLikelyUrl("https://github.com/quilla"), true);
    assert.equal(isLikelyUrl("www.example.com/docs"), true);
    assert.equal(isLikelyUrl("普通文本标题"), false);

    const fromUrl = buildSmartMarkdownLink("https://github.com/quilla");
    assert.equal(fromUrl.insertStr, "[链接文字](https://github.com/quilla)");
    assert.equal(fromUrl.isUrlInput, true);
    assert.equal(
      fromUrl.insertStr.slice(fromUrl.anchorOffset, fromUrl.headOffset),
      "链接文字",
      "选中网址转超链接时应将网址放入右侧链接栏，并自动选中左侧名称栏供用户输入名称"
    );

    const fromText = buildSmartMarkdownLink("Quilla 官网");
    assert.equal(fromText.insertStr, "[Quilla 官网](https://)");
    assert.equal(fromText.isUrlInput, false);
  }

  // 6. [v0.10.0 Bug 5 & Phase 1.7] 验证统一词法解析器对 `1~2周...3~6个月` 与数学幂运算的边界守卫
  {
    const medicalSample =
      "**下地时间**：由于主承重骨胫骨正常，若未伤及膝关节韧带，术后通常在伤口疼痛缓解后（数天至1~2周内）即可借助拐杖保护性下地部分负重，日常生活自理恢复较快；但剧烈运动需等待植骨逐步愈合（约3~6个月后根据复查X光决定）。";

    const tokens = extractLineInlineTokens(medicalSample, []);
    const subTokens = tokens.filter((t) => t.kind === "sub");
    assert.equal(
      subTokens.length,
      0,
      "编辑器实时预览词法器严禁将 `1~2周...3~6个月` 中间的正文误判为下标"
    );

    const exportedHtml = renderInlineASTSync(parseInlineAST(medicalSample), { mode: "export" });
    assert.equal(
      exportedHtml.includes("<sub>"),
      false,
      "导出 AST 渲染器严禁将 `1~2周...3~6个月` 渲染为 <sub>"
    );
    assert.equal(
      exportedHtml.includes("1~2周内") && exportedHtml.includes("约3~6个月后"),
      true,
      "数值区间连接符应原样保留"
    );

    // 验证同源上标误匹配防护：两个幂运算或行尾 ^block-id
    const mathPowerSample = "计算 2^10 与 2^20 的比值，复杂度 O(n^2) ^algo-block";
    const powerHtml = renderInlineASTSync(parseInlineAST(mathPowerSample), { mode: "export" });
    assert.equal(
      powerHtml.includes("<sup>10 与 2</sup>"),
      false,
      "两个数学幂运算之间严禁跨空格误配对为上标"
    );

    // 验证合法化学式下标 H~2~O 与数学上标 x^2^ 在双端均正常解析
    const validChemSample = "水分子式为 H~2~O，面积公式为 R^2^。";
    const validTokens = extractLineInlineTokens(validChemSample, []);
    assert.equal(validTokens.some((t) => t.kind === "sub"), true, "H~2~O 应正确识别为下标 Token");
    assert.equal(validTokens.some((t) => t.kind === "sup"), true, "R^2^ 应正确识别为上标 Token");
    const validHtml = renderInlineASTSync(parseInlineAST(validChemSample), { mode: "export" });
    assert.equal(validHtml, "水分子式为 H<sub>2</sub>O，面积公式为 R<sup>2</sup>。");
  }

  // 7. [v0.10.0 瓶颈 4] 验证 Myers Diff 在 600 行大文档首尾微调时不退化
  {
    const linesA = Array.from({ length: 600 }, (_, i) => `第 ${i + 1} 行原始正文内容`);
    const linesB = [...linesA];
    linesB[1] = "第 2 行已修改内容";
    linesB[598] = "第 599 行已修改内容";

    const diff = computeLineDiff(linesA.join("\n"), linesB.join("\n"));
    const equalCount = diff.filter((r) => r.type === "equal").length;
    const addCount = diff.filter((r) => r.type === "add").length;
    const delCount = diff.filter((r) => r.type === "del").length;

    assert.equal(equalCount, 598, "600 行文档修改 2 行时应保留 598 行 equal，绝不退化为全篇删除重加");
    assert.equal(addCount, 2);
    assert.equal(delCount, 2);
  }
}
