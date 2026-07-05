import { create } from "zustand";
import type { Budget } from "@/lib/types";

interface BudgetStore {
  budgets: Budget[];
  setBudgets: (budgets: Budget[]) => void;
}

export const useBudgetStore = create<BudgetStore>((set) => ({
  budgets: [],
  setBudgets: (budgets) => set({ budgets }),
}));
