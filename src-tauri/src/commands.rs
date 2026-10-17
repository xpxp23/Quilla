use crate::buffer::{DocumentBuffer, HeadingItem};
use crate::safe_io::{DraftSnapshotRecord, SafeIO};
use crate::search::{SearchEngine, SearchMatch};
use crate::watcher::WorkspaceWatcher;
use base64::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

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
    if let Ok(mut map) = state.document_buffers.lock() {
        let buf = map.entry(window.label().to_string()).or_default();
        buf.set_text(&content);
        buf.mark_clean();
    }
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
        let buf = map.entry(window.label().to_string()).or_default();
        buf.set_text(&content);
        buf.mark_clean();
    }
    Ok(content)
}

#[tauri::command]
pub fn sync_document_buffer(
    content: String,
    file_id: Option<String>,
    file_path: Option<String>,
    title: Option<String>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Vec<HeadingItem>, String> {
    if let Some(ref id) = file_id {
        let _ = SafeIO::save_draft_snapshot(id, file_path, &content, title);
    }
    if let Ok(mut map) = state.document_buffers.lock() {
        let buf = map.entry(window.label().to_string()).or_default();
        buf.set_text(&content);
        return Ok(buf.extract_headings());
    }
    Ok(Vec::new())
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
    Ok(build_tree(Path::new(&root), 0, &mut count))
}

#[tauri::command]
pub fn search_workspace_content(
    keyword: String,
    case_sensitive: Option<bool>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Vec<SearchMatch>, String> {
    let win_root = state
        .window_workspaces
        .lock()
        .ok()
        .and_then(|m| m.get(window.label()).cloned());

    let fallback_root = state
        .current_workspace
        .lock()
        .ok()
        .and_then(|ws| ws.clone());

    if let Some(root) = win_root.or(fallback_root) {
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
pub fn select_workspace_folder(
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
pub fn select_save_file_path(default_name: Option<String>) -> Result<Option<String>, String> {
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
pub fn select_export_html_path(default_name: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new()
        .set_title("导出为 HTML 文档")
        .add_filter("HTML 网页 (*.html)", &["html", "htm"]);

    if let Some(name) = default_name {
        dialog = dialog.set_file_name(&name);
    }

    let file = dialog.save_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn select_open_file_path() -> Result<Option<String>, String> {
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
    if let Ok(map) = state.window_workspaces.lock() {
        if let Some(root) = map.get(window.label()) {
            candidates.push(Path::new(root).join("base.user.css"));
        }
    }
    if let Ok(ws) = state.current_workspace.lock() {
        if let Some(ref root) = *ws {
            candidates.push(Path::new(root).join("base.user.css"));
        }
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
        bufs.remove(&label);
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
pub fn create_new_window(app: tauri::AppHandle, file_path: Option<String>) -> Result<(), String> {
    if let Ok(current_exe) = std::env::current_exe() {
        let mut cmd = std::process::Command::new(current_exe);
        if let Some(ref path) = file_path {
            cmd.arg(path);
        } else {
            cmd.arg("--new-window");
        }
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let label = format!("window-{}", timestamp);

    let url = if let Some(ref path) = file_path {
        let normalized = path.replace('\\', "/");
        let encoded = encode_uri_component(&normalized);
        tauri::WebviewUrl::App(format!("index.html?open={}", encoded).into())
    } else {
        tauri::WebviewUrl::App("index.html?new=1".into())
    };

    tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title("Quilla")
        .inner_size(1080.0, 760.0)
        .min_inner_size(640.0, 480.0)
        .decorations(false)
        .transparent(false)
        .center()
        .build()
        .map_err(|e| format!("创建新窗口失败: {}", e))?;

    Ok(())
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
