use crate::buffer::{DocumentBuffer, HeadingItem, TextDelta};
use crate::safe_io::{DraftSnapshotRecord, HistorySnapshotRecord, SafeIO};
use crate::search::{
    BacklinkOverview, KnowledgeGraphData, SearchEngine, SearchMatch, TagSummary, WorkspaceIndex,
};
use crate::watcher::WorkspaceWatcher;
use base64::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct AppState {
    pub current_workspace: Mutex<Option<String>>,
    pub window_workspaces: Mutex<HashMap<String, String>>,
    pub initial_file: Mutex<Option<String>>,
    pub is_new_window: Mutex<bool>,
    pub document_buffers: Mutex<HashMap<String, DocumentBuffer>>,
    pub workspace_watcher: WorkspaceWatcher,
    pub workspace_index: WorkspaceIndex,
    pub force_closing_windows: Mutex<HashSet<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub modified_ms: u64,
    pub children: Option<Vec<FileItem>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrphanCleanupResult {
    #[serde(rename = "removedCount")]
    pub removed_count: usize,
    #[serde(rename = "freedBytes")]
    pub freed_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileAssociationStatus {
    #[serde(rename = "isRegisteredProgid")]
    pub is_registered_progid: bool,
    #[serde(rename = "isDefaultMd")]
    pub is_default_md: bool,
    #[serde(rename = "currentProgid")]
    pub current_progid: String,
    #[serde(rename = "hasContextMenu")]
    pub has_context_menu: bool,
    #[serde(rename = "associatedExtensions")]
    pub associated_extensions: Vec<String>,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageBedConfig {
    pub provider: String, // "picgo" | "github" | "custom"
    #[serde(default)]
    pub picgo_url: String,
    #[serde(default)]
    pub github_repo: String, // e.g. "username/repo"
    #[serde(default)]
    pub github_branch: String, // e.g. "main"
    #[serde(default)]
    pub github_token: String,
    #[serde(default)]
    pub github_path: String, // e.g. "images"
    #[serde(default)]
    pub github_custom_domain: String, // e.g. "https://fastly.jsdelivr.net/gh/username/repo@main"
    #[serde(default)]
    pub custom_upload_url: String,
    #[serde(default)]
    pub custom_auth_header: String,
}

fn resolve_window_workspace(window: &tauri::Window, state: &AppState) -> Option<String> {
    let win_root = state
        .window_workspaces
        .lock()
        .ok()
        .and_then(|m| m.get(window.label()).cloned());
    if win_root.is_some() {
        return win_root;
    }
    state
        .current_workspace
        .lock()
        .ok()
        .and_then(|ws| ws.clone())
}

#[tauri::command]
pub fn save_file_content(
    path: String,
    content: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.workspace_watcher.mark_self_save();
    SafeIO::atomic_write(&path, &content).map_err(|e| format!("写入失败: {}", e))?;
    state.workspace_watcher.mark_self_save();

    // O(1) 增量更新内存倒排索引（无需重扫磁盘）
    state
        .workspace_index
        .update_single_file(Path::new(&path), Some(&content));

    // 自动记录本地时间机器 (Time Machine) 版本历史快照
    let _ = SafeIO::save_file_history_snapshot(&path, &content, Some("保存文档".to_string()));

    if let Ok(mut map) = state.document_buffers.lock() {
        let key = format!("{}::{}", window.label(), path.replace('\\', "/").to_lowercase());
        let buf = map.entry(key).or_default();
        buf.set_text(&content);
        buf.mark_clean();
    }

    #[derive(Serialize, Clone)]
    struct CrossWindowSavePayload {
        path: String,
        #[serde(rename = "sourceWindow")]
        source_window: String,
    }
    let _ = window.app_handle().emit(
        "quilla-cross-window-file-saved",
        CrossWindowSavePayload {
            path,
            source_window: window.label().to_string(),
        },
    );
    Ok(())
}

#[tauri::command]
pub fn save_base64_file(
    path: String,
    base64_data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.workspace_watcher.mark_self_save();
    let clean_b64 = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };
    let bytes = BASE64_STANDARD
        .decode(clean_b64.trim())
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }
    fs::write(p, bytes).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn read_file_content(
    path: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let content = fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;
    if let Ok(mut map) = state.document_buffers.lock() {
        let key = format!("{}::{}", window.label(), path.replace('\\', "/").to_lowercase());
        let buf = map.entry(key).or_default();
        buf.set_text(&content);
        buf.mark_clean();
    }
    Ok(content)
}

#[tauri::command]
pub fn sync_document_buffer(
    content: Option<String>,
    deltas: Option<Vec<TextDelta>>,
    file_id: Option<String>,
    file_path: Option<String>,
    title: Option<String>,
    need_headings: Option<bool>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Vec<HeadingItem>, String> {
    let mut final_content = content.clone().unwrap_or_default();
    let buffer_key = format!(
        "{}::{}",
        window.label(),
        file_path
            .as_deref()
            .or(file_id.as_deref())
            .unwrap_or("active")
            .replace('\\', "/")
            .to_lowercase()
    );

    if let Ok(mut map) = state.document_buffers.lock() {
        let buf = map.entry(buffer_key).or_default();
        if let Some(ref d_list) = deltas {
            if !buf.apply_deltas(d_list) {
                if let Some(ref full_text) = content {
                    buf.set_text(full_text);
                }
            }
            if final_content.is_empty() {
                final_content = buf.get_text();
            }
        } else if let Some(ref full_text) = content {
            buf.set_text(full_text);
        }

        if let Some(ref id) = file_id {
            if id != "memory_only" && !final_content.is_empty() {
                let _ = SafeIO::save_draft_snapshot(id, file_path, &final_content, title);
            }
        }

        if need_headings.unwrap_or(false) {
            return Ok(buf.extract_headings());
        }
    } else if let Some(ref id) = file_id {
        if id != "memory_only" && !final_content.is_empty() {
            let _ = SafeIO::save_draft_snapshot(id, file_path, &final_content, title);
        }
    }

    Ok(Vec::new())
}

#[tauri::command]
pub fn extract_file_headings(
    path: String,
    include_blocks: Option<bool>,
) -> Result<Vec<HeadingItem>, String> {
    let content = fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;
    let buf = DocumentBuffer::new(&content);
    if include_blocks.unwrap_or(true) {
        Ok(buf.extract_headings_and_blocks())
    } else {
        Ok(buf.extract_headings())
    }
}

#[tauri::command]
pub fn read_heading_section(path: String, heading: Option<String>) -> Result<String, String> {
    let content = fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;
    let buf = DocumentBuffer::new(&content);
    Ok(buf.extract_section_by_heading(heading.as_deref()))
}

#[tauri::command]
pub fn list_file_history(path: String) -> Result<Vec<HistorySnapshotRecord>, String> {
    Ok(SafeIO::list_file_history_snapshots(&path))
}

#[tauri::command]
pub fn create_file_history_snapshot(
    path: String,
    content: String,
    label: Option<String>,
) -> Result<(), String> {
    SafeIO::save_file_history_snapshot(&path, &content, label).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_file_history_item(path: String, snapshot_id: String) -> Result<(), String> {
    SafeIO::delete_file_history_snapshot(&path, &snapshot_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn scan_workspace_tags(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Vec<TagSummary>, String> {
    if let Some(root) = resolve_window_workspace(&window, &state) {
        Ok(state.workspace_index.scan_workspace_tags(root))
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn get_workspace_graph(
    center_path: Option<String>,
    active_file_path: Option<String>,
    local_depth: Option<usize>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<KnowledgeGraphData, String> {
    let effective_center = center_path.or(active_file_path);
    let inferred_root = effective_center
        .as_deref()
        .and_then(|p| Path::new(p).parent())
        .map(|p| p.to_string_lossy().to_string());
    if let Some(root) = resolve_window_workspace(&window, &state).or(inferred_root) {
        Ok(state.workspace_index.build_knowledge_graph(
            root,
            effective_center.as_deref(),
            local_depth.unwrap_or(2),
        ))
    } else {
        Ok(KnowledgeGraphData {
            nodes: Vec::new(),
            edges: Vec::new(),
        })
    }
}

#[tauri::command]
pub fn check_is_directory(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
pub fn clear_draft_snapshot(file_id: String) -> Result<(), String> {
    SafeIO::remove_draft_snapshot(&file_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_draft_snapshots() -> Result<Vec<DraftSnapshotRecord>, String> {
    Ok(SafeIO::load_all_draft_snapshots())
}

#[tauri::command]
pub fn close_workspace_watcher(window: tauri::Window, state: State<'_, AppState>) {
    let label = window.label().to_string();
    if let Ok(mut map) = state.window_workspaces.lock() {
        map.remove(&label);
    }
    state.workspace_watcher.unwatch_window(&label);
}

#[tauri::command]
pub fn list_workspace_files(
    root: String,
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<FileItem>, String> {
    let root_path = Path::new(&root);
    if !root_path.exists() || !root_path.is_dir() {
        return Err("无效的工作区目录路径".to_string());
    }

    let label = window.label().to_string();
    if let Ok(mut map) = state.window_workspaces.lock() {
        map.insert(label.clone(), root.clone());
    }
    if let Ok(mut ws) = state.current_workspace.lock() {
        *ws = Some(root.clone());
    }
    state.workspace_watcher.watch_directory(
        &label,
        &root,
        app,
        state.workspace_index.clone(),
    );

    // 后台线程增量预热内存倒排索引（仅重扫 mtime 变化的文件）
    let idx_clone = state.workspace_index.clone();
    let root_clone = root_path.to_path_buf();
    std::thread::spawn(move || {
        let _ = idx_clone.refresh_workspace_incremental(&root_clone);
    });

    const MAX_DEPTH: usize = 8;
    const MAX_ITEMS: usize = 3500;
    static BLACKLIST: &[&str] = &[
        ".git", ".svn", ".hg", "node_modules", "target", "dist", "build", "out",
        "bin", "obj", ".vs", ".idea", ".vscode", "AppData", "Windows", "System32",
        "Library", "vendor", "cache", ".cache", "$RECYCLE.BIN", "System Volume Information",
    ];

    fn is_text_file(path: &Path) -> bool {
        path.extension().map_or(false, |ext| {
            let ext_str = ext.to_string_lossy();
            ext_str.eq_ignore_ascii_case("md")
                || ext_str.eq_ignore_ascii_case("markdown")
                || ext_str.eq_ignore_ascii_case("txt")
        })
    }

    fn get_modified_ms(path: &Path) -> u64 {
        fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn build_tree(dir: &Path, depth: usize, count: &mut usize) -> Vec<FileItem> {
        if depth > MAX_DEPTH || *count >= MAX_ITEMS {
            return Vec::new();
        }

        let mut items = Vec::new();
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if *count >= MAX_ITEMS {
                    break;
                }
                let path = entry.path();
                let file_name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let lower_name = file_name.to_lowercase();

                if file_name.starts_with('.')
                    || lower_name == "assets"
                    || lower_name.ends_with(".assets")
                    || BLACKLIST.iter().any(|&b| file_name.eq_ignore_ascii_case(b))
                {
                    continue;
                }

                let modified_ms = get_modified_ms(&path);

                if path.is_dir() {
                    *count += 1;
                    let children = build_tree(&path, depth + 1, count);
                    items.push(FileItem {
                        name: file_name,
                        path: path.to_string_lossy().to_string(),
                        is_dir: true,
                        modified_ms,
                        children: Some(children),
                    });
                } else if is_text_file(&path) {
                    *count += 1;
                    items.push(FileItem {
                        name: file_name,
                        path: path.to_string_lossy().to_string(),
                        is_dir: false,
                        modified_ms,
                        children: None,
                    });
                }
            }
        }
        items.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        items
    }

    let mut count = 0;
    Ok(build_tree(root_path, 0, &mut count))
}

#[tauri::command]
pub fn search_workspace_content(
    keyword: String,
    case_sensitive: Option<bool>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Vec<SearchMatch>, String> {
    if let Some(root) = resolve_window_workspace(&window, &state) {
        Ok(SearchEngine::search_workspace(
            root,
            &keyword,
            case_sensitive.unwrap_or(false),
        ))
    } else {
        Err("当前未设置工作区目录".to_string())
    }
}

#[tauri::command]
pub fn search_backlinks(
    target_name: String,
    current_file_path: Option<String>,
    current_path: Option<String>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Vec<SearchMatch>, String> {
    let active_path = current_file_path.or(current_path);
    let inferred_root = active_path
        .as_deref()
        .and_then(|p| Path::new(p).parent())
        .map(|p| p.to_string_lossy().to_string());

    if let Some(root) = resolve_window_workspace(&window, &state).or(inferred_root) {
        Ok(state.workspace_index.search_backlinks(
            root,
            &target_name,
            active_path.as_deref(),
        ))
    } else {
        Ok(Vec::new())
    }
}

/// 检索当前文档的「已链接反向引用 (Linked Mentions)」与「未链接提及 (Unlinked Mentions)」
#[tauri::command]
pub fn search_backlinks_overview(
    target_name: String,
    current_file_path: Option<String>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<BacklinkOverview, String> {
    let inferred_root = current_file_path
        .as_deref()
        .and_then(|p| Path::new(p).parent())
        .map(|p| p.to_string_lossy().to_string());

    if let Some(root) = resolve_window_workspace(&window, &state).or(inferred_root) {
        Ok(state.workspace_index.search_backlinks_overview(
            root,
            &target_name,
            current_file_path.as_deref(),
        ))
    } else {
        Ok(BacklinkOverview {
            linked: Vec::new(),
            unlinked: Vec::new(),
        })
    }
}

/// 将某篇文档指定行的“未链接提及”一键转换为 `[[targetName]]` 双向链接并同步索引
#[tauri::command]
pub fn convert_unlinked_mention_to_wikilink(
    file_path: String,
    line: usize,
    target_name: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let p = Path::new(&file_path);
    if !p.exists() {
        return Err("目标笔记文件不存在".to_string());
    }
    let raw = fs::read_to_string(p).map_err(|e| format!("读取文件失败: {}", e))?;
    let mut lines: Vec<String> = raw.lines().map(|s| s.to_string()).collect();
    if line == 0 || line > lines.len() {
        return Err("目标行号超出范围".to_string());
    }

    let line_str = &lines[line - 1];
    let lower_line = line_str.to_lowercase();
    let lower_target = target_name.trim().to_lowercase();
    if lower_target.is_empty() {
        return Err("目标名称为空".to_string());
    }

    if let Some(byte_idx) = lower_line.find(&lower_target) {
        let end_idx = byte_idx + lower_target.len();
        if line_str.is_char_boundary(byte_idx) && line_str.is_char_boundary(end_idx) {
            let mut updated_line = String::with_capacity(line_str.len() + 4);
            updated_line.push_str(&line_str[..byte_idx]);
            updated_line.push_str(&format!("[[{}]]", target_name.trim()));
            updated_line.push_str(&line_str[end_idx..]);
            lines[line - 1] = updated_line;

            let new_content = lines.join("\n");
            state.workspace_watcher.mark_self_save();
            SafeIO::atomic_write(p, &new_content).map_err(|e| format!("写回文件失败: {}", e))?;
            state
                .workspace_index
                .update_single_file(p, Some(&new_content));

            #[derive(Serialize, Clone)]
            struct CrossWindowSavePayload {
                path: String,
                #[serde(rename = "sourceWindow")]
                source_window: String,
            }
            let _ = window.app_handle().emit(
                "quilla-cross-window-file-saved",
                CrossWindowSavePayload {
                    path: file_path,
                    source_window: "backlink-converter".to_string(),
                },
            );
            return Ok(());
        }
    }

    Err("未在该行找到可转换的未链接提及".to_string())
}

#[tauri::command]
pub async fn select_workspace_folder(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let folder = rfd::FileDialog::new()
        .set_title("选择工作区文件夹")
        .pick_folder();

    if let Some(path) = folder {
        let path_str = path.to_string_lossy().to_string();
        let label = window.label().to_string();
        if let Ok(mut map) = state.window_workspaces.lock() {
            map.insert(label.clone(), path_str.clone());
        }
        if let Ok(mut ws) = state.current_workspace.lock() {
            *ws = Some(path_str.clone());
        }
        state.workspace_watcher.watch_directory(
            &label,
            &path_str,
            app,
            state.workspace_index.clone(),
        );
        let idx_clone = state.workspace_index.clone();
        let root_clone = path.clone();
        std::thread::spawn(move || {
            let _ = idx_clone.refresh_workspace_incremental(&root_clone);
        });
        Ok(Some(path_str))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn select_save_file_path(default_name: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new()
        .set_title("保存 Markdown 文档")
        .add_filter("Markdown 文件 (*.md)", &["md", "markdown"])
        .add_filter("文本文档 (*.txt)", &["txt"])
        .add_filter("所有文件 (*.*)", &["*"]);

    if let Some(name) = default_name {
        dialog = dialog.set_file_name(&name);
    }

    let file = dialog.save_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn select_export_html_path(default_name: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new()
        .set_title("导出 HTML 网页")
        .add_filter("HTML 网页 (*.html)", &["html", "htm"])
        .add_filter("所有文件 (*.*)", &["*"]);

    if let Some(name) = default_name {
        dialog = dialog.set_file_name(&name);
    }

    let file = dialog.save_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn select_export_word_path(default_name: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new()
        .set_title("导出为 Word 文档 (.doc)")
        .add_filter("Word 文档 (*.doc)", &["doc"])
        .add_filter("所有文件 (*.*)", &["*"]);

    if let Some(name) = default_name {
        dialog = dialog.set_file_name(&name);
    }

    let file = dialog.save_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn select_export_pdf_path(default_name: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new()
        .set_title("导出为出版级矢量 PDF 文档 (.pdf)")
        .add_filter("PDF 文档 (*.pdf)", &["pdf"])
        .add_filter("所有文件 (*.*)", &["*"]);

    if let Some(name) = default_name {
        dialog = dialog.set_file_name(&name);
    }

    let file = dialog.save_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

/// 出版级原生矢量 PDF 导出管线 (v0.9 增强)：
/// - 支持 `--no-pdf-header-footer` 与 `--print-to-pdf-no-header` 彻底消除浏览器默认页眉页脚
/// - 支持 `--generate-pdf-document-outline` 自动从 H1~H6 标题生成原生 PDF 书签大纲树 (Outline Tree)
/// - 在 Windows 下启用 `CREATE_NO_WINDOW` 静默无黑框渲染
#[tauri::command]
pub async fn export_pdf_document(
    path: String,
    html_content: String,
    page_size: Option<String>,
    generate_outline: Option<bool>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.workspace_watcher.mark_self_save();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let temp_html_path = std::env::temp_dir().join(format!("quilla_pdf_export_{}.html", timestamp));
    fs::write(&temp_html_path, html_content.as_bytes())
        .map_err(|e| format!("写入临时排版文件失败: {}", e))?;

    let target_pdf = PathBuf::from(&path);
    if let Some(parent) = target_pdf.parent() {
        if !parent.exists() {
            let _ = fs::create_dir_all(parent);
        }
    }

    let mut candidate_bins: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        for p in [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ] {
            let pb = PathBuf::from(p);
            if pb.exists() {
                candidate_bins.push(pb);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        for p in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ] {
            let pb = PathBuf::from(p);
            if pb.exists() {
                candidate_bins.push(pb);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for bin_name in [
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome",
            "/usr/bin/microsoft-edge",
        ] {
            let pb = PathBuf::from(bin_name);
            if pb.exists() {
                candidate_bins.push(pb);
            }
        }
    }

    let _page_sz = page_size.unwrap_or_else(|| "A4".to_string());
    let enable_outline = generate_outline.unwrap_or(true);
    let mut last_err = String::from("未检测到系统原生 Chromium/Edge 矢量渲染组件");

    for bin in candidate_bins {
        let mut cmd = std::process::Command::new(&bin);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        cmd.arg("--headless=new")
            .arg("--disable-gpu")
            .arg("--no-sandbox")
            .arg("--no-pdf-header-footer")
            .arg("--print-to-pdf-no-header")
            .arg("--run-all-compositor-stages-before-draw");

        if enable_outline {
            cmd.arg("--generate-pdf-document-outline");
        }

        cmd.arg(format!("--print-to-pdf={}", target_pdf.to_string_lossy()))
            .arg(temp_html_path.to_string_lossy().to_string());

        match cmd.status() {
            Ok(status) if status.success() && target_pdf.exists() => {
                let _ = fs::remove_file(&temp_html_path);
                return Ok(path);
            }
            Ok(status) => {
                last_err = format!("PDF 渲染进程退出码: {}", status);
            }
            Err(e) => {
                last_err = format!("启动 PDF 渲染引擎失败: {}", e);
            }
        }
    }

    let _ = fs::remove_file(&temp_html_path);
    Err(last_err)
}

#[tauri::command]
pub async fn select_save_image_path(default_name: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new()
        .set_title("选择长图卡片保存位置")
        .add_filter("PNG 高清长图 (*.png)", &["png"])
        .add_filter("SVG 矢量卡片 (*.svg)", &["svg"])
        .add_filter("所有文件 (*.*)", &["*"]);

    if let Some(name) = default_name {
        dialog = dialog.set_file_name(&name);
    }

    let file = dialog.save_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn select_open_file_path() -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new()
        .set_title("打开 Markdown 文档")
        .add_filter("Markdown 文件 (*.md)", &["md", "markdown", "txt"])
        .add_filter("所有文件 (*.*)", &["*"])
        .pick_file();

    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

fn resolve_assets_folder_name(
    doc_path: &Option<String>,
    folder_mode: &Option<String>,
    custom_folder: &Option<String>,
) -> String {
    if let Some(mode) = folder_mode {
        if mode == "current_dir" || mode == "." || mode == "./" {
            return ".".to_string();
        }
        if mode == "custom" {
            if let Some(ref cf) = custom_folder {
                let trimmed = cf.trim().trim_matches(|c| c == '/' || c == '\\');
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
        if mode == "filename.assets" {
            if let Some(ref dp) = doc_path {
                if let Some(stem) = Path::new(dp).file_stem().and_then(|s| s.to_str()) {
                    let clean_stem: String = stem
                        .chars()
                        .filter(|&c| c != '/' && c != '\\' && c != ':')
                        .collect();
                    if !clean_stem.is_empty() {
                        return format!("{}.assets", clean_stem);
                    }
                }
            }
        }
    }
    "assets".to_string()
}

fn resolve_base_and_assets_dir(
    doc_path: &Option<String>,
    folder_mode: &Option<String>,
    custom_folder: &Option<String>,
) -> (PathBuf, String, bool) {
    let folder_name = resolve_assets_folder_name(doc_path, folder_mode, custom_folder);
    let custom_path = Path::new(&folder_name);
    if custom_path.is_absolute() {
        return (custom_path.to_path_buf(), folder_name, true);
    }

    let base_dir = if let Some(ref dp) = doc_path {
        Path::new(dp).parent().unwrap_or(Path::new(".")).to_path_buf()
    } else {
        std::env::temp_dir().join("quilla-unsaved")
    };

    if folder_name == "." {
        (base_dir, ".".to_string(), false)
    } else {
        (base_dir.join(&folder_name), folder_name, false)
    }
}

#[tauri::command]
pub fn save_image_asset(
    doc_path: Option<String>,
    filename: String,
    base64_data: String,
    folder_mode: Option<String>,
    custom_folder: Option<String>,
) -> Result<String, String> {
    let clean_base64 = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };

    let bytes = BASE64_STANDARD
        .decode(clean_base64.trim())
        .map_err(|e| format!("Base64 解码失败: {}", e))?;

    let (assets_dir, folder_name, is_abs_custom) =
        resolve_base_and_assets_dir(&doc_path, &folder_mode, &custom_folder);
    if !assets_dir.exists() {
        fs::create_dir_all(&assets_dir).map_err(|e| format!("创建图片目录失败: {}", e))?;
    }

    let safe_filename = Path::new(&filename)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "image.png".to_string());

    let target_file = assets_dir.join(&safe_filename);
    fs::write(&target_file, bytes).map_err(|e| format!("写入图片失败: {}", e))?;

    if is_abs_custom || doc_path.is_none() {
        Ok(target_file.to_string_lossy().replace('\\', "/"))
    } else if folder_name == "." {
        Ok(format!("./{}", safe_filename))
    } else {
        Ok(format!("{}/{}", folder_name, safe_filename))
    }
}

#[tauri::command]
pub fn copy_image_to_assets(
    doc_path: Option<String>,
    source_path: String,
    folder_mode: Option<String>,
    custom_folder: Option<String>,
    naming_mode: Option<String>,
) -> Result<String, String> {
    let src = Path::new(&source_path);
    if !src.exists() {
        return Err("源图片文件不存在".to_string());
    }

    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("png");

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let file_stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");

    let mode = naming_mode.unwrap_or_else(|| "timestamp".to_string());
    let new_filename = if mode == "original" {
        format!("{}.{}", file_stem, ext)
    } else {
        format!("{}-{}.{}", file_stem, timestamp, ext)
    };

    let (assets_dir, folder_name, is_abs_custom) =
        resolve_base_and_assets_dir(&doc_path, &folder_mode, &custom_folder);
    if !assets_dir.exists() {
        fs::create_dir_all(&assets_dir).map_err(|e| format!("创建图片目录失败: {}", e))?;
    }

    let target_file = assets_dir.join(&new_filename);
    if src != target_file {
        fs::copy(src, &target_file).map_err(|e| format!("复制图片失败: {}", e))?;
    }

    if is_abs_custom || doc_path.is_none() {
        Ok(target_file.to_string_lossy().replace('\\', "/"))
    } else if folder_name == "." {
        Ok(format!("./{}", new_filename))
    } else {
        Ok(format!("{}/{}", folder_name, new_filename))
    }
}

/// 将本地或粘贴的图片一键上传至图床 (支持 PicGo Server、GitHub 仓库图床与自定义 HTTP 图床)
#[tauri::command]
pub fn upload_image_to_bed(
    doc_path: Option<String>,
    image_path: Option<String>,
    base64_data: Option<String>,
    filename: Option<String>,
    config: ImageBedConfig,
) -> Result<String, String> {
    // 1. 解析待上传图片的本地物理路径与字节流
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut temp_cleanup_path: Option<PathBuf> = None;

    let resolved_path: PathBuf = if let Some(ref raw_p) = image_path {
        let decoded = urlencoding_decode(raw_p);
        let clean = decoded.trim().trim_start_matches("./");
        let candidate = if Path::new(&decoded).is_absolute() {
            PathBuf::from(&decoded)
        } else if let Some(ref dp) = doc_path {
            Path::new(dp)
                .parent()
                .unwrap_or(Path::new("."))
                .join(clean)
        } else {
            PathBuf::from(clean)
        };
        if !candidate.exists() {
            return Err(format!("待上传的本地图片不存在: {:?}", candidate));
        }
        candidate
    } else if let Some(ref b64) = base64_data {
        let clean_b64 = if let Some(idx) = b64.find(',') {
            &b64[idx + 1..]
        } else {
            b64.as_str()
        };
        let bytes = BASE64_STANDARD
            .decode(clean_b64.trim())
            .map_err(|e| format!("解码图片 Base64 失败: {}", e))?;
        let fname = filename.clone().unwrap_or_else(|| format!("image-{}.png", timestamp));
        let tmp = std::env::temp_dir().join(format!("quilla_upload_{}_{}", timestamp, fname));
        fs::write(&tmp, bytes).map_err(|e| format!("写入临时上传图片失败: {}", e))?;
        temp_cleanup_path = Some(tmp.clone());
        tmp
    } else {
        return Err("未提供待上传的图片路径或数据".to_string());
    };

    let provider = config.provider.trim().to_lowercase();
    let result = match provider.as_str() {
        "picgo" => upload_via_picgo_server(&resolved_path, &config.picgo_url),
        "github" => upload_via_github_api(&resolved_path, &config, timestamp),
        "custom" => upload_via_custom_endpoint(&resolved_path, &config),
        _ => Err(format!("不支持的图床类型: {}", provider)),
    };

    if let Some(tmp) = temp_cleanup_path {
        let _ = fs::remove_file(tmp);
    }

    result
}

/// 通过内置 TCP HTTP 客户端向本地 PicGo Server (默认 http://127.0.0.1:36677/upload) 发送上传请求
fn upload_via_picgo_server(file_path: &Path, endpoint_url: &str) -> Result<String, String> {
    let url = if endpoint_url.trim().is_empty() {
        "http://127.0.0.1:36677/upload"
    } else {
        endpoint_url.trim()
    };

    let without_proto = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .unwrap_or(url);
    let (host_port, req_path) = match without_proto.find('/') {
        Some(idx) => (&without_proto[..idx], &without_proto[idx..]),
        None => (without_proto, "/upload"),
    };
    let addr = if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{}:36677", host_port)
    };

    let payload = serde_json::json!({
        "list": [file_path.to_string_lossy().to_string()]
    })
    .to_string();

    let mut stream = std::net::TcpStream::connect(&addr).map_err(|e| {
        format!(
            "无法连接本地 PicGo 服务 ({})，请确认 PicGo 已启动并开启 Server (端口 36677): {}",
            addr, e
        )
    })?;
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(20)));

    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        req_path,
        host_port,
        payload.len(),
        payload
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("发送 PicGo 请求失败: {}", e))?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| format!("读取 PicGo 响应失败: {}", e))?;

    let body = response
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or(&response)
        .trim();

    if let Ok(json) = serde_json::from_str::<serde_json::Value>(body) {
        if json.get("success").and_then(|v| v.as_bool()) == Some(true) {
            if let Some(first_url) = json
                .get("result")
                .and_then(|r| r.as_array())
                .and_then(|arr| arr.first())
                .and_then(|u| u.as_str())
            {
                return Ok(first_url.to_string());
            }
        }
        let msg = json
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("PicGo 未返回有效图片 URL");
        return Err(format!("PicGo 上传返回错误: {}", msg));
    }

    Err(format!("解析 PicGo 响应失败: {}", body))
}

/// 通过系统原生 curl 调用 GitHub REST API 上传图片至指定仓库并生成 CDN 链接
fn upload_via_github_api(
    file_path: &Path,
    config: &ImageBedConfig,
    timestamp: u128,
) -> Result<String, String> {
    let repo = config.github_repo.trim().trim_matches('/');
    let token = config.github_token.trim();
    if repo.is_empty() || !repo.contains('/') || token.is_empty() {
        return Err("请先在偏好设置中填写完整的 GitHub 仓库名 (owner/repo) 与 Personal Access Token".to_string());
    }
    let branch = if config.github_branch.trim().is_empty() {
        "main"
    } else {
        config.github_branch.trim()
    };
    let folder = config.github_path.trim().trim_matches('/');
    let fname = file_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("image-{}.png", timestamp));
    let remote_path = if folder.is_empty() {
        format!("{}-{}", timestamp, fname)
    } else {
        format!("{}/{}-{}", folder, timestamp, fname)
    };

    let bytes = fs::read(file_path).map_err(|e| format!("读取本地图片失败: {}", e))?;
    let b64_content = BASE64_STANDARD.encode(&bytes);

    let payload = serde_json::json!({
        "message": format!("docs(quilla): upload image {}", fname),
        "content": b64_content,
        "branch": branch
    })
    .to_string();

    let tmp_json = std::env::temp_dir().join(format!("quilla_gh_payload_{}.json", timestamp));
    fs::write(&tmp_json, payload.as_bytes())
        .map_err(|e| format!("创建上传请求体失败: {}", e))?;

    let api_url = format!("https://api.github.com/repos/{}/contents/{}", repo, remote_path);
    let mut cmd = std::process::Command::new("curl");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .args([
            "-sS",
            "-X",
            "PUT",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            &format!("Authorization: Bearer {}", token),
            "-H",
            "User-Agent: Quilla-Markdown-Studio",
            "-d",
            &format!("@{}", tmp_json.to_string_lossy()),
            &api_url,
        ])
        .output();

    let _ = fs::remove_file(&tmp_json);

    let out = output.map_err(|e| format!("调用系统 curl 上传 GitHub 图床失败: {}", e))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
        if json.get("content").is_some() {
            let custom_domain = config.github_custom_domain.trim().trim_end_matches('/');
            if !custom_domain.is_empty() {
                return Ok(format!("{}/{}", custom_domain, remote_path));
            }
            return Ok(format!(
                "https://fastly.jsdelivr.net/gh/{}@{}/{}",
                repo, branch, remote_path
            ));
        }
        if let Some(msg) = json.get("message").and_then(|m| m.as_str()) {
            return Err(format!("GitHub API 错误: {}", msg));
        }
    }

    Err(format!("GitHub 图床响应异常: {}", stdout.chars().take(200).collect::<String>()))
}

/// 通过自定义 HTTP Multipart / Webhook 上传图床
fn upload_via_custom_endpoint(file_path: &Path, config: &ImageBedConfig) -> Result<String, String> {
    let url = config.custom_upload_url.trim();
    if url.is_empty() {
        return Err("请先在偏好设置中配置自定义图床 API 地址".to_string());
    }
    let mut cmd = std::process::Command::new("curl");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.args(["-sS", "-X", "POST"]);
    if !config.custom_auth_header.trim().is_empty() {
        cmd.args(["-H", config.custom_auth_header.trim()]);
    }
    cmd.args([
        "-F",
        &format!("file=@{}", file_path.to_string_lossy()),
        url,
    ]);

    let out = cmd.output().map_err(|e| format!("调用自定义图床失败: {}", e))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
        for key in ["url", "data", "link", "result"] {
            if let Some(u) = json.get(key).and_then(|v| v.as_str()) {
                return Ok(u.to_string());
            }
            if let Some(u) = json
                .get(key)
                .and_then(|v| v.get("url"))
                .and_then(|v| v.as_str())
            {
                return Ok(u.to_string());
            }
        }
    }
    if stdout.starts_with("http://") || stdout.starts_with("https://") {
        return Ok(stdout);
    }
    Err(format!("自定义图床未返回有效 URL: {}", stdout))
}

#[tauri::command]
pub fn read_image_base64(
    doc_path: Option<String>,
    rel_path: String,
) -> Result<String, String> {
    let decoded_rel = urlencoding_decode(&rel_path);
    let clean_rel = decoded_rel.trim().trim_start_matches("./");
    let path = if Path::new(&decoded_rel).is_absolute() {
        Path::new(&decoded_rel).to_path_buf()
    } else {
        let base_dir = if let Some(ref dp) = doc_path {
            Path::new(dp).parent().unwrap_or(Path::new(".")).to_path_buf()
        } else {
            Path::new(".").to_path_buf()
        };
        let direct = base_dir.join(clean_rel);
        if direct.exists() {
            direct
        } else {
            base_dir.join(&decoded_rel)
        }
    };

    if !path.exists() {
        return Err(format!("图片不存在: {:?}", path));
    }

    let bytes = fs::read(&path).map_err(|e| format!("读取图片失败: {}", e))?;
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    };

    let encoded = BASE64_STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

fn urlencoding_decode(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let Ok(hex_str) = std::str::from_utf8(&raw[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                    bytes.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        bytes.push(raw[i]);
        i += 1;
    }
    String::from_utf8_lossy(&bytes).to_string()
}

#[tauri::command]
pub fn read_custom_theme_css(
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut candidates = Vec::new();
    if let Some(root) = resolve_window_workspace(&window, &state) {
        candidates.push(Path::new(&root).join("base.user.css"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("base.user.css"));
            candidates.push(parent.join("themes").join("base.user.css"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("base.user.css"));
        candidates.push(cwd.join("src").join("themes").join("base.user.css"));
    }

    for path in candidates {
        if path.exists() {
            if let Ok(css) = fs::read_to_string(&path) {
                return Ok(css);
            }
        }
    }
    Ok(String::new())
}

#[tauri::command]
pub fn window_minimize(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn window_toggle_maximize(window: tauri::Window) -> Result<bool, String> {
    if let Ok(is_max) = window.is_maximized() {
        if is_max {
            let _ = window.unmaximize();
            return Ok(false);
        } else {
            let _ = window.maximize();
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
pub fn window_is_maximized(window: tauri::Window) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_close(window: tauri::Window, state: State<'_, AppState>) {
    let label = window.label().to_string();
    if let Ok(mut closing) = state.force_closing_windows.lock() {
        closing.insert(label.clone());
    }
    state.workspace_watcher.unwatch_window(&label);
    if let Ok(mut map) = state.window_workspaces.lock() {
        map.remove(&label);
    }
    if let Ok(mut bufs) = state.document_buffers.lock() {
        let prefix = format!("{}::", label);
        bufs.retain(|k, _| !k.starts_with(&prefix) && k != &label);
    }
    let _ = window.close();
}

#[tauri::command]
pub fn window_set_always_on_top(window: tauri::Window, on_top: bool) -> Result<bool, String> {
    window.set_always_on_top(on_top).map_err(|e| e.to_string())?;
    Ok(on_top)
}

#[tauri::command]
pub fn create_file(
    path: String,
    initial_content: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.workspace_watcher.mark_self_save();
    let p = Path::new(&path);
    if p.exists() {
        return Err("同名文件已存在".to_string());
    }
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
        }
    }
    let body = initial_content.unwrap_or_default();
    SafeIO::atomic_write(p, &body).map_err(|e| format!("创建文件失败: {}", e))?;
    state.workspace_index.update_single_file(p, Some(&body));
    Ok(())
}

#[tauri::command]
pub fn create_folder(path: String, state: State<'_, AppState>) -> Result<(), String> {
    state.workspace_watcher.mark_self_save();
    let p = Path::new(&path);
    if p.exists() {
        return Err("同名文件夹已存在".to_string());
    }
    fs::create_dir_all(p).map_err(|e| format!("创建文件夹失败: {}", e))?;
    Ok(())
}

/// 提取 Markdown 文本中引用的本地图片文件名集合（用于重命名/删除时清理或迁移 .assets 资源）
fn extract_referenced_image_filenames(md_content: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    for line in md_content.lines() {
        // 1. 匹配 ![alt](path)
        let bytes = line.as_bytes();
        let mut i = 0;
        while i + 3 < bytes.len() {
            if bytes[i] == b'!' && bytes[i + 1] == b'[' {
                if let Some(mid) = line[i + 2..].find("](") {
                    let url_start = i + 2 + mid + 2;
                    if let Some(close) = line[url_start..].find(')') {
                        let raw_url = line[url_start..url_start + close].trim();
                        let decoded = urlencoding_decode(raw_url);
                        if let Some(fname) = Path::new(&decoded).file_name().and_then(|s| s.to_str())
                        {
                            names.insert(fname.to_lowercase());
                        }
                        i = url_start + close + 1;
                        continue;
                    }
                }
            }
            i += 1;
        }
        // 2. 匹配 <img src="path" />
        let lower_line = line.to_lowercase();
        if let Some(img_idx) = lower_line.find("<img") {
            if let Some(src_idx) = lower_line[img_idx..].find("src=") {
                let rest = &line[img_idx + src_idx + 4..].trim_start();
                if let Some(quote) = rest.chars().next() {
                    if quote == '"' || quote == '\'' {
                        if let Some(end_q) = rest[1..].find(quote) {
                            let raw_url = &rest[1..1 + end_q];
                            let decoded = urlencoding_decode(raw_url);
                            if let Some(fname) =
                                Path::new(&decoded).file_name().and_then(|s| s.to_str())
                            {
                                names.insert(fname.to_lowercase());
                            }
                        }
                    }
                }
            }
        }
    }
    names
}

#[tauri::command]
pub fn rename_path(
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.workspace_watcher.mark_self_save();
    let old_p = Path::new(&old_path);
    let new_p = Path::new(&new_path);
    if !old_p.exists() {
        return Err("源文件或目录不存在".to_string());
    }
    let is_same_case_only = old_path.replace('\\', "/").to_lowercase()
        == new_path.replace('\\', "/").to_lowercase();
    if !is_same_case_only && new_p.exists() {
        return Err("目标名称已存在，无法覆盖".to_string());
    }

    let was_file = old_p.is_file();
    let old_stem = old_p
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());
    let new_stem = new_p
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());
    let same_parent = old_p.parent() == new_p.parent();

    fs::rename(old_p, new_p).map_err(|e| format!("重命名失败: {}", e))?;

    // 若重命名的是 Markdown 文档且同级存在专属 <old_stem>.assets 目录，自动迁移专属资源目录并更新文档内相对路径
    if was_file && same_parent {
        if let (Some(parent), Some(os), Some(ns)) = (old_p.parent(), old_stem, new_stem) {
            if os != ns {
                let old_assets_dir = parent.join(format!("{}.assets", os));
                let new_assets_dir = parent.join(format!("{}.assets", ns));
                if old_assets_dir.exists() && old_assets_dir.is_dir() && !new_assets_dir.exists() {
                    if fs::rename(&old_assets_dir, &new_assets_dir).is_ok() {
                        if let Ok(content) = fs::read_to_string(new_p) {
                            let old_prefix_1 = format!("{}.assets/", os);
                            let new_prefix_1 = format!("{}.assets/", ns);
                            let old_prefix_2 = format!("{}.assets\\", os);
                            let new_prefix_2 = format!("{}.assets\\", ns);
                            if content.contains(&old_prefix_1) || content.contains(&old_prefix_2) {
                                let updated = content
                                    .replace(&old_prefix_1, &new_prefix_1)
                                    .replace(&old_prefix_2, &new_prefix_2);
                                let _ = SafeIO::atomic_write(new_p, &updated);
                            }
                        }
                    }
                }
            }
        }
    }

    state.workspace_index.handle_rename(old_p, new_p);
    Ok(())
}

#[tauri::command]
pub fn delete_path(path: String, state: State<'_, AppState>) -> Result<(), String> {
    state.workspace_watcher.mark_self_save();
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| format!("删除文件夹失败: {}", e))?;
        state.workspace_index.remove_path(p);
    } else {
        // 读取被删除文档引用的本地图片，并在删除文档后自动清理其专属 .assets 文件夹或共享 assets/ 下的孤儿图片
        let parent_dir = p.parent().map(|d| d.to_path_buf());
        let doc_stem = p
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string());
        let referenced_imgs = fs::read_to_string(p)
            .map(|c| extract_referenced_image_filenames(&c))
            .unwrap_or_default();

        fs::remove_file(p).map_err(|e| format!("删除文件失败: {}", e))?;
        state.workspace_index.remove_path(p);

        if let Some(parent) = parent_dir {
            // 1. 若存在专属 <stem>.assets 目录，直接一并清理
            if let Some(stem) = doc_stem {
                let dedicated_assets = parent.join(format!("{}.assets", stem));
                if dedicated_assets.exists() && dedicated_assets.is_dir() {
                    let _ = fs::remove_dir_all(&dedicated_assets);
                }
            }

            // 2. 若被删文档引用了共享 assets/ 下的图片，检查同目录其余 .md 是否仍引用该图片，若无则清理孤儿图片
            if !referenced_imgs.is_empty() {
                let shared_assets = parent.join("assets");
                if shared_assets.exists() && shared_assets.is_dir() {
                    let mut still_used = HashSet::new();
                    if let Ok(entries) = fs::read_dir(&parent) {
                        for entry in entries.flatten() {
                            let ep = entry.path();
                            if ep.is_file() {
                                if let Ok(c) = fs::read_to_string(&ep) {
                                    for name in extract_referenced_image_filenames(&c) {
                                        still_used.insert(name);
                                    }
                                }
                            }
                        }
                    }
                    for img_name in referenced_imgs {
                        if !still_used.contains(&img_name) {
                            let candidate = shared_assets.join(&img_name);
                            if candidate.exists() && candidate.is_file() {
                                let _ = fs::remove_file(&candidate);
                            }
                        }
                    }
                    if let Ok(mut rem) = fs::read_dir(&shared_assets) {
                        if rem.next().is_none() {
                            let _ = fs::remove_dir(&shared_assets);
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// 扫描并清理当前工作区（或当前文档所在目录）下未被任何 Markdown 文档引用的 .assets / assets 孤儿图片
#[tauri::command]
pub fn cleanup_orphan_assets(
    current_file_path: Option<String>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<OrphanCleanupResult, String> {
    let inferred_root = current_file_path
        .as_deref()
        .and_then(|p| Path::new(p).parent())
        .map(|p| p.to_string_lossy().to_string());
    let root_str = resolve_window_workspace(&window, &state)
        .or(inferred_root)
        .ok_or_else(|| "请先打开工作区或保存当前文档后再执行孤儿图片清理".to_string())?;

    let root_path = Path::new(&root_str);
    if !root_path.exists() {
        return Err("目标目录不存在".to_string());
    }

    state.workspace_watcher.mark_self_save();

    let md_files = SearchEngine::collect_markdown_files(root_path);
    let mut all_referenced = HashSet::new();
    for md in &md_files {
        if let Ok(content) = fs::read_to_string(md) {
            for fname in extract_referenced_image_filenames(&content) {
                all_referenced.insert(fname);
            }
        }
    }

    let mut asset_dirs: Vec<PathBuf> = Vec::new();
    fn collect_asset_dirs(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        if depth > 6 {
            return;
        }
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let name = p
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_lowercase();
                    if name == "assets" || name.ends_with(".assets") {
                        out.push(p);
                    } else if !name.starts_with('.') && name != "node_modules" && name != "target" {
                        collect_asset_dirs(&p, depth + 1, out);
                    }
                }
            }
        }
    }
    collect_asset_dirs(root_path, 0, &mut asset_dirs);

    let mut removed_count = 0usize;
    let mut freed_bytes = 0u64;
    static IMG_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];

    for adir in asset_dirs {
        if let Ok(entries) = fs::read_dir(&adir) {
            for entry in entries.flatten() {
                let fp = entry.path();
                if !fp.is_file() {
                    continue;
                }
                let is_img = fp.extension().map_or(false, |ext| {
                    let e = ext.to_string_lossy().to_lowercase();
                    IMG_EXTS.contains(&e.as_str())
                });
                if !is_img {
                    continue;
                }
                let fname = fp
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                if !all_referenced.contains(&fname) {
                    let sz = fs::metadata(&fp).map(|m| m.len()).unwrap_or(0);
                    if fs::remove_file(&fp).is_ok() {
                        removed_count += 1;
                        freed_bytes += sz;
                    }
                }
            }
        }
        if let Ok(mut rem) = fs::read_dir(&adir) {
            if rem.next().is_none() {
                let _ = fs::remove_dir(&adir);
            }
        }
    }

    Ok(OrphanCleanupResult {
        removed_count,
        freed_bytes,
    })
}

/// 实时检测操作系统中 Quilla 的默认打开程序关联状态与右键菜单挂载状态 (v0.9 Typora 同款状态感知)
#[tauri::command]
pub fn get_file_association_status() -> Result<FileAssociationStatus, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let progid_check = Command::new("reg")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["query", r"HKCU\Software\Classes\Quilla.Markdown\shell\open\command"])
            .output();
        let is_registered_progid = progid_check.map(|o| o.status.success()).unwrap_or(false);

        let uc_out = Command::new("reg")
            .creation_flags(CREATE_NO_WINDOW)
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice",
                "/v",
                "ProgId",
            ])
            .output();
        let mut current_progid = String::new();
        if let Ok(out) = uc_out {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                if line.contains("ProgId") {
                    if let Some(val) = line.split_whitespace().last() {
                        current_progid = val.to_string();
                    }
                }
            }
        }
        let is_default_md = current_progid.contains("Quilla")
            || current_progid.to_lowercase().contains("quilla.exe")
            || (current_progid.is_empty() && is_registered_progid);

        let ctx_check = Command::new("reg")
            .creation_flags(CREATE_NO_WINDOW)
            .args([
                "query",
                r"HKCU\Software\Classes\SystemFileAssociations\.md\shell\Quilla",
            ])
            .output();
        let has_context_menu = ctx_check.map(|o| o.status.success()).unwrap_or(false);

        let mut associated_extensions = Vec::new();
        for ext in [".md", ".markdown", ".mdown", ".mkd", ".txt"] {
            let key = format!(r"HKCU\Software\Classes\{}\OpenWithProgids", ext);
            if let Ok(o) = Command::new("reg")
                .creation_flags(CREATE_NO_WINDOW)
                .args(["query", &key, "/v", "Quilla.Markdown"])
                .output()
            {
                if o.status.success() {
                    associated_extensions.push(ext.to_string());
                }
            }
        }

        return Ok(FileAssociationStatus {
            is_registered_progid,
            is_default_md,
            current_progid,
            has_context_menu,
            associated_extensions,
            platform: "windows".to_string(),
        });
    }

    #[cfg(target_os = "macos")]
    {
        return Ok(FileAssociationStatus {
            is_registered_progid: true,
            is_default_md: false,
            current_progid: "app.quilla.editor".to_string(),
            has_context_menu: true,
            associated_extensions: vec![".md".into(), ".markdown".into(), ".mdown".into()],
            platform: "macos".to_string(),
        });
    }

    #[cfg(target_os = "linux")]
    {
        let out = std::process::Command::new("xdg-mime")
            .args(["query", "default", "text/markdown"])
            .output();
        let current = out
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let is_def = current.to_lowercase().contains("quilla");
        return Ok(FileAssociationStatus {
            is_registered_progid: is_def,
            is_default_md: is_def,
            current_progid: current,
            has_context_menu: is_def,
            associated_extensions: vec![".md".into(), ".markdown".into()],
            platform: "linux".to_string(),
        });
    }
}

/// 独立切换 Windows 资源管理器右键菜单「用 Quilla (羽墨) 打开」（100% 免管理员权限立即生效）
#[tauri::command]
pub fn toggle_explorer_context_menu(enabled: bool) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let exe_path =
            std::env::current_exe().map_err(|e| format!("无法获取程序路径: {}", e))?;
        let exe_str = exe_path.to_string_lossy().to_string();
        let open_cmd = format!("\"{}\" \"%1\"", exe_str);
        let open_dir_cmd = format!("\"{}\" \"%V\"", exe_str);
        let icon_val = format!("\"{}\",0", exe_str);

        if enabled {
            for ext in [".md", ".markdown", ".mdown", ".mkd", ".txt"] {
                let shell_key = format!(
                    r"HKCU\Software\Classes\SystemFileAssociations\{}\shell\Quilla",
                    ext
                );
                let cmd_key = format!(r"{}\command", shell_key);
                let _ = Command::new("reg")
                    .creation_flags(CREATE_NO_WINDOW)
                    .args(["add", &shell_key, "/ve", "/d", "用 Quilla (羽墨) 打开", "/f"])
                    .status();
                let _ = Command::new("reg")
                    .creation_flags(CREATE_NO_WINDOW)
                    .args(["add", &shell_key, "/v", "Icon", "/d", &icon_val, "/f"])
                    .status();
                let _ = Command::new("reg")
                    .creation_flags(CREATE_NO_WINDOW)
                    .args(["add", &cmd_key, "/ve", "/d", &open_cmd, "/f"])
                    .status();
            }
            // 支持右键文件夹「用 Quilla 作为工作区打开」
            for dir_key in [
                r"HKCU\Software\Classes\Directory\shell\Quilla",
                r"HKCU\Software\Classes\Directory\Background\shell\Quilla",
            ] {
                let cmd_key = format!(r"{}\command", dir_key);
                let _ = Command::new("reg")
                    .creation_flags(CREATE_NO_WINDOW)
                    .args([
                        "add",
                        dir_key,
                        "/ve",
                        "/d",
                        "用 Quilla (羽墨) 作为工作区打开",
                        "/f",
                    ])
                    .status();
                let _ = Command::new("reg")
                    .creation_flags(CREATE_NO_WINDOW)
                    .args(["add", dir_key, "/v", "Icon", "/d", &icon_val, "/f"])
                    .status();
                let _ = Command::new("reg")
                    .creation_flags(CREATE_NO_WINDOW)
                    .args(["add", &cmd_key, "/ve", "/d", &open_dir_cmd, "/f"])
                    .status();
            }
            return Ok("已添加系统右键菜单「用 Quilla (羽墨) 打开」".to_string());
        } else {
            for ext in [".md", ".markdown", ".mdown", ".mkd", ".txt"] {
                let shell_key = format!(
                    r"HKCU\Software\Classes\SystemFileAssociations\{}\shell\Quilla",
                    ext
                );
                let _ = Command::new("reg")
                    .creation_flags(CREATE_NO_WINDOW)
                    .args(["delete", &shell_key, "/f"])
                    .status();
            }
            for dir_key in [
                r"HKCU\Software\Classes\Directory\shell\Quilla",
                r"HKCU\Software\Classes\Directory\Background\shell\Quilla",
            ] {
                let _ = Command::new("reg")
                    .creation_flags(CREATE_NO_WINDOW)
                    .args(["delete", dir_key, "/f"])
                    .status();
            }
            return Ok("已移除系统右键菜单项".to_string());
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Ok("当前系统已通过桌面环境集成打开方式".to_string())
    }
}

/// 将 Quilla 注册为操作系统默认的 Markdown (.md / .markdown / .mdown / .mkd) 打开程序 (v0.9 Typora 同款重构)
/// - 完整写入 Windows RegisteredApplications + Capabilities\FileAssociations + FriendlyAppName + OpenWithProgids
/// - 支持直接唤起针对 `.md` 的 Windows 原生 `OpenWith.exe` 选择框（用户只需一键勾选“始终”），无需在系统设置大海捞针
#[tauri::command]
pub fn register_default_markdown_app(
    open_system_settings: Option<bool>,
    extensions: Option<Vec<String>>,
    enable_context_menu: Option<bool>,
    open_with_dialog: Option<bool>,
) -> Result<String, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("无法获取当前程序路径: {}", e))?;
    let exe_str = exe_path.to_string_lossy().to_string();
    let target_exts = extensions.unwrap_or_else(|| {
        vec![
            ".md".to_string(),
            ".markdown".to_string(),
            ".mdown".to_string(),
            ".mkd".to_string(),
        ]
    });

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let open_cmd = format!("\"{}\" \"%1\"", exe_str);
        let icon_val = format!("\"{}\",0", exe_str);

        let reg_commands: Vec<Vec<String>> = vec![
            vec![
                "add".into(),
                r"HKCU\Software\Classes\Quilla.Markdown".into(),
                "/ve".into(),
                "/d".into(),
                "Quilla Markdown Document".into(),
                "/f".into(),
            ],
            vec![
                "add".into(),
                r"HKCU\Software\Classes\Quilla.Markdown".into(),
                "/v".into(),
                "FriendlyTypeName".into(),
                "/d".into(),
                "Markdown 文档 (Quilla)".into(),
                "/f".into(),
            ],
            vec![
                "add".into(),
                r"HKCU\Software\Classes\Quilla.Markdown\DefaultIcon".into(),
                "/ve".into(),
                "/d".into(),
                icon_val.clone(),
                "/f".into(),
            ],
            vec![
                "add".into(),
                r"HKCU\Software\Classes\Quilla.Markdown\shell\open".into(),
                "/v".into(),
                "FriendlyAppName".into(),
                "/d".into(),
                "Quilla (羽墨)".into(),
                "/f".into(),
            ],
            vec![
                "add".into(),
                r"HKCU\Software\Classes\Quilla.Markdown\shell\open\command".into(),
                "/ve".into(),
                "/d".into(),
                open_cmd.clone(),
                "/f".into(),
            ],
            vec![
                "add".into(),
                r"HKCU\Software\Classes\Applications\quilla.exe".into(),
                "/v".into(),
                "FriendlyAppName".into(),
                "/d".into(),
                "Quilla (羽墨)".into(),
                "/f".into(),
            ],
            vec![
                "add".into(),
                r"HKCU\Software\Classes\Applications\quilla.exe\DefaultIcon".into(),
                "/ve".into(),
                "/d".into(),
                icon_val.clone(),
                "/f".into(),
            ],
            vec![
                "add".into(),
                r"HKCU\Software\Classes\Applications\quilla.exe\shell\open\command".into(),
                "/ve".into(),
                "/d".into(),
                open_cmd.clone(),
                "/f".into(),
            ],
            // 注册 Windows 10/11 默认应用中心 (RegisteredApplications & Capabilities)
            vec![
                "add".into(),
                r"HKCU\Software\Quilla\Capabilities".into(),
                "/v".into(),
                "ApplicationName".into(),
                "/d".into(),
                "Quilla (羽墨)".into(),
                "/f".into(),
            ],
            vec![
                "add".into(),
                r"HKCU\Software\Quilla\Capabilities".into(),
                "/v".into(),
                "ApplicationDescription".into(),
                "/d".into(),
                "Quilla (羽墨) - 现代化所见即所得 Markdown 编辑器与双链知识库".into(),
                "/f".into(),
            ],
            vec![
                "add".into(),
                r"HKCU\Software\RegisteredApplications".into(),
                "/v".into(),
                "Quilla".into(),
                "/d".into(),
                r"Software\Quilla\Capabilities".into(),
                "/f".into(),
            ],
        ];

        for args in reg_commands {
            let _ = Command::new("reg")
                .args(&args)
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }

        for ext in &target_exts {
            let clean_ext = if ext.starts_with('.') {
                ext.clone()
            } else {
                format!(".{}", ext)
            };
            let ext_key = format!(r"HKCU\Software\Classes\{}", clean_ext);
            let progids_key = format!(r"HKCU\Software\Classes\{}\OpenWithProgids", clean_ext);
            let supported_key =
                r"HKCU\Software\Classes\Applications\quilla.exe\SupportedTypes".to_string();
            let cap_assoc_key = r"HKCU\Software\Quilla\Capabilities\FileAssociations".to_string();

            let _ = Command::new("reg")
                .args(["add", &ext_key, "/ve", "/d", "Quilla.Markdown", "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
            let _ = Command::new("reg")
                .args([
                    "add",
                    &progids_key,
                    "/v",
                    "Quilla.Markdown",
                    "/t",
                    "REG_NONE",
                    "/f",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
            let _ = Command::new("reg")
                .args(["add", &supported_key, "/v", &clean_ext, "/d", "", "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
            let _ = Command::new("reg")
                .args([
                    "add",
                    &cap_assoc_key,
                    "/v",
                    &clean_ext,
                    "/d",
                    "Quilla.Markdown",
                    "/f",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }

        if enable_context_menu.unwrap_or(true) {
            let _ = toggle_explorer_context_menu(true);
        }

        // 通知 Windows Explorer 刷新文件图标与打开方式列表缓存
        let _ = Command::new("ie4uinit.exe")
            .arg("-show")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();

        // Typora 同款体验：优先针对 .md 唤起 Windows 原生「打开方式 (OpenWith.exe)」选择框
        if open_with_dialog.unwrap_or(true) {
            let probe_md = std::env::temp_dir().join("Quilla_Markdown_Association.md");
            if !probe_md.exists() {
                let _ = fs::write(
                    &probe_md,
                    "# Quilla (羽墨)\n请在弹出的窗口中选择「Quilla (羽墨)」并点击「始终」。\n",
                );
            }
            let _ = Command::new("OpenWith.exe")
                .arg(probe_md.to_string_lossy().to_string())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .or_else(|_| {
                    Command::new("rundll32.exe")
                        .args([
                            "shell32.dll,OpenAs_RunDLL",
                            &probe_md.to_string_lossy(),
                        ])
                        .creation_flags(CREATE_NO_WINDOW)
                        .spawn()
                });
        } else if open_system_settings.unwrap_or(false) {
            let _ = Command::new("cmd")
                .args(["/C", "start", "", "ms-settings:defaultapps"])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }

        return Ok(
            "已完成系统注册并唤起 .md 打开方式选择框，请在弹窗中选中「Quilla (羽墨)」并点击「始终」"
                .to_string(),
        );
    }

    #[cfg(target_os = "macos")]
    {
        let _ = (enable_context_menu, open_with_dialog);
        let duti_ok = std::process::Command::new("duti")
            .args(["-s", "app.quilla.editor", "net.daringfireball.markdown", "all"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        for ext in &target_exts {
            let _ = std::process::Command::new("duti")
                .args(["-s", "app.quilla.editor", ext, "all"])
                .status();
        }
        if open_system_settings.unwrap_or(false) {
            let _ = std::process::Command::new("open")
                .arg("-a")
                .arg(&exe_str)
                .spawn();
        }
        if duti_ok {
            return Ok("已通过 LaunchServices 将 Quilla 设为 macOS 默认 Markdown 程序".to_string());
        }
        return Ok(
            "已注册 macOS 文件类型声明 (app.quilla.editor)，可在访达右键 .md 文件「显示简介 -> 打开方式 -> 全部更改」中确认"
                .to_string(),
        );
    }

    #[cfg(target_os = "linux")]
    {
        let _ = (open_system_settings, enable_context_menu, open_with_dialog, target_exts);
        // 自动在 ~/.local/share/applications/ 生成 quilla.desktop，确保 AppImage 与便携版也能 100% 关联成功
        if let Ok(home) = std::env::var("HOME") {
            let apps_dir = Path::new(&home).join(".local/share/applications");
            let _ = fs::create_dir_all(&apps_dir);
            let desktop_file = apps_dir.join("quilla.desktop");
            let desktop_content = format!(
                "[Desktop Entry]\nName=Quilla (羽墨)\nComment=Modern WYSIWYG Markdown Editor\nExec=\"{}\" %U\nTerminal=false\nType=Application\nMimeType=text/markdown;text/x-markdown;text/plain;\nCategories=Office;TextEditor;Utility;\n",
                exe_str
            );
            let _ = fs::write(&desktop_file, desktop_content);
        }
        let _ = std::process::Command::new("xdg-mime")
            .args(["default", "quilla.desktop", "text/markdown"])
            .status();
        let _ = std::process::Command::new("xdg-mime")
            .args(["default", "quilla.desktop", "text/x-markdown"])
            .status();
        return Ok("已生成桌面入口并通过 xdg-mime 将 Quilla 设为默认 Markdown 程序".to_string());
    }
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let normalized = path.replace('/', "\\");
        Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", normalized))
            .spawn()
            .map_err(|e| format!("打开文件资源管理器失败: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("在 Finder 中显示失败: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        let p = Path::new(&path);
        let dir = if p.is_dir() {
            p
        } else {
            p.parent().unwrap_or(Path::new("."))
        };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    reveal_in_explorer(path)
}

#[tauri::command]
pub fn get_cli_open_file(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let mut init = state.initial_file.lock().unwrap();
    Ok(init.take())
}

#[tauri::command]
pub fn is_blank_new_window(state: State<'_, AppState>) -> Result<bool, String> {
    let nw = state.is_new_window.lock().unwrap();
    Ok(*nw)
}

fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for b in input.as_bytes() {
        match *b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b'/'
            | b':' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[tauri::command]
pub async fn create_new_window(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    file_path: Option<String>,
    transfer_id: Option<String>,
) -> Result<String, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let label = format!("window-{}", timestamp);

    // 继承父窗口的工作区配置但保持窗口间独立隔离
    if let Some(parent_ws) = resolve_window_workspace(&window, &state) {
        if let Ok(mut map) = state.window_workspaces.lock() {
            map.insert(label.clone(), parent_ws);
        }
    }

    let url = if let Some(ref tid) = transfer_id {
        let encoded_tid = encode_uri_component(tid);
        tauri::WebviewUrl::App(format!("index.html?transfer={}", encoded_tid).into())
    } else if let Some(ref path) = file_path {
        let normalized = path.replace('\\', "/");
        let encoded = encode_uri_component(&normalized);
        tauri::WebviewUrl::App(format!("index.html?open={}", encoded).into())
    } else {
        tauri::WebviewUrl::App("index.html?new=1".into())
    };

    if tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title("Quilla")
        .inner_size(1080.0, 760.0)
        .min_inner_size(640.0, 480.0)
        .decorations(false)
        .transparent(false)
        .center()
        .build()
        .is_ok()
    {
        return Ok(label);
    }

    if let Ok(current_exe) = std::env::current_exe() {
        let mut cmd = std::process::Command::new(current_exe);
        cmd.arg("--new-window");
        if let Some(ref path) = file_path {
            cmd.arg(path);
        }
        cmd.spawn().map_err(|e| format!("创建新窗口失败: {}", e))?;
    }

    Ok(label)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let target = url.trim();
    if target.is_empty() {
        return Ok(());
    }

    let lower = target.to_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with("ftp://"))
    {
        return Err("仅支持打开 http/https/mailto/ftp 协议链接".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", target])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("打开系统浏览器失败: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {}", e))?;
    }

    Ok(())
}
