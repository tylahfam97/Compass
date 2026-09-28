import { useState, useEffect, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import ScopeToggle from "@/components/ScopeToggle";
import PinModal from "@/components/PinModal";
import ManageAccountsPanel from "@/components/ManageAccountsPanel";
import LockedProfilesNotice from "@/components/LockedProfilesNotice";
import SectionHeading from "@/components/SectionHeading";
import EmptyState from "@/components/EmptyState";
import Soundings from "@/components/Soundings";
import AccountRoster from "@/components/AccountRoster";
import { Skeleton } from "@/components/Skeleton";
import { staggerContainer, riseIn } from "@/lib/motionPresets";
import { getOverviewAccounts, getSoundingHistory, standingsByProfile, type OverviewAccount } from "@/lib/overviewData";
import { soundings, type Sounding } from "@/lib/soundings";
import { toISODate } from "@/lib/forecast";
import { formatCurrency } from "@/lib/utils";
import { useProfileStore } from "@/stores/profileStore";
import { handleLoadFailure } from "@/stores/toastStore";
import type { Profile } from "@/lib/types";

/** Months of history the soundings are taken over. */
const HISTORY_MONTHS = 24;

function viewModeKey(profileId: number) {
  return `compass_overview_view_${profileId}`;
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const { profiles, setActiveProfile, activeProfile, unlockedIds, unlockProfile } = useProfileStore();
  const profileId = activeProfile?.id ?? profiles[0]?.id ?? 1;

  const [accounts, setAccounts] = useState<OverviewAccount[]>([]);
  const [sounding, setSounding] = useState<Sounding | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  const [viewMode, setViewMode] = useState<"profile" | "global">(() =>
    localStorage.getItem(viewModeKey(profileId)) === "global" ? "global" : "profile"
  );
  const [pinQueue, setPinQueue] = useState<Profile[]>([]);
  const [pinQueueIdx, setPinQueueIdx] = useState(0);

  useEffect(() => {
    setViewMode(localStorage.getItem(viewModeKey(profileId)) === "global" ? "global" : "profile");
  }, [profileId]);

  const unlockedProfileIds = useMemo(
    () => profiles.filter((p) => !p.pin_hash || p.id === profileId || unlockedIds.has(p.id)).map((p) => p.id),
    [profiles, profileId, unlockedIds]
  );

  const handleSwitchToGlobal = () => {
    const locked = profiles.filter((p) => p.pin_hash && p.id !== profileId && !unlockedIds.has(p.id));
    if (locked.length > 0) { setPinQueue(locked); setPinQueueIdx(0); }
    else { localStorage.setItem(viewModeKey(profileId), "global"); setViewMode("global"); }
  };
  const handleSwitchToProfile = () => { localStorage.setItem(viewModeKey(profileId), "profile"); setViewMode("profile"); };
  const advancePinQueue = (unlockedId?: number) => {
    if (unlockedId !== undefined) unlockProfile(unlockedId);
    const next = pinQueueIdx + 1;
    if (next >= pinQueue.length) {
      setPinQueue([]); setPinQueueIdx(0);
      localStorage.setItem(viewModeKey(profileId), "global"); setViewMode("global");
    } else { setPinQueueIdx(next); }
  };

  const isGlobalActive = viewMode === "global";
  const pinTarget = pinQueue.length > 0 && pinQueueIdx < pinQueue.length ? pinQueue[pinQueueIdx] : null;

  const visibleProfiles = useMemo(
    () => isGlobalActive ? profiles.filter((p) => unlockedProfileIds.includes(p.id)) : profiles.filter((p) => p.id === profileId),
    [isGlobalActive, profiles, unlockedProfileIds, profileId]
  );

  const lockedExcluded = isGlobalActive
    ? profiles.filter((p) => p.pin_hash && p.id !== profileId && !unlockedIds.has(p.id))
    : [];

  useEffect(() => {
    const ids = visibleProfiles.map((p) => p.id);
    if (ids.length === 0) { setAccounts([]); setSounding(null); setLoading(false); return; }
    setLoading(true);
    let cancelled = false;
    (async () => {
      const [roster, history] = await Promise.all([
        getOverviewAccounts(ids),
        getSoundingHistory(ids, HISTORY_MONTHS, toISODate(new Date())),
      ]);
      if (cancelled) return;
      setAccounts(roster);
      setSounding(soundings(history));
      setLoading(false);
    })().catch(handleLoadFailure("your account overview", setLoading, () => setReloadTick((t) => t + 1)));
    return () => { cancelled = true; };
  }, [visibleProfiles, reloadTick]);

  const standings = useMemo(
    () => standingsByProfile(accounts, visibleProfiles.map((p) => p.id)),
    [accounts, visibleProfiles]
  );
  const profileNames = useMemo(
    () => new Map(visibleProfiles.map((p) => [p.id, p.name] as const)),
    [visibleProfiles]
  );

  const otherProfiles = profiles.filter((p) => p.id !== profileId);
  const hasReadings = sounding !== null && sounding.latest !== null;

  function handleSwitch(profile: Profile) {
    setActiveProfile(profile);
    navigate("/");
  }

  return (
    <div className="workspace-page overview-workspace overview-grid">
      {pinTarget && (
        <PinModal profile={pinTarget} onSuccess={() => advancePinQueue(pinTarget.id)} onCancel={() => advancePinQueue()} />
      )}

      <div className="workspace-heading overview-heading">
        <div>
          <h1>Overview</h1>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
            {isGlobalActive
              ? `${visibleProfiles.length} of ${profiles.length} profile${profiles.length !== 1 ? "s" : ""} combined`
              : `Every account in ${activeProfile?.name ?? "this profile"}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium select-none" style={{ color: !isGlobalActive ? "hsl(var(--gold-ink))" : "hsl(var(--muted-foreground))", transition: "color 0.3s" }}>
            Profile
          </span>
          <ScopeToggle isGlobal={isGlobalActive} onToggle={() => isGlobalActive ? handleSwitchToProfile() : handleSwitchToGlobal()} />
          <span className="text-sm font-medium select-none" style={{ color: isGlobalActive ? "hsl(var(--gold-ink))" : "hsl(var(--muted-foreground))", transition: "color 0.3s" }}>
            Global
          </span>
        </div>
      </div>

      {loading && (
        <div className="overview-sounding space-y-6">
          <Skeleton className="h-28" />
          <Skeleton className="h-56" />
        </div>
      )}

      {!loading && !hasReadings && (
        <div className="overview-sounding">
          <EmptyState
            title="No soundings yet"
            actions={
              <Link to="/import" className="px-4 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-md text-sm font-medium hover:opacity-90 transition-opacity">
                Import transactions
              </Link>
            }
          >
            Compass takes a sounding of what you own and what you owe from every statement you import. One import places the first mark.
          </EmptyState>
        </div>
      )}

      {!loading && hasReadings && sounding && (
        <motion.section className="overview-sounding" variants={staggerContainer} initial="hidden" animate="show" aria-label="Net worth">
          <motion.div variants={riseIn}>
            <Soundings
              sounding={sounding}
              scopeLabel={isGlobalActive ? "Combined, unlocked profiles" : "This profile"}
            />
          </motion.div>
          {lockedExcluded.length > 0 && (
            <motion.div variants={riseIn} className="mt-5">
              <LockedProfilesNotice
                profiles={lockedExcluded}
                onUnlock={(p) => { setPinQueue([p]); setPinQueueIdx(0); }}
                context="excluded from the figures above."
              />
            </motion.div>
          )}
        </motion.section>
      )}

      {!loading && accounts.length > 0 && (
        <section className="overview-accounts">
          <SectionHeading title="Accounts" hint="Every account in scope, and the date each balance was recorded" />
          <div className="mt-3">
            <AccountRoster accounts={accounts} profileNames={profileNames} />
          </div>
        </section>
      )}

      {!loading && isGlobalActive && visibleProfiles.length > 0 && (
        <section className="overview-people">
          <SectionHeading title="Profiles" hint="Each profile's own standing inside the combined figures" />
          <div className="overview-profiles">
            {visibleProfiles.map((p) => {
              const st = standings.get(p.id);
              return (
                <div key={p.id} className="profile-row">
                  <div className="flex items-center gap-2.5">
                    <span className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0" style={{ backgroundColor: p.avatar_color }}>
                      {p.name.charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{p.name}</p>
                      <p className="text-xs text-[hsl(var(--muted-foreground))]">
                        {st?.accountCount ?? 0} {st?.accountCount === 1 ? "account" : "accounts"}
                      </p>
                    </div>
                    {p.id === profileId ? (
                      <span className="ml-auto text-xs text-[hsl(var(--muted-foreground))]">Active</span>
                    ) : (
                      <button type="button" onClick={() => handleSwitch(p)} className="ml-auto text-xs px-2.5 py-1 border rounded-md hover:bg-[hsl(var(--muted))] transition-colors shrink-0">
                        Switch
                      </button>
                    )}
                  </div>
                  <div className="profile-figures">
                    <div><p>Cash</p><strong>{formatCurrency(st?.liquidCents ?? 0)}</strong></div>
                    <div><p>Invested</p><strong>{formatCurrency(st?.investmentCents ?? 0)}</strong></div>
                    <div><p>Owed</p><strong>{formatCurrency(Math.abs(st?.owedCents ?? 0))}</strong></div>
                    <div>
                      <p>Net</p>
                      <strong style={{ color: (st?.netWorthCents ?? 0) >= 0 ? "hsl(var(--success))" : "hsl(var(--error))" }}>
                        {formatCurrency(st?.netWorthCents ?? 0)}
                      </strong>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {!loading && !isGlobalActive && otherProfiles.length > 0 && (
        <section className="overview-people">
          <SectionHeading title="Other profiles" hint="Switch to one, or use the Global toggle to combine them" />
          <div className="flex flex-wrap gap-2 mt-3">
            {otherProfiles.map((p) => (
              <button key={p.id} type="button" onClick={() => handleSwitch(p)} className="flex items-center gap-2 text-sm px-3 py-1.5 border rounded-md hover:bg-[hsl(var(--muted))] transition-colors">
                <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0" style={{ backgroundColor: p.avatar_color }}>
                  {p.name.charAt(0).toUpperCase()}
                </span>
                {p.name}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="overview-manage">
        <ManageAccountsPanel profileId={profileId} />
      </div>
    </div>
  );
}
