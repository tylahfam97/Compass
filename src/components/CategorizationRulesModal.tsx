import { useState, useEffect, useCallback } from "react";
import { getDb } from "@/lib/db";
import { useCategoryStore } from "@/stores/categoryStore";
import type { CategorizationRule } from "@/lib/types";

interface Props {
  onClose: () => void;
  profileId: number;
}

type RuleRow = CategorizationRule & {
  category_name: string;
  category_color: string;
  is_system_rule: boolean;
};

/** Format absolute-value amount conditions for display in the table. */
function fmtAmtCond(min: number | null | undefined, max: number | null | undefined): string {
  if (min == null && max == null) return "—";
  const lo = min != null ? `$${(min / 100).toLocaleString()}` : null;
  const hi = max != null ? `$${(max / 100).toLocaleString()}` : null;
  if (lo && hi) return `${lo}–${hi}`;
  if (lo) return `≥ ${lo}`;
  return `≤ ${hi}`;
}

function parseDollar(s: string): number | null {
  const n = parseFloat(s.replace(/[$,]/g, ""));
  return isNaN(n) || n < 0 ? null : Math.round(n * 100);
}

// ─── Regex cheat-sheet shown in the Advanced section ─────────────────────────
const REGEX_CHEATSHEET = ".*  any text  ·  \\d+  digits  ·  |  or  ·  ^  start  ·  $  end";

// ─── Two-tier rule form (used for both Add and inline Edit) ───────────────────
interface RuleFormState {
  description: string;         // simple-mode text (used when matchType = contains)
  matchType: "contains" | "starts_with" | "regex";
  rawPattern: string;          // regex/starts_with raw value shown in advanced
  catId: number;
  priority: number;
  minAbs: string;
  maxAbs: string;
  showAdvanced: boolean;
}

function makeEmptyForm(defaultCatId: number): RuleFormState {
  return { description: "", matchType: "contains", rawPattern: "", catId: defaultCatId, priority: 75, minAbs: "", maxAbs: "", showAdvanced: false };
}

function formPattern(f: RuleFormState): string {
  return f.matchType === "contains" ? f.description.trim() : f.rawPattern.trim();
}

interface RuleFormProps {
  form: RuleFormState;
  setForm: React.Dispatch<React.SetStateAction<RuleFormState>>;
  categories: { id: number; name: string }[];
  onSubmit: () => void;
  submitLabel: string;
  saving: boolean;
  error?: string | null;
  onCancel?: () => void;
}

function RuleForm({ form, setForm, categories, onSubmit, submitLabel, saving, error, onCancel }: RuleFormProps) {
  const set = <K extends keyof RuleFormState>(key: K, val: RuleFormState[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-red-500">{error}</p>}

      {/* ── Simple mode ── */}
      <div>
        <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">
          {form.matchType === "contains" ? "Description contains" : "Pattern"}
        </label>
        {form.matchType === "contains" ? (
          <input
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            placeholder="e.g. STARBUCKS"
            className="mt-1 w-full border rounded-lg px-3 py-2 text-sm
                       bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                       placeholder:text-[hsl(var(--muted-foreground))]"
          />
        ) : (
          <input
            value={form.rawPattern}
            onChange={(e) => set("rawPattern", e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            placeholder={form.matchType === "regex" ? "e.g. ZELLE.*RENT" : "e.g. PAYROLL"}
            className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-mono
                       bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                       placeholder:text-[hsl(var(--muted-foreground))]"
          />
        )}
      </div>

      {/* ── Category ── */}
      <div>
        <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Category</label>
        <select
          value={form.catId}
          onChange={(e) => set("catId", Number(e.target.value))}
          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm
                     bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
        >
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {/* ── Optional amount conditions ── */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">
            Min Amount <span className="normal-case font-normal">(optional)</span>
          </label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={form.minAbs}
            onChange={(e) => set("minAbs", e.target.value)}
            placeholder="e.g. 500"
            className="mt-1 w-full border rounded-lg px-3 py-2 text-sm
                       bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                       placeholder:text-[hsl(var(--muted-foreground))]"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">
            Max Amount <span className="normal-case font-normal">(optional)</span>
          </label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={form.maxAbs}
            onChange={(e) => set("maxAbs", e.target.value)}
            placeholder="leave blank = any"
            className="mt-1 w-full border rounded-lg px-3 py-2 text-sm
                       bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                       placeholder:text-[hsl(var(--muted-foreground))]"
          />
        </div>
      </div>
      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        Amount conditions match the absolute dollar value of the transaction (expenses and income).
        Leave both blank to match any amount.
      </p>

      {/* ── Advanced toggle ── */}
      <details
        open={form.showAdvanced}
        onToggle={(e) => set("showAdvanced", (e.currentTarget as HTMLDetailsElement).open)}
        className="group border rounded-lg"
      >
        <summary className="px-3 py-2 text-xs font-medium cursor-pointer select-none
                            text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                            list-none flex items-center gap-1.5 transition-colors">
          <span className="group-open:rotate-90 transition-transform inline-block text-[10px]">▶</span>
          Advanced — match type &amp; regex
        </summary>
        <div className="px-3 pb-3 space-y-3 border-t mt-0 pt-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Match type</label>
              <select
                value={form.matchType}
                onChange={(e) => set("matchType", e.target.value as RuleFormState["matchType"])}
                className="mt-1 w-full border rounded-lg px-3 py-2 text-sm
                           bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
              >
                <option value="contains">Contains</option>
                <option value="starts_with">Starts with</option>
                <option value="regex">Regex</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">
                Priority <span className="normal-case font-normal">(higher = checked first)</span>
              </label>
              <input
                type="number"
                value={form.priority}
                onChange={(e) => set("priority", Number(e.target.value))}
                min={0} max={500}
                className="mt-1 w-full border rounded-lg px-3 py-2 text-sm
                           bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
              />
            </div>
          </div>
          {form.matchType !== "contains" && (
            <div>
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">
                {form.matchType === "regex" ? "Regex pattern" : "Starts-with text"}
              </label>
              <input
                value={form.rawPattern}
                onChange={(e) => set("rawPattern", e.target.value)}
                placeholder={form.matchType === "regex" ? "e.g. ZELLE.*RENT" : "e.g. PAYROLL"}
                className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-mono
                           bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                           placeholder:text-[hsl(var(--muted-foreground))]"
              />
            </div>
          )}
          {form.matchType === "regex" && (
            <p className="text-xs font-mono text-[hsl(var(--muted-foreground))] bg-[hsl(var(--muted))]
                          rounded px-2 py-1.5 select-all">
              {REGEX_CHEATSHEET}
            </p>
          )}
        </div>
      </details>

      {/* ── Actions ── */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={onSubmit}
          disabled={saving}
          className="px-4 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                     rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
        >
          {saving ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            className="px-4 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export default function CategorizationRulesModal({ onClose, profileId }: Props) {
  const categories = useCategoryStore((s) => s.categories);
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const defaultCatId = categories[0]?.id ?? 1;
  const [addForm, setAddForm] = useState<RuleFormState>(() => makeEmptyForm(defaultCatId));

  // Inline edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<RuleFormState>(() => makeEmptyForm(defaultCatId));
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

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
    const pattern = formPattern(addForm);
    if (!pattern) { setError("Description / pattern is required"); return; }
    setSaving(true);
    setError(null);
    try {
      const db = await getDb();
      await db.execute(
        `INSERT INTO categorization_rules
           (pattern, match_type, category_id, priority, profile_id, min_abs_cents, max_abs_cents)
         VALUES (?,?,?,?,?,?,?)`,
        [
          pattern,
          addForm.matchType,
          addForm.catId,
          addForm.priority,
          profileId,
          parseDollar(addForm.minAbs),
          parseDollar(addForm.maxAbs),
        ]
      );
      setAddForm(makeEmptyForm(defaultCatId));
      await loadRules();
    } catch (e) { setError(String(e)); }
    setSaving(false);
  };

  const startEdit = (rule: RuleRow) => {
    setEditingId(rule.id);
    setEditError(null);
    const isContains = rule.match_type === "contains";
    setEditForm({
      description: isContains ? rule.pattern : "",
      matchType: rule.match_type,
      rawPattern: isContains ? "" : rule.pattern,
      catId: rule.category_id,
      priority: rule.priority,
      minAbs: rule.min_abs_cents != null ? String(rule.min_abs_cents / 100) : "",
      maxAbs: rule.max_abs_cents != null ? String(rule.max_abs_cents / 100) : "",
      showAdvanced: rule.match_type !== "contains",
    });
  };

  const saveEdit = async () => {
    if (editingId == null) return;
    const pattern = formPattern(editForm);
    if (!pattern) { setEditError("Description / pattern is required"); return; }
    setEditSaving(true);
    setEditError(null);
    try {
      const db = await getDb();
      await db.execute(
        `UPDATE categorization_rules
         SET pattern=?, match_type=?, category_id=?, priority=?, min_abs_cents=?, max_abs_cents=?
         WHERE id=?`,
        [
          pattern,
          editForm.matchType,
          editForm.catId,
          editForm.priority,
          parseDollar(editForm.minAbs),
          parseDollar(editForm.maxAbs),
          editingId,
        ]
      );
      setEditingId(null);
      await loadRules();
    } catch (e) { setEditError(String(e)); }
    setEditSaving(false);
  };

  const deleteRule = async (id: number) => {
    const db = await getDb();
    await db.execute("DELETE FROM categorization_rules WHERE id=?", [id]);
    if (editingId === id) setEditingId(null);
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
              Rules are matched in priority order. Higher priority rules win.
            </p>
          </div>
          <button onClick={onClose} className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                                               text-xl leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* ── Add new rule ────────────────────────────────────────────── */}
          <div className="border rounded-xl p-4 space-y-3 bg-[hsl(var(--muted)/0.4)]">
            <h3 className="text-sm font-semibold">Add Rule</h3>
            <RuleForm
              form={addForm}
              setForm={setAddForm}
              categories={categories}
              onSubmit={addRule}
              submitLabel="Add Rule"
              saving={saving}
              error={error}
            />
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
              <div className="border rounded-xl overflow-hidden text-sm">
                {userRules.map((r) => (
                  <div key={r.id} className="border-b last:border-0">
                    {editingId === r.id ? (
                      /* ── Inline edit form ── */
                      <div className="p-4 bg-[hsl(var(--muted)/0.3)]">
                        <RuleForm
                          form={editForm}
                          setForm={setEditForm}
                          categories={categories}
                          onSubmit={saveEdit}
                          submitLabel="Save"
                          saving={editSaving}
                          error={editError}
                          onCancel={() => setEditingId(null)}
                        />
                      </div>
                    ) : (
                      /* ── Read row ── */
                      <div className="flex items-center gap-2 px-3 py-2 hover:bg-[hsl(var(--muted)/0.5)]">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-xs bg-[hsl(var(--muted))] px-1.5 py-0.5 rounded truncate max-w-[200px]">
                              {r.pattern}
                            </span>
                            {r.match_type !== "contains" && (
                              <span className="text-xs text-[hsl(var(--muted-foreground))] capitalize">
                                {r.match_type.replace("_", " ")}
                              </span>
                            )}
                            <span className="inline-flex items-center gap-1">
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.category_color }} />
                              <span className="text-xs">{r.category_name}</span>
                            </span>
                            {(r.min_abs_cents != null || r.max_abs_cents != null) && (
                              <span className="text-xs text-[hsl(var(--muted-foreground))] bg-[hsl(var(--muted))] px-1.5 py-0.5 rounded">
                                {fmtAmtCond(r.min_abs_cents, r.max_abs_cents)}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="text-xs text-[hsl(var(--muted-foreground))] shrink-0 w-8 text-center">{r.priority}</span>
                        <button
                          onClick={() => startEdit(r)}
                          title="Edit rule"
                          className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                                     transition-colors text-sm shrink-0 px-1"
                        >
                          ✏
                        </button>
                        <button
                          onClick={() => deleteRule(r.id)}
                          title="Delete rule"
                          className="text-red-500 hover:text-red-700 transition-colors text-base leading-none shrink-0 px-1"
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── System rules (read-only) ─────────────────────────────────── */}
          <details className="group">
            <summary className="text-sm font-semibold cursor-pointer select-none list-none flex items-center gap-1">
              <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
              System Rules <span className="text-[hsl(var(--muted-foreground))] font-normal">({systemRules.length})</span>
              <span className="ml-2 text-xs font-normal text-[hsl(var(--muted-foreground))] border rounded px-1.5 py-0.5">
                read-only
              </span>
            </summary>
            <div className="mt-2 border rounded-xl overflow-hidden text-sm">
              {systemRules.map((r) => (
                <div key={r.id}
                     className="flex items-center gap-2 px-3 py-2 border-b last:border-0
                                hover:bg-[hsl(var(--muted)/0.5)]">
                  <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs bg-[hsl(var(--muted))] px-1.5 py-0.5 rounded truncate max-w-[200px]">
                      {r.pattern}
                    </span>
                    {r.match_type !== "contains" && (
                      <span className="text-xs text-[hsl(var(--muted-foreground))] capitalize">
                        {r.match_type.replace("_", " ")}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.category_color }} />
                      <span className="text-xs">{r.category_name}</span>
                    </span>
                  </div>
                  <span className="text-xs text-[hsl(var(--muted-foreground))] shrink-0 w-8 text-center">{r.priority}</span>
                </div>
              ))}
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
