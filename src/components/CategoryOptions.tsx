import type { Category } from "@/lib/types";

/**
 * Renders <optgroup> sections for system and user-created categories,
 * both sorted alphabetically.  Drop this inside any <select> that shows
 * a category list — pass the already-filtered category array.
 *
 * Accepts the full Category type or any subset that includes id, name,
 * and optionally is_system (treated as user-created when absent).
 */
interface CategoryItem {
  id: number;
  name: string;
  is_system?: boolean;
}

interface CategoryOptionsProps {
  categories: CategoryItem[] | Category[];
}

export default function CategoryOptions({ categories }: CategoryOptionsProps) {
  const sorted = (arr: CategoryItem[]) =>
    [...arr].sort((a, b) => a.name.localeCompare(b.name));

  const items = categories as CategoryItem[];
  const system = sorted(items.filter((c) => c.is_system));
  const user   = sorted(items.filter((c) => !c.is_system));

  return (
    <>
      {system.length > 0 && (
        <optgroup label="System">
          {system.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </optgroup>
      )}
      {user.length > 0 && (
        <optgroup label="User Created">
          {user.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </optgroup>
      )}
    </>
  );
}
