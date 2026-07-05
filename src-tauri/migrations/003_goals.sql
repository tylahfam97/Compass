-- Migration 3: financial goals tracking
CREATE TABLE IF NOT EXISTS goals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    type          TEXT    NOT NULL CHECK(type IN ('net_savings','reduce_spend','increase_income')),
    category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    target_cents  INTEGER NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
