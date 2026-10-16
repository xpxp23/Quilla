use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct FsChangePayload {
    pub paths: Vec<String>,
    pub kind: String,
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
                println!("[ThemeWatcher] 正在监听主题目录: {:?}", theme_dir.as_ref());

                while let Ok(res) = rx.recv() {
                    match res {
                        Ok(event) => {
                            let is_css_event = event
                                .paths
                                .iter()
                                .any(|p| p.extension().map_or(false, |ext| ext == "css"));
                            if is_css_event {
                                let _ = app_handle.emit("theme-updated", ());
                            }
                        }
                        Err(e) => eprintln!("[ThemeWatcher] 错误: {:?}", e),
                    }
                }
            }
        });
    }
}

/// 工作区与活动文档磁盘变动监听器（支持动态切换监听目录，自动过滤 SafeIO 临时文件与自身保存事件）
pub struct WorkspaceWatcher {
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched_root: Mutex<Option<PathBuf>>,
    last_self_save: Arc<Mutex<Instant>>,
}

impl Default for WorkspaceWatcher {
    fn default() -> Self {
        Self {
            watcher: Mutex::new(None),
            watched_root: Mutex::new(None),
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

    pub fn watch_directory(&self, root_path: &str, app_handle: AppHandle) {
        let new_root = PathBuf::from(root_path);
        if !new_root.exists() {
            return;
        }

        if let Ok(mut cur_root) = self.watched_root.lock() {
            if cur_root.as_ref() == Some(&new_root) {
                return;
            }
            *cur_root = Some(new_root.clone());
        }

        let self_save_ref = Arc::clone(&self.last_self_save);
        let (tx, rx) = channel();

        let watcher_res: Result<RecommendedWatcher, _> =
            RecommendedWatcher::new(tx, Config::default());

        if let Ok(mut w) = watcher_res {
            if w.watch(&new_root, RecursiveMode::Recursive).is_ok() {
                if let Ok(mut guard) = self.watcher.lock() {
                    *guard = Some(w);
                }

                std::thread::spawn(move || {
                    let mut last_emit = Instant::now() - Duration::from_secs(5);
                    while let Ok(res) = rx.recv() {
                        if let Ok(event) = res {
                            // 忽略纯访问事件
                            if matches!(event.kind, EventKind::Access(_)) {
                                continue;
                            }

                            // 忽略 SafeIO 产生的 .tmp / .bak 隐藏临时文件及无关目录
                            let relevant_paths: Vec<String> = event
                                .paths
                                .iter()
                                .filter(|p| {
                                    let name = p
                                        .file_name()
                                        .unwrap_or_default()
                                        .to_string_lossy()
                                        .to_lowercase();
                                    if name.starts_with('.')
                                        || name.ends_with(".tmp")
                                        || name.ends_with(".bak")
                                    {
                                        return false;
                                    }
                                    true
                                })
                                .map(|p| p.to_string_lossy().to_string())
                                .collect();

                            if relevant_paths.is_empty() {
                                continue;
                            }

                            // 若距离自身保存不足 750ms，视为编辑器自身原子落盘，不触发外部冲突告警
                            let is_self_save = self_save_ref
                                .lock()
                                .map(|t| t.elapsed() < Duration::from_millis(750))
                                .unwrap_or(false);
                            if is_self_save {
                                continue;
                            }

                            // 节流保护（200ms 内合并高频文件事件）
                            if last_emit.elapsed() < Duration::from_millis(200) {
                                continue;
                            }
                            last_emit = Instant::now();

                            let kind_str = match event.kind {
                                EventKind::Create(_) => "create",
                                EventKind::Modify(_) => "modify",
                                EventKind::Remove(_) => "remove",
                                _ => "other",
                            }
                            .to_string();

                            let _ = app_handle.emit(
                                "workspace-fs-changed",
                                FsChangePayload {
                                    paths: relevant_paths,
                                    kind: kind_str,
                                },
                            );
                        }
                    }
                });
            }
        }
    }
}
