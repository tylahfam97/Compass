import { useState } from "react";
import { motion } from "motion/react";
import { getDb } from "@/lib/db";
import { deleteUserCategory, loadCategories } from "@/lib/categoryManagement";
import { useProfileStore } from "@/stores/profileStore";
import { useCategoryStore } from "@/stores/categoryStore";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import CategoryOptions from "@/components/CategoryOptions";
import type { Category } from "@/lib/types";

const PRESET_COLORS = [
  "#ef4444","#f97316","#eab308","#22c55e",
  "#14b8a6","#3b82f6","#8b5cf6","#ec4899",
  "#6b7280","#10b981",
];

interface Props {
  category?: Category;   // undefined = create mode
  onClose: () => void;
  profileId?: number;
  deleteMode?: boolean;
}

export default function CategoryModal({ category, onClose, profileId, deleteMode = false }: Props) {
  const { categories, addCategory, updateCategory, setCategories } = useCategoryStore();
  const activeProfile = useProfileStore((state) => state.activeProfile);
  const ownerId = profileId ?? activeProfile?.id;
  const { onBackdropClick, containerRef } = useModalDismiss(onClose);
  const [name, setName] = useState(category?.name ?? "");
  const [color, setColor] = useState(category?.color ?? "#3b82f6");
  const [parentId, setParentId] = useState<number | "">(category?.parent_id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(deleteMode);
  const [replacementId, setReplacementId] = useState(15);

  const isEdit = !!category;
  const isSystem = category?.is_system ?? false;
  const topLevel = categories.filter((c) => !c.parent_id && c.id !== category?.id);

  async function handleSave() {
    if (!ownerId || isSystem) return;
    if (!name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    try {
      const db = await getDb();
      if (isEdit) {
        const result = await db.execute(
          "UPDATE categories SET name=?, color=?, parent_id=? WHERE id=? AND profile_id=? AND is_system=0",
          [name.trim(), color, parentId || null, category!.id, ownerId]
        );
        if (!result.rowsAffected) throw new Error("This category is no longer available.");
        updateCategory({ ...category!, name: name.trim(), color, parent_id: parentId || null });
      } else {
        // profile_id MUST be set here - NULL means "system/shared" in this column's schema
        // (see src/lib/db.ts v6 migration comment), so a user-created category left with a
        // NULL profile_id is invisible to the `WHERE is_system=1 OR profile_id=?` queries
        // that load categories on every app start (App.tsx / ProfileSwitcher.tsx) - it still
        // exists in the DB, it just silently stops appearing anywhere after the in-memory
        // Zustand store is discarded (e.g. on the next launch after an update).
        const [last] = await db.select<{ position: number }[]>("SELECT COALESCE(MAX(sort_order),-1)+1 AS position FROM categories WHERE profile_id=? AND is_system=0", [ownerId]);
        const res = await db.execute(
          "INSERT INTO categories (name, color, icon, parent_id, is_system, profile_id, sort_order) VALUES (?,?,?,?,0,?,?)",
          [name.trim(), color, "tag", parentId || null, ownerId, last.position]
        );
        addCategory({
          id: res.lastInsertId as number,
          name: name.trim(), color, icon: "tag",
          parent_id: parentId || null, is_system: false,
          sort_order: last.position,
        });
      }
      onClose();
    } catch (e) { setError(String(e)); }
    setSaving(false);
  }

  async function handleDelete() {
    if (!category || !ownerId || isSystem) return;
    setSaving(true);
    try {
      await deleteUserCategory(ownerId, category.id, replacementId);
      setCategories(await loadCategories(ownerId));
      onClose();
    } catch (e) { setError(String(e)); }
    setSaving(false);
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      onClick={onBackdropClick} ref={containerRef}
      role="dialog" aria-modal="true" aria-label="Category editor"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.15 }}
        className="bg-[hsl(var(--background))] border rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6 m-4"
      >
        <h2 className="text-lg font-semibold mb-4">{isEdit ? "Edit Category" : "New Category"}</h2>

        {error && <p role="alert" className="mb-3 text-sm text-[hsl(var(--error))]">{error}</p>}

        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Name</label>
            <input
              aria-label="Category name"
              value={name} onChange={(e) => setName(e.target.value)}
              disabled={isSystem}
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))]"
              placeholder="e.g. Travel"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Color</label>
            <div className="mt-1 flex flex-wrap gap-2">
              {PRESET_COLORS.map((c) => (
                <button key={c} onClick={() => setColor(c)} aria-label={`Color ${c}`} aria-pressed={color === c}
                  className={`w-7 h-7 rounded-full border-2 transition-transform ${color === c ? "scale-125 border-white" : "border-transparent"}`}
                  style={{ backgroundColor: c }} />
              ))}
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
                className="w-7 h-7 rounded-full border cursor-pointer" title="Custom color" />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Parent Category (optional)</label>
            <select value={parentId} aria-label="Parent category"
              onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : "")}
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))]">
              <option value="">— None (top level) —</option>
              <CategoryOptions categories={topLevel} />
            </select>
          </div>
        </div>

        {confirmDelete && !isSystem && <div className="mt-5 space-y-3 border-t pt-4">
          <p className="text-sm">Existing transactions, budgets, goals, and rules will move to:</p>
          <select aria-label="Replacement category" value={replacementId} onChange={(event) => setReplacementId(Number(event.target.value))} className="border rounded-lg px-3 py-2 w-full bg-[hsl(var(--background))] text-sm">
            <CategoryOptions categories={categories.filter((item) => item.id !== category?.id)} />
          </select>
          <button disabled={saving} onClick={handleDelete} className="text-sm px-3 py-2 rounded-lg bg-[hsl(var(--error))] text-white disabled:opacity-50">Remove category</button>
          <button disabled={saving} onClick={() => setConfirmDelete(false)} className="text-sm px-3 py-2">Keep category</button>
        </div>}

        <div className="mt-6 flex justify-between gap-2 flex-wrap">
          <div>
            {isEdit && !isSystem && !confirmDelete && (
              <button onClick={() => setConfirmDelete(true)}
                className="text-sm text-[hsl(var(--error))] hover:underline">Delete</button>
            )}
            {isSystem && <span className="text-xs text-[hsl(var(--muted-foreground))]">System category — cannot delete</span>}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancel</button>
            <button onClick={handleSave} disabled={saving || isSystem || confirmDelete || !ownerId}
              className="px-4 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}