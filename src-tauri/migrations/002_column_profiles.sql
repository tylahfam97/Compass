-- Migration 2: remember column layouts per bank CSV format
CREATE TABLE IF NOT EXISTS column_profiles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    header_sig  TEXT    NOT NULL UNIQUE, -- sorted, lowercased headers joined by '|'
    date_col    INTEGER NOT NULL,
    desc_col    INTEGER NOT NULL,
    amount_col  INTEGER NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
