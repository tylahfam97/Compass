import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { getDb, recomputeCalculatedBalances } from "@/lib/db";
import { useCategoryStore } from "@/stores/categoryStore";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import CategoryOptions from "@/components/CategoryOptions";
import { Info } from "lucide-react";
import type { Transaction } from "@/lib/types";

interface Props {
  /** Existing transaction to edit, or undefined to add a new one. */
  transaction?: Transaction;
  onClose: () => void;
  /** Called after a successful save or delete so the parent can refresh. */
  onSaved: () => void;
  profileId: number;
}

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking: "Checking", savings: "Savings", credit: "Credit Card", investment: "Investment",
};

function centsToDisplay(cents: number): string {
  return (cents / 100).toFixed(2);
}

function parseDollar(s: string): number {
  const n = parseFloat(s.replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : Math.round(n * 100);
}

export default function EditTransactionModal({ transaction, onClose, onSaved, profileId }: Props) {
  const categories = useCategoryStore((s) => s.categories);
  const isAdd = !transaction;
  const { onBackdropClick } = useModalDismiss(onClose);

  const [date, setDate]         = useState(transaction?.date ?? new Date().toISOString().split("T")[0]);
  const [desc, setDesc]         = useState(transaction?.description ?? "");
  const [amount, setAmount]     = useState(transaction ? centsToDisplay(transaction.amount_cents) : "");
  const [catId, setCatId]       = useState<number>(transaction?.category_id ?? 15);
  const [notes, setNotes]       = useState(transaction?.notes ?? "");
  const [saving, setSaving]     = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [accounts, setAccounts] = useState<{ id: number; name: string; account_type: string }[]>([]);
  const [accountId, setAccountId] = useState<number | "">("");

  // Which account a manually-added transaction posts against - required, since silently
  // defaulting to "whichever account happens to be first" produced wrong balances/insights
  // for anyone with more than one account. Loans are excluded: they only ever get balance-
  // snapshot rows from statement uploads, never itemized transactions (see db.ts).
  useEffect(() => {
    if (!isAdd) return;
    let cancelled = false;
    (async () => {
      const db = await getDb();
      const rows = await db.select<{ id: number; name: string; account_type: string }[]>(
        "SELECT id, name, account_type FROM accounts WHERE profile_id=? AND account_type!='loan' ORDER BY account_type, name",
        [profileId]
      );
      if (cancelled) return;
      setAccounts(rows);
      if (rows.length === 1) setAccountId(rows[0].id);
    })().catch(console.error);
    return () => { cancelled = true; };
  }, [isAdd, profileId]);

  const handleSave = async () => {
    if (!date || !desc.trim()) { setError("Date and description are required."); return; }
    if (isAdd && !accountId) { setError("Please select which account this transaction belongs to."); return; }
    const amountCents = parseDollar(amount);
    if (amountCents === 0) { setError("Amount cannot be zero."); return; }
    setSaving(true);
    setError(null);
    try {
      const db = await getDb();
      if (isAdd) {
        // Generate a unique hash for manually-added transactions
        const hash = "manual_" + crypto.randomUUID();
        await db.execute(
          `INSERT INTO transactions
             (account_id, date, amount_cents, description, category_id, notes, import_hash, profile_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [accountId, date, amountCents, desc.trim(), catId, notes.trim() || null, hash, profileId]
        );
        await recomputeCalculatedBalances(accountId as number);
      } else {
        await db.execute(
          `UPDATE transactions
           SET date=?, amount_cents=?, description=?, category_id=?, notes=?
           WHERE id=?`,
          [date, amountCents, desc.trim(), catId, notes.trim() || null, transaction!.id]
        );
        // Amount/date edits shift every later transaction's running balance - recompute
        // the whole account so Overview/Dashboard/Trends read correct numbers next load.
        await recomputeCalculatedBalances(transaction!.account_id);
      }
      onSaved();
      onClose();
    } catch (e) { setError(String(e)); }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!transaction) return;
    setSaving(true);
    try {
      const db = await getDb();
      await db.execute("DELETE FROM transactions WHERE id=?", [transaction.id]);
      await recomputeCalculatedBalances(transaction.account_id);
      onSaved();
      onClose();
    } catch (e) { setError(String(e)); setSaving(false); }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      onClick={onBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.15 }}
        className="bg-[hsl(var(--background))] border rounded-2xl shadow-xl w-full max-w-md p-6"
      >
        <h2 className="text-lg font-semibold mb-4">{isAdd ? "Add Transaction" : "Edit Transaction"}</h2>

        {error && <p className="mb-3 text-sm text-[hsl(var(--error))]">{error}</p>}

        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]" />
          </div>

          {isAdd && (
            <div>
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Account</label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}
                className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
                <option value="">Select an account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({ACCOUNT_TYPE_LABELS[a.account_type] ?? a.account_type})
                  </option>
                ))}
              </select>
              {accounts.length === 0 && (
                <p className="mt-1.5 text-xs text-[hsl(var(--warning))]">
                  No accounts found for this profile yet - import a statement first.
                </p>
              )}
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Description</label>
            <input value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder="e.g. Grocery run"
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]" />
          </div>

          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">
              Amount (negative = expense)
            </label>
            <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
              placeholder="-45.00"
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]" />
          </div>

          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Category</label>
            <select value={catId} onChange={(e) => setCatId(Number(e.target.value))}
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
              <CategoryOptions categories={categories} />
            </select>
            {catId === 20 && (
              <div className="mt-1.5 flex items-start gap-1.5 text-xs text-[hsl(var(--warning))]">
                <Info size={12} className="shrink-0 mt-0.5" />
                <span>Transfers are excluded from income and expense totals across all reports and insights.</span>
              </div>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">
              Notes <span className="normal-case">(optional)</span>
            </label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
              rows={2} placeholder="Any additional context…"
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] resize-none" />
          </div>
        </div>

        <div className="mt-6 flex justify-between items-center">
          <div>
            {!isAdd && !confirmDel && (
              <button onClick={() => setConfirmDel(true)}
                className="text-sm text-[hsl(var(--error))] hover:underline">Delete</button>
            )}
            {confirmDel && (
              <span className="text-sm flex items-center gap-2">
                <span className="text-[hsl(var(--muted-foreground))]">Delete this transaction?</span>
                <button onClick={handleDelete} disabled={saving}
                  className="text-[hsl(var(--error))] font-medium hover:underline">Yes</button>
                <span>/</span>
                <button onClick={() => setConfirmDel(false)} className="hover:underline">No</button>
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-4 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving || (isAdd && accounts.length === 0)}
              className="px-4 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity">
              {saving ? "Saving…" : isAdd ? "Add" : "Save"}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
