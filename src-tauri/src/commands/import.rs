use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)] // used in Phase 1 import pipeline
pub struct ImportResult {
    pub imported: usize,
    pub duplicates_skipped: usize,
    pub errors: Vec<String>,
}

/// Parse a CSV bank statement and return raw row data.
/// Actual DB insertion is handled on the frontend via tauri-plugin-sql
/// so the user can review/map columns before committing.
#[tauri::command]
pub async fn parse_csv(path: String) -> Result<Vec<Vec<String>>, String> {
    use std::fs::File;
    use std::io::{BufRead, BufReader};

    let file = File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut rows: Vec<Vec<String>> = vec![];

    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let fields: Vec<String> = line.split(',').map(|f| f.trim().to_string()).collect();
        rows.push(fields);
    }

    Ok(rows)
}
