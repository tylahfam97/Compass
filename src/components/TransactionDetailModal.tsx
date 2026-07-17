import { motion } from "motion/react";
import { CreditCard, Wallet, X } from "lucide-react";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Transaction } from "@/lib/types";

interface Props {
  transaction: Transaction;
  onClose: () => void;
}

/**
 * A minimal, read-only detail popup for a single transaction row - account, balance at the
 * time, and the full (untruncated) description. Purely informational; editing still happens
 * through the pencil icon's EditTransactionModal, this is just a quick "what was this?" view.
 */
export default function TransactionDetailModal({ transaction: t, onClose }: Props) {
  const { onBackdropClick } = useModalDismiss(onClose);
  const isCredit = t.account_type === "credit";
  const AccountIcon = isCredit ? CreditCard : Wallet;

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      onClick={onBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 6 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="bg-[hsl(var(--background))] border rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
      >
        <div className="px-6 pt-5 pb-4 border-b flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-[hsl(var(--muted-foreground))] mb-1">{formatDate(t.date)}</p>
            <h2 className="text-base font-semibold leading-snug break-words">{t.description}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors shrink-0 mt-0.5"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="text-center py-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-1">Amount</p>
            <p className={`text-3xl font-bold tabular-nums ${t.amount_cents < 0 ? "text-red-500" : "text-green-600"}`}>
              {formatCurrency(t.amount_cents)}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="border rounded-xl px-3 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-1 flex items-center gap-1">
                <AccountIcon size={10} /> Account
              </p>
              <p className="text-sm font-medium truncate">{t.account_name ?? "—"}</p>
            </div>
            <div className="border rounded-xl px-3 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-1">
                Balance after
              </p>
              <p className="text-sm font-medium tabular-nums">
                {t.balance_cents != null ? formatCurrency(t.balance_cents) : "—"}
              </p>
            </div>
          </div>

          {t.category_name && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[hsl(var(--muted-foreground))]">Category</span>
              <span
                className="inline-block px-2 py-0.5 rounded-full text-xs text-white"
                style={{ backgroundColor: t.category_color ?? "hsl(var(--neutral))" }}
              >
                {t.category_name}
              </span>
            </div>
          )}

          {t.notes && (
            <div className="border-t pt-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-1">Note</p>
              <p className="text-sm text-[hsl(var(--foreground))] leading-relaxed">{t.notes}</p>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
