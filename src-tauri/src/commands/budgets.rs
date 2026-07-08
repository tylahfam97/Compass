use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Budget {
    pub id: i64,
    pub category_id: i64,
    pub amount_cents: i64,
    pub period: String,
    pub start_date: String,
}

#[tauri::command]
pub async fn get_budgets() -> Result<Vec<Budget>, String> {
    Ok(vec![])
}
