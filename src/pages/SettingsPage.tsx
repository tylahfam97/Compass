import { useState } from "react";
import { Link } from "react-router-dom";
import { Download, Upload, CalendarClock, ShieldAlert, AlertTriangle, CheckCircle2, Sparkles, Eye, Trash2 } from "lucide-react";
import { getBalanceAnchorRiskReport, deleteAllProfileData, type BalanceAnchorRiskEntry } from "@/lib/db";
import { exportBackup, restoreBackup, getLastBackupAt } from "@/lib/backup";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useProfileStore } from "@/stores/profileStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { toast } from "@/stores/toastStore";

/** Backup/restore and data-integrity tools - a home for app-wide concerns that don't belong on
 *  any single page. Currency is deliberately not configurable here; Compass stays USD-only.
 *  Scheduled bills and income moved to the Plan page, next to the forecast they drive. */
export default function SettingsPage() {
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;
  const motionPref = useSettingsStore((s) => s.motionPref);
  const setMotionPref = useSettingsStore((s) => s.setMotionPref);
  const restartOnboarding = useOnboardingStore((s) => s.restart);

  // ── Danger zone ──────────────────────────────────────────────────────────
  const [eraseConfirmText, setEraseConfirmText] = useState("");
  const [eraseOpen, setEraseOpen] = useState(false);
  const [erasing, setErasing] = useState(false);

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

  const handleErase = async () => {
    if (eraseConfirmText !== "ERASE") return;
    setErasing(true);
    try {
      await deleteAllProfileData(profileId);
      setEraseOpen(false);
      setEraseConfirmText("");
      toast.success("This profile's data has been erased. Reloading…");
      // Every page holds its own cached copy of this profile's data, so a reload is the only
      // honest way to show an empty app rather than stale figures.
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      toast.error(`Couldn't erase this profile's data: ${String(e)}`);
      setErasing(false);
    }
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

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
          Backup and restore, data integrity checks, and app-wide preferences.
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

      {/* ── Appearance & guidance ────────────────────────────────────────── */}
      <section className="border rounded-2xl p-5 space-y-4">
        <div>
          <h2 className="font-semibold flex items-center gap-1.5"><Eye size={15} /> Appearance &amp; Guidance</h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1 max-w-md">
            Compass already follows your system's reduce-motion setting. Turn it on here if you
            want calmer animation in this app only.
          </p>
        </div>

        <label className="flex items-center gap-2.5 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={motionPref === "reduced"}
            onChange={(e) => setMotionPref(e.target.checked ? "reduced" : "system")}
          />
          Reduce motion in Compass
        </label>

        <div className="pt-1">
          <button
            onClick={() => { restartOnboarding(); toast.info("Tour restarted - head to the Dashboard to begin."); }}
            className="text-sm px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))] transition-colors flex items-center gap-1.5"
          >
            <Sparkles size={14} /> Replay the guided tour
          </button>
        </div>
      </section>

      {/* ── Danger zone ──────────────────────────────────────────────────── */}
      <section className="border rounded-2xl p-5 space-y-3" style={{ borderColor: "hsl(var(--error))" }}>
        <div>
          <h2 className="font-semibold flex items-center gap-1.5" style={{ color: "hsl(var(--error))" }}>
            <Trash2 size={15} /> Erase this profile's data
          </h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1 max-w-md">
            Permanently deletes every transaction, account, budget, goal, scheduled item and
            custom category belonging to <span className="font-medium">{activeProfile?.name ?? "this profile"}</span>.
            The profile itself stays. Your other profiles are untouched.
          </p>
          <p className="text-xs mt-2 max-w-md" style={{ color: "hsl(var(--error))" }}>
            This cannot be undone. Export a backup first if there's any chance you'll want it back.
          </p>
        </div>

        {!eraseOpen ? (
          <button
            onClick={() => { setEraseOpen(true); setEraseConfirmText(""); }}
            className="text-sm px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))] transition-colors"
            style={{ borderColor: "hsl(var(--error))", color: "hsl(var(--error))" }}
          >
            Erase data…
          </button>
        ) : (
          <div className="space-y-2">
            <label className="block text-xs">
              Type <span className="font-mono font-semibold">ERASE</span> to confirm
              <input
                value={eraseConfirmText}
                onChange={(e) => setEraseConfirmText(e.target.value)}
                className="mt-1 w-48 border rounded-lg px-2.5 py-1.5 text-sm bg-[hsl(var(--background))]"
                autoFocus
              />
            </label>
            <div className="flex items-center gap-2">
              <button
                onClick={handleErase}
                disabled={eraseConfirmText !== "ERASE" || erasing}
                className="text-sm px-3 py-1.5 rounded-lg font-medium text-white disabled:opacity-40"
                style={{ backgroundColor: "hsl(var(--error))" }}
              >
                {erasing ? "Erasing…" : "Erase everything"}
              </button>
              <button
                onClick={() => { setEraseOpen(false); setEraseConfirmText(""); }}
                className="text-sm px-3 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
