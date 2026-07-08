import { create } from "zustand";
import type { Category } from "@/lib/types";

interface CategoryStore {
  categories: Category[];
  setCategories: (cats: Category[]) => void;
  getCategoryById: (id: number) => Category | undefined;
}

export const useCategoryStore = create<CategoryStore>((set, get) => ({
  categories: [],
  setCategories: (categories) => set({ categories }),
  getCategoryById: (id) => get().categories.find((c) => c.id === id),
}));
