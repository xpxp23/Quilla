use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct FsChangePayload {
    pub paths: Vec<String>,
    pub kind: String,
    pub window_label: String,
}

pub struct ThemeWatcher;

impl ThemeWatcher {
    /// 启动主题热重载监听器线程
    pub fn start_theme_watcher<P: AsRef<Path> + Send + 'static>(
        theme_dir: P,
        app_handle: AppHandle,
    ) {
        std::thread::spawn(move || {
            let (tx, rx) = channel();

            let watcher: Result<RecommendedWatcher, _> =
                RecommendedWatcher::new(tx, Config::default());

            if let Ok(mut watcher) = watcher {
                let _ = watcher.watch(theme_dir.as_ref(), RecursiveMode::Recursive);

                while let Ok(res) = rx.recv() {
                    if let Ok(event) = res {
                        let is_css_event = event.paths.iter().any(|p| {
                            p.extension()
                                .map_or(false, |ext| ext.eq_ignore_ascii_case("css"))
                        });
                        if is_css_event {
                            let _ = app_handle.emit("theme-updated", ());
                        }
                    }
                }
            }
        });
    }
}

struct WindowWatcherEntry {
    root: PathBuf,
    _watcher: RecommendedWatcher,
}

/// 多窗口隔离的工作区与活动文档磁盘变动监听器
/// 采用 180ms 防抖聚合（Debounce Aggregation）替代原先的丢尾节流（Drop-Tail Throttle），彻底杜绝目录事件吞掉后续文件更新事件
pub struct WorkspaceWatcher {
    watchers: Mutex<HashMap<String, WindowWatcherEntry>>,
    last_self_save: Arc<Mutex<Instant>>,
}

impl Default for WorkspaceWatcher {
    fn default() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
            last_self_save: Arc::new(Mutex::new(Instant::now() - Duration::from_secs(10))),
        }
    }
}

impl WorkspaceWatcher {
    pub fn mark_self_save(&self) {
        if let Ok(mut t) = self.last_self_save.lock() {
            *t = Instant::now();
        }
    }

    pub fn unwatch_window(&self, window_label: &str) {
        if let Ok(mut map) = self.watchers.lock() {
            map.remove(window_label);
        }
    }

    pub fn watch_directory(&self, window_label: &str, root_path: &str, app_handle: AppHandle) {
        let new_root = PathBuf::from(root_path);
        if !new_root.exists() {
            return;
        }

        if let Ok(map) = self.watchers.lock() {
            if let Some(existing) = map.get(window_label) {
                if existing.root == new_root {
                    return;
                }
            }
        }

        let self_save_ref = Arc::clone(&self.last_self_save);
        let (tx, rx) = channel();

        let watcher_res: Result<RecommendedWatcher, _> =
            RecommendedWatcher::new(tx, Config::default());

        if let Ok(mut w) = watcher_res {
            if w.watch(&new_root, RecursiveMode::Recursive).is_ok() {
                if let Ok(mut map) = self.watchers.lock() {
                    map.insert(
                        window_label.to_string(),
                        WindowWatcherEntry {
                            root: new_root,
                            _watcher: w,
                        },
                    );
                }

                let win_label = window_label.to_string();
                std::thread::spawn(move || {
                    let debounce_window = Duration::from_millis(180);
                    let mut pending_paths: HashSet<String> = HashSet::new();
                    let mut dominant_kind: &'static str = "other";

                    loop {
                        let next_event = if pending_paths.is_empty() {
                            rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
                        } else {
                            rx.recv_timeout(debounce_window)
                        };

                        match next_event {
                            Ok(Ok(event)) => {
                                if matches!(event.kind, EventKind::Access(_)) {
                                    continue;
                                }

                                let is_self_save = self_save_ref
                                    .lock()
                                    .map(|t| t.elapsed() < Duration::from_millis(750))
                                    .unwrap_or(false);
                                if is_self_save {
                                    continue;
                                }

                                for p in &event.paths {
                                    let name = p
                                        .file_name()
                                        .unwrap_or_default()
                                        .to_string_lossy()
                                        .to_lowercase();
                                    if name.starts_with('.')
                                        || name.ends_with(".tmp")
                                        || name.ends_with(".bak")
                                        || name.ends_with(".draft.json")
                                    {
                                        continue;
                                    }
                                    pending_paths.insert(p.to_string_lossy().to_string());
                                }

                                match event.kind {
                                    EventKind::Modify(_) => dominant_kind = "modify",
                                    EventKind::Create(_) if dominant_kind != "modify" => {
                                        dominant_kind = "create"
                                    }
                                    EventKind::Remove(_)
                                        if dominant_kind != "modify"
                                            && dominant_kind != "create" =>
                                    {
                                        dominant_kind = "remove"
                                    }
                                    _ => {}
                                }
                            }
                            Ok(Err(_)) => continue,
                            Err(RecvTimeoutError::Timeout) => {
                                if !pending_paths.is_empty() {
                                    let paths: Vec<String> = pending_paths.drain().collect();
                                    let kind_str = dominant_kind.to_string();
                                    dominant_kind = "other";

                                    let _ = app_handle.emit_to(
                                        &win_label,
                                        "workspace-fs-changed",
                                        FsChangePayload {
                                            paths,
                                            kind: kind_str,
                                            window_label: win_label.clone(),
                                        },
                                    );
                                }
                            }
                            Err(RecvTimeoutError::Disconnected) => break,
                        }
                    }
                });
            }
        }
    }
}
