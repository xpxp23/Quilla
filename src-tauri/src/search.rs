use ignore::WalkBuilder;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchMatch {
    pub file: String,
    pub line: usize,
    pub text: String,
}

static BLACKLIST: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "bin",
    "obj",
    ".vs",
    ".idea",
    ".vscode",
    "AppData",
    "Windows",
    "System32",
    "Library",
    "vendor",
    "cache",
    ".cache",
    "$RECYCLE.BIN",
    "System Volume Information",
];

const MAX_SEARCH_MATCHES: usize = 500;
const MAX_LINE_PREVIEW_CHARS: usize = 220;

pub struct SearchEngine;

impl SearchEngine {
    /// 在指定工作区目录下并发流式搜索关键词（忽略扩展名大小写、过滤黑名单目录、限制最大返回数防止大目录卡死）
    pub fn search_workspace<P: AsRef<Path>>(
        root: P,
        keyword: &str,
        case_sensitive: bool,
    ) -> Vec<SearchMatch> {
        let trimmed_kw = keyword.trim();
        if trimmed_kw.is_empty() {
            return Vec::new();
        }

        let needle = if case_sensitive {
            trimmed_kw.to_string()
        } else {
            trimmed_kw.to_lowercase()
        };

        let walker = WalkBuilder::new(root)
            .hidden(true)
            .git_ignore(true)
            .max_depth(Some(8))
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                let file_name = entry.file_name().to_string_lossy();
                let lower = file_name.to_lowercase();
                if file_name.starts_with('.')
                    || lower == "assets"
                    || lower.ends_with(".assets")
                    || BLACKLIST.iter().any(|&b| file_name.eq_ignore_ascii_case(b))
                {
                    return false;
                }
                true
            })
            .build();

        let files: Vec<_> = walker
            .filter_map(|entry| entry.ok())
            .filter(|e| {
                e.file_type().map_or(false, |ft| ft.is_file())
                    && e.path().extension().map_or(false, |ext| {
                        let ext_str = ext.to_string_lossy();
                        ext_str.eq_ignore_ascii_case("md")
                            || ext_str.eq_ignore_ascii_case("markdown")
                            || ext_str.eq_ignore_ascii_case("txt")
                    })
            })
            .map(|e| e.into_path())
            .collect();

        let total_counter = AtomicUsize::new(0);

        let mut results: Vec<SearchMatch> = files
            .into_par_iter()
            .flat_map(|path| {
                if total_counter.load(Ordering::Relaxed) >= MAX_SEARCH_MATCHES {
                    return Vec::new();
                }
                let mut matches = Vec::new();
                if let Ok(file) = File::open(&path) {
                    let reader = BufReader::new(file);
                    for (line_idx, line_res) in reader.lines().enumerate() {
                        if total_counter.load(Ordering::Relaxed) >= MAX_SEARCH_MATCHES {
                            break;
                        }
                        if let Ok(line) = line_res {
                            let matched = if case_sensitive {
                                line.contains(&needle)
                            } else {
                                line.to_lowercase().contains(&needle)
                            };
                            if matched {
                                let prev = total_counter.fetch_add(1, Ordering::Relaxed);
                                if prev >= MAX_SEARCH_MATCHES {
                                    break;
                                }
                                let trimmed_line = line.trim();
                                let preview: String =
                                    trimmed_line.chars().take(MAX_LINE_PREVIEW_CHARS).collect();
                                matches.push(SearchMatch {
                                    file: path.to_string_lossy().to_string(),
                                    line: line_idx + 1,
                                    text: preview,
                                });
                            }
                        }
                    }
                }
                matches
            })
            .collect();

        results.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
        if results.len() > MAX_SEARCH_MATCHES {
            results.truncate(MAX_SEARCH_MATCHES);
        }
        results
    }
}
