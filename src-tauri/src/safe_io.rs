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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistorySnapshotRecord {
    pub id: String,
    #[serde(rename = "filePath", alias = "file_path")]
    pub file_path: String,
    #[serde(rename = "timestamp_ms", alias = "timestamp")]
    pub timestamp: u64,
    pub label: String,
    pub content: String,
    #[serde(rename = "char_count", alias = "charCount")]
    pub char_count: usize,
    #[serde(rename = "line_count", alias = "lineCount")]
    pub line_count: usize,
}

const MAX_HISTORY_SNAPSHOTS_PER_FILE: usize = 25;

pub struct SafeIO;

impl SafeIO {
    /// 平台感知的路径归一化键：Windows 大小写不敏感，Linux/macOS 保留原始大小写防止哈希碰撞
    fn normalize_history_key(file_path: &str) -> String {
        let unified = file_path.replace('\\', "/");
        #[cfg(target_os = "windows")]
        {
            unified.to_lowercase()
        }
        #[cfg(not(target_os = "windows"))]
        {
            unified
        }
    }

    /// 原子写入文件：
    /// 1. 软链接先解析真实目标路径，再对其执行同等原子临时文件替换（避免截断覆写断电丢数据）；
    /// 2. 使用 `tempfile::Builder` 生成进程与线程隔离的唯一临时文件，彻底消除多窗口并发保存踩踏。
    pub fn atomic_write_with_options<P: AsRef<Path>>(
        path: P,
        content: &str,
        force_fsync: bool,
    ) -> io::Result<()> {
        let raw_path = path.as_ref();
        let target_buf: PathBuf = if let Ok(meta) = fs::symlink_metadata(raw_path) {
            if meta.file_type().is_symlink() {
                fs::canonicalize(raw_path).unwrap_or_else(|_| raw_path.to_path_buf())
            } else {
                raw_path.to_path_buf()
            }
        } else {
            raw_path.to_path_buf()
        };

        let path = target_buf.as_path();
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }

        let file_name = path.file_name().unwrap_or_default().to_string_lossy();
        let prefix_str = format!(".{}.", file_name);
        let mut tmp_builder = tempfile::Builder::new();
        tmp_builder
            .prefix(&prefix_str)
            .suffix(".quilla.tmp");

        let named_tmp = match tmp_builder.tempfile_in(parent) {
            Ok(mut tmp) => {
                tmp.write_all(content.as_bytes())?;
                if force_fsync {
                    tmp.as_file().sync_all()?;
                }
                tmp
            }
            Err(_) => {
                // 目录禁止创建临时文件时的安全降级
                let mut direct = File::create(path)?;
                direct.write_all(content.as_bytes())?;
                if force_fsync {
                    direct.sync_all()?;
                }
                return Ok(());
            }
        };

        if path.exists() {
            if let Ok(orig_meta) = fs::metadata(path) {
                let _ = fs::set_permissions(named_tmp.path(), orig_meta.permissions());
            }
        }

        match named_tmp.persist(path) {
            Ok(_) => Ok(()),
            Err(persist_err) => {
                // Windows 隐藏/只读锁或跨卷场景回退：从已落盘的临时文件复制并清理
                let tmp_file = persist_err.file;
                if fs::copy(tmp_file.path(), path).is_err() {
                    let mut direct = File::create(path)?;
                    direct.write_all(content.as_bytes())?;
                    if force_fsync {
                        let _ = direct.sync_all();
                    }
                }
                Ok(())
            }
        }
    }

    pub fn atomic_write<P: AsRef<Path>>(path: P, content: &str) -> io::Result<()> {
        Self::atomic_write_with_options(path, content, true)
    }

    /// 计算确定性 64-bit FNV-1a 哈希
    pub fn fnv1a_hash(input: &str) -> u64 {
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

    /// 解析跨平台持久化应用数据根目录
    pub fn resolve_app_data_root() -> PathBuf {
        #[cfg(target_os = "windows")]
        {
            if let Ok(appdata) = std::env::var("LOCALAPPDATA").or_else(|_| std::env::var("APPDATA")) {
                let p = PathBuf::from(appdata).join("Quilla");
                if fs::create_dir_all(&p).is_ok() {
                    return p;
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            if let Ok(home) = std::env::var("HOME") {
                let p = PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("Quilla");
                if fs::create_dir_all(&p).is_ok() {
                    return p;
                }
            }
        }
        #[cfg(target_os = "linux")]
        {
            if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
                let p = PathBuf::from(xdg).join("quilla");
                if fs::create_dir_all(&p).is_ok() {
                    return p;
                }
            } else if let Ok(home) = std::env::var("HOME") {
                let p = PathBuf::from(home).join(".local").join("share").join("quilla");
                if fs::create_dir_all(&p).is_ok() {
                    return p;
                }
            }
        }
        let fallback = std::env::temp_dir().join("quilla-appdata");
        let _ = fs::create_dir_all(&fallback);
        fallback
    }

    fn resolve_draft_dir() -> PathBuf {
        let d = Self::resolve_app_data_root().join("recovery-drafts");
        let _ = fs::create_dir_all(&d);
        d
    }

    /// 非阻塞快速保存后台崩溃快照 (Draft Snapshot)
    pub fn save_draft_snapshot(
        file_id: &str,
        file_path: Option<String>,
        content: &str,
        title: Option<String>,
    ) -> io::Result<PathBuf> {
        let draft_dir = Self::resolve_draft_dir();
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
        Self::atomic_write_with_options(&draft_path, &serialized, false)?;
        Ok(draft_path)
    }

    /// 清理指定会话或文件的崩溃恢复草稿
    pub fn remove_draft_snapshot(file_id: &str) -> io::Result<()> {
        let draft_dir = Self::resolve_draft_dir();
        let draft_path = draft_dir.join(Self::build_draft_filename(file_id));
        if draft_path.exists() {
            let _ = fs::remove_file(draft_path);
        }

        let legacy_path =
            draft_dir.join(format!("{}.draft", Self::legacy_sanitize_file_id(file_id)));
        if legacy_path.exists() {
            let _ = fs::remove_file(legacy_path);
        }
        Ok(())
    }

    /// 读取磁盘上所有有效的崩溃快照草稿（自动清理超过 7 天的过期快照）
    pub fn load_all_draft_snapshots() -> Vec<DraftSnapshotRecord> {
        let draft_dir = Self::resolve_draft_dir();
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

    fn build_history_store_path(file_path: &str) -> PathBuf {
        let norm = Self::normalize_history_key(file_path);
        let hash = Self::fnv1a_hash(&norm);
        let history_dir = Self::resolve_app_data_root().join("version-history");
        let _ = fs::create_dir_all(&history_dir);
        history_dir.join(format!("hist_{:016x}.json", hash))
    }

    /// 保存本地时间机器 (Time Machine) 历史版本快照（自动去重并保留最近 25 个版本）
    pub fn save_file_history_snapshot(
        file_path: &str,
        content: &str,
        label: Option<String>,
    ) -> io::Result<()> {
        if file_path.trim().is_empty() {
            return Ok(());
        }
        let store_path = Self::build_history_store_path(file_path);
        let mut list = Self::list_file_history_snapshots(file_path);

        if let Some(latest) = list.first() {
            if latest.content == content {
                return Ok(());
            }
        }

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let record = HistorySnapshotRecord {
            id: format!("v-{}", timestamp),
            file_path: file_path.to_string(),
            timestamp,
            label: label.unwrap_or_else(|| "自动快照".to_string()),
            content: content.to_string(),
            char_count: content.chars().count(),
            line_count: content.lines().count().max(1),
        };

        list.insert(0, record);
        if list.len() > MAX_HISTORY_SNAPSHOTS_PER_FILE {
            list.truncate(MAX_HISTORY_SNAPSHOTS_PER_FILE);
        }

        let serialized = serde_json::to_string(&list)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        Self::atomic_write_with_options(&store_path, &serialized, false)
    }

    /// 读取指定文件的所有历史版本记录（按时间倒序）
    pub fn list_file_history_snapshots(file_path: &str) -> Vec<HistorySnapshotRecord> {
        if file_path.trim().is_empty() {
            return Vec::new();
        }
        let store_path = Self::build_history_store_path(file_path);
        if !store_path.exists() {
            return Vec::new();
        }
        if let Ok(raw) = fs::read_to_string(&store_path) {
            if let Ok(mut list) = serde_json::from_str::<Vec<HistorySnapshotRecord>>(&raw) {
                list.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
                return list;
            }
        }
        Vec::new()
    }

    /// 删除单条历史版本快照
    pub fn delete_file_history_snapshot(file_path: &str, snapshot_id: &str) -> io::Result<()> {
        let store_path = Self::build_history_store_path(file_path);
        if !store_path.exists() {
            return Ok(());
        }
        let mut list = Self::list_file_history_snapshots(file_path);
        list.retain(|item| item.id != snapshot_id);
        let serialized = serde_json::to_string(&list)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        Self::atomic_write_with_options(&store_path, &serialized, false)
    }

    fn migrate_single_file_history(old_path: &Path, new_path: &Path) {
        let old_str = old_path.to_string_lossy().to_string();
        let new_str = new_path.to_string_lossy().to_string();
        let old_store = Self::build_history_store_path(&old_str);
        let new_store = Self::build_history_store_path(&new_str);
        if old_store.exists() && old_store != new_store {
            if let Ok(raw) = fs::read_to_string(&old_store) {
                if let Ok(mut list) = serde_json::from_str::<Vec<HistorySnapshotRecord>>(&raw) {
                    for item in &mut list {
                        item.file_path = new_str.clone();
                    }
                    if let Ok(serialized) = serde_json::to_string(&list) {
                        let _ = Self::atomic_write_with_options(&new_store, &serialized, false);
                    }
                }
            }
            let _ = fs::remove_file(&old_store);
        }
    }

    /// 当文件或上级目录在侧边栏被重命名时，同步迁移该文件或目录下所有笔记的本地时间机器历史快照
    pub fn migrate_file_history(old_path: &Path, new_path: &Path) {
        if new_path.is_file() {
            Self::migrate_single_file_history(old_path, new_path);
        } else if new_path.is_dir() {
            let mut stack = vec![(old_path.to_path_buf(), new_path.to_path_buf())];
            while let Some((cur_old, cur_new)) = stack.pop() {
                if let Ok(entries) = fs::read_dir(&cur_new) {
                    for entry in entries.flatten() {
                        let child_new = entry.path();
                        if let Some(name) = child_new.file_name() {
                            let child_old = cur_old.join(name);
                            if child_new.is_dir() {
                                stack.push((child_old, child_new));
                            } else if child_new.is_file() {
                                Self::migrate_single_file_history(&child_old, &child_new);
                            }
                        }
                    }
                }
            }
        }
    }
}
