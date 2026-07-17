import { useState, useRef, useEffect } from "react";
import { motion } from "motion/react";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import type { Profile } from "@/lib/types";

const COOLDOWN_SECS = 10;

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

export default function PinModal({ profile, onSuccess, onCancel }: PinModalProps) {
  const { onBackdropClick } = useModalDismiss(onCancel);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const startCooldown = () => {
    setCooldown(COOLDOWN_SECS);
    timerRef.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          clearInterval(timerRef.current!);
          timerRef.current = null;
          setAttempts(0);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cooldown > 0 || pin.length < 4) return;
    const match = await verifyPin(pin, profile.created_at, profile.pin_hash!);
    if (match) {
      onSuccess();
    } else {
      const next = attempts + 1;
      setAttempts(next);
      setPin("");
      if (next >= 3) {
        setError(`Too many attempts. Wait ${COOLDOWN_SECS}s.`);
        startCooldown();
      } else {
        setError(`Incorrect PIN. ${3 - next} attempt${3 - next === 1 ? "" : "s"} left.`);
      }
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
      onClick={onBackdropClick}
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
            disabled={cooldown > 0}
            className="w-full border rounded-xl px-4 py-3 text-center text-xl tracking-[0.5em]
                       bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                       placeholder:tracking-normal placeholder:text-[hsl(var(--muted-foreground))]
                       disabled:opacity-50"
          />

          {error && (
            <p className="text-xs text-red-500 text-center">
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
