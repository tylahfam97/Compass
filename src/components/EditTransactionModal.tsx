import { useState, useEffect } from "react";
import { motion } from "motion/react";
import {
  getDb, reconcileCryptoTransfers, recomputeCalculatedBalances, shiftBalanceAnchorForTransactionChange,
  getCryptoMatchState, confirmCryptoTransfer, undoCryptoTransfer, keepCryptoAsSpending, allowCryptoMatching,
  splitCryptoTransfer, undoCryptoSplit,
} from "@/lib/db";
import type { CryptoMatchState } from "@/lib/db";
import { formatCurrency, formatDate } from "@/lib/utils";
import { toISODate } from "@/lib/forecast";
import { useCategoryStore } from "@/stores/categoryStore";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import CategoryOptions from "@/components/CategoryOptions";
import { InfoIcon } from "@phosphor-icons/react";
import { TRANSFER_CATEGORY_ID, type Transaction } from "@/lib/types";

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
  const { onBackdropClick, containerRef } = useModalDismiss(onClose);

  const [date, setDate]         = useState(transaction?.date ?? toISODate(new Date()));
  const [desc, setDesc]         = useState(transaction?.description ?? "");
  const [amount, setAmount]     = useState(transaction ? centsToDisplay(transaction.amount_cents) : "");
  const [catId, setCatId]       = useState<number>(transaction?.category_id ?? 15);
  const [notes, setNotes]       = useState(transaction?.notes ?? "");
  const [saving, setSaving]     = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [accounts, setAccounts] = useState<{ id: number; name: string; account_type: string }[]>([]);
  const [accountId, setAccountId] = useState<number | "">("");
  const [crypto, setCrypto] = useState<CryptoMatchState | null>(null);
  const [depositId, setDepositId] = useState<number | "">("");
  const [feeOk, setFeeOk] = useState(false);
  const [investInput, setInvestInput] = useState("");
  const [spendCatId, setSpendCatId] = useState<number | "">("");

  // Crypto portfolio reconciliation for a saved bank outflow (#107): review the matched deposit
  // and undo, or pick a deposit and confirm (unequal amounts need an explicit acknowledgement).
  useEffect(() => {
    if (!transaction || transaction.amount_cents >= 0) return;
    let cancelled = false;
    getCryptoMatchState(transaction.id).then((s) => { if (!cancelled) setCrypto(s); }).catch(console.error);
    return () => { cancelled = true; };
  }, [transaction]);

  // Each action closes the editor: its form still holds the pre-action category, and saving it
  // would overwrite the decision just made.
  const cryptoAction = async (run: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    try { await run(); onSaved(); onClose(); } catch (e) { setError(String(e)); setSaving(false); }
  };
  const chosenDeposit = crypto?.candidates.find((d) => d.id === depositId);
  const depositDiff = chosenDeposit && transaction ? chosenDeposit.amountCents + transaction.amount_cents : 0;
  // Explicit split (#107): the user types the invested part; nothing is inferred from the deposit.
  const investCents = parseDollar(investInput);
  const spendRemainder = transaction ? -transaction.amount_cents - investCents : 0;
  const splitValid = !!chosenDeposit && Number.isSafeInteger(investCents) && investCents > 0 && spendRemainder > 0
    && spendCatId !== "" && spendCatId !== TRANSFER_CATEGORY_ID;
  const seenOutflow = transaction && crypto ? {
    transactionId: transaction.id, categoryId: transaction.category_id ?? null, amountCents: transaction.amount_cents, ...crypto.seen,
  } : null;

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
        const hash = "manual_" + globalThis.crypto.randomUUID();
        await db.execute(
          `INSERT INTO transactions
             (account_id, date, amount_cents, description, category_id, notes, import_hash, profile_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [accountId, date, amountCents, desc.trim(), catId, notes.trim() || null, hash, profileId]
        );
        await shiftBalanceAnchorForTransactionChange(accountId as number, null, { date, amountCents });
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
        await shiftBalanceAnchorForTransactionChange(
          transaction!.account_id,
          { date: transaction!.date, amountCents: transaction!.amount_cents },
          { date, amountCents }
        );
        await recomputeCalculatedBalances(transaction!.account_id);
      }
      // A new/edited Crypto or Transfers row (or a changed amount/date) can change portfolio
      // matches (#107). Best effort: the save itself already succeeded.
      await reconcileCryptoTransfers().catch(() => 0);
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
      await shiftBalanceAnchorForTransactionChange(
        transaction.account_id,
        { date: transaction.date, amountCents: transaction.amount_cents },
        null
      );
      await recomputeCalculatedBalances(transaction.account_id);
      await reconcileCryptoTransfers().catch(() => 0);
      onSaved();
      onClose();
    } catch (e) { setError(String(e)); setSaving(false); }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      onClick={onBackdropClick} ref={containerRef}
      role="dialog" aria-modal="true" aria-label="Transaction editor"
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
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] ">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]" />
          </div>

          {isAdd && (
            <div>
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] ">Account</label>
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
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] ">Description</label>
            <input value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder="e.g. Grocery run"
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]" />
          </div>

          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] ">
              Amount (negative = expense)
            </label>
            <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
              placeholder="-45.00"
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]" />
          </div>

          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] ">Category</label>
            <select value={catId} onChange={(e) => setCatId(Number(e.target.value))}
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
              <CategoryOptions categories={categories} />
            </select>
            {catId === 20 && (
              <div className="mt-1.5 flex items-start gap-1.5 text-xs text-[hsl(var(--warning))]">
                <InfoIcon size={12} className="shrink-0 mt-0.5" />
                <span>Transfers are excluded from income and expense totals across all reports and insights.</span>
              </div>
            )}
          </div>

          {transaction && crypto && (crypto.link || crypto.split || crypto.candidates.length > 0 || crypto.rejected) && (
            <div className="rounded-lg border p-3 text-xs space-y-2">
              <div className="font-medium">Crypto portfolio</div>
              {crypto.split && (
                <p>
                  You split the original {formatCurrency(-crypto.split.originalCents)}: {formatCurrency(-crypto.split.investCents)} invested
                  (this row, Transfers) and {formatCurrency(-crypto.split.spendCents)} spending
                  ({categories.find((c) => c.id === crypto.split!.spendCategoryId)?.name ?? "category"}, a separate row with the same date).{" "}
                  <button type="button" disabled={saving} onClick={() => cryptoAction(() => undoCryptoSplit(transaction.id))}
                    className="underline disabled:opacity-50">Undo split</button>
                </p>
              )}
              {crypto.link ? (
                <>
                  <p>
                    {crypto.link.confirmed ? "You confirmed" : "Automatically matched (exact same amount):"} this
                    funded {crypto.link.symbol} {formatCurrency(crypto.link.amountCents)} received {formatDate(crypto.link.date)} in {crypto.link.accountName}
                    {crypto.link.description ? ` (${crypto.link.description})` : ""}.{" "}
                    {crypto.split ? null : <>The full {formatCurrency(transaction.amount_cents)} counts as a transfer, not spending; the amount and balance are unchanged.</>}
                  </p>
                  {!crypto.split && (
                    <button type="button" disabled={saving} onClick={() => cryptoAction(() => undoCryptoTransfer(transaction.id))}
                      className="underline disabled:opacity-50">Undo - not a portfolio deposit</button>
                  )}
                </>
              ) : (
                <>
                  {crypto.rejected && (
                    <p>
                      Kept as spending: never matched automatically.{" "}
                      <button type="button" disabled={saving} onClick={() => cryptoAction(() => allowCryptoMatching(transaction.id))}
                        className="underline disabled:opacity-50">Allow automatic matching</button>
                    </p>
                  )}
                  {crypto.candidates.length > 0 && (
                    <>
                      <label className="block text-[hsl(var(--muted-foreground))]">Did this fund one of these deposits?</label>
                      <select value={depositId} onChange={(e) => { setDepositId(e.target.value ? Number(e.target.value) : ""); setFeeOk(false); }}
                        className="w-full border rounded-lg px-2 py-1.5 bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
                        <option value="">Choose a deposit...</option>
                        {crypto.candidates.map((d) => (
                          <option key={d.id} value={d.id}>
                            {formatDate(d.date)} - {d.symbol} {formatCurrency(d.amountCents)} - {d.accountName}{d.description ? ` - ${d.description}` : ""}
                          </option>
                        ))}
                      </select>
                      {chosenDeposit && depositDiff !== 0 && (
                        <label className="flex items-start gap-1.5">
                          <input type="checkbox" checked={feeOk} onChange={(e) => setFeeOk(e.target.checked)} className="mt-0.5" />
                          <span>
                            The amounts differ by {formatCurrency(Math.abs(depositDiff))}. I confirm the difference is fees or
                            price movement, and the whole {formatCurrency(-transaction.amount_cents)} went to this portfolio.
                          </span>
                        </label>
                      )}
                      <div className="flex gap-3">
                        <button type="button" disabled={saving || !chosenDeposit || (depositDiff !== 0 && !feeOk)}
                          onClick={() => cryptoAction(() => confirmCryptoTransfer(seenOutflow!, chosenDeposit!))}
                          className="underline disabled:opacity-50">Confirm: investment transfer</button>
                        {!crypto.rejected && (
                          <button type="button" disabled={saving} onClick={() => cryptoAction(() => keepCryptoAsSpending(transaction.id))}
                            className="underline disabled:opacity-50">Keep as spending</button>
                        )}
                      </div>
                      {chosenDeposit && (
                        <div className="space-y-1.5 border-t pt-2">
                          <div>Or split it: part invested, the rest spending.</div>
                          <div>Original total: {formatCurrency(-transaction.amount_cents)}</div>
                          <label className="flex items-center gap-1.5">Invested
                            <input type="text" inputMode="decimal" value={investInput} onChange={(e) => setInvestInput(e.target.value)}
                              placeholder="0.00" aria-label="Invested amount" className="w-24 border rounded px-1.5 py-1 bg-[hsl(var(--background))]" />
                          </label>
                          <div>Spending (remainder): {spendRemainder > 0 ? formatCurrency(spendRemainder) : "-"}</div>
                          <select value={spendCatId} onChange={(e) => setSpendCatId(e.target.value ? Number(e.target.value) : "")}
                            aria-label="Spending category" className="w-full border rounded-lg px-2 py-1.5 bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
                            <option value="">Spending category...</option>
                            <CategoryOptions categories={categories.filter((c) => c.id !== TRANSFER_CATEGORY_ID)} />
                          </select>
                          <button type="button" disabled={saving || !splitValid}
                            onClick={() => cryptoAction(() => splitCryptoTransfer(seenOutflow!, chosenDeposit!, investCents, Number(spendCatId)))}
                            className="underline disabled:opacity-50">Confirm split</button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] ">
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
