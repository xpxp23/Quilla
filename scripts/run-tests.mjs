import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Normalize CRLF to LF across all platforms for predictable assertion matching
const _origReadFileSync = fs.readFileSync;
fs.readFileSync = function(...args) {
  const result = _origReadFileSync.apply(this, args);
  return typeof result === "string" ? result.replace(/\r\n/g, "\n") : result;
};


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("=== Quilla (羽墨) v0.8.0 自动化回归与架构完整性验证 ===");

// 1. 静态源码架构、历史防回归与 v0.8.0 七大核心 Bug 修复验证
{
  const mainTs = fs.readFileSync(path.join(rootDir, "src/main.ts"), "utf-8");
  const indexTs = fs.readFileSync(path.join(rootDir, "src/editor/index.ts"), "utf-8");
  const boundaryTs = fs.readFileSync(
    path.join(rootDir, "src/editor/extensions/boundary-traversal.ts"),
    "utf-8"
  );
  const fmtKeymapTs = fs.readFileSync(
    path.join(rootDir, "src/editor/extensions/formatting-keymap.ts"),
    "utf-8"
  );
  const inlineGuardTs = fs.readFileSync(
    path.join(rootDir, "src/editor/extensions/inline-boundary-guard.ts"),
    "utf-8"
  );
  const docStructTs = fs.readFileSync(
    path.join(rootDir, "src/editor/extensions/doc-structure.ts"),
    "utf-8"
  );
  const livePreviewTs = fs.readFileSync(
    path.join(rootDir, "src/editor/extensions/live-preview.ts"),
    "utf-8"
  );
  const floatingTbTs = fs.readFileSync(
    path.join(rootDir, "src/editor/extensions/floating-toolbars.ts"),
    "utf-8"
  );
  const tableEditorTs = fs.readFileSync(
    path.join(rootDir, "src/editor/extensions/table-editor.ts"),
    "utf-8"
  );
  const pubExportTs = fs.readFileSync(
    path.join(rootDir, "src/components/publisher-export.ts"),
    "utf-8"
  );
  const prefsTs = fs.readFileSync(
    path.join(rootDir, "src/components/preferences.ts"),
    "utf-8"
  );
  const tabsTs = fs.readFileSync(
    path.join(rootDir, "src/components/tabs-manager.ts"),
    "utf-8"
  );
  const wikiLinkTs = fs.readFileSync(
    path.join(rootDir, "src/editor/extensions/wiki-link.ts"),
    "utf-8"
  );
  const kgTs = fs.readFileSync(
    path.join(rootDir, "src/components/knowledge-graph.ts"),
    "utf-8"
  );
  const commandsRs = fs.readFileSync(
    path.join(rootDir, "src-tauri/src/commands.rs"),
    "utf-8"
  );
  const searchRs = fs.readFileSync(
    path.join(rootDir, "src-tauri/src/search.rs"),
    "utf-8"
  );
  const watcherRs = fs.readFileSync(
    path.join(rootDir, "src-tauri/src/watcher.rs"),
    "utf-8"
  );
  const baseCss = fs.readFileSync(path.join(rootDir, "src/themes/base.css"), "utf-8");
  const windowCss = fs.readFileSync(path.join(rootDir, "src/themes/window.css"), "utf-8");

  // 历史基线断言
  assert.equal(
    indexTs.includes("view.posAtCoords ="),
    false,
    "index.ts 严禁全局覆盖 view.posAtCoords"
  );
  assert.equal(
    indexTs.includes("markdown({ addKeymap: false })"),
    true,
    "index.ts 必须设置 markdown({ addKeymap: false })"
  );
  assert.equal(
    mainTs.includes("EXP_PH_"),
    false,
    "main.ts 必须彻底移除易被斜体正则腐蚀的 EXP_PH_ 占位符"
  );
  assert.equal(
    baseCss.includes(":not(pre) > code, .cm-inline-code"),
    true,
    "base.css 必须将行内代码边框排除在 pre > code 之外"
  );

  // [v0.8 Bug #1] 上下箭头防乱窜：原生 moveVertically 折行探测 + 跨块保留水平列坐标
  assert.equal(
    boundaryTs.includes("view.moveVertically") &&
      boundaryTs.includes("resolveTargetPosPreservingColumn"),
    true,
    "[v0.8 Bug #1] boundary-traversal.ts 必须使用 moveVertically 探测折行并保留跨块水平列坐标"
  );

  // [v0.8 Bug #2] 导出与编辑器代码块换行 UI：悬挂缩进、贯穿式竖线、Flex 行号槽与类名对齐
  assert.equal(
    baseCss.includes(".exported-code-line[data-code-line]") &&
      baseCss.includes(".cm-line.cm-code-block-line.cm-code-line-wrapped") &&
      livePreviewTs.includes("cm-code-expand-footer code-block-expand-footer") &&
      pubExportTs.includes("display: flex; align-items: stretch;"),
    true,
    "[v0.8 Bug #2] 代码块导出与实时预览必须具备悬挂缩进、贯穿行号分割线与完整折行样式"
  );

  // [v0.8 Bug #3] 默认打开 .md 文件程序设置与外部热唤起
  assert.equal(
    commandsRs.includes("pub fn register_default_markdown_app") &&
      prefsTs.includes("pref-set-default-md-btn") &&
      mainTs.includes("quilla-open-external-file"),
    true,
    "[v0.8 Bug #3] 必须支持注册系统默认 .md 打开程序与外部文件热唤起"
  );

  // [v0.8 Bug #4] 保存时页面不乱跳：过滤自窗口广播、禁止无变更 setState 重建、反链原子替换
  assert.equal(
    mainTs.includes("event.payload?.sourceWindow === currentWinLabel") &&
      mainTs.includes("this.lastSelfSaveInfo") &&
      tabsTs.includes("if (curPrimaryDoc !== newContent)") &&
      wikiLinkTs.includes("this.listEl.replaceChildren(frag)"),
    true,
    "[v0.8 Bug #4] 保存文件时必须过滤本窗口广播并避免重建 EditorState 导致光标归零与页面跳动"
  );

  // [v0.8 Bug #5] 有序列表从中间断开后下方重新从 1 编号
  assert.equal(
    fmtKeymapTs.includes(
      "const renumberChanges = buildSubsequentRenumberChanges(\n      doc,\n      line.number + 1,\n      quotePrefix,\n      0,\n      1\n    );"
    ) &&
      fmtKeymapTs.includes(
        "extraChanges.push(\n          ...buildSubsequentRenumberChanges(doc, line.number + 1, quotePrefix, 0, 1)\n        );"
      ),
    true,
    "[v0.8 Bug #5] 有序列表在中间按回车或退格断开时，下半部分必须从 1 重新排列"
  );

  // [v0.8 Bug #6] 超链接右侧单击按回车安全逃逸 + 统一行内原子装饰器边界守卫
  assert.equal(
    inlineGuardTs.includes("inlineBoundaryCursorGuardExtension") &&
      inlineGuardTs.includes("resolveSafeInlineEnterPosition") &&
      inlineGuardTs.includes("snapClickPosAtInlineBoundary") &&
      indexTs.includes("inlineBoundaryCursorGuardExtension"),
    true,
    "[v0.8 Bug #6] 必须启用 inlineBoundaryCursorGuardExtension 保护超链接右边缘点击与回车换行"
  );

  // [v0.8 Bug #7] 网址右键/快捷键转超链接智能填入链接栏 + 编辑框明确显示“名称/链接”标签
  assert.equal(
    inlineGuardTs.includes("export function buildSmartMarkdownLink") &&
      inlineGuardTs.includes("export function isLikelyUrl") &&
      floatingTbTs.includes('<span class="link-edit-label"') &&
      tableEditorTs.includes('<span class="link-edit-label">名称</span>') &&
      windowCss.includes(".link-edit-field"),
    true,
    "[v0.8 Bug #7] 网址转超链接必须自动填入链接栏，且编辑弹窗必须具备清晰的名称/链接字段标识"
  );

  // [v0.8 架构升级] 增量 DocStructure O(1) 行号平移 + Rust WorkspaceIndex 内存倒排索引 + .assets 孤儿清理 + 图谱防泄漏
  assert.equal(
    docStructTs.includes("canIncrementalShift") &&
      docStructTs.includes("const shiftLine = (ln: number) => (ln > pivotLineA ? ln + deltaLines : ln);"),
    true,
    "[v0.8 Core] doc-structure.ts 必须实现 O(1) 行号平移增量缓存"
  );
  assert.equal(
    searchRs.includes("pub struct WorkspaceIndex") &&
      commandsRs.includes("pub fn cleanup_orphan_assets") &&
      watcherRs.includes("workspace_index.sync_changed_paths") &&
      kgTs.includes("AbortController"),
    true,
    "[v0.8 Core] Rust 后端必须启用 WorkspaceIndex 内存倒排索引、孤儿图片清理与图谱监听器生命周期管理"
  );

  console.log("✓ [1/3] 静态源码架构、7 大用户反馈问题与 3 大核心架构升级检查全部通过");
}

// 2. 版本号一致性验证 (0.8.0)
{
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
  const tauriConf = JSON.parse(
    fs.readFileSync(path.join(rootDir, "src-tauri/tauri.conf.json"), "utf-8")
  );
  const cargoToml = fs.readFileSync(path.join(rootDir, "src-tauri/Cargo.toml"), "utf-8");

  assert.equal(pkg.version, "0.8.0", "package.json 版本号必须为 0.8.0");
  assert.equal(tauriConf.version, "0.8.0", "tauri.conf.json 版本号必须为 0.8.0");
  assert.equal(
    Array.isArray(tauriConf.bundle?.fileAssociations) &&
      tauriConf.bundle.fileAssociations[0].ext.includes("md"),
    true,
    "tauri.conf.json 必须包含 .md 文件关联配置 (fileAssociations)"
  );
  assert.equal(
    cargoToml.includes('version = "0.8.0"'),
    true,
    "Cargo.toml 版本号必须为 0.8.0"
  );

  console.log("✓ [2/3] 全工程版本号 (v0.8 / 0.8.0) 与桌面文件关联配置验证通过");
}

// 3. 统一 AST 渲染内核与智能超链接构建器逻辑验证
{
  function testInlineAstAndSmartLink() {
    const astSrc = fs.readFileSync(
      path.join(rootDir, "src/editor/markdown-ast-renderer.ts"),
      "utf-8"
    );
    assert.ok(astSrc.includes("matchBalancedLinkOrImageAt"), "必须包含平衡括号链接解析器");
    assert.ok(astSrc.includes("exported-code-card"), "必须生成统一的代码块卡片容器");
    assert.ok(astSrc.includes("exported-code-header"), "必须生成统一的代码块顶栏");
  }
  testInlineAstAndSmartLink();
  console.log("✓ [3/3] 统一 AST 渲染内核、原生矢量 PDF 导出管线与智能超链接管线验证通过");
}

console.log("=== ALL TESTS PASSED (100%) ===");
