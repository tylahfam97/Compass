import { useState, useEffect, useCallback } from "react";
import { Download, Upload, RotateCcw, Plus, Pencil, Trash2, Pause, Play, CalendarClock, ShieldAlert, AlertTriangle, CheckCircle2 } from "lucide-react";
import { getDb } from "@/lib/db";
import {
  getRecurringRulesForProfile, createRecurringRule, updateRecurringRule,
  setRecurringRuleActive, deleteRecurringRule, type RecurringRuleInput,
  getBalanceAnchorRiskReport, type BalanceAnchorRiskEntry,
} from "@/lib/db";
import { computeNextOccurrence, daysUntil, formatCadenceLabel } from "@/lib/recurring";
import { exportBackup, restoreBackup, getLastBackupAt } from "@/lib/backup";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useProfileStore } from "@/stores/profileStore";
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

/** Backup/Restore + user-defined Recurring Transactions - a dedicated home for app-wide
 *  features that don't belong on any single existing page. Currency is deliberately not
 *  configurable here - Compass stays USD-only for now. */
export default function SettingsPage() {
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;
  const categories = useCategoryStore((s) => s.categories);

  // ── Backup & Restore ─────────────────────────────────────────────────────
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState<{ text: string; tone: "success" | "error" } | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(() => getLastBackupAt());

  // ── Balance anchor check ─────────────────────────────────────────────────
  const [balanceReport, setBalanceReport] = useState<BalanceAnchorRiskEntry[] | null>(null);
  const [balanceCheckBusy, setBalanceCheckBusy] = useState(false);

  const handleCheckBalances = async () => {
    setBalanceCheckBusy(true);
    const report = await getBalanceAnchorRiskReport(profileId);
    setBalanceReport(report);
    setBalanceCheckBusy(false);
  };

  const handleExport = async () => {
    setBackupBusy(true);
    setBackupMsg(null);
    const result = await exportBackup();
    setBackupBusy(false);
    if (result.ok) { setBackupMsg({ text: "Backup saved.", tone: "success" }); setLastBackupAt(getLastBackupAt()); }
    else if (result.error !== "cancelled") setBackupMsg({ text: `Backup failed: ${result.error}`, tone: "error" });
  };

  const handleRestore = async () => {
    if (!restoreConfirm) { setRestoreConfirm(true); return; }
    setRestoreConfirm(false);
    setRestoreBusy(true);
    setBackupMsg(null);
    const result = await restoreBackup();
    if (!result.ok) {
      setRestoreBusy(false);
      if (result.error !== "cancelled") setBackupMsg({ text: `Restore failed: ${result.error}`, tone: "error" });
    }
    // On success the app relaunches itself - nothing more to do here.
  };

  // ── Recurring transactions ───────────────────────────────────────────────
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

  useEffect(() => { loadRules().catch(console.error); }, [loadRules]);

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
      await loadRules();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
    setSaving(false);
  };

  const toggleActive = async (r: RecurringRule) => {
    await setRecurringRuleActive(r.id, !r.active);
    await loadRules();
  };

  const removeRule = async (id: number) => {
    await deleteRecurringRule(id);
    setConfirmDeleteId(null);
    await loadRules();
  };

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
          Backup &amp; restore, and upcoming bills you want to plan for ahead of time.
        </p>
      </div>

      {/* ── Balance Anchor Check ─────────────────────────────────────────── */}
      <section className="border rounded-2xl p-5 space-y-4">
        <div>
          <h2 className="font-semibold flex items-center gap-1.5"><AlertTriangle size={15} /> Balance Anchor Check</h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
            Lists checking/credit accounts with 2+ manually-added transactions - the pattern that
            could have tripped a balance-calculation bug fixed in 0.9.6. Being listed doesn't mean
            an account is wrong, just worth comparing against your real bank balance once.
          </p>
        </div>

        <button
          onClick={handleCheckBalances}
          disabled={balanceCheckBusy}
          className="text-sm px-3 py-1.5 rounded-lg border hover:bg-[hsl(var(--muted))]
                     transition-colors flex items-center gap-1.5 disabled:opacity-50"
        >
          <AlertTriangle size={14} /> {balanceCheckBusy ? "Checking…" : "Check My Accounts"}
        </button>

        {balanceReport && (
          balanceReport.length === 0 ? (
            <p className="text-sm text-[hsl(var(--success))] flex items-center gap-1.5">
              <CheckCircle2 size={14} /> No accounts match the risk pattern.
            </p>
          ) : (
            <div className="space-y-1.5">
              {balanceReport.map((r) => (
                <div key={r.accountId} className="flex items-center justify-between text-sm border rounded-lg px-3 py-2">
                  <span>
                    <strong>{r.name}</strong>{" "}
                    <span className="text-xs text-[hsl(var(--muted-foreground))]">
                      ({r.manualTxnCount} manual entries{r.hasAnchor ? "" : ", no confirmed balance yet"})
                    </span>
                  </span>
                  <span className="font-mono text-[hsl(var(--muted-foreground))]">
                    {r.latestBalanceCents != null ? formatCurrency(r.latestBalanceCents) : "—"}
                  </span>
                </div>
              ))}
            </div>
          )
        )}
      </section>

      {/* ── Backup & Restore ────────────────────────────────────────────── */}
      <section className="border rounded-2xl p-5 space-y-4">
        <div>
          <h2 className="font-semibold flex items-center gap-1.5"><ShieldAlert size={15} /> Backup &amp; Restore</h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
            A backup is a single encrypted file containing your entire database and its
            encryption key - simpler than manually copying <code>compass.db</code> and{" "}
            <code>compass.key</code> separately.
          </p>
        </div>

        {(() => {
          const daysSince = lastBackupAt != null
            ? Math.floor((Date.now() - new Date(lastBackupAt).getTime()) / 86400000)
            : null;
          const stale = daysSince == null || daysSince >= 30;
          return (
            <p className={`text-xs px-3 py-2 rounded-lg ${
              stale ? "bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))]" : "text-[hsl(var(--muted-foreground))]"
            }`}>
              {daysSince == null
                ? "You haven't backed up yet - your data only exists on this device. Consider creating one now."
                : daysSince >= 30
                ? `It's been ${daysSince} days since your last backup (${formatDate(lastBackupAt!.split("T")[0])}) - consider backing up again.`
                : `Last backup: ${formatDate(lastBackupAt!.split("T")[0])}.`}
            </p>
          );
        })()}

        {backupMsg && (
          <p className={`text-sm px-3 py-2 rounded-lg ${
            backupMsg.tone === "success"
              ? "bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]"
              : "bg-[hsl(var(--error)/0.1)] text-[hsl(var(--error))]"
          }`}>
            {backupMsg.text}
          </p>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleExport}
            disabled={backupBusy}
            className="text-sm px-3 py-1.5 rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                       hover:opacity-90 transition-opacity flex items-center gap-1.5 font-medium disabled:opacity-50"
          >
            <Download size={14} /> {backupBusy ? "Preparing…" : "Export Backup"}
          </button>

          {restoreConfirm ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-[hsl(var(--muted-foreground))]">
                This replaces all current data and relaunches the app. Continue?
              </span>
              <button
                onClick={handleRestore}
                className="text-xs px-2.5 py-1.5 rounded-lg font-medium"
                style={{ color: "white", backgroundColor: "hsl(var(--error))" }}
              >
                Yes, restore
              </button>
              <button
                onClick={() => setRestoreConfirm(false)}
                className="text-xs px-2.5 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              onClick={handleRestore}
              disabled={restoreBusy}
              title="Choose a .compassbackup file to restore from"
              className="text-sm px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]
                         transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <Upload size={14} /> {restoreBusy ? "Restoring…" : "Restore Backup"}
            </button>
          )}
        </div>
      </section>

      {/* ── Recurring Transactions ──────────────────────────────────────── */}
      <section className="border rounded-2xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-semibold flex items-center gap-1.5"><CalendarClock size={15} /> Recurring Transactions</h2>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1 max-w-md">
              Schedule a bill or income ahead of time. Reminder-only - nothing here ever posts a
              real transaction automatically; add or edit it yourself when it actually happens.
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
            No recurring rules yet - add one for a bill or paycheck you know is coming.
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
              <button onClick={() => setForm(null)} className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
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
    </div>
  );
}
