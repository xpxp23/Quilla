use ignore::WalkBuilder;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchMatch {
    pub file: String,
    #[serde(rename = "file_name")]
    pub file_name: String,
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagSummary {
    pub tag: String,
    pub count: usize,
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub path: Option<String>,
    pub exists: bool,
    #[serde(rename = "isCenter")]
    pub is_center: bool,
    pub degree: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeGraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
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
    pub fn collect_markdown_files<P: AsRef<Path>>(root: P) -> Vec<PathBuf> {
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

        walker
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
            .collect()
    }

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

        let files = Self::collect_markdown_files(root);
        let total_counter = AtomicUsize::new(0);

        let mut results: Vec<SearchMatch> = files
            .into_par_iter()
            .flat_map(|path| {
                if total_counter.load(Ordering::Relaxed) >= MAX_SEARCH_MATCHES {
                    return Vec::new();
                }
                let file_name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
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
                                    file_name: file_name.clone(),
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

    /// 多线程检索指向目标文档的双向链接与 Markdown 引用 ([[Target]] / ![[Target]] / [[Target#Heading]] / [[Target|Alias]] / ](...Target.md))
    pub fn search_backlinks<P: AsRef<Path>>(
        root: P,
        target_name: &str,
        exclude_file_path: Option<&str>,
    ) -> Vec<SearchMatch> {
        let stem = Path::new(target_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(target_name)
            .trim()
            .to_lowercase();
        if stem.is_empty() {
            return Vec::new();
        }

        let norm_exclude = exclude_file_path
            .map(|p| p.replace('\\', "/").to_lowercase())
            .unwrap_or_default();

        let wiki_exact = format!("[[{}]]", stem);
        let wiki_hash = format!("[[{}#", stem);
        let wiki_pipe = format!("[[{}|", stem);
        let wiki_ext = format!("[[{}.md", stem);
        let md_link_1 = format!("]({}.md", stem);
        let md_link_2 = format!("/{}.md", stem);

        let files = Self::collect_markdown_files(root);
        let total_counter = AtomicUsize::new(0);

        let mut results: Vec<SearchMatch> = files
            .into_par_iter()
            .flat_map(|path| {
                if total_counter.load(Ordering::Relaxed) >= 200 {
                    return Vec::new();
                }
                let path_str = path.to_string_lossy().to_string();
                if !norm_exclude.is_empty()
                    && path_str.replace('\\', "/").to_lowercase() == norm_exclude
                {
                    return Vec::new();
                }
                let file_name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                let mut matches = Vec::new();
                if let Ok(file) = File::open(&path) {
                    let reader = BufReader::new(file);
                    for (line_idx, line_res) in reader.lines().enumerate() {
                        if let Ok(line) = line_res {
                            let lower = line.to_lowercase();
                            if lower.contains(&wiki_exact)
                                || lower.contains(&wiki_hash)
                                || lower.contains(&wiki_pipe)
                                || lower.contains(&wiki_ext)
                                || lower.contains(&md_link_1)
                                || lower.contains(&md_link_2)
                            {
                                let prev = total_counter.fetch_add(1, Ordering::Relaxed);
                                if prev >= 200 {
                                    break;
                                }
                                let preview: String =
                                    line.trim().chars().take(MAX_LINE_PREVIEW_CHARS).collect();
                                matches.push(SearchMatch {
                                    file: path_str.clone(),
                                    file_name: file_name.clone(),
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
        results
    }

    /// 扫描工作区全部标签 (#tag / #parent/child 及 YAML front matter tags)
    pub fn scan_workspace_tags<P: AsRef<Path>>(root: P) -> Vec<TagSummary> {
        let files = Self::collect_markdown_files(root);
        let per_file_hits: Vec<Vec<(String, SearchMatch)>> = files
            .into_par_iter()
            .map(|path| {
                let mut hits = Vec::new();
                let path_str = path.to_string_lossy().to_string();
                let file_name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if let Ok(content) = fs::read_to_string(&path) {
                    let lines: Vec<&str> = content.lines().collect();
                    let mut in_fence = false;
                    let mut in_yaml = false;
                    for (idx, &raw_line) in lines.iter().enumerate() {
                        let trimmed = raw_line.trim();
                        if idx == 0 && trimmed == "---" {
                            in_yaml = true;
                            continue;
                        }
                        if in_yaml {
                            if trimmed == "---" || trimmed == "..." {
                                in_yaml = false;
                                continue;
                            }
                            if let Some(rest) = trimmed.strip_prefix("tags:") {
                                let clean = rest.trim().trim_matches(|c| c == '[' || c == ']');
                                for part in clean.split(',') {
                                    let t = part.trim().trim_matches(|c| c == '"' || c == '\'' || c == '#');
                                    if !t.is_empty() {
                                        hits.push((
                                            t.to_string(),
                                            SearchMatch {
                                                file: path_str.clone(),
                                                file_name: file_name.clone(),
                                                line: idx + 1,
                                                text: trimmed.chars().take(160).collect(),
                                            },
                                        ));
                                    }
                                }
                            }
                            continue;
                        }
                        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                            in_fence = !in_fence;
                            continue;
                        }
                        if in_fence {
                            continue;
                        }
                        // 提取行内 #标签（排除 # 标题与 URL 锚点）
                        let chars: Vec<char> = raw_line.chars().collect();
                        let mut i = 0;
                        while i < chars.len() {
                            if chars[i] == '`' {
                                i += 1;
                                while i < chars.len() && chars[i] != '`' {
                                    i += 1;
                                }
                                i += 1;
                                continue;
                            }
                            if chars[i] == '#' {
                                let prev_ok = i == 0 || chars[i - 1].is_whitespace();
                                if prev_ok && i + 1 < chars.len() && !chars[i + 1].is_whitespace() && chars[i + 1] != '#' && chars[i + 1] != '[' {
                                    let start = i + 1;
                                    let mut end = start;
                                    while end < chars.len() {
                                        let c = chars[end];
                                        if c.is_alphanumeric() || c == '_' || c == '-' || c == '/' || ('\u{4e00}'..='\u{9fa5}').contains(&c) {
                                            end += 1;
                                        } else {
                                            break;
                                        }
                                    }
                                    if end > start {
                                        let tag_str: String = chars[start..end].iter().collect();
                                        // 排除纯数字如 #123 或纯色值
                                        if !tag_str.chars().all(|c| c.is_ascii_digit()) {
                                            hits.push((
                                                tag_str,
                                                SearchMatch {
                                                    file: path_str.clone(),
                                                    file_name: file_name.clone(),
                                                    line: idx + 1,
                                                    text: trimmed.chars().take(160).collect(),
                                                },
                                            ));
                                        }
                                        i = end;
                                        continue;
                                    }
                                }
                            }
                            i += 1;
                        }
                    }
                }
                hits
            })
            .collect();

        let mut map: HashMap<String, Vec<SearchMatch>> = HashMap::new();
        for file_hits in per_file_hits {
            for (tag, m) in file_hits {
                map.entry(tag).or_default().push(m);
            }
        }

        let mut summaries: Vec<TagSummary> = map
            .into_iter()
            .map(|(tag, matches)| TagSummary {
                tag,
                count: matches.len(),
                matches,
            })
            .collect();
        summaries.sort_by(|a, b| b.count.cmp(&a.count).then(a.tag.cmp(&b.tag)));
        summaries
    }

    /// 构建工作区双链知识图谱数据 (Nodes & Edges)
    pub fn build_knowledge_graph<P: AsRef<Path>>(
        root: P,
        center_file_path: Option<&str>,
    ) -> KnowledgeGraphData {
        let files = Self::collect_markdown_files(root);
        let center_stem = center_file_path
            .and_then(|p| Path::new(p).file_stem())
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();

        let mut stem_to_path: HashMap<String, (String, String)> = HashMap::new();
        for p in &files {
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                stem_to_path.insert(
                    stem.to_lowercase(),
                    (stem.to_string(), p.to_string_lossy().to_string()),
                );
            }
        }

        let extracted_links: Vec<(String, Vec<(String, String)>)> = files
            .par_iter()
            .filter_map(|path| {
                let src_stem = path.file_stem()?.to_str()?.to_lowercase();
                let content = fs::read_to_string(path).ok()?;
                let mut links = Vec::new();
                let mut pos = 0;
                let bytes = content.as_bytes();
                while pos + 3 < bytes.len() {
                    if bytes[pos] == b'[' && bytes[pos + 1] == b'[' {
                        let is_embed = pos > 0 && bytes[pos - 1] == b'!';
                        if let Some(rel_end) = content[pos + 2..].find("]]") {
                            let inner = &content[pos + 2..pos + 2 + rel_end];
                            if !inner.contains('\n') {
                                let before_pipe = inner.split('|').next().unwrap_or("");
                                let target_doc = before_pipe
                                    .split('#')
                                    .next()
                                    .unwrap_or("")
                                    .trim()
                                    .trim_end_matches(".md")
                                    .to_lowercase();
                                if !target_doc.is_empty() && target_doc != src_stem {
                                    links.push((
                                        target_doc,
                                        if is_embed {
                                            "embed".to_string()
                                        } else {
                                            "wikilink".to_string()
                                        },
                                    ));
                                }
                            }
                            pos += 2 + rel_end + 2;
                            continue;
                        }
                    }
                    pos += 1;
                }
                Some((src_stem, links))
            })
            .collect();

        let mut edges = Vec::new();
        let mut seen_edges = HashSet::new();
        let mut degree_map: HashMap<String, usize> = HashMap::new();
        let mut missing_nodes: HashSet<String> = HashSet::new();

        for (src, targets) in extracted_links {
            for (tgt, kind) in targets {
                let edge_key = format!("{}->{}", src, tgt);
                if seen_edges.insert(edge_key) {
                    *degree_map.entry(src.clone()).or_insert(0) += 1;
                    *degree_map.entry(tgt.clone()).or_insert(0) += 1;
                    if !stem_to_path.contains_key(&tgt) {
                        missing_nodes.insert(tgt.clone());
                    }
                    edges.push(GraphEdge {
                        source: src.clone(),
                        target: tgt,
                        kind,
                    });
                }
            }
        }

        // 若传入了当前聚焦文档且节点过多，优先过滤出与当前文档 1~2 跳关联的子图（若关联为空则展示全图前 60 个核心节点）
        let mut allowed_ids: HashSet<String> = HashSet::new();
        if !center_stem.is_empty() {
            allowed_ids.insert(center_stem.clone());
            for e in &edges {
                if e.source == center_stem {
                    allowed_ids.insert(e.target.clone());
                } else if e.target == center_stem {
                    allowed_ids.insert(e.source.clone());
                }
            }
            // 二跳扩展
            let hop1 = allowed_ids.clone();
            for e in &edges {
                if hop1.contains(&e.source) || hop1.contains(&e.target) {
                    allowed_ids.insert(e.source.clone());
                    allowed_ids.insert(e.target.clone());
                }
            }
        }

        let filter_by_hop = allowed_ids.len() > 1;
        let mut nodes = Vec::new();

        for (id, (label, path)) in &stem_to_path {
            if filter_by_hop && !allowed_ids.contains(id) {
                continue;
            }
            nodes.push(GraphNode {
                id: id.clone(),
                label: label.clone(),
                path: Some(path.clone()),
                exists: true,
                is_center: *id == center_stem,
                degree: *degree_map.get(id).unwrap_or(&0),
            });
        }

        for missing in missing_nodes {
            if filter_by_hop && !allowed_ids.contains(&missing) {
                continue;
            }
            let degree = *degree_map.get(&missing).unwrap_or(&1);
            nodes.push(GraphNode {
                id: missing.clone(),
                label: missing,
                path: None,
                exists: false,
                is_center: false,
                degree,
            });
        }

        nodes.sort_by(|a, b| {
            b.is_center
                .cmp(&a.is_center)
                .then(b.degree.cmp(&a.degree))
                .then(a.label.cmp(&b.label))
        });
        if nodes.len() > 80 {
            nodes.truncate(80);
        }
        let valid_node_ids: HashSet<String> = nodes.iter().map(|n| n.id.clone()).collect();
        edges.retain(|e| valid_node_ids.contains(&e.source) && valid_node_ids.contains(&e.target));

        KnowledgeGraphData { nodes, edges }
    }
}
