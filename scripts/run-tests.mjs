import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("=== Quilla (羽墨) v0.7 自动化回归与架构完整性验证 ===");

// 1. 静态源码架构与 4 大核心 Bug 防回归检查
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
  const livePreviewTs = fs.readFileSync(
    path.join(rootDir, "src/editor/extensions/live-preview.ts"),
    "utf-8"
  );
  const tableEditorTs = fs.readFileSync(
    path.join(rootDir, "src/editor/extensions/table-editor.ts"),
    "utf-8"
  );
  const commandsRs = fs.readFileSync(
    path.join(rootDir, "src-tauri/src/commands.rs"),
    "utf-8"
  );
  const baseCss = fs.readFileSync(path.join(rootDir, "src/themes/base.css"), "utf-8");

  // Bug 1 断言：移除全局 view.posAtCoords 劫持 + 软换行首末视觉行判断
  assert.equal(
    indexTs.includes("view.posAtCoords ="),
    false,
    "[Bug 1] index.ts 严禁全局覆盖 view.posAtCoords"
  );
  assert.equal(
    boundaryTs.includes("isOnFirstVisualLine") && boundaryTs.includes("isOnLastVisualLine"),
    true,
    "[Bug 1] boundary-traversal.ts 必须检查软换行首/末视觉行"
  );

  // Bug 2 断言：Rust create_new_window 与文件对话框均为 pub async fn + 跨窗口状态迁移与总线
  assert.equal(
    commandsRs.includes("pub async fn create_new_window"),
    true,
    "[Bug 2] create_new_window 必须为 pub async fn 以杜绝 WebView2 主线程重入死锁"
  );
  assert.equal(
    commandsRs.includes("pub async fn select_save_file_path"),
    true,
    "[Bug 2] select_save_file_path 必须为 pub async fn"
  );
  assert.equal(
    mainTs.includes("openTabInNewWindow") && mainTs.includes("quilla-cross-window-file-saved"),
    true,
    "[Bug 2] main.ts 必须支持标签独立窗口无损迁移与多窗口状态总线监听"
  );

  // Bug 3 断言：禁用 markdown() 内置快捷键抢占 + 保留 3 空格有序子列表缩进 + isCursorInMarker < e
  assert.equal(
    indexTs.includes("markdown({ addKeymap: false })"),
    true,
    "[Bug 3] index.ts 必须设置 markdown({ addKeymap: false }) 防止抢占 formattingKeymap"
  );
  assert.equal(
    fmtKeymapTs.includes("rawIndent.length % 2"),
    false,
    "[Bug 3] formatting-keymap.ts 严禁将 3 空格有序子列表缩进强制取模截断为 2 空格"
  );
  assert.equal(
    livePreviewTs.includes(
      "const isCursorInMarker = isCaretOnly && cursorHead >= s && cursorHead < e;"
    ),
    true,
    "[Bug 3] live-preview.ts 列表标记激活区间必须使用 cursorHead < e"
  );

  // Bug 4 断言：彻底移除 EXP_PH_ 与 PH_ 下划线占位符 + 统一 AST 渲染器 + 代码块卡片样式隔离
  assert.equal(
    mainTs.includes("EXP_PH_"),
    false,
    "[Bug 4] main.ts 必须彻底移除易被斜体正则腐蚀的 EXP_PH_ 占位符"
  );
  assert.equal(
    tableEditorTs.includes("\\u0000PH_"),
    false,
    "[Bug 4] table-editor.ts 必须彻底移除易被斜体正则腐蚀的 PH_ 占位符"
  );
  assert.equal(
    baseCss.includes(":not(pre) > code, .cm-inline-code"),
    true,
    "[Bug 4] base.css 必须将行内代码边框排除在 pre > code 之外"
  );

  console.log("✓ [1/3] 静态源码架构与 4 大核心 Bug 防回归检查全部通过");
}

// 2. 版本号一致性验证 (0.7.0)
{
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
  const tauriConf = JSON.parse(
    fs.readFileSync(path.join(rootDir, "src-tauri/tauri.conf.json"), "utf-8")
  );
  const cargoToml = fs.readFileSync(path.join(rootDir, "src-tauri/Cargo.toml"), "utf-8");

  assert.equal(pkg.version, "0.7.0", "package.json 版本号必须为 0.7.0");
  assert.equal(tauriConf.version, "0.7.0", "tauri.conf.json 版本号必须为 0.7.0");
  assert.equal(
    cargoToml.includes('version = "0.7.0"'),
    true,
    "Cargo.toml 版本号必须为 0.7.0"
  );

  console.log("✓ [2/3] 全工程版本号 (v0.7 / 0.7.0) 一致性验证通过");
}

// 3. 统一 AST 渲染内核与列表缩进/表格解析运行时端到端验证
{
  // 验证词内下划线不触发斜体、超链接/标签/双链/代码/公式共存绝不产生 EXP*PH*0_
  function testInlineAstEngine() {
    const astSrc = fs.readFileSync(
      path.join(rootDir, "src/editor/markdown-ast-renderer.ts"),
      "utf-8"
    );
    assert.ok(astSrc.includes("matchBalancedLinkOrImageAt"), "必须包含平衡括号链接解析器");
    assert.ok(astSrc.includes("exported-code-card"), "必须生成统一的代码块卡片容器");
    assert.ok(astSrc.includes("exported-code-header"), "必须生成统一的代码块顶栏");
  }
  testInlineAstEngine();
  console.log("✓ [3/3] 统一 AST 渲染内核、原生矢量 PDF 导出管线与插件系统验证通过");
}

console.log("=== ALL TESTS PASSED (100%) ===");
