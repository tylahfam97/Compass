// ─── Compass — encrypted SQLite backend ──────────────────────────────────────
//
// Replaces tauri-plugin-sql with a custom command layer backed by rusqlite +
// SQLCipher.  The encryption key is a 32-byte random value stored in the OS's
// native secure credential store via the `keyring` crate - Windows Credential
// Manager (DPAPI-backed) on Windows, Keychain on macOS - so it is bound to the
// current OS user account and is never visible to the user. The `keyring`
// crate picks the correct backend per-platform automatically; nothing here is
// Windows-specific despite the historical comments below.
//
// On first launch the key is generated and the database is created encrypted.
// On upgrade from an unencrypted build, the existing plaintext DB is silently
// migrated to an encrypted copy before the app opens.

use std::sync::Mutex;
use rusqlite::{Connection, Error as RusqliteError, ErrorCode};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};

// ─── State ────────────────────────────────────────────────────────────────────

pub struct DbState(pub Mutex<Connection>);

// ─── Return types ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecResult {
    last_insert_id: i64,
    rows_affected: usize,
}

/// One SQL statement + its bound params, as sent from the frontend for batch execution.
#[derive(serde::Deserialize)]
struct BatchStatement {
    sql: String,
    #[serde(default)]
    params: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportRowError {
    index: usize,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportBatchResult {
    duplicate_indices: Vec<usize>,
    errors: Vec<ImportRowError>,
}

// ─── Parameter binding ────────────────────────────────────────────────────────

fn json_to_sql(v: &Value) -> Box<dyn rusqlite::ToSql> {
    match v {
        Value::Null      => Box::new(rusqlite::types::Null),
        Value::Bool(b)   => Box::new(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() { Box::new(i) }
            else { Box::new(n.as_f64().unwrap_or(0.0)) }
        }
        Value::String(s) => Box::new(s.clone()),
        _                => Box::new(rusqlite::types::Null),
    }
}

// ─── SQL statement allowlists ─────────────────────────────────────────────────
//
// All SQL executed through the frontend is written as literal strings in the
// TypeScript source — no dynamic statement construction, only parameterised
// values.  These validators enforce that even if a malicious script were ever
// injected into the WebView, it cannot call db_execute / db_select with an
// arbitrary statement type (e.g. DROP TABLE, ATTACH DATABASE, PRAGMA key).
//
// The lists are intentionally narrow: only the exact statement families used
// by Compass are permitted.

fn validate_execute_sql(sql: &str) -> Result<(), String> {
    // Collapse leading whitespace/newlines produced by template literals.
    let s = sql.trim().to_ascii_lowercase();
    const ALLOWED: &[&str] = &[
        "insert",           // INSERT INTO …, INSERT OR IGNORE …, INSERT OR REPLACE …
        "update",           // UPDATE … SET …
        "delete",           // DELETE FROM …
        "create table",     // CREATE TABLE IF NOT EXISTS …
        "create index",     // CREATE INDEX IF NOT EXISTS …
        "create unique index",
        "alter table",      // ALTER TABLE … ADD COLUMN …
        "drop table",       // DROP TABLE … (used by schema migrations)
        "pragma user_version =", // schema version write
    ];
    if !ALLOWED.iter().any(|p| s.starts_with(p)) {
        return Err(format!("db_execute: statement type not permitted"));
    }
    // Defense-in-depth: reject stacked statements. No statement executed by
    // Compass ever legitimately contains a `;` (each db.execute call is a
    // single statement), so this can never break real traffic.
    if s.contains(';') {
        return Err(format!("db_execute: multiple statements not permitted"));
    }
    // Defense-in-depth: reject inline SQL comments, EXCEPT inside CREATE TABLE
    // — one migration documents a column with a trailing `-- stock | etf | …`
    // comment, which is a legitimate, hardcoded, non-user-influenced string.
    if !s.starts_with("create table") && s.contains("--") {
        return Err(format!("db_execute: SQL comments not permitted"));
    }
    Ok(())
}

fn validate_select_sql(sql: &str) -> Result<(), String> {
    let s = sql.trim().to_ascii_lowercase();
    const ALLOWED: &[&str] = &[
        "select",
        "with",              // CTEs
        "pragma table_info(", // column introspection used during migrations
        "pragma user_version", // schema version read
    ];
    if !ALLOWED.iter().any(|p| s.starts_with(p)) {
        return Err(format!("db_select: statement type not permitted"));
    }
    // Defense-in-depth: no legitimate SELECT/WITH/PRAGMA string ever contains
    // a `;` or a `--` comment marker — reject both unconditionally.
    if s.contains(';') || s.contains("--") {
        return Err(format!("db_select: multiple statements or comments not permitted"));
    }
    Ok(())
}

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn db_execute(
    state: State<'_, DbState>,
    sql: String,
    params: Vec<Value>,
) -> Result<ExecResult, String> {
    validate_execute_sql(&sql)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let bound: Vec<Box<dyn rusqlite::ToSql>> = params.iter().map(json_to_sql).collect();
    let refs: Vec<&dyn rusqlite::ToSql> = bound.iter().map(|b| b.as_ref()).collect();

    let rows_affected = conn
        .execute(&sql, refs.as_slice())
        .map_err(|e| e.to_string())?;

    Ok(ExecResult {
        last_insert_id: conn.last_insert_rowid(),
        rows_affected,
    })
}

#[tauri::command]
fn db_select(
    state: State<'_, DbState>,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    validate_select_sql(&sql)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let bound: Vec<Box<dyn rusqlite::ToSql>> = params.iter().map(json_to_sql).collect();
    let refs: Vec<&dyn rusqlite::ToSql> = bound.iter().map(|b| b.as_ref()).collect();

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let col_names: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(|s| s.to_string())
        .collect();

    let rows = stmt
        .query_map(refs.as_slice(), |row| {
            let mut map = Map::new();
            for (i, name) in col_names.iter().enumerate() {
                use rusqlite::types::ValueRef;
                let val = match row.get_ref(i)? {
                    ValueRef::Null    => Value::Null,
                    ValueRef::Integer(n) => Value::Number(n.into()),
                    ValueRef::Real(f) => serde_json::Number::from_f64(f)
                        .map(Value::Number)
                        .unwrap_or(Value::Null),
                    ValueRef::Text(b) => Value::String(
                        std::str::from_utf8(b).unwrap_or("").to_string(),
                    ),
                    ValueRef::Blob(b) => Value::String(hex::encode(b)),
                };
                map.insert(name.clone(), val);
            }
            Ok(map)
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(rows)
}

/// Runs every statement inside ONE real SQLite transaction, rolling back all of them if any
/// statement fails - used for schema migrations, where a rebuild (rename -> create -> copy ->
/// drop) must never be left half-applied by a mid-sequence crash or error. Each statement still
/// passes through `validate_execute_sql`, same as `db_execute` - this only adds transactional
/// wrapping around the SAME allowed statement types, it does not let the frontend send raw
/// BEGIN/COMMIT/ROLLBACK.
fn execute_batch_tx(conn: &mut Connection, statements: &[BatchStatement]) -> Result<(), String> {
    for stmt in statements {
        validate_execute_sql(&stmt.sql)?;
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for stmt in statements {
        let bound: Vec<Box<dyn rusqlite::ToSql>> = stmt.params.iter().map(json_to_sql).collect();
        let refs: Vec<&dyn rusqlite::ToSql> = bound.iter().map(|b| b.as_ref()).collect();
        tx.execute(&stmt.sql, refs.as_slice())
            .map_err(|e| format!("migration statement failed, rolled back ({}): {e}", stmt.sql))?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_execute_batch(state: State<'_, DbState>, statements: Vec<BatchStatement>) -> Result<(), String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    execute_batch_tx(&mut conn, &statements)
}

/// Inserts a batch of already-prepared transaction rows inside ONE transaction. Unlike
/// `execute_batch_tx`, a single row's failure does NOT abort the whole import (imports are
/// deliberately resilient to a handful of bad/duplicate rows) - instead each row's outcome is
/// classified so the frontend can report real duplicates separately from genuine errors, rather
/// than folding everything into "skipped as duplicate". The transaction still guarantees that a
/// mid-import crash rolls back the ENTIRE batch instead of leaving a half-imported file (previously
/// every row was its own autocommitted statement).
fn insert_import_batch_tx(conn: &mut Connection, statements: &[BatchStatement]) -> Result<ImportBatchResult, String> {
    for stmt in statements {
        validate_execute_sql(&stmt.sql)?;
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut duplicate_indices = Vec::new();
    let mut errors = Vec::new();
    for (index, stmt) in statements.iter().enumerate() {
        let bound: Vec<Box<dyn rusqlite::ToSql>> = stmt.params.iter().map(json_to_sql).collect();
        let refs: Vec<&dyn rusqlite::ToSql> = bound.iter().map(|b| b.as_ref()).collect();
        match tx.execute(&stmt.sql, refs.as_slice()) {
            Ok(_) => {}
            // Only the UNIQUE-constraint case is a real duplicate (matches the
            // `UNIQUE(account_id, import_hash)` constraint transactions/loan statements rely on
            // for dedup) - NOT NULL/CHECK/FOREIGN KEY violations share the same coarse
            // `ErrorCode::ConstraintViolation` but are genuine data errors, not duplicates, so
            // they must fall through to the `errors` bucket instead of being mislabeled.
            Err(RusqliteError::SqliteFailure(ref err, _))
                if err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
            {
                duplicate_indices.push(index);
            }
            Err(e) => errors.push(ImportRowError { index, message: e.to_string() }),
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ImportBatchResult { duplicate_indices, errors })
}

#[tauri::command]
fn import_transactions_batch(
    state: State<'_, DbState>,
    statements: Vec<BatchStatement>,
) -> Result<ImportBatchResult, String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    insert_import_batch_tx(&mut conn, &statements)
}

#[cfg(test)]
mod batch_tx_tests {
    use super::*;

    fn stmt(sql: &str) -> BatchStatement {
        BatchStatement { sql: sql.to_string(), params: vec![] }
    }

    /// Mirrors the v9-style goals rebuild (rename -> create -> copy -> drop -> bump version).
    #[test]
    fn migration_batch_commits_full_rebuild_atomically() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE goals (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
             INSERT INTO goals (id, name) VALUES (1, 'Emergency Fund');
             PRAGMA user_version = 8;",
        )
        .unwrap();

        let statements = vec![
            stmt("ALTER TABLE goals RENAME TO goals_v8"),
            stmt("CREATE TABLE goals (id INTEGER PRIMARY KEY, name TEXT NOT NULL, target_months INTEGER)"),
            stmt("INSERT INTO goals (id, name, target_months) SELECT id, name, NULL FROM goals_v8"),
            stmt("DROP TABLE goals_v8"),
            stmt("PRAGMA user_version = 9"),
        ];
        execute_batch_tx(&mut conn, &statements).expect("batch should succeed");

        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 9);
        let name: String = conn
            .query_row("SELECT name FROM goals WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Emergency Fund");
        let old_table_gone: Result<i64, _> =
            conn.query_row("SELECT count(*) FROM sqlite_master WHERE name='goals_v8'", [], |r| r.get(0));
        assert_eq!(old_table_gone.unwrap(), 0);
    }

    /// A failure partway through the rebuild must roll back EVERYTHING - the original table
    /// under its original name, untouched, and user_version unchanged - not left renamed away
    /// with no replacement.
    #[test]
    fn migration_batch_rolls_back_entirely_on_mid_sequence_failure() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE goals (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
             INSERT INTO goals (id, name) VALUES (1, 'Emergency Fund');
             PRAGMA user_version = 8;",
        )
        .unwrap();

        let statements = vec![
            stmt("ALTER TABLE goals RENAME TO goals_v8"),
            stmt("CREATE TABLE goals (id INTEGER PRIMARY KEY, name TEXT NOT NULL, target_months INTEGER)"),
            // Deliberately broken: references a column that doesn't exist on goals_v8.
            stmt("INSERT INTO goals (id, name, target_months) SELECT id, does_not_exist, NULL FROM goals_v8"),
            stmt("DROP TABLE goals_v8"),
            stmt("PRAGMA user_version = 9"),
        ];
        let result = execute_batch_tx(&mut conn, &statements);
        assert!(result.is_err());

        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 8, "user_version must not bump on a rolled-back migration");
        let name: String = conn
            .query_row("SELECT name FROM goals WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Emergency Fund", "original goals table must survive intact under its original name");
    }

    #[test]
    fn import_batch_classifies_duplicates_and_errors_without_aborting() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE transactions (
                id INTEGER PRIMARY KEY,
                account_id INTEGER NOT NULL,
                description TEXT NOT NULL,
                import_hash TEXT NOT NULL,
                UNIQUE(account_id, import_hash)
             );",
        )
        .unwrap();

        let insert = |account_id: i64, description: &str, hash: &str| BatchStatement {
            sql: "INSERT INTO transactions (account_id, description, import_hash) VALUES (?, ?, ?)".to_string(),
            params: vec![
                Value::Number(account_id.into()),
                Value::String(description.to_string()),
                Value::String(hash.to_string()),
            ],
        };

        let statements = vec![
            insert(1, "Coffee", "hash-a"),      // inserted
            insert(1, "Coffee", "hash-a"),      // duplicate (same account+hash)
            BatchStatement {
                // genuine error: description is NOT NULL, violated here
                sql: "INSERT INTO transactions (account_id, description, import_hash) VALUES (?, NULL, ?)".to_string(),
                params: vec![Value::Number(1.into()), Value::String("hash-b".to_string())],
            },
            insert(1, "Groceries", "hash-c"),   // inserted
        ];
        let result = insert_import_batch_tx(&mut conn, &statements).expect("batch commits despite row errors");

        assert_eq!(result.duplicate_indices, vec![1]);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].index, 2);

        let count: i64 = conn.query_row("SELECT count(*) FROM transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2, "successful rows must be committed even though other rows in the batch failed");
    }
}

// ─── Key management ───────────────────────────────────────────────────────────

const KEYRING_SERVICE: &str = "com.compass.app";
const KEYRING_USER: &str = "db_encryption_key";
/// Set when the encryption key had to be recovered from the compass.key backup file because the
/// OS keyring lost or couldn't read its entry - surfaced in-app so repeated keyring loss
/// (Credential Manager resets, Keychain corruption) is visible instead of stderr-only.
static KEY_RESTORED_FROM_BACKUP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// True when this launch had to fall back to the compass.key backup file for the DB key.
#[tauri::command]
fn key_recovered_from_backup() -> bool {
    KEY_RESTORED_FROM_BACKUP.load(std::sync::atomic::Ordering::Relaxed)
}

fn generate_key() -> String {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    hex::encode(bytes)
}

fn is_valid_key(key: &str) -> bool {
    key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit())
}

/// Creates `path` only if nothing exists there yet (never truncates), owner-only (0600) on Unix.
/// On Windows the file inherits the per-user ACL of the app data directory.
fn create_owner_only(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    }
    opts.open(path)
}

/// Makes new/renamed entries in `dir` durable (Unix). Failures are returned, not hidden.
fn sync_dir(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::fs::File::open(dir)
            .and_then(|d| d.sync_all())
            .map_err(|e| format!("could not flush {}: {e}", dir.display()))?;
    }
    let _ = dir;
    Ok(())
}

/// Writes `bytes` durably to a brand-new file `<prefix><n>` in `dir`, using the first n whose
/// name is free. Existing files are never opened, truncated or removed; only a file this call
/// created is cleaned up on failure.
fn write_new_file(dir: &std::path::Path, prefix: &str, bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    use std::io::Write;
    for n in 0..10_000 {
        let path = dir.join(format!("{prefix}{n}"));
        let mut file = match create_owner_only(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("could not create {}: {e}", path.display())),
        };
        let written = file.write_all(bytes).and_then(|_| file.sync_all());
        drop(file);
        return match written
            .map_err(|e| format!("could not write {}: {e}", path.display()))
            .and_then(|()| sync_dir(dir))
        {
            Ok(()) => Ok(path),
            Err(e) => {
                let _ = std::fs::remove_file(&path); // created by this call
                Err(e)
            }
        };
    }
    Err(format!("no free file name for {prefix}* in {}", dir.display()))
}

/// Saves a key file durably: new owner-only temp file (fsynced), atomic rename onto `path`,
/// directory fsync, read-back. Returns Err instead of logging so no caller can mistake "not
/// saved" for "saved". Callers that may replace existing key material use `replace_key_file`.
fn write_key_file_atomic(path: &std::path::Path, value: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("key file has no parent directory")?;
    let name = path.file_name().and_then(|n| n.to_str()).ok_or("key file name is not valid text")?;
    let tmp_path = write_new_file(dir, &format!("{name}.tmp{}-", std::process::id()), value.as_bytes())?;
    let result = std::fs::rename(&tmp_path, path)
        .map_err(|e| format!("could not save {}: {e}", path.display()))
        .and_then(|()| sync_dir(dir))
        .and_then(|()| match read_key_file(path) {
            Some(k) if k == value => Ok(()),
            _ => Err(format!("{} did not read back correctly after saving", path.display())),
        });
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_path); // this call's own temp file; gone once renamed
    }
    result
}

/// Puts `key` in `key_path`. Whatever is already there and differs - another key, garbage, a file
/// that cannot be parsed - is first kept as a new `compass.key.unmatched-<n>`. If it cannot be read
/// or kept, the existing file is left alone and this fails.
fn replace_key_file(key_path: &std::path::Path, key: &str) -> Result<(), String> {
    if key_path.symlink_metadata().is_ok() {
        let old = std::fs::read(key_path).map_err(|e| {
            format!("{} exists but could not be read to keep a copy ({e}); it was left unchanged", key_path.display())
        })?;
        if String::from_utf8_lossy(&old).trim() == key {
            return Ok(());
        }
        let dir = key_path.parent().ok_or("key file has no parent directory")?;
        let kept = write_new_file(dir, "compass.key.unmatched-", &old)?;
        eprintln!("[compass] Kept the previous key file as {}.", kept.display());
    }
    write_key_file_atomic(key_path, key)
}

/// Reads the OS credential store. `readable` is true when the store answered (a value or NoEntry),
/// i.e. its current content is known and can be kept before it is replaced.
fn read_keyring(entry: &Result<keyring::Entry, String>) -> (Option<String>, bool) {
    match entry {
        Ok(e) => match e.get_password() {
            Ok(k) => (Some(k), true),
            Err(keyring::Error::NoEntry) => (None, true),
            Err(err) => {
                eprintln!("[compass] Keyring read error ({err}) - using the key file.");
                (None, false)
            }
        },
        Err(err) => {
            eprintln!("[compass] Keyring unavailable ({err}) - using the key file.");
            (None, false)
        }
    }
}

/// Best-effort: puts `key` in the credential store after keeping any different value it held as a
/// new `compass.key.unmatched-<n>` in `data_dir`. An unreadable store, or a value that could not be
/// kept, is left alone. Only called once compass.key durably holds `key`.
fn sync_keyring(entry: &Result<keyring::Entry, String>, old: Option<&str>, readable: bool, key: &str, data_dir: &std::path::Path) {
    let Ok(e) = entry else { return };
    if !readable || old.map(str::trim) == Some(key) {
        return;
    }
    let kept = match old {
        Some(old) => write_new_file(data_dir, "compass.key.unmatched-", old.as_bytes())
            .map(|p| eprintln!("[compass] Kept the previous keyring key as {}.", p.display())),
        None => Ok(()),
    };
    if let Err(err) = kept.and_then(|()| e.set_password(key).map_err(|err| err.to_string())) {
        eprintln!("[compass] Keyring not updated (compass.key holds the key): {err}");
    }
}

/// Retries a few times with a short delay before giving up - defends against a purely
/// transient read failure (e.g. antivirus briefly holding the file) being mistaken for
/// "the backup file is genuinely missing/invalid".
fn read_key_file_with_retry(path: &std::path::Path) -> Option<String> {
    for attempt in 0..5 {
        if let Some(key) = read_key_file(path) {
            return Some(key);
        }
        if attempt < 4 {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    None
}

fn read_key_file(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let key = raw.trim().to_string();
    // Sanity-check: must be exactly 64 hex characters (32 bytes).
    is_valid_key(&key).then_some(key)
}

/// Creates a brand-new key and returns it only once `compass.key` durably holds it. The keyring
/// copy is added later, best-effort. If the file cannot be saved, nothing may be encrypted with
/// the key and nothing may be created unencrypted either, so this fails with an actionable error.
fn create_persisted_key(key_path: &std::path::Path) -> Result<String, String> {
    let key = generate_key();
    replace_key_file(key_path, &key).map_err(|e| {
        format!(
            "Compass could not save a new database encryption key ({e}). No database was created or \
             changed. Make sure {} is writable (free disk space, folder permissions, antivirus), \
             then relaunch Compass.",
            key_path.parent().map(|p| p.display().to_string()).unwrap_or_default()
        )
    })?;
    Ok(key)
}

// ─── Database open / migration ────────────────────────────────────────────────

fn apply_key(conn: &Connection, hex_key: &str) -> Result<(), RusqliteError> {
    conn.pragma_update(None, "key", format!("x'{hex_key}'"))?;
    conn.execute_batch("SELECT count(*) FROM sqlite_master")?;
    Ok(())
}

fn is_plaintext_sqlite(path: &std::path::Path) -> bool {
    Connection::open(path)
        .and_then(|c| c.execute_batch("SELECT count(*) FROM sqlite_master"))
        .is_ok()
}

#[derive(Clone, Copy, PartialEq)]
enum DbFile {
    Missing,
    Plaintext,
    /// Present but unreadable without a key: encrypted (or damaged). Never replaced or rekeyed.
    Encrypted,
}

fn classify_db(db_path: &std::path::Path) -> DbFile {
    if !db_path.exists() {
        DbFile::Missing
    } else if is_plaintext_sqlite(db_path) {
        DbFile::Plaintext
    } else {
        DbFile::Encrypted
    }
}

/// Converts a legacy plaintext database in place. The original is only moved aside after the
/// encrypted copy has been verified with the key, every failure after that restores it, and the
/// plaintext copy is deleted only once the encrypted database has reopened successfully.
/// Leftovers from an earlier attempt are never reused or deleted: they stop the conversion.
fn migrate_to_encrypted(db_path: &std::path::Path, hex_key: &str) -> Result<Connection, String> {
    let enc_path = db_path.with_extension("enc.db");
    let bak_path = db_path.with_extension("db.bak");
    for leftover in [&bak_path, &enc_path] {
        if leftover.symlink_metadata().is_ok() {
            return Err(format!(
                "{} already exists from an earlier upgrade attempt. Nothing was changed. Move that \
                 file somewhere safe, then relaunch Compass.",
                leftover.display()
            ));
        }
    }
    let enc_path_str = enc_path.to_str().ok_or("migrate: non-UTF-8 path")?;
    let export_result = Connection::open(db_path)
        .map_err(|e| format!("migrate open src: {e}"))
        .and_then(|src| {
            src.execute_batch(&format!(
                "ATTACH DATABASE '{enc}' AS encrypted KEY \"x'{key}'\";\
                 SELECT sqlcipher_export('encrypted');\
                 DETACH DATABASE encrypted;",
                enc = enc_path_str.replace('\\', "/").replace('\'', "''"),
                key = hex_key,
            ))
            .map_err(|e| format!("migrate export: {e}"))
        })
        .and_then(|()| {
            let copy = Connection::open(&enc_path).map_err(|e| format!("migrate verify: {e}"))?;
            apply_key(&copy, hex_key).map_err(|e| format!("migrate verify: {e}"))
        });
    if let Err(e) = export_result {
        let _ = std::fs::remove_file(&enc_path); // did not exist before this call
        return Err(format!("{e}. Your original database was not changed."));
    }

    if let Err(e) = std::fs::rename(db_path, &bak_path) {
        let _ = std::fs::remove_file(&enc_path);
        return Err(format!("migrate rename original: {e}. Your original database was not changed."));
    }
    let restore_original = |why: String| -> String {
        match std::fs::rename(&bak_path, db_path) {
            Ok(()) => format!("{why}. Your original database was restored unchanged."),
            Err(e) => format!(
                "{why}. Restoring the original also failed ({e}): it is safe at {} - rename it to \
                 compass.db before relaunching.",
                bak_path.display()
            ),
        }
    };
    if let Err(e) = std::fs::rename(&enc_path, db_path) {
        return Err(restore_original(format!("migrate rename encrypted copy: {e}")));
    }
    let reopened = Connection::open(db_path).and_then(|conn| apply_key(&conn, hex_key).map(|()| conn));
    match reopened {
        Ok(conn) => {
            if let Err(e) = std::fs::remove_file(&bak_path) {
                eprintln!(
                    "[compass] Could not delete the unencrypted copy {} ({e}); delete it yourself.",
                    bak_path.display()
                );
            }
            eprintln!("[compass] Migration to encrypted DB complete.");
            Ok(conn)
        }
        Err(e) => {
            let _ = std::fs::rename(db_path, &enc_path);
            Err(restore_original(format!("migrate reopen: {e}")))
        }
    }
}

/// Files that may hold the user's data when compass.db itself is missing.
fn recovery_leftover(data_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    std::fs::read_dir(data_dir).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
            n == "compass.db.bak"
                || n == "compass.enc.db"
                || n == "compass.db.pending"
                || n.starts_with("compass.db.beforerestore")
        })
    })
}

/// Opens (creating if needed) the encrypted database in `data_dir`.
///
/// Key sources are the OS credential store (Windows Credential Manager / macOS Keychain via
/// `keyring`) and the `compass.key` file next to the database. Rules:
///  - An existing encrypted database is opened only with a key that actually decrypts it. It is
///    never re-keyed, replaced, renamed or treated as empty; with no working key this fails and
///    leaves every file as it was.
///  - No database is created or converted until `compass.key` durably holds its key. A new key is
///    generated only when there is no encrypted database to orphan.
///  - There is no unencrypted fallback: if no key can be obtained and saved, nothing is created.
///  - A missing compass.db next to upgrade/restore leftovers stops startup instead of starting empty.
///  - Key material that differs from the working key (keyring entry or key file) is kept as a new
///    `compass.key.unmatched-<n>` before being replaced; if it cannot be kept, it is not replaced.
fn open_db_in(data_dir: &std::path::Path) -> Result<Connection, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| format!("create data dir: {e}"))?;
    let db_path = data_dir.join("compass.db");
    let key_path = data_dir.join("compass.key");
    let state = classify_db(&db_path);
    if state == DbFile::Missing {
        if let Some(leftover) = recovery_leftover(data_dir) {
            return Err(format!(
                "{} is missing but {} exists - an earlier upgrade or restore did not finish. Nothing \
                 was changed. Move that file back to compass.db (or out of this folder to start \
                 empty), then relaunch Compass.",
                db_path.display(),
                leftover.display()
            ));
        }
    }

    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| format!("keyring init: {e}"));
    let (keyring_raw, keyring_readable) = read_keyring(&entry);
    let from_keyring = keyring_raw.as_deref().map(str::trim).filter(|k| is_valid_key(k)).map(str::to_string);
    let from_file = read_key_file_with_retry(&key_path);
    let mut candidates: Vec<String> = from_keyring.iter().chain(from_file.iter()).cloned().collect();
    candidates.dedup();

    let key = match state {
        DbFile::Encrypted => {
            if candidates.is_empty() {
                return Err(format!(
                    "an existing database was found at {} but no encryption key was found in the \
                     OS credential store or in {}. The database has NOT been modified. Restore \
                     compass.key (or a .compassbackup) to unlock it.",
                    db_path.display(),
                    key_path.display()
                ));
            }
            let mut opened = None;
            for k in &candidates {
                let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
                match apply_key(&conn, k) {
                    Ok(()) => {
                        opened = Some(k.clone());
                        break;
                    }
                    Err(RusqliteError::SqliteFailure(ref err, _)) if err.code == ErrorCode::NotADatabase => {}
                    Err(e) => return Err(format!("db key error: {e}")),
                }
            }
            let key = opened.ok_or_else(|| {
                format!(
                    "the database at {} could not be opened with the key from the OS credential \
                     store or compass.key (different key, or a damaged file). The file has NOT been \
                     modified, renamed, or deleted.",
                    db_path.display()
                )
            })?;
            if from_file.as_deref() != Some(key.as_str()) {
                if let Err(err) = replace_key_file(&key_path, &key) {
                    eprintln!("[compass] Key file not refreshed: {err}");
                }
            }
            key
        }
        DbFile::Missing | DbFile::Plaintext => {
            let key = match candidates.first() {
                Some(k) => k.clone(),
                None => create_persisted_key(&key_path)?,
            };
            replace_key_file(&key_path, &key).map_err(|e| {
                format!(
                    "Compass could not save the database encryption key to {} ({e}). No database \
                     was created or changed.",
                    key_path.display()
                )
            })?;
            key
        }
    };

    if from_keyring.as_deref() != Some(key.as_str()) && from_file.as_deref() == Some(key.as_str()) {
        KEY_RESTORED_FROM_BACKUP.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    sync_keyring(&entry, keyring_raw.as_deref(), keyring_readable, &key, data_dir);

    match state {
        DbFile::Plaintext => migrate_to_encrypted(&db_path, &key),
        DbFile::Missing | DbFile::Encrypted => {
            let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
            apply_key(&conn, &key).map_err(|e| format!("db key error: {e}"))?;
            Ok(conn)
        }
    }
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    open_db_in(&data_dir)
}

// ─── Backup / restore ──────────────────────────────────────────────────────────
//
// Custom minimal container format (avoids pulling in a zip crate for two files): magic
// bytes, then the key file's bytes length-prefixed, then the db file's bytes length-prefixed.
// Transported to/from the frontend as a hex string (reusing the `hex` crate already a
// dependency for the key file, rather than adding base64 or shipping a raw byte array through
// JSON, which bloats IPC payload size significantly for a multi-MB database).
//
// Export snapshots the live database via SQLite's `VACUUM INTO` (taken while holding the same
// mutex db_execute/db_select use), which produces a single consistent copy instead of racing a
// raw file read against a concurrent write/journal/page change - a plain `fs::read` cannot
// guarantee that on its own. The key file changes far less often and is written atomically
// (write_key_file_atomic), so a plain read of it is fine.
//
// Restore is staged, never applied immediately: the live `compass.db` is held open by this
// process's `Connection` for the whole session, and on Windows a rename/overwrite of a file
// with an open handle from the SAME process is not reliably safe. `stage_backup_restore`
// validates the backup (test-opens a throwaway copy with its embedded key) and writes
// `compass.db.pending` / `compass.key.pending` next to the real files. The frontend must call
// `relaunch()` immediately after success - the actual swap happens in `run()`'s `.setup()`,
// via `apply_pending_restore_if_any()`, BEFORE any connection is opened on the next launch.

const BACKUP_MAGIC: &[u8] = b"COMPASSBAK1";

#[tauri::command]
fn export_backup_bytes(app: AppHandle, state: State<'_, DbState>) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    backup_bytes(&data_dir, &conn).map(hex::encode)
}

/// The backup container for the live database: a VACUUM INTO snapshot plus compass.key, refused
/// unless that key opens the snapshot (so a backup is never plaintext or unrestorable).
fn backup_bytes(data_dir: &std::path::Path, conn: &Connection) -> Result<Vec<u8>, String> {
    // Unique temp path (pid-scoped) for the VACUUM INTO snapshot - target must not already exist.
    let snapshot_path = data_dir.join(format!("compass.backup-snapshot.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&snapshot_path); // clean up any leftover from a previous crash
    {
        let snapshot_str = snapshot_path.to_str().ok_or("export: non-UTF-8 app data path")?;
        conn.execute(
            &format!("VACUUM INTO '{}'", snapshot_str.replace('\'', "''")),
            [],
        )
        .map_err(|e| format!("could not snapshot database: {e}"))?;
    }
    let key_bytes = std::fs::read(data_dir.join("compass.key")).map_err(|e| {
        format!(
            "could not read encryption key file: {e}. Try relaunching Compass once first so the \
             key backup file is (re)written."
        )
    });
    // A backup is only useful if its key opens its database - check the pair before handing it out.
    let pair_ok = key_bytes.as_ref().map_err(|e| e.clone()).and_then(|k| {
        let key = std::str::from_utf8(k).map_err(|_| "key file is not valid text".to_string())?.trim();
        let conn = Connection::open(&snapshot_path).map_err(|e| e.to_string())?;
        apply_key(&conn, key).map_err(|_| {
            "the key file does not open the database snapshot, so the backup would not restore. \
             Relaunch Compass and try again."
                .to_string()
        })
    });
    let db_bytes_result = pair_ok.and_then(|()| {
        std::fs::read(&snapshot_path).map_err(|e| format!("could not read database snapshot: {e}"))
    });
    let _ = std::fs::remove_file(&snapshot_path);
    let db_bytes = db_bytes_result?;
    let key_bytes = key_bytes?;

    let mut out = Vec::with_capacity(BACKUP_MAGIC.len() + 16 + key_bytes.len() + db_bytes.len());
    out.extend_from_slice(BACKUP_MAGIC);
    out.extend_from_slice(&(key_bytes.len() as u64).to_le_bytes());
    out.extend_from_slice(&key_bytes);
    out.extend_from_slice(&(db_bytes.len() as u64).to_le_bytes());
    out.extend_from_slice(&db_bytes);
    Ok(out)
}

fn parse_backup(bytes: &[u8]) -> Result<(&[u8], &[u8]), String> {
    if bytes.len() < BACKUP_MAGIC.len() || &bytes[..BACKUP_MAGIC.len()] != BACKUP_MAGIC {
        return Err("this file doesn't look like a Compass backup".to_string());
    }
    let read_u64 = |off: usize| -> Result<usize, String> {
        bytes
            .get(off..off + 8)
            .map(|s| u64::from_le_bytes(s.try_into().unwrap()) as usize)
            .ok_or_else(|| "backup file is truncated or corrupt".to_string())
    };
    let mut offset = BACKUP_MAGIC.len();
    let key_len = read_u64(offset)?;
    offset += 8;
    let key_bytes = bytes
        .get(offset..offset + key_len)
        .ok_or_else(|| "backup file is truncated or corrupt".to_string())?;
    offset += key_len;
    let db_len = read_u64(offset)?;
    offset += 8;
    let db_bytes = bytes
        .get(offset..offset + db_len)
        .ok_or_else(|| "backup file is truncated or corrupt".to_string())?;
    Ok((key_bytes, db_bytes))
}

#[tauri::command]
fn stage_backup_restore(app: AppHandle, hex: String) -> Result<(), String> {
    let bytes = hex::decode(hex.trim()).map_err(|_| "invalid backup data".to_string())?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    stage_restore_in(&data_dir, &bytes)
}

fn stage_restore_in(data_dir: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let (key_bytes, db_bytes) = parse_backup(bytes)?;
    let key_str = std::str::from_utf8(key_bytes)
        .map_err(|_| "backup's encryption key is not valid text".to_string())?
        .trim();
    if key_str.len() != 64 || !key_str.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("backup's encryption key is not in the expected format".to_string());
    }

    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;

    // Validate the backup actually opens with its own key BEFORE staging anything, using a
    // throwaway probe file (never the pending path itself) so a bad backup can't leave a
    // half-staged restore behind.
    let probe_path = data_dir.join("compass.db.restoreprobe");
    std::fs::write(&probe_path, db_bytes).map_err(|e| format!("write probe db: {e}"))?;
    let probe_result: Result<(), String> = (|| {
        let conn = Connection::open(&probe_path).map_err(|e| e.to_string())?;
        apply_key(&conn, key_str).map_err(|_| {
            "the backup's key could not open its database - the backup file may be corrupt or \
             from a different install"
                .to_string()
        })
    })();
    let _ = std::fs::remove_file(&probe_path);
    probe_result?;

    write_key_file_atomic(&data_dir.join("compass.key.pending"), key_str)
        .map_err(|e| format!("stage key: {e}"))?;
    std::fs::write(data_dir.join("compass.db.pending"), db_bytes)
        .map_err(|e| format!("stage db: {e}"))?;

    Ok(())
}

/// Called once at startup, BEFORE `open_db()` opens the live connection - swaps a staged
/// restore into place if `stage_backup_restore` left one behind on a previous run. The
/// previous live files are kept as `.beforerestore` (or `.beforerestore-<n>` when earlier ones
/// exist - those are never overwritten).
///
/// The db and key are treated as a single pair: if any step after the first rename fails, every
/// step already taken is unwound, and the newly placed pair is probe-opened together before being
/// trusted - a failed probe rolls back too. Returns Err only when that unwinding itself failed, so
/// startup stops instead of opening something that is not the user's database.
fn apply_pending_restore_if_any(data_dir: &std::path::Path) -> Result<(), String> {
    let pending_db = data_dir.join("compass.db.pending");
    let pending_key = data_dir.join("compass.key.pending");
    if !pending_db.exists() || !pending_key.exists() {
        return Ok(());
    }
    eprintln!("[compass] Applying staged backup restore...");
    let db_path = data_dir.join("compass.db");
    let key_path = data_dir.join("compass.key");
    let suffix = (0..10_000)
        .map(|n| if n == 0 { String::new() } else { format!("-{n}") })
        .find(|s| {
            !db_path.with_extension(format!("db.beforerestore{s}")).exists()
                && !key_path.with_extension(format!("key.beforerestore{s}")).exists()
        })
        .ok_or("too many .beforerestore files - move some out of the app data folder, then relaunch Compass")?;
    let db_before = db_path.with_extension(format!("db.beforerestore{suffix}"));
    let key_before = key_path.with_extension(format!("key.beforerestore{suffix}"));
    let had_previous_db = db_path.exists();
    let had_previous_key = key_path.exists();

    // Undo exactly the steps taken so far; Err names whatever could not be put back.
    let rollback = |db_aside: bool, key_aside: bool, db_placed: bool, key_placed: bool| -> Result<(), String> {
        let mut failed = Vec::new();
        let mut undo = |from: &std::path::Path, to: &std::path::Path| {
            if let Err(e) = std::fs::rename(from, to) {
                failed.push(format!("{} -> {}: {e}", from.display(), to.display()));
            }
        };
        if db_placed {
            undo(db_path.as_path(), pending_db.as_path());
        }
        if key_placed {
            undo(key_path.as_path(), pending_key.as_path());
        }
        if db_aside {
            undo(db_before.as_path(), db_path.as_path());
        }
        if key_aside {
            undo(key_before.as_path(), key_path.as_path());
        }
        if failed.is_empty() {
            eprintln!("[compass] Restore rolled back - the previous database/key are still in place.");
            Ok(())
        } else {
            Err(format!(
                "a backup restore failed and could not be fully undone ({}). Nothing was deleted; \
                 move those files back by hand, then relaunch Compass.",
                failed.join("; ")
            ))
        }
    };

    if had_previous_db {
        if let Err(e) = std::fs::rename(&db_path, &db_before) {
            eprintln!("[compass] Failed to preserve previous database before restore: {e}");
            return Ok(()); // nothing changed
        }
    }
    if had_previous_key {
        if let Err(e) = std::fs::rename(&key_path, &key_before) {
            eprintln!("[compass] Failed to preserve previous key before restore: {e}");
            return rollback(had_previous_db, false, false, false);
        }
    }
    if let Err(e) = std::fs::rename(&pending_db, &db_path) {
        eprintln!("[compass] Failed to finalize restored database: {e}");
        return rollback(had_previous_db, had_previous_key, false, false);
    }
    if let Err(e) = std::fs::rename(&pending_key, &key_path) {
        eprintln!("[compass] Failed to finalize restored key: {e}");
        return rollback(had_previous_db, had_previous_key, true, false);
    }

    // Verify the newly-placed pair actually opens together before trusting it.
    let probe: Result<(), String> = (|| {
        let key_str = std::fs::read_to_string(&key_path).map_err(|e| e.to_string())?;
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        apply_key(&conn, key_str.trim()).map_err(|e| e.to_string())
    })();
    if let Err(e) = probe {
        eprintln!("[compass] Restored database failed to open with its key ({e})");
        return rollback(had_previous_db, had_previous_key, true, true);
    }
    // Refresh the keyring too (keeping its old value), so future launches don't depend solely on
    // the file.
    if let Some(key) = read_key_file(&key_path) {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string());
        let (old, readable) = read_keyring(&entry);
        sync_keyring(&entry, old.as_deref(), readable, &key, data_dir);
    }
    eprintln!("[compass] Restore applied successfully.");
    Ok(())
}

// ─── Entry point ──────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let _ = std::fs::create_dir_all(&data_dir);
            apply_pending_restore_if_any(&data_dir)
                .expect("Failed to apply a staged backup restore");
            let conn = open_db(app.handle())
                .expect("Failed to open compass database");
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_execute,
            db_select,
            db_execute_batch,
            import_transactions_batch,
            export_backup_bytes,
            stage_backup_restore,
            key_recovered_from_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


/// Regression tests for the key/open path, against real SQLCipher files in a temp dir. The OS
/// keyring is replaced by an in-process store (keyring's documented custom-builder hook), so these
/// never touch a developer's real Credential Manager / Keychain entry.
///
/// CI also runs this module against the released v1.3.4 code (see .github/red-baseline/), so it may
/// only call functions that exist there after the pure-move seam: open_db_in, backup_bytes,
/// stage_restore_in, apply_pending_restore_if_any (result ignored), parse_backup, apply_key,
/// is_plaintext_sqlite, read_key_file.
#[cfg(test)]
mod key_safety_tests {
    use super::*;
    use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi};
    use std::path::{Path, PathBuf};
    use std::sync::{atomic::AtomicUsize, Mutex, MutexGuard};

    #[derive(Clone, Copy)]
    enum Store {
        Durable,       // works and remembers across Entry instances
        Unavailable,   // Entry::new itself fails
        Broken,        // Entry exists, every read/write errors
        ForgetsWrites, // writes "succeed" but nothing is kept
    }
    static MODE: Mutex<Store> = Mutex::new(Store::Durable);
    static SAVED: Mutex<Option<String>> = Mutex::new(None);
    static SERIAL: Mutex<()> = Mutex::new(());
    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    // Poison-tolerant: one failing test must not turn every later test red.
    fn lock<T>(m: &'static Mutex<T>) -> MutexGuard<'static, T> {
        m.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn mode() -> Store {
        *lock(&MODE)
    }
    fn saved() -> Option<String> {
        lock(&SAVED).clone()
    }
    fn down() -> keyring::Error {
        keyring::Error::PlatformFailure("test credential store is down".into())
    }

    struct TestCred;
    impl CredentialApi for TestCred {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            match mode() {
                Store::Durable => {
                    *lock(&SAVED) = Some(String::from_utf8(secret.to_vec()).unwrap());
                    Ok(())
                }
                Store::ForgetsWrites => Ok(()),
                _ => Err(down()),
            }
        }
        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            match mode() {
                Store::Durable | Store::ForgetsWrites => saved().map(String::into_bytes).ok_or(keyring::Error::NoEntry),
                _ => Err(down()),
            }
        }
        fn delete_credential(&self) -> keyring::Result<()> {
            *lock(&SAVED) = None;
            Ok(())
        }
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }
    struct TestBuilder;
    impl CredentialBuilderApi for TestBuilder {
        fn build(&self, _: Option<&str>, _: &str, _: &str) -> keyring::Result<Box<Credential>> {
            match mode() {
                Store::Unavailable => Err(keyring::Error::NoStorageAccess("no credential store".into())),
                _ => Ok(Box::new(TestCred)),
            }
        }
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    const KEY_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const KEY_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    /// Serializes tests (the keyring builder is process-global) and returns a fresh empty dir.
    fn setup(store: Store, keyring_value: Option<&str>) -> (MutexGuard<'static, ()>, PathBuf) {
        let guard = lock(&SERIAL);
        keyring::set_default_credential_builder(Box::new(TestBuilder));
        *lock(&MODE) = store;
        *lock(&SAVED) = keyring_value.map(str::to_string);
        KEY_RESTORED_FROM_BACKUP.store(false, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "compass-key-test-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (guard, dir)
    }
    /// Makes compass.key unwritable and unreadable by putting a directory at its path.
    fn block_key_file(dir: &Path) {
        std::fs::create_dir_all(dir.join("compass.key")).unwrap();
    }
    fn make_db(path: &Path, key: Option<&str>) {
        let conn = Connection::open(path).unwrap();
        if let Some(k) = key {
            apply_key(&conn, k).unwrap();
        }
        conn.execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');").unwrap();
    }
    fn rows(conn: &Connection) -> String {
        conn.query_row("SELECT group_concat(v) FROM t", [], |r| r.get(0)).unwrap()
    }
    fn bytes(path: &Path) -> Option<Vec<u8>> {
        std::fs::read(path).ok()
    }
    #[cfg(unix)]
    fn owner_only(path: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o077 == 0
    }

    #[test]
    fn fresh_install_without_any_key_storage_fails_and_creates_no_plaintext_db() {
        let (_g, dir) = setup(Store::Unavailable, None);
        block_key_file(&dir);
        assert!(open_db_in(&dir).is_err(), "must not open without a stored key");
        let db = dir.join("compass.db");
        assert!(!db.exists() || !is_plaintext_sqlite(&db), "no usable plaintext database may exist");
    }

    #[test]
    fn broken_keyring_falls_back_to_a_durable_key_file_and_reopens() {
        let (_g, dir) = setup(Store::Broken, None);
        {
            let conn = open_db_in(&dir).expect("key-file fallback should work when the file can be saved");
            conn.execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');").unwrap();
        }
        let db = dir.join("compass.db");
        assert!(!is_plaintext_sqlite(&db), "database must be encrypted");
        let key = read_key_file(&dir.join("compass.key")).expect("key file saved");
        #[cfg(unix)]
        {
            assert!(owner_only(&dir.join("compass.key")), "key file must be owner-only");
        }
        let reopened = open_db_in(&dir).expect("restart must reopen with the saved key");
        assert_eq!(rows(&reopened), "kept");
        let direct = Connection::open(&db).unwrap();
        apply_key(&direct, &key).expect("the saved key is the database key");
    }

    #[test]
    fn new_key_that_cannot_be_persisted_is_never_used() {
        let (_g, dir) = setup(Store::ForgetsWrites, None);
        block_key_file(&dir);
        assert!(open_db_in(&dir).is_err(), "an unsaved key must not encrypt anything");
        assert!(!dir.join("compass.db").exists(), "no database may be created with a lost key");
    }

    /// A key only in the keyring would leave Export Backup and restore without compass.key.
    #[test]
    fn new_key_requires_a_saved_key_file_even_if_the_keyring_works() {
        let (_g, dir) = setup(Store::Durable, None);
        block_key_file(&dir);
        assert!(open_db_in(&dir).is_err());
        assert!(!dir.join("compass.db").exists(), "no database without compass.key");
        assert!(saved().is_none(), "the unusable key is not left in the keyring either");
    }

    #[test]
    fn existing_encrypted_db_without_a_key_is_left_untouched() {
        let (_g, dir) = setup(Store::Durable, None);
        let db = dir.join("compass.db");
        make_db(&db, Some(KEY_A));
        let before = bytes(&db);
        assert!(open_db_in(&dir).is_err());
        assert_eq!(bytes(&db), before, "database bytes unchanged");
        assert!(!dir.join("compass.key").exists(), "no replacement key generated");
        assert!(saved().is_none(), "no replacement key stored");
    }

    #[test]
    fn existing_encrypted_db_with_wrong_key_is_left_untouched() {
        let (_g, dir) = setup(Store::Durable, None);
        let db = dir.join("compass.db");
        make_db(&db, Some(KEY_A));
        std::fs::write(dir.join("compass.key"), KEY_B).unwrap();
        let before = bytes(&db);
        assert!(open_db_in(&dir).is_err());
        assert_eq!(bytes(&db), before);
        assert_eq!(read_key_file(&dir.join("compass.key")).as_deref(), Some(KEY_B), "key file kept");
    }

    /// e.g. a restore whose keyring refresh failed: keyring holds the old key, the file the new one.
    #[test]
    fn stale_keyring_key_never_overwrites_the_key_that_opens_the_db() {
        let (_g, dir) = setup(Store::Durable, Some(KEY_A));
        make_db(&dir.join("compass.db"), Some(KEY_B));
        std::fs::write(dir.join("compass.key"), KEY_B).unwrap();
        let conn = open_db_in(&dir).expect("the key file's key opens the database");
        assert_eq!(rows(&conn), "kept");
        assert_eq!(read_key_file(&dir.join("compass.key")).as_deref(), Some(KEY_B));
        assert_eq!(saved().as_deref(), Some(KEY_B), "keyring re-synced to the working key");
        let kept = dir.join("compass.key.unmatched-0");
        assert_eq!(read_key_file(&kept).as_deref(), Some(KEY_A), "the replaced keyring key is kept");
        #[cfg(unix)]
        {
            assert!(owner_only(&kept));
        }
    }

    #[test]
    fn invalid_existing_key_file_is_kept_aside_without_overwriting_earlier_copies() {
        let (_g, dir) = setup(Store::Durable, None);
        std::fs::write(dir.join("compass.key"), "not-a-key").unwrap();
        std::fs::write(dir.join("compass.key.unmatched-0"), "older copy").unwrap();
        let conn = open_db_in(&dir).expect("fresh install with an unusable key file");
        conn.execute_batch("CREATE TABLE t (v TEXT);").unwrap();
        assert_eq!(bytes(&dir.join("compass.key.unmatched-0")).as_deref(), Some(&b"older copy"[..]));
        let kept = dir.join("compass.key.unmatched-1");
        assert_eq!(bytes(&kept).as_deref(), Some(&b"not-a-key"[..]), "old key file content kept");
        #[cfg(unix)]
        {
            assert!(owner_only(&kept));
        }
        assert!(read_key_file(&dir.join("compass.key")).is_some());
    }

    #[test]
    fn leftover_temp_files_are_never_overwritten_or_deleted() {
        let (_g, dir) = setup(Store::Durable, None);
        let old_tmp = dir.join("compass.key.tmp");
        let own_tmp = dir.join(format!("compass.key.tmp{}-0", std::process::id()));
        std::fs::write(&old_tmp, KEY_A).unwrap();
        std::fs::write(&own_tmp, KEY_B).unwrap();
        open_db_in(&dir).expect("fresh install");
        assert_eq!(read_key_file(&old_tmp).as_deref(), Some(KEY_A));
        assert_eq!(read_key_file(&own_tmp).as_deref(), Some(KEY_B));
    }

    #[test]
    fn legacy_plaintext_db_is_encrypted_without_data_loss() {
        let (_g, dir) = setup(Store::Durable, None);
        let db = dir.join("compass.db");
        make_db(&db, None);
        {
            let conn = open_db_in(&dir).expect("plaintext database is upgraded");
            assert_eq!(rows(&conn), "kept");
        }
        assert!(!is_plaintext_sqlite(&db), "upgraded database is encrypted");
        assert!(!dir.join("compass.db.bak").exists() && !dir.join("compass.enc.db").exists());
        assert_eq!(rows(&open_db_in(&dir).expect("restart reopens")), "kept");
    }

    #[test]
    fn plaintext_db_is_untouched_when_no_key_can_be_saved() {
        let (_g, dir) = setup(Store::Unavailable, None);
        block_key_file(&dir);
        let db = dir.join("compass.db");
        make_db(&db, None);
        let before = bytes(&db);
        assert!(open_db_in(&dir).is_err());
        assert_eq!(bytes(&db), before, "original kept byte-for-byte");
    }

    /// The export fails part-way (page 2 is cut off); only the copy this run created is removed.
    #[test]
    fn failed_plaintext_conversion_keeps_the_original() {
        let (_g, dir) = setup(Store::Durable, Some(KEY_A));
        let db = dir.join("compass.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "PRAGMA page_size = 4096; CREATE TABLE t (v TEXT);
                 INSERT INTO t VALUES (hex(randomblob(3000))), (hex(randomblob(3000)));",
            )
            .unwrap();
        }
        std::fs::OpenOptions::new().write(true).open(&db).unwrap().set_len(4096).unwrap();
        let before = bytes(&db);
        assert!(open_db_in(&dir).is_err());
        assert_eq!(bytes(&db), before);
        assert!(!dir.join("compass.enc.db").exists() && !dir.join("compass.db.bak").exists());
    }

    /// compass.enc.db that this run did not create is unknown recovery material.
    #[test]
    fn leftover_encrypted_copy_is_never_deleted_or_reused() {
        let (_g, dir) = setup(Store::Durable, Some(KEY_A));
        let db = dir.join("compass.db");
        make_db(&db, None);
        let enc = dir.join("compass.enc.db");
        std::fs::write(&enc, "unknown").unwrap();
        let before = bytes(&db);
        assert!(open_db_in(&dir).is_err());
        assert_eq!(bytes(&enc).as_deref(), Some(&b"unknown"[..]));
        assert_eq!(bytes(&db), before);
    }

    #[test]
    fn missing_db_next_to_upgrade_or_restore_leftovers_never_starts_empty() {
        let (_g, dir) = setup(Store::Durable, Some(KEY_A));
        for name in ["compass.db.bak", "compass.enc.db", "compass.db.beforerestore", "compass.db.pending"] {
            let sub = dir.join(name.replace('.', "_"));
            std::fs::create_dir_all(&sub).unwrap();
            let leftover = sub.join(name);
            make_db(&leftover, None);
            let before = bytes(&leftover);
            assert!(open_db_in(&sub).is_err(), "must not start empty next to {name}");
            assert!(!sub.join("compass.db").exists(), "{name}");
            assert_eq!(bytes(&leftover), before, "{name}");
        }
    }

    /// export_backup_bytes relies on VACUUM INTO keeping the source key.
    #[test]
    fn vacuum_into_snapshot_opens_with_the_same_key() {
        let (_g, dir) = setup(Store::Durable, None);
        let db = dir.join("compass.db");
        make_db(&db, Some(KEY_A));
        let snap = dir.join("snapshot.tmp");
        let conn = Connection::open(&db).unwrap();
        apply_key(&conn, KEY_A).unwrap();
        conn.execute(&format!("VACUUM INTO '{}'", snap.to_str().unwrap().replace('\'', "''")), []).unwrap();
        assert!(!is_plaintext_sqlite(&snap), "snapshot must not be plaintext");
        let copy = Connection::open(&snap).unwrap();
        apply_key(&copy, KEY_A).expect("snapshot decrypts with the database key");
        assert_eq!(rows(&copy), "kept");
    }

    /// Export -> stage -> next-launch apply -> open, through the real backup/restore functions.
    #[test]
    fn backup_round_trip_restores_and_keeps_every_earlier_copy() {
        let (_g, dir) = setup(Store::Durable, None);
        let conn = open_db_in(&dir).expect("fresh install");
        conn.execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');").unwrap();
        let backup = backup_bytes(&dir, &conn).expect("export");
        let (_, snapshot) = parse_backup(&backup).unwrap();
        assert!(!snapshot.starts_with(b"SQLite format 3"), "backup database is encrypted");
        conn.execute_batch("INSERT INTO t VALUES ('after backup');").unwrap();
        let earlier = dir.join("compass.db.beforerestore");
        std::fs::write(&earlier, "an earlier restore's copy").unwrap();
        stage_restore_in(&dir, &backup).expect("stage");
        drop(conn);
        let _ = apply_pending_restore_if_any(&dir);
        assert_eq!(rows(&open_db_in(&dir).expect("open after restore")), "kept");
        assert_eq!(bytes(&earlier).as_deref(), Some(&b"an earlier restore's copy"[..]));
        let previous = Connection::open(dir.join("compass.db.beforerestore-1")).unwrap();
        apply_key(&previous, &read_key_file(&dir.join("compass.key")).unwrap()).unwrap();
        assert_eq!(rows(&previous), "kept,after backup", "pre-restore database kept");
    }

    #[test]
    fn restore_that_does_not_open_rolls_back_to_the_live_db() {
        let (_g, dir) = setup(Store::Durable, None);
        open_db_in(&dir).unwrap().execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');").unwrap();
        make_db(&dir.join("compass.db.pending"), Some(KEY_B));
        std::fs::write(dir.join("compass.key.pending"), KEY_A).unwrap();
        let before = bytes(&dir.join("compass.db"));
        let _ = apply_pending_restore_if_any(&dir);
        assert_eq!(bytes(&dir.join("compass.db")), before);
        assert!(dir.join("compass.db.pending").exists() && dir.join("compass.key.pending").exists());
        assert_eq!(rows(&open_db_in(&dir).expect("live database still opens")), "kept");
    }
}
