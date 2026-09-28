use rusqlite::{Connection, OpenFlags};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) const BACKUP_MAGIC: &[u8] = b"COMPASSBAK1";

pub(crate) struct ValidatedBackup<'a> {
    pub key: &'a str,
    pub database: &'a [u8],
}

fn parse_backup(bytes: &[u8]) -> Result<(&[u8], &[u8]), String> {
    let mut remaining = bytes
        .strip_prefix(BACKUP_MAGIC)
        .ok_or_else(|| "this file doesn't look like a Compass backup".to_string())?;
    fn read_section<'a>(remaining: &mut &'a [u8]) -> Result<&'a [u8], String> {
        let corrupt = || "backup file is truncated or corrupt".to_string();
        let length_bytes = remaining.get(..8).ok_or_else(corrupt)?;
        let length = usize::try_from(u64::from_le_bytes(length_bytes.try_into().unwrap()))
            .map_err(|_| corrupt())?;
        *remaining = &remaining[8..];
        let section = remaining.get(..length).ok_or_else(corrupt)?;
        *remaining = &remaining[length..];
        Ok(section)
    }
    let key = read_section(&mut remaining)?;
    let database = read_section(&mut remaining)?;
    if database.is_empty() {
        return Err("backup contains an empty database".to_string());
    }
    if !remaining.is_empty() {
        return Err("backup contains unexpected trailing data".to_string());
    }
    Ok((key, database))
}

struct Probe(PathBuf);
impl Drop for Probe {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Shared by preview and staging. Only a private throwaway copy is opened; live/pending
/// databases and the keyring are never touched. The caller owns the validated byte snapshot.
pub(crate) fn validate_backup<'a>(
    bytes: &'a [u8],
    data_dir: &Path,
) -> Result<ValidatedBackup<'a>, String> {
    let (key_bytes, database) = parse_backup(bytes)?;
    let key = std::str::from_utf8(key_bytes)
        .map_err(|_| "backup's encryption key is not valid text".to_string())?
        .trim();
    if key.len() != 64 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("backup's encryption key is not in the expected format".to_string());
    }

    let path = data_dir.join(format!(
        "compass.db.restoreprobe.{:032x}",
        rand::random::<u128>()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| format!("create probe db: {e}"))?;
    let probe = Probe(path);
    let write_result = file.write_all(database);
    drop(file); // Close before cleanup on errors too (Windows cannot unlink an open file).
    write_result.map_err(|e| format!("write probe db: {e}"))?;
    let conn = Connection::open_with_flags(&probe.0, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("open probe db: {e}"))?;
    conn.pragma_update(None, "key", format!("x'{key}'"))
        .map_err(|e| e.to_string())?;
    conn.execute_batch("SELECT count(*) FROM sqlite_master").map_err(|_| {
        "the backup's key could not open its database - the backup file may be corrupt or from a different install".to_string()
    })?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|_| {
            "backup database integrity check failed - the file may be corrupt".to_string()
        })?;
    if integrity != "ok" {
        return Err("backup database integrity check failed - the file may be corrupt".to_string());
    }
    Ok(ValidatedBackup { key, database })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(std::path::PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "compass-backup-test-{:032x}",
                rand::random::<u128>()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn container(key: &[u8], db: &[u8]) -> Vec<u8> {
        let mut bytes = b"COMPASSBAK1".to_vec();
        bytes.extend_from_slice(&(key.len() as u64).to_le_bytes());
        bytes.extend_from_slice(key);
        bytes.extend_from_slice(&(db.len() as u64).to_le_bytes());
        bytes.extend_from_slice(db);
        bytes
    }

    fn encrypted_database(dir: &TestDir, key: &str) -> Vec<u8> {
        let path = dir.0.join("fixture.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "key", format!("x'{key}'"))
            .unwrap();
        conn.execute_batch(
            "CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('example');",
        )
        .unwrap();
        drop(conn);
        let bytes = std::fs::read(&path).unwrap();
        std::fs::remove_file(path).unwrap();
        assert!(
            !bytes.starts_with(b"SQLite format 3"),
            "fixture must really be encrypted"
        );
        bytes
    }

    #[test]
    fn rejects_overflowing_container_lengths_without_panicking() {
        let mut bytes = b"COMPASSBAK1".to_vec();
        bytes.extend_from_slice(&u64::MAX.to_le_bytes());
        assert!(parse_backup(&bytes).is_err());
        let mut bytes = container(&[b'a'; 64], b"database");
        let db_length_offset = BACKUP_MAGIC.len() + 8 + 64;
        bytes[db_length_offset..db_length_offset + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(parse_backup(&bytes).is_err());
    }

    #[test]
    fn rejects_corruption_beyond_the_schema_page_and_cleans_up_the_probe() {
        let dir = TestDir::new();
        let key = "ab".repeat(32);
        let mut db = encrypted_database(&dir, &key);
        *db.last_mut().unwrap() ^= 0xff;
        let backup = container(key.as_bytes(), &db);
        let error = validate_backup(&backup, &dir.0)
            .err()
            .expect("corrupt pages must fail validation");
        assert!(error.contains("integrity"), "{error}");
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[test]
    fn rejects_empty_or_trailing_database_payloads() {
        assert!(parse_backup(&container(&[b'a'; 64], b"")).is_err());
        let mut bytes = container(&[b'a'; 64], b"database");
        bytes.push(0);
        assert!(parse_backup(&bytes).is_err());
    }

    #[test]
    fn rejects_wrong_magic_and_every_truncated_container_prefix() {
        let backup = container(&[b'a'; 64], b"database");
        for end in 0..backup.len() {
            assert!(parse_backup(&backup[..end]).is_err());
        }
        let mut wrong_magic = backup.clone();
        wrong_magic[0] ^= 0xff;
        assert!(parse_backup(&wrong_magic).is_err());
        assert!(parse_backup(&backup).is_ok());
    }

    #[test]
    fn rejects_invalid_or_mismatched_keys_without_leaving_probe_files() {
        let dir = TestDir::new();
        let db = encrypted_database(&dir, &"ab".repeat(32));
        for key in [vec![0xff], vec![b'g'; 64], vec![], "cd".repeat(32).into_bytes()] {
            assert!(validate_backup(&container(&key, &db), &dir.0).is_err());
            assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 0);
        }
    }

    #[test]
    fn reports_probe_io_errors_without_creating_a_restore_directory() {
        let dir = TestDir::new();
        let missing = dir.0.join("missing");
        let backup = container(&[b'a'; 64], b"database");
        let error = validate_backup(&backup, &missing).err().unwrap();
        assert!(error.contains("create probe db"));
        assert!(!missing.exists());
    }

    #[test]
    fn preview_validates_encrypted_database_without_touching_live_or_pending_files() {
        let dir = TestDir::new();
        let key = "ab".repeat(32);
        let db = encrypted_database(&dir, &key);
        let backup = container(key.as_bytes(), &db);
        for name in [
            "compass.db",
            "compass.key",
            "compass.db.pending",
            "compass.key.pending",
        ] {
            std::fs::write(dir.0.join(name), name).unwrap();
        }

        let validated = validate_backup(&backup, &dir.0).unwrap();
        assert_eq!(validated.key, key);
        assert_eq!(validated.database, db);
        for name in [
            "compass.db",
            "compass.key",
            "compass.db.pending",
            "compass.key.pending",
        ] {
            assert_eq!(std::fs::read_to_string(dir.0.join(name)).unwrap(), name);
        }
        assert_eq!(
            std::fs::read_dir(&dir.0).unwrap().count(),
            4,
            "probe must be removed"
        );
    }
}
