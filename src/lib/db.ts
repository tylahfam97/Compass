import { invoke } from "@tauri-apps/api/core";
import type { CategorizationRule } from "./types";

// ─── Invoke-based DB wrapper ──────────────────────────────────────────────────
// Mirrors the tauri-plugin-sql Database API (select / execute) so all call
// sites are unchanged.  Actual SQL runs through the encrypted rusqlite layer
// registered in src-tauri/src/lib.rs.

interface ExecResult {
  lastInsertId: number;
  rowsAffected: number;
}

class CompassDb {
  select<T>(sql: string, params: unknown[] = []): Promise<T> {
    return invoke<T>("db_select", { sql, params });
  }
  execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
    return invoke<ExecResult>("db_execute", { sql, params });
  }
}

// ─── Singleton with lazy migration ───────────────────────────────────────────

let _initPromise: Promise<CompassDb> | null = null;

export function getDb(): Promise<CompassDb> {
  if (!_initPromise) {
    _initPromise = (async () => {
      const db = new CompassDb();
      await runMigrations(db);
      return db;
    })();
  }
  return _initPromise;
}

// ─── Schema migration ─────────────────────────────────────────────────────────

// Allowlist for table names used in dynamic PRAGMA/ALTER statements.
// PRAGMA table_info() and ALTER TABLE do not support parameterized inputs in
// SQLite, so we validate against this set to prevent injection.
const ALLOWED_MIGRATION_TABLES = new Set([
  "accounts",
  "transactions",
  "budgets",
  "goals",
  "categories",
  "categorization_rules",
  "column_profiles",
  "profiles",
]);

const SAFE_COLUMN_NAME_RE = /^[a-z_][a-z0-9_]*$/i;

function assertSafeMigrationIdentifiers(table: string, col?: string): void {
  if (!ALLOWED_MIGRATION_TABLES.has(table)) {
    throw new Error(`Migration error: unexpected table name "${table}"`);
  }
  if (col !== undefined && !SAFE_COLUMN_NAME_RE.test(col)) {
    throw new Error(`Migration error: invalid column name "${col}"`);
  }
}

async function colExists(db: CompassDb, table: string, col: string): Promise<boolean> {
  assertSafeMigrationIdentifiers(table, col);
  const cols = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
  return cols.some((c: { name: string }) => c.name === col);
}

async function runMigrations(db: CompassDb): Promise<void> {
  const [vRow] = await db.select<{ user_version: number }[]>("PRAGMA user_version");
  const version = vRow?.user_version ?? 0;

  // ── v1: Full initial schema (safe on existing DBs via IF NOT EXISTS) ────
  if (version < 1) {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS accounts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL,
        account_type TEXT    NOT NULL DEFAULT 'checking',
        institution  TEXT    NOT NULL DEFAULT '',
        created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS categories (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        name      TEXT    NOT NULL,
        parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        color     TEXT    NOT NULL DEFAULT '#6b7280',
        icon      TEXT    NOT NULL DEFAULT 'circle',
        is_system INTEGER NOT NULL DEFAULT 0
      )
    `);

    await db.execute(`
      INSERT OR IGNORE INTO categories (id, name, parent_id, color, icon, is_system) VALUES
        (1,  'Income',          NULL, '#22c55e', 'trending-up',   1),
        (2,  'Housing',         NULL, '#3b82f6', 'home',          1),
        (3,  'Food & Dining',   NULL, '#f97316', 'utensils',      1),
        (4,  'Transportation',  NULL, '#8b5cf6', 'car',           1),
        (5,  'Healthcare',      NULL, '#ec4899', 'heart',         1),
        (6,  'Entertainment',   NULL, '#eab308', 'film',          1),
        (7,  'Shopping',        NULL, '#06b6d4', 'shopping-bag',  1),
        (8,  'Personal Care',   NULL, '#a78bfa', 'user',          1),
        (9,  'Education',       NULL, '#14b8a6', 'book',          1),
        (10, 'Savings',         NULL, '#10b981', 'piggy-bank',    1),
        (11, 'Utilities',       2,    '#60a5fa', 'zap',           1),
        (12, 'Rent / Mortgage', 2,    '#3b82f6', 'building',      1),
        (13, 'Groceries',       3,    '#fb923c', 'shopping-cart', 1),
        (14, 'Restaurants',     3,    '#f97316', 'coffee',        1),
        (15, 'Uncategorized',   NULL, '#9ca3af', 'circle',        1)
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS categorization_rules (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern     TEXT    NOT NULL,
        match_type  TEXT    NOT NULL DEFAULT 'contains',
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        priority    INTEGER NOT NULL DEFAULT 0
      )
    `);

    await db.execute(`
      INSERT OR IGNORE INTO categorization_rules
        (id, pattern, match_type, category_id, priority) VALUES
        (1,  'DIRECT DEPOSIT',   'contains', 1,  100),
        (2,  'PAYCHECK',         'contains', 1,  100),
        (3,  'PAYROLL',          'contains', 1,  100),
        (4,  'RENT PAYMENT',     'contains', 12, 90),
        (5,  'MORTGAGE',         'contains', 12, 90),
        (6,  'ELECTRIC COMPANY', 'contains', 11, 80),
        (7,  'COMCAST',          'contains', 11, 80),
        (8,  'SPECTRUM',         'contains', 11, 80),
        (9,  'VERIZON WIRELESS', 'contains', 11, 80),
        (10, 'AT&T',             'contains', 11, 80),
        (11, 'WHOLE FOODS',      'contains', 13, 70),
        (12, 'KROGER',           'contains', 13, 70),
        (13, 'TRADER JOE',       'contains', 13, 70),
        (14, 'ALDI',             'contains', 13, 70),
        (15, 'PUBLIX',           'contains', 13, 70),
        (16, 'SAFEWAY',          'contains', 13, 70),
        (17, 'WEGMANS',          'contains', 13, 70),
        (18, 'UBER EATS',        'contains', 14, 65),
        (19, 'DOORDASH',         'contains', 14, 65),
        (20, 'GRUBHUB',          'contains', 14, 65),
        (21, 'STARBUCKS',        'contains', 14, 60),
        (22, 'CHIPOTLE',         'contains', 14, 60),
        (23, 'MCDONALD',         'contains', 14, 60),
        (24, 'PANERA',           'contains', 14, 60),
        (25, 'CHICK-FIL-A',      'contains', 14, 60),
        (26, 'SUBWAY',           'contains', 14, 60),
        (27, 'DUNKIN',           'contains', 14, 60),
        (28, 'UBER TRIP',        'contains', 4,  55),
        (29, 'LYFT',             'contains', 4,  55),
        (30, 'SHELL OIL',        'contains', 4,  55)
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS transactions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        date         TEXT    NOT NULL,
        amount_cents INTEGER NOT NULL,
        description  TEXT    NOT NULL DEFAULT '',
        category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        notes        TEXT,
        import_hash  TEXT    NOT NULL UNIQUE,
        created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)"
    );

    await db.execute(`
      CREATE TABLE IF NOT EXISTS column_profiles (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        header_sig TEXT    NOT NULL UNIQUE,
        date_col   INTEGER NOT NULL,
        desc_col   INTEGER NOT NULL,
        amount_col INTEGER NOT NULL,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS budgets (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        amount_cents INTEGER NOT NULL,
        period       TEXT    NOT NULL DEFAULT 'monthly',
        start_date   TEXT    NOT NULL DEFAULT (date('now', 'start of month')),
        created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS goals (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL,
        type         TEXT    NOT NULL,
        category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        target_cents INTEGER NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await db.execute("PRAGMA user_version = 1");
  }

  // ── v2: Multi-profile support ────────────────────────────────────────────
  if (version < 2) {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS profiles (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        avatar_color TEXT   NOT NULL DEFAULT '#6366f1',
        pin_hash    TEXT,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Seed default profile (id=1) if none exist
    const [cnt] = await db.select<{ n: number }[]>("SELECT COUNT(*) as n FROM profiles");
    if ((cnt?.n ?? 0) === 0) {
      await db.execute(
        "INSERT INTO profiles (id, name, avatar_color) VALUES (1, 'Default', '#6366f1')"
      );
    }

    // 2. Add profile_id columns to existing tables (safe, idempotent)
    const alterations: [string, string, string][] = [
      ["accounts",            "profile_id", "INTEGER DEFAULT 1"],
      ["transactions",        "profile_id", "INTEGER DEFAULT 1"],
      ["budgets",             "profile_id", "INTEGER DEFAULT 1"],
      ["goals",               "profile_id", "INTEGER DEFAULT 1"],
      ["categories",          "profile_id", "INTEGER"],          // NULL = system/shared
      ["categorization_rules","profile_id", "INTEGER"],          // NULL = system/shared
      ["column_profiles",     "profile_id", "INTEGER DEFAULT 1"],
    ];

    for (const [table, col, def] of alterations) {
      assertSafeMigrationIdentifiers(table, col);
      if (!(await colExists(db, table, col))) {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      }
    }

    await db.execute("PRAGMA user_version = 2");
  }

  // ── v3: Transaction type column support ──────────────────────────────────
  if (version < 3) {
    assertSafeMigrationIdentifiers("column_profiles", "type_col");
    if (!(await colExists(db, "column_profiles", "type_col"))) {
      await db.execute(
        "ALTER TABLE column_profiles ADD COLUMN type_col INTEGER NOT NULL DEFAULT -1"
      );
    }
    await db.execute("PRAGMA user_version = 3");
  }
}

// ─── Account helpers ──────────────────────────────────────────────────────────

/** Returns the account ID for a profile, creating one if it doesn't exist. */
export async function getOrCreateAccountForProfile(profileId: number): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>(
    "SELECT id FROM accounts WHERE profile_id=? LIMIT 1",
    [profileId]
  );
  if (rows.length > 0) return rows[0].id;
  const result = await db.execute(
    "INSERT INTO accounts (name, account_type, institution, profile_id) VALUES (?, ?, ?, ?)",
    ["My Account", "checking", "Imported", profileId]
  );
  return result.lastInsertId as number;
}

/** @deprecated use getOrCreateAccountForProfile */
export async function getOrCreateDefaultAccount(): Promise<number> {
  return getOrCreateAccountForProfile(1);
}

// ─── Categorization ───────────────────────────────────────────────────────────

export function applyCategorizationRules(
  description: string,
  rules: CategorizationRule[]
): number {
  const upper = description.toUpperCase();
  for (const rule of rules) {
    const pattern = rule.pattern.toUpperCase();
    if (rule.match_type === "contains" && upper.includes(pattern)) {
      return rule.category_id;
    }
    if (rule.match_type === "starts_with" && upper.startsWith(pattern)) {
      return rule.category_id;
    }
  }
  return 15; // Uncategorized
}
