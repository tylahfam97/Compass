import { test as base, expect, chromium, type Page, type Browser } from "@playwright/test";

/**
 * Smoke suite for the running Tauri dev app - see playwright.config.ts for how to launch it
 * with the CDP port open. Every test shares the single real app window, so the suite is serial.
 */
const CDP_URL = process.env.COMPASS_CDP_URL ?? "http://127.0.0.1:9222";

const NAV_TABS = [
  "Overview", "Dashboard", "Transactions", "Import", "Trends", "Investments",
  "Budgets", "Goals", "Plan", "Reports", "Insights", "Settings",
] as const;

let browser: Browser;
let page: Page;

const test = base;
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch {
    throw new Error(
      `Couldn't reach the app at ${CDP_URL}. Launch it first:\n` +
      `  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"; npm run tauri dev`
    );
  }
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent("page"));

  // First-launch overlays: pick the first profile if the picker is up, dismiss the welcome card.
  const profileButton = page.locator('[role="dialog"][aria-label="Profiles"] button').first();
  if (await profileButton.isVisible().catch(() => false)) await profileButton.click();
  const welcome = page.getByRole("dialog", { name: "Welcome to Compass" });
  if (await welcome.isVisible().catch(() => false)) {
    await welcome.getByRole("button").last().click();
  }
});

test.afterAll(async () => {
  await browser?.close(); // disconnects from CDP; does not close the app
});

test("app shell renders with full navigation", async () => {
  await expect(page.locator("nav")).toBeVisible();
  for (const label of NAV_TABS) {
    await expect(page.locator("nav").getByText(label, { exact: true })).toBeVisible();
  }
});

test("every tab opens without tripping the error boundary", async () => {
  for (const label of NAV_TABS) {
    await page.locator("nav").getByText(label, { exact: true }).click();
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
  }
});

test("plan window selector switches and persists", async () => {
  await page.locator("nav").getByText("Plan", { exact: true }).click();
  const toNextPaycheck = page.getByRole("button", { name: "To next paycheck" });
  // Empty profile shows the import empty state instead - both are valid smoke outcomes.
  if (!(await toNextPaycheck.isVisible().catch(() => false))) {
    await expect(page.getByText("No checking account yet")).toBeVisible();
    return;
  }
  await toNextPaycheck.click();
  await expect(toNextPaycheck).toHaveAttribute("aria-pressed", "true");
  const stored = await page.evaluate(() => localStorage.getItem("compass_plan_window"));
  expect(stored).toBe("paycheck");
});

test("plan what-if slider reacts and persists", async () => {
  await page.locator("nav").getByText("Plan", { exact: true }).click();
  const slider = page.locator('input[type="range"]').first();
  if (!(await slider.isVisible().catch(() => false))) return; // empty-profile state
  await slider.focus();
  // Reset first so the assertion is deterministic.
  const reset = page.getByRole("button", { name: "Reset" });
  if (await reset.isVisible().catch(() => false)) await reset.click();
  await slider.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();
  const stored = await page.evaluate(() => Number(localStorage.getItem("compass_plan_extra")));
  expect(stored).toBeGreaterThan(0);
});
