import { useState } from "react";
import { ArrowUp, ArrowDown, Pencil, Plus, Trash2, X, LockKeyhole } from "lucide-react";
import CategoryModal from "./CategoryModal";
import { useCategoryStore } from "@/stores/categoryStore";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import { loadCategories, reorderCategories } from "@/lib/categoryManagement";
import type { Category } from "@/lib/types";

interface Props { profileId: number; onClose: () => void }

export default function CategoryManagerModal({ profileId, onClose }: Props) {
  const [editor, setEditor] = useState<{ category?: Category; remove?: boolean } | null>(null);
  if (editor) return <CategoryModal category={editor.category} deleteMode={editor.remove} profileId={profileId} onClose={() => setEditor(null)} />;
  return <CategoryList profileId={profileId} onClose={onClose} onEdit={(category, remove) => setEditor({ category, remove })} />;
}

function CategoryList({ profileId, onClose, onEdit }: Props & { onEdit: (category?: Category, remove?: boolean) => void }) {
  const { categories, setCategories } = useCategoryStore();
  const { containerRef, onBackdropClick } = useModalDismiss(onClose);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const custom = categories.filter((category) => !category.is_system).sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0) || left.name.localeCompare(right.name));
  const matches = (category: Category) => category.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());

  async function move(index: number, direction: number) {
    const ordered = custom.map((category) => category.id);
    [ordered[index], ordered[index + direction]] = [ordered[index + direction], ordered[index]];
    setBusy(true);
    setError("");
    try {
      await reorderCategories(profileId, ordered);
      setCategories(await loadCategories(profileId));
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }

  return <div ref={containerRef} onClick={onBackdropClick} role="dialog" aria-modal="true" aria-labelledby="category-manager-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div className="w-full max-w-xl max-h-[85vh] overflow-y-auto border rounded-lg bg-[hsl(var(--background))] p-5 shadow-xl">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 id="category-manager-title" className="text-lg font-semibold">Categories</h2>
        <button onClick={onClose} className="workspace-icon" aria-label="Close categories" title="Close"><X size={18} /></button>
      </div>
      <div className="flex gap-2 mb-5">
        <input autoFocus aria-label="Search categories" placeholder="Search categories" value={search} onChange={(event) => setSearch(event.target.value)} className="min-w-0 flex-1 border rounded-lg px-3 py-2 bg-transparent text-sm" />
        <button onClick={() => onEdit()} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"><Plus size={15} /> New</button>
      </div>
      {error && <p role="alert" className="text-sm text-[hsl(var(--error))] mb-3">{error}</p>}
      <h3 className="text-xs text-[hsl(var(--muted-foreground))] mb-2">Your categories · {custom.length}</h3>
      {custom.length === 0 && <p className="py-5 text-sm text-[hsl(var(--muted-foreground))]">No custom categories yet.</p>}
      {custom.filter(matches).map((category) => {
        const index = custom.findIndex((item) => item.id === category.id);
        return <div key={category.id} data-category-id={category.id} className="flex items-center gap-2 border-b py-2">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: category.color }} />
          <span className="text-sm flex-1 min-w-0 break-words">{category.name}</span>
          <button disabled={busy || index === 0 || !!search.trim()} onClick={() => move(index, -1)} className="workspace-icon disabled:opacity-25" aria-label={`Move ${category.name} up`} title="Move up"><ArrowUp size={15} /></button>
          <button disabled={busy || index === custom.length - 1 || !!search.trim()} onClick={() => move(index, 1)} className="workspace-icon disabled:opacity-25" aria-label={`Move ${category.name} down`} title="Move down"><ArrowDown size={15} /></button>
          <button disabled={busy} onClick={() => onEdit(category)} className="workspace-icon" aria-label={`Edit ${category.name}`} title="Rename or edit"><Pencil size={15} /></button>
          <button disabled={busy} onClick={() => onEdit(category, true)} className="workspace-icon text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--error))]" aria-label={`Remove ${category.name}`} title="Remove"><Trash2 size={15} /></button>
        </div>;
      })}
      <details className="workspace-disclosure mt-5" open={search.trim() ? true : undefined}>
        <summary>System categories</summary>
        {categories.filter((category) => category.is_system && matches(category)).map((category) => <div key={category.id} className="flex items-center gap-3 py-2 text-sm text-[hsl(var(--muted-foreground))]"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: category.color }} /><span className="flex-1">{category.name}</span><LockKeyhole size={13} aria-label="Protected" /></div>)}
      </details>
    </div>
  </div>;
}