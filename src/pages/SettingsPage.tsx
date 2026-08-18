import { useState } from "react";
import { Link } from "react-router-dom";
import { Download, Upload, CalendarClock, ShieldAlert, AlertTriangle, CheckCircle2 } from "lucide-react";
import { getBalanceAnchorRiskReport, type BalanceAnchorRiskEntry } from "@/lib/db";
import { exportBackup, restoreBackup, getLastBackupAt } from "@/lib/backup";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useProfileStore } from "@/stores/profileStore";

/** Backup/restore and data-integrity tools - a home for app-wide concerns that don't belong on
 *  any single page. Currency is deliberately not configurable here; Compass stays USD-only.
 *  Scheduled bills and income moved to the Plan page, next to the forecast they drive. */
export default function SettingsPage() {
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;

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
  // CRUD now lives in RecurringRulesPanel on the Plan page - see the link below.

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

      {/* ── Scheduled bills & income (lives on the Plan page, linked from here) ─ */}
      <section className="border rounded-2xl p-5">
        <h2 className="font-semibold flex items-center gap-1.5"><CalendarClock size={15} /> Scheduled Bills &amp; Income</h2>
        <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1 max-w-md">
          Recurring bills and paychecks now live on the Plan page, alongside the cash flow
          forecast they feed into.
        </p>
        <Link
          to="/plan"
          className="inline-block mt-3 text-sm px-3 py-1.5 rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90 transition-opacity font-medium"
        >
          Open Plan
        </Link>
      </section>
    </div>
  );
}
