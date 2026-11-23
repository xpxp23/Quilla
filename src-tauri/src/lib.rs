pub mod buffer;
pub mod commands;
pub mod safe_io;
pub mod search;
pub mod watcher;

use commands::AppState;
use safe_io::SafeIO;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, WindowEvent};

#[cfg(not(target_os = "linux"))]
use std::net::{TcpListener, TcpStream};

#[cfg(not(target_os = "linux"))]
const SINGLE_INSTANCE_ADDR: &str = "127.0.0.1:45789";

const MAX_SINGLE_INSTANCE_IPC_BYTES: u64 = 64 * 1024;

/// Tauri v1 / v2 统一事件广播适配 Trait：
/// 将 `app_handle.emit(...)` 与 `app_handle.emit_to(...)` 映射至 `tauri::Manager::emit_all` / `emit_to`
pub trait Emitter {
    fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) -> tauri::Result<()>;
    fn emit_to<S: serde::Serialize + Clone>(
        &self,
        label: &str,
        event: &str,
        payload: S,
    ) -> tauri::Result<()>;
}

impl Emitter for tauri::AppHandle {
    fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) -> tauri::Result<()> {
        tauri::Manager::emit_all(self, event, payload)
    }

    fn emit_to<S: serde::Serialize + Clone>(
        &self,
        label: &str,
        event: &str,
        payload: S,
    ) -> tauri::Result<()> {
        tauri::Manager::emit_to(self, label, event, payload)
    }
}

pub trait WebviewWindowCompat {
    fn get_webview_window(&self, label: &str) -> Option<tauri::Window>;
}

impl WebviewWindowCompat for tauri::AppHandle {
    fn get_webview_window(&self, label: &str) -> Option<tauri::Window> {
        tauri::Manager::get_window(self, label)
    }
}

/// 检测 Linux 是否运行在 KVM/QEMU/VMware/VirtualBox 等虚拟化或软件渲染环境下
#[cfg(target_os = "linux")]
fn is_virtualized_or_software_gpu() -> bool {
    // 1. 景嘉微国产显卡检测
    if std::path::Path::new("/proc/driver/jmgpu").exists()
        || std::path::Path::new("/dev/jmgpu").exists()
    {
        return true;
    }

    // 2. 常见 KVM/QEMU 虚拟显卡内核模块检测
    for module in ["virtio_gpu", "qxl", "bochs", "bochs_drm", "vmwgfx", "cirrus"] {
        if std::path::Path::new(&format!("/sys/module/{}", module)).exists() {
            return true;
        }
    }

    // 3. DMI 产品名与虚拟化特征检测（兼容 KVM / QEMU / VMware / VirtualBox）
    for dmi_path in [
        "/sys/class/dmi/id/product_name",
        "/sys/class/dmi/id/sys_vendor",
        "/sys/class/dmi/id/board_vendor",
    ] {
        if let Ok(raw) = std::fs::read_to_string(dmi_path) {
            let lower = raw.to_lowercase();
            if lower.contains("kvm")
                || lower.contains("qemu")
                || lower.contains("vmware")
                || lower.contains("virtualbox")
                || lower.contains("bochs")
            {
                return true;
            }
        }
    }

    // 4. 软件渲染环境变量检测 (llvmpipe / softpipe)
    if let Ok(always_soft) = std::env::var("LIBGL_ALWAYS_SOFTWARE") {
        if always_soft == "1" || always_soft.eq_ignore_ascii_case("true") {
            return true;
        }
    }

    // 5. 无可用硬件 DRM render 节点时视为软件渲染/远程 VNC 环境
    if !std::path::Path::new("/dev/dri/renderD128").exists() {
        return true;
    }

    false
}

/// 银河麒麟 (Kylin OS V10 SP1 / 高级服务器 OS V11 2503 / glibc 2.38 / AArch64·x86_64·LoongArch64) 运行时环境预初始化：
/// 1. 默认注入 `WEBKIT_DISABLE_DMABUF_RENDERER=1`（除非显式设置 `QUILLA_ALLOW_DMABUF=1`），规避 WebKitGTK 白屏；
/// 2. 检测到景嘉微显卡、KVM/QEMU 虚拟化显卡（virtio-gpu/qxl/bochs/llvmpipe）、无硬件渲染节点或 `--safe-render` 时，
///    自动启用 `WEBKIT_DISABLE_COMPOSITING_MODE=1`，彻底解决 V11 2503 虚拟化环境渲染冻结与无法输入；
/// 3. 仅在存在 X11 `DISPLAY` 时才优先回退 `GDK_BACKEND=x11,wayland`，避免纯 Wayland 会话启动失败；
/// 4. 不再盲目覆写 `GTK_IM_MODULE=fcitx`，仅保留系统原配输入法框架（兼容 Fcitx5 / Fcitx / IBus）；
/// 5. 初始化 Rayon 全局并行线程池，兼顾多核处理器吞吐。
pub fn init_linux_kylin_environment(args: &[String]) {
    #[cfg(target_os = "linux")]
    {
        let allow_dmabuf = std::env::var("QUILLA_ALLOW_DMABUF")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if !allow_dmabuf && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }

        let force_safe_render = args
            .iter()
            .any(|a| a == "--disable-gpu" || a == "--safe-render")
            || std::env::var("QUILLA_SAFE_RENDER")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);

        if (force_safe_render || is_virtualized_or_software_gpu())
            && std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none()
        {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }

        // 仅在存在 X11 DISPLAY 且为 Wayland 混合会话时优先 x11；纯 Wayland 环境不强行覆写
        if std::env::var_os("GDK_BACKEND").is_none() {
            let has_x11_display = std::env::var("DISPLAY")
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false);
            if has_x11_display {
                if let Ok(session_type) = std::env::var("XDG_SESSION_TYPE") {
                    if session_type.eq_ignore_ascii_case("wayland") {
                        std::env::set_var("GDK_BACKEND", "x11,wayland");
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = args;
    }

    let logical_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(8)
        .clamp(2, 16);
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(logical_threads)
        .thread_name(|idx| format!("quilla-worker-{}", idx))
        .build_global();
}

/// 解析命令行或 Linux `.desktop` (`%U` / `%F`) 传入的文件/目录参数，
/// 自动剥离 `file://` 协议头并解码 `%XX` UTF-8 中文路径；同时支持打开尚未创建的新 `.md` 文件路径
pub fn normalize_cli_path_arg(raw_arg: &str) -> Option<String> {
    let trimmed = raw_arg.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return None;
    }
    let without_scheme = if let Some(rest) = trimmed.strip_prefix("file://localhost") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("file://") {
        rest
    } else {
        trimmed
    };
    let mut decoded = commands::urlencoding_decode(without_scheme);
    #[cfg(target_os = "windows")]
    {
        if decoded.starts_with('/') && decoded.as_bytes().get(2) == Some(&b':') {
            decoded.remove(0);
        }
    }
    let path = std::path::Path::new(&decoded);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    if resolved.exists() {
        Some(resolved.to_string_lossy().to_string())
    } else if resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
        && resolved.parent().map(|p| p.exists()).unwrap_or(false)
    {
        Some(resolved.to_string_lossy().to_string())
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn resolve_single_instance_socket_path() -> std::path::PathBuf {
    if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
        let dir = std::path::PathBuf::from(runtime_dir);
        if dir.exists() {
            return dir.join("quilla-single-instance.sock");
        }
    }
    let user = std::env::var("USER").unwrap_or_else(|_| "user".to_string());
    let safe_user: String = user
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    std::env::temp_dir().join(format!("quilla-ipc-{}.sock", safe_user))
}

fn handle_single_instance_payload(app_handle: &tauri::AppHandle, buf: &str) {
    if let Some(win) = app_handle.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(buf) {
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

/// 单实例文件接管守卫：
/// - Linux 使用 per-user Unix Domain Socket (`$XDG_RUNTIME_DIR/quilla-single-instance.sock`, 0600 隔离)，
///   避免多用户服务器上固定 TCP 端口抢占与跨用户转发；
/// - Windows/macOS 使用本地回环 TCP；
/// - 统一限制单次 IPC 读取上限为 64 KiB，防止 OOM DoS。
fn try_forward_to_existing_instance(cli_paths: &[String], is_new_window: bool) -> bool {
    if is_new_window {
        return false;
    }
    let payload = serde_json::json!({
        "paths": cli_paths,
        "cwd": std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    })
    .to_string();

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::net::UnixStream;
        let sock_path = resolve_single_instance_socket_path();
        if let Ok(mut stream) = UnixStream::connect(&sock_path) {
            let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
            if stream.write_all(payload.as_bytes()).is_ok() {
                let _ = stream.flush();
                return true;
            }
        }
        return false;
    }

    #[cfg(not(target_os = "linux"))]
    {
        if let Ok(addr) = SINGLE_INSTANCE_ADDR.parse() {
            if let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(180)) {
                let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
                if stream.write_all(payload.as_bytes()).is_ok() {
                    let _ = stream.flush();
                    return true;
                }
            }
        }
        false
    }
}

fn start_single_instance_ipc_server(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::PermissionsExt;
            use std::os::unix::net::UnixListener;
            let sock_path = resolve_single_instance_socket_path();
            let _ = std::fs::remove_file(&sock_path);
            if let Ok(listener) = UnixListener::bind(&sock_path) {
                let _ = std::fs::set_permissions(
                    &sock_path,
                    std::fs::Permissions::from_mode(0o600),
                );
                for stream in listener.incoming().flatten() {
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                    let mut buf = String::new();
                    if stream
                        .take(MAX_SINGLE_INSTANCE_IPC_BYTES)
                        .read_to_string(&mut buf)
                        .is_ok()
                    {
                        handle_single_instance_payload(&app_handle, &buf);
                    }
                }
            }
        }

        #[cfg(not(target_os = "linux"))]
        {
            if let Ok(listener) = TcpListener::bind(SINGLE_INSTANCE_ADDR) {
                for stream in listener.incoming().flatten() {
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                    let mut buf = String::new();
                    if stream
                        .take(MAX_SINGLE_INSTANCE_IPC_BYTES)
                        .read_to_string(&mut buf)
                        .is_ok()
                    {
                        handle_single_instance_payload(&app_handle, &buf);
                    }
                }
            }
        }
    });
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    init_linux_kylin_environment(&args);

    let mut initial_file = None;
    let mut cli_paths: Vec<String> = Vec::new();
    let mut is_new_window = false;
    if args.len() > 1 {
        for arg in &args[1..] {
            if arg == "--new-window" {
                is_new_window = true;
            } else if arg == "--disable-gpu" || arg == "--safe-render" {
                continue;
            } else if let Some(resolved_str) = normalize_cli_path_arg(arg) {
                cli_paths.push(resolved_str.clone());
                initial_file = Some(resolved_str);
            }
        }
    }

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
        window_maximized_state: Mutex::new(HashMap::new()),
    };

    let app = tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            start_single_instance_ipc_server(app.handle().clone());

            // 仅监控明确的主题目录（开发环境 src/themes 或用户数据目录 themes/），
            // 严禁回退递归监控 current_dir()，彻底杜绝 Linux inotify 句柄耗尽。
            let dev_themes = std::env::current_dir()
                .ok()
                .map(|d| d.join("src").join("themes"))
                .filter(|p| p.is_dir());
            if let Some(themes_dir) = dev_themes {
                watcher::ThemeWatcher::start_theme_watcher(themes_dir, app.handle().clone());
            } else {
                let user_themes = SafeIO::resolve_app_data_root().join("themes");
                if std::fs::create_dir_all(&user_themes).is_ok() {
                    watcher::ThemeWatcher::start_theme_watcher(user_themes, app.handle().clone());
                }
            }
            Ok(())
        })
        .on_window_event(|event| {
            let window = event.window();
            match event.event() {
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
                    // 状态去重：仅当最大化状态真实变化时才向前端广播，消除缩放/拖动时的事件风暴
                    if let Ok(maximized) = window.is_maximized() {
                        let state = window.state::<AppState>();
                        let label = window.label().to_string();
                        let changed = state
                            .window_maximized_state
                            .lock()
                            .map(|mut map| {
                                let prev = map.insert(label, maximized);
                                prev != Some(maximized)
                            })
                            .unwrap_or(true);
                        if changed {
                            let _ = window.emit("window-maximized-changed", maximized);
                        }
                    }
                }
                _ => {}
            }
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
            commands::window_start_dragging,
            commands::window_start_resize_dragging,
            commands::get_window_outer_rect,
            commands::set_window_outer_rect,
            commands::get_runtime_platform_info,
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
