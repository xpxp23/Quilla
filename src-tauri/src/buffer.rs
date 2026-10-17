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

    /// O(log N) 增量更新 Rope 缓冲区，避免每次打字重建整棵 Rope 树
    pub fn apply_deltas(&mut self, deltas: &[TextDelta]) -> bool {
        for d in deltas {
            let len = self.rope.len_chars();
            if d.from > d.to || d.to > len {
                return false;
            }
            if d.from < d.to {
                self.rope.remove(d.from..d.to);
            }
            if !d.insert.is_empty() {
                self.rope.insert(d.from, &d.insert);
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

    /// 高性能提取 Markdown 大纲 (# Headings)，自动跳过顶部 YAML Front Matter 与围栏代码块（含引用块内围栏代码块）
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

    /// 提取指定标题章节（含其下属子标题闭包）的 Markdown 文本，供 ![[文档#标题]] 块级嵌入使用
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

        // 未命中特定标题时回退返回正文前 12 行摘要
        let mut out = String::new();
        for idx in start_line_idx..total_lines.min(start_line_idx + 15) {
            out.push_str(&self.rope.line(idx).to_string());
        }
        out.trim().to_string()
    }
}
