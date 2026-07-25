import type { Category } from "@/lib/types";
import { TRANSFER_CATEGORY_ID, EXCLUDED_CATEGORY_ID } from "@/lib/types";

/**
 * Renders <optgroup> sections for excluded, user-created, and system categories, each
 * sorted alphabetically. Drop this inside any <select> that shows a category list —
 * pass the already-filtered category array.
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
  const isExcluded = (c: CategoryItem) => c.id === TRANSFER_CATEGORY_ID || c.id === EXCLUDED_CATEGORY_ID;
  const excluded = sorted(items.filter(isExcluded));
  const system   = sorted(items.filter((c) => c.is_system && !isExcluded(c)));
  const user     = sorted(items.filter((c) => !c.is_system && !isExcluded(c)));

  const titleFor = (c: CategoryItem) =>
    c.id === TRANSFER_CATEGORY_ID
      ? "Transfers are excluded from income and expense totals"
      : c.id === EXCLUDED_CATEGORY_ID
      ? "Excluded is a catch-all for anything else you don't want counted as income or spending (reimbursements, one-off adjustments, etc.) - also left out of income and expense totals"
      : undefined;

  return (
    <>
      {excluded.length > 0 && (
        <optgroup label="Excluded from Debits and Credits">
          {excluded.map((c) => (
            <option key={c.id} value={c.id} title={titleFor(c)}>
              {c.name}
            </option>
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
      {system.length > 0 && (
        <optgroup label="System">
          {system.map((c) => (
            <option key={c.id} value={c.id} title={titleFor(c)}>
              {c.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}
