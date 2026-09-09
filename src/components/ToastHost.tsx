import { motion, AnimatePresence } from "motion/react";
import { X } from "lucide-react";
import { useToastStore, type ToastTone } from "@/stores/toastStore";

const TONE_BORDER: Record<ToastTone, string> = {
  info: "",
  success: "border-[hsl(var(--success))]",
  error: "border-[hsl(var(--error))]",
};

/** Single mount point for transient app-wide messages. Rendered once from App.tsx; fire toasts
 *  from anywhere with the `toast` helper in `@/stores/toastStore`. */
export default function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div
      className="fixed bottom-6 right-6 z-[250] flex flex-col gap-2 items-end pointer-events-none"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          // border/rounded live on the inner div: the global .border.rounded-xl decorative-ring
          // rule in index.css outranks .fixed and would force position:relative on the parent.
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.2 }}
            className="max-w-sm pointer-events-auto"
          >
            <div
              className={`border shadow-xl rounded-xl px-5 py-3 flex items-center gap-4 text-sm
                          bg-[hsl(var(--background))] ${TONE_BORDER[t.tone]}`}
              role={t.tone === "error" ? "alert" : "status"}
            >
              <span
                className={`flex-1 ${t.tone === "error" ? "text-[hsl(var(--error))]" : "text-[hsl(var(--foreground))]"}`}
              >
                {t.message}
              </span>

              {t.action && (
                <button
                  onClick={() => { t.action!.onClick(); dismiss(t.id); }}
                  className="px-3 py-1.5 border rounded-lg font-medium hover:bg-[hsl(var(--muted))] transition-colors shrink-0"
                >
                  {t.action.label}
                </button>
              )}

              <button
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
                className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] shrink-0"
              >
                <X size={16} />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
