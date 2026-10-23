pub mod buffer;
pub mod commands;
pub mod safe_io;
pub mod search;
pub mod watcher;

use commands::AppState;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager, WindowEvent};

const SINGLE_INSTANCE_ADDR: &str = "127.0.0.1:45789";

/// 单实例文件接管守卫 (tauri-plugin-single-instance 原生零依赖实现)：
/// - 当已有 Quilla 实例运行且未传入 `--new-window` 时，将双击打开的 `.md` 文件或工作区目录通过本地回环 IPC 秒级转发给主实例并立即退出；
/// - 主实例监听本地回环端口，收到外部双击文件请求后自动唤醒窗口、置顶聚焦并派发 `quilla-open-external-file` 事件在新标签页打开。
fn try_forward_to_existing_instance(cli_paths: &[String], is_new_window: bool) -> bool {
    if is_new_window {
        return false;
    }
    if let Ok(mut stream) = TcpStream::connect_timeout(
        &SINGLE_INSTANCE_ADDR.parse().unwrap(),
        Duration::from_millis(180),
    ) {
        let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
        let payload = serde_json::json!({
            "paths": cli_paths,
            "cwd": std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        })
        .to_string();
        if stream.write_all(payload.as_bytes()).is_ok() {
            let _ = stream.flush();
            return true;
        }
    }
    false
}

fn start_single_instance_ipc_server(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        if let Ok(listener) = TcpListener::bind(SINGLE_INSTANCE_ADDR) {
            for stream in listener.incoming().flatten() {
                let mut s = stream;
                let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
                let mut buf = String::new();
                if s.read_to_string(&mut buf).is_ok() {
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let _ = win.unminimize();
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&buf) {
                        if let Some(arr) = json.get("paths").and_then(|v| v.as_array()) {
                            for item in arr {
                                if let Some(path_str) = item.as_str() {
                                    if !path_str.trim().is_empty() {
                                        let _ = app_handle.emit(
                                            "quilla-open-external-file",
                                            path_str.trim().to_string(),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let mut initial_file = None;
    let mut cli_paths: Vec<String> = Vec::new();
    let mut is_new_window = false;
    if args.len() > 1 {
        for arg in &args[1..] {
            if arg == "--new-window" {
                is_new_window = true;
            } else if !arg.starts_with('-') {
                let cleaned = arg
                    .trim_matches('"')
                    .trim_start_matches("file://")
                    .to_string();
                let path = std::path::Path::new(&cleaned);
                let resolved = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    std::env::current_dir()
                        .unwrap_or_default()
                        .join(path)
                };
                if resolved.exists() {
                    let s = resolved.to_string_lossy().to_string();
                    cli_paths.push(s.clone());
                    initial_file = Some(s);
                }
            }
        }
    }

    // 若已有主实例正在运行，将双击打开的 .md 文件转发给现有实例并在新标签页秒开
    if try_forward_to_existing_instance(&cli_paths, is_new_window) {
        return;
    }

    let app_state = AppState {
        current_workspace: Mutex::new(None),
        window_workspaces: Mutex::new(HashMap::new()),
        initial_file: Mutex::new(initial_file),
        is_new_window: Mutex::new(is_new_window),
        document_buffers: Mutex::new(HashMap::new()),
        workspace_watcher: watcher::WorkspaceWatcher::default(),
        workspace_index: search::WorkspaceIndex::default(),
        force_closing_windows: Mutex::new(HashSet::new()),
    };

    let app = tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            // 启动单实例文件接管 IPC 监听服务
            start_single_instance_ipc_server(app.handle().clone());

            // 启动主题目录监听器（同时兼容开发环境 src/themes 与生产环境可执行文件同级目录）
            if let Ok(current_dir) = std::env::current_dir() {
                let dev_themes = current_dir.join("src").join("themes");
                if dev_themes.exists() {
                    watcher::ThemeWatcher::start_theme_watcher(dev_themes, app.handle().clone());
                } else {
                    watcher::ThemeWatcher::start_theme_watcher(current_dir, app.handle().clone());
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let state = window.state::<AppState>();
                let label = window.label().to_string();
                let should_allow = state
                    .force_closing_windows
                    .lock()
                    .map(|mut set| set.remove(&label))
                    .unwrap_or(false);

                if !should_allow {
                    api.prevent_close();
                    let _ = window.emit("window-close-requested", ());
                }
            }
            WindowEvent::Resized(_) => {
                if let Ok(maximized) = window.is_maximized() {
                    let _ = window.emit("window-maximized-changed", maximized);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::save_file_content,
            commands::save_base64_file,
            commands::read_file_content,
            commands::sync_document_buffer,
            commands::extract_file_headings,
            commands::read_heading_section,
            commands::update_heading_section,
            commands::list_file_history,
            commands::create_file_history_snapshot,
            commands::delete_file_history_item,
            commands::scan_workspace_tags,
            commands::get_workspace_graph,
            commands::check_is_directory,
            commands::clear_draft_snapshot,
            commands::load_draft_snapshots,
            commands::close_workspace_watcher,
            commands::list_workspace_files,
            commands::search_workspace_content,
            commands::search_backlinks,
            commands::search_backlinks_overview,
            commands::convert_unlinked_mention_to_wikilink,
            commands::select_workspace_folder,
            commands::select_save_file_path,
            commands::select_export_html_path,
            commands::select_export_word_path,
            commands::select_export_pdf_path,
            commands::export_pdf_document,
            commands::select_save_image_path,
            commands::select_open_file_path,
            commands::create_new_window,
            commands::get_cli_open_file,
            commands::is_blank_new_window,
            commands::save_image_asset,
            commands::copy_image_to_assets,
            commands::upload_image_to_bed,
            commands::read_image_base64,
            commands::read_custom_theme_css,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_is_maximized,
            commands::window_close,
            commands::window_set_always_on_top,
            commands::create_file,
            commands::create_folder,
            commands::rename_path,
            commands::delete_path,
            commands::cleanup_orphan_assets,
            commands::get_file_association_status,
            commands::toggle_explorer_context_menu,
            commands::register_default_markdown_app,
            commands::reveal_in_explorer,
            commands::reveal_in_folder,
            commands::open_external_url
        ])
        .build(tauri::generate_context!())
        .expect("构建 Quilla 失败");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if path.exists() {
                        let path_str = path.to_string_lossy().to_string();
                        if let Some(state) = app_handle.try_state::<AppState>() {
                            if let Ok(mut init) = state.initial_file.lock() {
                                *init = Some(path_str.clone());
                            }
                        }
                        let _ = app_handle.emit("quilla-open-external-file", path_str);
                    }
                }
            }
        }
        let _ = (app_handle, event);
    });
}
