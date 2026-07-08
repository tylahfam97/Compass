use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Account {
    pub id: i64,
    pub name: String,
    pub account_type: String,
    pub institution: String,
    pub created_at: String,
}

#[tauri::command]
pub async fn get_accounts() -> Result<Vec<Account>, String> {
    // Placeholder — queries will go through tauri-plugin-sql from the frontend
    Ok(vec![])
}
