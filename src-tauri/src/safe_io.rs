use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftSnapshotRecord {
    pub key: String,
    #[serde(rename = "filePath")]
    pub file_path: Option<String>,
    pub content: String,
    pub timestamp: u64,
    pub title: String,
}

pub struct SafeIO;

impl SafeIO {
    /// 原子写入文件：
    /// 1. 写入同目录下的 .filename.tmp 文件并调用 sync_all() 确保物理落盘
    /// 2. 原子重命名覆盖原文件；若目标为符号链接或遇同步盘瞬时锁冲突，自动回退为安全覆写并清理临时文件
    pub fn atomic_write<P: AsRef<Path>>(path: P, content: &str) -> io::Result<()> {
        let path = path.as_ref();
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }

        // 若目标为软链接 (Symlink)，直接写入目标文件以保持链接关系不断裂
        if let Ok(meta) = fs::symlink_metadata(path) {
            if meta.file_type().is_symlink() {
                let mut f = File::create(path)?;
                f.write_all(content.as_bytes())?;
                f.sync_all()?;
                return Ok(());
            }
        }

        let file_name = path.file_name().unwrap_or_default().to_string_lossy();
        let tmp_path = parent.join(format!(".{}.tmp", file_name));

        {
            let mut tmp_file = File::create(&tmp_path)?;
            tmp_file.write_all(content.as_bytes())?;
            tmp_file.sync_all()?;
        }

        if path.exists() {
            let backup_path = parent.join(format!(".{}.bak", file_name));
            let _ = fs::rename(path, &backup_path);
            if let Err(_e) = fs::rename(&tmp_path, path) {
                let _ = fs::rename(&backup_path, path);
                // 同步盘文件锁冲突降级方案：直接复制内容并移除临时文件
                fs::copy(&tmp_path, path)?;
                let _ = fs::remove_file(&tmp_path);
            }
            let _ = fs::remove_file(backup_path);
        } else if let Err(_e) = fs::rename(&tmp_path, path) {
            fs::copy(&tmp_path, path)?;
            let _ = fs::remove_file(&tmp_path);
        }

        Ok(())
    }

    /// 计算确定性 64-bit FNV-1a 哈希，彻底解决中文或特殊符号文件路径转化为下划线后的文件名碰撞覆盖问题
    fn fnv1a_hash(input: &str) -> u64 {
        let mut hash: u64 = 0xcbf29ce484222325;
        for byte in input.as_bytes() {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash
    }

    fn build_draft_filename(file_id: &str) -> String {
        let prefix: String = file_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .take(24)
            .collect();
        let clean_prefix = if prefix.is_empty() { "doc" } else { &prefix };
        let hash = Self::fnv1a_hash(file_id);
        format!("{}_{:016x}.draft.json", clean_prefix, hash)
    }

    fn legacy_sanitize_file_id(file_id: &str) -> String {
        file_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    }

    /// 安全保存后台崩溃快照 (Draft Snapshot)，突破浏览器 localStorage 5MB 容量限制
    pub fn save_draft_snapshot(
        file_id: &str,
        file_path: Option<String>,
        content: &str,
        title: Option<String>,
    ) -> io::Result<PathBuf> {
        let draft_dir = std::env::temp_dir().join("quilla-recovery-drafts");
        fs::create_dir_all(&draft_dir)?;

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let resolved_title = title.unwrap_or_else(|| {
            file_path
                .as_deref()
                .and_then(|p| Path::new(p).file_name())
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "未命名.md".to_string())
        });

        let record = DraftSnapshotRecord {
            key: file_id.to_string(),
            file_path,
            content: content.to_string(),
            timestamp,
            title: resolved_title,
        };

        let serialized = serde_json::to_string(&record)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        let draft_path = draft_dir.join(Self::build_draft_filename(file_id));
        Self::atomic_write(&draft_path, &serialized)?;
        Ok(draft_path)
    }

    /// 清理指定会话或文件的崩溃恢复草稿（同时清理新版哈希草稿与旧版遗留文件）
    pub fn remove_draft_snapshot(file_id: &str) -> io::Result<()> {
        let draft_dir = std::env::temp_dir().join("quilla-recovery-drafts");
        let draft_path = draft_dir.join(Self::build_draft_filename(file_id));
        if draft_path.exists() {
            let _ = fs::remove_file(draft_path);
        }

        let legacy_path = draft_dir.join(format!("{}.draft", Self::legacy_sanitize_file_id(file_id)));
        if legacy_path.exists() {
            let _ = fs::remove_file(legacy_path);
        }
        Ok(())
    }

    /// 读取磁盘上所有有效的崩溃快照草稿（自动清理超过 7 天的过期快照）
    pub fn load_all_draft_snapshots() -> Vec<DraftSnapshotRecord> {
        let draft_dir = std::env::temp_dir().join("quilla-recovery-drafts");
        if !draft_dir.exists() {
            return Vec::new();
        }

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let max_age_ms: u64 = 7 * 24 * 3600 * 1000;

        let mut records = Vec::new();
        if let Ok(entries) = fs::read_dir(&draft_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if !name.ends_with(".draft.json") {
                    continue;
                }
                if let Ok(raw) = fs::read_to_string(&path) {
                    if let Ok(rec) = serde_json::from_str::<DraftSnapshotRecord>(&raw) {
                        if now_ms > rec.timestamp && now_ms - rec.timestamp > max_age_ms {
                            let _ = fs::remove_file(&path);
                            continue;
                        }
                        if !rec.content.trim().is_empty() {
                            records.push(rec);
                        }
                    }
                }
            }
        }

        records.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        records
    }
}
