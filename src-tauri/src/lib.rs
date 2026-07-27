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

// ─── Key management ───────────────────────────────────────────────────────────

const KEYRING_SERVICE: &str = "com.compass.app";
const KEYRING_USER: &str = "db_encryption_key";

/// Load the encryption key, using a two-tier strategy:
///  1. OS native credential store (via `keyring`) - primary, backward-compatible.
///     Windows Credential Manager on Windows, Keychain on macOS - `keyring`
///     selects the right backend automatically per-platform.
///  2. `compass.key` file in the app data dir — backup / fallback
///
/// On every successful keyring read the key is also written to the file so
/// that future keyring losses (Credential Manager reset, update side-effect,
/// roaming profile sync, etc.) do NOT cause the DB to be abandoned.
///
/// `db_exists` gates the ONE dangerous branch here: generating a brand-new key. If a database
/// already exists on disk, a new (necessarily wrong) key would silently orphan it - the
/// existing DB would look "encrypted with an unknown key" and get renamed away, replaced by an
/// empty one, with no error shown to the user. So a new key is only ever generated on a
/// genuinely fresh install (no DB file yet). If a DB exists and no valid key can be found
/// anywhere after retrying the file read (to rule out a transient lock, e.g. antivirus scanning
/// mid-read), this returns an error instead of guessing - callers must NOT treat that error as
/// "proceed unencrypted" for an existing database.
fn load_or_create_key(data_dir: &std::path::Path, db_exists: bool) -> Result<String, String> {
    let key_file = data_dir.join("compass.key");

    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("keyring init: {e}"))?;

    match entry.get_password() {
        Ok(key) => {
            // Keyring succeeded — refresh the file backup silently.
            write_key_file_atomic(&key_file, &key);
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => {
            // Keyring has no entry. Check the file backup before creating a new key,
            // because a new key would make the existing DB permanently unreadable.
            if let Some(key) = read_key_file_with_retry(&key_file) {
                eprintln!("[compass] Keyring entry missing — key restored from backup file.");
                if let Err(e) = entry.set_password(&key) {
                    eprintln!("[compass] Failed to re-populate keyring after restoring from backup: {e}");
                }
                return Ok(key);
            }
            if db_exists {
                return Err(format!(
                    "an existing database was found at {} but no valid encryption key could be \
                     located in the OS keyring or in the compass.key backup file after retrying - \
                     refusing to generate a new key, which would make that database permanently \
                     unreadable. The database has NOT been modified.",
                    data_dir.display()
                ));
            }
            // Genuinely first launch (no DB file yet): generate and persist a new key.
            let hex_key = generate_key();
            if let Err(e) = entry.set_password(&hex_key) {
                eprintln!("[compass] Failed to save new key to keyring (will rely on the file backup instead): {e}");
            }
            write_key_file_atomic(&key_file, &hex_key);
            Ok(hex_key)
        }
        Err(e) => {
            // Keyring returned an unexpected error. Fall back to file rather than
            // treating it as "no entry" and generating a new (wrong) key.
            eprintln!("[compass] Keyring read error ({e}) — falling back to key file.");
            if let Some(key) = read_key_file_with_retry(&key_file) {
                return Ok(key);
            }
            Err(format!("keyring read: {e}"))
        }
    }
}

fn generate_key() -> String {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    hex::encode(bytes)
}

/// Writes the key file via a temp-file-then-rename so a reader can never observe a partially
/// written (torn) file - a plain `fs::write` truncates-then-writes in place, so a read that
/// races with it (another process, an antivirus scan, a crash mid-write) could see a truncated
/// file that fails `read_key_file`'s sanity check, which previously looked identical to "the key
/// file doesn't exist" and could trigger generating a brand-new (wrong) key. `rename` on the
/// same directory is atomic on both Windows and Unix.
fn write_key_file_atomic(path: &std::path::Path, value: &str) {
    let tmp_path = path.with_extension("key.tmp");
    if let Err(e) = std::fs::write(&tmp_path, value) {
        eprintln!("[compass] Failed to write key file backup: {e}");
        return;
    }
    if let Err(e) = std::fs::rename(&tmp_path, path) {
        eprintln!("[compass] Failed to finalize key file backup: {e}");
    }
}

/// Retries a few times with a short delay before giving up - defends against a purely
/// transient read failure (e.g. antivirus briefly holding the file, a race with another
/// process mid-write) being mistaken for "the backup file is genuinely missing/invalid", which
/// is the one mistake that can lead to silently generating a new key over an existing database.
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
    if key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(key)
    } else {
        None
    }
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

fn migrate_to_encrypted(db_path: &std::path::Path, hex_key: &str) -> Result<Connection, String> {
    let enc_path = db_path.with_extension("enc.db");
    // SQLite accepts forward slashes on Windows; escape single quotes in path
    let enc_path_str = enc_path
        .to_str()
        .ok_or("migrate: non-UTF-8 path")?;
    // Use sqlcipher_export() — the backup API cannot write to an encrypted destination
    let src = Connection::open(db_path)
        .map_err(|e| format!("migrate open src: {e}"))?;
    let export_result = src.execute_batch(&format!(
        "ATTACH DATABASE '{enc}' AS encrypted KEY \"x'{key}'\";\
         SELECT sqlcipher_export('encrypted');\
         DETACH DATABASE encrypted;",
        enc = enc_path_str.replace('\\', "/").replace('\'', "''"),
        key = hex_key,
    ));
    drop(src);
    // Clean up the partial enc file on any failure before propagating the error
    if let Err(e) = export_result {
        let _ = std::fs::remove_file(&enc_path);
        return Err(format!("migrate export: {e}"));
    }

    let bak_path = db_path.with_extension("db.bak");
    std::fs::rename(db_path, &bak_path)
        .map_err(|e| format!("migrate rename bak: {e}"))?;
    std::fs::rename(&enc_path, db_path)
        .map_err(|e| format!("migrate rename enc: {e}"))?;

    let conn = Connection::open(db_path)
        .map_err(|e| format!("migrate reopen: {e}"))?;
    apply_key(&conn, hex_key)
        .map_err(|e| format!("migrate reopen key: {e}"))?;

    let _ = std::fs::remove_file(&bak_path);
    eprintln!("[compass] Migration to encrypted DB complete.");
    Ok(conn)
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("create data dir: {e}"))?;
    let db_path = data_dir.join("compass.db");
    let db_exists = db_path.exists();

    let hex_key = match load_or_create_key(&data_dir, db_exists) {
        Ok(k) => k,
        Err(e) => {
            if db_exists {
                // An existing, presumably-encrypted database is on disk and we couldn't find a
                // key for it - do NOT open it unencrypted (that connection would just fail on
                // first real query anyway) and absolutely do not touch/replace the file. Fail
                // loudly instead, so this surfaces as a clear startup error rather than a
                // silently "empty" app.
                return Err(format!(
                    "could not load the database encryption key ({e}). Your existing database \
                     at {} was NOT modified or deleted."
                    , db_path.display()
                ));
            }
            eprintln!("[compass] WARNING: keyring unavailable ({e}), DB will be unencrypted");
            return Connection::open(&db_path).map_err(|e| e.to_string());
        }
    };

    if !db_path.exists() {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        apply_key(&conn, &hex_key).map_err(|e| e.to_string())?;
        return Ok(conn);
    }

    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    match apply_key(&conn, &hex_key) {
        Ok(()) => Ok(conn),
        Err(RusqliteError::SqliteFailure(ref err, _))
            if err.code == ErrorCode::NotADatabase =>
        {
            drop(conn);
            if is_plaintext_sqlite(&db_path) {
                eprintln!("[compass] Plaintext DB detected — migrating to encrypted...");
                migrate_to_encrypted(&db_path, &hex_key)
            } else {
                // Already encrypted with an unknown key (e.g. keyring was reset). Deliberately
                // do NOT rename/replace the file here - leave it exactly where it is so that if
                // the user (or a future in-app recovery flow) manages to locate the correct key,
                // simply relaunching works immediately with no manual file surgery required.
                // Fail loudly instead of silently swapping in an empty database - a user whose
                // real data suddenly "disappeared" with no error is a much worse outcome than an
                // explicit startup error saying what happened and that nothing was touched.
                Err(format!(
                    "the database at {} is encrypted with a different key than the one just \
                     loaded from the keyring/backup file. The file has NOT been modified, \
                     renamed, or deleted.",
                    db_path.display()
                ))
            }
        }
        Err(e) => Err(format!("db key error: {e}")),
    }
}

// ─── Backup / restore ──────────────────────────────────────────────────────────
//
// Custom minimal container format (avoids pulling in a zip crate for two files): magic
// bytes, then the key file's bytes length-prefixed, then the db file's bytes length-prefixed.
// Transported to/from the frontend as a hex string (reusing the `hex` crate already a
// dependency for the key file, rather than adding base64 or shipping a raw byte array through
// JSON, which bloats IPC payload size significantly for a multi-MB database).
//
// Export reads the two live files directly - safe here since every db_execute/db_select call
// is its own autocommitted statement (see validate_execute_sql/validate_select_sql above), so
// there's never a long-running transaction that a concurrent whole-file read could catch
// mid-write, the same assumption the README's manual "copy compass.db + compass.key" backup
// method already relies on.
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
fn export_backup_bytes(app: AppHandle) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_bytes = std::fs::read(data_dir.join("compass.db"))
        .map_err(|e| format!("could not read database file: {e}"))?;
    let key_bytes = std::fs::read(data_dir.join("compass.key")).map_err(|e| {
        format!(
            "could not read encryption key file: {e}. Try relaunching Compass once first so the \
             key backup file is (re)written."
        )
    })?;

    let mut out = Vec::with_capacity(BACKUP_MAGIC.len() + 16 + key_bytes.len() + db_bytes.len());
    out.extend_from_slice(BACKUP_MAGIC);
    out.extend_from_slice(&(key_bytes.len() as u64).to_le_bytes());
    out.extend_from_slice(&key_bytes);
    out.extend_from_slice(&(db_bytes.len() as u64).to_le_bytes());
    out.extend_from_slice(&db_bytes);
    Ok(hex::encode(out))
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
    let (key_bytes, db_bytes) = parse_backup(&bytes)?;
    let key_str = std::str::from_utf8(key_bytes)
        .map_err(|_| "backup's encryption key is not valid text".to_string())?
        .trim();
    if key_str.len() != 64 || !key_str.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("backup's encryption key is not in the expected format".to_string());
    }

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

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

    write_key_file_atomic(&data_dir.join("compass.key.pending"), key_str);
    std::fs::write(data_dir.join("compass.db.pending"), db_bytes)
        .map_err(|e| format!("stage db: {e}"))?;

    Ok(())
}

/// Called once at startup, BEFORE `open_db()` opens the live connection - swaps a staged
/// restore into place if `stage_backup_restore` left one behind on a previous run. The
/// previous live files are kept as `.beforerestore` backups rather than deleted outright, in
/// case the restored backup turns out to be the wrong one.
fn apply_pending_restore_if_any(data_dir: &std::path::Path) {
    let pending_db = data_dir.join("compass.db.pending");
    let pending_key = data_dir.join("compass.key.pending");
    if !pending_db.exists() || !pending_key.exists() {
        return;
    }
    eprintln!("[compass] Applying staged backup restore...");
    let db_path = data_dir.join("compass.db");
    let key_path = data_dir.join("compass.key");
    if db_path.exists() {
        let _ = std::fs::rename(&db_path, db_path.with_extension("db.beforerestore"));
    }
    if key_path.exists() {
        let _ = std::fs::rename(&key_path, key_path.with_extension("key.beforerestore"));
    }
    if let Err(e) = std::fs::rename(&pending_db, &db_path) {
        eprintln!("[compass] Failed to finalize restored database: {e}");
        return;
    }
    if let Err(e) = std::fs::rename(&pending_key, &key_path) {
        eprintln!("[compass] Failed to finalize restored key: {e}");
        return;
    }
    // Refresh the keyring too, so future launches don't depend solely on the file backup.
    if let Ok(key) = std::fs::read_to_string(&key_path) {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
            let _ = entry.set_password(key.trim());
        }
    }
    eprintln!("[compass] Restore applied successfully.");
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
            apply_pending_restore_if_any(&data_dir);
            let conn = open_db(app.handle())
                .expect("Failed to open compass database");
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![db_execute, db_select, export_backup_bytes, stage_backup_restore])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

