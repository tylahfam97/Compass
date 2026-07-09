import { useState, useEffect, useCallback } from "react";
import { getDb } from "@/lib/db";
import { useCategoryStore } from "@/stores/categoryStore";
import type { CategorizationRule } from "@/lib/types";

interface Props {
  onClose: () => void;
  profileId: number;
}

const MATCH_TYPES = [
  { value: "contains",    label: "Contains" },
  { value: "starts_with", label: "Starts with" },
  { value: "regex",       label: "Regex" },
];

export default function CategorizationRulesModal({ onClose, profileId }: Props) {
  const categories = useCategoryStore((s) => s.categories);
  const [rules, setRules] = useState<(CategorizationRule & { category_name: string; category_color: string; is_system_rule: boolean })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New-rule form
  const [newPattern,   setNewPattern]   = useState("");
  const [newMatchType, setNewMatchType] = useState<"contains" | "starts_with" | "regex">("contains");
  const [newCatId,     setNewCatId]     = useState<number>(categories[0]?.id ?? 1);
  const [newPriority,  setNewPriority]  = useState(75);
  const [saving,       setSaving]       = useState(false);

  const loadRules = useCallback(async () => {
    setLoading(true);
    const db = await getDb();
    const rows = await db.select<(CategorizationRule & {
      category_name: string;
      category_color: string;
      is_system_rule: number;
    })[]>(
      `SELECT r.*, c.name as category_name, c.color as category_color,
              CASE WHEN r.profile_id IS NULL THEN 1 ELSE 0 END as is_system_rule
       FROM categorization_rules r JOIN categories c ON r.category_id=c.id
       ORDER BY r.priority DESC, r.id ASC`
    );
    setRules(rows.map((r) => ({ ...r, is_system_rule: r.is_system_rule === 1 })));
    setLoading(false);
  }, []);

  useEffect(() => { loadRules().catch(console.error); }, [loadRules]);

  const addRule = async () => {
    if (!newPattern.trim()) { setError("Pattern is required"); return; }
    setSaving(true);
    setError(null);
    try {
      const db = await getDb();
      await db.execute(
        "INSERT INTO categorization_rules (pattern, match_type, category_id, priority, profile_id) VALUES (?,?,?,?,?)",
        [newPattern.trim(), newMatchType, newCatId, newPriority, profileId]
      );
      setNewPattern("");
      await loadRules();
    } catch (e) { setError(String(e)); }
    setSaving(false);
  };

  const deleteRule = async (id: number) => {
    const db = await getDb();
    await db.execute("DELETE FROM categorization_rules WHERE id=?", [id]);
    await loadRules();
  };

  const userRules = rules.filter((r) => !r.is_system_rule);
  const systemRules = rules.filter((r) => r.is_system_rule);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-[hsl(var(--background))] border rounded-2xl shadow-xl w-full max-w-2xl
                      flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b shrink-0">
          <div>
            <h2 className="text-lg font-semibold">Categorization Rules</h2>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">
              Rules are matched in priority order against imported transaction descriptions.
            </p>
          </div>
          <button onClick={onClose} className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                                               text-xl leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* ── Add new rule ────────────────────────────────────────────── */}
          <div className="border rounded-xl p-4 space-y-3 bg-[hsl(var(--muted)/0.4)]">
            <h3 className="text-sm font-semibold">Add Rule</h3>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Pattern</label>
                <input
                  value={newPattern}
                  onChange={(e) => setNewPattern(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addRule()}
                  placeholder="e.g. STARBUCKS"
                  className="mt-1 w-full border rounded-lg px-3 py-2 text-sm
                             bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                             placeholder:text-[hsl(var(--muted-foreground))]"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Match type</label>
                <select
                  value={newMatchType}
                  onChange={(e) => setNewMatchType(e.target.value as typeof newMatchType)}
                  className="mt-1 w-full border rounded-lg px-3 py-2 text-sm
                             bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
                >
                  {MATCH_TYPES.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Category</label>
                <select
                  value={newCatId}
                  onChange={(e) => setNewCatId(Number(e.target.value))}
                  className="mt-1 w-full border rounded-lg px-3 py-2 text-sm
                             bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Priority (higher = checked first)</label>
                <input
                  type="number"
                  value={newPriority}
                  onChange={(e) => setNewPriority(Number(e.target.value))}
                  min={0} max={500}
                  className="mt-1 w-full border rounded-lg px-3 py-2 text-sm
                             bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
                />
              </div>
            </div>
            <button
              onClick={addRule}
              disabled={saving}
              className="px-4 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                         rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
            >
              {saving ? "Adding…" : "Add Rule"}
            </button>
          </div>

          {/* ── User rules ──────────────────────────────────────────────── */}
          <section>
            <h3 className="text-sm font-semibold mb-2">
              Your Rules <span className="text-[hsl(var(--muted-foreground))] font-normal">({userRules.length})</span>
            </h3>
            {loading ? (
              <p className="text-sm text-[hsl(var(--muted-foreground))]">Loading…</p>
            ) : userRules.length === 0 ? (
              <p className="text-sm text-[hsl(var(--muted-foreground))] italic">
                No custom rules yet. Add one above or click "Create Rule" when changing a transaction's category.
              </p>
            ) : (
              <RulesTable rules={userRules} onDelete={deleteRule} deletable />
            )}
          </section>

          {/* ── System rules ────────────────────────────────────────────── */}
          <details className="group">
            <summary className="text-sm font-semibold cursor-pointer select-none list-none flex items-center gap-1">
              <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
              System Rules <span className="text-[hsl(var(--muted-foreground))] font-normal">({systemRules.length})</span>
            </summary>
            <div className="mt-2">
              <RulesTable rules={systemRules} onDelete={deleteRule} deletable={false} />
            </div>
          </details>
        </div>

        <div className="px-6 py-4 border-t shrink-0 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))]">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

interface RulesTableProps {
  rules: (CategorizationRule & { category_name: string; category_color: string; is_system_rule: boolean })[];
  onDelete: (id: number) => void;
  deletable: boolean;
}

function RulesTable({ rules, onDelete, deletable }: RulesTableProps) {
  return (
    <div className="border rounded-xl overflow-hidden text-sm">
      <table className="w-full">
        <thead>
          <tr className="bg-[hsl(var(--muted))] border-b text-left">
            <th className="px-3 py-2 font-medium">Pattern</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Category</th>
            <th className="px-3 py-2 font-medium text-center w-16">Pri.</th>
            {deletable && <th className="px-3 py-2 w-10" />}
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className="border-b last:border-0 hover:bg-[hsl(var(--muted)/0.5)]">
              <td className="px-3 py-2 font-mono text-xs">{r.pattern}</td>
              <td className="px-3 py-2 text-[hsl(var(--muted-foreground))] text-xs capitalize">{r.match_type.replace("_", " ")}</td>
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.category_color }} />
                  {r.category_name}
                </span>
              </td>
              <td className="px-3 py-2 text-center text-[hsl(var(--muted-foreground))]">{r.priority}</td>
              {deletable && (
                <td className="px-3 py-2 text-center">
                  <button
                    onClick={() => onDelete(r.id)}
                    className="text-red-500 hover:text-red-700 transition-colors text-base leading-none"
                    title="Delete rule"
                  >
                    ×
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
