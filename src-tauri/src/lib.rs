// All schema migrations are handled by the TypeScript layer (src/lib/db.ts).
// The SQL plugin is registered here with no migrations so it simply opens the database.

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
