import { useState, useEffect, useRef } from "react";
import { getDb } from "@/lib/db";
import { useProfileStore, getSavedProfileId } from "@/stores/profileStore";
import { useCategoryStore } from "@/stores/categoryStore";
import type { Profile, Category } from "@/lib/types";
import PinModal, { hashPin } from "./PinModal";

const AVATAR_COLORS = [
  "#6366f1", "#ec4899", "#22c55e", "#f59e0b",
  "#06b6d4", "#8b5cf6", "#ef4444", "#f97316",
];

function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");
}

interface ProfileStats {
  txCount: number;
  monthlyNet: number;
}

interface EditState {
  name: string;
  avatar_color: string;
  pinAction: "none" | "set" | "remove";
  pin: string;
  pinConfirm: string;
}

export default function ProfileSwitcher() {
  const { profiles, activeProfile, unlockedIds, setProfiles, setActiveProfile, unlockProfile } =
    useProfileStore();
  const setCategories = useCategoryStore((s) => s.setCategories);

  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<Record<number, ProfileStats>>({});
  const [pinTarget, setPinTarget] = useState<Profile | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(AVATAR_COLORS[0]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Load stats for all profiles when panel opens
  useEffect(() => {
    if (!open || profiles.length === 0) return;
    (async () => {
      const db = await getDb();
      const now = new Date();
      const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
        .toISOString()
        .split("T")[0];

      const newStats: Record<number, ProfileStats> = {};
      await Promise.all(
        profiles.map(async (p) => {
          const [cnt, net] = await Promise.all([
            db.select<{ n: number }[]>(
              "SELECT COUNT(*) as n FROM transactions WHERE profile_id=?",
              [p.id]
            ),
            db.select<{ v: number }[]>(
              "SELECT COALESCE(SUM(amount_cents),0) as v FROM transactions WHERE profile_id=? AND date>=? AND date<?",
              [p.id, start, end]
            ),
          ]);
          newStats[p.id] = {
            txCount: cnt[0]?.n ?? 0,
            monthlyNet: net[0]?.v ?? 0,
          };
        })
      );
      setStats(newStats);
    })();
  }, [open, profiles]);

  const reloadProfiles = async () => {
    const db = await getDb();
    const rows = await db.select<Profile[]>("SELECT * FROM profiles ORDER BY created_at");
    setProfiles(rows);
    return rows;
  };

  const reloadCategories = async (profileId: number) => {
    const db = await getDb();
    const cats = await db.select<Category[]>(
      "SELECT * FROM categories WHERE is_system=1 OR profile_id=? ORDER BY name",
      [profileId]
    );
    setCategories(cats);
  };

  const switchTo = async (profile: Profile) => {
    const needsPin =
      profile.pin_hash &&
      !unlockedIds.has(profile.id) &&
      profile.id !== activeProfile?.id;
    if (needsPin) {
      setPinTarget(profile);
      return;
    }
    setActiveProfile(profile);
    await reloadCategories(profile.id);
    setOpen(false);
  };

  const onPinSuccess = async () => {
    if (!pinTarget) return;
    unlockProfile(pinTarget.id);
    setActiveProfile(pinTarget);
    await reloadCategories(pinTarget.id);
    setPinTarget(null);
    setOpen(false);
  };

  const createProfile = async () => {
    const name = newName.trim();
    if (!name || saving) return;
    setSaving(true);
    const db = await getDb();
    await db.execute(
      "INSERT INTO profiles (name, avatar_color) VALUES (?, ?)",
      [name.slice(0, 32), newColor]
    );
    const rows = await reloadProfiles();
    // Switch to newly created profile
    const newest = rows[rows.length - 1];
    if (newest) {
      setActiveProfile(newest);
      await reloadCategories(newest.id);
    }
    setNewName("");
    setNewColor(AVATAR_COLORS[0]);
    setAddingNew(false);
    setSaving(false);
    setOpen(false);
  };

  const startEdit = (profile: Profile) => {
    setEditingId(profile.id);
    setEditState({
      name: profile.name,
      avatar_color: profile.avatar_color,
      pinAction: "none",
      pin: "",
      pinConfirm: "",
    });
    setDeleteConfirm(null);
  };

  const saveEdit = async () => {
    if (!editState || editingId === null || saving) return;
    const name = editState.name.trim();
    if (!name) return;
    setSaving(true);
    const db = await getDb();

    let pin_hash: string | null | undefined;
    if (editState.pinAction === "set") {
      if (
        editState.pin.length < 4 ||
        editState.pin !== editState.pinConfirm
      ) {
        setSaving(false);
        return;
      }
      const profile = profiles.find((p) => p.id === editingId);
      if (!profile) { setSaving(false); return; }
      pin_hash = await hashPin(editState.pin, profile.created_at);
    } else if (editState.pinAction === "remove") {
      pin_hash = null;
    }

    if (pin_hash !== undefined) {
      await db.execute(
        "UPDATE profiles SET name=?, avatar_color=?, pin_hash=? WHERE id=?",
        [name.slice(0, 32), editState.avatar_color, pin_hash, editingId]
      );
    } else {
      await db.execute(
        "UPDATE profiles SET name=?, avatar_color=? WHERE id=?",
        [name.slice(0, 32), editState.avatar_color, editingId]
      );
    }

    await reloadProfiles();
    // If editing active profile, refresh it in store
    if (activeProfile?.id === editingId) {
      const rows = await db.select<Profile[]>(
        "SELECT * FROM profiles WHERE id=?",
        [editingId]
      );
      if (rows[0]) setActiveProfile(rows[0]);
    }
    setEditingId(null);
    setEditState(null);
    setSaving(false);
  };

  const deleteProfile = async (id: number) => {
    if (profiles.length <= 1) return; // can't delete last profile
    setSaving(true);
    const db = await getDb();
    // Cascade delete profile data
    await db.execute("DELETE FROM transactions WHERE profile_id=?", [id]);
    await db.execute("DELETE FROM budgets WHERE profile_id=?", [id]);
    await db.execute("DELETE FROM goals WHERE profile_id=?", [id]);
    await db.execute("DELETE FROM accounts WHERE profile_id=?", [id]);
    await db.execute("DELETE FROM categories WHERE profile_id=?", [id]);
    await db.execute("DELETE FROM column_profiles WHERE profile_id=?", [id]);
    await db.execute("DELETE FROM profiles WHERE id=?", [id]);

    const rows = await reloadProfiles();
    if (activeProfile?.id === id) {
      const fallback = rows[0];
      if (fallback) {
        setActiveProfile(fallback);
        await reloadCategories(fallback.id);
      }
    }
    setDeleteConfirm(null);
    setSaving(false);
  };

  if (!activeProfile) return null;

  const initials = getInitials(activeProfile.name);

  return (
    <>
      {/* Trigger */}
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl
                   hover:bg-[hsl(var(--border))] transition-colors text-left group"
      >
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-white
                     text-xs font-bold shrink-0"
          style={{ backgroundColor: activeProfile.avatar_color }}
        >
          {initials}
        </div>
        <span className="text-sm font-medium truncate flex-1">{activeProfile.name}</span>
        <svg className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))] shrink-0"
          viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5"
            fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Panel overlay */}
      {open && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div
            ref={panelRef}
            className="bg-[hsl(var(--background))] border rounded-2xl shadow-2xl w-96 max-h-[80vh]
                       overflow-y-scroll flex flex-col"
          >
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <h2 className="font-semibold">Profiles</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                           transition-colors text-lg leading-none"
              >
                ×
              </button>
            </div>

            <div className="p-3 space-y-2">
              {profiles.map((p) => {
                const isActive = p.id === activeProfile.id;
                const isEditing = editingId === p.id;
                const pStats = stats[p.id];

                return (
                  <div
                    key={p.id}
                    className={`border rounded-xl overflow-hidden transition-colors
                      ${isActive ? "border-[hsl(var(--primary))]" : ""}`}
                  >
                    {/* Profile card header */}
                    <div className="flex items-center gap-3 p-3">
                      <div
                        className="w-10 h-10 rounded-full flex items-center justify-center
                                   text-white text-sm font-bold shrink-0"
                        style={{ backgroundColor: p.avatar_color }}
                      >
                        {getInitials(p.name)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="font-medium text-sm truncate">{p.name}</p>
                          {p.pin_hash && (
                            <svg className="w-3 h-3 text-[hsl(var(--muted-foreground))] shrink-0"
                              viewBox="0 0 16 16" fill="currentColor">
                              <path fillRule="evenodd" d="M8 1a3 3 0 00-3 3v1H4a1 1 0 00-1 1v7a1 1 0 001 1h8a1 1 0 001-1V6a1 1 0 00-1-1H11V4a3 3 0 00-3-3zm1 9.5V12H7v-1.5a1.5 1.5 0 112 0zM9 4v1H7V4a1 1 0 112 0z" />
                            </svg>
                          )}
                          {isActive && (
                            <span className="text-xs text-[hsl(var(--primary))] font-medium">Active</span>
                          )}
                        </div>
                        {pStats && (
                          <p className="text-xs text-[hsl(var(--muted-foreground))]">
                            {pStats.txCount.toLocaleString()} txns
                            {" · "}
                            <span className={pStats.monthlyNet >= 0 ? "text-green-600" : "text-red-500"}>
                              {pStats.monthlyNet >= 0 ? "+" : ""}
                              {(pStats.monthlyNet / 100).toLocaleString("en-US", {
                                style: "currency", currency: "USD", maximumFractionDigits: 0,
                              })} this month
                            </span>
                          </p>
                        )}
                      </div>
                      {/* Actions */}
                      <div className="flex items-center gap-1.5 shrink-0">
                        {!isActive && (
                          <button
                            onClick={() => switchTo(p)}
                            className="text-xs px-2.5 py-1 border rounded-lg
                                       hover:bg-[hsl(var(--muted))] transition-colors"
                          >
                            Switch
                          </button>
                        )}
                        <button
                          onClick={() => isEditing ? (setEditingId(null), setEditState(null)) : startEdit(p)}
                          className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                                     px-1.5 transition-colors"
                        >
                          {isEditing ? "Cancel" : "Edit"}
                        </button>
                        {profiles.length > 1 && (
                          <button
                            onClick={() =>
                              deleteConfirm === p.id
                                ? deleteProfile(p.id)
                                : setDeleteConfirm(p.id)
                            }
                            className={`text-xs px-1.5 transition-colors ${
                              deleteConfirm === p.id
                                ? "text-red-500 font-medium"
                                : "text-[hsl(var(--muted-foreground))] hover:text-red-500"
                            }`}
                          >
                            {deleteConfirm === p.id ? "Confirm?" : "Delete"}
                          </button>
                        )}
                        {deleteConfirm === p.id && (
                          <button
                            onClick={() => setDeleteConfirm(null)}
                            className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                                       px-1.5 transition-colors"
                          >
                            No
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Edit form */}
                    {isEditing && editState && (
                      <div className="border-t px-3 pb-3 pt-2 space-y-3 bg-[hsl(var(--muted))]/30">
                        <input
                          type="text"
                          maxLength={32}
                          value={editState.name}
                          onChange={(e) =>
                            setEditState((s) => s && ({ ...s, name: e.target.value }))
                          }
                          className="w-full border rounded-lg px-3 py-1.5 text-sm
                                     bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
                          placeholder="Profile name"
                        />

                        {/* Color picker */}
                        <div className="flex gap-1.5 flex-wrap">
                          {AVATAR_COLORS.map((c) => (
                            <button
                              key={c}
                              onClick={() => setEditState((s) => s && ({ ...s, avatar_color: c }))}
                              className={`w-6 h-6 rounded-full transition-transform
                                ${editState.avatar_color === c ? "scale-125 ring-2 ring-offset-1 ring-[hsl(var(--foreground))]" : ""}`}
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>

                        {/* PIN section */}
                        <div className="space-y-1.5">
                          <p className="text-xs text-[hsl(var(--muted-foreground))]">PIN protection</p>
                          <div className="flex gap-2">
                            {(["none", "set", "remove"] as const).map((a) => (
                              <button
                                key={a}
                                onClick={() =>
                                  setEditState((s) =>
                                    s && ({ ...s, pinAction: a, pin: "", pinConfirm: "" })
                                  )
                                }
                                disabled={a === "remove" && !p.pin_hash}
                                className={`text-xs px-2.5 py-1 border rounded-lg transition-colors disabled:opacity-40
                                  ${editState.pinAction === a
                                    ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent"
                                    : "hover:bg-[hsl(var(--muted))]"}`}
                              >
                                {a === "none" ? "No change" : a === "set" ? (p.pin_hash ? "Change PIN" : "Set PIN") : "Remove PIN"}
                              </button>
                            ))}
                          </div>
                          {editState.pinAction === "set" && (
                            <div className="space-y-2">
                              <input
                                type="password"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                maxLength={6}
                                value={editState.pin}
                                onChange={(e) =>
                                  setEditState((s) =>
                                    s && ({ ...s, pin: e.target.value.replace(/\D/g, "") })
                                  )
                                }
                                placeholder="New PIN (4–6 digits)"
                                className="w-full border rounded-lg px-3 py-1.5 text-sm
                                           bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                                           placeholder:text-[hsl(var(--muted-foreground))]"
                              />
                              <input
                                type="password"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                maxLength={6}
                                value={editState.pinConfirm}
                                onChange={(e) =>
                                  setEditState((s) =>
                                    s && ({ ...s, pinConfirm: e.target.value.replace(/\D/g, "") })
                                  )
                                }
                                placeholder="Confirm PIN"
                                className="w-full border rounded-lg px-3 py-1.5 text-sm
                                           bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                                           placeholder:text-[hsl(var(--muted-foreground))]"
                              />
                            </div>
                          )}
                          {editState.pinAction === "set" &&
                            editState.pin.length >= 4 &&
                            editState.pin !== editState.pinConfirm && (
                              <p className="text-xs text-red-500">PINs do not match.</p>
                            )}
                        </div>

                        <button
                          onClick={saveEdit}
                          disabled={saving}
                          className="w-full py-1.5 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                                     rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90
                                     transition-opacity"
                        >
                          {saving ? "Saving…" : "Save changes"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Add new profile */}
            <div className="border-t p-3">
              {addingNew ? (
                <div className="space-y-2">
                  <input
                    autoFocus
                    type="text"
                    maxLength={32}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && createProfile()}
                    placeholder="Profile name"
                    className="w-full border rounded-lg px-3 py-2 text-sm
                               bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                               placeholder:text-[hsl(var(--muted-foreground))]"
                  />
                  <div className="flex gap-1.5 flex-wrap">
                    {AVATAR_COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => setNewColor(c)}
                        className={`w-6 h-6 rounded-full transition-transform
                          ${newColor === c ? "scale-125 ring-2 ring-offset-1 ring-[hsl(var(--foreground))]" : ""}`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={createProfile}
                      disabled={!newName.trim() || saving}
                      className="flex-1 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                                 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90
                                 transition-opacity"
                    >
                      {saving ? "Creating…" : "Create"}
                    </button>
                    <button
                      onClick={() => { setAddingNew(false); setNewName(""); }}
                      className="px-4 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))]
                                 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setAddingNew(true)}
                  className="w-full py-2 border border-dashed rounded-xl text-sm
                             text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                             hover:border-[hsl(var(--foreground))] transition-colors"
                >
                  + Add profile
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* PIN prompt */}
      {pinTarget && (
        <PinModal
          profile={pinTarget}
          onSuccess={onPinSuccess}
          onCancel={() => setPinTarget(null)}
        />
      )}
    </>
  );
}

/** Bootstrap: load all profiles from DB and set active profile from localStorage. */
export async function bootstrapProfiles(
  setProfiles: (p: Profile[]) => void,
  setActiveProfile: (p: Profile) => void,
  setCategories: (c: Category[]) => void
) {
  const db = await getDb();
  const profiles = await db.select<Profile[]>(
    "SELECT * FROM profiles ORDER BY created_at"
  );
  if (profiles.length === 0) return;
  setProfiles(profiles);

  const savedId = getSavedProfileId();
  const active =
    profiles.find((p) => p.id === savedId) ?? profiles[0];
  setActiveProfile(active);

  const cats = await db.select<Category[]>(
    "SELECT * FROM categories WHERE is_system=1 OR profile_id=? ORDER BY name",
    [active.id]
  );
  setCategories(cats);
}
