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
  "import_sessions",
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

  // ── v4: Running balance support ──────────────────────────────────────────
  if (version < 4) {
    assertSafeMigrationIdentifiers("transactions", "balance_cents");
    if (!(await colExists(db, "transactions", "balance_cents"))) {
      await db.execute("ALTER TABLE transactions ADD COLUMN balance_cents INTEGER");
    }
    assertSafeMigrationIdentifiers("column_profiles", "balance_col");
    if (!(await colExists(db, "column_profiles", "balance_col"))) {
      await db.execute(
        "ALTER TABLE column_profiles ADD COLUMN balance_col INTEGER NOT NULL DEFAULT -1"
      );
    }
    await db.execute("PRAGMA user_version = 4");
  }

  // ── v5: Expanded categories + comprehensive categorization rules ──────────
  if (version < 5) {
    // New system categories
    await db.execute(`
      INSERT OR IGNORE INTO categories (id, name, parent_id, color, icon, is_system) VALUES
        (16, 'Gas & Fuel',        4,    '#818cf8', 'fuel',             1),
        (17, 'Subscriptions',     6,    '#a78bfa', 'repeat',           1),
        (18, 'Insurance',         NULL, '#0ea5e9', 'shield',           1),
        (19, 'Bank Fees',         NULL, '#f43f5e', 'landmark',         1),
        (20, 'Transfers',         NULL, '#71717a', 'arrow-right-left', 1),
        (21, 'Gifts & Donations', NULL, '#f472b6', 'gift',             1)
    `);

    // Insert new rules in batch — unique index on (pattern, category_id) prevents dupes.
    // Priority guide: Transfers 200 · Income 100 · Subscriptions-specific 95 ·
    //   Housing 90 · Insurance 85 · Utilities 80 · Groceries 70 · Delivery 65 ·
    //   Restaurants 60 · Gas 58 · Transport 55 · Healthcare 53 · Shopping 50 ·
    //   Personal Care 45 · Subscriptions-generic 40 · Bank Fees 35

    const newRules: [string, string, number, number][] = [
      // ── Transfers (highest priority so internal moves never inflate expenses) ──
      ["ONLINE BANKING TRANSFER",        "contains",    20, 200],
      ["OVERDRAFT PROTECTION FROM",      "contains",    20, 200],
      ["KEEP THE CHANGE",                "contains",    10, 195], // round-up → Savings
      ["KEEPTHECHANGE",                   "contains",    10, 195], // BoA no-space variant
      ["ZELLE",                          "contains",    20, 190],
      ["VENMO",                          "contains",    20, 190],
      ["CASH APP",                       "contains",    20, 190],
      ["ACH TRANSFER",                   "contains",    20, 190],
      ["AMERICAN EXPRESS.*ACH PMT",      "regex",       20, 185], // AmEx bill pay
      ["CREDIT CARD PAYMENT",            "contains",    20, 185],
      // ── Income ────────────────────────────────────────────────────────────
      ["AVEANNA",                        "contains",    1,  100],
      ["SALARY",                         "contains",    1,  100],
      ["WAGES",                          "contains",    1,  100],
      // ── Subscriptions — specific patterns before generic merchant names ──
      ["INSTACART.*SUBSCRIP",            "regex",       17, 95],
      ["INSTACART.*ANNUAL",              "regex",       17, 95],
      ["DOORDASHDASHPASS",               "contains",    17, 95],
      ["APPLE.COM/BILL",                 "contains",    17, 95],
      ["PP\\*APPLE",                     "regex",       17, 95],
      ["AMAZON PRIME",                   "contains",    17, 92],
      ["NETFLIX",                        "contains",    17, 40],
      ["SPOTIFY",                        "contains",    17, 40],
      ["HULU",                           "contains",    17, 40],
      ["DISNEY",                         "contains",    17, 40],
      ["HBO",                            "contains",    17, 40],
      ["PEACOCK",                        "contains",    17, 40],
      ["PARAMOUNT",                      "contains",    17, 40],
      ["APPLE TV",                       "contains",    17, 40],
      ["DISCOVERY PLUS",                 "contains",    17, 40],
      ["PATREON",                        "contains",    17, 40],
      ["GITHUB",                         "contains",    17, 40],
      ["ADOBE",                          "contains",    17, 40],
      ["MICROSOFT 365",                  "contains",    17, 40],
      ["DROPBOX",                        "contains",    17, 40],
      ["GOOGLE ONE",                     "contains",    17, 40],
      ["GOOGLE STORAGE",                 "contains",    17, 40],
      ["SIRIUS",                         "contains",    17, 40],
      ["PANDORA",                        "contains",    17, 40],
      ["YOUTUBE PREMIUM",                "contains",    17, 40],
      // ── Insurance ─────────────────────────────────────────────────────────
      ["PROG PREMIER",                   "contains",    18, 85],
      ["INS PREM",                       "contains",    18, 85],
      ["GEICO",                          "contains",    18, 85],
      ["STATE FARM",                     "contains",    18, 85],
      ["ALLSTATE",                       "contains",    18, 85],
      ["PROGRESSIVE INS",                "contains",    18, 85],
      ["USAA",                           "contains",    18, 85],
      ["NATIONWIDE",                     "contains",    18, 85],
      ["FARMERS INS",                    "contains",    18, 85],
      ["LIBERTY MUTUAL",                 "contains",    18, 85],
      ["HUMANA",                         "contains",    18, 85],
      ["AETNA",                          "contains",    18, 85],
      ["CIGNA",                          "contains",    18, 85],
      ["ANTHEM",                         "contains",    18, 85],
      // ── Groceries ─────────────────────────────────────────────────────────
      ["INSTACART",                      "contains",    13, 70],
      ["HEB",                            "contains",    13, 70],
      ["FOOD LION",                      "contains",    13, 70],
      ["HARRIS TEETER",                  "contains",    13, 70],
      ["MEIJER",                         "contains",    13, 70],
      ["SPROUTS",                        "contains",    13, 70],
      ["WINN DIXIE",                     "contains",    13, 70],
      ["GIANT FOOD",                     "contains",    13, 70],
      ["STOP & SHOP",                    "contains",    13, 70],
      ["MARKET BASKET",                  "contains",    13, 70],
      ["FOOD 4 LESS",                    "contains",    13, 70],
      ["FRESH MARKET",                   "contains",    13, 70],
      // ── Restaurants ───────────────────────────────────────────────────────
      ["WAFFLE HOUSE",                   "contains",    14, 60],
      ["WING STOP",                      "contains",    14, 60],
      ["WINGSTOP",                       "contains",    14, 60],
      ["FOODA",                          "contains",    14, 60],
      ["LABOTTEGA",                      "contains",    14, 60],
      ["TACO BELL",                      "contains",    14, 60],
      ["SONIC",                          "contains",    14, 60],
      ["CULVER",                         "contains",    14, 60],
      ["FIVE GUYS",                      "contains",    14, 60],
      ["SHAKE SHACK",                    "contains",    14, 60],
      ["PANDA EXPRESS",                  "contains",    14, 60],
      ["PIZZA HUT",                      "contains",    14, 60],
      ["DOMINO",                         "contains",    14, 60],
      ["BURGER KING",                    "contains",    14, 60],
      ["WENDYS",                         "contains",    14, 60],
      ["DAIRY QUEEN",                    "contains",    14, 60],
      ["JIMMY JOHN",                     "contains",    14, 60],
      ["JERSEY MIKE",                    "contains",    14, 60],
      ["RAISING CANE",                   "contains",    14, 60],
      ["OLIVE GARDEN",                   "contains",    14, 60],
      ["APPLEBEES",                      "contains",    14, 60],
      ["CHILIS",                         "contains",    14, 60],
      ["TEXAS ROADHOUSE",                "contains",    14, 60],
      ["OUTBACK",                        "contains",    14, 60],
      ["CRACKER BARREL",                 "contains",    14, 60],
      ["DENNYS",                         "contains",    14, 60],
      ["DENNY'S",                        "contains",    14, 60],
      ["HOOTERS",                        "contains",    14, 60],
      ["BUFFALO WILD",                   "contains",    14, 60],
      ["MAZZYS",                         "contains",    14, 60],
      ["TIN CUP",                        "contains",    14, 60],
      ["SPORTS BAR",                     "contains",    14, 58],
      ["TST*",                           "starts_with", 14, 55], // Toast POS (restaurants)
      // ── Gas & Fuel ────────────────────────────────────────────────────────
      ["RACETRAC",                       "contains",    16, 58],
      ["QT ",                            "contains",    16, 58], // QuikTrip (space after to avoid false matches)
      ["BP ",                            "contains",    16, 58],
      ["CHEVRON",                        "contains",    16, 58],
      ["EXXON",                          "contains",    16, 58],
      ["SUNOCO",                         "contains",    16, 58],
      ["MOBIL",                          "contains",    16, 58],
      ["VALERO",                         "contains",    16, 58],
      ["SPEEDWAY",                       "contains",    16, 58],
      ["CIRCLE K",                       "contains",    16, 58],
      ["WAWA",                           "contains",    16, 58],
      ["MARATHON",                       "contains",    16, 58],
      ["CASEYS",                         "contains",    16, 58],
      ["SHEETZ",                         "contains",    16, 58],
      ["KWIK TRIP",                      "contains",    16, 58],
      ["GAS STATION",                    "contains",    16, 55],
      ["FUEL",                           "contains",    16, 50],
      // ── Healthcare ────────────────────────────────────────────────────────
      ["CVS",                            "contains",    5,  53],
      ["WALGREENS",                      "contains",    5,  53],
      ["RITE AID",                       "contains",    5,  53],
      ["DUANE READE",                    "contains",    5,  53],
      ["PHARMACY",                       "contains",    5,  52],
      ["URGENT CARE",                    "contains",    5,  52],
      ["MEDICAL",                        "contains",    5,  50],
      ["DENTAL",                         "contains",    5,  50],
      ["OPTOMETRY",                      "contains",    5,  50],
      ["LAB CORP",                       "contains",    5,  50],
      ["LABCORP",                        "contains",    5,  50],
      ["QUEST DIAGN",                    "contains",    5,  50],
      // ── Shopping ──────────────────────────────────────────────────────────
      ["AMAZON",                         "contains",    7,  50],
      ["AMZN",                           "contains",    7,  50],
      ["WALMART",                        "contains",    7,  50],
      ["TARGET",                         "contains",    7,  50],
      ["COSTCO",                         "contains",    7,  50],
      ["SAMS CLUB",                      "contains",    7,  50],
      ["BEST BUY",                       "contains",    7,  50],
      ["HOME DEPOT",                     "contains",    7,  50],
      ["LOWES",                          "contains",    7,  50],
      ["ROSS",                           "contains",    7,  50],
      ["TJ MAXX",                        "contains",    7,  50],
      ["MARSHALLS",                      "contains",    7,  50],
      ["DOLLAR GENERAL",                 "contains",    7,  50],
      ["DOLLAR TREE",                    "contains",    7,  50],
      ["FIVE BELOW",                     "contains",    7,  50],
      ["ETSY",                           "contains",    7,  50],
      ["EBAY",                           "contains",    7,  50],
      ["CHEWY",                          "contains",    7,  50],
      // ── Personal Care ─────────────────────────────────────────────────────
      ["STEEL SUPPLEMENT",               "contains",    8,  45],
      ["SUPPLEMENT",                     "contains",    8,  43],
      ["SUPERCUTS",                      "contains",    8,  45],
      ["GREAT CLIPS",                    "contains",    8,  45],
      ["FANTASTIC SAM",                  "contains",    8,  45],
      ["ULTA",                           "contains",    8,  45],
      ["SEPHORA",                        "contains",    8,  45],
      ["SPORT CLIPS",                    "contains",    8,  45],
      // ── Bank Fees ─────────────────────────────────────────────────────────
      ["OVERDRAFT FEE",                  "contains",    19, 35],
      ["NSF FEE",                        "contains",    19, 35],
      ["SERVICE CHARGE",                 "contains",    19, 35],
      ["MONTHLY FEE",                    "contains",    19, 35],
      ["LATE FEE",                       "contains",    19, 35],
      ["ANNUAL FEE",                     "contains",    19, 35],
      ["FOREIGN TRANSACTION",            "contains",    19, 35],
    ];

    for (const [pattern, matchType, categoryId, priority] of newRules) {
      await db.execute(
        `INSERT OR IGNORE INTO categorization_rules (pattern, match_type, category_id, priority) VALUES (?,?,?,?)`,
        [pattern, matchType, categoryId, priority]
      );
    }

    await db.execute("PRAGMA user_version = 5");
  }

  // ── v6: Import session history ──────────────────────────────────────
  if (version < 6) {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS import_sessions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        filename      TEXT    NOT NULL,
        imported_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        row_count     INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        profile_id    INTEGER NOT NULL
      )
    `);

    assertSafeMigrationIdentifiers("transactions", "import_session_id");
    if (!(await colExists(db, "transactions", "import_session_id"))) {
      await db.execute(
        "ALTER TABLE transactions ADD COLUMN import_session_id INTEGER REFERENCES import_sessions(id) ON DELETE SET NULL"
      );
    }

    await db.execute("PRAGMA user_version = 6");
  }

  // ── v7: New categories (Debt, Business Expenses, Gambling, Crypto, Investments, Emergency)
  //       + amount-condition columns on rules + Transfer rule cleanup ──────────────────────
  if (version < 7) {
    // Add optional amount-range columns to categorization_rules
    assertSafeMigrationIdentifiers("categorization_rules", "min_abs_cents");
    if (!(await colExists(db, "categorization_rules", "min_abs_cents"))) {
      await db.execute(
        "ALTER TABLE categorization_rules ADD COLUMN min_abs_cents INTEGER"
      );
    }
    assertSafeMigrationIdentifiers("categorization_rules", "max_abs_cents");
    if (!(await colExists(db, "categorization_rules", "max_abs_cents"))) {
      await db.execute(
        "ALTER TABLE categorization_rules ADD COLUMN max_abs_cents INTEGER"
      );
    }

    // Insert new system categories first — they must exist before the merge
    // so FK references in the UPDATE statements below are valid.
    await db.execute(`
      INSERT OR IGNORE INTO categories (id, name, parent_id, color, icon, is_system) VALUES
        (22, 'Debt',              NULL, '#ef4444', 'credit-card',    1),
        (23, 'Business Expenses', NULL, '#0d9488', 'briefcase',      1),
        (24, 'Gambling',          NULL, '#dc2626', 'dice-5',         1),
        (25, 'Crypto',            NULL, '#f59e0b', 'bitcoin',        1),
        (26, 'Investments',       NULL, '#10b981', 'trending-up',    1),
        (27, 'Emergency',         NULL, '#f97316', 'alert-triangle', 1)
    `);

    // Generic user-category merge: for every newly introduced system category, find
    // any user-created category whose name matches case-insensitively, re-point all
    // FK references to the canonical system ID, then delete the duplicate.
    // ─────────────────────────────────────────────────────────────────────────────
    // EDGE CASE: if the user's category coincidentally has the same database ID as
    // the new system category (e.g. it was the 22nd category ever created), we must
    // NOT delete it — we upgrade it in-place instead. Deleting then re-inserting
    // would leave dangling FK references in any database with FK enforcement on.
    // ─────────────────────────────────────────────────────────────────────────────
    // MAINTAINER NOTE: repeat this pattern in every future release that adds new
    // system categories — just extend the array below.
    const mergeTargets: { newId: number; upperName: string; color: string; icon: string }[] = [
      { newId: 22, upperName: "DEBT",              color: "#ef4444", icon: "credit-card"    },
      { newId: 23, upperName: "BUSINESS EXPENSES", color: "#0d9488", icon: "briefcase"       },
      { newId: 24, upperName: "GAMBLING",          color: "#dc2626", icon: "dice-5"          },
      { newId: 25, upperName: "CRYPTO",            color: "#f59e0b", icon: "bitcoin"         },
      { newId: 26, upperName: "INVESTMENTS",       color: "#10b981", icon: "trending-up"     },
      { newId: 27, upperName: "EMERGENCY",         color: "#f97316", icon: "alert-triangle"  },
    ];
    for (const { newId, upperName, color, icon } of mergeTargets) {
      const duplicates = await db.select<{ id: number }[]>(
        "SELECT id FROM categories WHERE UPPER(name)=? AND is_system=0",
        [upperName]
      );
      for (const dup of duplicates) {
        if (dup.id === newId) {
          // Same ID: the user category IS the slot we want. Upgrade it to a system
          // category in-place — no reference migration needed, no delete needed.
          await db.execute(
            "UPDATE categories SET is_system=1, color=?, icon=? WHERE id=?",
            [color, icon, dup.id]
          );
        } else {
          // Different ID: remap every reference from the old user ID to the new
          // system ID, then delete the now-orphaned user category row.
          await db.execute(
            "UPDATE transactions SET category_id=? WHERE category_id=?",
            [newId, dup.id]
          );
          await db.execute(
            "UPDATE categorization_rules SET category_id=? WHERE category_id=?",
            [newId, dup.id]
          );
          await db.execute(
            "UPDATE budgets SET category_id=? WHERE category_id=?",
            [newId, dup.id]
          );
          await db.execute(
            "UPDATE goals SET category_id=? WHERE category_id=?",
            [newId, dup.id]
          );
          await db.execute("DELETE FROM categories WHERE id=?", [dup.id]);
        }
      }
    }

    // Remove Zelle / Venmo / Cash App from Transfer auto-rules.
    // Transfer (id 20) is reserved for same-institution internal moves only
    // (e.g. "ONLINE BANKING TRANSFER", "ACH TRANSFER"). External payment-service
    // transactions are left Uncategorized so users can create purpose-specific rules.
    await db.execute(
      "DELETE FROM categorization_rules WHERE pattern IN ('ZELLE','VENMO','CASH APP') AND profile_id IS NULL"
    );

    // New system rules for the new categories
    const v7Rules: [string, string, number, number][] = [
      // ── Debt ────────────────────────────────────────────────────────────────
      ["STUDENT LOAN",   "contains", 22, 88],
      ["NAVIENT",        "contains", 22, 88],
      ["NELNET",         "contains", 22, 88],
      ["MOHELA",         "contains", 22, 88],
      ["SALLIE MAE",     "contains", 22, 88],
      ["AUTO LOAN",      "contains", 22, 88],
      ["LOAN PAYMENT",   "contains", 22, 88],
      // ── Gambling ─────────────────────────────────────────────────────────────
      ["DRAFTKINGS",     "contains", 24, 85],
      ["FANDUEL",        "contains", 24, 85],
      ["BETMGM",         "contains", 24, 85],
      ["CAESARS",        "contains", 24, 85],
      ["POINTSBET",      "contains", 24, 85],
      ["HARD ROCK BET",  "contains", 24, 85],
      ["BETRIVERS",      "contains", 24, 85],
      // ── Crypto ───────────────────────────────────────────────────────────────
      ["COINBASE",       "contains", 25, 85],
      ["BINANCE",        "contains", 25, 85],
      ["KRAKEN",         "contains", 25, 85],
      ["GEMINI",         "contains", 25, 85],
      ["CRYPTO.COM",     "contains", 25, 85],
      ["BITCOIN",        "contains", 25, 85],
      ["ETHEREUM",       "contains", 25, 85],
      // ── Investments ──────────────────────────────────────────────────────────
      ["FIDELITY",       "contains", 26, 80],
      ["VANGUARD",       "contains", 26, 80],
      ["SCHWAB",         "contains", 26, 80],
      ["TD AMERITRADE",  "contains", 26, 80],
      ["ETRADE",         "contains", 26, 80],
      ["MERRILL LYNCH",  "contains", 26, 80],
      ["MORGAN STANLEY", "contains", 26, 80],
      ["ROBINHOOD",      "contains", 26, 80],
      ["SOFI INVEST",    "contains", 26, 80],
    ];
    for (const [pattern, matchType, categoryId, priority] of v7Rules) {
      await db.execute(
        "INSERT OR IGNORE INTO categorization_rules (pattern, match_type, category_id, priority) VALUES (?,?,?,?)",
        [pattern, matchType, categoryId, priority]
      );
    }

    await db.execute("PRAGMA user_version = 7");
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

/**
 * Strip common bank-format noise so patterns match more reliably.
 *
 * Examples:
 *   "DD *DOORDASH CHIPOTLEM 05/27 PURCHASE 855-973-1040 CA"
 *    → "DOORDASH CHIPOTLEM"
 *   "IC* INSTACART*161 06/15 PURCHASE INSTACART.COM CA"
 *    → "INSTACART"
 *   "PP*APPLE.COM/BILL 06/13 PURCHASE 402-935-7733 CA"
 *    → "APPLE.COM/BILL"
 *   "AMAZON MKTPL*1A52U9IQ3 05/22 PURCHASE Amzn.com/bill WA"
 *    → "AMAZON MKTPL"
 */
function normalizeDescription(desc: string): string {
  let s = desc.toUpperCase().trim();
  // Strip leading 2-4 char processor codes followed by * or space+*
  s = s.replace(/^[A-Z]{2,4}[\s*]+/, "");
  // Strip trailing purchase-date / phone / state noise: "05/21 PURCHASE …"
  s = s.replace(/\s+\d{2}\/\d{2}\s+.*$/, "");
  // Strip mid-string or trailing *ALPHANUM codes (order-ref noise)
  s = s.replace(/\*[A-Z0-9]{4,}/g, "");
  return s.trim();
}

export function applyCategorizationRules(
  description: string,
  rules: CategorizationRule[],
  amountCents?: number
): number {
  const upper = description.toUpperCase();
  const normalized = normalizeDescription(description);

  for (const rule of rules) {
    const pattern = rule.pattern.toUpperCase();
    let patternMatched = false;
    // Test against both raw and normalized string so existing rules keep working
    for (const text of [upper, normalized]) {
      if (rule.match_type === "contains" && text.includes(pattern)) {
        patternMatched = true;
        break;
      }
      if (rule.match_type === "starts_with" && text.startsWith(pattern)) {
        patternMatched = true;
        break;
      }
      if (rule.match_type === "regex") {
        try {
          if (new RegExp(rule.pattern, "i").test(text)) {
            patternMatched = true;
            break;
          }
        } catch {
          // invalid stored regex — skip
        }
      }
    }
    if (!patternMatched) continue;

    // Check optional amount-range conditions (absolute value of transaction amount)
    if (amountCents !== undefined) {
      const absAmt = Math.abs(amountCents);
      if (rule.min_abs_cents != null && absAmt < rule.min_abs_cents) continue;
      if (rule.max_abs_cents != null && absAmt > rule.max_abs_cents) continue;
    }

    return rule.category_id;
  }
  return 15; // Uncategorized
}

/**
 * Re-run categorization rules against already-imported transactions.
 *
 * @param profileId   Profile whose transactions to process.
 * @param mode        "uncategorized" — only touch transactions currently
 *                    assigned to "Uncategorized" (id 15) or NULL.
 *                    "all" — overwrite every transaction's category.
 * @returns           Number of transactions whose category was changed.
 */
export async function reapplyCategorizationRules(
  profileId: number,
  mode: "uncategorized" | "all" = "uncategorized"
): Promise<number> {
  const db = await getDb();

  // Fetch rules ordered by priority so the loop mirrors import behaviour.
  // Also select profile_id so we can distinguish user rules from system rules.
  const rules = await db.select<(CategorizationRule & { profile_id: number | null })[]>(
    `SELECT id, pattern, match_type, category_id, priority, min_abs_cents, max_abs_cents, profile_id
     FROM categorization_rules
     WHERE profile_id=? OR profile_id IS NULL
     ORDER BY priority DESC`,
    [profileId]
  );
  console.debug(`[autoCat] ${rules.length} rules loaded`);

  // Split into user rules (created by this profile) and system rules (profile_id IS NULL).
  // User rules always override system-rule categorizations.
  // System rules only fill the gap when no user rule applies.
  const userRules   = rules.filter((r) => r.profile_id !== null);
  const systemRules = rules.filter((r) => r.profile_id === null);

  // Fetch ALL transactions for this profile so user rules can override anything.
  const transactions = await db.select<{ id: number; description: string; amount_cents: number; category_id: number | null }[]>(
    `SELECT id, description, amount_cents, category_id FROM transactions WHERE profile_id=? ORDER BY id`,
    [profileId]
  );
  console.debug(`[autoCat] ${transactions.length} transactions to evaluate (mode=${mode})`);

  // ── Group by matched category (pure JS — no IPC inside the loop) ──────────
  const byCategory = new Map<number, number[]>(); // catId → [txnId, …]
  let matched = 0;

  for (const txn of transactions) {
    const currentCat = txn.category_id;
    let newCatId: number;

    if (mode === "all") {
      // Apply every rule (user first by priority ordering) to every transaction.
      newCatId = applyCategorizationRules(txn.description, rules, txn.amount_cents);
    } else {
      // mode = "uncategorized" with smart user-rule override:
      //   • User rules → applied to ALL transactions (override prior system categorizations)
      //   • System rules → only fill truly uncategorized (NULL / id 15) transactions
      const userMatch = applyCategorizationRules(txn.description, userRules, txn.amount_cents);
      if (userMatch !== 15) {
        newCatId = userMatch;
      } else if (currentCat === null || currentCat === 15) {
        newCatId = applyCategorizationRules(txn.description, systemRules, txn.amount_cents);
      } else {
        continue; // no user rule matched + already categorized → leave it alone
      }
    }

    if (newCatId === 15) continue;         // no rule produced a real category
    if (newCatId === currentCat) continue; // already correct
    const bucket = byCategory.get(newCatId) ?? [];
    bucket.push(txn.id);
    byCategory.set(newCatId, bucket);
    matched++;
  }

  if (matched === 0) {
    console.debug("[autoCat] No matches — nothing to update");
    return 0;
  }
  console.debug(`[autoCat] ${matched} matched across ${byCategory.size} categories, running updates…`);

  // ── One UPDATE per distinct category, chunked to stay under SQLite's
  //    variable limit. Each chunk: 1 catId param + up to 500 id params.
  const CHUNK = 500;
  for (const [catId, ids] of byCategory.entries()) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      await db.execute(
        `UPDATE transactions SET category_id=? WHERE id IN (${placeholders})`,
        [catId, ...chunk]
      );
    }
  }

  return matched;
}
