import { useState, useRef, useEffect } from "react";
import { motion } from "motion/react";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import type { Profile } from "@/lib/types";

const COOLDOWN_SECS = 10;

/**
 * Failed attempts and the running cooldown per profile, for this launch. Held outside the
 * component because Cancel unmounts the dialog: with the count in component state, closing and
 * reopening it handed out a fresh three guesses every time, so the limit limited nothing.
 */
const lockouts = new Map<number, { attempts: number; until: number }>();

/** Seconds of cooldown still to run for a profile (0 when none). */
export function lockoutSecondsLeft(profileId: number, now = Date.now()): number {
  const until = lockouts.get(profileId)?.until ?? 0;
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** Records a wrong PIN; the third starts the cooldown. Returns the attempts used so far. */
export function recordFailedPin(profileId: number, now = Date.now()): number {
  const attempts = (lockouts.get(profileId)?.attempts ?? 0) + 1;
  lockouts.set(profileId, { attempts, until: attempts >= 3 ? now + COOLDOWN_SECS * 1000 : 0 });
  return attempts;
}

/** Attempts already used, forgetting a cooldown that has fully run out. */
export function failedPinAttempts(profileId: number, now = Date.now()): number {
  const lock = lockouts.get(profileId);
  if (!lock) return 0;
  if (lock.attempts >= 3 && lock.until <= now) { lockouts.delete(profileId); return 0; }
  return lock.attempts;
}

export function clearPinLockout(profileId: number): void {
  lockouts.delete(profileId);
}

/**
 * Hashes a PIN using PBKDF2-SHA-256 (260 000 iterations).
 * The returned string is prefixed with "pbkdf2$" so legacy SHA-256
 * hashes stored in the database can be distinguished.
 */
export async function hashPin(pin: string, salt: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 260000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const hex = Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `pbkdf2$${hex}`;
}

/** SHA-256 fallback for PINs set before the PBKDF2 upgrade. */
async function legacySha256Pin(pin: string, salt: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(pin + salt)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verifies a PIN against a stored hash.
 * Accepts both new PBKDF2 hashes (prefixed "pbkdf2$") and legacy SHA-256 hashes.
 */
async function verifyPin(pin: string, salt: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith("pbkdf2$")) {
    return (await hashPin(pin, salt)) === storedHash;
  }
  // Backward compatibility: hashes set before the PBKDF2 upgrade
  return (await legacySha256Pin(pin, salt)) === storedHash;
}

interface PinModalProps {
  profile: Profile;
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * Profiles with a verification running. Shared like the lockouts, so neither a second submit
 * nor closing and reopening the dialog can start another one beside it and spend two attempts
 * on one entry.
 */
const verifying = new Set<number>();

export default function PinModal({ profile, onSuccess, onCancel }: PinModalProps) {
  const { onBackdropClick, containerRef } = useModalDismiss(onCancel);
  const [pin, setPin] = useState("");
  const [cooldown, setCooldown] = useState(() => lockoutSecondsLeft(profile.id));
  const [error, setError] = useState<string | null>(() => (cooldown > 0 ? "Too many attempts." : null));
  const inputRef = useRef<HTMLInputElement>(null);
  // The profile on screen, or null once the dialog has closed. A verification that finishes
  // late checks it before touching the dialog.
  const shownRef = useRef<number | null>(null);

  // Per profile, not per mount: the PIN queues (Overview, Insights, Trends, Budgets) hand this
  // same mounted dialog the next profile, so what it shows is reset and the cooldown re-read.
  useEffect(() => {
    shownRef.current = profile.id;
    const left = lockoutSecondsLeft(profile.id);
    setPin("");
    setCooldown(left);
    setError(left > 0 ? "Too many attempts." : null);
    inputRef.current?.focus();
    return () => { shownRef.current = null; };
  }, [profile.id]);

  // Counts down from the shared deadline, so a cooldown started before the dialog was closed is
  // still running when it reopens. The timer only reads: the store forgets an expired cooldown
  // itself (failedPinAttempts), so a stray tick can never hand attempts back.
  const locked = cooldown > 0;
  useEffect(() => {
    if (!locked) return;
    const timer = setInterval(() => setCooldown(lockoutSecondsLeft(profile.id)), 1000);
    return () => clearInterval(timer);
  }, [locked, profile.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (verifying.has(profile.id) || pin.length < 4) return;
    // The shared deadline decides, not the copy of it in state.
    const left = lockoutSecondsLeft(profile.id);
    if (left > 0) { setCooldown(left); setError("Too many attempts."); return; }
    verifying.add(profile.id);
    try {
      const match = await verifyPin(pin, profile.created_at, profile.pin_hash!);
      // The result belongs to the profile it was checked against, so the attempt is counted even
      // if the dialog has closed or moved to the next profile meanwhile. Only the dialog, and
      // the unlock itself, are left alone then.
      const shown = shownRef.current === profile.id;
      if (match) {
        clearPinLockout(profile.id);
        if (shown) onSuccess();
        return;
      }
      failedPinAttempts(profile.id); // drops a cooldown that ran out while the dialog was closed
      const next = recordFailedPin(profile.id);
      if (!shown) return;
      setPin("");
      if (next >= 3) {
        setError(`Too many attempts. Wait ${COOLDOWN_SECS}s.`);
        setCooldown(lockoutSecondsLeft(profile.id));
      } else {
        setError(`Incorrect PIN. ${3 - next} attempt${3 - next === 1 ? "" : "s"} left.`);
      }
    } finally {
      verifying.delete(profile.id);
    }
  };

  const initials = profile.name
    .trim()
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      onClick={onBackdropClick} ref={containerRef}
      role="dialog" aria-modal="true" aria-label="PIN entry"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.15 }}
        className="bg-[hsl(var(--background))] border rounded-2xl p-8 w-80 shadow-2xl space-y-5"
      >
        {/* Avatar */}
        <div className="flex flex-col items-center gap-3">
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center text-white
                       text-xl font-bold select-none"
            style={{ backgroundColor: profile.avatar_color }}
          >
            {initials}
          </div>
          <div className="text-center">
            <p className="font-semibold text-base">{profile.name}</p>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">Enter PIN to switch</p>
          </div>
        </div>

        {/* PIN form */}
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={pin}
            onChange={(e) => {
              setError(null);
              setPin(e.target.value.replace(/\D/g, ""));
            }}
            placeholder="••••"
            aria-label={`PIN for ${profile.name}`}
            disabled={cooldown > 0}
            className="w-full border rounded-xl px-4 py-3 text-center text-xl tracking-[0.5em]
                       bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                       placeholder:tracking-normal placeholder:text-[hsl(var(--muted-foreground))]
                       disabled:opacity-50"
          />

          {error && (
            <p className="text-xs text-[hsl(var(--error))] text-center">
              {cooldown > 0 ? `Too many attempts. Wait ${cooldown}s.` : error}
            </p>
          )}

          <button
            type="submit"
            disabled={cooldown > 0 || pin.length < 4}
            className="w-full py-2.5 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                       rounded-xl text-sm font-medium disabled:opacity-40 hover:opacity-90
                       transition-opacity"
          >
            {cooldown > 0 ? `Wait ${cooldown}s` : "Unlock"}
          </button>
        </form>

        <button
          onClick={onCancel}
          className="w-full text-sm text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                     transition-colors"
        >
          Cancel
        </button>
      </motion.div>
    </motion.div>
  );
}
