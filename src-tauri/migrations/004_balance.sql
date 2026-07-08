-- Migration 4: running balance per transaction + balance column mapping
ALTER TABLE transactions ADD COLUMN balance_cents INTEGER;
ALTER TABLE column_profiles ADD COLUMN balance_col INTEGER NOT NULL DEFAULT -1;