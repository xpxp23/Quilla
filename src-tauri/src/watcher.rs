use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc::channel;
use tauri::{AppHandle, Emitter};

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
                            // 过滤只处理 .css 文件变动
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
