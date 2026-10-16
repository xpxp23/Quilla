use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

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

    /// 安全保存后台崩溃快照 (Draft Snapshot)
    pub fn save_draft_snapshot(file_id: &str, content: &str) -> io::Result<PathBuf> {
        let draft_dir = std::env::temp_dir().join("rust-typora-drafts");
        fs::create_dir_all(&draft_dir)?;

        let draft_path = draft_dir.join(format!("{}.draft", file_id));
        fs::write(&draft_path, content)?;
        Ok(draft_path)
    }
}
