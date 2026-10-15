use ropey::Rope;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeadingItem {
    pub level: usize,
    pub text: String,
    pub line: usize,
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

    /// 高性能提取 Markdown 大纲 (# Headings)，自动跳过代码块内部注释
    pub fn extract_headings(&self) -> Vec<HeadingItem> {
        let mut headings = Vec::new();
        let mut in_fence = false;
        let mut fence_marker = "";

        for (idx, line_slice) in self.rope.lines().enumerate() {
            let line_str = line_slice.to_string();
            let trimmed = line_str.trim();

            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                let marker = if trimmed.starts_with("```") { "```" } else { "~~~" };
                if !in_fence {
                    in_fence = true;
                    fence_marker = marker;
                } else if trimmed.starts_with(fence_marker) {
                    in_fence = false;
                }
                continue;
            }

            if in_fence {
                continue;
            }

            if trimmed.starts_with('#') {
                let mut level = 0;
                for ch in trimmed.chars() {
                    if ch == '#' {
                        level += 1;
                    } else {
                        break;
                    }
                }
                if (1..=6).contains(&level) && trimmed.chars().nth(level) == Some(' ') {
                    let text = trimmed[level..].trim().to_string();
                    headings.push(HeadingItem {
                        level,
                        text,
                        line: idx + 1,
                    });
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
        let content = "# Header 1\nSome paragraph\n```python\n# Code comment\n```\n## Subheader 2\n### Subheader 3\nNot # A Header";
        let buf = DocumentBuffer::new(content);
        let headings = buf.extract_headings();

        assert_eq!(headings.len(), 3);
        assert_eq!(headings[0].level, 1);
        assert_eq!(headings[0].text, "Header 1");
        assert_eq!(headings[1].level, 2);
        assert_eq!(headings[1].text, "Subheader 2");
        assert_eq!(headings[2].level, 3);
        assert_eq!(headings[2].text, "Subheader 3");
    }
}
