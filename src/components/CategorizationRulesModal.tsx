import { useState, useEffect, useCallback, useMemo } from "react";
import { motion } from "motion/react";
import { XIcon, PencilSimpleIcon, TrashIcon, CaretRightIcon, CrosshairIcon } from "@phosphor-icons/react";
import { getDb, applyCategorizationRules, reapplyCategorizationRules } from "@/lib/db";
import { formatCurrency } from "@/lib/utils";
import { useCategoryStore } from "@/stores/categoryStore";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import CategoryOptions from "@/components/CategoryOptions";
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

/** Recent transactions the live tester matches candidate rules against. */
interface SampleTxn {
  date: string;
  description: string;
  amount_cents: number;
}

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
const REGEX_CHEATSHEET = ".*  any text ,  \\d+  digits ,  |  or ,  ^  start ,  $  end";

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
  return { description: "", matchType: "contains", rawPattern: "", catId: defaultCatId, priority: 250, minAbs: "", maxAbs: "", showAdvanced: false };
}

function formPattern(f: RuleFormState): string {
  return f.matchType === "contains" ? f.description.trim() : f.rawPattern.trim();
}

/** Wraps the part of a description the candidate rule matched in a gold mark. */
function highlightMatch(desc: string, form: RuleFormState): React.ReactNode {
  const pattern = formPattern(form);
  if (!pattern) return desc;
  let start = -1;
  let len = 0;
  if (form.matchType === "regex") {
    try {
      const m = new RegExp(pattern, "i").exec(desc);
      if (m && m[0]) { start = m.index; len = m[0].length; }
    } catch { /* invalid regex while typing */ }
  } else {
    start = desc.toUpperCase().indexOf(pattern.toUpperCase());
    if (form.matchType === "starts_with" && start !== 0) start = -1;
    len = pattern.length;
  }
  if (start < 0) return desc;
  return (
    <>
      {desc.slice(0, start)}
      <mark className="bg-[hsl(var(--primary)/0.28)] text-inherit rounded-sm px-0.5">
        {desc.slice(start, start + len)}
      </mark>
      {desc.slice(start + len)}
    </>
  );
}

/** Live preview: which of the user's recent transactions this rule would catch. */
function MatchPreview({ form, sampleTxns }: { form: RuleFormState; sampleTxns: SampleTxn[] }) {
  const pattern = formPattern(form);
  const matches = useMemo(() => {
    if (!pattern || sampleTxns.length === 0) return null;
    // Sentinel category id -1: applyCategorizationRules returns it on match, 15 on miss.
    const candidate = {
      id: -1, pattern, match_type: form.matchType, category_id: -1, priority: form.priority,
      min_abs_cents: parseDollar(form.minAbs), max_abs_cents: parseDollar(form.maxAbs),
    } as CategorizationRule;
    return sampleTxns.filter((t) => applyCategorizationRules(t.description, [candidate], t.amount_cents) === -1);
  }, [pattern, form.matchType, form.priority, form.minAbs, form.maxAbs, sampleTxns]);

  if (matches === null) return null;
  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 text-xs flex items-center gap-1.5 bg-[hsl(var(--muted)/0.35)]">
        <CrosshairIcon size={12} weight="bold" className="text-[hsl(var(--gold-ink))] shrink-0" aria-hidden />
        {matches.length === 0 ? (
          <span className="text-[hsl(var(--warning))]">
            No matches in your last {sampleTxns.length.toLocaleString()} transactions - check the text above
          </span>
        ) : (
          <span className="text-[hsl(var(--muted-foreground))]">
            Matches <strong className="text-[hsl(var(--foreground))]">{matches.length.toLocaleString()}</strong> of
            your last {sampleTxns.length.toLocaleString()} transactions
          </span>
        )}
      </div>
      {matches.slice(0, 4).map((t, i) => (
        <div key={i} className="flex items-baseline gap-3 px-3 py-1.5 border-t text-xs">
          <span className="text-[hsl(var(--muted-foreground))] tabular-nums shrink-0">{t.date}</span>
          <span className="flex-1 min-w-0 truncate">{highlightMatch(t.description, form)}</span>
          <span className="tabular-nums shrink-0">{formatCurrency(t.amount_cents)}</span>
        </div>
      ))}
      {matches.length > 4 && (
        <div className="px-3 py-1 border-t text-[10px] text-[hsl(var(--muted-foreground))]">
          + {(matches.length - 4).toLocaleString()} more
        </div>
      )}
    </div>
  );
}

interface RuleFormProps {
  form: RuleFormState;
  setForm: React.Dispatch<React.SetStateAction<RuleFormState>>;
  categories: { id: number; name: string }[];
  sampleTxns: SampleTxn[];
  applyOnSave: boolean;
  onApplyOnSaveChange: (v: boolean) => void;
  onSubmit: () => void;
  submitLabel: string;
  saving: boolean;
  error?: string | null;
  onCancel?: () => void;
}

function RuleForm({ form, setForm, categories, sampleTxns, applyOnSave, onApplyOnSaveChange, onSubmit, submitLabel, saving, error, onCancel }: RuleFormProps) {
  const set = <K extends keyof RuleFormState>(key: K, val: RuleFormState[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-[hsl(var(--error))]">{error}</p>}

      {/* ── Simple mode ── */}
      <div>
        <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] ">
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
        <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] ">Category</label>
        <select
          value={form.catId}
          onChange={(e) => set("catId", Number(e.target.value))}
          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm
                     bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
        >
          <CategoryOptions categories={categories} />
        </select>
      </div>

      {/* ── Optional amount conditions ── */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] ">
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
          <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] ">
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

      {/* ── Live match preview ── */}
      <MatchPreview form={form} sampleTxns={sampleTxns} />

      {/* ── Advanced toggle ── */}
      <details
        open={form.showAdvanced}
        onToggle={(e) => set("showAdvanced", (e.currentTarget as HTMLDetailsElement).open)}
        className="group border rounded-lg"
      >
        <summary className="px-3 py-2 text-xs font-medium cursor-pointer select-none
                            text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                            list-none flex items-center gap-1.5 transition-colors">
          <CaretRightIcon size={10} weight="bold" className="group-open:rotate-90 transition-transform" aria-hidden />
          Advanced, match type &amp; regex
        </summary>
        <div className="px-3 pb-3 space-y-3 border-t mt-0 pt-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] ">Match type</label>
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
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] ">
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
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] ">
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
      <label className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))] cursor-pointer select-none">
        <input
          type="checkbox"
          checked={applyOnSave}
          onChange={(e) => onApplyOnSaveChange(e.target.checked)}
          className="accent-[hsl(var(--primary))]"
        />
        Also categorize existing uncategorized transactions on save
      </label>
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
  const { onBackdropClick, containerRef } = useModalDismiss(onClose);
  const categories = useCategoryStore((s) => s.categories);
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const defaultCatId = categories[0]?.id ?? 1;
  const [addForm, setAddForm] = useState<RuleFormState>(() => makeEmptyForm(defaultCatId));
  const [applyOnSave, setApplyOnSave] = useState(true);
  const [appliedNote, setAppliedNote] = useState<string | null>(null);
  // Recent transactions for the live tester - loaded once per modal open.
  const [sampleTxns, setSampleTxns] = useState<SampleTxn[]>([]);

  // Inline edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<RuleFormState>(() => makeEmptyForm(defaultCatId));
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const db = await getDb();
      const rows = await db.select<SampleTxn[]>(
        `SELECT date, description, amount_cents FROM transactions
          WHERE profile_id=? ORDER BY date DESC, id DESC LIMIT 1000`,
        [profileId]
      );
      setSampleTxns(rows);
    })().catch(console.error);
  }, [profileId]);

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
    setAppliedNote(null);
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
      if (applyOnSave) {
        const n = await reapplyCategorizationRules(profileId, "uncategorized");
        setAppliedNote(n > 0 ? `Rule added - ${n.toLocaleString()} existing ${n === 1 ? "transaction" : "transactions"} categorized.` : "Rule added.");
      } else {
        setAppliedNote("Rule added.");
      }
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
    setAppliedNote(null);
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
      if (applyOnSave) {
        const n = await reapplyCategorizationRules(profileId, "uncategorized");
        setAppliedNote(n > 0 ? `Rule updated - ${n.toLocaleString()} existing ${n === 1 ? "transaction" : "transactions"} categorized.` : "Rule updated.");
      }
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
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      onClick={onBackdropClick} ref={containerRef}
      role="dialog" aria-modal="true" aria-label="Categorization rules"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.15 }}
        className="bg-[hsl(var(--background))] border rounded-2xl shadow-xl w-full max-w-2xl
                      flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b shrink-0">
          <div>
            <h2 className="text-lg font-semibold">Categorization Rules</h2>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">
              Rules are matched in priority order. Higher priority rules win.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                                               transition-colors"><XIcon size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {appliedNote && (
            <p className="text-xs px-3 py-2 rounded-lg border border-[hsl(var(--success)/0.3)] text-[hsl(var(--success))]"
               style={{ backgroundColor: "hsl(var(--success)/0.06)" }} role="status">
              {appliedNote}
            </p>
          )}
          {/* ── Add new rule ────────────────────────────────────────── */}
          <div className="border rounded-xl p-4 space-y-3 bg-[hsl(var(--muted)/0.4)]">
            <h3 className="text-sm font-semibold">Add Rule</h3>
            <RuleForm
              form={addForm}
              setForm={setAddForm}
              categories={categories}
              sampleTxns={sampleTxns}
              applyOnSave={applyOnSave}
              onApplyOnSaveChange={setApplyOnSave}
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
                          sampleTxns={sampleTxns}
                          applyOnSave={applyOnSave}
                          onApplyOnSaveChange={setApplyOnSave}
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
                        <span className="text-[10px] tabular-nums text-[hsl(var(--muted-foreground))] shrink-0"
                              title="Priority - higher rules are checked first">
                          {r.priority}
                        </span>
                        <button
                          onClick={() => startEdit(r)}
                          title="Edit rule"
                          className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--gold-ink))]
                                     transition-colors shrink-0 px-1"
                        >
                          <PencilSimpleIcon size={14} />
                        </button>
                        <button
                          onClick={() => deleteRule(r.id)}
                          title="Delete rule"
                          className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--error))] transition-colors shrink-0 px-1"
                        >
                          <TrashIcon size={14} />
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
              <CaretRightIcon size={12} weight="bold" className="group-open:rotate-90 transition-transform" aria-hidden />
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
      </motion.div>
    </motion.div>
  );
}
