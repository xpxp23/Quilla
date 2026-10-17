pub mod buffer;
pub mod commands;
pub mod safe_io;
pub mod search;
pub mod watcher;

use commands::AppState;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{Emitter, Manager, WindowEvent};

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let mut initial_file = None;
    let mut is_new_window = false;
    if args.len() > 1 {
        for arg in &args[1..] {
            if arg == "--new-window" {
                is_new_window = true;
            } else if !arg.starts_with('-') {
                let path = std::path::Path::new(arg);
                if path.exists() {
                    initial_file = Some(path.to_string_lossy().to_string());
                }
            }
        }
    }

    let app_state = AppState {
        current_workspace: Mutex::new(None),
        window_workspaces: Mutex::new(HashMap::new()),
        initial_file: Mutex::new(initial_file),
        is_new_window: Mutex::new(is_new_window),
        document_buffers: Mutex::new(HashMap::new()),
        workspace_watcher: watcher::WorkspaceWatcher::default(),
        force_closing_windows: Mutex::new(HashSet::new()),
    };

    tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
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
            commands::read_file_content,
            commands::sync_document_buffer,
            commands::extract_file_headings,
            commands::check_is_directory,
            commands::clear_draft_snapshot,
            commands::load_draft_snapshots,
            commands::close_workspace_watcher,
            commands::list_workspace_files,
            commands::search_workspace_content,
            commands::search_backlinks,
            commands::select_workspace_folder,
            commands::select_save_file_path,
            commands::select_export_html_path,
            commands::select_open_file_path,
            commands::create_new_window,
            commands::get_cli_open_file,
            commands::is_blank_new_window,
            commands::save_image_asset,
            commands::copy_image_to_assets,
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
            commands::reveal_in_explorer,
            commands::open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("运行 Quilla 失败");
}
