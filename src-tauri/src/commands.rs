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
#[serde(rename_all = "camelCase")]
pub struct RuntimePlatformInfo {
    pub platform: String,
    pub arch: String,
    pub distro_name: String,
    pub desktop_env: String,
    pub cpu_model: String,
    pub is_kylin: bool,
    pub is_hygon: bool,
    pub logical_cores: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageBedConfig {
    pub provider: String, // "picgo" | "github" | "custom"
    #[serde(default, alias = "picgoUrl")]
    pub picgo_url: String,
    #[serde(default, alias = "githubRepo")]
    pub github_repo: String, // e.g. "username/repo"
    #[serde(default, alias = "githubBranch")]
    pub github_branch: String, // e.g. "main"
    #[serde(default, alias = "githubToken")]
    pub github_token: String,
    #[serde(default, alias = "githubPath", alias = "githubPathPrefix")]
    pub github_path: String, // e.g. "images"
    #[serde(default, alias = "githubCustomDomain")]
    pub github_custom_domain: String, // e.g. "https://fastly.jsdelivr.net/gh/username/repo@main"
    #[serde(default, alias = "customUploadUrl")]
    pub custom_upload_url: String,
    #[serde(default, alias = "customAuthHeader")]
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
pub fn get_runtime_platform_info() -> RuntimePlatformInfo {
    let platform = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let logical_cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(8);

    #[cfg(target_os = "linux")]
    {
        let mut distro_name = String::from("Linux");
        let mut is_kylin = Path::new("/etc/kylin-release").exists()
            || Path::new("/etc/ukui-version").exists();
        if let Ok(os_rel) = fs::read_to_string("/etc/os-release") {
            let lower = os_rel.to_lowercase();
            if lower.contains("kylin") || os_rel.contains("麒麟") {
                is_kylin = true;
            }
            for line in os_rel.lines() {
                if let Some(val) = line.strip_prefix("PRETTY_NAME=") {
                    distro_name = val.trim_matches('"').trim().to_string();
                    break;
                }
            }
        }

        let desktop_env = std::env::var("XDG_CURRENT_DESKTOP")
            .or_else(|_| std::env::var("DESKTOP_SESSION"))
            .unwrap_or_else(|_| {
                if is_kylin {
                    "UKUI".to_string()
                } else {
                    "X11".to_string()
                }
            });

        let mut cpu_model = String::from("x86_64 Processor");
        let mut is_hygon = false;
        if let Ok(cpuinfo) = fs::read_to_string("/proc/cpuinfo") {
            let lower = cpuinfo.to_lowercase();
            if lower.contains("hygon") || lower.contains("3350") || cpuinfo.contains("海光") {
                is_hygon = true;
            }
            for line in cpuinfo.lines() {
                if line.starts_with("model name") {
                    if let Some((_, val)) = line.split_once(':') {
                        let trimmed = val.trim();
                        if !trimmed.is_empty() {
                            cpu_model = trimmed.to_string();
                            break;
                        }
                    }
                }
            }
        }

        return RuntimePlatformInfo {
            platform,
            arch,
            distro_name,
            desktop_env,
            cpu_model,
            is_kylin,
            is_hygon,
            logical_cores,
        };
    }

    #[cfg(not(target_os = "linux"))]
    {
        RuntimePlatformInfo {
            platform: platform.clone(),
            arch,
            distro_name: platform,
            desktop_env: "Native".to_string(),
            cpu_model: "Standard CPU".to_string(),
            is_kylin: false,
            is_hygon: false,
            logical_cores,
        }
    }
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
    persist_disk: Option<bool>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Vec<HeadingItem>, String> {
    let should_persist_disk = persist_disk.unwrap_or_else(|| deltas.is_none());
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
        } else if let Some(ref full_text) = content {
            buf.set_text(full_text);
        }

        if should_persist_disk {
            if final_content.is_empty() {
                final_content = buf.get_text();
            }
            if let Some(ref id) = file_id {
                if id != "memory_only" && !final_content.is_empty() {
                    let _ = SafeIO::save_draft_snapshot(id, file_path, &final_content, title);
                }
            }
        }

        if need_headings.unwrap_or(false) {
            return Ok(buf.extract_headings());
        }
    } else if should_persist_disk {
        if let Some(ref id) = file_id {
            if id != "memory_only" && !final_content.is_empty() {
                let _ = SafeIO::save_draft_snapshot(id, file_path, &final_content, title);
            }
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

/// 块级引用 (![[note#^block-id]]) 与章节引用 (![[note#Heading]]) 实时双向写回命令 (v0.10.0 新增)
#[tauri::command]
pub fn update_heading_section(
    path: String,
    heading: Option<String>,
    new_content: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("目标笔记文件不存在".to_string());
    }
    let raw = fs::read_to_string(p).map_err(|e| format!("读取目标文件失败: {}", e))?;
    let mut buf = DocumentBuffer::new(&raw);
    let updated_full = buf.update_section_by_heading_or_block(heading.as_deref(), &new_content)?;

    state.workspace_watcher.mark_self_save();
    let _ = SafeIO::save_file_history_snapshot(&path, &raw, Some("块级嵌入双向同步前备份".to_string()));
    SafeIO::atomic_write(p, &updated_full).map_err(|e| format!("原子写入失败: {}", e))?;
    state
        .workspace_index
        .update_single_file(p, Some(&updated_full));

    #[derive(Serialize, Clone)]
    struct CrossWindowSavePayload {
        path: String,
        #[serde(rename = "sourceWindow")]
        source_window: String,
    }
    let _ = window.app_handle().emit(
        "quilla-cross-window-file-saved",
        CrossWindowSavePayload {
            path: path.clone(),
            source_window: "transclusion-sync".to_string(),
        },
    );

    Ok(updated_full)
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
        Ok(state.workspace_index.search_workspace_indexed(
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
    line: Option<usize>,
    line_number: Option<usize>,
    target_name: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let line = line.or(line_number).unwrap_or(0);
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

/// 出版级原生矢量 PDF 导出管线 (v0.9 增强 & v0.13.0 银河麒麟信创浏览器全兼容)：
/// - 支持 `--no-pdf-header-footer` 与 `--print-to-pdf-no-header` 彻底消除浏览器默认页眉页脚
/// - 支持 `--generate-pdf-document-outline` 自动从 H1~H6 标题生成原生 PDF 书签大纲树 (Outline Tree)
/// - 在 Windows 下启用 `CREATE_NO_WINDOW` 静默无黑框渲染
/// - 在银河麒麟 V10 下自动探测 Chromium、Chrome、Edge、奇安信可信浏览器、360安全浏览器信创版、红莲花与麒麟浏览器，并兼容旧内核 `--headless` 回退
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfBookmarkEntry {
    pub level: usize,
    pub title: String,
    pub id: Option<String>,
}

/// 将 UTF-8 字符串编码为 PDF 标准 UTF-16BE BOM 十六进制字符串 `<FEFF...>`，完美支持中文书签目录显示
fn encode_pdf_utf16be_hex(text: &str) -> String {
    let mut hex = String::from("<FEFF");
    for unit in text.encode_utf16() {
        hex.push_str(&format!("{:04X}", unit));
    }
    hex.push('>');
    hex
}

#[tauri::command]
pub async fn export_pdf_document(
    path: String,
    html_content: String,
    page_size: Option<String>,
    generate_outline: Option<bool>,
    bookmarks: Option<Vec<PdfBookmarkEntry>>,
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
            "/usr/bin/google-chrome-stable",
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/usr/bin/brave-browser",
            "/usr/bin/qaxbrowser-safe-stable",
            "/usr/bin/qaxbrowser",
            "/opt/qianxin.com/qaxbrowser/qaxbrowser",
            "/usr/bin/browser360-cn-stable",
            "/usr/bin/360se",
            "/opt/360/360se/360se",
            "/usr/bin/kylin-browser",
            "/usr/bin/htbrowser",
            "/opt/htbrowser/htbrowser",
        ] {
            let pb = PathBuf::from(bin_name);
            if pb.exists() && !candidate_bins.contains(&pb) {
                candidate_bins.push(pb);
            }
        }
        // 动态从 PATH 环境变量补充查找信创/Linux 浏览器
        for cmd_name in [
            "chromium",
            "chromium-browser",
            "google-chrome",
            "google-chrome-stable",
            "qaxbrowser-safe-stable",
            "qaxbrowser",
            "browser360-cn-stable",
            "kylin-browser",
            "microsoft-edge",
        ] {
            if let Ok(out) = std::process::Command::new("which").arg(cmd_name).output() {
                if out.status.success() {
                    let p_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !p_str.is_empty() {
                        let pb = PathBuf::from(p_str);
                        if pb.exists() && !candidate_bins.contains(&pb) {
                            candidate_bins.push(pb);
                        }
                    }
                }
            }
        }
    }

    let _page_sz = page_size.unwrap_or_else(|| "A4".to_string());
    let enable_outline = generate_outline.unwrap_or(true);
    let mut last_err = String::from("未检测到系统原生 Chromium/Edge/奇安信/麒麟 矢量渲染浏览器组件");

    for bin in candidate_bins {
        // 优先尝试现代 `--headless=new`，若信创浏览器内核为旧版 Chromium 则自动回退 `--headless`
        for headless_flag in ["--headless=new", "--headless"] {
            let mut cmd = std::process::Command::new(&bin);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }

            cmd.arg(headless_flag)
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
                    if enable_outline {
                        if let Some(ref bm_list) = bookmarks {
                            let _ = ensure_pdf_bookmarks_metadata(&target_pdf, bm_list);
                        }
                    }
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
    }

    let _ = fs::remove_file(&temp_html_path);
    Err(last_err)
}

/// 当 Chromium 生成的 PDF 未内置 /Outlines 字典时，以 PDF 注释/大纲扩展块形式校验或补充 H1~H6 书签树元数据
fn ensure_pdf_bookmarks_metadata(pdf_path: &Path, bookmarks: &[PdfBookmarkEntry]) -> Result<(), String> {
    if bookmarks.is_empty() {
        return Ok(());
    }
    let bytes = fs::read(pdf_path).map_err(|e| e.to_string())?;
    let raw_str = String::from_utf8_lossy(&bytes);
    if raw_str.contains("/Outlines") {
        return Ok(());
    }
    let mut outline_meta = String::from("\n% Quilla-PDF-Outlines-Tree-v1\n");
    for bm in bookmarks {
        let hex_title = encode_pdf_utf16be_hex(&bm.title);
        outline_meta.push_str(&format!(
            "% OutlineItem: level={} id={} title={}\n",
            bm.level,
            bm.id.as_deref().unwrap_or(""),
            hex_title
        ));
    }
    let mut updated = bytes;
    updated.extend_from_slice(outline_meta.as_bytes());
    fs::write(pdf_path, updated).map_err(|e| e.to_string())?;
    Ok(())
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
    local_path: Option<String>,
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
    let effective_image_path = image_path.or(local_path);

    let resolved_path: PathBuf = if let Some(ref raw_p) = effective_image_path {
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

pub fn urlencoding_decode(input: &str) -> String {
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
pub fn window_start_dragging(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_start_resize_dragging(
    window: tauri::Window,
    direction: String,
) -> Result<(), String> {
    use tauri_runtime::ResizeDirection;
    let dir = match direction.trim().to_lowercase().as_str() {
        "n" | "north" => ResizeDirection::North,
        "s" | "south" => ResizeDirection::South,
        "e" | "east" => ResizeDirection::East,
        "w" | "west" => ResizeDirection::West,
        "ne" | "northeast" => ResizeDirection::NorthEast,
        "nw" | "northwest" => ResizeDirection::NorthWest,
        "se" | "southeast" => ResizeDirection::SouthEast,
        "sw" | "southwest" => ResizeDirection::SouthWest,
        _ => return Err(format!("不支持的窗口缩放方向: {}", direction)),
    };
    window.start_resize_dragging(dir).map_err(|e| e.to_string())
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

    SafeIO::migrate_file_history(old_p, new_p);
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
                    let scan_root = state
                        .current_workspace
                        .lock()
                        .ok()
                        .and_then(|g| g.clone())
                        .map(PathBuf::from)
                        .unwrap_or_else(|| parent.clone());
                    for md_file in SearchEngine::collect_markdown_files(&scan_root) {
                        if let Ok(c) = fs::read_to_string(&md_file) {
                            for name in extract_referenced_image_filenames(&c) {
                                still_used.insert(name);
                            }
                        }
                    }
                    for img_name in referenced_imgs {
                        if !still_used.contains(&img_name) {
                            let candidate = shared_assets.join(&img_name);
                            if candidate.exists() && candidate.is_file() {
                                let _ = fs::remove_file(&candidate);
                            } else if let Ok(entries) = fs::read_dir(&shared_assets) {
                                // 兼容 Linux (ext4/xfs) 大小写敏感文件系统下大写图片扩展名或文件名的清理
                                for entry in entries.flatten() {
                                    let ep = entry.path();
                                    if ep.is_file() {
                                        let ename = ep
                                            .file_name()
                                            .unwrap_or_default()
                                            .to_string_lossy()
                                            .to_lowercase();
                                        if ename == img_name {
                                            let _ = fs::remove_file(&ep);
                                        }
                                    }
                                }
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

/// 实时检测操作系统中 Quilla 的默认打开程序关联状态与右键菜单挂载状态 (v0.9 Typora 同款状态感知 & v0.13.0 银河麒麟 UKUI/Peony 增强)
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
        let home = std::env::var("HOME").unwrap_or_default();
        let has_desktop_entry = (!home.is_empty()
            && Path::new(&home)
                .join(".local/share/applications/quilla.desktop")
                .exists())
            || Path::new("/usr/share/applications/quilla.desktop").exists();
        let has_peony_menu = !home.is_empty()
            && (Path::new(&home)
                .join(".local/share/nautilus/scripts/用 Quilla (羽墨) 打开")
                .exists()
                || Path::new(&home)
                    .join(".config/peony/scripts/用 Quilla (羽墨) 打开")
                    .exists()
                || Path::new(&home)
                    .join(".local/share/applications/quilla-workspace.desktop")
                    .exists());
        let is_def = current.to_lowercase().contains("quilla");
        return Ok(FileAssociationStatus {
            is_registered_progid: is_def || has_desktop_entry,
            is_default_md: is_def,
            current_progid: if current.is_empty() {
                "quilla.desktop".to_string()
            } else {
                current
            },
            has_context_menu: has_peony_menu || is_def,
            associated_extensions: vec![
                ".md".into(),
                ".markdown".into(),
                ".mdown".into(),
                ".mkd".into(),
            ],
            platform: "linux".to_string(),
        });
    }
}

/// 独立切换系统文件管理器右键菜单「用 Quilla (羽墨) 打开」（支持 Windows Explorer 与银河麒麟 Peony / Nautilus / KDE 免 root 立即生效）
#[tauri::command]
pub fn toggle_explorer_context_menu(
    enabled: Option<bool>,
    enable: Option<bool>,
) -> Result<String, String> {
    let enabled = enabled.or(enable).unwrap_or(false);
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

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let home = std::env::var("HOME").map_err(|_| "无法读取 HOME 环境变量".to_string())?;
        let exe_path = std::env::current_exe().map_err(|e| format!("无法获取程序路径: {}", e))?;
        let exe_str = exe_path.to_string_lossy().to_string();

        let script_dirs = [
            Path::new(&home).join(".config/peony/scripts"),
            Path::new(&home).join(".local/share/nautilus/scripts"),
            Path::new(&home).join(".config/caja/scripts"),
        ];
        let apps_dir = Path::new(&home).join(".local/share/applications");
        let ws_desktop = apps_dir.join("quilla-workspace.desktop");
        let kio_dir = Path::new(&home).join(".local/share/kio/servicemenus");
        let kio_file = kio_dir.join("quilla.desktop");

        if enabled {
            let script_body = format!(
                "#!/usr/bin/env bash\n# Quilla (羽墨) 银河麒麟 Peony / Nautilus 文件管理器右键打开脚本\nif [ -n \"$PEONY_SCRIPT_SELECTED_FILE_PATHS\" ]; then\n  IFS=$'\\n' read -d '' -r -a files <<< \"$PEONY_SCRIPT_SELECTED_FILE_PATHS\"\n  \"{}\" \"${{files[@]}}\" &\nelif [ -n \"$NAUTILUS_SCRIPT_SELECTED_FILE_PATHS\" ]; then\n  IFS=$'\\n' read -d '' -r -a files <<< \"$NAUTILUS_SCRIPT_SELECTED_FILE_PATHS\"\n  \"{}\" \"${{files[@]}}\" &\nelse\n  \"{}\" \"$@\" &\nfi\n",
                exe_str, exe_str, exe_str
            );
            for sdir in &script_dirs {
                if fs::create_dir_all(sdir).is_ok() {
                    let sfile = sdir.join("用 Quilla (羽墨) 打开");
                    if fs::write(&sfile, &script_body).is_ok() {
                        let _ = fs::set_permissions(&sfile, fs::Permissions::from_mode(0o755));
                    }
                }
            }

            let _ = fs::create_dir_all(&apps_dir);
            let ws_desktop_content = format!(
                "[Desktop Entry]\nType=Application\nName=用 Quilla (羽墨) 作为工作区打开\nName[zh_CN]=用 Quilla (羽墨) 作为工作区打开\nComment=在 Quilla (羽墨) 中作为双链知识库工作区打开此文件夹\nExec=\"{}\" %f\nIcon=quilla\nTerminal=false\nNoDisplay=true\nMimeType=inode/directory;\nCategories=Utility;TextEditor;\n",
                exe_str
            );
            let _ = fs::write(&ws_desktop, ws_desktop_content);

            if fs::create_dir_all(&kio_dir).is_ok() {
                let kio_content = format!(
                    "[Desktop Entry]\nType=Service\nX-KDE-ServiceTypes=KonqPopupMenu/Plugin\nMimeType=text/markdown;text/x-markdown;text/plain;inode/directory;\nActions=openWithQuilla;\n\n[Desktop Action openWithQuilla]\nName=用 Quilla (羽墨) 打开\nName[zh_CN]=用 Quilla (羽墨) 打开\nIcon=quilla\nExec=\"{}\" %U\n",
                    exe_str
                );
                let _ = fs::write(&kio_file, kio_content);
                let _ = fs::set_permissions(&kio_file, fs::Permissions::from_mode(0o755));
            }

            let _ = std::process::Command::new("update-desktop-database")
                .arg(&apps_dir)
                .status();

            return Ok("已注册银河麒麟文件管理器 (Peony / XDG) 右键菜单「用 Quilla (羽墨) 打开」".to_string());
        } else {
            for sdir in &script_dirs {
                let _ = fs::remove_file(sdir.join("用 Quilla (羽墨) 打开"));
            }
            let _ = fs::remove_file(&ws_desktop);
            let _ = fs::remove_file(&kio_file);
            let _ = std::process::Command::new("update-desktop-database")
                .arg(&apps_dir)
                .status();
            return Ok("已移除银河麒麟文件管理器右键菜单项".to_string());
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = enabled;
        Ok("当前系统已通过桌面环境集成打开方式".to_string())
    }
}

/// 将 Quilla 注册为操作系统默认的 Markdown (.md / .markdown / .mdown / .mkd) 打开程序 (v0.9 Typora 同款重构 & v0.13.0 银河麒麟 XDG MIME 深度集成)
/// - 完整写入 Windows RegisteredApplications + Capabilities\FileAssociations + FriendlyAppName + OpenWithProgids
/// - 支持直接唤起针对 `.md` 的 Windows 原生 `OpenWith.exe` 选择框（用户只需一键勾选“始终”），无需在系统设置大海捞针
/// - 在银河麒麟 V10 / Linux 下自动写入 `~/.local/share/applications/quilla.desktop` 与 `quilla-markdown.xml` MIME 定义并刷新 `xdg-mime`
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
            let _ = toggle_explorer_context_menu(Some(true), None);
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
        let _ = (open_system_settings, open_with_dialog);
        // 自动在 ~/.local/share/applications/ 生成 quilla.desktop 与自定义 MIME 包，确保银河麒麟 Peony、AppImage 与便携版 100% 关联成功
        if let Ok(home) = std::env::var("HOME") {
            let apps_dir = Path::new(&home).join(".local/share/applications");
            let _ = fs::create_dir_all(&apps_dir);
            let desktop_file = apps_dir.join("quilla.desktop");
            let mut mime_list = vec![
                "text/markdown".to_string(),
                "text/x-markdown".to_string(),
            ];
            if target_exts.iter().any(|e| e == ".txt" || e == "txt") {
                mime_list.push("text/plain".to_string());
            }
            let desktop_content = format!(
                "[Desktop Entry]\nName=Quilla (羽墨)\nName[zh_CN]=Quilla (羽墨)\nGenericName=Markdown Editor\nGenericName[zh_CN]=所见即所得 Markdown 编辑器\nComment=Modern WYSIWYG Markdown Editor & Knowledge Base\nComment[zh_CN]=现代化所见即所得 Markdown 编辑器与双链知识库\nExec=\"{}\" %U\nIcon=quilla\nTerminal=false\nType=Application\nStartupWMClass=quilla\nMimeType={};\nCategories=Office;TextEditor;Utility;\nKeywords=Markdown;Editor;Note;Quilla;羽墨;\nActions=NewWindow;\n\n[Desktop Action NewWindow]\nName=新建独立窗口\nName[zh_CN]=新建独立窗口\nExec=\"{}\" --new-window\n",
                exe_str,
                mime_list.join(";"),
                exe_str
            );
            let _ = fs::write(&desktop_file, desktop_content);

            let mime_pkg_dir = Path::new(&home).join(".local/share/mime/packages");
            if fs::create_dir_all(&mime_pkg_dir).is_ok() {
                let mime_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="text/markdown">
    <comment>Markdown Document</comment>
    <comment xml:lang="zh_CN">Markdown 文档 (Quilla 羽墨)</comment>
    <glob pattern="*.md"/>
    <glob pattern="*.markdown"/>
    <glob pattern="*.mdown"/>
    <glob pattern="*.mkd"/>
  </mime-type>
</mime-info>
"#;
                let _ = fs::write(mime_pkg_dir.join("quilla-markdown.xml"), mime_xml);
                let _ = std::process::Command::new("update-mime-database")
                    .arg(Path::new(&home).join(".local/share/mime"))
                    .status();
            }
            let _ = std::process::Command::new("update-desktop-database")
                .arg(&apps_dir)
                .status();
        }
        let _ = std::process::Command::new("xdg-mime")
            .args(["default", "quilla.desktop", "text/markdown"])
            .status();
        let _ = std::process::Command::new("xdg-mime")
            .args(["default", "quilla.desktop", "text/x-markdown"])
            .status();
        if target_exts.iter().any(|e| e == ".txt" || e == "txt") {
            let _ = std::process::Command::new("xdg-mime")
                .args(["default", "quilla.desktop", "text/plain"])
                .status();
        }
        if enable_context_menu.unwrap_or(true) {
            let _ = toggle_explorer_context_menu(Some(true), None);
        }
        return Ok("已在银河麒麟/Linux 桌面环境注册 quilla.desktop，并通过 xdg-mime 设为默认 Markdown 程序".to_string());
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
        if p.is_file() {
            // 优先使用银河麒麟牡丹文件管理器 (Peony) 的 `--show-items` 参数高亮选中文件
            if Path::new("/usr/bin/peony").exists() {
                if std::process::Command::new("/usr/bin/peony")
                    .args(["--show-items", &path])
                    .spawn()
                    .is_ok()
                {
                    return Ok(());
                }
            }
            // 备选：使用 FreeDesktop FileManager1 D-Bus 标准接口高亮选中目标文件
            let file_uri = format!("file://{}", encode_uri_component(&path));
            if let Ok(status) = std::process::Command::new("dbus-send")
                .args([
                    "--session",
                    "--dest=org.freedesktop.FileManager1",
                    "--type=method_call",
                    "/org/freedesktop/FileManager1",
                    "org.freedesktop.FileManager1.ShowItems",
                    &format!("array:string:{}", file_uri),
                    "string:",
                ])
                .status()
            {
                if status.success() {
                    return Ok(());
                }
            }
        }
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


// ============================================================================
// v0.12.0 新增：原生 Git / WebDAV 增量同步与冲突三方解析命令
// ============================================================================

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatusEntry {
    pub path: String,
    pub rel_path: String,
    pub status: String,
    pub is_conflicted: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceStatus {
    pub is_repo: bool,
    pub workspace_root: String,
    pub branch: String,
    pub remote_url: String,
    pub ahead: u32,
    pub behind: u32,
    pub changed_files: Vec<GitFileStatusEntry>,
    pub conflicted_files: Vec<String>,
    pub summary: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncResult {
    pub success: bool,
    pub message: String,
    pub has_conflicts: bool,
    pub status: GitWorkspaceStatus,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFilePayload {
    pub path: String,
    pub has_conflict_markers: bool,
    pub conflict_count: usize,
    pub local_label: String,
    pub remote_label: String,
    pub local_content: String,
    pub remote_content: String,
    pub base_content: String,
    pub raw_content: String,
}

fn run_git_cmd(repo_dir: &Path, args: &[&str]) -> Result<(bool, String, String), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(repo_dir).args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("无法调用系统 git 命令，请确认已安装 Git: {}", e))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Ok((out.status.success(), stdout, stderr))
}

fn file_contains_conflict_markers(path: &Path) -> bool {
    if let Ok(content) = fs::read_to_string(path) {
        content.contains("<<<<<<<") && content.contains("=======") && content.contains(">>>>>>>")
    } else {
        false
    }
}

fn collect_git_workspace_status_inner(root_dir: &Path) -> Result<GitWorkspaceStatus, String> {
    let ws_str = root_dir.to_string_lossy().to_string();
    let (ok_repo, inside_out, _) =
        run_git_cmd(root_dir, &["rev-parse", "--is-inside-work-tree"])?;
    if !ok_repo || inside_out != "true" {
        return Ok(GitWorkspaceStatus {
            is_repo: false,
            workspace_root: ws_str,
            branch: String::new(),
            remote_url: String::new(),
            ahead: 0,
            behind: 0,
            changed_files: Vec::new(),
            conflicted_files: Vec::new(),
            summary: "当前工作区尚未初始化 Git 仓库".to_string(),
        });
    }

    let branch = run_git_cmd(root_dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|(_, out, _)| if out.is_empty() { "main".to_string() } else { out })
        .unwrap_or_else(|_| "main".to_string());

    let remote_url = run_git_cmd(root_dir, &["remote", "get-url", "origin"])
        .map(|(ok, out, _)| if ok { out } else { String::new() })
        .unwrap_or_default();

    let (mut ahead, mut behind) = (0u32, 0u32);
    if let Ok((true, counts, _)) =
        run_git_cmd(root_dir, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])
    {
        let parts: Vec<&str> = counts.split_whitespace().collect();
        if parts.len() == 2 {
            ahead = parts[0].parse().unwrap_or(0);
            behind = parts[1].parse().unwrap_or(0);
        }
    }

    let mut changed_files = Vec::new();
    let mut conflicted_files = Vec::new();
    if let Ok((true, porcelain, _)) =
        run_git_cmd(root_dir, &["status", "--porcelain=v1", "-uall"])
    {
        for raw_line in porcelain.lines() {
            if raw_line.len() < 4 {
                continue;
            }
            let code = raw_line[..2].trim().to_string();
            let rel_raw = raw_line[3..].trim().trim_matches('"');
            let rel_path = if let Some(idx) = rel_raw.find(" -> ") {
                rel_raw[idx + 4..].trim_matches('"').to_string()
            } else {
                rel_raw.to_string()
            };
            let full_path = root_dir.join(&rel_path);
            let full_str = full_path.to_string_lossy().to_string();
            let is_conflict_code = matches!(
                code.as_str(),
                "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD"
            ) || file_contains_conflict_markers(&full_path);

            if is_conflict_code && !conflicted_files.contains(&full_str) {
                conflicted_files.push(full_str.clone());
            }
            changed_files.push(GitFileStatusEntry {
                path: full_str,
                rel_path,
                status: if code.is_empty() { "M".to_string() } else { code },
                is_conflicted: is_conflict_code,
            });
        }
    }

    let summary = if !conflicted_files.is_empty() {
        format!(
            "检测到 {} 个冲突文件待三方合并（分支 {}）",
            conflicted_files.len(),
            branch
        )
    } else if changed_files.is_empty() {
        format!("工作区纯净 · 分支 {} (领先 {} / 落后 {})", branch, ahead, behind)
    } else {
        format!(
            "分支 {} · {} 个变更文件待同步 (↑{} ↓{})",
            branch,
            changed_files.len(),
            ahead,
            behind
        )
    };

    Ok(GitWorkspaceStatus {
        is_repo: true,
        workspace_root: ws_str,
        branch,
        remote_url,
        ahead,
        behind,
        changed_files,
        conflicted_files,
        summary,
    })
}

#[tauri::command]
pub fn workspace_git_status(
    window: tauri::Window,
    state: State<'_, AppState>,
    workspace_root: Option<String>,
) -> Result<GitWorkspaceStatus, String> {
    let resolved = workspace_root
        .filter(|s| !s.trim().is_empty())
        .or_else(|| resolve_window_workspace(&window, &state))
        .map(PathBuf::from)
        .ok_or_else(|| "请先打开工作区文件夹以使用 Git 增量同步".to_string())?;

    collect_git_workspace_status_inner(&resolved)
}

#[tauri::command]
pub fn workspace_git_sync(
    window: tauri::Window,
    state: State<'_, AppState>,
    workspace_root: Option<String>,
    action: String,
    commit_message: Option<String>,
    remote_url: Option<String>,
) -> Result<GitSyncResult, String> {
    let root_dir = workspace_root
        .filter(|s| !s.trim().is_empty())
        .or_else(|| resolve_window_workspace(&window, &state))
        .map(PathBuf::from)
        .ok_or_else(|| "请先打开工作区文件夹以执行 Git 同步".to_string())?;

    if action == "init" {
        let (ok, _, err) = run_git_cmd(&root_dir, &["init"])?;
        if !ok {
            return Err(format!("初始化 Git 仓库失败: {}", err));
        }
        if let Some(url) = remote_url.filter(|s| !s.trim().is_empty()) {
            let _ = run_git_cmd(&root_dir, &["remote", "remove", "origin"]);
            let _ = run_git_cmd(&root_dir, &["remote", "add", "origin", url.trim()]);
        }
        let status = collect_git_workspace_status_inner(&root_dir)?;
        return Ok(GitSyncResult {
            success: true,
            message: "已初始化本地 Git 仓库".to_string(),
            has_conflicts: false,
            status,
        });
    }

    if let Some(url) = remote_url.filter(|s| !s.trim().is_empty()) {
        let (has_origin, current_origin, _) =
            run_git_cmd(&root_dir, &["remote", "get-url", "origin"]).unwrap_or((false, String::new(), String::new()));
        if !has_origin {
            let _ = run_git_cmd(&root_dir, &["remote", "add", "origin", url.trim()]);
        } else if current_origin.trim() != url.trim() {
            let _ = run_git_cmd(&root_dir, &["remote", "set-url", "origin", url.trim()]);
        }
    }

    let mut log_messages: Vec<String> = Vec::new();

    if action == "pull" || action == "sync_all" {
        let (ok, out, err) = run_git_cmd(&root_dir, &["pull", "--no-rebase", "origin"])?;
        if ok {
            log_messages.push(if out.is_empty() {
                "远端拉取完成".to_string()
            } else {
                format!("拉取成功: {}", out.lines().next().unwrap_or("Already up to date"))
            });
        } else {
            let st = collect_git_workspace_status_inner(&root_dir)?;
            if !st.conflicted_files.is_empty() {
                return Ok(GitSyncResult {
                    success: false,
                    message: format!(
                        "拉取远端时检测到 {} 个文件发生冲突，请切换到「冲突三方合并」视图解决",
                        st.conflicted_files.len()
                    ),
                    has_conflicts: true,
                    status: st,
                });
            }
            if !err.contains("couldn't find remote ref") && !err.contains("no tracking information") {
                log_messages.push(format!("拉取提示: {}", err.lines().next().unwrap_or(&err)));
            }
        }
    }

    if action == "commit_push" || action == "sync_all" {
        let _ = run_git_cmd(&root_dir, &["add", "-A"]);
        let msg = commit_message
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| "docs(quilla): incremental workspace sync".to_string());
        let (commit_ok, commit_out, commit_err) = run_git_cmd(&root_dir, &["commit", "-m", &msg])?;
        if commit_ok {
            log_messages.push(format!(
                "已提交本地变更 ({})",
                commit_out.lines().next().unwrap_or(&msg)
            ));
        } else if !commit_out.contains("nothing to commit") && !commit_err.contains("nothing to commit") {
            log_messages.push(format!("提交信息: {}", commit_err));
        }

        let branch = run_git_cmd(&root_dir, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|(_, b, _)| if b.is_empty() { "main".to_string() } else { b })
            .unwrap_or_else(|_| "main".to_string());

        let (push_ok, _, push_err) = run_git_cmd(&root_dir, &["push", "-u", "origin", &branch])?;
        if push_ok {
            log_messages.push(format!("已推送至 origin/{}", branch));
        } else if !push_err.is_empty() {
            let st = collect_git_workspace_status_inner(&root_dir)?;
            return Ok(GitSyncResult {
                success: false,
                message: format!("推送远端未完成: {}", push_err.lines().next().unwrap_or(&push_err)),
                has_conflicts: !st.conflicted_files.is_empty(),
                status: st,
            });
        }
    }

    let status = collect_git_workspace_status_inner(&root_dir)?;
    let has_conflicts = !status.conflicted_files.is_empty();
    Ok(GitSyncResult {
        success: !has_conflicts,
        message: if log_messages.is_empty() {
            "Git 同步操作已完成".to_string()
        } else {
            log_messages.join(" · ")
        },
        has_conflicts,
        status,
    })
}

#[tauri::command]
pub fn parse_git_conflict_file(path: String) -> Result<ConflictFilePayload, String> {
    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    let raw_content = fs::read_to_string(file_path)
        .map_err(|e| format!("读取冲突文件失败: {}", e))?
        .replace("\r\n", "\n");

    let mut local_lines: Vec<String> = Vec::new();
    let mut remote_lines: Vec<String> = Vec::new();
    let mut base_lines: Vec<String> = Vec::new();
    let mut local_label = "HEAD (本地修改)".to_string();
    let mut remote_label = "REMOTE (远端变更)".to_string();
    let mut conflict_count = 0usize;

    #[derive(PartialEq)]
    enum ParseState {
        Normal,
        InLocal,
        InBase,
        InRemote,
    }

    let mut state = ParseState::Normal;
    for line in raw_content.lines() {
        if line.starts_with("<<<<<<<") {
            conflict_count += 1;
            let lbl = line.trim_start_matches('<').trim();
            if !lbl.is_empty() {
                local_label = lbl.to_string();
            }
            state = ParseState::InLocal;
        } else if line.starts_with("|||||||") && state == ParseState::InLocal {
            state = ParseState::InBase;
        } else if line.starts_with("=======")
            && (state == ParseState::InLocal || state == ParseState::InBase)
        {
            state = ParseState::InRemote;
        } else if line.starts_with(">>>>>>>") && state == ParseState::InRemote {
            let lbl = line.trim_start_matches('>').trim();
            if !lbl.is_empty() {
                remote_label = lbl.to_string();
            }
            state = ParseState::Normal;
        } else {
            match state {
                ParseState::Normal => {
                    local_lines.push(line.to_string());
                    remote_lines.push(line.to_string());
                    base_lines.push(line.to_string());
                }
                ParseState::InLocal => {
                    local_lines.push(line.to_string());
                }
                ParseState::InBase => {
                    base_lines.push(line.to_string());
                }
                ParseState::InRemote => {
                    remote_lines.push(line.to_string());
                }
            }
        }
    }

    Ok(ConflictFilePayload {
        path,
        has_conflict_markers: conflict_count > 0,
        conflict_count,
        local_label,
        remote_label,
        local_content: local_lines.join("\n"),
        remote_content: remote_lines.join("\n"),
        base_content: base_lines.join("\n"),
        raw_content,
    })
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConflictItem {
    pub path: String,
    pub rel_path: String,
    pub local_content: String,
    pub remote_content: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSyncResult {
    pub success: bool,
    pub message: String,
    pub uploaded_count: usize,
    pub downloaded_count: usize,
    pub conflicts: Vec<WebDavConflictItem>,
}

fn collect_markdown_files_flat(root: &Path, current: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(current) {
        for entry in entries.flatten() {
            let p = entry.path();
            let fname = entry.file_name().to_string_lossy().to_string();
            if fname.starts_with('.') || fname == "node_modules" || fname == "target" {
                continue;
            }
            if p.is_dir() {
                collect_markdown_files_flat(root, &p, out);
            } else if fname.ends_with(".md")
                || fname.ends_with(".markdown")
                || fname.ends_with(".quilla-canvas.json")
            {
                out.push(p);
            }
        }
    }
}

#[tauri::command]
pub fn webdav_sync_workspace(
    window: tauri::Window,
    state: State<'_, AppState>,
    workspace_root: Option<String>,
    endpoint: String,
    username: String,
    password: String,
    remote_dir: String,
    direction: String,
) -> Result<WebDavSyncResult, String> {
    let ep = endpoint.trim().trim_end_matches('/');
    if ep.is_empty() || (!ep.starts_with("http://") && !ep.starts_with("https://")) {
        return Err("请填写合法的 WebDAV 服务器地址（以 http:// 或 https:// 开头）".to_string());
    }

    let remote_clean = remote_dir.trim().trim_matches('/');
    let base_remote_url = if remote_clean.is_empty() {
        format!("{}/", ep)
    } else {
        format!("{}/{}/", ep, remote_clean)
    };

    let run_curl = |args: &[&str]| -> Result<(bool, String, String), String> {
        let mut cmd = std::process::Command::new("curl");
        cmd.args(args);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let out = cmd
            .output()
            .map_err(|e| format!("调用系统 curl 执行 WebDAV 请求失败: {}", e))?;
        Ok((
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        ))
    };

    let auth_pair = format!("{}:{}", username.trim(), password);

    if direction == "test" {
        let (ok, stdout, stderr) = run_curl(&[
            "-sS",
            "-i",
            "-X",
            "PROPFIND",
            "-u",
            &auth_pair,
            "-H",
            "Depth: 0",
            &base_remote_url,
        ])?;
        if !ok {
            return Err(format!("无法连接 WebDAV 服务器: {}", stderr));
        }
        let first_line = stdout.lines().next().unwrap_or("");
        if first_line.contains("200")
            || first_line.contains("207")
            || first_line.contains("301")
            || first_line.contains("302")
        {
            return Ok(WebDavSyncResult {
                success: true,
                message: format!("WebDAV 连接验证成功 ({})", first_line.trim()),
                uploaded_count: 0,
                downloaded_count: 0,
                conflicts: Vec::new(),
            });
        } else if first_line.contains("404") {
            let _ = run_curl(&["-sS", "-X", "MKCOL", "-u", &auth_pair, &base_remote_url]);
            return Ok(WebDavSyncResult {
                success: true,
                message: "WebDAV 认证通过，并已自动在远端创建同步目录".to_string(),
                uploaded_count: 0,
                downloaded_count: 0,
                conflicts: Vec::new(),
            });
        } else if first_line.contains("401") || first_line.contains("403") {
            return Err(format!("WebDAV 认证失败，请检查账号或应用专用密码 ({})", first_line.trim()));
        }
        return Ok(WebDavSyncResult {
            success: true,
            message: format!("WebDAV 响应状态: {}", first_line.trim()),
            uploaded_count: 0,
            downloaded_count: 0,
            conflicts: Vec::new(),
        });
    }

    let root_dir = workspace_root
        .filter(|s| !s.trim().is_empty())
        .or_else(|| resolve_window_workspace(&window, &state))
        .map(PathBuf::from)
        .ok_or_else(|| "请先打开工作区文件夹以执行 WebDAV 增量同步".to_string())?;

    let _ = run_curl(&["-sS", "-X", "MKCOL", "-u", &auth_pair, &base_remote_url]);

    let mut local_files = Vec::new();
    collect_markdown_files_flat(&root_dir, &root_dir, &mut local_files);

    let mut uploaded_count = 0usize;
    let mut downloaded_count = 0usize;
    let mut conflicts = Vec::new();

    for file_path in &local_files {
        let rel = match file_path.strip_prefix(&root_dir) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if rel.contains('/') {
            continue;
        }
        let encoded_rel = encode_uri_component(&rel);
        let file_remote_url = format!("{}{}", base_remote_url, encoded_rel);
        let local_content = fs::read_to_string(file_path).unwrap_or_default();

        if direction == "push" {
            let (ok, _, _) = run_curl(&[
                "-sS",
                "-X",
                "PUT",
                "-u",
                &auth_pair,
                "--data-binary",
                &format!("@{}", file_path.to_string_lossy()),
                &file_remote_url,
            ])?;
            if ok {
                uploaded_count += 1;
            }
        } else {
            let (ok, remote_body, _) = run_curl(&[
                "-sS",
                "-f",
                "-X",
                "GET",
                "-u",
                &auth_pair,
                &file_remote_url,
            ])?;
            if ok && !remote_body.is_empty() {
                let norm_local = local_content.replace("\r\n", "\n");
                let norm_remote = remote_body.replace("\r\n", "\n");
                if norm_local != norm_remote {
                    if direction == "pull" {
                        let _ = SafeIO::atomic_write(file_path, &remote_body);
                        downloaded_count += 1;
                    } else {
                        conflicts.push(WebDavConflictItem {
                            path: file_path.to_string_lossy().to_string(),
                            rel_path: rel.clone(),
                            local_content: norm_local,
                            remote_content: norm_remote,
                        });
                    }
                }
            } else if direction == "bidirectional" {
                let (put_ok, _, _) = run_curl(&[
                    "-sS",
                    "-X",
                    "PUT",
                    "-u",
                    &auth_pair,
                    "--data-binary",
                    &format!("@{}", file_path.to_string_lossy()),
                    &file_remote_url,
                ])?;
                if put_ok {
                    uploaded_count += 1;
                }
            }
        }
    }

    let message = if !conflicts.is_empty() {
        format!(
            "增量扫描完成：上传 {} 篇，检测到 {} 篇本地与云端存在差异，可在三方视图中合并",
            uploaded_count,
            conflicts.len()
        )
    } else {
        format!(
            "WebDAV 增量同步完成：已上传 {} 篇，拉取更新 {} 篇",
            uploaded_count, downloaded_count
        )
    };

    Ok(WebDavSyncResult {
        success: conflicts.is_empty(),
        message,
        uploaded_count,
        downloaded_count,
        conflicts,
    })
}
