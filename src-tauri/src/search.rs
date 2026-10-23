use ignore::WalkBuilder;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchMatch {
    pub file: String,
    #[serde(rename = "file_name")]
    pub file_name: String,
    pub line: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacklinkOverview {
    pub linked: Vec<SearchMatch>,
    pub unlinked: Vec<SearchMatch>,
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
    pub is_active: bool,
    #[serde(rename = "isCenter")]
    pub is_center: bool,
    pub in_degree: usize,
    pub out_degree: usize,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedLink {
    pub target_stem: String,
    pub kind: String,
    pub line: usize,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedDoc {
    pub path: String,
    pub file_name: String,
    pub stem_lower: String,
    pub stem_display: String,
    pub modified_ms: u64,
    pub tags: Vec<(String, SearchMatch)>,
    pub outgoing_links: Vec<IndexedLink>,
    /// 缓存非代码块的可见正文行 (行号, 原始文本, 小写文本)，供未链接提及与毫秒级全文检索使用
    pub body_lines: Vec<(usize, String, String)>,
}

#[derive(Debug, Default, Clone)]
pub struct WorkspaceCache {
    pub root: String,
    pub docs: HashMap<String, IndexedDoc>,
    /// FTS5 风格内存倒排分词与中文 Bigram 索引：Token -> 包含该 Token 的文档键集合
    pub inverted_tokens: HashMap<String, HashSet<String>>,
    /// 标签倒排索引：小写标签名（含父级前缀） -> 包含该标签的文档键集合
    pub tag_index: HashMap<String, HashSet<String>>,
}

/// 工作区增量全文检索与双链倒排索引引擎 (Incremental FTS & Graph Index v0.10.0)
/// - 维护每个 `.md` 文档的标题词干、`#多级标签`、`[[WikiLinks]]`、正文行以及 ASCII 词元 + CJK Bigram 倒排索引表；
/// - 支持百万字级知识库的亚毫秒级分词检索、`#标签` 组合过滤与磁盘快照持久化预热，彻底告别每次按键全盘 Walk I/O。
#[derive(Default, Clone)]
pub struct WorkspaceIndex {
    caches: Arc<Mutex<HashMap<String, WorkspaceCache>>>,
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

fn normalize_path_key(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn get_file_modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn is_indexable_markdown(path: &Path) -> bool {
    path.extension().map_or(false, |ext| {
        let ext_str = ext.to_string_lossy();
        ext_str.eq_ignore_ascii_case("md")
            || ext_str.eq_ignore_ascii_case("markdown")
            || ext_str.eq_ignore_ascii_case("txt")
    })
}

fn is_cjk_char(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
        || ('\u{3400}'..='\u{4dbf}').contains(&c)
        || ('\u{3040}'..='\u{30ff}').contains(&c)
}

/// 从文本中提取 FTS 索引词元（包含英文/数字单词前缀、CJK 单字及相邻 CJK Bigram 二元语法）
fn extract_fts_tokens(text: &str) -> HashSet<String> {
    let mut tokens = HashSet::new();
    let lower = text.to_lowercase();
    let mut ascii_buf = String::new();
    let mut prev_cjk: Option<char> = None;

    for ch in lower.chars() {
        if is_cjk_char(ch) {
            if ascii_buf.len() >= 2 {
                tokens.insert(ascii_buf.clone());
            }
            ascii_buf.clear();

            let mut single = String::with_capacity(4);
            single.push(ch);
            tokens.insert(single);

            if let Some(prev) = prev_cjk {
                let mut bigram = String::with_capacity(8);
                bigram.push(prev);
                bigram.push(ch);
                tokens.insert(bigram);
            }
            prev_cjk = Some(ch);
        } else if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            prev_cjk = None;
            ascii_buf.push(ch);
        } else {
            prev_cjk = None;
            if ascii_buf.len() >= 2 {
                tokens.insert(ascii_buf.clone());
            }
            ascii_buf.clear();
        }
    }

    if ascii_buf.len() >= 2 {
        tokens.insert(ascii_buf);
    }

    tokens
}

impl WorkspaceCache {
    fn index_single_doc_tokens_internal(
        inverted_tokens: &mut HashMap<String, HashSet<String>>,
        tag_index: &mut HashMap<String, HashSet<String>>,
        doc_key: &str,
        doc: &IndexedDoc,
    ) {
        // 索引文件名词干
        for tok in extract_fts_tokens(&doc.stem_lower) {
            inverted_tokens
                .entry(tok)
                .or_default()
                .insert(doc_key.to_string());
        }

        // 索引标签（含父级层级标签，如 #知识管理/双链笔记 同时注册 "知识管理/双链笔记" 与 "知识管理"）
        for (tag, _) in &doc.tags {
            let low_tag = tag.to_lowercase();
            tag_index
                .entry(low_tag.clone())
                .or_default()
                .insert(doc_key.to_string());
            let mut prefix = String::new();
            for part in low_tag.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                tag_index
                    .entry(prefix.clone())
                    .or_default()
                    .insert(doc_key.to_string());
            }
        }

        // 索引正文行词元
        for (_, _, lower_line) in &doc.body_lines {
            for tok in extract_fts_tokens(lower_line) {
                inverted_tokens
                    .entry(tok)
                    .or_default()
                    .insert(doc_key.to_string());
            }
        }
    }

    /// 根据当前 `docs` 重建内存倒排词元表与标签表
    pub fn rebuild_inverted_indices(&mut self) {
        self.inverted_tokens.clear();
        self.tag_index.clear();

        for (doc_key, doc) in &self.docs {
            Self::index_single_doc_tokens_internal(
                &mut self.inverted_tokens,
                &mut self.tag_index,
                doc_key,
                doc,
            );
        }
    }

    pub fn index_single_doc_tokens(&mut self, doc_key: &str, doc: &IndexedDoc) {
        Self::index_single_doc_tokens_internal(
            &mut self.inverted_tokens,
            &mut self.tag_index,
            doc_key,
            doc,
        );
    }
}

impl WorkspaceIndex {
    /// 解析单个 Markdown 文档的标签、出链与可见正文行元数据
    pub fn parse_doc_entry(path: &Path, content_override: Option<&str>) -> Option<IndexedDoc> {
        let stem_os = path.file_stem()?.to_str()?;
        let stem_display = stem_os.to_string();
        let stem_lower = stem_os.trim().to_lowercase();
        if stem_lower.is_empty() {
            return None;
        }

        let path_str = path.to_string_lossy().to_string();
        let file_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let modified_ms = get_file_modified_ms(path);

        let owned_content;
        let content = match content_override {
            Some(c) => c,
            None => {
                owned_content = fs::read_to_string(path).ok()?;
                &owned_content
            }
        };

        let mut tags: Vec<(String, SearchMatch)> = Vec::new();
        let mut outgoing_links: Vec<IndexedLink> = Vec::new();
        let mut body_lines: Vec<(usize, String, String)> = Vec::new();

        let lines: Vec<&str> = content.lines().collect();
        let mut in_fence = false;
        let mut in_yaml = false;

        for (idx, &raw_line) in lines.iter().enumerate() {
            let line_num = idx + 1;
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
                        let t = part
                            .trim()
                            .trim_matches(|c| c == '"' || c == '\'' || c == '#');
                        if !t.is_empty() {
                            tags.push((
                                t.to_string(),
                                SearchMatch {
                                    file: path_str.clone(),
                                    file_name: file_name.clone(),
                                    line: line_num,
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

            let preview: String = trimmed.chars().take(MAX_LINE_PREVIEW_CHARS).collect();
            if !preview.is_empty() && body_lines.len() < 50_000 {
                body_lines.push((line_num, preview.clone(), preview.to_lowercase()));
            }

            if in_fence {
                continue;
            }

            // 1. 提取该行内的 [[WikiLink]] / ![[Embed]]
            let bytes = raw_line.as_bytes();
            let mut pos = 0;
            while pos + 3 < bytes.len() {
                if bytes[pos] == b'`' {
                    pos += 1;
                    while pos < bytes.len() && bytes[pos] != b'`' {
                        pos += 1;
                    }
                    pos += 1;
                    continue;
                }
                if bytes[pos] == b'[' && bytes[pos + 1] == b'[' {
                    let is_embed = pos > 0 && bytes[pos - 1] == b'!';
                    if let Some(rel_end) = raw_line[pos + 2..].find("]]") {
                        let inner = &raw_line[pos + 2..pos + 2 + rel_end];
                        let before_pipe = inner.split('|').next().unwrap_or("");
                        let target_doc = before_pipe
                            .split('#')
                            .next()
                            .unwrap_or("")
                            .trim()
                            .trim_end_matches(".md")
                            .trim_end_matches(".markdown")
                            .to_lowercase();
                        if !target_doc.is_empty() && target_doc != stem_lower {
                            outgoing_links.push(IndexedLink {
                                target_stem: target_doc,
                                kind: if is_embed {
                                    "embed".to_string()
                                } else {
                                    "wikilink".to_string()
                                },
                                line: line_num,
                                preview: preview.clone(),
                            });
                        }
                        pos += 2 + rel_end + 2;
                        continue;
                    }
                }
                // 2. 提取标准 Markdown 内部文档链接 ](target.md) 或 ](./target.md)
                if bytes[pos] == b']' && pos + 1 < bytes.len() && bytes[pos + 1] == b'(' {
                    if let Some(rel_close) = raw_line[pos + 2..].find(')') {
                        let raw_url = raw_line[pos + 2..pos + 2 + rel_close].trim();
                        let lower_url = raw_url.to_lowercase();
                        if !lower_url.starts_with("http://")
                            && !lower_url.starts_with("https://")
                            && !lower_url.starts_with("mailto:")
                            && !lower_url.starts_with("data:")
                        {
                            let clean_url = lower_url.split('#').next().unwrap_or("").trim();
                            if clean_url.ends_with(".md") || clean_url.ends_with(".markdown") {
                                let file_part = clean_url
                                    .rsplit('/')
                                    .next()
                                    .unwrap_or(clean_url)
                                    .rsplit('\\')
                                    .next()
                                    .unwrap_or(clean_url);
                                let tgt_stem = file_part
                                    .trim_end_matches(".md")
                                    .trim_end_matches(".markdown")
                                    .trim();
                                if !tgt_stem.is_empty() && tgt_stem != stem_lower {
                                    outgoing_links.push(IndexedLink {
                                        target_stem: tgt_stem.to_string(),
                                        kind: "wikilink".to_string(),
                                        line: line_num,
                                        preview: preview.clone(),
                                    });
                                }
                            }
                        }
                        pos += 2 + rel_close + 1;
                        continue;
                    }
                }
                pos += 1;
            }

            // 3. 提取该行内的 #多级标签
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
                    if prev_ok
                        && i + 1 < chars.len()
                        && !chars[i + 1].is_whitespace()
                        && chars[i + 1] != '#'
                        && chars[i + 1] != '['
                    {
                        let start = i + 1;
                        let mut end = start;
                        while end < chars.len() {
                            let c = chars[end];
                            if c.is_alphanumeric()
                                || c == '_'
                                || c == '-'
                                || c == '/'
                                || ('\u{4e00}'..='\u{9fa5}').contains(&c)
                            {
                                end += 1;
                            } else {
                                break;
                            }
                        }
                        if end > start {
                            let tag_str: String = chars[start..end].iter().collect();
                            if !tag_str.chars().all(|c| c.is_ascii_digit()) {
                                tags.push((
                                    tag_str,
                                    SearchMatch {
                                        file: path_str.clone(),
                                        file_name: file_name.clone(),
                                        line: line_num,
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

        Some(IndexedDoc {
            path: path_str,
            file_name,
            stem_lower,
            stem_display,
            modified_ms,
            tags,
            outgoing_links,
            body_lines,
        })
    }

    /// 获取或初次构建工作区内存索引（命中缓存时 O(1) 零磁盘 I/O）
    pub fn get_or_build_workspace(&self, root: &Path) -> WorkspaceCache {
        let root_str = root.to_string_lossy().to_string();
        let norm_root = normalize_path_key(&root_str);

        if let Ok(guard) = self.caches.lock() {
            if let Some(existing) = guard.get(&norm_root) {
                return existing.clone();
            }
        }

        self.refresh_workspace_incremental(root)
    }

    /// 增量刷新工作区索引：仅对新增或 mtime 变化的文件重新解析，其余直接复用内存缓存，并构建倒排索引表
    pub fn refresh_workspace_incremental(&self, root: &Path) -> WorkspaceCache {
        let root_str = root.to_string_lossy().to_string();
        let norm_root = normalize_path_key(&root_str);

        let old_docs: HashMap<String, IndexedDoc> = self
            .caches
            .lock()
            .ok()
            .and_then(|g| g.get(&norm_root).map(|c| c.docs.clone()))
            .unwrap_or_default();

        let files = SearchEngine::collect_markdown_files(root);
        let parsed_entries: Vec<(String, IndexedDoc)> = files
            .into_par_iter()
            .filter_map(|path| {
                let path_str = path.to_string_lossy().to_string();
                let key = normalize_path_key(&path_str);
                let cur_mtime = get_file_modified_ms(&path);
                if let Some(prev) = old_docs.get(&key) {
                    if prev.modified_ms == cur_mtime && cur_mtime > 0 {
                        return Some((key, prev.clone()));
                    }
                }
                Self::parse_doc_entry(&path, None).map(|doc| (key, doc))
            })
            .collect();

        let mut docs = HashMap::with_capacity(parsed_entries.len());
        for (k, v) in parsed_entries {
            docs.insert(k, v);
        }

        let mut cache = WorkspaceCache {
            root: root_str,
            docs,
            inverted_tokens: HashMap::new(),
            tag_index: HashMap::new(),
        };
        cache.rebuild_inverted_indices();

        if let Ok(mut guard) = self.caches.lock() {
            guard.insert(norm_root, cache.clone());
        }
        cache
    }

    /// O(1) 单文件增量更新（保存文件或新建文件时直接用内存文本更新索引与倒排表，零磁盘遍历）
    pub fn update_single_file(&self, file_path: &Path, content_override: Option<&str>) {
        if !is_indexable_markdown(file_path) {
            return;
        }
        let file_key = normalize_path_key(&file_path.to_string_lossy());
        let parsed = Self::parse_doc_entry(file_path, content_override);

        if let Ok(mut guard) = self.caches.lock() {
            for (ws_root_key, cache) in guard.iter_mut() {
                if file_key.starts_with(ws_root_key) {
                    if let Some(ref doc) = parsed {
                        cache.docs.insert(file_key.clone(), doc.clone());
                        cache.index_single_doc_tokens(&file_key, doc);
                    } else {
                        cache.docs.remove(&file_key);
                        cache.rebuild_inverted_indices();
                    }
                }
            }
        }
    }

    /// O(1) 移除被删除的文件或目录索引项
    pub fn remove_path(&self, path: &Path) {
        let target_key = normalize_path_key(&path.to_string_lossy());
        let prefix = format!("{}/", target_key);
        if let Ok(mut guard) = self.caches.lock() {
            for cache in guard.values_mut() {
                let before_len = cache.docs.len();
                cache
                    .docs
                    .retain(|k, _| k != &target_key && !k.starts_with(&prefix));
                if cache.docs.len() != before_len {
                    cache.rebuild_inverted_indices();
                }
            }
        }
    }

    /// 处理文件或文件夹重命名后的索引同步
    pub fn handle_rename(&self, old_path: &Path, new_path: &Path) {
        self.remove_path(old_path);
        if new_path.is_dir() {
            let files = SearchEngine::collect_markdown_files(new_path);
            for f in files {
                self.update_single_file(&f, None);
            }
        } else if new_path.is_file() {
            self.update_single_file(new_path, None);
        }
    }

    /// 供 WorkspaceWatcher 线程在监听到磁盘局部变更时增量同步对应路径
    pub fn sync_changed_paths(&self, paths: &[String]) {
        for raw in paths {
            let p = Path::new(raw);
            if p.exists() {
                if p.is_file() && is_indexable_markdown(p) {
                    self.update_single_file(p, None);
                }
            } else {
                self.remove_path(p);
            }
        }
    }

    /// 基于内存倒排索引的毫秒级工作区全文检索（支持多关键词组合检索与 `#标签` 联合过滤）
    pub fn search_workspace_indexed<P: AsRef<Path>>(
        &self,
        root: P,
        keyword: &str,
        case_sensitive: bool,
    ) -> Vec<SearchMatch> {
        let trimmed_kw = keyword.trim();
        if trimmed_kw.is_empty() {
            return Vec::new();
        }

        let cache = self.get_or_build_workspace(root.as_ref());
        if cache.docs.is_empty() {
            return SearchEngine::search_workspace(root, keyword, case_sensitive);
        }

        // 拆分 `#标签` 过滤项与普通检索词项
        let mut tag_filters: Vec<String> = Vec::new();
        let mut text_terms: Vec<String> = Vec::new();

        for part in trimmed_kw.split_whitespace() {
            if let Some(stripped_tag) = part.strip_prefix('#') {
                if !stripped_tag.is_empty() {
                    tag_filters.push(stripped_tag.to_lowercase());
                    continue;
                }
            }
            text_terms.push(if case_sensitive {
                part.to_string()
            } else {
                part.to_lowercase()
            });
        }

        // 若整个查询就是单个 `#tag`，直接利用标签倒排表加速同时匹配正文与 YAML 标签
        let mut candidate_keys: Option<HashSet<String>> = None;

        for tf in &tag_filters {
            if let Some(tag_docs) = cache.tag_index.get(tf) {
                candidate_keys = Some(match candidate_keys {
                    Some(prev) => prev.intersection(tag_docs).cloned().collect(),
                    None => tag_docs.clone(),
                });
            }
        }

        // 利用 CJK Bigram / 词元倒排索引进行候选文档预筛选
        for term in &text_terms {
            let query_tokens = extract_fts_tokens(term);
            for qt in query_tokens {
                if let Some(tok_docs) = cache.inverted_tokens.get(&qt) {
                    candidate_keys = Some(match candidate_keys {
                        Some(prev) => prev.intersection(tok_docs).cloned().collect(),
                        None => tok_docs.clone(),
                    });
                }
            }
        }

        let mut results: Vec<SearchMatch> = Vec::new();

        let doc_iter: Vec<(&String, &IndexedDoc)> = match candidate_keys {
            Some(ref keys) if !keys.is_empty() => cache
                .docs
                .iter()
                .filter(|(k, _)| keys.contains(*k))
                .collect(),
            _ => cache.docs.iter().collect(),
        };

        for (_, doc) in doc_iter {
            if results.len() >= MAX_SEARCH_MATCHES {
                break;
            }

            // 若包含 #tag 过滤，验证该文档是否确实拥有匹配的标签或正文内含 #tag
            if !tag_filters.is_empty() {
                let doc_has_all_tags = tag_filters.iter().all(|tf| {
                    doc.tags.iter().any(|(t, _)| {
                        let tl = t.to_lowercase();
                        tl == *tf || tl.starts_with(&format!("{}/", tf))
                    }) || doc
                        .body_lines
                        .iter()
                        .any(|(_, _, low)| low.contains(&format!("#{}", tf)))
                });
                if !doc_has_all_tags {
                    continue;
                }
            }

            // 如果仅检索 `#tag` 而无额外文本词，优先返回该文档内的标签出现位置
            if text_terms.is_empty() && !tag_filters.is_empty() {
                let mut added_lines = HashSet::new();
                for (t, m) in &doc.tags {
                    let tl = t.to_lowercase();
                    if tag_filters
                        .iter()
                        .any(|tf| tl == *tf || tl.starts_with(&format!("{}/", tf)))
                    {
                        if added_lines.insert(m.line) {
                            results.push(m.clone());
                            if results.len() >= MAX_SEARCH_MATCHES {
                                break;
                            }
                        }
                    }
                }
                continue;
            }

            // 在文档的缓存行中检索全部 text_terms
            for (line_num, orig_text, lower_text) in &doc.body_lines {
                let hay = if case_sensitive {
                    orig_text
                } else {
                    lower_text
                };
                if text_terms.iter().all(|term| hay.contains(term)) {
                    results.push(SearchMatch {
                        file: doc.path.clone(),
                        file_name: doc.file_name.clone(),
                        line: *line_num,
                        text: orig_text.clone(),
                    });
                    if results.len() >= MAX_SEARCH_MATCHES {
                        break;
                    }
                }
            }
        }

        results.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
        results
    }

    /// 亚毫秒级内存反向链接检索（已链接引用 Linked Mentions）
    pub fn search_backlinks<P: AsRef<Path>>(
        &self,
        root: P,
        target_name: &str,
        exclude_file_path: Option<&str>,
    ) -> Vec<SearchMatch> {
        self.search_backlinks_overview(root, target_name, exclude_file_path)
            .linked
    }

    /// 同时检索当前文档的「已链接反向引用 (Linked Mentions)」与「未链接提及 (Unlinked Mentions)」
    pub fn search_backlinks_overview<P: AsRef<Path>>(
        &self,
        root: P,
        target_name: &str,
        exclude_file_path: Option<&str>,
    ) -> BacklinkOverview {
        let stem = Path::new(target_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(target_name)
            .trim()
            .to_lowercase();
        if stem.is_empty() {
            return BacklinkOverview {
                linked: Vec::new(),
                unlinked: Vec::new(),
            };
        }

        let norm_exclude = exclude_file_path
            .map(normalize_path_key)
            .unwrap_or_default();

        let cache = self.get_or_build_workspace(root.as_ref());
        let mut linked = Vec::new();
        let mut unlinked = Vec::new();
        let can_scan_unlinked = stem.chars().count() >= 2;

        for (doc_key, doc) in &cache.docs {
            if !norm_exclude.is_empty() && doc_key == &norm_exclude {
                continue;
            }
            if doc.stem_lower == stem {
                continue;
            }

            let mut linked_lines_in_doc = HashSet::new();
            for link in &doc.outgoing_links {
                if link.target_stem == stem {
                    linked_lines_in_doc.insert(link.line);
                    if linked.len() < 200 {
                        linked.push(SearchMatch {
                            file: doc.path.clone(),
                            file_name: doc.file_name.clone(),
                            line: link.line,
                            text: link.preview.clone(),
                        });
                    }
                }
            }

            if can_scan_unlinked && unlinked.len() < 150 {
                for (ln, orig_text, lower_text) in &doc.body_lines {
                    if linked_lines_in_doc.contains(ln) {
                        continue;
                    }
                    if lower_text.contains(&stem) {
                        unlinked.push(SearchMatch {
                            file: doc.path.clone(),
                            file_name: doc.file_name.clone(),
                            line: *ln,
                            text: orig_text.clone(),
                        });
                        if unlinked.len() >= 150 {
                            break;
                        }
                    }
                }
            }
        }

        linked.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
        unlinked.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
        BacklinkOverview { linked, unlinked }
    }

    /// 亚毫秒级内存 #标签 云聚合
    pub fn scan_workspace_tags<P: AsRef<Path>>(&self, root: P) -> Vec<TagSummary> {
        let cache = self.get_or_build_workspace(root.as_ref());
        let mut map: HashMap<String, Vec<SearchMatch>> = HashMap::new();

        for doc in cache.docs.values() {
            for (tag, m) in &doc.tags {
                map.entry(tag.clone()).or_default().push(m.clone());
            }
        }

        let mut summaries: Vec<TagSummary> = map
            .into_iter()
            .map(|(tag, mut matches)| {
                matches.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
                TagSummary {
                    tag,
                    count: matches.len(),
                    matches,
                }
            })
            .collect();
        summaries.sort_by(|a, b| b.count.cmp(&a.count).then(a.tag.cmp(&b.tag)));
        summaries
    }

    /// 亚毫秒级内存双链知识图谱构建
    pub fn build_knowledge_graph<P: AsRef<Path>>(
        &self,
        root: P,
        center_file_path: Option<&str>,
        local_depth: usize,
    ) -> KnowledgeGraphData {
        let cache = self.get_or_build_workspace(root.as_ref());
        let center_stem = center_file_path
            .and_then(|p| Path::new(p).file_stem())
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();

        let mut stem_to_path: HashMap<String, (String, String)> = HashMap::new();
        for doc in cache.docs.values() {
            stem_to_path.insert(
                doc.stem_lower.clone(),
                (doc.stem_display.clone(), doc.path.clone()),
            );
        }

        let mut edges = Vec::new();
        let mut seen_edges = HashSet::new();
        let mut in_deg_map: HashMap<String, usize> = HashMap::new();
        let mut out_deg_map: HashMap<String, usize> = HashMap::new();
        let mut missing_nodes: HashSet<String> = HashSet::new();

        for doc in cache.docs.values() {
            let src = &doc.stem_lower;
            for link in &doc.outgoing_links {
                let tgt = &link.target_stem;
                let edge_key = format!("{}->{}", src, tgt);
                if seen_edges.insert(edge_key) {
                    *out_deg_map.entry(src.clone()).or_insert(0) += 1;
                    *in_deg_map.entry(tgt.clone()).or_insert(0) += 1;
                    if !stem_to_path.contains_key(tgt) {
                        missing_nodes.insert(tgt.clone());
                    }
                    edges.push(GraphEdge {
                        source: src.clone(),
                        target: tgt.clone(),
                        kind: link.kind.clone(),
                    });
                }
            }
        }

        let mut allowed_ids: HashSet<String> = HashSet::new();
        if local_depth > 0 && !center_stem.is_empty() {
            allowed_ids.insert(center_stem.clone());
            for e in &edges {
                if e.source == center_stem {
                    allowed_ids.insert(e.target.clone());
                } else if e.target == center_stem {
                    allowed_ids.insert(e.source.clone());
                }
            }
            if local_depth >= 2 {
                let hop1 = allowed_ids.clone();
                for e in &edges {
                    if hop1.contains(&e.source) || hop1.contains(&e.target) {
                        allowed_ids.insert(e.source.clone());
                        allowed_ids.insert(e.target.clone());
                    }
                }
            }
        }

        let filter_by_hop = local_depth > 0 && allowed_ids.len() > 1;
        let mut nodes = Vec::new();

        for (id, (label, path)) in &stem_to_path {
            if filter_by_hop && !allowed_ids.contains(id) {
                continue;
            }
            let in_deg = *in_deg_map.get(id).unwrap_or(&0);
            let out_deg = *out_deg_map.get(id).unwrap_or(&0);
            let is_center = *id == center_stem;
            nodes.push(GraphNode {
                id: id.clone(),
                label: label.clone(),
                path: Some(path.clone()),
                exists: true,
                is_active: is_center,
                is_center,
                in_degree: in_deg,
                out_degree: out_deg,
                degree: in_deg + out_deg,
            });
        }

        for missing in missing_nodes {
            if filter_by_hop && !allowed_ids.contains(&missing) {
                continue;
            }
            let in_deg = *in_deg_map.get(&missing).unwrap_or(&1);
            let out_deg = *out_deg_map.get(&missing).unwrap_or(&0);
            nodes.push(GraphNode {
                id: missing.clone(),
                label: missing,
                path: None,
                exists: false,
                is_active: false,
                is_center: false,
                in_degree: in_deg,
                out_degree: out_deg,
                degree: in_deg + out_deg,
            });
        }

        nodes.sort_by(|a, b| {
            b.is_center
                .cmp(&a.is_center)
                .then(b.degree.cmp(&a.degree))
                .then(a.label.cmp(&b.label))
        });
        if nodes.len() > 100 {
            nodes.truncate(100);
        }
        let valid_node_ids: HashSet<String> = nodes.iter().map(|n| n.id.clone()).collect();
        edges.retain(|e| valid_node_ids.contains(&e.source) && valid_node_ids.contains(&e.target));

        KnowledgeGraphData { nodes, edges }
    }
}

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
                e.file_type().map_or(false, |ft| ft.is_file()) && is_indexable_markdown(e.path())
            })
            .map(|e| e.into_path())
            .collect()
    }

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

    pub fn search_backlinks<P: AsRef<Path>>(
        root: P,
        target_name: &str,
        exclude_file_path: Option<&str>,
    ) -> Vec<SearchMatch> {
        let index = WorkspaceIndex::default();
        index.search_backlinks(root, target_name, exclude_file_path)
    }
}
