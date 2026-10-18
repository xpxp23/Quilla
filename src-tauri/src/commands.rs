use crate::buffer::{DocumentBuffer, HeadingItem, TextDelta};
use crate::safe_io::{DraftSnapshotRecord, HistorySnapshotRecord, SafeIO};
use crate::search::{KnowledgeGraphData, SearchEngine, SearchMatch, TagSummary};
use crate::watcher::WorkspaceWatcher;
use base64::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
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
pub fn extract_file_headings(path: String) -> Result<Vec<HeadingItem>, String> {
    let content = fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;
    let buf = DocumentBuffer::new(&content);
    Ok(buf.extract_headings())
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
        Ok(SearchEngine::scan_workspace_tags(root))
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
        Ok(SearchEngine::build_knowledge_graph(
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
    state
        .workspace_watcher
        .watch_directory(&label, &root, app);

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
        Ok(SearchEngine::search_backlinks(
            root,
            &target_name,
            active_path.as_deref(),
        ))
    } else {
        Ok(Vec::new())
    }
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
        state
            .workspace_watcher
            .watch_directory(&label, &path_str, app);
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

#[tauri::command]
pub async fn export_pdf_document(
    path: String,
    html_content: String,
    page_size: Option<String>,
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
    let mut last_err = String::from("未检测到系统原生 Chromium/Edge 矢量渲染组件");

    for bin in candidate_bins {
        let mut cmd = std::process::Command::new(&bin);
        cmd.arg("--headless=new")
            .arg("--disable-gpu")
            .arg("--no-sandbox")
            .arg("--no-pdf-header-footer")
            .arg("--run-all-compositor-stages-before-draw")
            .arg(format!("--print-to-pdf={}", target_pdf.to_string_lossy()))
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

fn resolve_assets_folder_name(doc_path: &Option<String>, folder_mode: &Option<String>) -> String {
    if let Some(mode) = folder_mode {
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
) -> (PathBuf, String) {
    let folder_name = resolve_assets_folder_name(doc_path, folder_mode);
    let base_dir = if let Some(ref dp) = doc_path {
        Path::new(dp).parent().unwrap_or(Path::new(".")).to_path_buf()
    } else {
        std::env::temp_dir().join("quilla-unsaved")
    };
    (base_dir.join(&folder_name), folder_name)
}

#[tauri::command]
pub fn save_image_asset(
    doc_path: Option<String>,
    filename: String,
    base64_data: String,
    folder_mode: Option<String>,
) -> Result<String, String> {
    let clean_base64 = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };

    let bytes = BASE64_STANDARD
        .decode(clean_base64.trim())
        .map_err(|e| format!("Base64 解码失败: {}", e))?;

    let (assets_dir, folder_name) = resolve_base_and_assets_dir(&doc_path, &folder_mode);
    if !assets_dir.exists() {
        fs::create_dir_all(&assets_dir).map_err(|e| format!("创建图片目录失败: {}", e))?;
    }

    let safe_filename = Path::new(&filename)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "image.png".to_string());

    let target_file = assets_dir.join(&safe_filename);
    fs::write(&target_file, bytes).map_err(|e| format!("写入图片失败: {}", e))?;

    if doc_path.is_some() {
        Ok(format!("{}/{}", folder_name, safe_filename))
    } else {
        Ok(target_file.to_string_lossy().replace('\\', "/"))
    }
}

#[tauri::command]
pub fn copy_image_to_assets(
    doc_path: Option<String>,
    source_path: String,
    folder_mode: Option<String>,
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

    let new_filename = format!("{}-{}.{}", file_stem, timestamp, ext);

    let (assets_dir, folder_name) = resolve_base_and_assets_dir(&doc_path, &folder_mode);
    if !assets_dir.exists() {
        fs::create_dir_all(&assets_dir).map_err(|e| format!("创建图片目录失败: {}", e))?;
    }

    let target_file = assets_dir.join(&new_filename);
    fs::copy(src, &target_file).map_err(|e| format!("复制图片失败: {}", e))?;

    if doc_path.is_some() {
        Ok(format!("{}/{}", folder_name, new_filename))
    } else {
        Ok(target_file.to_string_lossy().replace('\\', "/"))
    }
}

#[tauri::command]
pub fn read_image_base64(
    doc_path: Option<String>,
    rel_path: String,
) -> Result<String, String> {
    let decoded_rel = urlencoding_decode(&rel_path);
    let path = if Path::new(&decoded_rel).is_absolute() {
        Path::new(&decoded_rel).to_path_buf()
    } else {
        let base_dir = if let Some(ref dp) = doc_path {
            Path::new(dp).parent().unwrap_or(Path::new(".")).to_path_buf()
        } else {
            Path::new(".").to_path_buf()
        };
        base_dir.join(&decoded_rel)
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
    fs::rename(old_p, new_p).map_err(|e| format!("重命名失败: {}", e))?;
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
    } else {
        fs::remove_file(p).map_err(|e| format!("删除文件失败: {}", e))?;
    }
    Ok(())
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
        if let Some(ref path) = file_path {
            cmd.arg(path);
        } else {
            cmd.arg("--new-window");
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
