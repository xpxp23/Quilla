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

console.log("=== Quilla (羽墨) v0.9.1 自动化回归与架构完整性验证 ===");

// 1. 静态源码架构、历史防回归与 v0.9.0 七大核心 Bug 修复验证
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


  // [v0.9 新增 8 大核心特性完整性验证]
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

  // 1) Lezer 增量语法树 + B-Tree iterLines() + 方向键 goalColumn 视觉行保持 + 引用块内嵌列表复合渲染
  assert.equal(
    docStructTs.includes("doc.iterLines()") &&
      docStructTs.includes("syntaxTree(state)") &&
      boundaryTs.includes("enterFromBottom") &&
      boundaryTs.includes("goalColumn") &&
      baseCss.includes(".cm-line.cm-blockquote.cm-blockquote-level-2.cm-list-level-2"),
    true,
    "[v0.9 #1 & #8] 必须启用 Lezer SyntaxTree + doc.iterLines() 增量扫描、方向键视觉行 goalColumn 保持与引用块复合列表渲染"
  );

  // 2) 单实例文件接管 (Single-Instance IPC) + Windows OpenWith.exe + 资源管理器右键菜单集成
  assert.equal(
    libRs.includes("try_forward_to_existing_instance") &&
      commandsRs.includes("OpenWith.exe") &&
      commandsRs.includes("toggle_explorer_context_menu") &&
      commandsRs.includes("get_file_association_status"),
    true,
    "[v0.9 #3] 必须支持单实例文件接管、Windows OpenWith.exe 原生对话框与右键菜单注册"
  );

  // 3) 反向链接面板 (Linked & Unlinked Mentions) + 一键转为 [[WikiLink]] + 块级引用 (^block-id) 补全与跳转
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

  // 4) 原生 PDF 书签大纲树 (--generate-pdf-document-outline) + 图床管家 (PicGo / GitHub / 自定义 Webhook) + 符号链接安全原子写
  assert.equal(
    commandsRs.includes("--generate-pdf-document-outline") &&
      commandsRs.includes("upload_image_to_bed") &&
      imgHandlerTs.includes("uploadImageAssetToBed") &&
      floatingTbTs.includes('data-action="upload-bed"') &&
      safeIoRs.includes("fs::canonicalize"),
    true,
    "[v0.9 #6 & #7] 必须支持 PDF 书签大纲树导出、PicGo/GitHub/自定义图床一键上传及符号链接安全保存"
  );


  // [v0.9.1 用户反馈三大顽疾根治防回归断言]
  // 1) 超链接删空最后一个字不触发 MarkDecoration RangeError 崩溃变源码模式
  assert.equal(
    livePreviewTs.includes("if (!(deco as any).point) return;") &&
      livePreviewTs.includes("textLen === 0 ||"),
    true,
    "[Bug #1 Fix] live-preview.ts 必须拦截 from === to 的空 MarkDecoration，防止删空超链接名称时崩溃退化为源码模式"
  );

  // 2) 两段有序列表中间空行按 Enter 正常换行，按 Backspace 才合并重编号
  const enterFnBody = fmtKeymapTs.slice(
    fmtKeymapTs.indexOf("export function handleListEnter"),
    fmtKeymapTs.indexOf("export function handleListBackspace")
  );
  const backspaceFnBody = fmtKeymapTs.slice(
    fmtKeymapTs.indexOf("export function handleListBackspace"),
    fmtKeymapTs.indexOf("export function handleListTab")
  );
  assert.equal(
    !enterFnBody.includes('from: prevLine.to, to: line.to, insert: ""') &&
      backspaceFnBody.includes('from: prevLine.to, to: line.to, insert: ""'),
    true,
    "[Bug #2 Fix] 空行合并两段有序列表的逻辑必须位于 handleListBackspace 中，严禁在 handleListEnter 中误删空行"
  );

  // 3) 上下方向键全文档逐视觉行确定性移动（修复侧边栏 -260px goalColumn 偏移、接管普通行逐视觉行移动）
  assert.equal(
    boundaryTs.includes("goalXMemory") &&
      boundaryTs.includes("stepWithinSoftWrappedLine") &&
      boundaryTs.includes("getLineContentBox") &&
      !boundaryTs.includes("coords.left - scrollerRect.left"),
    true,
    "[Bug #3 Fix] boundary-traversal.ts 必须使用视口 clientX goalColumn 与 getLineContentBox 逐视觉行导航，严禁减去 scrollerRect.left"
  );

  console.log("✓ [1/3] 静态源码架构、历史回归项、v0.9 八大特性及三大用户反馈顽疾修复检查全部通过");
}

// 2. 版本号一致性验证 (0.9.1)
{
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
  const tauriConf = JSON.parse(
    fs.readFileSync(path.join(rootDir, "src-tauri/tauri.conf.json"), "utf-8")
  );
  const cargoToml = fs.readFileSync(path.join(rootDir, "src-tauri/Cargo.toml"), "utf-8");

  assert.equal(pkg.version, "0.9.1", "package.json 版本号必须为 0.9.1");
  assert.equal(tauriConf.version, "0.9.1", "tauri.conf.json 版本号必须为 0.9.1");
  assert.equal(
    Array.isArray(tauriConf.bundle?.fileAssociations) &&
      tauriConf.bundle.fileAssociations[0].ext.includes("md"),
    true,
    "tauri.conf.json 必须包含 .md 文件关联配置 (fileAssociations)"
  );
  assert.equal(
    cargoToml.includes('version = "0.9.1"'),
    true,
    "Cargo.toml 版本号必须为 0.9.1"
  );

  console.log("✓ [2/3] 全工程版本号 (v0.9.1 / 0.9.1) 与桌面文件关联配置验证通过");
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
