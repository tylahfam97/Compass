import { create } from "zustand";
import type { Transaction } from "@/lib/types";

interface TransactionStore {
  transactions: Transaction[];
  loading: boolean;
  setTransactions: (txns: Transaction[]) => void;
  setLoading: (v: boolean) => void;
  upsertTransaction: (txn: Transaction) => void;
}

export const useTransactionStore = create<TransactionStore>((set) => ({
  transactions: [],
  loading: false,
  setTransactions: (transactions) => set({ transactions }),
  setLoading: (loading) => set({ loading }),
  upsertTransaction: (txn) =>
    set((state) => {
      const idx = state.transactions.findIndex((t) => t.id === txn.id);
      if (idx >= 0) {
        const updated = [...state.transactions];
        updated[idx] = txn;
        return { transactions: updated };
      }
      return { transactions: [txn, ...state.transactions] };
    }),
}));
