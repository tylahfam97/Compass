import { useState, useEffect, useCallback } from "react";
import { Plus, Pencil, Trash2, Pause, Play, CalendarClock, RotateCcw } from "lucide-react";
import {
  getDb,
  getRecurringRulesForProfile, createRecurringRule, updateRecurringRule,
  setRecurringRuleActive, deleteRecurringRule, type RecurringRuleInput,
} from "@/lib/db";
import { computeNextOccurrence, daysUntil, formatCadenceLabel } from "@/lib/recurring";
import { formatCurrency, formatDate } from "@/lib/utils";
import { reportLoadError } from "@/stores/toastStore";
import { useCategoryStore } from "@/stores/categoryStore";
import CategoryOptions from "@/components/CategoryOptions";
import type { RecurringRule, RecurringCadence } from "@/lib/types";

function centsToDisplay(cents: number): string {
  return (cents / 100).toFixed(2);
}
function parseDollar(s: string): number {
  const n = parseFloat(s.replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : Math.round(n * 100);
}

const DOW_OPTIONS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

interface RuleFormState {
  id: number | null;
  description: string;
  amount: string;
  categoryId: number;
  cadence: RecurringCadence;
  dayOfMonth: string;
  dayOfWeek: number;
  startDate: string;
  accountId: number | "";
}

function blankForm(): RuleFormState {
  return {
    id: null, description: "", amount: "", categoryId: 15, cadence: "monthly",
    dayOfMonth: "1", dayOfWeek: 0, startDate: new Date().toISOString().split("T")[0], accountId: "",
  };
}

interface RecurringRulesPanelProps {
  profileId: number;
  /** Fired after any create/edit/pause/delete so a parent forecast can be recomputed. */
  onChanged?: () => void;
}

/** CRUD for user-defined recurring bills and income. These are reminder-and-forecast only -
 *  nothing here ever posts a real transaction automatically. */
export default function RecurringRulesPanel({ profileId, onChanged }: RecurringRulesPanelProps) {
  const categories = useCategoryStore((s) => s.categories);
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [loadingRules, setLoadingRules] = useState(true);
  const [accounts, setAccounts] = useState<{ id: number; name: string; account_type: string }[]>([]);
  const [form, setForm] = useState<RuleFormState | null>(null);
  const [signIsExpense, setSignIsExpense] = useState(true);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    setLoadingRules(true);
    const [ruleRows, db] = await Promise.all([getRecurringRulesForProfile(profileId), getDb()]);
    setRules(ruleRows);
    const accountRows = await db.select<{ id: number; name: string; account_type: string }[]>(
      "SELECT id, name, account_type FROM accounts WHERE profile_id=? AND account_type!='loan' ORDER BY account_type, name",
      [profileId]
    );
    setAccounts(accountRows);
    setLoadingRules(false);
  }, [profileId]);

  useEffect(() => {
    loadRules().catch(reportLoadError("your recurring transactions", () => void loadRules()));
  }, [loadRules]);

  const upcoming = rules
    .filter((r) => r.active)
    .map((r) => {
      const next = computeNextOccurrence(r, new Date());
      return { rule: r, next, days: daysUntil(next) };
    })
    .sort((a, b) => a.next.getTime() - b.next.getTime());

  const openNewForm = () => { setForm(blankForm()); setSignIsExpense(true); setFormError(null); };
  const openEditForm = (r: RecurringRule) => {
    setForm({
      id: r.id,
      description: r.description,
      amount: centsToDisplay(Math.abs(r.amount_cents)),
      categoryId: r.category_id ?? 15,
      cadence: r.cadence,
      dayOfMonth: String(r.day_of_month ?? 1),
      dayOfWeek: r.day_of_week ?? 0,
      startDate: r.start_date,
      accountId: r.account_id ?? "",
    });
    setSignIsExpense(r.amount_cents <= 0);
    setFormError(null);
  };

  const afterChange = async () => {
    await loadRules();
    onChanged?.();
  };

  const saveForm = async () => {
    if (!form) return;
    if (!form.description.trim()) { setFormError("Description is required."); return; }
    const dollars = parseDollar(form.amount);
    if (dollars === 0) { setFormError("Amount can't be zero."); return; }
    const amountCents = signIsExpense ? -Math.abs(dollars) : Math.abs(dollars);
    const dayOfMonth = form.cadence === "monthly" ? Math.min(31, Math.max(1, parseInt(form.dayOfMonth, 10) || 1)) : null;
    const dayOfWeek = form.cadence !== "monthly" ? form.dayOfWeek : null;

    const input: RecurringRuleInput = {
      profileId,
      accountId: form.accountId === "" ? null : Number(form.accountId),
      description: form.description.trim(),
      amountCents,
      categoryId: form.categoryId,
      cadence: form.cadence,
      dayOfMonth,
      dayOfWeek,
      startDate: form.startDate,
    };
    setSaving(true);
    setFormError(null);
    try {
      if (form.id != null) await updateRecurringRule(form.id, input);
      else await createRecurringRule(input);
      setForm(null);
      await afterChange();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
    setSaving(false);
  };

  const toggleActive = async (r: RecurringRule) => {
    await setRecurringRuleActive(r.id, !r.active);
    await afterChange();
  };

  const removeRule = async (id: number) => {
    await deleteRecurringRule(id);
    setConfirmDeleteId(null);
    await afterChange();
  };

  return (
    <section className="border rounded-2xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold flex items-center gap-1.5"><CalendarClock size={15} /> Scheduled Bills &amp; Income</h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1 max-w-md">
            Anything you add here is projected into the forecast above. Reminder-only - nothing
            posts a real transaction automatically; add or edit it yourself when it happens.
          </p>
        </div>
        <button
          onClick={openNewForm}
          className="text-sm px-3 py-1.5 rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                     hover:opacity-90 transition-opacity flex items-center gap-1.5 font-medium shrink-0"
        >
          <Plus size={14} /> Add Rule
        </button>
      </div>

      {loadingRules ? (
        <p className="text-sm text-[hsl(var(--muted-foreground))]">Loading…</p>
      ) : rules.length === 0 ? (
        <p className="text-sm text-[hsl(var(--muted-foreground))] italic">
          No scheduled items yet - add your rent, your paycheck, and any bill you know is coming.
        </p>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => {
            const nextInfo = r.active ? upcoming.find((u) => u.rule.id === r.id) : null;
            return (
              <div key={r.id} className={`flex items-center gap-3 border rounded-lg px-3 py-2 ${!r.active ? "opacity-50" : ""}`}>
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: r.category_color ?? "hsl(var(--neutral))" }}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{r.description}</p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    {formatCadenceLabel(r)}
                    {r.account_name ? ` · ${r.account_name}` : ""}
                    {nextInfo ? ` · next ${formatDate(nextInfo.next.toISOString().split("T")[0])} (${nextInfo.days <= 0 ? "today" : `${nextInfo.days}d`})` : ""}
                  </p>
                </div>
                <span className={`text-sm font-semibold shrink-0 ${r.amount_cents < 0 ? "text-[hsl(var(--error))]" : "text-[hsl(var(--success))]"}`}>
                  {formatCurrency(r.amount_cents)}
                </span>
                <button onClick={() => toggleActive(r)} title={r.active ? "Pause" : "Resume"} className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] shrink-0">
                  {r.active ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button onClick={() => openEditForm(r)} title="Edit" className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] shrink-0">
                  <Pencil size={14} />
                </button>
                {confirmDeleteId === r.id ? (
                  <span className="flex items-center gap-1 shrink-0">
                    <button onClick={() => removeRule(r.id)} className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ color: "white", backgroundColor: "hsl(var(--error))" }}>Delete?</button>
                    <button onClick={() => setConfirmDeleteId(null)} className="text-[hsl(var(--muted-foreground))]">✕</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmDeleteId(r.id)} title="Delete" className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--error))] shrink-0">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {form && (
        <div className="border rounded-xl p-4 space-y-3 bg-[hsl(var(--muted))]/30">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{form.id != null ? "Edit rule" : "New rule"}</h3>
            <button onClick={() => setForm(null)} aria-label="Discard" className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
              <RotateCcw size={13} />
            </button>
          </div>

          {formError && <p className="text-xs text-[hsl(var(--error))]">{formError}</p>}

          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs col-span-2">
              Description
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="e.g. Rent, Paycheck"
                className="mt-1 w-full border rounded-lg px-2.5 py-1.5 text-sm bg-[hsl(var(--background))]"
              />
            </label>

            <label className="text-xs">
              Amount
              <div className="mt-1 flex gap-1">
                <select
                  value={signIsExpense ? "expense" : "income"}
                  onChange={(e) => setSignIsExpense(e.target.value === "expense")}
                  aria-label="Money in or out"
                  className="border rounded-lg px-1.5 text-sm bg-[hsl(var(--background))]"
                >
                  <option value="expense">−</option>
                  <option value="income">+</option>
                </select>
                <input
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  placeholder="0.00"
                  className="flex-1 border rounded-lg px-2.5 py-1.5 text-sm bg-[hsl(var(--background))]"
                />
              </div>
            </label>

            <label className="text-xs">
              Category
              <select
                value={form.categoryId}
                onChange={(e) => setForm({ ...form, categoryId: parseInt(e.target.value, 10) })}
                className="mt-1 w-full border rounded-lg px-2.5 py-1.5 text-sm bg-[hsl(var(--background))]"
              >
                <CategoryOptions categories={categories} />
              </select>
            </label>

            <label className="text-xs">
              Cadence
              <select
                value={form.cadence}
                onChange={(e) => setForm({ ...form, cadence: e.target.value as RecurringCadence })}
                className="mt-1 w-full border rounded-lg px-2.5 py-1.5 text-sm bg-[hsl(var(--background))]"
              >
                <option value="monthly">Monthly</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every 2 weeks</option>
              </select>
            </label>

            {form.cadence === "monthly" ? (
              <label className="text-xs">
                Day of month
                <input
                  type="number" min={1} max={31}
                  value={form.dayOfMonth}
                  onChange={(e) => setForm({ ...form, dayOfMonth: e.target.value })}
                  className="mt-1 w-full border rounded-lg px-2.5 py-1.5 text-sm bg-[hsl(var(--background))]"
                />
              </label>
            ) : (
              <label className="text-xs">
                Day of week
                <select
                  value={form.dayOfWeek}
                  onChange={(e) => setForm({ ...form, dayOfWeek: parseInt(e.target.value, 10) })}
                  className="mt-1 w-full border rounded-lg px-2.5 py-1.5 text-sm bg-[hsl(var(--background))]"
                >
                  {DOW_OPTIONS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </label>
            )}

            <label className="text-xs">
              Starting
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                className="mt-1 w-full border rounded-lg px-2.5 py-1.5 text-sm bg-[hsl(var(--background))]"
              />
            </label>

            <label className="text-xs">
              Account <span className="text-[hsl(var(--muted-foreground))]">(optional)</span>
              <select
                value={form.accountId}
                onChange={(e) => setForm({ ...form, accountId: e.target.value === "" ? "" : parseInt(e.target.value, 10) })}
                className="mt-1 w-full border rounded-lg px-2.5 py-1.5 text-sm bg-[hsl(var(--background))]"
              >
                <option value="">Any / unassigned</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={saveForm}
              disabled={saving}
              className="text-sm px-3 py-1.5 rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                         hover:opacity-90 transition-opacity font-medium disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setForm(null)} className="text-sm px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]">
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
