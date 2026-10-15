use ignore::WalkBuilder;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchMatch {
    pub file: String,
    pub line: usize,
    pub text: String,
}

pub struct SearchEngine;

impl SearchEngine {
    /// 在指定工作区目录下并发流式搜索关键词
    pub fn search_workspace<P: AsRef<Path>>(root: P, keyword: &str) -> Vec<SearchMatch> {
        let keyword_lower = keyword.to_lowercase();
        let walker = WalkBuilder::new(root)
            .hidden(true)
            .git_ignore(true)
            .build();

        // 收集所有 Markdown 和文本文件路径
        let files: Vec<_> = walker
            .filter_map(|entry| entry.ok())
            .filter(|e| {
                e.file_type().map_or(false, |ft| ft.is_file())
                    && e.path()
                        .extension()
                        .map_or(false, |ext| ext == "md" || ext == "markdown" || ext == "txt")
            })
            .map(|e| e.into_path())
            .collect();

        // 使用 Rayon 并发多线程匹配文件行
        files
            .into_par_iter()
            .flat_map(|path| {
                let mut matches = Vec::new();
                if let Ok(file) = File::open(&path) {
                    let reader = BufReader::new(file);
                    for (line_idx, line_res) in reader.lines().enumerate() {
                        if let Ok(line) = line_res {
                            if line.to_lowercase().contains(&keyword_lower) {
                                matches.push(SearchMatch {
                                    file: path.to_string_lossy().to_string(),
                                    line: line_idx + 1,
                                    text: line.trim().to_string(),
                                });
                            }
                        }
                    }
                }
                matches
            })
            .collect()
    }
}
