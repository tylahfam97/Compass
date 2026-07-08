import { useState } from "react";
import { getDb } from "@/lib/db";
import { useCategoryStore } from "@/stores/categoryStore";
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
}

export default function CategoryModal({ category, onClose }: Props) {
  const { categories, addCategory, updateCategory, removeCategory } = useCategoryStore();
  const [name, setName] = useState(category?.name ?? "");
  const [color, setColor] = useState(category?.color ?? "#3b82f6");
  const [parentId, setParentId] = useState<number | "">(category?.parent_id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isEdit = !!category;
  const isSystem = category?.is_system ?? false;
  const topLevel = categories.filter((c) => !c.parent_id && c.id !== category?.id);

  async function handleSave() {
    if (!name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    try {
      const db = await getDb();
      if (isEdit) {
        await db.execute(
          "UPDATE categories SET name=?, color=?, parent_id=? WHERE id=?",
          [name.trim(), color, parentId || null, category!.id]
        );
        updateCategory({ ...category!, name: name.trim(), color, parent_id: parentId || null });
      } else {
        const res = await db.execute(
          "INSERT INTO categories (name, color, icon, parent_id, is_system) VALUES (?,?,?,?,0)",
          [name.trim(), color, "tag", parentId || null]
        );
        addCategory({
          id: res.lastInsertId as number,
          name: name.trim(), color, icon: "tag",
          parent_id: parentId || null, is_system: false,
        });
      }
      onClose();
    } catch (e) { setError(String(e)); }
    setSaving(false);
  }

  async function handleDelete() {
    if (!category) return;
    setSaving(true);
    try {
      const db = await getDb();
      await db.execute("UPDATE transactions SET category_id=15 WHERE category_id=?", [category.id]);
      await db.execute("DELETE FROM categories WHERE id=? AND is_system=0", [category.id]);
      removeCategory(category.id);
      onClose();
    } catch (e) { setError(String(e)); }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-[hsl(var(--background))] border rounded-2xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold mb-4">{isEdit ? "Edit Category" : "New Category"}</h2>

        {error && <p className="mb-3 text-sm text-red-500">{error}</p>}

        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Name</label>
            <input
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
                <button key={c} onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-full border-2 transition-transform ${color === c ? "scale-125 border-white" : "border-transparent"}`}
                  style={{ backgroundColor: c }} />
              ))}
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
                className="w-7 h-7 rounded-full border cursor-pointer" title="Custom color" />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Parent Category (optional)</label>
            <select value={parentId}
              onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : "")}
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))]">
              <option value="">— None (top level) —</option>
              {topLevel.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>

        <div className="mt-6 flex justify-between">
          <div>
            {isEdit && !isSystem && !confirmDelete && (
              <button onClick={() => setConfirmDelete(true)}
                className="text-sm text-red-500 hover:underline">Delete</button>
            )}
            {confirmDelete && (
              <span className="text-sm">
                Sure?{" "}
                <button onClick={handleDelete} className="text-red-500 font-medium hover:underline">Yes, delete</button>{" / "}
                <button onClick={() => setConfirmDelete(false)} className="hover:underline">Cancel</button>
              </span>
            )}
            {isSystem && <span className="text-xs text-[hsl(var(--muted-foreground))]">System category — cannot delete</span>}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancel</button>
            <button onClick={handleSave} disabled={saving || isSystem}
              className="px-4 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}