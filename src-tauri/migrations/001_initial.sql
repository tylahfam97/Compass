-- Compass Phase 1 — Initial Schema
-- All monetary values stored as integer cents to avoid floating-point issues

CREATE TABLE IF NOT EXISTS accounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    account_type TEXT    NOT NULL DEFAULT 'checking', -- checking | savings | credit | investment
    institution  TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    color     TEXT    NOT NULL DEFAULT '#6b7280',
    icon      TEXT    NOT NULL DEFAULT 'circle',
    is_system INTEGER NOT NULL DEFAULT 0 -- 1 = built-in, cannot be deleted
);

CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date         TEXT    NOT NULL,               -- ISO 8601: YYYY-MM-DD
    amount_cents INTEGER NOT NULL,               -- negative = expense, positive = income
    description  TEXT    NOT NULL DEFAULT '',
    category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    notes        TEXT,
    import_hash  TEXT    NOT NULL UNIQUE,        -- SHA-256 of raw import row for deduplication
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categorization_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern     TEXT    NOT NULL,                -- substring or regex to match on description
    match_type  TEXT    NOT NULL DEFAULT 'contains', -- contains | starts_with | regex
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    priority    INTEGER NOT NULL DEFAULT 0       -- higher = checked first
);

CREATE TABLE IF NOT EXISTS budgets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL,
    period      TEXT    NOT NULL DEFAULT 'monthly', -- monthly | weekly
    start_date  TEXT    NOT NULL DEFAULT (date('now', 'start of month')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS custom_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    filters_json TEXT   NOT NULL DEFAULT '{}',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Seed default system categories
INSERT OR IGNORE INTO categories (id, name, parent_id, color, icon, is_system) VALUES
    (1,  'Income',          NULL, '#22c55e', 'trending-up',    1),
    (2,  'Housing',         NULL, '#3b82f6', 'home',           1),
    (3,  'Food & Dining',   NULL, '#f97316', 'utensils',       1),
    (4,  'Transportation',  NULL, '#8b5cf6', 'car',            1),
    (5,  'Healthcare',      NULL, '#ec4899', 'heart-pulse',    1),
    (6,  'Entertainment',   NULL, '#eab308', 'tv',             1),
    (7,  'Shopping',        NULL, '#06b6d4', 'shopping-bag',   1),
    (8,  'Personal Care',   NULL, '#a78bfa', 'sparkles',       1),
    (9,  'Education',       NULL, '#14b8a6', 'book-open',      1),
    (10, 'Savings',         NULL, '#10b981', 'piggy-bank',     1),
    (11, 'Utilities',       2,    '#60a5fa', 'zap',            1),
    (12, 'Rent / Mortgage', 2,    '#3b82f6', 'building',       1),
    (13, 'Groceries',       3,    '#fb923c', 'shopping-cart',  1),
    (14, 'Restaurants',     3,    '#f97316', 'utensils',       1),
    (15, 'Uncategorized',   NULL, '#9ca3af', 'circle-help',    1);

-- Unique index so INSERT OR IGNORE deduplicates rules across re-runs
CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_unique
    ON categorization_rules(pattern, category_id);

-- Default categorization rules (matched case-insensitively against description)
INSERT OR IGNORE INTO categorization_rules (pattern, match_type, category_id, priority) VALUES
    -- Income
    ('DIRECT DEPOSIT',   'contains', 1,  100),
    ('PAYCHECK',         'contains', 1,  100),
    ('PAYROLL',          'contains', 1,  100),
    -- Housing
    ('RENT PAYMENT',     'contains', 12,  90),
    ('MORTGAGE',         'contains', 12,  90),
    -- Utilities
    ('ELECTRIC COMPANY', 'contains', 11,  80),
    ('COMCAST',          'contains', 11,  80),
    ('SPECTRUM',         'contains', 11,  80),
    ('VERIZON WIRELESS', 'contains', 11,  80),
    ('AT&T',             'contains', 11,  80),
    -- Groceries
    ('WHOLE FOODS',      'contains', 13,  70),
    ('KROGER',           'contains', 13,  70),
    ('TRADER JOE',       'contains', 13,  70),
    ('ALDI',             'contains', 13,  70),
    ('PUBLIX',           'contains', 13,  70),
    ('SAFEWAY',          'contains', 13,  70),
    ('WEGMANS',          'contains', 13,  70),
    -- Delivery before generic Uber
    ('UBER EATS',        'contains', 14,  65),
    ('DOORDASH',         'contains', 14,  65),
    ('GRUBHUB',          'contains', 14,  65),
    -- Restaurants
    ('STARBUCKS',        'contains', 14,  60),
    ('CHIPOTLE',         'contains', 14,  60),
    ('MCDONALD',         'contains', 14,  60),
    ('PANERA',           'contains', 14,  60),
    ('CHICK-FIL-A',      'contains', 14,  60),
    ('SUBWAY',           'contains', 14,  60),
    ('DUNKIN',           'contains', 14,  60),
    -- Transportation
    ('UBER TRIP',        'contains', 4,   55),
    ('LYFT',             'contains', 4,   55),
    ('SHELL OIL',        'contains', 4,   55),
    ('CHEVRON',          'contains', 4,   55),
    ('EXXON',            'contains', 4,   55),
    -- Entertainment
    ('NETFLIX',          'contains', 6,   50),
    ('SPOTIFY',          'contains', 6,   50),
    ('HULU',             'contains', 6,   50),
    ('DISNEY PLUS',      'contains', 6,   50),
    ('AMC THEATER',      'contains', 6,   50),
    ('TICKETMASTER',     'contains', 6,   50),
    ('BOWLING',          'contains', 6,   50),
    -- Healthcare
    ('CVS PHARMACY',     'contains', 5,   50),
    ('WALGREENS',        'contains', 5,   50),
    ('URGENT CARE',      'contains', 5,   50),
    -- Personal Care
    ('ULTA BEAUTY',      'contains', 8,   45),
    ('GREAT CLIPS',      'contains', 8,   45),
    -- Shopping
    ('AMAZON',           'contains', 7,   40),
    ('TARGET',           'contains', 7,   40),
    ('BEST BUY',         'contains', 7,   40),
    ('WALMART',          'contains', 7,   40);
