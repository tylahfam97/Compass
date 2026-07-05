import Database from "@tauri-apps/plugin-sql";
import type { CategorizationRule } from "./types";

let _db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (_db) return _db;
  _db = await Database.load("sqlite:compass.db");
  return _db;
}

export async function getOrCreateDefaultAccount(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>(
    "SELECT id FROM accounts LIMIT 1"
  );
  if (rows.length > 0) return rows[0].id;
  const result = await db.execute(
    "INSERT INTO accounts (name, account_type, institution) VALUES (?, ?, ?)",
    ["My Account", "checking", "Imported"]
  );
  return result.lastInsertId as number;
}

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
