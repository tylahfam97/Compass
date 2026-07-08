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

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn db_execute(
    state: State<'_, DbState>,
    sql: String,
    params: Vec<Value>,
) -> Result<ExecResult, String> {
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

fn load_or_create_key() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("keyring init: {e}"))?;

    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
            let hex_key = hex::encode(bytes);
            entry.set_password(&hex_key)
                .map_err(|e| format!("keyring write: {e}"))?;
            Ok(hex_key)
        }
        Err(e) => Err(format!("keyring read: {e}")),
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

    let hex_key = match load_or_create_key() {
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

