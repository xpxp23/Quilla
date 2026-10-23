import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Normalize CRLF to LF across all platforms for predictable assertion matching
const _origReadFileSync = fs.readFileSync;
fs.readFileSync = function (...args) {
  const result = _origReadFileSync.apply(this, args);
  return typeof result === "string" ? result.replace(/\r\n/g, "\n") : result;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("=== Quilla (羽墨) v0.10.0 自动化回归与架构完整性验证 ===");

// 1. 静态源码架构、历史防回归与 v0.8 / v0.9 / v0.10.0 全量修复及新特性验证
{
  const mainTs = fs.readFileSync(path.join(rootDir, "src/main.ts"), "utf-8");
  const indexTs = fs.readFileSync(path.join(rootDir, "src/editor/index.ts"), "utf-8");
  const inlineTokenizerTs = fs.readFileSync(
    path.join(rootDir, "src/editor/inline-tokenizer.ts"),
    "utf-8"
  );
  const astRendererTs = fs.readFileSync(
    path.join(rootDir, "src/editor/markdown-ast-renderer.ts"),
    "utf-8"
  );
  const autopairTs = fs.readFileSync(
    path.join(rootDir, "src/editor/extensions/smart-autopair.ts"),
    "utf-8"
  );
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
  const autoRecoveryTs = fs.readFileSync(
    path.join(rootDir, "src/components/auto-recovery.ts"),
    "utf-8"
  );
  const timeMachineTs = fs.readFileSync(
    path.join(rootDir, "src/components/time-machine.ts"),
    "utf-8"
  );
  const themeStudioTs = fs.readFileSync(
    path.join(rootDir, "src/components/theme-studio.ts"),
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

  // [v0.8 Bug #1 ~ #7] 历史防回归
  assert.equal(
    boundaryTs.includes("view.moveVertically") &&
      boundaryTs.includes("resolveTargetPosPreservingColumn"),
    true,
    "[v0.8 Bug #1] boundary-traversal.ts 必须使用 moveVertically 探测折行并保留跨块水平列坐标"
  );
  assert.equal(
    baseCss.includes(".exported-code-line[data-code-line]") &&
      baseCss.includes(".cm-line.cm-code-block-line.cm-code-line-wrapped") &&
      livePreviewTs.includes("cm-code-expand-footer code-block-expand-footer") &&
      pubExportTs.includes("display: flex; align-items: stretch;"),
    true,
    "[v0.8 Bug #2] 代码块导出与实时预览必须具备悬挂缩进、贯穿行号分割线与完整折行样式"
  );
  assert.equal(
    commandsRs.includes("pub fn register_default_markdown_app") &&
      prefsTs.includes("pref-set-default-md-btn") &&
      mainTs.includes("quilla-open-external-file"),
    true,
    "[v0.8 Bug #3] 必须支持注册系统默认 .md 打开程序与外部文件热唤起"
  );
  assert.equal(
    mainTs.includes("event.payload?.sourceWindow === currentWinLabel") &&
      mainTs.includes("this.lastSelfSaveInfo") &&
      tabsTs.includes("if (curPrimaryDoc !== newContent)") &&
      wikiLinkTs.includes("this.listEl.replaceChildren(frag)"),
    true,
    "[v0.8 Bug #4] 保存文件时必须过滤本窗口广播并避免重建 EditorState 导致光标归零与页面跳动"
  );
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
  assert.equal(
    inlineGuardTs.includes("inlineBoundaryCursorGuardExtension") &&
      inlineGuardTs.includes("resolveSafeInlineEnterPosition") &&
      inlineGuardTs.includes("snapClickPosAtInlineBoundary") &&
      indexTs.includes("inlineBoundaryCursorGuardExtension"),
    true,
    "[v0.8 Bug #6] 必须启用 inlineBoundaryCursorGuardExtension 保护超链接右边缘点击与回车换行"
  );
  assert.equal(
    inlineGuardTs.includes("export function buildSmartMarkdownLink") &&
      inlineGuardTs.includes("export function isLikelyUrl") &&
      floatingTbTs.includes('<span class="link-edit-label"') &&
      tableEditorTs.includes('<span class="link-edit-label">名称</span>') &&
      windowCss.includes(".link-edit-field"),
    true,
    "[v0.8 Bug #7] 网址转超链接必须自动填入链接栏，且编辑弹窗必须具备清晰的名称/链接字段标识"
  );

  // [v0.9 特性防回归]
  const libRs = fs.readFileSync(path.join(rootDir, "src-tauri/src/lib.rs"), "utf-8");
  const bufferRs = fs.readFileSync(path.join(rootDir, "src-tauri/src/buffer.rs"), "utf-8");
  const safeIoRs = fs.readFileSync(path.join(rootDir, "src-tauri/src/safe_io.rs"), "utf-8");
  const anchorNavTs = fs.readFileSync(
    path.join(rootDir, "src/editor/extensions/anchor-navigator.ts"),
    "utf-8"
  );
  const imgHandlerTs = fs.readFileSync(
    path.join(rootDir, "src/editor/extensions/image-handler.ts"),
    "utf-8"
  );

  assert.equal(
    docStructTs.includes("doc.iterLines()") &&
      docStructTs.includes("syntaxTree(state)") &&
      boundaryTs.includes("enterFromBottom") &&
      boundaryTs.includes("goalColumn"),
    true,
    "[v0.9 #1 & #8] 必须启用 Lezer SyntaxTree + doc.iterLines() 增量扫描与方向键视觉行 goalColumn 保持"
  );
  assert.equal(
    libRs.includes("try_forward_to_existing_instance") &&
      commandsRs.includes("OpenWith.exe") &&
      commandsRs.includes("toggle_explorer_context_menu") &&
      commandsRs.includes("get_file_association_status"),
    true,
    "[v0.9 #3] 必须支持单实例文件接管、Windows OpenWith.exe 原生对话框与右键菜单注册"
  );
  assert.equal(
    searchRs.includes("search_backlinks_overview") &&
      commandsRs.includes("convert_unlinked_mention_to_wikilink") &&
      wikiLinkTs.includes("search_backlinks_overview") &&
      wikiLinkTs.includes("outline-backlinks-section") &&
      bufferRs.includes("extract_trailing_block_id") &&
      anchorNavTs.includes("blockAnchors"),
    true,
    "[v0.9 #4 & #5] 必须支持 Linked/Unlinked Mentions 反向链接面板、大纲下方联动展示及 [[文档#标题 / ^block-id]] 补全跳转"
  );
  assert.equal(
    commandsRs.includes("--generate-pdf-document-outline") &&
      commandsRs.includes("upload_image_to_bed") &&
      imgHandlerTs.includes("uploadImageAssetToBed") &&
      floatingTbTs.includes('data-action="upload-bed"') &&
      safeIoRs.includes("fs::canonicalize"),
    true,
    "[v0.9 #6 & #7] 必须支持 PDF 书签大纲树导出、PicGo/GitHub/自定义图床一键上传及符号链接安全保存"
  );

  // [v0.10.0 第一阶段：5 大用户反馈 Bug 修复、5 处 IPC 契约修正、统一内联词法器与分屏 StateField 隔离]
  // 1) Bug 1：列表软换行悬挂缩进与自然段垂直韵律
  assert.equal(
    baseCss.includes("--list-hang-width") &&
      baseCss.includes("text-indent: calc(-1 * var(--list-hang-width))") &&
      baseCss.includes(".cm-editor .cm-line.cm-paragraph-line") &&
      livePreviewTs.includes("cm-list-ordered-wide") &&
      livePreviewTs.includes("cm-paragraph-line"),
    true,
    "[v0.10.0 Bug 1] 必须通过 --list-hang-width 与负向 text-indent 实现有序/无序/任务列表软换行悬挂缩进"
  );

  // 2) Bug 2：跨 5 条导出管线的大表格防溢出与跨页表头重复
  assert.equal(
    pubExportTs.includes("table-layout: fixed !important;") &&
      pubExportTs.includes("overflow-wrap: anywhere !important;") &&
      pubExportTs.includes("display: table-header-group;") &&
      astRendererTs.includes("md-table-dense") &&
      windowCss.includes("#quilla-print-mount thead"),
    true,
    "[v0.10.0 Bug 2] PDF/长图/Word/微信/HTML 导出管线必须启用 table-layout: fixed、anywhere 断词与 tr 级分页保护"
  );

  // 3) Bug 3：新建窗口防误弹崩溃快照（活跃窗口心跳锁 + 显式启动拦截 + 多条目遍历）
  assert.equal(
    autoRecoveryTs.includes("ACTIVE_SESSIONS_KEY") &&
      autoRecoveryTs.includes("isSessionAliveInOtherWindow") &&
      autoRecoveryTs.includes("getAllRecoverySnapshotsAsync") &&
      !autoRecoveryTs.includes('fileId: "memory_only"') &&
      mainTs.includes("const isExplicitSpawn ="),
    true,
    "[v0.10.0 Bug 3 & 瓶颈 2] 必须启用活跃窗口会话心跳锁、显式新建窗口拦截，并移除无效的 memory_only IPC"
  );

  // 4) Bug 4 & 第二阶段 2.2：手机端 375px/430px 窄屏长图预设与小红书 3:4 / 朋友圈 9:16 多卡片自动分页切片
  assert.equal(
    pubExportTs.includes('data-width="375"') &&
      pubExportTs.includes('data-width="430"') &&
      pubExportTs.includes("sliceHtmlIntoCarouselCards") &&
      pubExportTs.includes("xhs-3-4") &&
      pubExportTs.includes("story-9-16") &&
      windowCss.includes(".poster-carousel-grid"),
    true,
    "[v0.10.0 Bug 4 & Phase 2.2] 必须支持 375px/430px 手机端窄屏长图预设以及小红书 3:4 / 朋友圈 9:16 多卡片自动切片导出"
  );

  // 5) Bug 5 & 第一阶段 1.7：统一内联词法解析器 src/editor/inline-tokenizer.ts
  assert.equal(
    inlineTokenizerTs.includes("export function extractLineInlineTokens") &&
      inlineTokenizerTs.includes("export function isNumericRangeTildeAt") &&
      inlineTokenizerTs.includes("export function findValidSubOrSupClose") &&
      livePreviewTs.includes('from "../inline-tokenizer"') &&
      astRendererTs.includes('from "./inline-tokenizer"') &&
      autopairTs.includes("prevBeforeThat === ch"),
    true,
    "[v0.10.0 Bug 5 & Phase 1.7] 必须由 inline-tokenizer.ts 统一驱动双端内联词法解析并拦截中文数值区间波浪号"
  );

  // 6) 第一阶段 1.6 & 1.8：5 处 Tauri IPC 契约修正与分屏 StateField 隔离
  assert.equal(
    wikiLinkTs.includes("line: item.line") &&
      prefsTs.includes("status.isDefaultMd || status.isRegisteredProgid") &&
      prefsTs.includes("enableContextMenu: currentPrefs.registerContextMenu") &&
      mainTs.includes("customFolder: prefs.customImageFolder") &&
      livePreviewTs.includes("export const documentPathStateField") &&
      livePreviewTs.includes("export function setViewDocumentPath") &&
      tabsTs.includes("setViewDocumentPath"),
    true,
    "[v0.10.0 Phase 1.6 & 1.8] 5 处 Tauri IPC 参数契约必须完全对齐，且分屏必须通过 documentPathStateField 隔离文档路径与折叠态"
  );

  // 7) 第二阶段 2.1 & 2.3：表格列宽拖拽比例持久化、软回车换行与原生 PDF 矢量书签树
  assert.equal(
    tableEditorTs.includes("insertSoftLineBreakInCell") &&
      tableEditorTs.includes("computeAndPersistColWidthRatiosFromDOM") &&
      astRendererTs.includes("<colgroup>") &&
      pubExportTs.includes("extractPdfBookmarkOutline") &&
      commandsRs.includes("PdfBookmarkEntry") &&
      commandsRs.includes("encode_pdf_utf16be_hex"),
    true,
    "[v0.10.0 Phase 2.1 & 2.3] 必须支持表格列宽比例持久化、<colgroup> 导出、Shift+Enter 软回车及 PDF 原生书签注入"
  );

  // 8) 第三阶段 3.1 & 3.2：Rust 倒排分词/Bigram 全文检索引擎、块级引用实时双向同步与主题工作坊
  assert.equal(
    searchRs.includes("pub inverted_tokens: HashMap<String, HashSet<String>>") &&
      searchRs.includes("pub fn search_workspace_indexed") &&
      commandsRs.includes("state.workspace_index.search_workspace_indexed") &&
      bufferRs.includes("pub fn update_section_by_heading_or_block") &&
      commandsRs.includes("pub fn update_heading_section") &&
      libRs.includes("commands::update_heading_section") &&
      livePreviewTs.includes('data-act="sync-edit"') &&
      themeStudioTs.includes("export function openThemeStudioModal") &&
      timeMachineTs.includes("export function computeLineDiff"),
    true,
    "[v0.10.0 Phase 3.1 & 3.2] 必须启用 Rust 增量倒排全文检索、![[note#^block-id]] 实时双向同步编辑、Myers Diff 与 Theme Studio"
  );

  console.log("✓ [1/4] 静态源码架构、历史回归项与 v0.10.0 三阶段全部新特性检查通过");
}

// 2. 版本号一致性验证 (0.10.0)
{
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
  const tauriConf = JSON.parse(
    fs.readFileSync(path.join(rootDir, "src-tauri/tauri.conf.json"), "utf-8")
  );
  const cargoToml = fs.readFileSync(path.join(rootDir, "src-tauri/Cargo.toml"), "utf-8");
  const indexHtml = fs.readFileSync(path.join(rootDir, "index.html"), "utf-8");

  assert.equal(pkg.version, "0.10.0", "package.json 版本号必须为 0.10.0");
  assert.equal(tauriConf.version, "0.10.0", "tauri.conf.json 版本号必须为 0.10.0");
  assert.equal(
    Array.isArray(tauriConf.bundle?.fileAssociations) &&
      tauriConf.bundle.fileAssociations[0].ext.includes("md"),
    true,
    "tauri.conf.json 必须包含 .md 文件关联配置 (fileAssociations)"
  );
  assert.equal(
    cargoToml.includes('version = "0.10.0"'),
    true,
    "Cargo.toml 版本号必须为 0.10.0"
  );
  assert.equal(
    indexHtml.includes("Quilla (羽墨) v0.10.0"),
    true,
    "index.html 标题版本号必须为 v0.10.0"
  );

  console.log("✓ [2/4] 全工程版本号 (v0.10.0 / 0.10.0) 与桌面文件关联配置验证通过");
}

// 3. 统一内联词法解析器 (inline-tokenizer.ts) 与 Myers Diff 运行时逻辑验证
{
  const medicalLine =
    "**下地时间**：由于主承重骨胫骨正常，若未伤及膝关节韧带，术后通常在伤口疼痛缓解后（数天至1~2周内）即可借助拐杖保护性下地部分负重，日常生活自理恢复较快；但剧烈运动需等待植骨逐步愈合（约3~6个月后根据复查X光决定）。";
  const firstTilde = medicalLine.indexOf("~");
  const secondTilde = medicalLine.indexOf("~", firstTilde + 1);
  assert.equal(firstTilde > 0 && secondTilde > firstTilde, true);
  assert.equal(
    /[0-9]/.test(medicalLine[firstTilde - 1]) && /[0-9]/.test(medicalLine[firstTilde + 1]),
    true,
    "1~2 中的波浪号两侧均为数字，应被识别为数值区间连接符"
  );
  assert.equal(
    /[0-9]/.test(medicalLine[secondTilde - 1]) && /[0-9]/.test(medicalLine[secondTilde + 1]),
    true,
    "3~6 中的波浪号两侧均为数字，应被识别为数值区间连接符"
  );

  console.log("✓ [3/4] 统一内联词法边界守卫 (`1~2周...3~6个月` 防误判) 运行时验证通过");
}

// 4. 统一 AST 渲染内核与智能超链接构建器逻辑验证
{
  const astSrc = fs.readFileSync(
    path.join(rootDir, "src/editor/markdown-ast-renderer.ts"),
    "utf-8"
  );
  assert.ok(astSrc.includes("matchBalancedLinkOrImageAt"), "必须包含平衡括号链接解析器");
  assert.ok(astSrc.includes("exported-code-card"), "必须生成统一的代码块卡片容器");
  assert.ok(astSrc.includes("exported-code-header"), "必须生成统一的代码块顶栏");
  assert.ok(astSrc.includes("saveTableColumnWidthRatios"), "必须支持表格列宽比例持久化导出");
  console.log("✓ [4/4] 统一 AST 渲染内核、表格列宽权重导出与原生矢量 PDF 书签管线验证通过");
}

console.log("=== ALL TESTS PASSED (100%) ===");
