import { useState, useEffect, useCallback } from "react";
import { Pencil, Check, X, Trash2, ChevronDown, ChevronUp, Info, Wallet } from "lucide-react";
import {
  getAccountsSummaryForProfile, renameAccount, deleteEmptyAccount,
  findDuplicateAccountGroups, mergeDuplicateAccounts,
  type AccountSummary, type DuplicateAccountGroup,
} from "@/lib/db";
import { formatCurrency } from "@/lib/utils";

const TYPE_LABELS: Record<string, string> = {
  checking: "Checking", savings: "Savings", credit: "Credit Card", investment: "Investment",
};

interface Props {
  profileId: number;
  /** Gives the panel a quiet gold accent (border + icon) and opens it by default -
   *  for when it's the featured element on a page, without adding any animation/motion. */
  special?: boolean;
}

/**
 * Lists every account (checking/credit/investment) identified from this profile's imported or
 * manually-entered transactions, with the ability to rename them or clean up duplicates -
 * unrelated to Profiles (separate people/entities), which are managed via the profile switcher.
 */
export default function ManageAccountsPanel({ profileId, special = false }: Props) {
  const [open, setOpen] = useState(special);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateAccountGroup[]>([]);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accts, dupes] = await Promise.all([
        getAccountsSummaryForProfile(profileId),
        findDuplicateAccountGroups(profileId),
      ]);
      setAccounts(accts);
      setDuplicateGroups(dupes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    if (open) load().catch(console.error);
  }, [open, load]);

  const startEdit = (a: AccountSummary) => {
    setEditingId(a.id);
    setEditName(a.name);
    setError(null);
  };

  const saveEdit = async () => {
    if (editingId == null) return;
    try {
      await renameAccount(editingId, editName);
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteEmptyAccount(id);
      setConfirmDeleteId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleMerge = async () => {
    try {
      await mergeDuplicateAccounts(profileId);
      setConfirmMerge(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const duplicateCount = duplicateGroups.reduce((s, g) => s + g.accounts.length - 1, 0);

  return (
    <div
      className={`border rounded-xl ${special ? "border-2" : ""}`}
      style={special ? { borderColor: "var(--gold)", backgroundColor: "hsl(var(--primary)/0.02)" } : undefined}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between p-4 text-left"
      >
        <span className="font-semibold text-sm flex items-center gap-2">
          {special && <Wallet size={16} style={{ color: "var(--gold)" }} />}
          Manage Accounts
        </span>
        {open ? <ChevronUp size={16} className="text-[hsl(var(--muted-foreground))]" /> : <ChevronDown size={16} className="text-[hsl(var(--muted-foreground))]" />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-xs text-[hsl(var(--muted-foreground))] flex items-start gap-1.5 border-t pt-3">
            <Info size={12} className="shrink-0 mt-0.5" />
            These are the individual accounts (checking, credit cards, investments) identified from
            this profile&apos;s imported or manually-entered transactions - not related to Profiles.
            Use the profile switcher for separate people or entities.
          </p>

          {error && <p className="text-xs text-red-500">{error}</p>}

          {loading ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Loading…</p>
          ) : accounts.length === 0 ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">No accounts yet - import a statement to create one.</p>
          ) : (
            <div className="space-y-1.5">
              {accounts.map((a) => (
                <div key={a.id} className="flex items-center gap-2 border rounded-lg px-3 py-2 text-sm">
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full border font-medium shrink-0 text-[hsl(var(--muted-foreground))]">
                    {TYPE_LABELS[a.account_type] ?? a.account_type}
                  </span>
                  {editingId === a.id ? (
                    <>
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        autoFocus
                        className="flex-1 border rounded-md px-2 py-1 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
                      />
                      <button onClick={saveEdit} title="Save" className="text-green-600 hover:opacity-80"><Check size={16} /></button>
                      <button onClick={() => setEditingId(null)} title="Cancel" className="text-[hsl(var(--muted-foreground))] hover:opacity-80"><X size={16} /></button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 truncate">{a.name}</span>
                      <span className="text-xs text-[hsl(var(--muted-foreground))] shrink-0">
                        {a.account_type === "investment"
                          ? `${a.holdings_count} holding${a.holdings_count === 1 ? "" : "s"}`
                          : a.balance_cents != null
                            ? formatCurrency(a.balance_cents)
                            : `${a.txn_count} txn${a.txn_count === 1 ? "" : "s"}`}
                      </span>
                      <button onClick={() => startEdit(a)} title="Rename" className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
                        <Pencil size={14} />
                      </button>
                      {a.txn_count === 0 && a.holdings_count === 0 && (
                        confirmDeleteId === a.id ? (
                          <span className="flex items-center gap-1 text-xs shrink-0">
                            <button onClick={() => handleDelete(a.id)} className="text-red-500 font-medium hover:underline">Delete?</button>
                            <button onClick={() => setConfirmDeleteId(null)} className="hover:underline">No</button>
                          </span>
                        ) : (
                          <button onClick={() => setConfirmDeleteId(a.id)} title="Delete empty account" className="text-[hsl(var(--muted-foreground))] hover:text-red-500">
                            <Trash2 size={14} />
                          </button>
                        )
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {duplicateGroups.length > 0 && (
            <div className="pt-2 border-t space-y-2">
              <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                <Info size={12} className="shrink-0 mt-0.5" />
                Found {duplicateCount} duplicate account{duplicateCount === 1 ? "" : "s"} (same type + name) -
                merging combines their transactions/holdings into a single account.
              </p>
              {confirmMerge ? (
                <div className="flex items-center gap-2 text-xs">
                  <span>Merge {duplicateGroups.length} duplicate group{duplicateGroups.length === 1 ? "" : "s"}?</span>
                  <button onClick={handleMerge} className="text-amber-600 font-medium hover:underline">Yes, merge</button>
                  <button onClick={() => setConfirmMerge(false)} className="hover:underline">Cancel</button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmMerge(true)}
                  className="text-xs px-3 py-1.5 rounded-lg border hover:bg-[hsl(var(--muted))] transition-colors"
                >
                  Merge duplicate accounts
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
