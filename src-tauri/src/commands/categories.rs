use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub color: String,
    pub icon: String,
    pub is_system: bool,
}

#[tauri::command]
pub async fn get_categories() -> Result<Vec<Category>, String> {
    Ok(vec![])
}
