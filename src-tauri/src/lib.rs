pub mod buffer;
pub mod commands;
pub mod safe_io;
pub mod search;
pub mod watcher;

use commands::AppState;

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
        current_workspace: std::sync::Mutex::new(None),
        initial_file: std::sync::Mutex::new(initial_file),
        is_new_window: std::sync::Mutex::new(is_new_window),
    };

    tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            // 启动主题目录监听器
            if let Ok(current_dir) = std::env::current_dir() {
                let themes_dir = current_dir.join("src").join("themes");
                if themes_dir.exists() {
                    watcher::ThemeWatcher::start_theme_watcher(themes_dir, app.handle().clone());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::save_file_content,
            commands::read_file_content,
            commands::list_workspace_files,
            commands::search_workspace_content,
            commands::select_workspace_folder,
            commands::select_save_file_path,
            commands::select_open_file_path,
            commands::create_new_window,
            commands::get_cli_open_file,
            commands::is_blank_new_window,
            commands::save_image_asset,
            commands::copy_image_to_assets,
            commands::read_image_base64,
            commands::window_minimize,
            commands::window_toggle_maximize,
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
