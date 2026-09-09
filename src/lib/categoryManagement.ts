import { getDb } from "./db";
import type { Category } from "./types";

export async function loadCategories(profileId: number): Promise<Category[]> {
  const database = await getDb();
  return database.select<Category[]>("SELECT * FROM categories WHERE is_system=1 OR profile_id=? ORDER BY sort_order, name", [profileId]);
}

export async function reorderCategories(profileId: number, categoryIds: number[]): Promise<void> {
  const database = await getDb();
  const owned = await database.select<{ id: number }[]>("SELECT id FROM categories WHERE profile_id=? AND is_system=0", [profileId]);
  if (categoryIds.length !== owned.length || new Set(categoryIds).size !== owned.length || owned.some((category) => !categoryIds.includes(category.id))) {
    throw new Error("The category list changed. Reopen the manager and try again.");
  }
  await database.executeBatch(categoryIds.map((id, index) => ({
    sql: "UPDATE categories SET sort_order=? WHERE id=? AND profile_id=? AND is_system=0",
    params: [index, id, profileId],
  })));
}

export async function deleteUserCategory(profileId: number, categoryId: number, replacementId: number): Promise<void> {
  const database = await getDb();
  const [source] = await database.select<Category[]>("SELECT * FROM categories WHERE id=? AND profile_id=? AND is_system=0", [categoryId, profileId]);
  const [replacement] = await database.select<Category[]>("SELECT * FROM categories WHERE id=? AND (profile_id=? OR is_system=1)", [replacementId, profileId]);
  if (!source || !replacement || categoryId === replacementId) throw new Error("Choose a valid replacement category.");
  const conflictingBudgets = await database.select<{ id: number }[]>(
    "SELECT target.id FROM budgets target JOIN budgets source ON source.profile_id=target.profile_id AND source.period=target.period WHERE source.category_id=? AND target.category_id=? LIMIT 1",
    [categoryId, replacementId],
  );
  if (conflictingBudgets.length) throw new Error("Both categories have budgets for the same period. Resolve those budgets or choose another replacement.");
  const conflictingRules = await database.select<{ id: number }[]>(
    "SELECT target.id FROM categorization_rules target JOIN categorization_rules source ON source.pattern=target.pattern WHERE source.category_id=? AND target.category_id=? LIMIT 1",
    [categoryId, replacementId],
  );
  if (conflictingRules.length) throw new Error("Both categories have a matching categorization rule. Resolve those rules or choose another replacement.");
  await database.executeBatch([
    ...["transactions", "budgets", "goals", "categorization_rules", "recurring_rules"].map((table) => ({
      sql: `UPDATE ${table} SET category_id=? WHERE category_id=?`, params: [replacementId, categoryId],
    })),
    { sql: "UPDATE categories SET parent_id=? WHERE parent_id=?", params: [source.parent_id, categoryId] },
    { sql: "DELETE FROM categories WHERE id=? AND profile_id=? AND is_system=0", params: [categoryId, profileId] },
  ]);
}