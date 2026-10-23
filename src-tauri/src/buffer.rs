use ropey::Rope;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeadingItem {
    pub level: usize,
    pub text: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextDelta {
    #[serde(alias = "fromChar")]
    pub from: usize,
    #[serde(alias = "toChar")]
    pub to: usize,
    pub insert: String,
}

pub struct DocumentBuffer {
    rope: Rope,
    is_dirty: bool,
}

impl Default for DocumentBuffer {
    fn default() -> Self {
        Self::new("")
    }
}

pub fn strip_inline_markdown(raw: &str) -> String {
    let mut out = raw.trim().to_string();
    // 剥离行尾块级引用锚点 ` ^block-id`
    if let Some(caret_idx) = out.rfind(" ^") {
        let suffix = &out[caret_idx + 2..];
        if !suffix.is_empty()
            && suffix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            out = out[..caret_idx].trim().to_string();
        }
    }
    // 剥离 ATX 标题尾部可选的 ` ###`
    if let Some(stripped) = out.trim_end_matches('#').strip_suffix(' ') {
        out = stripped.trim().to_string();
    }
    // 剥离 [[文档#标题|别名]] 双链语法，优先保留别名或目标名
    while let Some(start) = out.find("[[") {
        if let Some(rel_end) = out[start + 2..].find("]]") {
            let inner = &out[start + 2..start + 2 + rel_end];
            let display = if let Some(pipe_idx) = inner.find('|') {
                inner[pipe_idx + 1..].trim()
            } else if let Some(hash_idx) = inner.find('#') {
                let doc_part = inner[..hash_idx].trim();
                let head_part = inner[hash_idx + 1..].trim();
                if doc_part.is_empty() {
                    head_part
                } else {
                    doc_part
                }
            } else {
                inner.trim()
            };
            let replacement = display.to_string();
            out.replace_range(start..start + 2 + rel_end + 2, &replacement);
        } else {
            break;
        }
    }
    // 剥离常见行内语法标记 (** / * / ~~ / == / `)
    for marker in ["***", "___", "**", "__", "~~", "==", "*", "_", "`"] {
        if out.contains(marker) {
            out = out.replace(marker, "");
        }
    }
    out.trim().to_string()
}

/// 提取行尾的块级引用 ID（如 `段落内容 ^block-id` -> Some(("block-id", "段落内容"))）
pub fn extract_trailing_block_id(raw_line: &str) -> Option<(String, String)> {
    let trimmed = raw_line.trim_end();
    if let Some(caret_pos) = trimmed.rfind('^') {
        let before = &trimmed[..caret_pos];
        let id_part = &trimmed[caret_pos + 1..];
        if (before.is_empty() || before.ends_with(char::is_whitespace))
            && !id_part.is_empty()
            && id_part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            let clean_preview = strip_inline_markdown(before);
            return Some((id_part.to_string(), clean_preview));
        }
    }
    None
}

impl DocumentBuffer {
    pub fn new(initial_text: &str) -> Self {
        Self {
            rope: Rope::from_str(initial_text),
            is_dirty: false,
        }
    }

    pub fn set_text(&mut self, text: &str) {
        self.rope = Rope::from_str(text);
        self.is_dirty = true;
    }

    /// O(log N) 增量更新 Rope 缓冲区，自动将前端 CodeMirror UTF-16 代码单元偏移转换至 Unicode 标量字符偏移，
    /// 彻底解决文档包含 Emoji 或增补平面字符时增量同步错位崩溃的问题。
    pub fn apply_deltas(&mut self, deltas: &[TextDelta]) -> bool {
        for d in deltas {
            let total_utf16 = self.rope.len_utf16_cu();
            if d.from > d.to || d.to > total_utf16 {
                return false;
            }
            let char_from = self.rope.utf16_cu_to_char(d.from);
            let char_to = self.rope.utf16_cu_to_char(d.to);
            if char_from > char_to || char_to > self.rope.len_chars() {
                return false;
            }
            if char_from < char_to {
                self.rope.remove(char_from..char_to);
            }
            if !d.insert.is_empty() {
                self.rope.insert(char_from, &d.insert);
            }
        }
        self.is_dirty = true;
        true
    }

    pub fn get_text(&self) -> String {
        self.rope.to_string()
    }

    pub fn len_chars(&self) -> usize {
        self.rope.len_chars()
    }

    pub fn len_lines(&self) -> usize {
        self.rope.len_lines()
    }

    pub fn mark_clean(&mut self) {
        self.is_dirty = false;
    }

    pub fn is_dirty(&self) -> bool {
        self.is_dirty
    }

    /// 高性能提取 Markdown 大纲 (# Headings) 与块级引用锚点 (^block-id)
    /// 自动跳过顶部 YAML Front Matter 与围栏代码块（含引用块内围栏代码块）
    pub fn extract_headings(&self) -> Vec<HeadingItem> {
        let mut headings = Vec::new();
        let mut in_fence = false;
        let mut fence_char: char = '\0';
        let mut fence_len: usize = 0;

        let total_lines = self.rope.len_lines();
        let mut start_line_idx = 0;

        if total_lines >= 3 && self.rope.line(0).to_string().trim() == "---" {
            let limit = total_lines.min(40);
            for k in 1..limit {
                let t = self.rope.line(k).to_string();
                let trimmed = t.trim();
                if trimmed == "---" || trimmed == "..." {
                    start_line_idx = k + 1;
                    break;
                }
            }
        }

        for (idx, line_slice) in self.rope.lines().enumerate() {
            if idx < start_line_idx {
                continue;
            }
            let line_str = line_slice.to_string();
            let after_quote = line_str
                .trim_start()
                .trim_start_matches(|c: char| c == '>' || c == ' ');
            let trimmed = after_quote.trim();

            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                let m_char = trimmed.chars().next().unwrap_or('`');
                let m_len = trimmed.chars().take_while(|&c| c == m_char).count();
                if !in_fence {
                    in_fence = true;
                    fence_char = m_char;
                    fence_len = m_len;
                } else if m_char == fence_char
                    && m_len >= fence_len
                    && trimmed[m_len..].trim().is_empty()
                {
                    in_fence = false;
                }
                continue;
            }

            if in_fence {
                continue;
            }

            if after_quote.starts_with('#') {
                let mut level = 0;
                for ch in after_quote.chars() {
                    if ch == '#' {
                        level += 1;
                    } else {
                        break;
                    }
                }
                if (1..=6).contains(&level) && after_quote.chars().nth(level) == Some(' ') {
                    let text = strip_inline_markdown(&after_quote[level..]);
                    if !text.is_empty() {
                        headings.push(HeadingItem {
                            level,
                            text,
                            line: idx + 1,
                        });
                    }
                }
            }
        }
        headings
    }

    /// 提取包含 H1~H6 标题以及 `^block-id` 块级锚点的完整列表（供 `[[文档#` 与 `[[文档#^` 自动补全使用）
    pub fn extract_headings_and_blocks(&self) -> Vec<HeadingItem> {
        let mut items = self.extract_headings();
        let total_lines = self.rope.len_lines();
        let mut in_fence = false;
        let mut prev_line_preview = String::new();

        for (idx, line_slice) in self.rope.lines().enumerate() {
            let line_str = line_slice.to_string();
            let trimmed = line_str.trim();
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                in_fence = !in_fence;
                continue;
            }
            if in_fence {
                continue;
            }
            if let Some((block_id, inline_preview)) = extract_trailing_block_id(&line_str) {
                let preview = if !inline_preview.is_empty() {
                    inline_preview
                } else {
                    prev_line_preview.clone()
                };
                let short_preview: String = preview.chars().take(36).collect();
                let label = if short_preview.is_empty() {
                    format!("^{}", block_id)
                } else {
                    format!("^{} ({})", block_id, short_preview)
                };
                items.push(HeadingItem {
                    level: 0,
                    text: label,
                    line: idx + 1,
                });
            }
            if !trimmed.is_empty() && !trimmed.starts_with('^') {
                prev_line_preview = strip_inline_markdown(trimmed);
            }
            if idx >= total_lines {
                break;
            }
        }
        items
    }

    /// 提取指定标题章节（含其下属子标题闭包）或 `^block-id` 块引用的 Markdown 文本，供 ![[文档#标题]] / ![[文档#^block]] 嵌入使用
    pub fn extract_section_by_heading(&self, heading_query: Option<&str>) -> String {
        let total_lines = self.rope.len_lines();
        let mut start_line_idx = 0;

        if total_lines >= 3 && self.rope.line(0).to_string().trim() == "---" {
            let limit = total_lines.min(40);
            for k in 1..limit {
                let t = self.rope.line(k).to_string();
                let trimmed = t.trim();
                if trimmed == "---" || trimmed == "..." {
                    start_line_idx = k + 1;
                    break;
                }
            }
        }

        let query_clean = heading_query
            .map(|q| q.trim().trim_start_matches('#').trim().to_lowercase())
            .unwrap_or_default();

        if query_clean.is_empty() {
            let mut out = String::new();
            for idx in start_line_idx..total_lines {
                out.push_str(&self.rope.line(idx).to_string());
            }
            return out.trim().to_string();
        }

        // 支持 ^block-id 块级精准引用提取
        if let Some(target_block_id) = query_clean.strip_prefix('^') {
            let target_id_clean = target_block_id
                .split_whitespace()
                .next()
                .unwrap_or(target_block_id)
                .trim();
            for idx in start_line_idx..total_lines {
                let line_str = self.rope.line(idx).to_string();
                if let Some((bid, preview_text)) = extract_trailing_block_id(&line_str) {
                    if bid.to_lowercase() == target_id_clean {
                        if !preview_text.is_empty() {
                            let stripped = line_str
                                .trim_end()
                                .trim_end_matches(&format!("^{}", bid))
                                .trim_end();
                            return stripped.to_string();
                        } else if idx > start_line_idx {
                            // 独立行 ^block-id：向上收集紧邻的非空段落/引用块/列表块
                            let mut blk_start = idx - 1;
                            while blk_start > start_line_idx {
                                let prev = self.rope.line(blk_start - 1).to_string();
                                if prev.trim().is_empty() {
                                    break;
                                }
                                blk_start -= 1;
                            }
                            let mut out = String::new();
                            for k in blk_start..idx {
                                out.push_str(&self.rope.line(k).to_string());
                            }
                            return out.trim().to_string();
                        }
                    }
                }
            }
        }

        let headings = self.extract_headings();
        let target_idx = headings.iter().position(|h| {
            let h_low = h.text.to_lowercase();
            h_low == query_clean || h_low.contains(&query_clean)
        });

        if let Some(t_idx) = target_idx {
            let target_h = &headings[t_idx];
            let sec_start = target_h.line.saturating_sub(1);
            let mut sec_end = total_lines;
            for next_h in &headings[t_idx + 1..] {
                if next_h.level <= target_h.level {
                    sec_end = next_h.line.saturating_sub(1);
                    break;
                }
            }
            let mut out = String::new();
            for idx in sec_start..sec_end.min(total_lines) {
                out.push_str(&self.rope.line(idx).to_string());
            }
            return out.trim().to_string();
        }

        // 未命中特定标题时回退返回正文前 15 行摘要
        let mut out = String::new();
        for idx in start_line_idx..total_lines.min(start_line_idx + 15) {
            out.push_str(&self.rope.line(idx).to_string());
        }
        out.trim().to_string()
    }

    /// 块级引用 (`![[note#^block-id]]`) 与章节引用 (`![[note#Heading]]`) 原位双向同步写回引擎 (v0.10.0 新增)
    pub fn update_section_by_heading_or_block(
        &mut self,
        heading_query: Option<&str>,
        new_section_content: &str,
    ) -> Result<String, String> {
        let full_text = self.rope.to_string();
        let mut lines: Vec<String> = full_text.lines().map(|s| s.to_string()).collect();
        let total_lines = lines.len();

        let mut start_line_idx = 0;
        if total_lines >= 3 && lines[0].trim() == "---" {
            let limit = total_lines.min(40);
            for k in 1..limit {
                let trimmed = lines[k].trim();
                if trimmed == "---" || trimmed == "..." {
                    start_line_idx = k + 1;
                    break;
                }
            }
        }

        let query_clean = heading_query
            .map(|q| q.trim().trim_start_matches('#').trim().to_lowercase())
            .unwrap_or_default();

        if query_clean.is_empty() {
            let mut updated_lines = lines[..start_line_idx].to_vec();
            for l in new_section_content.lines() {
                updated_lines.push(l.to_string());
            }
            let updated_doc = updated_lines.join("\n");
            self.set_text(&updated_doc);
            return Ok(updated_doc);
        }

        // 1. 匹配 `^block-id` 块级锚点并双向写回
        if let Some(target_block_id) = query_clean.strip_prefix('^') {
            let target_id_clean = target_block_id
                .split_whitespace()
                .next()
                .unwrap_or(target_block_id)
                .trim();

            for idx in start_line_idx..total_lines {
                if let Some((bid, preview_text)) = extract_trailing_block_id(&lines[idx]) {
                    if bid.to_lowercase() == target_id_clean {
                        let cleaned_new = new_section_content
                            .trim()
                            .trim_end_matches(&format!("^{}", bid))
                            .trim();
                        if !preview_text.is_empty() {
                            lines[idx] = format!("{} ^{}", cleaned_new, bid);
                        } else if idx > start_line_idx {
                            let mut blk_start = idx - 1;
                            while blk_start > start_line_idx {
                                if lines[blk_start - 1].trim().is_empty() {
                                    break;
                                }
                                blk_start -= 1;
                            }
                            let replacement: Vec<String> =
                                cleaned_new.lines().map(|s| s.to_string()).collect();
                            lines.splice(blk_start..idx, replacement);
                        } else {
                            lines[idx] = format!("{} ^{}", cleaned_new, bid);
                        }
                        let updated_doc = lines.join("\n");
                        self.set_text(&updated_doc);
                        return Ok(updated_doc);
                    }
                }
            }
            return Err(format!("未找到块级引用锚点 ^{}", target_id_clean));
        }

        // 2. 匹配 `#Heading` 标题章节并双向写回
        let headings = self.extract_headings();
        let target_idx = headings.iter().position(|h| {
            let h_low = h.text.to_lowercase();
            h_low == query_clean || h_low.contains(&query_clean)
        });

        if let Some(t_idx) = target_idx {
            let target_h = &headings[t_idx];
            let sec_start = target_h.line.saturating_sub(1);
            let mut sec_end = total_lines;
            for next_h in &headings[t_idx + 1..] {
                if next_h.level <= target_h.level {
                    sec_end = next_h.line.saturating_sub(1);
                    break;
                }
            }

            let trimmed_new = new_section_content.trim();
            let mut replacement: Vec<String> = Vec::new();
            if !trimmed_new.starts_with('#') && sec_start < lines.len() {
                replacement.push(lines[sec_start].clone());
            }
            for l in trimmed_new.lines() {
                replacement.push(l.to_string());
            }
            if sec_end < total_lines {
                replacement.push(String::new());
            }

            lines.splice(sec_start..sec_end.min(total_lines), replacement);
            let updated_doc = lines.join("\n");
            self.set_text(&updated_doc);
            return Ok(updated_doc);
        }

        Err(format!("未找到章节标题: {}", query_clean))
    }
}
