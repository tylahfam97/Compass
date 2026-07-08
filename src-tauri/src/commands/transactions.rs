use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Transaction {
    pub id: i64,
    pub account_id: i64,
    pub date: String,
    pub amount_cents: i64,
    pub description: String,
    pub category_id: Option<i64>,
    pub notes: Option<String>,
    pub import_hash: String,
}

#[tauri::command]
pub async fn get_transactions() -> Result<Vec<Transaction>, String> {
    // Placeholder — queries will go through tauri-plugin-sql from the frontend
    Ok(vec![])
}
