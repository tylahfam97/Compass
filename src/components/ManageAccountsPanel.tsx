import { useState, useEffect, useCallback } from "react";
import { Pencil, Check, X, Trash2, ChevronDown, ChevronUp, Info, Wallet, Eye, EyeOff, SlidersHorizontal } from "lucide-react";
import {
  getAccountsSummaryForProfile, renameAccount, deleteEmptyAccount, deleteAccountWithData,
  findDuplicateAccountGroups, mergeDuplicateAccounts,
  setAccountHiddenFromDashboard, setAccountExcludedFromInsights,
  type AccountSummary, type DuplicateAccountGroup,
} from "@/lib/db";
import { formatCurrency } from "@/lib/utils";

const TYPE_LABELS: Record<string, string> = {
  checking: "Checking", savings: "Savings", credit: "Credit Card", investment: "Investment", loan: "Loan",
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
  // Deleting a non-empty account is a two-step confirmation (see handleDeleteWithData) -
  // this tracks which account is on the more serious "final" step.
  const [confirmDeleteFinalId, setConfirmDeleteFinalId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
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

  /** Permanently deletes a non-empty account and everything tied to it - reached only after
   *  the two-step confirmation below (see the Trash2 button), since this cannot be undone. */
  const handleDeleteWithData = async (id: number) => {
    setDeleting(true);
    try {
      await deleteAccountWithData(id);
      setConfirmDeleteId(null);
      setConfirmDeleteFinalId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
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

  const toggleHidden = async (a: AccountSummary) => {
    try {
      await setAccountHiddenFromDashboard(a.id, !a.hidden_from_dashboard);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleExcluded = async (a: AccountSummary) => {
    try {
      await setAccountExcludedFromInsights(a.id, !a.excluded_from_insights);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const duplicateCount = duplicateGroups.reduce((s, g) => s + g.accounts.length - 1, 0);

  return (
    <div
      data-tour="manage-accounts"
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
              {accounts.map((a) => {
                const isEmpty = a.txn_count === 0 && a.holdings_count === 0;
                const dataDesc = a.account_type === "investment"
                  ? `${a.holdings_count} holding${a.holdings_count === 1 ? "" : "s"}`
                  : `${a.txn_count} transaction${a.txn_count === 1 ? "" : "s"}`;
                return (
                  <div key={a.id} className="border rounded-lg px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
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
                          <button
                            onClick={() => toggleHidden(a)}
                            title={a.hidden_from_dashboard ? "Show on dashboard/overview" : "Hide from dashboard/overview"}
                            className={a.hidden_from_dashboard ? "text-amber-500" : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"}
                          >
                            {a.hidden_from_dashboard ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                          <button
                            onClick={() => toggleExcluded(a)}
                            title={a.excluded_from_insights ? "Excluded from Insights - click to include" : "Included in Insights - click to exclude"}
                            className={a.excluded_from_insights ? "text-amber-500" : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"}
                          >
                            <SlidersHorizontal size={14} />
                          </button>
                          <button onClick={() => startEdit(a)} title="Rename" className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
                            <Pencil size={14} />
                          </button>
                          {isEmpty ? (
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
                          ) : (
                            <button
                              onClick={() => setConfirmDeleteId(a.id)}
                              title="Delete account and its data"
                              className="text-[hsl(var(--muted-foreground))] hover:text-red-500"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </>
                      )}
                    </div>

                    {/* Non-empty accounts get a two-step confirmation, since this is
                        destructive and permanently clears the account's transactions/holdings. */}
                    {!isEmpty && confirmDeleteId === a.id && (
                      <div className="mt-2 pt-2 border-t space-y-2">
                        {confirmDeleteFinalId === a.id ? (
                          <>
                            <p className="text-xs font-medium text-red-500">
                              Are you absolutely sure? This cannot be undone.
                            </p>
                            <div className="flex items-center gap-3 text-xs">
                              <button
                                onClick={() => handleDeleteWithData(a.id)}
                                disabled={deleting}
                                className="px-2.5 py-1 bg-red-500 text-white rounded-md font-medium hover:bg-red-600 transition-colors disabled:opacity-50"
                              >
                                {deleting ? "Deleting…" : "Yes, delete everything"}
                              </button>
                              <button
                                onClick={() => { setConfirmDeleteId(null); setConfirmDeleteFinalId(null); }}
                                className="hover:underline"
                              >
                                Cancel
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                              <Info size={12} className="shrink-0 mt-0.5" />
                              This account has {dataDesc} - deleting it will permanently remove all of them too.
                            </p>
                            <div className="flex items-center gap-3 text-xs">
                              <button
                                onClick={() => setConfirmDeleteFinalId(a.id)}
                                className="px-2.5 py-1 border border-red-400 text-red-500 rounded-md font-medium hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                              >
                                Continue
                              </button>
                              <button onClick={() => setConfirmDeleteId(null)} className="hover:underline">Cancel</button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
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
