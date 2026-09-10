import { cn } from "@/lib/utils";

/**
 * One notice for PIN-locked profiles whose data is excluded from a combined view, replacing
 * three copy-pasted amber banners. role="note" on purpose: the Insights tests query
 * role="status", and this must never collide with that.
 */
interface LockedProfilesNoticeProps<T extends { id: number; name: string }> {
  profiles: T[];
  onUnlock: (profile: T) => void;
  /** Completes the sentence "N profiles are PIN-locked, {context}". */
  context: string;
  className?: string;
}

export default function LockedProfilesNotice<T extends { id: number; name: string }>({ profiles, onUnlock, context, className }: LockedProfilesNoticeProps<T>) {
  if (profiles.length === 0) return null;
  const n = profiles.length;
  return (
    <div role="note" className={cn("locked-notice", className)}>
      <span>{n === 1 ? `1 profile is PIN-locked, ${context}` : `${n} profiles are PIN-locked, ${context}`}</span>
      {profiles.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onUnlock(p)}
          className="rounded-md px-2.5 py-1 text-xs font-medium border transition-colors hover:bg-[hsl(var(--warning)/0.1)]"
          style={{ borderColor: "hsl(var(--warning) / 0.45)", color: "hsl(var(--warning))" }}
        >
          Unlock {p.name}
        </button>
      ))}
    </div>
  );
}
