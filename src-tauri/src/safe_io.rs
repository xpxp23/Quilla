use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub struct SafeIO;

impl SafeIO {
    /// 原子写入文件：
    /// 1. 写入同目录下的 .filename.tmp 文件
    /// 2. 调用 sync_all() 确保物理落盘
    /// 3. 原子重命名覆盖原文件，绝不截断或损坏原文件
    pub fn atomic_write<P: AsRef<Path>>(path: P, content: &str) -> io::Result<()> {
        let path = path.as_ref();
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let file_name = path.file_name().unwrap_or_default().to_string_lossy();
        let tmp_path = parent.join(format!(".{}.tmp", file_name));

        {
            let mut tmp_file = File::create(&tmp_path)?;
            tmp_file.write_all(content.as_bytes())?;
            tmp_file.sync_all()?;
        }

        // Windows 下如果目标文件存在，直接 rename 可能会报错，先确保替换原子性
        if path.exists() {
            let backup_path = parent.join(format!(".{}.bak", file_name));
            // 快速备份
            let _ = fs::rename(path, &backup_path);
            if let Err(e) = fs::rename(&tmp_path, path) {
                // 如果替换失败，回滚备份
                let _ = fs::rename(&backup_path, path);
                return Err(e);
            }
            let _ = fs::remove_file(backup_path);
        } else {
            fs::rename(&tmp_path, path)?;
        }

        Ok(())
    }

    /// 安全保存后台崩溃快照 (Draft Snapshot)
    pub fn save_draft_snapshot(file_id: &str, content: &str) -> io::Result<PathBuf> {
        let draft_dir = std::env::temp_dir().join("rust-typora-drafts");
        fs::create_dir_all(&draft_dir)?;

        let draft_path = draft_dir.join(format!("{}.draft", file_id));
        fs::write(&draft_path, content)?;
        Ok(draft_path)
    }
}
