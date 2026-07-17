import { getDb, resolveAccountId, recomputeCalculatedBalances } from "./db";

/** System category IDs used by the demo dataset (matches the hardcoded IDs seeded in
 *  db.ts's category migrations - see MAINTAINER NOTE there for the full list). */
const CAT = {
  INCOME: 1,
  UTILITIES: 11,
  RENT: 12,
  GROCERIES: 13,
  RESTAURANTS: 14,
  GAS: 16,
  SUBSCRIPTIONS: 17,
  TRANSFERS: 20,
  SHOPPING: 7,
  ENTERTAINMENT: 6,
};

interface DemoTxn {
  daysAgo: number;
  amountCents: number;
  description: string;
  categoryId: number;
  account: "checking" | "credit";
}

/** ~55 realistic transactions spread across the last ~3 months, covering enough
 *  variety (income, rent, groceries, restaurants, gas, subscriptions, a credit
 *  card with its own purchases + a monthly payment) that Budgets/Trends/Reports/
 *  Insights all have something meaningful to show during the demo. */
function buildDemoTransactions(): DemoTxn[] {
  const txns: DemoTxn[] = [];

  // Biweekly paycheck, ~6 pay periods over 3 months
  for (let i = 0; i < 6; i++) {
    txns.push({ daysAgo: i * 14 + 2, amountCents: 185000, description: "Acme Corp Payroll", categoryId: CAT.INCOME, account: "checking" });
  }

  // Rent, one per month
  for (let i = 0; i < 3; i++) {
    txns.push({ daysAgo: i * 30 + 3, amountCents: -140000, description: "Sunset Apartments Rent", categoryId: CAT.RENT, account: "checking" });
  }

  // Utilities, one per month
  for (let i = 0; i < 3; i++) {
    txns.push({ daysAgo: i * 30 + 8, amountCents: -11000 - i * 500, description: "City Power & Water", categoryId: CAT.UTILITIES, account: "checking" });
  }

  // Subscriptions, monthly
  for (let i = 0; i < 3; i++) {
    txns.push({ daysAgo: i * 30 + 5, amountCents: -1599, description: "Netflix", categoryId: CAT.SUBSCRIPTIONS, account: "checking" });
    txns.push({ daysAgo: i * 30 + 6, amountCents: -1099, description: "Spotify", categoryId: CAT.SUBSCRIPTIONS, account: "checking" });
  }

  // Groceries, ~8 across the period
  const groceryStores = ["Trader Joe's", "Whole Foods", "Safeway", "Costco"];
  for (let i = 0; i < 8; i++) {
    txns.push({ daysAgo: i * 11 + 1, amountCents: -(4000 + (i * 733) % 6000), description: groceryStores[i % groceryStores.length], categoryId: CAT.GROCERIES, account: "checking" });
  }

  // Restaurants/coffee, ~10 across the period
  const spots = ["Blue Bottle Coffee", "Chipotle", "Local Diner", "Sushi House", "Pizza Palace"];
  for (let i = 0; i < 10; i++) {
    txns.push({ daysAgo: i * 8 + 2, amountCents: -(600 + (i * 517) % 4500), description: spots[i % spots.length], categoryId: CAT.RESTAURANTS, account: "checking" });
  }

  // Gas, ~6 across the period
  for (let i = 0; i < 6; i++) {
    txns.push({ daysAgo: i * 15 + 4, amountCents: -(3800 + (i * 211) % 1800), description: "Shell Gas Station", categoryId: CAT.GAS, account: "checking" });
  }

  // Shopping/entertainment, a handful
  txns.push({ daysAgo: 12, amountCents: -8900, description: "Target", categoryId: CAT.SHOPPING, account: "checking" });
  txns.push({ daysAgo: 27, amountCents: -6200, description: "Amazon", categoryId: CAT.SHOPPING, account: "checking" });
  txns.push({ daysAgo: 45, amountCents: -4500, description: "AMC Theatres", categoryId: CAT.ENTERTAINMENT, account: "checking" });
  txns.push({ daysAgo: 60, amountCents: -3200, description: "Steam Games", categoryId: CAT.ENTERTAINMENT, account: "checking" });

  // Credit card purchases (negative on the credit account - real expenses)
  const creditSpots = ["Best Buy", "Home Depot", "Uber", "DoorDash", "REI"];
  for (let i = 0; i < 8; i++) {
    txns.push({ daysAgo: i * 10 + 3, amountCents: -(2500 + (i * 977) % 9000), description: creditSpots[i % creditSpots.length], categoryId: i % 2 === 0 ? CAT.SHOPPING : CAT.RESTAURANTS, account: "credit" });
  }

  // Credit card payments - one per month: negative on checking (money leaving), positive on
  // credit (debt going down) - both categorized as Transfers, demonstrating the common-sense
  // rule that a card payment is neither income nor an expense.
  for (let i = 0; i < 3; i++) {
    const amt = 32000 + i * 1500;
    txns.push({ daysAgo: i * 30 + 10, amountCents: -amt, description: "Credit Card Payment", categoryId: CAT.TRANSFERS, account: "checking" });
    txns.push({ daysAgo: i * 30 + 10, amountCents: amt, description: "Payment - Thank You", categoryId: CAT.TRANSFERS, account: "credit" });
  }

  return txns;
}

/**
 * Seeds a "Demo Checking" and "Demo Credit Card" account with ~55 realistic transactions
 * spanning the last ~3 months, so a brand-new user can see every page populated without
 * importing anything. Undo with the existing "Clear all transactions" option on the
 * Dashboard's Manage Data section - demo transactions aren't tracked separately, they're
 * just regular transactions on two clearly-named demo accounts.
 */
export async function seedDemoData(profileId: number): Promise<void> {
  const db = await getDb();
  const checkingId = await resolveAccountId(profileId, "checking", {
    mode: "new", name: "Demo Checking", institution: "Compass Demo",
  });
  const creditId = await resolveAccountId(profileId, "credit", {
    mode: "new", name: "Demo Credit Card", institution: "Compass Demo",
  });

  const today = new Date();
  const txns = buildDemoTransactions();

  for (const t of txns) {
    const date = new Date(today);
    date.setDate(date.getDate() - t.daysAgo);
    const dateStr = date.toISOString().split("T")[0];
    const accountId = t.account === "checking" ? checkingId : creditId;
    const hash = "demo_" + crypto.randomUUID();
    await db.execute(
      `INSERT INTO transactions (account_id, date, amount_cents, description, category_id, import_hash, profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [accountId, dateStr, t.amountCents, t.description, t.categoryId, hash, profileId]
    );
  }

  await recomputeCalculatedBalances(checkingId);
  await recomputeCalculatedBalances(creditId);
}
