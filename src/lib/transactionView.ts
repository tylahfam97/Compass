export interface TransactionView {
  month?: string;
  allTime: boolean;
  search: string;
  view: "activity" | "table";
  category: string;
  account: string;
  type: "all" | "income" | "expense";
  minimum: string;
  maximum: string;
  sort: "date" | "description" | "category" | "amount" | "balance" | null;
  direction: "asc" | "desc";
  range: { start: string; end: string } | null;
  scroll: number;
}

export function loadTransactionView(profileId: number): TransactionView {
  let value: Partial<TransactionView> = {};
  try { value = JSON.parse(sessionStorage.getItem(`compass_transactions_view_${profileId}`) ?? "{}") ?? {}; } catch { value = {}; }
  const text = (input: unknown) => typeof input === "string" ? input.slice(0, 250) : "";
  const identifier = (input: unknown) => typeof input === "string" && /^\d+$/.test(input) ? input : "";
  const validDate = (input: unknown) => typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input) && Number.isFinite(Date.parse(`${input}T00:00:00Z`)) && new Date(`${input}T00:00:00Z`).toISOString().slice(0, 10) === input;
  return {
    month: typeof value.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.month) ? value.month : undefined,
    allTime: value.allTime === true,
    search: text(value.search), view: value.view === "table" ? "table" : "activity",
    category: value.category === "uncategorized" ? value.category : identifier(value.category),
    account: identifier(value.account), type: value.type === "income" || value.type === "expense" ? value.type : "all",
    minimum: text(value.minimum), maximum: text(value.maximum),
    sort: ["date", "description", "category", "amount", "balance"].includes(value.sort ?? "") ? value.sort! : null,
    direction: value.direction === "desc" ? "desc" : "asc",
    range: value.range && validDate(value.range.start) && validDate(value.range.end) && value.range.start < value.range.end ? value.range : null,
    scroll: typeof value.scroll === "number" && Number.isFinite(value.scroll) ? Math.max(0, value.scroll) : 0,
  };
}

export function saveTransactionView(profileId: number, value: TransactionView) {
  try { sessionStorage.setItem(`compass_transactions_view_${profileId}`, JSON.stringify(value)); } catch { return; }
}