import { test as base, expect } from "@playwright/test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const test = base.extend<{ database: DatabaseSync }>({
  database: async ({ page }, use) => {
    const database = new DatabaseSync(":memory:");
    await page.exposeBinding("compassTestInvoke", async (_source, command: string, args: { sql?: string; params?: SQLInputValue[]; statements?: { sql: string; params?: SQLInputValue[] }[] } = {}) => {
      if (command === "db_select") return database.prepare(args.sql!).all(...(args.params ?? []));
      if (command === "db_execute") {
        const result = database.prepare(args.sql!).run(...(args.params ?? []));
        return { lastInsertId: Number(result.lastInsertRowid), rowsAffected: Number(result.changes) };
      }
      if (command === "db_execute_batch") {
        database.exec("BEGIN");
        try {
          for (const statement of args.statements ?? []) database.prepare(statement.sql).run(...(statement.params ?? []));
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        return;
      }
      if (command === "plugin:app|version") return "1.0.2";
      if (command === "plugin:event|listen") return 1;
      if (command.startsWith("plugin:event|") || command.startsWith("plugin:window|") || command === "plugin:updater|check") return null;
      throw new Error(`Unexpected native command: ${command}`);
    });
    await page.addInitScript(() => {
      const bridge = window as unknown as {
        compassTestInvoke: (command: string, args: unknown) => Promise<unknown>;
        __TAURI_INTERNALS__: unknown;
      };
      bridge.__TAURI_INTERNALS__ = {
        invoke: (command: string, args: unknown) => bridge.compassTestInvoke(command, args),
        transformCallback: () => 1,
        unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      };
      localStorage.setItem("compass_onboarding_dismissed_forever", "1");
      localStorage.setItem("compass_milestones_seen_1", JSON.stringify(["goal_complete_1", "goal_complete_2", "goal_complete_3"]));
      localStorage.setItem("compass_transfer_disclaimer_dismissed", "1");
      localStorage.setItem("compass_plan_window", "nextMonth");
      localStorage.setItem("sidebarOpen", "false");
    });
    await page.goto("/plan");
    await expect(page.getByText("No checking account yet", { exact: true })).toBeVisible();
    const date = (offset: number) => {
      const value = new Date();
      value.setDate(value.getDate() + offset);
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    };
    database.prepare("UPDATE profiles SET name='Preview profile' WHERE id=1").run();
    database.prepare("INSERT INTO accounts (id,name,account_type,profile_id) VALUES (1,'Everyday checking','checking',1)").run();
    const category = (name: string) => Number(database.prepare("SELECT id FROM categories WHERE name=? LIMIT 1").get(name)?.id ?? 15);
    const categoryIds = ["Groceries", "Food & Dining", "Transportation", "Shopping"].map(category);
    const insertTransaction = database.prepare("INSERT INTO transactions (account_id,profile_id,date,description,amount_cents,balance_cents,category_id,import_hash) VALUES (1,1,?,?,?,?,?,?)");
    for (let index = 0; index < 12; index++) {
      insertTransaction.run(date(-Math.floor(index / 3)), ["Green Market Groceries", "Neighborhood Coffee", "City Transit", "Bookshop & Stationery"][index % 4], -[8450, 650, 2400, 3800][index % 4], 100_000, categoryIds[index % 4], `preview-${index}`);
    }
    for (const monthsAgo of [1, 2]) {
      const historical = new Date();
      historical.setDate(1);
      historical.setMonth(historical.getMonth() - monthsAgo);
      const historicalDate = `${historical.getFullYear()}-${String(historical.getMonth() + 1).padStart(2, "0")}-01`;
      insertTransaction.run(historicalDate, "Prior month groceries", -40_000 - monthsAgo * 5_000, 100_000, categoryIds[0], `historical-${monthsAgo}`);
    }
    const insertRule = database.prepare("INSERT INTO recurring_rules (profile_id,account_id,description,amount_cents,category_id,cadence,day_of_month,start_date) VALUES (1,1,?,?,?,'monthly',?,?)");
    insertRule.run("Rent", -150_000, category("Housing"), Number(date(1).slice(-2)), date(1));
    insertRule.run("Paycheck", 300_000, category("Income"), Number(date(4).slice(-2)), date(4));
    const insertGoal = database.prepare("INSERT INTO goals (profile_id,name,type,target_cents,category_id) VALUES (1,?,?,?,?)");
    insertGoal.run("Everyday cash reserve", "balance_floor", 50_000, null);
    insertGoal.run("Emergency fund", "balance_floor", 250_000, null);
    insertGoal.run("Dining this month", "reduce_spend", 30_000, categoryIds[1]);
    database.prepare("INSERT INTO budgets (category_id,amount_cents,profile_id) VALUES (?,10000,1), (?,20000,1)").run(categoryIds[0], categoryIds[2]);
    await use(database);
    database.close();
  },
});

test("Plan preserves red deficits and updates the scenario immediately", async ({ page, database }) => {
  expect(database.isOpen).toBe(true);
  await page.reload();
  const amount = page.getByTestId("safe-to-spend");
  await expect(amount).toHaveText("-$500.00");
  const errorColor = await page.evaluate(() => {
    const sample = document.createElement("span");
    sample.style.color = "hsl(var(--error))";
    document.body.append(sample);
    const color = getComputedStyle(sample).color;
    sample.remove();
    return color;
  });
  await expect(amount).toHaveCSS("color", errorColor);
  await page.getByRole("slider", { name: /Keep in reserve/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(amount).toHaveText("-$550.00");
  await expect(page.getByText("Short of your cash cushion", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(amount).toHaveText("-$500.00");
  await page.getByText("Manage scheduled bills & income", { exact: true }).click();
  await expect(page.locator(".plan-rules")).toHaveAttribute("open", "");
});

test("Transactions supports activity, table, search and editing", async ({ page, database }) => {
  expect(database.isOpen).toBe(true);
  await page.goto("/transactions");
  await expect(page.locator(".activity-row")).not.toHaveCount(0);
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("textbox", { name: "Search transactions" }).fill("Green Market");
  await expect(page.locator(".activity-row")).toHaveCount(3);
  await page.getByRole("checkbox", { name: "Select all", exact: true }).check();
  await expect(page.getByRole("button", { name: "Recategorize", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Green Market Groceries", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("Goals opens with progress and supports focused editing", async ({ page, database }) => {
  expect(database.isOpen).toBe(true);
  await page.goto("/goals");
  await expect(page.locator(".goal-item")).toHaveCount(3);
  await expect(page.getByRole("textbox", { name: "Goal name" })).toBeHidden();
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  await expect(page.locator(".goal-item")).toHaveCount(1);
  await page.getByRole("button", { name: "Edit Emergency fund", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Goal name" })).toHaveValue("Emergency fund");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "New goal", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Goal name" })).toHaveValue("Save each month");
});

test("category management preserves IDs and safely reassigns references", async ({ page, database }) => {
  const createCategory = database.prepare("INSERT INTO categories (name,color,icon,is_system,profile_id) VALUES (?,'#14b8a6','tag',0,1)");
  const travelId = Number(createCategory.run("Travel").lastInsertRowid);
  const workId = Number(createCategory.run("Work").lastInsertRowid);
  const childId = Number(createCategory.run("Flights").lastInsertRowid);
  database.prepare("UPDATE categories SET parent_id=? WHERE id=?").run(travelId, childId);
  database.prepare("UPDATE transactions SET category_id=? WHERE id=1").run(travelId);
  database.prepare("UPDATE goals SET category_id=? WHERE id=3").run(travelId);
  database.prepare("UPDATE recurring_rules SET category_id=? WHERE id=1").run(travelId);
  const budgetId = Number(database.prepare("INSERT INTO budgets (category_id,amount_cents,profile_id) VALUES (?,10000,1)").run(travelId).lastInsertRowid);
  const ruleId = Number(database.prepare("INSERT INTO categorization_rules (pattern,category_id,profile_id) VALUES ('TEST TRAVEL',?,1)").run(travelId).lastInsertRowid);
  await page.goto("/transactions");
  await page.getByLabel("Transaction tools", { exact: true }).click();
  await page.getByRole("button", { name: "Categories", exact: true }).click();
  await page.getByRole("button", { name: "Edit Travel", exact: true }).click();
  await page.getByRole("textbox", { name: "Category name", exact: true }).fill("Trips");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit Trips", exact: true })).toBeVisible();
  expect(database.prepare("SELECT id FROM categories WHERE name='Trips'").get()?.id).toBe(travelId);
  await page.getByRole("button", { name: "Move Trips down", exact: true }).click();
  await expect.poll(() => database.prepare("SELECT id FROM categories WHERE is_system=0 ORDER BY sort_order,name").all().map((category) => category.id)).toEqual([childId, workId, travelId]);
  await page.getByRole("button", { name: "Remove Trips", exact: true }).click();
  await page.getByRole("combobox", { name: "Replacement category", exact: true }).selectOption(String(workId));
  const conflictId = Number(database.prepare("INSERT INTO budgets (category_id,amount_cents,profile_id) VALUES (?,20000,1)").run(workId).lastInsertRowid);
  await page.getByRole("button", { name: "Remove category", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Both categories have budgets");
  expect(database.prepare("SELECT category_id FROM transactions WHERE id=1").get()?.category_id).toBe(travelId);
  database.prepare("DELETE FROM budgets WHERE id=?").run(conflictId);
  database.exec(`CREATE TRIGGER fail_category_reassignment BEFORE UPDATE OF category_id ON goals WHEN OLD.category_id=${travelId} BEGIN SELECT RAISE(ABORT, 'Test rollback'); END`);
  await page.getByRole("button", { name: "Remove category", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Test rollback");
  expect(database.prepare("SELECT category_id FROM transactions WHERE id=1").get()?.category_id).toBe(travelId);
  expect(database.prepare("SELECT category_id FROM budgets WHERE id=?").get(budgetId)?.category_id).toBe(travelId);
  expect(database.prepare("SELECT id FROM categories WHERE id=?").get(travelId)?.id).toBe(travelId);
  database.exec("DROP TRIGGER fail_category_reassignment");
  await page.getByRole("button", { name: "Remove category", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Categories", exact: true })).toBeVisible();
  for (const [table, id] of [["transactions", 1], ["goals", 3], ["recurring_rules", 1], ["budgets", budgetId], ["categorization_rules", ruleId]] as const) {
    expect(database.prepare(`SELECT category_id FROM ${table} WHERE id=?`).get(id)?.category_id).toBe(workId);
  }
  expect(database.prepare("SELECT id FROM categories WHERE id=?").get(travelId)).toBeUndefined();
  expect(database.prepare("SELECT parent_id FROM categories WHERE id=?").get(childId)?.parent_id).toBeNull();
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  await page.getByRole("button", { name: "Close categories", exact: true }).click();
  await expect(page.locator(".activity-row").filter({ hasText: "Work" })).toHaveCount(1);
});

test("Budgets compares weekly spending to a weekly limit and keeps editing available", async ({ page, database }) => {
  const categoryId = Number(database.prepare("INSERT INTO categories (name,color,icon,is_system,profile_id) VALUES ('Weekend travel','#14b8a6','tag',0,1)").run().lastInsertRowid);
  const weeklyId = Number(database.prepare("INSERT INTO budgets (category_id,amount_cents,profile_id,period) VALUES (?,10000,1,'weekly')").run(categoryId).lastInsertRowid);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const priorWeek = new Date(now);
  priorWeek.setDate(priorWeek.getDate() - 7);
  const older = `${priorWeek.getFullYear()}-${String(priorWeek.getMonth() + 1).padStart(2, "0")}-${String(priorWeek.getDate()).padStart(2, "0")}`;
  const insert = database.prepare("INSERT INTO transactions (account_id,profile_id,date,description,amount_cents,category_id,import_hash) VALUES (1,1,?,'Weekend travel',?,?,?)");
  insert.run(today, -2500, categoryId, "weekly-current");
  insert.run(older, -15000, categoryId, "weekly-previous");
  await page.goto("/budgets");
  await expect(page.getByRole("spinbutton", { name: "Budget amount", exact: true })).toBeHidden();
  const weekly = page.locator(`[data-budget-id="${weeklyId}"]`);
  await expect(weekly).toContainText("$25.00");
  await expect(weekly).not.toContainText("$175.00");
  await expect(weekly).toContainText("Week of");
  await page.getByRole("button", { name: "Edit Weekend travel budget", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Budget amount", exact: true })).toHaveValue("100");
  await page.getByRole("spinbutton", { name: "Budget amount", exact: true }).fill("125");
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await expect(weekly).toContainText("$125.00");
  await page.getByRole("button", { name: "Over limit", exact: true }).click();
  await expect(weekly).toBeHidden();
});

test("Reports uses exact selected dates and opens expense details", async ({ page, database }) => {
  expect(database.isOpen).toBe(true);
  await page.goto("/reports");
  await expect(page.locator(".report-summary")).toContainText("$459.00");
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await page.getByLabel("Report start date", { exact: true }).fill(today);
  await page.getByLabel("Report end date", { exact: true }).fill(today);
  const expected = Number(database.prepare("SELECT SUM(-amount_cents) AS total FROM transactions WHERE date=?").get(today)?.total ?? 0);
  await expect(page.locator(".report-summary")).toContainText((expected / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }));
  await page.getByRole("button", { name: /Green Market Groceries/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`workspace layouts at ${viewport.width}px`, async ({ page, database }, testInfo) => {
    expect(database.isOpen).toBe(true);
    await page.setViewportSize(viewport);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      for (const route of ["plan", "transactions", "goals", "budgets", "reports"]) {
        await page.goto(`/${route}`);
        await expect(page.locator(".workspace-page")).toBeVisible();
        if (route === "plan") {
          await expect(page.locator(".plan-rules")).toHaveCSS("opacity", "1");
          await expect(page.locator(".recharts-area-curve").first()).toBeVisible();
        }
        if (route === "goals") await expect(page.locator(".goal-item")).toHaveCount(3);
        if (route === "transactions") await expect(page.locator(".activity-row")).not.toHaveCount(0);
        if (route === "budgets") await expect(page.locator(".budget-item")).toHaveCount(2);
        if (route === "reports") await expect(page.locator(".report-summary")).toBeVisible();
        await expect(page.getByText("Something went wrong displaying this page")).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${route}-${theme}-${viewport.width}.png`), fullPage: true });
      }
    }
  });
}