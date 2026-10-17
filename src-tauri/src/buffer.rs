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
    pub from: usize,
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

fn strip_inline_markdown(raw: &str) -> String {
    let mut out = raw.trim().to_string();
    // 剥离 ATX 标题尾部可选的 ` ###`
    if let Some(stripped) = out.trim_end_matches('#').strip_suffix(' ') {
        out = stripped.trim().to_string();
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

    /// 高性能提取 Markdown 大纲 (# Headings)，自动跳过顶部 YAML Front Matter 与围栏代码块内部注释，并兼容引用块内标题
    pub fn extract_headings(&self) -> Vec<HeadingItem> {
        let mut headings = Vec::new();
        let mut in_fence = false;
        let mut fence_char: char = '\0';
        let mut fence_len: usize = 0;

        let total_lines = self.rope.len_lines();
        let mut start_line_idx = 0;

        if total_lines >= 3 && self.rope.line(0).to_string().trim() == "---" {
            let limit = total_lines.min(35);
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
            let trimmed = line_str.trim();

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

            // 兼容顶层标题与引用块内标题 (> # Heading)，排除 Callout 头部 (> [!NOTE])
            let after_quote = trimmed.trim_start_matches(|c: char| c == '>' || c == ' ');
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_buffer_operations() {
        let mut buf = DocumentBuffer::new("# Title\n\nHello Rust-Typora!");
        assert_eq!(buf.len_lines(), 3);
        assert!(!buf.is_dirty());

        buf.set_text("# New Title\n\nUpdated text");
        assert!(buf.is_dirty());
        assert_eq!(buf.get_text(), "# New Title\n\nUpdated text");

        buf.mark_clean();
        assert!(!buf.is_dirty());
    }

    #[test]
    fn test_heading_extraction() {
        let content = "---\ntitle: demo\n---\n# Header 1\nSome paragraph\n````markdown\n```python\n# Code comment\n```\n````\n## **Subheader *2*** ##\n> ### Quoted Header 3\nNot # A Header";
        let buf = DocumentBuffer::new(content);
        let headings = buf.extract_headings();

        assert_eq!(headings.len(), 3);
        assert_eq!(headings[0].level, 1);
        assert_eq!(headings[0].text, "Header 1");
        assert_eq!(headings[1].level, 2);
        assert_eq!(headings[1].text, "Subheader 2");
        assert_eq!(headings[2].level, 3);
        assert_eq!(headings[2].text, "Quoted Header 3");
    }
}
