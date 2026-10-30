import { test as base, expect } from "@playwright/test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";

const test = base.extend<{ database: DatabaseSync; today: Date | undefined }>({
  // Seeds dates from this day and, when set, pins the browser's Date to it too (timers keep running).
  today: [undefined, { option: true }],
  database: async ({ page, today }, use) => {
    if (today) await page.clock.setFixedTime(today);
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
      if (command === "import_transactions_batch") {
        // Mirrors insert_import_batch_tx: UNIQUE violations are duplicates, anything else an error.
        const duplicateIndices: number[] = [];
        const errors: { index: number; message: string }[] = [];
        database.exec("BEGIN");
        (args.statements ?? []).forEach((statement, index) => {
          try { database.prepare(statement.sql).run(...(statement.params ?? [])); }
          catch (error) {
            const message = String((error as Error).message);
            if (message.includes("UNIQUE constraint failed")) duplicateIndices.push(index);
            else errors.push({ index, message });
          }
        });
        database.exec("COMMIT");
        return { duplicateIndices, errors };
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
      localStorage.setItem("compass_milestones_seen_1", JSON.stringify(["goal_complete_1", "goal_complete_2", "goal_complete_3", "networth_positive", "networth_100000"]));
      localStorage.setItem("compass_transfer_disclaimer_dismissed", "1");
      localStorage.setItem("compass_plan_window", "nextMonth");
      localStorage.setItem("sidebarOpen", "false");
    });
    await page.goto("/plan");
    await expect(page.getByText("No checking account yet", { exact: true })).toBeVisible();
    const date = (offset: number) => {
      const value = new Date(today ?? Date.now());
      value.setDate(value.getDate() + offset);
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    };
    database.prepare("UPDATE profiles SET name='Preview profile' WHERE id=1").run();
    database.prepare("INSERT INTO accounts (id,name,account_type,profile_id) VALUES (1,'Everyday checking','checking',1)").run();
    const category = (name: string) => Number(database.prepare("SELECT id FROM categories WHERE name=? LIMIT 1").get(name)?.id ?? 15);
    const categoryIds = ["Groceries", "Food & Dining", "Transportation", "Shopping"].map(category);
    const insertTransaction = database.prepare("INSERT INTO transactions (account_id,profile_id,date,description,amount_cents,balance_cents,category_id,import_hash) VALUES (1,1,?,?,?,?,?,?)");
    // Recent activity spans up to three days back but never before the 1st, so month-scoped views
    // (Reports' $459.00, Transactions' three Green Market rows) hold all 12 rows on the 1st-3rd too.
    const daysIntoMonth = Number(date(0).slice(-2)) - 1;
    for (let index = 0; index < 12; index++) {
      insertTransaction.run(date(-Math.min(Math.floor(index / 3), daysIntoMonth)), ["Green Market Groceries", "Neighborhood Coffee", "City Transit", "Bookshop & Stationery"][index % 4], -[8450, 650, 2400, 3800][index % 4], 100_000, categoryIds[index % 4], `preview-${index}`);
    }
    // Plan projects this as a detected monthly charge on the day it was last seen. Tie that day to
    // today so its next occurrence is always 11-14 days out, after the payday below: a fixed day
    // such as the 1st falls before payday near every month end and moves the Plan low point.
    // Capped at 28 so every month has the day.
    const groceryDay = String(Math.min(Number(date(14).slice(-2)), 28)).padStart(2, "0");
    for (const monthsAgo of [1, 2]) {
      const historical = new Date(today ?? Date.now());
      historical.setDate(1);
      historical.setMonth(historical.getMonth() - monthsAgo);
      const historicalDate = `${historical.getFullYear()}-${String(historical.getMonth() + 1).padStart(2, "0")}-${groceryDay}`;
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

// The Plan forecast runs from the browser's today, so these figures need a fixed one: a mid-month
// noon puts Rent (day+1) and Paycheck (day+4) before the 1st-of-month grocery estimate, away from
// month ends and DST changes. Real-date runs fail whenever the 1st falls before payday.
const planTest = test.extend({ today: new Date(2026, 5, 15, 12) });

planTest("Plan preserves red deficits and updates the scenario immediately", async ({ page, database }) => {
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

planTest("Plan purchase preview is inspectable and never writes transactions", async ({ page, database }, testInfo) => {
  const before = database.prepare('SELECT COUNT(*) AS total FROM transactions').get()?.total;
  await page.reload();
  await page.getByLabel('Hypothetical purchase amount').fill('250.01');
  const today = await page.evaluate(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  });
  await page.getByLabel('Hypothetical purchase date').fill(today);
  await expect(page.getByTestId('safe-to-spend')).toHaveText('-$750.01');
  await expect(page.locator('.horizon-inspector')).toContainText('Hypothetical, not recorded');
  await expect(page.locator('.horizon-inspector')).toContainText('-$250.01');
  await expect(page.locator('aside a[title="Insights"] span')).toBeVisible();
  await expect(page.locator('.plan-rules').getByTitle('Edit', { exact: true })).toHaveCount(2);
  await page.evaluate(() => {
    const host = window as unknown as { previewQueries: number; __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> } };
    host.previewQueries = 0;
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = (command, args) => { if (command.startsWith('db_')) host.previewQueries++; return original(command, args); };
  });
  const responseMs = await page.getByLabel('Hypothetical purchase amount').evaluate(async (input: HTMLInputElement) => {
    const start = performance.now();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '300.01');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return performance.now() - start;
  });
  await expect(page.getByTestId('safe-to-spend')).toHaveText('-$800.01');
  await testInfo.attach('scenario-response-ms', { body: String(responseMs), contentType: 'text/plain' });
  expect(responseMs).toBeLessThan(250);
  await page.getByLabel('Hypothetical purchase amount').fill('250.01');
  await page.getByRole('slider', { name: 'Inspect forecast date' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.horizon-inspector')).toContainText('Rent');
  expect(await page.evaluate(() => (window as unknown as { previewQueries: number }).previewQueries)).toBe(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('.cash-horizon').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`horizon-preview-${width}.png`) });
  }
  await page.reload();
  await expect(page.getByLabel('Hypothetical purchase amount')).toHaveValue('250.01');
  expect(database.prepare('SELECT COUNT(*) AS total FROM transactions').get()?.total).toBe(before);
});

planTest("Plan marks missing balances and respects playback motion preferences", async ({ page, database }) => {
  database.prepare("INSERT INTO accounts (name,account_type,profile_id) VALUES ('Unrecorded checking','checking',1)").run();
  await page.reload();
  await expect(page.getByTestId('safe-to-spend')).toHaveText('Unavailable');
  await page.getByText('Source balances', { exact: true }).click();
  await expect(page.getByText('No recorded balance', { exact: true })).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Play forecast', exact: true }).click();
  await expect.poll(() => page.getByRole('slider', { name: 'Inspect forecast date' }).inputValue()).not.toBe('0');
  await page.getByRole('button', { name: 'Pause forecast', exact: true }).click();
  await page.getByRole('button', { name: 'Reset forecast playback' }).click();
  await expect(page.getByRole('slider', { name: 'Inspect forecast date' })).toHaveValue('0');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('button', { name: 'Play forecast', exact: true })).toHaveCount(0);
  await page.getByRole('slider', { name: 'Inspect forecast date' }).focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('slider', { name: 'Inspect forecast date' })).not.toHaveValue('0');
});

test("Plan keeps profile scenarios separate while an old load is pending", async ({ page, database }) => {
  database.prepare("INSERT INTO profiles(id,name,avatar_color) VALUES (2,'Second profile','#0284c7')").run();
  database.prepare("INSERT INTO accounts(id,name,account_type,profile_id) VALUES (2,'Second checking','checking',2)").run();
  database.prepare("INSERT INTO transactions(account_id,profile_id,date,description,amount_cents,balance_cents,import_hash) VALUES (2,2,date('now'),'Second balance',0,200000,'second-balance')").run();
  await page.reload();
  await page.getByRole('button', { name: /Preview profile/ }).click();
  await page.getByLabel('Hypothetical purchase amount').fill('125');
  await page.getByTitle('Transactions', { exact: true }).click();
  await page.evaluate(() => {
    const host = window as unknown as { releaseForecast?: () => void; __TAURI_INTERNALS__: { invoke: (command: string, args: { sql?: string; params?: unknown[] }) => Promise<unknown> } };
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await original(command, args);
      if (args?.sql?.includes("a.account_type='checking' AND a.excluded_from_insights=0") && args.params?.[0] === 1) await new Promise<void>((resolve) => { host.releaseForecast = resolve; });
      return result;
    };
  });
  await page.getByTitle('Plan', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseForecast?: () => void }).releaseForecast)).toBe('function');
  await page.evaluate(async (profile) => {
    const path = '/src/stores/profileStore.ts';
    const store = await import(path);
    store.useProfileStore.getState().setActiveProfile(profile);
  }, database.prepare('SELECT * FROM profiles WHERE id=2').get());
  await expect(page.getByLabel('Hypothetical purchase amount')).toHaveValue('');
  await expect(page.getByTestId('safe-to-spend')).toHaveText('$2,000.00');
  await page.evaluate(() => (window as unknown as { releaseForecast: () => void }).releaseForecast());
  await expect(page.getByTestId('safe-to-spend')).toHaveText('$2,000.00');
  await page.getByLabel('Hypothetical purchase amount').fill('50');
  const amounts = await page.evaluate(() => [1, 2].map((profile) => JSON.parse(localStorage.getItem(`compass_plan_scenario_${profile}`)!).purchase.amountCents));
  expect(amounts).toEqual([12500, 5000]);
});

test("Settings restores theme preference and recovers from account-check failure", async ({ page, database }) => {
  expect(database.isOpen).toBe(true);
  await page.goto('/settings');
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await page.reload();
  await expect(page.getByLabel('Theme', { exact: true })).toHaveValue('dark');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByText('Account diagnostics', { exact: true }).click();
  await page.evaluate(() => {
    const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: { sql?: string }) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = bridge.invoke;
    let fail = true;
    bridge.invoke = (command, args) => {
      if (fail && args?.sql?.includes('manual_txn_count')) { fail = false; return Promise.reject(new Error('Test failure')); }
      return original(command, args);
    };
  });
  await page.getByRole('button', { name: 'Check My Accounts' }).click();
  await expect(page.getByRole('alert')).toContainText('Account check failed');
  await expect(page.getByRole('button', { name: 'Check My Accounts' })).toBeEnabled();
  await page.getByRole('button', { name: 'Check My Accounts' }).click();
  await expect(page.getByText('No accounts match the risk pattern.')).toBeVisible();
});

test("Transactions restores private view context and still changes month", async ({ page, database }) => {
  expect(database.isOpen).toBe(true);
  await page.goto('/transactions');
  await page.getByLabel('Search transactions').fill('Green Market');
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByTitle('Plan', { exact: true }).click();
  await page.getByTitle('Transactions', { exact: true }).click();
  await expect(page.getByLabel('Search transactions')).toHaveValue('Green Market');
  await expect(page.getByRole('table')).toBeVisible();
  const before = await page.locator('input[type="month"]').inputValue();
  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(page.locator('input[type="month"]')).not.toHaveValue(before);
  expect(page.url()).not.toContain('Green');
});

test("Insights leads with full-width financial context above review", async ({ page, database }, testInfo) => {
  expect(database.isOpen).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/agent');
  await expect(page.getByRole('region', { name: 'Financial context and scores', exact: true })).toBeVisible();
  await expect(page.locator('.insights-context-content')).toBeVisible();
  // The scheduled Rent rule (due tomorrow) drives a review row on any date, with its figure.
  await expect(page.getByRole('region', { name: 'Items to review' })).toContainText('Rent');
  await expect(page.getByRole('region', { name: 'Items to review' })).toContainText('$1,500');
  for (const width of [390, 2560]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => {
      const workspace = document.querySelector('.insights-workspace')!;
      const context = document.querySelector('.insights-context')!.getBoundingClientRect();
      const review = document.querySelector('.insights-review')!.getBoundingClientRect();
      const style = getComputedStyle(workspace);
      const available = workspace.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return Math.abs(context.width - available) <= 1 && review.top >= context.bottom && Math.abs(review.width - context.width) <= 1;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`insights-context-first-${width}.png`) });
  }
});

// #108: on a wide window these sections used to stop at a fixed cap and leave the right empty.
test("wide sections span their column on a wide window", async ({ page, database }) => {
  // A fortnightly payroll in the past drives the Watch (detected cycle) and Fixed and flexible
  // (complete months with income); the base fixture has neither.
  const deposit = database.prepare("INSERT INTO transactions (account_id,profile_id,date,description,amount_cents,balance_cents,category_id,import_hash) VALUES (1,1,date('now','localtime',?),'Payroll deposit',300000,100000,(SELECT id FROM categories WHERE name='Income'),?)");
  for (const days of [1, 15, 29, 43]) deposit.run(`-${days} days`, `payroll-${days}`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 2560, height: 1000 });
  for (const [route, selector] of [['/overview', '.overview-roster table'], ['/', '.bearing, .pay-watch'], ['/agent', '.fixed-flex, .cost-of-money']]) {
    await page.goto(route);
    for (const part of selector.split(', ')) await expect(page.locator(part).first()).toBeVisible();
    await expect.poll(() => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((element) => {
      const parent = element.parentElement!;
      const style = getComputedStyle(parent);
      const available = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return Math.abs(element.getBoundingClientRect().width - available) > 1;
    }).map((element) => element.className), selector), { message: route }).toEqual([]);
  }
});

test("Insights retains available sections with limited history", async ({ page, database }) => {
  database.exec("DELETE FROM transactions WHERE date < date('now','start of month')");
  await page.goto('/agent');
  await expect(page.getByRole('status').filter({ hasText: 'Limited history' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Items to review' })).toBeVisible();
  await expect(page.getByText('Not enough data yet', { exact: true })).toHaveCount(0);
});

test("login particles render, move, resize and stop for reduced motion", async ({ page, database }, testInfo) => {
  database.prepare("INSERT INTO profiles(name,avatar_color) VALUES ('Second profile','#0284c7')").run();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  const pixels = () => canvas.evaluate((element: HTMLCanvasElement) => {
    const data = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let count = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index] > 0) count++;
    return count;
  });
  await expect.poll(pixels).toBeGreaterThan(100);
  const before = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await page.mouse.move(1100, 300);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).not.toBe(before);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(pixels).toBeGreaterThan(100);
    await page.screenshot({ path: testInfo.outputPath(`particles-${width}.png`) });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(pixels).toBe(0);
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
  await page.getByRole("button", { name: "All budgets", exact: true }).click();
  await weekly.getByText('Debits and credits', { exact: true }).click();
  await weekly.getByRole('button', { name: 'View transactions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear date range' })).toBeVisible();
  await expect(page.locator('.activity-row')).toHaveCount(1);
  await expect(page.locator('.activity-row')).toContainText('$25.00');
});

test("Budgets shows negative net usage without rolling over net credits", async ({ page, database }) => {
  const categoryId = Number(database.prepare("SELECT id FROM categories WHERE name='Gambling'").get()?.id);
  const budgetId = Number(database.prepare("INSERT INTO budgets (category_id,amount_cents,profile_id,rollover,start_date) VALUES (?,20000,1,1,date('now','start of month'))").run(categoryId).lastInsertRowid);
  database.prepare("INSERT INTO transactions (account_id,profile_id,date,description,amount_cents,category_id,import_hash) VALUES (1,1,date('now'),'Debit',-10000,?,'net-debit'),(1,1,date('now'),'Credit',15000,?,'net-credit')").run(categoryId, categoryId);
  await page.goto('/budgets');
  const budget = page.locator(`[data-budget-id="${budgetId}"]`);
  await expect(budget).toContainText('-$50.00');
  await expect(budget).toContainText('$250.00 remaining');
  await budget.getByText('Debits and credits', { exact: true }).click();
  await expect(budget).toContainText('Next carry: $200.00');
  await expect(budget).toContainText('Credits exceed debits');
  await expect(budget).not.toContainText('Daily allowance');
});

test("Trends ranks range spending by category and keeps profiles apart", async ({ page, database }) => {
  // The fixture's spending: Groceries $253.50 recent + $450 and $500 in the two prior months,
  // Shopping $114, Transportation $72, Food & Dining $19.50; all inside the 3-month range.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  database.prepare("INSERT INTO profiles(id,name,avatar_color) VALUES (2,'Second profile','#0284c7')").run();
  database.prepare("INSERT INTO accounts (id,name,account_type,profile_id) VALUES (2,'Second checking','checking',2)").run();
  database.prepare("INSERT INTO transactions (account_id,profile_id,date,description,amount_cents,category_id,import_hash) VALUES (2,2,?,'Second profile shopping',-99900,(SELECT id FROM categories WHERE name='Shopping' LIMIT 1),'second-profile')").run(today);
  await page.goto("/trends");
  await page.getByRole("button", { name: /Preview profile/ }).click();
  const section = page.locator(".trend-section").filter({ hasText: "Where it went" });
  const rows = section.locator(".ranked-bars > button");
  await expect(page.locator(".trend-legend")).toContainText("Expenses $1,409.00");
  await expect(rows.locator("span.truncate")).toHaveText(["Groceries", "Shopping", "Transportation", "Food & Dining"]);
  await expect(section.getByRole("img", { name: "Groceries: $1,203.50, 85% of spending over 6 months" })).toBeVisible();
  await expect(section.getByRole("img", { name: "Food & Dining: $19.50, 1% of spending over 6 months" })).toBeVisible();

  await rows.filter({ hasText: "Shopping" }).click();
  await expect(rows.filter({ hasText: "Shopping" })).toHaveAttribute("aria-pressed", "true");
  await expect(section.getByText("Shopping trend")).toBeVisible();
  await expect(section.getByRole("link", { name: "View all" })).toBeVisible();

  await page.getByRole("group", { name: "Range" }).getByRole("button", { name: "3mo" }).click();
  await expect(section.getByRole("img", { name: "Groceries: $1,203.50, 85% of spending over 3 months" })).toBeVisible();

  await page.getByRole("switch").click();
  await expect(page.locator(".trend-legend")).toContainText("Expenses $2,408.00");
  await expect(rows.locator("span.truncate")).toHaveText(["Groceries", "Shopping", "Transportation", "Food & Dining"]);
  await expect(section.getByRole("img", { name: "Shopping: $1,113.00, 46% of spending over 3 months" })).toBeVisible();
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

test("credit card import keeps payments from a separate Credit column", async ({ page, database }) => {
  // Synthetic statement: purchases in Debit, the card payment only in Credit.
  const csv = "Date,Description,Debit,Credit\n2026-10-02,Synthetic Grocer,120.00,\n2026-10-05,Synthetic Fuel,80.00,\n2026-10-10,PAYMENT THANK YOU,,150.00\n";
  await page.goto("/import");
  await page.getByRole("button", { name: /Credit Card Statement/ }).click();
  await page.locator("#csv-input").setInputFiles({ name: "synthetic-card.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByPlaceholder("e.g. Chase Sapphire").fill("Synthetic Card");
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue to Preview" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: /^Import \d+ Transactions$/ }).click();
  await expect(page.getByText("Import complete")).toBeVisible();
  const rows = database.prepare(
    "SELECT t.description, t.amount_cents FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.account_type='credit' ORDER BY t.date"
  ).all();
  expect(rows).toEqual([
    { description: "Synthetic Grocer", amount_cents: -12000 },
    { description: "Synthetic Fuel", amount_cents: -8000 },
    { description: "PAYMENT THANK YOU", amount_cents: 15000 },
  ]);
});

const cardRows = (database: DatabaseSync) => database.prepare(
  "SELECT t.description, t.amount_cents, t.category_id, t.balance_cents FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.account_type='credit' ORDER BY t.date"
).all();
// A column profile saved by an older import: only Debit mapped as one amount column, signs flipped by hand.
const saveSingleColumnCardProfile = (database: DatabaseSync) => database.prepare(
  "INSERT INTO column_profiles (header_sig,date_col,desc_col,amount_col,type_col,balance_col,profile_id,invert_amounts,debit_col,credit_col) VALUES ('credit|date|debit|description',0,1,2,-1,-1,1,1,-1,-1)"
).run();

test("zero-filled Credit-before-Debit card import keeps the payment as a transfer", async ({ page, database }) => {
  const csv = "Date,Description,Credit,Debit\n2026-10-02,Synthetic Grocer,0.00,120.00\n2026-10-05,Synthetic Fuel,0.00,80.00\n2026-10-10,PAYMENT THANK YOU,150.00,0.00\n";
  await page.goto("/import");
  await page.getByRole("button", { name: /Credit Card Statement/ }).click();
  await page.locator("#csv-input").setInputFiles({ name: "synthetic-card.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByPlaceholder("e.g. Chase Sapphire").fill("Synthetic Card");
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue to Preview" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: /^Import \d+ Transactions$/ }).click();
  await expect(page.getByText("Import complete")).toBeVisible();
  await expect(page.getByText(/1 of those\s+was recognized as a transfer/)).toBeVisible();
  expect(cardRows(database)).toEqual([
    { description: "Synthetic Grocer", amount_cents: -12000, category_id: expect.anything(), balance_cents: -12000 },
    { description: "Synthetic Fuel", amount_cents: -8000, category_id: expect.anything(), balance_cents: -20000 },
    { description: "PAYMENT THANK YOU", amount_cents: 15000, category_id: 20, balance_cents: -5000 },
  ]);
});

test("single signed Amount card import is unchanged and shows no Debit/Credit warning", async ({ page, database }) => {
  const csv = "Date,Description,Amount\n2026-10-02,Synthetic Grocer,-120.00\n2026-10-10,PAYMENT THANK YOU,150.00\n";
  await page.goto("/import");
  await page.getByRole("button", { name: /Credit Card Statement/ }).click();
  await page.locator("#csv-input").setInputFiles({ name: "synthetic-signed.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByPlaceholder("e.g. Chase Sapphire").fill("Synthetic Card");
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue to Preview" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: /^Import \d+ Transactions$/ }).click();
  await expect(page.getByText("Import complete")).toBeVisible();
  expect(cardRows(database).map(({ description, amount_cents }) => ({ description, amount_cents }))).toEqual([
    { description: "Synthetic Grocer", amount_cents: -12000 },
    { description: "PAYMENT THANK YOU", amount_cents: 15000 },
  ]);
});

test("saved single-column card mapping warns, then reimport adds only the missing payments", async ({ page, database }) => {
  saveSingleColumnCardProfile(database);
  // Payment leaves Debit blank; refund zero-fills it. Both live only in Credit.
  const csv = "Date,Description,Debit,Credit\n2026-10-02,Synthetic Grocer,120.00,\n2026-10-10,PAYMENT THANK YOU,,100.00\n2026-10-12,Synthetic Refund,0.00,5.00\n";
  const importCard = async (readBoth: boolean, existingAccount = true) => {
    await page.goto("/import");
    await page.getByRole("button", { name: /Credit Card Statement/ }).click();
    await page.locator("#csv-input").setInputFiles({ name: "synthetic-card.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    if (existingAccount) await page.getByRole("button", { name: "Existing account", exact: true }).click();
    else await page.getByPlaceholder("e.g. Chase Sapphire").fill("Synthetic Card");
    for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Continue to Preview" }).click();
    if (readBoth) {
      await expect(page.getByRole("alert")).toContainText('2 rows have an amount only in the "Credit" column');
      await page.getByRole("button", { name: "Read both Debit and Credit columns" }).click();
    }
    await page.getByRole("button", { name: /^Import \d+ Transactions$/ }).click();
  };

  // 1st import keeps the stale mapping (warning ignored): only the purchase lands.
  await importCard(false, false);
  await expect(page.getByText("Import complete")).toBeVisible();
  expect(cardRows(database).map((r) => r.description)).toEqual(["Synthetic Grocer"]);

  // 2nd import reads both columns: purchase is a duplicate, the two Credit rows are added once.
  await importCard(true);
  await expect(page.getByText(/2 transactions\s+imported, 1 duplicates skipped/)).toBeVisible();
  expect(cardRows(database)).toEqual([
    { description: "Synthetic Grocer", amount_cents: -12000, category_id: expect.anything(), balance_cents: -12000 },
    { description: "PAYMENT THANK YOU", amount_cents: 10000, category_id: 20, balance_cents: -2000 },
    { description: "Synthetic Refund", amount_cents: 500, category_id: expect.anything(), balance_cents: -1500 },
  ]);
  expect(database.prepare("SELECT debit_col, credit_col FROM column_profiles WHERE header_sig='credit|date|debit|description'").get())
    .toEqual({ debit_col: 2, credit_col: 3 });

  // 3rd import: nothing new, no warning (the saved profile now reads both columns).
  await importCard(false);
  await expect(page.getByText("Already imported")).toBeVisible();
  expect(cardRows(database)).toHaveLength(3);
});

test("Auto-Import All pauses on a later file whose payments the first file's mapping would drop", async ({ page, database }) => {
  saveSingleColumnCardProfile(database);
  const file = (name: string, body: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(`Date,Description,Debit,Credit\n${body}`) });
  await page.goto("/import");
  await page.getByRole("button", { name: /Credit Card Statement/ }).click();
  await page.locator("#csv-input").setInputFiles([
    file("synthetic-sep.csv", "2026-09-02,Synthetic Grocer,120.00,\n"),
    file("synthetic-oct.csv", "2026-10-05,Synthetic Fuel,80.00,\n2026-10-10,PAYMENT THANK YOU,,150.00\n"),
  ]);
  await page.getByPlaceholder("e.g. Chase Sapphire").fill("Synthetic Card");
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue to Preview" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Auto-Import All (2 Files)" }).click();

  // File 2 is handed back to the wizard instead of being imported silently without its payment.
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText('1 row has an amount only in the "Credit" column');
  expect(cardRows(database).map((r) => r.description)).toEqual(["Synthetic Grocer"]);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue to Preview" }).click();
  await page.getByRole("button", { name: "Read both Debit and Credit columns" }).click();
  await page.getByRole("button", { name: /^Import \d+ Transactions$/ }).click();
  await expect(page.getByText("Import complete")).toBeVisible();
  expect(cardRows(database).map(({ description, amount_cents }) => ({ description, amount_cents }))).toEqual([
    { description: "Synthetic Grocer", amount_cents: -12000 },
    { description: "Synthetic Fuel", amount_cents: -8000 },
    { description: "PAYMENT THANK YOU", amount_cents: 15000 },
  ]);
  expect(database.prepare("SELECT COUNT(*) AS n FROM accounts WHERE account_type='credit'").get()).toEqual({ n: 1 });
  expect(database.prepare("SELECT COUNT(*) AS n FROM import_sessions").get()).toEqual({ n: 2 });
});

// A minimal text-only PDF (Helvetica, one Tm per item) so the import runs real pdf.js extraction.
// Every name, date and amount below is invented; only the layout mirrors real card statements.
function syntheticPdf(pages: [number, number, string][][]): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: string[] = [];
  for (const items of pages) {
    const stream = items.map(([x, y, s]) => `BT /F1 8 Tf 1 0 0 1 ${x} ${y} Tm (${s.replace(/[\\()]/g, "\\$&")}) Tj ET`).join("\n");
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length} 0 R >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => { const at = Buffer.byteLength(pdf); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

// Trans./Post date columns, amounts ~1pt off the description baseline, a detached "-" sign, a
// wrapped merchant name, year-less dates across New Year, and a summary that must not import.
const cardStatementPdf = (rows = true) => syntheticPdf([[
  [34, 700, "Billing Period: 12/06/25-01/05/26"],
  [317, 660, "Previous balance"], [553, 660, rows ? "$1,000.00" : "$0.00"],
  [317, 646, "Payments"], [549, 646, "-"], [553, 646, rows ? "$500.00" : "$0.00"],
  [317, 632, "Purchases"], [548, 632, rows ? "+$145.20" : "+$0.00"],
  [317, 618, "New balance"], [553, 618, rows ? "$645.20" : "$0.00"],
  [34, 600, "Minimum payment due: $41.00"],
  [37, 560, "Trans."], [100, 560, "Post"],
  [37, 550, "date"], [100, 550, "date"], [163, 550, "Description"], [548, 550, "Amount"],
  ...(rows ? [
    [37, 530, "12/28"], [100, 530, "12/29"], [163, 530, "SAMPLE GROCERY MARKET"], [551, 528.9, "$120.00"],
    [37, 516, "12/30"], [100, 516, "12/30"], [163, 516, "ONLINE PAYMENT THANK YOU"], [549, 514.8, "-"], [553, 514.8, "$500.00"],
    [37, 502, "01/02"], [100, 502, "01/03"], [163, 502, "EXAMPLE COFFEE ROASTERS"], [551, 500.7, "$25.20"],
    [163, 492, "PORTLAND OR"],
  ] as [number, number, string][] : []),
  [41, 450, "Total fees charged in this billing period"], [551, 449, "$0.00"],
]]);

test("credit card PDF statement imports every row with the right sign and year, once", async ({ page, database }) => {
  const importPdf = async (existing: boolean) => {
    await page.goto("/import");
    await page.getByRole("button", { name: /Credit Card Statement/ }).click();
    await page.locator("#csv-input").setInputFiles({ name: "synthetic-statement.pdf", mimeType: "application/pdf", buffer: cardStatementPdf() });
    if (existing) await page.getByRole("button", { name: "Existing account", exact: true }).click();
    else await page.getByPlaceholder("e.g. Chase Sapphire").fill("Synthetic Card");
    for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Continue to Preview" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "Import 3 Transactions" }).click();
  };
  await importPdf(false);
  await expect(page.getByText("Import complete")).toBeVisible();
  const rows = () => database.prepare(
    "SELECT t.date, t.description, t.amount_cents, t.category_id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.account_type='credit' ORDER BY t.date"
  ).all();
  expect(rows()).toEqual([
    { date: "2025-12-28", description: "SAMPLE GROCERY MARKET", amount_cents: -12000, category_id: expect.anything() },
    { date: "2025-12-30", description: "ONLINE PAYMENT THANK YOU", amount_cents: 50000, category_id: 20 },
    { date: "2026-01-02", description: "EXAMPLE COFFEE ROASTERS PORTLAND OR", amount_cents: -2520, category_id: expect.anything() },
  ]);
  await importPdf(true);
  await expect(page.getByText("Already imported")).toBeVisible();
  expect(rows()).toHaveLength(3);
});

test("PDF statement with no activity says so instead of importing nothing or suggesting a loan", async ({ page, database }) => {
  const before = database.prepare("SELECT COUNT(*) AS n FROM transactions").get();
  await page.goto("/import");
  await page.getByRole("button", { name: /Credit Card Statement/ }).click();
  await page.locator("#csv-input").setInputFiles({ name: "synthetic-quiet.pdf", mimeType: "application/pdf", buffer: cardStatementPdf(false) });
  await expect(page.getByText(/That statement has no transactions/)).toBeVisible();
  await expect(page.getByText(/loan statement/)).toHaveCount(0);
  expect(database.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual(before);
});

test("Ledger crypto export imports as an investment holding with transfers, not spending", async ({ page, database }) => {
  // Invented operations: 100.123456 in, 25.000014 out (fee included), a dust receipt, a failed send.
  const csv = [
    "Operation Date,Status,Currency Ticker,Operation Type,Operation Amount,Operation Fees,Operation Hash,Account Name,Account xpub,Countervalue Ticker,Countervalue at Operation Date,Countervalue at CSV Export",
    "2026-09-20T15:00:00.000Z,Confirmed,XRP,OUT,25.000014,0.000014,SYNTHETIC3,Sample Wallet,xpub-sample,USD,50.00,62.50",
    "2026-09-10T15:00:00.000Z,Confirmed,XRP,IN,0.000003,0.00003,SYNTHETIC2,Sample Wallet,xpub-sample,USD,0.00,0.00",
    "2026-09-01T15:00:00.000Z,Confirmed,XRP,IN,100.123456,0.000017,SYNTHETIC1,Sample Wallet,xpub-sample,USD,200.25,250.31",
    "2026-09-21T15:00:00.000Z,Failed,XRP,OUT,5,0.00004,SYNTHETIC4,Sample Wallet,xpub-sample,USD,10.00,12.50",
  ].join("\n");
  const transactionsBefore = database.prepare("SELECT COUNT(*) AS n FROM transactions").get();
  const importLedger = async (replace: boolean) => {
    await page.goto("/import");
    await page.getByRole("button", { name: /Investment \/ Brokerage/ }).click();
    await page.locator("#csv-input").setInputFiles({ name: "synthetic-ledger.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    if (replace) await page.getByRole("button", { name: "Existing account", exact: true }).click();
    else await page.getByPlaceholder("e.g. Fidelity Brokerage").fill("Sample Ledger");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("note")).toContainText("Cost basis is unknown");
    await expect(page.getByRole("note")).toContainText("1 failed or unconfirmed operation was left out");
    await page.getByRole("button", { name: "Import 1 Position + 3 Activity" }).click();
    if (replace) await page.getByRole("button", { name: "Replace that snapshot" }).click();
  };
  await importLedger(false);
  await expect(page.getByText("Import complete")).toBeVisible();
  const holdings = () => database.prepare("SELECT security_type, symbol, shares, cost_basis_cents FROM holdings").all();
  const activity = () => database.prepare("SELECT activity_type, quantity, amount_cents FROM investment_activity ORDER BY trade_date").all();
  expect(holdings()).toEqual([{ security_type: "crypto", symbol: "XRP", shares: 75.123405, cost_basis_cents: null }]);
  expect(activity()).toEqual([
    { activity_type: "transfer", quantity: 100.123456, amount_cents: 20025 },
    { activity_type: "transfer", quantity: 0.000003, amount_cents: 0 },
    { activity_type: "transfer", quantity: -25.000014, amount_cents: -5000 },
  ]);
  // Re-importing the same export replaces the snapshot and skips every known operation.
  await importLedger(true);
  await expect(page.getByText(/Import complete|Already imported/)).toBeVisible();
  expect(holdings()).toHaveLength(1);
  expect(activity()).toHaveLength(3);
  expect(database.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual(transactionsBefore);
});

test("Investments leads with a labeled portfolio summary scoped to the chosen account", async ({ page, database }) => {
  // Invented accounts: a brokerage priced in September with a known cost basis, and a retirement
  // fund last priced in June with none.
  database.prepare("INSERT INTO accounts (id,name,account_type,institution,profile_id) VALUES (10,'Sample Brokerage','investment','Example Securities',1), (11,'Sample Retirement','investment','',1)").run();
  const holding = database.prepare("INSERT INTO holdings (account_id,profile_id,as_of_date,security_type,symbol,description,shares,market_value_cents,cost_basis_cents) VALUES (?,1,?,?,?,?,?,?,?)");
  holding.run(10, "2026-09-30", "stock", "SMPL", "Sample Corp", 10, 100_000, 80_000);
  holding.run(11, "2026-06-30", "mutual_fund", null, "Sample Target Fund", null, 500_000, null);
  const summary = database.prepare("INSERT INTO investment_summaries (account_id,profile_id,period_start,period_end,beginning_value_cents,ending_value_cents) VALUES (?,1,?,?,?,?)");
  summary.run(10, "2026-09-01", "2026-09-30", 90_000, 100_000);
  summary.run(11, "2026-04-01", "2026-06-30", 450_000, 500_000);

  await page.setViewportSize({ width: 768, height: 1000 });
  await page.goto("/investments");
  const hero = page.getByRole("group", { name: "Portfolio summary, All 2 accounts" });
  await expect(hero).toContainText("Portfolio value");
  await expect(hero).toContainText("$6,000.00");
  await expect(hero).toContainText("Mixed");
  await expect(hero).toContainText("Jun 30, 2026 to Sep 30, 2026");
  // The unknown-cost fund adds no gain: $1,000 - $800, on the 17% of value with a cost basis.
  await expect(hero).toContainText("$200.00");
  await expect(hero).toContainText("17% of value");
  const heroBox = (await hero.boundingBox())!;
  const tabBox = (await page.getByRole("button", { name: /^Holdings/ }).boundingBox())!;
  expect(heroBox.y + heroBox.height).toBeLessThanOrEqual(tabBox.y);
  // The value leads, centered across the summary, with the supporting figures below it.
  const value = hero.locator(".stat-row-item[data-hero]");
  const valueBox = (await value.locator("strong").boundingBox())!;
  expect(Math.abs(valueBox.x + valueBox.width / 2 - (heroBox.x + heroBox.width / 2))).toBeLessThanOrEqual(2);
  await expect(value).toHaveCSS("text-align", "center");
  const firstSupport = (await hero.locator(".stat-row-item:not([data-hero])").first().boundingBox())!;
  expect(firstSupport.y).toBeGreaterThanOrEqual((await value.boundingBox())!.y + (await value.boundingBox())!.height);
  // Each account keeps its own statement period - never one merged "latest" period.
  await expect(page.getByRole("region", { name: "Latest statement, Sample Brokerage" })).toContainText("Sep 1, 2026 – Sep 30, 2026");
  await expect(page.getByRole("region", { name: "Latest statement, Sample Retirement" })).toContainText("Apr 1, 2026 – Jun 30, 2026");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Keyboard, not a programmatic select: End moves to the last account (sorted by name).
  await page.getByRole("combobox", { name: /^Account/ }).focus();
  await page.keyboard.press("End");
  const scoped = page.getByRole("group", { name: "Portfolio summary, Sample Retirement" });
  await expect(scoped).toContainText("Account value");
  await expect(scoped).toContainText("$5,000.00");
  await expect(scoped).toContainText("Unknown");
  await expect(scoped).toContainText("Jun 30, 2026");
  await expect(page.getByRole("region", { name: /^Latest statement/ })).toHaveCount(1);
  await expect(page.getByText("Sample Target Fund")).toBeVisible();
  await expect(page.getByText("Sample Corp")).toHaveCount(0);
});

test("card PDF with a Charges column but no credits this cycle still imports charges as spending", async ({ page, database }) => {
  const pdf = syntheticPdf([[
    [40, 760, "Billing Period: 08/01/26-08/31/26"], [40, 740, "Previous balance $0.00"], [40, 726, "New balance $50.00"],
    [40, 700, "Date"], [110, 700, "Description"], [420, 700, "Charges"], [500, 700, "Credits"],
    [40, 680, "08/10"], [110, 680, "SAMPLE SHOP"], [420, 680, "50.00"],
  ]]);
  await page.goto("/import");
  await page.getByRole("button", { name: /Credit Card Statement/ }).click();
  await page.locator("#csv-input").setInputFiles({ name: "synthetic-charges.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.getByPlaceholder("e.g. Chase Sapphire").fill("Synthetic Card");
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue to Preview" }).click();
  await page.getByRole("button", { name: "Import 1 Transactions" }).click();
  await expect(page.getByText("Import complete")).toBeVisible();
  expect(database.prepare("SELECT t.date, t.amount_cents FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.account_type='credit'").all())
    .toEqual([{ date: "2026-08-10", amount_cents: -5000 }]);
});

// Rows as Compass 1.3.6 hashed them: the printed date, the rest of the line and the last amount,
// with a per-file ordinal for repeats (dedupeRowHash).
const legacyHash = (row: string[], ordinal = 0) =>
  createHash("sha256").update((ordinal ? [...row, `__dupe_ordinal_${ordinal}`] : row).join("||")).digest("hex");
const sameBaselineCardPdf = (rows: [string, string, string][]) => {
  const owed = rows.reduce((sum, [, , amount]) => sum + Number(amount), 0);
  return syntheticPdf([[
    [34, 700, "Billing Period: 08/01/2026-08/31/2026"],
    [317, 660, "Previous balance"], [553, 660, "$0.00"], [317, 646, "New balance"], [553, 646, `$${owed.toFixed(2)}`],
    [37, 550, "Date"], [163, 550, "Description"], [548, 550, "Amount"],
    ...rows.flatMap(([date, description, amount], i) => [[37, 530 - i * 14, date], [163, 530 - i * 14, description], [551, 530 - i * 14, `$${amount}`]] as [number, number, string][]),
  ]]);
};
const seedLegacyCard = (database: DatabaseSync, rows: { date: string; row: string[]; ordinal?: number }[]) => {
  const accountId = Number(database.prepare("INSERT INTO accounts (name,account_type,profile_id) VALUES ('Synthetic Card','credit',1)").run().lastInsertRowid);
  for (const { date, row, ordinal } of rows) {
    database.prepare("INSERT INTO transactions (account_id,profile_id,date,description,amount_cents,import_hash) VALUES (?,1,?,?,?,?)")
      .run(accountId, date, row[1], -Math.round(Number(row[2]) * 100), legacyHash(row, ordinal));
  }
};
const coffee = ["08/03/2026", "SAMPLE COFFEE", "4.50"];
const grocer = ["08/05/2026", "SAMPLE GROCER", "62.10"];

test("re-importing a PDF that 1.3.6 imported skips its rows but keeps a genuinely repeated charge", async ({ page, database }) => {
  // 1.3.6 imported the grocer and the first of two identical coffees; the second coffee is new.
  seedLegacyCard(database, [{ date: "2026-08-05", row: grocer }, { date: "2026-08-03", row: coffee }]);
  await page.goto("/import");
  await page.getByRole("button", { name: /Credit Card Statement/ }).click();
  await page.locator("#csv-input").setInputFiles({ name: "synthetic-aug.pdf", mimeType: "application/pdf",
    buffer: sameBaselineCardPdf([[coffee[0], coffee[1], coffee[2]], [coffee[0], coffee[1], coffee[2]], [grocer[0], grocer[1], grocer[2]]]) });
  await page.getByRole("button", { name: "Existing account", exact: true }).click();
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue to Preview" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Import 3 Transactions" }).click();
  await expect(page.getByText(/1 transactions?\s+imported, 2 duplicates skipped/)).toBeVisible();
  expect(database.prepare("SELECT date, description, amount_cents FROM transactions WHERE account_id=(SELECT id FROM accounts WHERE name='Synthetic Card') ORDER BY date, id").all()).toEqual([
    { date: "2026-08-03", description: "SAMPLE COFFEE", amount_cents: -450 },
    { date: "2026-08-03", description: "SAMPLE COFFEE", amount_cents: -450 },
    { date: "2026-08-05", description: "SAMPLE GROCER", amount_cents: -6210 },
  ]);
});

test("a year-less charge from last year's 1.3.6 import doesn't hide the same charge this year", async ({ page, database }) => {
  // 1.3.6 stored a year-less "07/15" as 2001 under the old row hash; this year's identical line is new.
  seedLegacyCard(database, [{ date: "2001-07-15", row: ["07/15", "SAMPLE ANNUAL FEE", "95.00"] }]);
  const pdf = syntheticPdf([[
    [34, 700, "Billing Period: 07/01/2026-07/31/2026"],
    [317, 660, "Previous balance"], [553, 660, "$0.00"], [317, 646, "New balance"], [553, 646, "$95.00"],
    [37, 550, "Date"], [163, 550, "Description"], [548, 550, "Amount"],
    [37, 530, "07/15"], [163, 530, "SAMPLE ANNUAL FEE"], [551, 530, "$95.00"],
  ]]);
  await page.goto("/import");
  await page.getByRole("button", { name: /Credit Card Statement/ }).click();
  await page.locator("#csv-input").setInputFiles({ name: "synthetic-annual.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.getByRole("button", { name: "Existing account", exact: true }).click();
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue to Preview" }).click();
  await page.getByRole("button", { name: "Import 1 Transactions" }).click();
  await expect(page.getByText("Import complete")).toBeVisible();
  expect(database.prepare("SELECT date, amount_cents FROM transactions WHERE account_id=(SELECT id FROM accounts WHERE name='Synthetic Card') ORDER BY date").all())
    .toEqual([{ date: "2001-07-15", amount_cents: -9500 }, { date: "2026-07-15", amount_cents: -9500 }]);
});

test("Auto-Import All skips rows a 1.3.6 import already holds", async ({ page, database }) => {
  seedLegacyCard(database, [{ date: "2026-08-05", row: grocer }, { date: "2026-08-03", row: coffee }, { date: "2026-08-03", row: coffee, ordinal: 1 }]);
  await page.goto("/import");
  await page.getByRole("button", { name: /Credit Card Statement/ }).click();
  await page.locator("#csv-input").setInputFiles([
    { name: "synthetic-jul.pdf", mimeType: "application/pdf", buffer: sameBaselineCardPdf([["07/20/2026", "SAMPLE BOOKS", "18.00"]]) },
    { name: "synthetic-aug.pdf", mimeType: "application/pdf", buffer: sameBaselineCardPdf([[coffee[0], coffee[1], coffee[2]], [coffee[0], coffee[1], coffee[2]], [grocer[0], grocer[1], grocer[2]]]) },
  ]);
  await page.getByRole("button", { name: "Existing account", exact: true }).click();
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue to Preview" }).click();
  await page.getByRole("button", { name: "Auto-Import All (2 Files)" }).click();
  await expect.poll(() => database.prepare("SELECT COUNT(*) AS n FROM import_sessions").get()).toEqual({ n: 1 });
  await expect(page.getByText(/Already imported|Import complete/)).toBeVisible();
  expect(database.prepare("SELECT date, description, amount_cents FROM transactions WHERE account_id=(SELECT id FROM accounts WHERE name='Synthetic Card') ORDER BY date, id").all()).toEqual([
    { date: "2026-07-20", description: "SAMPLE BOOKS", amount_cents: -1800 },
    { date: "2026-08-03", description: "SAMPLE COFFEE", amount_cents: -450 },
    { date: "2026-08-03", description: "SAMPLE COFFEE", amount_cents: -450 },
    { date: "2026-08-05", description: "SAMPLE GROCER", amount_cents: -6210 },
  ]);
});

test("workspace follows restored and maximized widths", async ({ page, database }) => {
  expect(database.isOpen).toBe(true);
  await page.goto("/budgets");
  for (const width of [2560, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => {
      const main = document.querySelector("main")!;
      const workspace = document.querySelector(".workspace-page")!;
      return Math.abs(main.clientWidth - workspace.getBoundingClientRect().width);
    })).toBeLessThanOrEqual(1);
  }
  await page.getByTitle('Plan', { exact: true }).click();
  for (const width of [2560, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByTitle('Expand sidebar', { exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      const main = document.querySelector('main')!;
      return main.scrollWidth <= main.clientWidth + 1;
    })).toBe(true);
    await page.getByTitle('Collapse sidebar', { exact: true }).click();
  }
});

// Compass is a desktop app: these are the window sizes it actually runs at. Phone widths are
// deliberately not covered.
for (const viewport of [768, 1024, 1440, 1920, 2560].map((width) => ({ width, height: 1000 }))) {
  test(`workspace layouts at ${viewport.width}px`, async ({ page, database }, testInfo) => {
    expect(database.isOpen).toBe(true);
    await page.setViewportSize(viewport);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      for (const route of ["overview", "", "plan", "transactions", "goals", "budgets", "reports", "import", "trends", "chart", "investments", "agent", "settings"]) {
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
        await expect.poll(() => page.evaluate(() => {
          const main = document.querySelector('main')!;
          const workspace = document.querySelector('.workspace-page')!;
          if (main.scrollWidth <= main.clientWidth + 1 && Math.abs(main.clientWidth - workspace.getBoundingClientRect().width) <= 1) return [];
          return [...workspace.querySelectorAll('*')].filter((element) => element.getBoundingClientRect().right > main.getBoundingClientRect().right + 1).slice(0, 8).map((element) => ({ tag: element.tagName, class: element.getAttribute('class'), width: Math.round(element.getBoundingClientRect().width) }));
        }), { message: `${route || 'dashboard'} ${theme} ${viewport.width}` }).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`${route}-${theme}-${viewport.width}.png`), fullPage: true });
      }
    }
  });
}