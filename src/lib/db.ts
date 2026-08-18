import { invoke } from "@tauri-apps/api/core";
import type { CategorizationRule, Account, RecurringRule, RecurringCadence } from "./types";

// ─── Invoke-based DB wrapper ──────────────────────────────────────────────────
// Mirrors the tauri-plugin-sql Database API (select / execute) so all call
// sites are unchanged.  Actual SQL runs through the encrypted rusqlite layer
// registered in src-tauri/src/lib.rs.

interface ExecResult {
  lastInsertId: number;
  rowsAffected: number;
}

export interface BatchStatement {
  sql: string;
  params?: unknown[];
}

export interface ImportBatchResult {
  duplicateIndices: number[];
  errors: { index: number; message: string }[];
}

class CompassDb {
  select<T>(sql: string, params: unknown[] = []): Promise<T> {
    return invoke<T>("db_select", { sql, params });
  }
  execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
    return invoke<ExecResult>("db_execute", { sql, params });
  }
  /** Runs every statement inside one real SQL transaction - all-or-nothing, used for schema
   *  migrations that rebuild a table (rename/create/copy/drop) so a crash mid-sequence can
   *  never leave the database in a half-migrated state. */
  executeBatch(statements: BatchStatement[]): Promise<void> {
    return invoke<void>("db_execute_batch", { statements });
  }
  /** Inserts transaction rows inside one transaction, classifying each row as inserted /
   *  duplicate (unique-constraint violation) / error instead of aborting the whole import or
   *  mislabeling every failure as "duplicate". */
  importTransactionsBatch(statements: BatchStatement[]): Promise<ImportBatchResult> {
    return invoke<ImportBatchResult>("import_transactions_batch", { statements });
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
  "holdings",
  "investment_activity",
  "investment_summaries",
  "recurring_rules",
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

  // ── v8: Global budgets — is_global flag on budgets table ─────────────────
  if (version < 8) {
    assertSafeMigrationIdentifiers("budgets", "is_global");
    if (!(await colExists(db, "budgets", "is_global"))) {
      await db.execute(
        "ALTER TABLE budgets ADD COLUMN is_global INTEGER NOT NULL DEFAULT 0"
      );
    }
    await db.execute("PRAGMA user_version = 8");
  }

  // ── v9: Expanded goal types + target_months column ────────────────────────
  // SQLite cannot ALTER TABLE to modify a CHECK constraint, so we recreate the
  // goals table with the expanded type set and a new target_months column.
  if (version < 9) {
    const hasTM = await colExists(db, "goals", "target_months");
    if (!hasTM) {
      // Rename → recreate with expanded constraint → copy → drop old, all in one transaction so
      // a crash mid-sequence can't leave goals renamed away with no replacement.
      await db.executeBatch([
        { sql: "ALTER TABLE goals RENAME TO goals_v8" },
        { sql: `
          CREATE TABLE goals (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT    NOT NULL,
            type          TEXT    NOT NULL,
            category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
            target_cents  INTEGER NOT NULL DEFAULT 0,
            target_months INTEGER,
            active        INTEGER NOT NULL DEFAULT 1,
            created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
            profile_id    INTEGER DEFAULT 1
          )
        ` },
        { sql: `
          INSERT INTO goals (id, name, type, category_id, target_cents, target_months, active, created_at, profile_id)
          SELECT id, name, type, category_id, target_cents, NULL, active, created_at, profile_id
          FROM goals_v8
        ` },
        { sql: "DROP TABLE goals_v8" },
        { sql: "PRAGMA user_version = 9" },
      ]);
    } else {
      await db.execute("PRAGMA user_version = 9");
    }
  }

  // ── v10: Investment portfolio imports — holdings snapshots + session kind ──
  if (version < 10) {
    assertSafeMigrationIdentifiers("import_sessions", "kind");
    if (!(await colExists(db, "import_sessions", "kind"))) {
      await db.execute(
        "ALTER TABLE import_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'bank'"
      );
    }

    await db.execute(`
      CREATE TABLE IF NOT EXISTS holdings (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id              INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        profile_id              INTEGER NOT NULL,
        import_session_id       INTEGER REFERENCES import_sessions(id) ON DELETE CASCADE,
        as_of_date              TEXT    NOT NULL,
        security_type           TEXT    NOT NULL, -- stock | etf | mutual_fund | cash | other
        symbol                  TEXT,
        description             TEXT    NOT NULL DEFAULT '',
        shares                  REAL,
        price_cents             INTEGER,
        market_value_cents      INTEGER,
        cost_basis_cents        INTEGER,
        trade_date              TEXT,
        dividend_per_share_cents INTEGER,
        est_annual_income_cents INTEGER,
        created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await db.execute(
      "CREATE INDEX IF NOT EXISTS idx_holdings_account_date ON holdings(account_id, as_of_date)"
    );

    await db.execute("PRAGMA user_version = 10");
  }

  // ── v11: Credit card "payment" transactions → Transfers, so paying off a
  //         card balance never inflates income totals ─────────────────────
  if (version < 11) {
    const v11Rules: [string, string, number, number][] = [
      ["PAYMENT - THANK YOU", "contains", 20, 200],
      ["PAYMENT THANK YOU",   "contains", 20, 200],
    ];
    for (const [pattern, matchType, categoryId, priority] of v11Rules) {
      await db.execute(
        "INSERT OR IGNORE INTO categorization_rules (pattern, match_type, category_id, priority) VALUES (?,?,?,?)",
        [pattern, matchType, categoryId, priority]
      );
    }
    await db.execute("PRAGMA user_version = 11");
  }

  // ── v12: Manually-anchored running balance for accounts whose imports have
  //         no native balance column ────────────────────────────────────────
  if (version < 12) {
    assertSafeMigrationIdentifiers("accounts", "starting_balance_cents");
    if (!(await colExists(db, "accounts", "starting_balance_cents"))) {
      await db.execute("ALTER TABLE accounts ADD COLUMN starting_balance_cents INTEGER");
    }
    await db.execute("PRAGMA user_version = 12");
  }

  // ── v13: Balance anchor represents the balance AFTER transactions as of a
  //         given date (typically today, when the value is entered), not
  //         before them - lets Compass calculate correctly in both directions
  if (version < 13) {
    assertSafeMigrationIdentifiers("accounts", "balance_anchor_cents");
    if (!(await colExists(db, "accounts", "balance_anchor_cents"))) {
      await db.execute("ALTER TABLE accounts ADD COLUMN balance_anchor_cents INTEGER");
    }
    assertSafeMigrationIdentifiers("accounts", "balance_anchor_date");
    if (!(await colExists(db, "accounts", "balance_anchor_date"))) {
      await db.execute("ALTER TABLE accounts ADD COLUMN balance_anchor_date TEXT");
    }
    await db.execute("PRAGMA user_version = 13");
  }

  // ── v14: Retroactively fix credit card balances imported/calculated before
  //         the sign-inversion fix - a credit card balance is a liability and
  //         should never be stored (or displayed) as a positive number.
  if (version < 14) {
    await db.execute(`
      UPDATE transactions SET balance_cents = -balance_cents
      WHERE balance_cents IS NOT NULL AND balance_cents > 0
        AND account_id IN (SELECT id FROM accounts WHERE account_type='credit')
    `);
    await db.execute(`
      UPDATE accounts SET balance_anchor_cents = -balance_anchor_cents
      WHERE balance_anchor_cents IS NOT NULL AND balance_anchor_cents > 0 AND account_type='credit'
    `);
    await db.execute("PRAGMA user_version = 14");
  }

  // ── v15: v14's per-row sign flip wasn't mathematically correct for credit
  //         accounts whose balance was calculated from a (wrongly-signed)
  //         anchor - simply negating each result doesn't reproduce what a
  //         backward calculation from a negated anchor actually produces.
  //         Force the anchor negative, then properly recompute from it.
  if (version < 15) {
    await db.execute(`
      UPDATE accounts SET balance_anchor_cents = -ABS(balance_anchor_cents)
      WHERE balance_anchor_cents IS NOT NULL AND account_type='credit'
    `);
    const creditAccountsWithAnchor = await db.select<{ id: number }[]>(
      "SELECT id FROM accounts WHERE account_type='credit' AND balance_anchor_cents IS NOT NULL"
    );
    for (const { id } of creditAccountsWithAnchor) {
      await recomputeCalculatedBalancesWithDb(db, id);
    }
    await db.execute("PRAGMA user_version = 15");
  }

  // ── v16: New category (Travel) ────────────────────────────────────────────
  if (version < 16) {
    await db.execute(`
      INSERT OR IGNORE INTO categories (id, name, parent_id, color, icon, is_system) VALUES
        (28, 'Travel', NULL, '#fb7185', 'plane', 1)
    `);

    // Generic user-category merge (see MAINTAINER NOTE in the v7 migration above).
    const mergeTargets: { newId: number; upperName: string; color: string; icon: string }[] = [
      { newId: 28, upperName: "TRAVEL", color: "#fb7185", icon: "plane" },
    ];
    for (const { newId, upperName, color, icon } of mergeTargets) {
      const duplicates = await db.select<{ id: number }[]>(
        "SELECT id FROM categories WHERE UPPER(name)=? AND is_system=0",
        [upperName]
      );
      for (const dup of duplicates) {
        if (dup.id === newId) {
          await db.execute(
            "UPDATE categories SET is_system=1, color=?, icon=? WHERE id=?",
            [color, icon, dup.id]
          );
        } else {
          await db.execute("UPDATE transactions SET category_id=? WHERE category_id=?", [newId, dup.id]);
          await db.execute("UPDATE categorization_rules SET category_id=? WHERE category_id=?", [newId, dup.id]);
          await db.execute("UPDATE budgets SET category_id=? WHERE category_id=?", [newId, dup.id]);
          await db.execute("UPDATE goals SET category_id=? WHERE category_id=?", [newId, dup.id]);
          await db.execute("DELETE FROM categories WHERE id=?", [dup.id]);
        }
      }
    }

    const v16Rules: [string, string, number, number][] = [
      ["DELTA AIR",           "contains", 28, 82],
      ["SOUTHWEST AIR",       "contains", 28, 82],
      ["UNITED AIRLINES",     "contains", 28, 82],
      ["AMERICAN AIRLINES",   "contains", 28, 82],
      ["JETBLUE",             "contains", 28, 82],
      ["ALASKA AIRLINES",     "contains", 28, 82],
      ["SPIRIT AIRLINES",     "contains", 28, 82],
      ["FRONTIER AIRLINES",   "contains", 28, 82],
      ["MARRIOTT",            "contains", 28, 82],
      ["HILTON",              "contains", 28, 82],
      ["HYATT",               "contains", 28, 82],
      ["AIRBNB",              "contains", 28, 82],
      ["EXPEDIA",             "contains", 28, 82],
      ["BOOKING.COM",         "contains", 28, 82],
      ["HERTZ",               "contains", 28, 82],
      ["ENTERPRISE RENT",     "contains", 28, 82],
      ["AVIS",                "contains", 28, 82],
      ["NATIONAL CAR RENTAL", "contains", 28, 82],
    ];
    for (const [pattern, matchType, categoryId, priority] of v16Rules) {
      await db.execute(
        "INSERT OR IGNORE INTO categorization_rules (pattern, match_type, category_id, priority) VALUES (?,?,?,?)",
        [pattern, matchType, categoryId, priority]
      );
    }

    await db.execute("PRAGMA user_version = 16");
  }

  // ── v17: Per-account dashboard-visibility + insights-exclusion flags.
  //         hidden_from_dashboard also removes the account from net worth;
  //         excluded_from_insights only affects agent.ts calculations. ─────
  if (version < 17) {
    const v17Alterations: [string, string, string][] = [
      ["accounts", "hidden_from_dashboard", "INTEGER NOT NULL DEFAULT 0"],
      ["accounts", "excluded_from_insights", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [table, col, def] of v17Alterations) {
      assertSafeMigrationIdentifiers(table, col);
      if (!(await colExists(db, table, col))) {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      }
    }
    await db.execute("PRAGMA user_version = 17");
  }

  // ── v18: Loan accounts (account_type='loan') - interest rate and minimum payment are
  //         purely informational (never used in any calculation), since the loan's own
  //         statements already carry that information. ────────────────────────────────
  if (version < 18) {
    const v18Alterations: [string, string, string][] = [
      ["accounts", "interest_rate_bps", "INTEGER"],
      ["accounts", "minimum_payment_cents", "INTEGER"],
    ];
    for (const [table, col, def] of v18Alterations) {
      assertSafeMigrationIdentifiers(table, col);
      if (!(await colExists(db, table, col))) {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      }
    }
    await db.execute("PRAGMA user_version = 18");
  }

  // ── v19: Removed the "Restaurants" system category (id 14) — it was always a
  //         child of "Food & Dining" (id 3) and offered no useful distinction from
  //         its parent. Re-point every reference to id 3 before deleting the row,
  //         same merge pattern as the v7 migration above. ───────────────────────
  if (version < 19) {
    await db.execute("UPDATE transactions SET category_id=3 WHERE category_id=14");
    await db.execute("UPDATE categorization_rules SET category_id=3 WHERE category_id=14");
    await db.execute("UPDATE budgets SET category_id=3 WHERE category_id=14");
    await db.execute("UPDATE goals SET category_id=3 WHERE category_id=14");
    await db.execute("DELETE FROM categories WHERE id=14");
    await db.execute("PRAGMA user_version = 19");
  }

  // ── v20: New category (Excluded) - a second "leave this out of my totals" bucket
  //         alongside Transfers (id 20). Transfers is reserved for same-institution
  //         internal moves; Excluded is a general catch-all for anything else the user
  //         wants left out of income/expense totals (reimbursements, one-off
  //         adjustments, etc.) without mislabeling it as a "transfer". ──────────────
  if (version < 20) {
    await db.execute(`
      INSERT OR IGNORE INTO categories (id, name, parent_id, color, icon, is_system) VALUES
        (29, 'Excluded', NULL, '#94a3b8', 'circle-slash', 1)
    `);

    // Generic user-category merge (see MAINTAINER NOTE in the v7 migration above).
    const mergeTargets: { newId: number; upperName: string; color: string; icon: string }[] = [
      { newId: 29, upperName: "EXCLUDED", color: "#94a3b8", icon: "circle-slash" },
    ];
    for (const { newId, upperName, color, icon } of mergeTargets) {
      const duplicates = await db.select<{ id: number }[]>(
        "SELECT id FROM categories WHERE UPPER(name)=? AND is_system=0",
        [upperName]
      );
      for (const dup of duplicates) {
        if (dup.id === newId) {
          await db.execute(
            "UPDATE categories SET is_system=1, color=?, icon=? WHERE id=?",
            [color, icon, dup.id]
          );
        } else {
          await db.execute("UPDATE transactions SET category_id=? WHERE category_id=?", [newId, dup.id]);
          await db.execute("UPDATE categorization_rules SET category_id=? WHERE category_id=?", [newId, dup.id]);
          await db.execute("UPDATE budgets SET category_id=? WHERE category_id=?", [newId, dup.id]);
          await db.execute("UPDATE goals SET category_id=? WHERE category_id=?", [newId, dup.id]);
          await db.execute("DELETE FROM categories WHERE id=?", [dup.id]);
        }
      }
    }

    await db.execute("PRAGMA user_version = 20");
  }

  // ── v21: Fix-up for v20 - "Excluded" (id 29) could silently fail to be created if the
  //         user had already created ANY custom category after "Travel" (id 28) was added,
  //         since SQLite AUTOINCREMENT would already have claimed id 29 for that user
  //         category. `INSERT OR IGNORE` in v20 then silently no-op'd (id already taken),
  //         and the by-name merge loop only catches a user category literally named
  //         "Excluded" - it never fires for an unrelated category that just happens to sit
  //         at id 29. Net effect: "Excluded" never actually got created, and this is NOT
  //         self-healing just by re-running v20 (user_version already advanced past it).
  //         This migration explicitly frees up id 29 first if something else is squatting
  //         on it, then guarantees the canonical row exists. Idempotent / safe to re-run. ──
  if (version < 21) {
    const [existing29] = await db.select<{ id: number; name: string; is_system: number }[]>(
      "SELECT id, name, is_system FROM categories WHERE id=29"
    );
    if (existing29 && !(existing29.is_system === 1 && existing29.name.toUpperCase() === "EXCLUDED")) {
      if (existing29.is_system === 0 && existing29.name.toUpperCase() === "EXCLUDED") {
        // User already had a category literally named "Excluded" sitting at id 29 -
        // upgrade it in place (standard merge pattern), no relocation needed.
        await db.execute(
          "UPDATE categories SET is_system=1, color=?, icon=? WHERE id=29",
          ["#94a3b8", "circle-slash"]
        );
      } else {
        // An unrelated category occupies id 29 - relocate it to a fresh AUTOINCREMENT id
        // so "Excluded" can take its rightful slot, remapping every FK reference along the
        // way (same remap set as the generic merge pattern elsewhere in this file).
        const inserted = await db.execute(
          "INSERT INTO categories (name, parent_id, color, icon, is_system) SELECT name, parent_id, color, icon, is_system FROM categories WHERE id=29"
        );
        const newId = inserted.lastInsertId as number;
        await db.execute("UPDATE transactions SET category_id=? WHERE category_id=29", [newId]);
        await db.execute("UPDATE categorization_rules SET category_id=? WHERE category_id=29", [newId]);
        await db.execute("UPDATE budgets SET category_id=? WHERE category_id=29", [newId]);
        await db.execute("UPDATE goals SET category_id=? WHERE category_id=29", [newId]);
        await db.execute("UPDATE categories SET parent_id=? WHERE parent_id=29", [newId]);
        await db.execute("DELETE FROM categories WHERE id=29");
      }
    }

    // id 29 is now guaranteed free (or already correct) - safe to insert unconditionally.
    await db.execute(`
      INSERT OR IGNORE INTO categories (id, name, parent_id, color, icon, is_system) VALUES
        (29, 'Excluded', NULL, '#94a3b8', 'circle-slash', 1)
    `);

    // Re-run the by-name merge too, in case a DIFFERENTLY-id'd user category named
    // "Excluded" also exists (rare, but keeps this migration fully self-contained).
    const dupExcluded = await db.select<{ id: number }[]>(
      "SELECT id FROM categories WHERE UPPER(name)='EXCLUDED' AND is_system=0"
    );
    for (const dup of dupExcluded) {
      await db.execute("UPDATE transactions SET category_id=29 WHERE category_id=?", [dup.id]);
      await db.execute("UPDATE categorization_rules SET category_id=29 WHERE category_id=?", [dup.id]);
      await db.execute("UPDATE budgets SET category_id=29 WHERE category_id=?", [dup.id]);
      await db.execute("UPDATE goals SET category_id=29 WHERE category_id=?", [dup.id]);
      await db.execute("DELETE FROM categories WHERE id=?", [dup.id]);
    }

    await db.execute("PRAGMA user_version = 21");
  }

  // ── v22: Budget rollover - opt-in per budget (monthly only). When enabled, unspent
  //         amounts from prior months carry forward and increase the effective limit for
  //         the currently-viewed month, envelope-budgeting style. ─────────────────────────
  if (version < 22) {
    assertSafeMigrationIdentifiers("budgets", "rollover");
    if (!(await colExists(db, "budgets", "rollover"))) {
      await db.execute("ALTER TABLE budgets ADD COLUMN rollover INTEGER NOT NULL DEFAULT 0");
    }
    await db.execute("PRAGMA user_version = 22");
  }

  // ── v23: Debt Paydown goals - track progress toward paying down a specific credit
  //         card or loan balance to at or below a target amount (optionally $0 for a
  //         full payoff). Needs a reference to which account the goal applies to. ────────
  if (version < 23) {
    assertSafeMigrationIdentifiers("goals", "account_id");
    if (!(await colExists(db, "goals", "account_id"))) {
      await db.execute("ALTER TABLE goals ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL");
    }
    await db.execute("PRAGMA user_version = 23");
  }

  // ── v24: Scope `import_hash` uniqueness to (account_id, import_hash) instead of a bare
  //         global UNIQUE on import_hash alone. A hash is deterministic from a row's own
  //         content (date/description/amount/etc, or account+statement-date for loans) - a
  //         GLOBAL unique constraint meant that once a statement's rows were imported into
  //         one account, no OTHER account (even a brand-new one created after the original
  //         was permanently deleted, or a different account entirely) could ever import that
  //         same content again, INSERT would just fail as "already imported" forever. Since
  //         SQLite can't ALTER a column-level UNIQUE away, the table is recreated (same
  //         rename -> create -> copy -> drop pattern as the v9 goals migration above). Every
  //         existing row already satisfies the new, looser composite constraint (a global
  //         unique value is trivially unique per-account too), so the copy can't fail.
  if (version < 24) {
    const [tbl] = await db.select<{ sql: string }[]>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'"
    );
    const alreadyMigrated = (tbl?.sql ?? "").includes("account_id, import_hash");
    if (!alreadyMigrated) {
      // Rename → recreate → copy → drop → reindex, all in one transaction so a crash mid-
      // sequence can't leave transactions renamed away with no replacement.
      await db.executeBatch([
        { sql: "ALTER TABLE transactions RENAME TO transactions_v23" },
        { sql: `
          CREATE TABLE transactions (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            date              TEXT    NOT NULL,
            amount_cents      INTEGER NOT NULL,
            description       TEXT    NOT NULL DEFAULT '',
            category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,
            notes             TEXT,
            import_hash       TEXT    NOT NULL,
            created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
            profile_id        INTEGER DEFAULT 1,
            balance_cents     INTEGER,
            import_session_id INTEGER REFERENCES import_sessions(id) ON DELETE SET NULL,
            UNIQUE(account_id, import_hash)
          )
        ` },
        { sql: `
          INSERT INTO transactions
            (id, account_id, date, amount_cents, description, category_id, notes, import_hash,
             created_at, profile_id, balance_cents, import_session_id)
          SELECT id, account_id, date, amount_cents, description, category_id, notes, import_hash,
                 created_at, profile_id, balance_cents, import_session_id
          FROM transactions_v23
        ` },
        { sql: "DROP TABLE transactions_v23" },
        { sql: "CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)" },
        { sql: "PRAGMA user_version = 24" },
      ]);
    } else {
      await db.execute("PRAGMA user_version = 24");
    }
  }

  // ── v25: Repair user-created categories orphaned by a bug in CategoryModal's INSERT -
  //         it never set `profile_id`, which defaults to NULL, and NULL means "system/
  //         shared" for this column (see v2 migration above). The category row itself was
  //         never deleted, but `WHERE is_system=1 OR profile_id=?` (App.tsx /
  //         ProfileSwitcher.tsx) excludes NULL-profile, non-system rows - so every custom
  //         category silently disappeared from the UI on the next fresh load (e.g. after an
  //         app update discards the in-memory Zustand store), even though it still existed
  //         in the DB the whole time. CategoryModal.tsx now sets profile_id on insert; this
  //         migration reattaches existing orphans to the default profile (id=1) so they
  //         reappear. Best-effort: if a user has multiple profiles, an orphaned category
  //         originally created under a non-default profile will resurface under the
  //         default one instead - still strictly better than staying permanently invisible.
  if (version < 25) {
    await db.execute(
      "UPDATE categories SET profile_id=1 WHERE is_system=0 AND profile_id IS NULL"
    );
    await db.execute("PRAGMA user_version = 25");
  }

  // ── v26: User-defined recurring transactions. Distinct from `detectRecurringCharges`
  //         (agent.ts), which only finds a pattern AFTER it's already happened a few times -
  //         this lets a user schedule a bill/income ahead of its first real occurrence.
  //         Reminder-only for now: nothing here ever auto-inserts a real transaction row. ──
  if (version < 26) {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS recurring_rules (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id   INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        account_id   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        description  TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        cadence      TEXT NOT NULL DEFAULT 'monthly',
        day_of_month INTEGER,
        day_of_week  INTEGER,
        start_date   TEXT NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await db.execute("PRAGMA user_version = 26");
  }

  // ── v27: Scope column_profiles.header_sig uniqueness to (profile_id, header_sig) instead of
  //         a bare global UNIQUE on header_sig alone - two profiles importing the same bank's
  //         CSV header shape previously overwrote each other's saved column mapping (the SELECT
  //         filtered by header_sig+profile_id, but the UNIQUE constraint/ON CONFLICT target only
  //         knew about header_sig). Same rename -> create -> copy -> drop pattern as v9/v24. A
  //         value already globally unique is trivially unique per-profile too, so the copy can't
  //         fail on the new composite constraint. ──
  if (version < 27) {
    const [tbl] = await db.select<{ sql: string }[]>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='column_profiles'"
    );
    const alreadyMigrated = (tbl?.sql ?? "").includes("UNIQUE(profile_id, header_sig)");
    if (!alreadyMigrated) {
      await db.executeBatch([
        { sql: "ALTER TABLE column_profiles RENAME TO column_profiles_v26" },
        { sql: `
          CREATE TABLE column_profiles (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            header_sig  TEXT    NOT NULL,
            date_col    INTEGER NOT NULL,
            desc_col    INTEGER NOT NULL,
            amount_col  INTEGER NOT NULL,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            profile_id  INTEGER DEFAULT 1,
            type_col    INTEGER NOT NULL DEFAULT -1,
            balance_col INTEGER NOT NULL DEFAULT -1,
            UNIQUE(profile_id, header_sig)
          )
        ` },
        { sql: `
          INSERT INTO column_profiles
            (id, header_sig, date_col, desc_col, amount_col, created_at, profile_id, type_col, balance_col)
          SELECT id, header_sig, date_col, desc_col, amount_col, created_at, COALESCE(profile_id, 1), type_col, balance_col
          FROM column_profiles_v26
        ` },
        { sql: "DROP TABLE column_profiles_v26" },
        { sql: "PRAGMA user_version = 27" },
      ]);
    } else {
      await db.execute("PRAGMA user_version = 27");
    }
  }

  // ── v28: Persist manually-chosen invertAmounts (previously re-inferred every import instead
  //         of saved), and add separate debit_col/credit_col for banks with two amount columns
  //         (e.g. Capital One) instead of forcing a single amount column that silently drops
  //         whichever side isn't selected. ──
  if (version < 28) {
    for (const [col, def] of [
      ["invert_amounts", "INTEGER NOT NULL DEFAULT 0"],
      ["debit_col", "INTEGER NOT NULL DEFAULT -1"],
      ["credit_col", "INTEGER NOT NULL DEFAULT -1"],
    ] as [string, string][]) {
      assertSafeMigrationIdentifiers("column_profiles", col);
      if (!(await colExists(db, "column_profiles", col))) {
        await db.execute(`ALTER TABLE column_profiles ADD COLUMN ${col} ${def}`);
      }
    }
    await db.execute("PRAGMA user_version = 28");
  }

  // ── v29: Brokerage statements carry far more than a positions snapshot. `holdings` only
  //         models "what you own on date X"; these two tables model "what happened during the
  //         period" (trades, dividends, transfers) and the statement's own period totals. ──
  if (version < 29) {
    await db.executeBatch([
      {
        sql: `CREATE TABLE IF NOT EXISTS investment_activity (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          profile_id          INTEGER NOT NULL,
          import_session_id   INTEGER REFERENCES import_sessions(id) ON DELETE CASCADE,
          trade_date          TEXT    NOT NULL,
          settle_date         TEXT,
          activity_type       TEXT    NOT NULL, -- buy|sell|dividend|reinvest|interest|deposit|withdrawal|transfer|fee|tax|other
          raw_activity_type   TEXT,
          symbol              TEXT,
          description         TEXT    NOT NULL DEFAULT '',
          quantity            REAL,
          price_cents         INTEGER,
          amount_cents        INTEGER NOT NULL DEFAULT 0,
          -- Only populated by statements that print per-lot cost basis next to the sale.
          cost_basis_cents    INTEGER,
          realized_gain_cents INTEGER,
          acquired_date       TEXT,
          term                TEXT,          -- short|long
          import_hash         TEXT    NOT NULL,
          created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE(account_id, import_hash)
        )`,
      },
      { sql: "CREATE INDEX IF NOT EXISTS idx_investment_activity_account_date ON investment_activity(account_id, trade_date)" },
      {
        sql: `CREATE TABLE IF NOT EXISTS investment_summaries (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id              INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          profile_id              INTEGER NOT NULL,
          import_session_id       INTEGER REFERENCES import_sessions(id) ON DELETE CASCADE,
          period_start            TEXT,
          period_end              TEXT    NOT NULL,
          beginning_value_cents   INTEGER,
          ending_value_cents      INTEGER,
          change_in_value_cents   INTEGER,
          cash_balance_cents      INTEGER,
          deposits_cents          INTEGER,
          withdrawals_cents       INTEGER,
          transfers_cents         INTEGER,
          income_cents            INTEGER,
          dividends_cents         INTEGER,
          interest_cents          INTEGER,
          fees_cents              INTEGER,
          realized_gain_cents     INTEGER,
          realized_gain_ytd_cents INTEGER,
          unrealized_gain_cents   INTEGER,
          created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE(account_id, period_end)
        )`,
      },
      { sql: "PRAGMA user_version = 29" },
    ]);
  }

  // Almost every query in the app filters transactions by profile_id (and usually a date
  // range on top), but the only index was on date alone - so those all degraded to a full
  // scan. Composite indices matter most for users with years of history. Batched so a large
  // database builds all three in one transaction rather than three sequential ones.
  if (version < 30) {
    await db.executeBatch([
      { sql: "CREATE INDEX IF NOT EXISTS idx_transactions_profile_date ON transactions(profile_id, date)" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, date)" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id)" },
      { sql: "PRAGMA user_version = 30" },
    ]);
  }
}

// ─── Account helpers ──────────────────────────────────────────────────────────

/**
 * Returns the account ID for a profile+type, creating one if it doesn't exist.
 * A profile can hold multiple accounts of different types (e.g. a "checking"
 * account for bank imports and a separate "investment" account for portfolio
 * imports) - each type gets its own row so totals never mix accidentally.
 */
export async function getOrCreateAccountForProfile(
  profileId: number,
  accountType: string = "checking"
): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>(
    "SELECT id FROM accounts WHERE profile_id=? AND account_type=? LIMIT 1",
    [profileId, accountType]
  );
  if (rows.length > 0) return rows[0].id;
  const name = accountType === "investment" ? "Investment Account" : "My Account";
  const result = await db.execute(
    "INSERT INTO accounts (name, account_type, institution, profile_id) VALUES (?, ?, ?, ?)",
    [name, accountType, "Imported", profileId]
  );
  return result.lastInsertId as number;
}

/**
 * Lists every account a profile has of a given type (e.g. all "credit" accounts), so the
 * import wizard can offer them as choices instead of always collapsing to a single account
 * per type. Ordered by name for a stable, predictable dropdown.
 */
export async function listAccountsForProfile(profileId: number, accountType: string): Promise<Account[]> {
  const db = await getDb();
  return db.select<Account[]>(
    "SELECT id, name, account_type, institution, created_at, balance_anchor_cents, balance_anchor_date, interest_rate_bps, minimum_payment_cents FROM accounts WHERE profile_id=? AND account_type=? ORDER BY name",
    [profileId, accountType]
  );
}

export interface BalanceAnchorRiskEntry {
  accountId: number;
  name: string;
  accountType: string;
  hasAnchor: boolean;
  manualTxnCount: number;
  latestBalanceCents: number | null;
}

/**
 * Flags accounts that have had 2+ manually-added transactions (via "Add Transaction", not an
 * import) - the exact pattern that could trip the anchor-absorption bug fixed in
 * `recomputeCalculatedBalancesWithDb`/`shiftBalanceAnchorForTransactionChange` (see
 * import-account-resolution.md). A flagged account ISN'T necessarily wrong - the fix prevents
 * the bug going forward regardless - this is just a "worth double-checking against your real
 * bank balance" list for anyone who used the app before that fix shipped. Scoped to
 * checking/credit accounts, the only types manual transactions meaningfully apply to.
 */
export async function getBalanceAnchorRiskReport(profileId: number): Promise<BalanceAnchorRiskEntry[]> {
  const db = await getDb();
  const rows = await db.select<{
    id: number; name: string; account_type: string;
    balance_anchor_cents: number | null;
    manual_txn_count: number;
    latest_balance_cents: number | null;
  }[]>(
    `SELECT a.id, a.name, a.account_type, a.balance_anchor_cents,
       (SELECT COUNT(*) FROM transactions t WHERE t.account_id=a.id AND t.import_hash LIKE 'manual_%') as manual_txn_count,
       (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL
        ORDER BY t.date DESC, t.id DESC LIMIT 1) as latest_balance_cents
     FROM accounts a
     WHERE a.profile_id=? AND a.account_type IN ('checking','credit')
     ORDER BY a.account_type, a.name`,
    [profileId]
  );
  return rows
    .filter((r) => r.manual_txn_count >= 2)
    .map((r) => ({
      accountId: r.id, name: r.name, accountType: r.account_type,
      hasAnchor: r.balance_anchor_cents != null,
      manualTxnCount: r.manual_txn_count,
      latestBalanceCents: r.latest_balance_cents,
    }));
}

/** Existing manually-added transactions on an account (import_hash is a random UUID, never
 *  content-derived) - fetched so the import wizard can check incoming statement rows against
 *  them for possible duplicates before anything gets inserted. */
export async function getManualTransactionsForAccount(
  accountId: number
): Promise<{ id: number; date: string; description: string; amount_cents: number }[]> {
  const db = await getDb();
  return db.select<{ id: number; date: string; description: string; amount_cents: number }[]>(
    "SELECT id, date, description, amount_cents FROM transactions WHERE account_id=? AND import_hash LIKE 'manual_%'",
    [accountId]
  );
}

/** Sets (or clears, with `null`) an account's informational interest rate - used for credit
 *  cards during import (optional APR entry) the same way loan statements already do. Never
 *  used in any calculation, purely for display and Avalanche-method ranking on the Debt
 *  Dashboard. */
export async function setAccountInterestRate(accountId: number, interestRateBps: number | null): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE accounts SET interest_rate_bps=? WHERE id=?", [interestRateBps, accountId]);
}

/** Sets (or clears, with `null`) an account's informational minimum payment - used for credit
 *  cards during import (optional entry) the same way loan statements already do. Never used in
 *  any calculation except the Debt Dashboard's Cash-flow-First ranking and the Debt Payoff
 *  plan's amortization estimate (as a stand-in when the user hasn't entered one). */
export async function setAccountMinimumPayment(accountId: number, minimumPaymentCents: number | null): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE accounts SET minimum_payment_cents=? WHERE id=?", [minimumPaymentCents, accountId]);
}

/** The user's decision, made in the import wizard, about which account a statement belongs to. */
export type AccountChoice =
  | { mode: "existing"; accountId: number; name: string }
  | { mode: "new"; name: string; institution: string };

/**
 * Resolves an `AccountChoice` from the import wizard into a concrete account ID - either the
 * existing account the user picked/confirmed, or a freshly-created row for a new account (using
 * the real detected institution name instead of a generic placeholder, so future imports have
 * something meaningful to match against). Falls through to creating a new account if an
 * "existing" choice no longer belongs to this profile/type (defensive, shouldn't normally happen).
 */
export async function resolveAccountId(
  profileId: number,
  accountType: string,
  choice: AccountChoice
): Promise<number> {
  const db = await getDb();
  if (choice.mode === "existing") {
    const rows = await db.select<{ id: number }[]>(
      "SELECT id FROM accounts WHERE id=? AND profile_id=? AND account_type=?",
      [choice.accountId, profileId, accountType]
    );
    if (rows.length > 0) return rows[0].id;
  }
  const name = choice.mode === "new" ? choice.name : choice.name;
  const institution = choice.mode === "new" ? choice.institution : "Imported";
  const result = await db.execute(
    "INSERT INTO accounts (name, account_type, institution, profile_id) VALUES (?, ?, ?, ?)",
    [name || "My Account", accountType, institution || "Imported", profileId]
  );
  return result.lastInsertId as number;
}

/** An account plus enough summary info to show/manage it in an accounts list (name, current
 *  balance, and how much data is attached to it, to decide whether it's safe to delete). */
export interface AccountSummary {
  id: number;
  name: string;
  account_type: string;
  institution: string;
  balance_cents: number | null;
  txn_count: number;
  holdings_count: number;
  hidden_from_dashboard: boolean;
  excluded_from_insights: boolean;
}

/**
 * Lists every account belonging to a profile (regardless of type) with enough summary info to
 * render a "Manage Accounts" list - these are the accounts identified from imported/entered
 * transactions, unrelated to Profiles (which are separate people/entities in the app).
 */
export async function getAccountsSummaryForProfile(profileId: number): Promise<AccountSummary[]> {
  const db = await getDb();
  const rows = await db.select<(Omit<AccountSummary, "hidden_from_dashboard" | "excluded_from_insights"> & {
    hidden_from_dashboard: number; excluded_from_insights: number;
  })[]>(
    `SELECT a.id, a.name, a.account_type, a.institution,
       a.hidden_from_dashboard, a.excluded_from_insights,
       (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL
        ORDER BY t.date DESC, t.id DESC LIMIT 1) as balance_cents,
       (SELECT COUNT(*) FROM transactions t WHERE t.account_id=a.id) as txn_count,
       (SELECT COUNT(*) FROM holdings h WHERE h.account_id=a.id) as holdings_count
     FROM accounts a WHERE a.profile_id=? ORDER BY a.account_type, a.name`,
    [profileId]
  );
  return rows.map((r) => ({
    ...r,
    hidden_from_dashboard: !!r.hidden_from_dashboard,
    excluded_from_insights: !!r.excluded_from_insights,
  }));
}

/** Renames an account - the same "which account" naming used during import, editable afterward. */
export async function renameAccount(accountId: number, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Account name cannot be empty.");
  const db = await getDb();
  await db.execute("UPDATE accounts SET name=? WHERE id=?", [trimmed, accountId]);
}

/** Hides/shows an account's chart on the Dashboard/Overview pages. Hiding also removes it
 *  from net-worth totals (see computeNetWorth in netWorth.ts) - a single toggle for "don't
 *  count this account visually or in net worth right now" (e.g. a joint/shared account, or a
 *  loan you don't want reflected in your net worth). Defaults to visible/included. */
export async function setAccountHiddenFromDashboard(accountId: number, hidden: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE accounts SET hidden_from_dashboard=? WHERE id=?", [hidden ? 1 : 0, accountId]);
}

/** Excludes/includes an account from the Insights/health-score calculations in agent.ts
 *  (savings rate, budget health, spending profile, etc.) without affecting whether it's shown
 *  on the Dashboard/Overview or counted in net worth. Defaults to included. */
export async function setAccountExcludedFromInsights(accountId: number, excluded: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE accounts SET excluded_from_insights=? WHERE id=?", [excluded ? 1 : 0, accountId]);
}

/** Deletes an account, but only if it has no transactions or holdings attached - refuses
 *  otherwise so data is never silently lost through the accounts list. */
export async function deleteEmptyAccount(accountId: number): Promise<void> {
  const db = await getDb();
  const [row] = await db.select<{ txn_count: number; holdings_count: number }[]>(
    `SELECT (SELECT COUNT(*) FROM transactions WHERE account_id=?) as txn_count,
            (SELECT COUNT(*) FROM holdings WHERE account_id=?)
            + (SELECT COUNT(*) FROM investment_activity WHERE account_id=?) as holdings_count`,
    [accountId, accountId, accountId]
  );
  if ((row?.txn_count ?? 0) > 0 || (row?.holdings_count ?? 0) > 0) {
    throw new Error("This account still has transactions or holdings - remove those first.");
  }
  await db.execute("DELETE FROM accounts WHERE id=?", [accountId]);
}

/**
 * Permanently deletes an account AND every transaction/holding attached to it (SQLite's
 * ON DELETE CASCADE isn't relied on here since this app never enables `PRAGMA foreign_keys`,
 * so the cascade is done by hand). Also cleans up any import_sessions that end up with zero
 * remaining transactions as a result, so the Import History list doesn't keep a stray empty
 * entry around. This is deliberately separate from `deleteEmptyAccount` - callers must obtain
 * their own (more serious) confirmation before calling this, since it is destructive and
 * cannot be undone.
 */
export async function deleteAccountWithData(accountId: number): Promise<void> {
  const db = await getDb();
  const sessions = await db.select<{ id: number }[]>(
    "SELECT DISTINCT import_session_id as id FROM transactions WHERE account_id=? AND import_session_id IS NOT NULL",
    [accountId]
  );
  await db.execute("DELETE FROM transactions WHERE account_id=?", [accountId]);
  await db.execute("DELETE FROM holdings WHERE account_id=?", [accountId]);
  await db.execute("DELETE FROM investment_activity WHERE account_id=?", [accountId]);
  await db.execute("DELETE FROM investment_summaries WHERE account_id=?", [accountId]);
  for (const { id } of sessions) {
    const [remaining] = await db.select<{ n: number }[]>(
      "SELECT COUNT(*) as n FROM transactions WHERE import_session_id=?",
      [id]
    );
    if ((remaining?.n ?? 0) === 0) {
      await db.execute("DELETE FROM import_sessions WHERE id=?", [id]);
    }
  }
  await db.execute("DELETE FROM accounts WHERE id=?", [accountId]);
}

/**
 * Erases everything belonging to one profile - transactions, accounts, holdings, budgets,
 * goals, scheduled rules, categorization rules, saved import layouts and any custom categories -
 * while keeping the profile itself. Runs as a single transaction so a failure part-way through
 * can't leave a half-erased profile behind.
 *
 * A privacy-first app that can't forget you is a contradiction, but this is unrecoverable:
 * callers MUST confirm explicitly, and should point the user at Backup first.
 */
export async function deleteAllProfileData(profileId: number): Promise<void> {
  const db = await getDb();
  await db.executeBatch([
    { sql: "DELETE FROM holdings WHERE profile_id=?", params: [profileId] },
    { sql: "DELETE FROM investment_activity WHERE profile_id=?", params: [profileId] },
    { sql: "DELETE FROM investment_summaries WHERE profile_id=?", params: [profileId] },
    { sql: "DELETE FROM transactions WHERE profile_id=?", params: [profileId] },
    { sql: "DELETE FROM import_sessions WHERE profile_id=?", params: [profileId] },
    { sql: "DELETE FROM accounts WHERE profile_id=?", params: [profileId] },
    { sql: "DELETE FROM budgets WHERE profile_id=?", params: [profileId] },
    { sql: "DELETE FROM goals WHERE profile_id=?", params: [profileId] },
    { sql: "DELETE FROM recurring_rules WHERE profile_id=?", params: [profileId] },
    { sql: "DELETE FROM categorization_rules WHERE profile_id=?", params: [profileId] },
    { sql: "DELETE FROM column_profiles WHERE profile_id=?", params: [profileId] },
    // System categories are shared across profiles and must survive - only this profile's own
    // custom ones go.
    { sql: "DELETE FROM categories WHERE profile_id=? AND is_system=0", params: [profileId] },
  ]);
}

/** One group of accounts that share the same type + name (case/whitespace-insensitive) within
 *  a profile - candidates to merge into a single account. */
export interface DuplicateAccountGroup {
  account_type: string;
  name: string;
  accounts: { id: number; created_at: string; txn_count: number; holdings_count: number }[];
}

/** Finds groups of 2+ accounts in a profile that share the same type and name - typically
 *  created by a bug or by importing the same account under slightly different sessions. */
export async function findDuplicateAccountGroups(profileId: number): Promise<DuplicateAccountGroup[]> {
  const db = await getDb();
  const rows = await db.select<{
    id: number; name: string; account_type: string; created_at: string; txn_count: number; holdings_count: number;
  }[]>(
    `SELECT a.id, a.name, a.account_type, a.created_at,
       (SELECT COUNT(*) FROM transactions t WHERE t.account_id=a.id) as txn_count,
       (SELECT COUNT(*) FROM holdings h WHERE h.account_id=a.id) as holdings_count
     FROM accounts a WHERE a.profile_id=? ORDER BY a.account_type, a.name, a.created_at ASC`,
    [profileId]
  );
  const groups = new Map<string, DuplicateAccountGroup>();
  for (const r of rows) {
    const key = `${r.account_type}::${r.name.trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { account_type: r.account_type, name: r.name, accounts: [] });
    groups.get(key)!.accounts.push({ id: r.id, created_at: r.created_at, txn_count: r.txn_count, holdings_count: r.holdings_count });
  }
  return [...groups.values()].filter((g) => g.accounts.length > 1);
}

/**
 * Merges every duplicate-account group in a profile (same type + name) into one account each -
 * keeps the oldest account as the primary, reassigns every other duplicate's transactions and
 * holdings onto it, deletes the emptied duplicates, then recomputes the primary's running
 * balance. Returns the number of duplicate rows merged away.
 */
export async function mergeDuplicateAccounts(profileId: number): Promise<number> {
  const db = await getDb();
  const groups = await findDuplicateAccountGroups(profileId);
  let merged = 0;
  for (const group of groups) {
    const [primary, ...dupes] = group.accounts;
    for (const dupe of dupes) {
      // A transaction with the exact same import_hash already exists on `primary` (the same
      // statement row, imported into both duplicate accounts at some point) - discard the
      // duplicate-account's copy instead of moving it, since moving it would violate the
      // (account_id, import_hash) uniqueness constraint on the now-merged account.
      await db.execute(
        `DELETE FROM transactions WHERE account_id=? AND import_hash IN (
           SELECT import_hash FROM transactions WHERE account_id=?
         )`,
        [dupe.id, primary.id]
      );
      await db.execute("UPDATE transactions SET account_id=? WHERE account_id=?", [primary.id, dupe.id]);
      await db.execute("UPDATE holdings SET account_id=? WHERE account_id=?", [primary.id, dupe.id]);
      await db.execute("DELETE FROM accounts WHERE id=?", [dupe.id]);
      merged++;
    }
    await recomputeCalculatedBalancesWithDb(db, primary.id);
  }
  return merged;
}

// ─── Loan accounts ────────────────────────────────────────────────────────────
// Loans are their own account_type ('loan'), never counted toward liquidity or
// income/expense totals. Each statement upload records a single balance-snapshot
// `transactions` row (balance_cents only, no itemized purchases) - the same shape
// credit cards already use for their running balance - so the existing per-account
// tile/sparkline rendering works unmodified. interest_rate_bps/minimum_payment_cents
// are purely informational and are never used in any calculation.
//
// The snapshot row is filed under category_id=20 (Transfers) rather than NULL -
// nearly every income/expense query across the app already excludes categories 20 and 29
// (Transfers and Excluded) via the ubiquitous
// `(t.category_id IS NULL OR t.category_id NOT IN (20,29))` filter, so this one
// choice keeps loan snapshots out of spending/income totals everywhere, not just the
// handful of queries that were explicitly updated to also exclude account_type='loan'.

export interface LoanAccount {
  id: number;
  name: string;
  institution: string;
  interest_rate_bps: number | null;
  minimum_payment_cents: number | null;
  balance_cents: number | null; // negative (amount owed), or null if no statement uploaded yet
  hidden_from_dashboard: boolean;
}

export async function getLoanAccountsForProfile(profileId: number): Promise<LoanAccount[]> {
  const db = await getDb();
  const rows = await db.select<(Omit<LoanAccount, "hidden_from_dashboard"> & { hidden_from_dashboard: number })[]>(
    `SELECT a.id, a.name, a.institution, a.interest_rate_bps, a.minimum_payment_cents, a.hidden_from_dashboard,
       (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL
        ORDER BY t.date DESC, t.id DESC LIMIT 1) as balance_cents
     FROM accounts a WHERE a.profile_id=? AND a.account_type='loan' ORDER BY a.name`,
    [profileId]
  );
  return rows.map((r) => ({ ...r, hidden_from_dashboard: !!r.hidden_from_dashboard }));
}

/** Same shape as `getLoanAccountsForProfile`, for credit card accounts - lets the Debt
 *  Dashboard rank credit cards alongside loans (Avalanche/Snowball/Cash-flow methods work
 *  identically for either, once a credit card has an optional interest rate on file). */
export async function getCreditAccountsForProfile(profileId: number): Promise<LoanAccount[]> {
  const db = await getDb();
  const rows = await db.select<(Omit<LoanAccount, "hidden_from_dashboard"> & { hidden_from_dashboard: number })[]>(
    `SELECT a.id, a.name, a.institution, a.interest_rate_bps, a.minimum_payment_cents, a.hidden_from_dashboard,
       (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL
        ORDER BY t.date DESC, t.id DESC LIMIT 1) as balance_cents
     FROM accounts a WHERE a.profile_id=? AND a.account_type='credit' ORDER BY a.name`,
    [profileId]
  );
  return rows.map((r) => ({ ...r, hidden_from_dashboard: !!r.hidden_from_dashboard }));
}

/** Balance history (one point per statement) for a loan account's sparkline - same shape as
 *  the credit-card tile chart data. */
export async function getLoanBalanceHistory(accountId: number): Promise<{ date: string; value: number }[]> {
  const db = await getDb();
  const rows = await db.select<{ date: string; balance_cents: number }[]>(
    `SELECT date, balance_cents FROM transactions
     WHERE account_id=? AND balance_cents IS NOT NULL ORDER BY date ASC, id ASC`,
    [accountId]
  );
  return rows.map((r) => ({ date: r.date, value: r.balance_cents / 100 }));
}

/**
 * Creates a new loan account (or reuses an existing one, either by explicit id or by
 * case-insensitive name match within the profile) and records one statement snapshot as a
 * `transactions` row. Re-uploading a statement for the same account+date updates that
 * snapshot in place instead of creating a duplicate (import_hash is deterministic:
 * `loan_stmt_<accountId>_<date>`). Returns the account id.
 */
export async function upsertLoanStatement(params: {
  profileId: number;
  accountId?: number | null;
  name: string;
  institution: string;
  interestRateBps: number | null;
  minimumPaymentCents: number | null;
  statementDate: string; // YYYY-MM-DD
  balanceCents: number; // positive amount owed - stored negative, matching credit accounts
}): Promise<number> {
  const db = await getDb();
  const name = params.name.trim() || "Loan";
  const institution = params.institution.trim();

  let accountId = params.accountId ?? null;
  if (accountId == null) {
    const existing = await db.select<{ id: number }[]>(
      "SELECT id FROM accounts WHERE profile_id=? AND account_type='loan' AND name=? COLLATE NOCASE",
      [params.profileId, name]
    );
    if (existing.length > 0) accountId = existing[0].id;
  }

  if (accountId == null) {
    const result = await db.execute(
      "INSERT INTO accounts (name, account_type, institution, profile_id, interest_rate_bps, minimum_payment_cents) VALUES (?, 'loan', ?, ?, ?, ?)",
      [name, institution, params.profileId, params.interestRateBps, params.minimumPaymentCents]
    );
    accountId = result.lastInsertId as number;
  } else {
    await db.execute(
      "UPDATE accounts SET name=?, institution=?, interest_rate_bps=?, minimum_payment_cents=? WHERE id=?",
      [name, institution, params.interestRateBps, params.minimumPaymentCents, accountId]
    );
  }

  const balanceCents = -Math.abs(params.balanceCents);
  const hash = `loan_stmt_${accountId}_${params.statementDate}`;
  const [prior] = await db.select<{ balance_cents: number }[]>(
    `SELECT balance_cents FROM transactions WHERE account_id=? AND balance_cents IS NOT NULL AND date<?
     ORDER BY date DESC, id DESC LIMIT 1`,
    [accountId, params.statementDate]
  );
  const deltaCents = prior ? balanceCents - prior.balance_cents : 0;

  // Reuse the same import_sessions row on a same-date re-upload (found via the existing
  // transaction's own session, since import_hash is deterministic per account+date) rather
  // than piling up an empty duplicate session every time a statement gets re-uploaded - either
  // way, this session is what lets the Import page's history list show and undo this upload
  // like any other import.
  const [existingTxn] = await db.select<{ import_session_id: number | null }[]>(
    "SELECT import_session_id FROM transactions WHERE import_hash=?",
    [hash]
  );
  let sessionId: number;
  if (existingTxn?.import_session_id != null) {
    sessionId = existingTxn.import_session_id;
    await db.execute(
      "UPDATE import_sessions SET filename=?, imported_at=datetime('now') WHERE id=?",
      [`${name} - statement ${params.statementDate}`, sessionId]
    );
  } else {
    const sessionResult = await db.execute(
      "INSERT INTO import_sessions (filename, row_count, skipped_count, profile_id, kind) VALUES (?, 1, 0, ?, 'loan')",
      [`${name} - statement ${params.statementDate}`, params.profileId]
    );
    sessionId = sessionResult.lastInsertId as number;
  }

  await db.execute(
    `INSERT INTO transactions (account_id, date, amount_cents, description, category_id, import_hash, balance_cents, profile_id, import_session_id)
     VALUES (?, ?, ?, ?, 20, ?, ?, ?, ?)
     ON CONFLICT(account_id, import_hash) DO UPDATE SET amount_cents=excluded.amount_cents, balance_cents=excluded.balance_cents, import_session_id=excluded.import_session_id`,
    [accountId, params.statementDate, deltaCents, "Statement balance update", hash, balanceCents, params.profileId, sessionId]
  );

  return accountId;
}

/** Deletes a loan account and its statement-snapshot rows - unlike deleteEmptyAccount, this is
 *  always allowed since a loan account's only "transactions" are its own balance snapshots. */
export async function deleteLoanAccount(accountId: number): Promise<void> {
  const db = await getDb();
  const sessions = await db.select<{ id: number }[]>(
    "SELECT DISTINCT import_session_id as id FROM transactions WHERE account_id=? AND import_session_id IS NOT NULL",
    [accountId]
  );
  await db.execute("DELETE FROM transactions WHERE account_id=?", [accountId]);
  for (const { id } of sessions) {
    const [remaining] = await db.select<{ n: number }[]>(
      "SELECT COUNT(*) as n FROM transactions WHERE import_session_id=?",
      [id]
    );
    if ((remaining?.n ?? 0) === 0) {
      await db.execute("DELETE FROM import_sessions WHERE id=?", [id]);
    }
  }
  await db.execute("DELETE FROM accounts WHERE id=? AND account_type='loan'", [accountId]);
}

/**
 * Shifts a manually-set balance anchor by a transaction change that falls within the anchor's
 * coverage window (date <= the anchor's date). Without this, adding/editing/deleting a single
 * transaction dated on or before the anchor date gets silently absorbed by
 * `recomputeCalculatedBalancesWithDb`'s backward-fit pass instead of actually changing the
 * anchor's own target value - e.g. adding a same-day $300 transfer out of an account anchored
 * at $315 would otherwise leave the anchor (and therefore the latest balance) unchanged at
 * $315, instead of correctly becoming $15. `removed` is the transaction's PRE-change date/amount
 * (pass for an edit or delete), `added` is its POST-change date/amount (pass for an edit or a
 * new add) - either may be null. No-op if the account has no anchor set, or if neither date
 * falls on/before it.
 */
export async function shiftBalanceAnchorForTransactionChange(
  accountId: number,
  removed: { date: string; amountCents: number } | null,
  added: { date: string; amountCents: number } | null
): Promise<void> {
  const db = await getDb();
  const [acct] = await db.select<{ balance_anchor_cents: number | null; balance_anchor_date: string | null }[]>(
    "SELECT balance_anchor_cents, balance_anchor_date FROM accounts WHERE id=?",
    [accountId]
  );
  if (acct?.balance_anchor_cents == null || !acct.balance_anchor_date) return;

  let delta = 0;
  if (removed && removed.date <= acct.balance_anchor_date) delta -= removed.amountCents;
  if (added && added.date <= acct.balance_anchor_date) delta += added.amountCents;
  if (delta !== 0) {
    await db.execute(
      "UPDATE accounts SET balance_anchor_cents=balance_anchor_cents+? WHERE id=?",
      [delta, accountId]
    );
  }
}

/**
 * Recalculates `balance_cents` for every transaction on an account using its manually-set
 * balance anchor - the real balance AFTER all transactions up to `balance_anchor_date`
 * (typically "today", the date the value was entered). Transactions on or before that date
 * are calculated backward from the anchor; any transactions after it (e.g. from a later
 * import) are calculated forward from it. With no manual anchor set, the LATEST transaction
 * that already carries a real `balance_cents` (e.g. from a bank statement's own running-
 * balance column) is used as an implicit anchor instead of assuming a $0 starting balance -
 * see the "implicit anchor" comment below for why this matters. Used for imports whose source
 * file has no native running-balance column, and any time a transaction is manually
 * added/edited/deleted or an import batch is undone.
 *
 * Callers that add/edit/delete a SINGLE transaction dated on or before the anchor date must
 * call {@link shiftBalanceAnchorForTransactionChange} first - this function trusts the stored
 * anchor as-is and has no way to tell a brand-new transaction apart from one that already
 * existed when the anchor was set.
 */
export async function recomputeCalculatedBalances(accountId: number): Promise<void> {
  const db = await getDb();
  await recomputeCalculatedBalancesWithDb(db, accountId);
}

/**
 * Same as {@link recomputeCalculatedBalances}, but takes an already-open db handle instead of
 * calling getDb() itself. Migrations must use this variant - calling getDb() again while the
 * very first getDb() call is still awaiting runMigrations() would deadlock (getDb() returns the
 * same in-flight promise it's already inside of, which never resolves).
 */
async function recomputeCalculatedBalancesWithDb(db: CompassDb, accountId: number): Promise<void> {
  const rows = await db.select<{ id: number; date: string; amount_cents: number; balance_cents: number | null }[]>(
    "SELECT id, date, amount_cents, balance_cents FROM transactions WHERE account_id=? ORDER BY date ASC, id ASC",
    [accountId]
  );

  if (rows.length === 0) {
    // No transactions left on this account (e.g. everything was cleared/undone) - a leftover
    // anchor from before the clear would otherwise silently resurface on the next import
    // (the wizard:balance step prefills from it), showing a stale balance forever.
    await db.execute(
      "UPDATE accounts SET balance_anchor_cents=NULL, balance_anchor_date=NULL WHERE id=?",
      [accountId]
    );
    return;
  }

  const [acct] = await db.select<{ balance_anchor_cents: number | null; balance_anchor_date: string | null }[]>(
    "SELECT balance_anchor_cents, balance_anchor_date FROM accounts WHERE id=?",
    [accountId]
  );

  let anchorCents = acct?.balance_anchor_cents ?? null;
  let anchorDate = acct?.balance_anchor_date ?? null;

  if (anchorCents == null || !anchorDate) {
    // Implicit anchor: this function runs on EVERY manual add/edit/delete of a transaction
    // and every "undo import" - not just imports without a native balance column. Without
    // this, an account imported WITH a real per-row balance column from the bank (accurate
    // data) would have that entire history silently discarded and replaced with a "pure"
    // running total from $0 the moment the user manually touched a single transaction -
    // producing a wildly wrong balance for every row, not just the edited one. Anchoring to
    // the latest transaction that still carries a real `balance_cents` preserves the bank's
    // own numbers instead.
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].balance_cents != null) {
        anchorCents = rows[i].balance_cents;
        anchorDate = rows[i].date;
        break;
      }
    }
    if (anchorCents != null && anchorDate) {
      // Any OTHER row dated on/before the picked anchor date that doesn't have a balance_cents
      // value yet isn't reflected in that native number at all - it's either a manual
      // transaction added in this very same operation, or an older no-balance-column import
      // that's never been computed - so shift the anchor by its amount first, the same reason
      // shiftBalanceAnchorForTransactionChange exists for an anchor that already existed
      // in `accounts` before this call.
      const unreflectedCents = rows
        .filter((r) => r.date <= anchorDate! && r.balance_cents == null)
        .reduce((sum, r) => sum + r.amount_cents, 0);
      anchorCents += unreflectedCents;
      // Persist this as a real explicit anchor going forward - otherwise a SECOND manual
      // add/edit/delete would re-derive an implicit anchor from whatever the FIRST one just
      // computed (its balance_cents is no longer a genuine bank-native value at that point,
      // just this function's own prior output), silently re-anchoring to an already-adjusted
      // number and compounding every mutation after it instead of shifting from a fixed point.
      // shiftBalanceAnchorForTransactionChange (called by add/edit/delete BEFORE this function)
      // can only shift an anchor that already exists in `accounts` - this makes one exist after
      // the very first mutation on a previously anchor-less (native-balance-column) account.
      await db.execute(
        "UPDATE accounts SET balance_anchor_cents=?, balance_anchor_date=? WHERE id=?",
        [anchorCents, anchorDate, accountId]
      );
    }
  }

  if (anchorCents == null || !anchorDate) {
    // Truly no balance data anywhere on this account (brand new, no anchor, no native balance
    // column ever imported) - nothing to anchor to, so fall back to a pure relative running
    // total from $0.
    let running = 0;
    for (const row of rows) {
      running += row.amount_cents;
      await db.execute("UPDATE transactions SET balance_cents=? WHERE id=?", [running, row.id]);
    }
    return;
  }

  const upToAnchor = rows.filter((r) => r.date <= anchorDate!);
  const afterAnchor = rows.filter((r) => r.date > anchorDate!);

  // Backward pass: the anchor is the balance right after the last transaction on/before
  // the anchor date, so walk from latest to earliest, subtracting each one's amount.
  let running = anchorCents;
  for (let i = upToAnchor.length - 1; i >= 0; i--) {
    const row = upToAnchor[i];
    await db.execute("UPDATE transactions SET balance_cents=? WHERE id=?", [running, row.id]);
    running -= row.amount_cents;
  }

  // Forward pass: any transactions dated after the anchor build forward from it.
  running = anchorCents;
  for (const row of afterAnchor) {
    running += row.amount_cents;
    await db.execute("UPDATE transactions SET balance_cents=? WHERE id=?", [running, row.id]);
  }
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
  // Only log categorization internals (transaction descriptions, match counts)
  // in dev builds — never in production, to avoid leaking financial data to
  // the console.
  const debugLog = (...args: unknown[]) => {
    if (import.meta.env.DEV) console.debug(...args);
  };

  // Fetch rules ordered by priority so the loop mirrors import behaviour.
  // Also select profile_id so we can distinguish user rules from system rules.
  const rules = await db.select<(CategorizationRule & { profile_id: number | null })[]>(
    `SELECT id, pattern, match_type, category_id, priority, min_abs_cents, max_abs_cents, profile_id
     FROM categorization_rules
     WHERE profile_id=? OR profile_id IS NULL
     ORDER BY priority DESC`,
    [profileId]
  );
  debugLog(`[autoCat] ${rules.length} rules loaded`);

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
  debugLog(`[autoCat] ${transactions.length} transactions to evaluate (mode=${mode})`);

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
    debugLog("[autoCat] No matches — nothing to update");
    return 0;
  }
  debugLog(`[autoCat] ${matched} matched across ${byCategory.size} categories, running updates…`);

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

// ─── Recurring transactions (user-defined) ────────────────────────────────────
//
// Reminder-only: creating/editing a rule never inserts a real transaction row. See
// src/lib/recurring.ts's computeNextOccurrence for the pure date math these feed into.

export interface RecurringRuleInput {
  profileId: number;
  accountId: number | null;
  description: string;
  amountCents: number;
  categoryId: number | null;
  cadence: RecurringCadence;
  dayOfMonth: number | null;
  dayOfWeek: number | null;
  startDate: string;
}

export async function getRecurringRulesForProfile(profileId: number): Promise<RecurringRule[]> {
  const db = await getDb();
  const rows = await db.select<(Omit<RecurringRule, "active"> & { active: number })[]>(
    `SELECT r.*, c.name as category_name, c.color as category_color, a.name as account_name
     FROM recurring_rules r
     LEFT JOIN categories c ON c.id=r.category_id
     LEFT JOIN accounts a ON a.id=r.account_id
     WHERE r.profile_id=?
     ORDER BY r.active DESC, r.description`,
    [profileId]
  );
  return rows.map((r) => ({ ...r, active: !!r.active }));
}

export async function createRecurringRule(input: RecurringRuleInput): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO recurring_rules
       (profile_id, account_id, description, amount_cents, category_id, cadence, day_of_month, day_of_week, start_date, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [input.profileId, input.accountId, input.description, input.amountCents, input.categoryId,
     input.cadence, input.dayOfMonth, input.dayOfWeek, input.startDate]
  );
  return result.lastInsertId as number;
}

export async function updateRecurringRule(id: number, input: RecurringRuleInput): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE recurring_rules
     SET account_id=?, description=?, amount_cents=?, category_id=?, cadence=?, day_of_month=?, day_of_week=?, start_date=?
     WHERE id=?`,
    [input.accountId, input.description, input.amountCents, input.categoryId,
     input.cadence, input.dayOfMonth, input.dayOfWeek, input.startDate, id]
  );
}

export async function setRecurringRuleActive(id: number, active: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE recurring_rules SET active=? WHERE id=?", [active ? 1 : 0, id]);
}

export async function deleteRecurringRule(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM recurring_rules WHERE id=?", [id]);
}
