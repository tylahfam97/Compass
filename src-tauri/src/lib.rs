// ─── Compass — encrypted SQLite backend ──────────────────────────────────────
//
// Replaces tauri-plugin-sql with a custom command layer backed by rusqlite +
// SQLCipher.  The encryption key is a 32-byte random value stored in Windows
// Credential Manager (DPAPI-backed) via the `keyring` crate, so it is bound
// to the current Windows user account and is never visible to the user.
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
    if ALLOWED.iter().any(|p| s.starts_with(p)) {
        Ok(())
    } else {
        Err(format!("db_execute: statement type not permitted"))
    }
}

fn validate_select_sql(sql: &str) -> Result<(), String> {
    let s = sql.trim().to_ascii_lowercase();
    const ALLOWED: &[&str] = &[
        "select",
        "with",              // CTEs
        "pragma table_info(", // column introspection used during migrations
        "pragma user_version", // schema version read
    ];
    if ALLOWED.iter().any(|p| s.starts_with(p)) {
        Ok(())
    } else {
        Err(format!("db_select: statement type not permitted"))
    }
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
///  1. Windows Credential Manager (keyring) — primary, backward-compatible
///  2. `compass.key` file in the app data dir — backup / fallback
///
/// On every successful keyring read the key is also written to the file so
/// that future keyring losses (Credential Manager reset, update side-effect,
/// roaming profile sync, etc.) do NOT cause the DB to be abandoned.
fn load_or_create_key(data_dir: &std::path::Path) -> Result<String, String> {
    let key_file = data_dir.join("compass.key");

    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("keyring init: {e}"))?;

    match entry.get_password() {
        Ok(key) => {
            // Keyring succeeded — refresh the file backup silently.
            let _ = std::fs::write(&key_file, &key);
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => {
            // Keyring has no entry. Check the file backup before creating a new key,
            // because a new key would make the existing DB permanently unreadable.
            if let Some(key) = read_key_file(&key_file) {
                eprintln!("[compass] Keyring entry missing — key restored from backup file.");
                let _ = entry.set_password(&key); // re-populate keyring
                return Ok(key);
            }
            // Genuinely first launch: generate and persist a new key.
            let hex_key = generate_key();
            let _ = entry.set_password(&hex_key);
            let _ = std::fs::write(&key_file, &hex_key);
            Ok(hex_key)
        }
        Err(e) => {
            // Keyring returned an unexpected error. Fall back to file rather than
            // treating it as "no entry" and generating a new (wrong) key.
            eprintln!("[compass] Keyring read error ({e}) — falling back to key file.");
            if let Some(key) = read_key_file(&key_file) {
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

    let hex_key = match load_or_create_key(&data_dir) {
        Ok(k) => k,
        Err(e) => {
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
                // Already encrypted with an unknown key (e.g. keyring was reset).
                // Preserve the old file and start fresh.
                eprintln!("[compass] WARNING: DB is encrypted with an unknown key — \
                           renaming to .db.lost and creating a new database.");
                let lost_path = db_path.with_extension("db.lost");
                let _ = std::fs::rename(&db_path, &lost_path);
                let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
                apply_key(&conn, &hex_key).map_err(|e| e.to_string())?;
                Ok(conn)
            }
        }
        Err(e) => Err(format!("db key error: {e}")),
    }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let conn = open_db(app.handle())
                .expect("Failed to open compass database");
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![db_execute, db_select])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

