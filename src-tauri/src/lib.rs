mod commands;

use tauri_plugin_sql::{Builder as SqlBuilder, Migration, MigrationKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial_schema",
            sql: include_str!("../migrations/001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "column_profiles",
            sql: include_str!("../migrations/002_column_profiles.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "goals",
            sql: include_str!("../migrations/003_goals.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            SqlBuilder::new()
                .add_migrations("sqlite:compass.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::accounts::get_accounts,
            commands::transactions::get_transactions,
            commands::categories::get_categories,
            commands::budgets::get_budgets,
            commands::import::parse_csv,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
