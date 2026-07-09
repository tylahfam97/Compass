import { create } from "zustand";
import type { Category } from "@/lib/types";

interface CategoryStore {
  categories: Category[];
  setCategories: (cats: Category[]) => void;
  getCategoryById: (id: number) => Category | undefined;
  addCategory: (cat: Category) => void;
  updateCategory: (cat: Category) => void;
  removeCategory: (id: number) => void;
}

export const useCategoryStore = create<CategoryStore>((set, get) => ({
  categories: [],
  setCategories: (categories) => set({ categories }),
  getCategoryById: (id) => get().categories.find((c) => c.id === id),
  addCategory: (cat) => set((s) => ({ categories: [...s.categories, cat] })),
  updateCategory: (cat) =>
    set((s) => ({ categories: s.categories.map((c) => (c.id === cat.id ? cat : c)) })),
  removeCategory: (id) =>
    set((s) => ({ categories: s.categories.filter((c) => c.id !== id) })),
}));
