import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Upload, Loader2, Info } from "lucide-react";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import { upsertLoanStatement, getLoanAccountsForProfile, type LoanAccount } from "@/lib/db";
import { parseLoanStatementFile } from "@/lib/pdfParse";

interface Props {
  profileId: number;
  /** Pass an existing loan to add a new statement to it (name/institution/rate/payment are
   *  pre-filled and stay editable); omit to create a brand-new loan account. */
  existingLoan?: LoanAccount;
  onClose: () => void;
  onSaved: () => void;
}

/** Loosely parses "MM/DD/YYYY", "MM/DD/YY", "YYYY-MM-DD", and "Month DD, YYYY" into YYYY-MM-DD. */
function parseLooseDate(s: string): string {
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let year = slash[3];
    if (year.length === 2) year = (Number(year) < 70 ? "20" : "19") + year;
    return `${year}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date().toISOString().split("T")[0] : d.toISOString().split("T")[0];
}

function parseDollarInput(s: string): number {
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
}

/** True if `guess` (a loosely-extracted lender name) plausibly refers to `loan` - used to
 *  auto-pick an existing loan account while bulk-uploading several statements at once so the
 *  user isn't forced to match every file by hand. Deliberately loose (substring, either
 *  direction) since extracted lender text rarely matches an account name verbatim. */
function institutionMatchesLoan(guess: string, loan: LoanAccount): boolean {
  const g = guess.trim().toLowerCase();
  if (!g) return false;
  const candidates = [loan.institution, loan.name].map((s) => s.trim().toLowerCase()).filter(Boolean);
  return candidates.some((c) => c === g || c.includes(g) || g.includes(c));
}

export default function LoanUploaderModal({ profileId, existingLoan, onClose, onSaved }: Props) {
  const { onBackdropClick } = useModalDismiss(onClose);
  const isAdd = !existingLoan;

  const [name, setName] = useState(existingLoan?.name ?? "");
  const [institution, setInstitution] = useState(existingLoan?.institution ?? "");
  const [statementDate, setStatementDate] = useState(new Date().toISOString().split("T")[0]);
  const [balance, setBalance] = useState(
    existingLoan?.balance_cents != null ? (Math.abs(existingLoan.balance_cents) / 100).toFixed(2) : ""
  );
  const [interestRate, setInterestRate] = useState(
    existingLoan?.interest_rate_bps != null ? (existingLoan.interest_rate_bps / 100).toFixed(2) : ""
  );
  const [minimumPayment, setMinimumPayment] = useState(
    existingLoan?.minimum_payment_cents != null ? (existingLoan.minimum_payment_cents / 100).toFixed(2) : ""
  );
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pdfNotice, setPdfNotice] = useState<string | null>(null);

  // Only relevant on the generic "Add Loan" flow (existingLoan is undefined) - lets the user
  // point a new statement at an already-existing loan account instead of retyping its exact
  // name, which previously silently created a duplicate account on any mismatch.
  const [existingLoans, setExistingLoans] = useState<LoanAccount[]>([]);
  const [accountChoice, setAccountChoice] = useState<"new" | number>("new");

  // Bulk upload: extra files picked alongside the first one. The first file drives every
  // "header" field below (loan/account, lender, rate, payment) - same as picking a bank/column
  // mapping once in the transaction wizard - while each extra file only contributes its own
  // parsed balance + statement date, and the whole batch imports together in one action.
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchWarning, setBatchWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdd) return;
    getLoanAccountsForProfile(profileId).then(setExistingLoans).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  const selectedExistingLoan = typeof accountChoice === "number"
    ? existingLoans.find((l) => l.id === accountChoice)
    : undefined;

  const applyLoanFields = (loan: LoanAccount) => {
    setName(loan.name);
    setInstitution(loan.institution);
    setInterestRate(loan.interest_rate_bps != null ? (loan.interest_rate_bps / 100).toFixed(2) : "");
    setMinimumPayment(loan.minimum_payment_cents != null ? (loan.minimum_payment_cents / 100).toFixed(2) : "");
  };

  const handleFileUpload = async (file: File) => {
    setParsing(true);
    setError(null);
    setPdfNotice(null);
    try {
      const fields = await parseLoanStatementFile(file);
      let foundAny = false;
      if (fields.balance) { setBalance(fields.balance.replace(/,/g, "")); foundAny = true; }
      if (fields.interestRatePct) { setInterestRate(fields.interestRatePct); foundAny = true; }
      if (fields.minimumPayment) { setMinimumPayment(fields.minimumPayment.replace(/,/g, "")); foundAny = true; }
      if (fields.statementDate) { setStatementDate(parseLooseDate(fields.statementDate)); foundAny = true; }
      if (fields.institution) {
        foundAny = true;
        const match = isAdd ? existingLoans.find((l) => institutionMatchesLoan(fields.institution!, l)) : undefined;
        if (match) {
          setAccountChoice(match.id);
          applyLoanFields(match);
        } else {
          setInstitution(fields.institution);
        }
      }
      setPdfNotice(
        foundAny
          ? "Pulled what we could find from the statement - double-check the fields below before saving."
          : "Couldn't find recognizable fields in that file - please fill in the details manually below."
      );
    } catch {
      setPdfNotice("Could not read that file. Please fill in the details manually below.");
    }
    setParsing(false);
  };

  const handleFilesSelected = (files: File[]) => {
    if (files.length === 0) return;
    const [first, ...rest] = files;
    setBatchFiles(rest);
    setBatchWarning(null);
    handleFileUpload(first);
  };

  const handleSave = async () => {
    if (!name.trim()) { setError("Loan name is required."); return; }
    const balanceCents = Math.round(parseDollarInput(balance) * 100);
    if (balanceCents <= 0) { setError("Enter the current balance owed on this loan."); return; }
    setSaving(true);
    setError(null);
    setBatchWarning(null);
    try {
      const rateInput = interestRate.trim();
      const paymentInput = minimumPayment.trim();
      const interestRateBps = rateInput ? Math.round(parseFloat(rateInput) * 100) : null;
      const minimumPaymentCents = paymentInput ? Math.round(parseDollarInput(paymentInput) * 100) : null;
      const initialAccountId = existingLoan?.id ?? (typeof accountChoice === "number" ? accountChoice : null);

      // The first file/entry resolves (or creates) the account - every subsequent file in the
      // batch reuses that SAME account id below, rather than accountChoice/null, so a "new
      // loan" pick doesn't insert a fresh duplicate account per extra file.
      const savedAccountId = await upsertLoanStatement({
        profileId,
        accountId: initialAccountId,
        name: name.trim(),
        institution: institution.trim(),
        interestRateBps,
        minimumPaymentCents,
        statementDate,
        balanceCents,
      });

      const skipped: string[] = [];
      for (let i = 0; i < batchFiles.length; i++) {
        setBatchProgress({ done: i, total: batchFiles.length });
        const file = batchFiles[i];
        try {
          const fields = await parseLoanStatementFile(file);
          const parsedBalanceCents = fields.balance ? Math.round(parseDollarInput(fields.balance) * 100) : 0;
          const parsedDate = fields.statementDate ? parseLooseDate(fields.statementDate) : null;
          if (parsedBalanceCents <= 0 || !parsedDate) { skipped.push(file.name); continue; }
          await upsertLoanStatement({
            profileId,
            accountId: savedAccountId,
            name: name.trim(),
            institution: institution.trim(),
            interestRateBps,
            minimumPaymentCents,
            statementDate: parsedDate,
            balanceCents: parsedBalanceCents,
          });
        } catch {
          skipped.push(file.name);
        }
      }
      setBatchProgress(null);

      if (skipped.length > 0) {
        const total = batchFiles.length + 1;
        setBatchWarning(
          `Imported ${total - skipped.length} of ${total} statements - couldn't find a balance and date in: ${skipped.join(", ")}. Add ${skipped.length === 1 ? "it" : "them"} individually.`
        );
        setBatchFiles([]);
        onSaved();
      } else {
        onSaved();
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setSaving(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      onClick={onBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.15 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-[hsl(var(--background))] border rounded-2xl shadow-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto"
      >
        <h2 className="text-lg font-semibold mb-1">{isAdd ? "Add a Loan" : `Add a Statement - ${existingLoan!.name}`}</h2>
        <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">
          Loans aren't counted toward liquidity and are excluded from income/expense totals -
          they only track balance over time for the Loan Dashboard and net worth.
        </p>

        {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
        {batchWarning && <p className="mb-3 text-sm text-amber-600 dark:text-amber-400">{batchWarning}</p>}

        <label
          className={`mb-4 flex items-center justify-center gap-2 border-2 border-dashed rounded-xl p-4 text-sm cursor-pointer
                      transition-colors hover:border-[hsl(var(--primary))]
                      ${parsing ? "opacity-60 cursor-wait" : ""}`}
        >
          {parsing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
          <span>{parsing ? "Reading statement…" : "Upload statement PDF, CSV, or XLSX (optional) - pre-fills the fields below"}</span>
          <input
            type="file"
            accept=".pdf,.csv,.xlsx,.xls"
            multiple
            className="hidden"
            disabled={parsing}
            onChange={(e) => { const files = Array.from(e.target.files ?? []); handleFilesSelected(files); e.target.value = ""; }}
          />
        </label>

        {pdfNotice && (
          <p className="mb-2 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
            <Info size={12} className="shrink-0 mt-0.5" />
            {pdfNotice}
          </p>
        )}
        {batchFiles.length > 0 && (
          <p className="mb-4 text-xs text-[hsl(var(--muted-foreground))] flex items-start gap-1.5">
            <Info size={12} className="shrink-0 mt-0.5" />
            {batchProgress
              ? `Importing statement ${batchProgress.done + 1} of ${batchFiles.length + 1}…`
              : `${batchFiles.length} more statement${batchFiles.length === 1 ? "" : "s"} will import automatically using the loan/lender details below - only each file's own balance and date are read individually.`}
          </p>
        )}

        <div className="space-y-4">
          {isAdd && existingLoans.length > 0 && (
            <div className="flex gap-3 text-sm">
              <button
                onClick={() => setAccountChoice("new")}
                className={`px-3 py-1.5 rounded-lg border transition-colors ${accountChoice === "new" ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
              >
                New loan
              </button>
              <button
                onClick={() => {
                  const target = selectedExistingLoan ?? existingLoans[0];
                  setAccountChoice(target.id);
                  applyLoanFields(target);
                }}
                className={`px-3 py-1.5 rounded-lg border transition-colors ${typeof accountChoice === "number" ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent" : "hover:bg-[hsl(var(--muted))]"}`}
              >
                Existing loan
              </button>
            </div>
          )}

          {isAdd && typeof accountChoice === "number" ? (
            <div>
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Loan</label>
              <select
                value={accountChoice}
                onChange={(e) => {
                  const loan = existingLoans.find((l) => l.id === parseInt(e.target.value));
                  if (loan) { setAccountChoice(loan.id); applyLoanFields(loan); }
                }}
                className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
              >
                {existingLoans.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}{l.institution ? ` (${l.institution})` : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Loan Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdd}
                placeholder="e.g. Car Loan, Student Loan"
                className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] disabled:opacity-60" />
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">
              Lender / Institution <span className="normal-case">(optional)</span>
            </label>
            <input value={institution} onChange={(e) => setInstitution(e.target.value)}
              placeholder="e.g. Chase, SoFi, Navient"
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Statement Date</label>
              <input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)}
                className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]" />
            </div>
            <div>
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Current Balance</label>
              <input type="number" step="0.01" min="0" value={balance} onChange={(e) => setBalance(e.target.value)}
                placeholder="12,500.00"
                className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">
                Interest Rate <span className="normal-case">(optional)</span>
              </label>
              <input type="number" step="0.01" min="0" value={interestRate} onChange={(e) => setInterestRate(e.target.value)}
                placeholder="6.50%"
                className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]" />
            </div>
            <div>
              <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">
                Min. Payment <span className="normal-case">(optional)</span>
              </label>
              <input type="number" step="0.01" min="0" value={minimumPayment} onChange={(e) => setMinimumPayment(e.target.value)}
                placeholder="250.00"
                className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]" />
            </div>
          </div>
          <p className="text-[11px] text-[hsl(var(--muted-foreground))] flex items-start gap-1.5">
            <Info size={11} className="shrink-0 mt-0.5" />
            Interest rate and minimum payment are for reference only (and to rank loans on the
            Loan Dashboard) - they're never used to calculate interest or payoff projections.
          </p>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
            {batchWarning ? "Close" : "Cancel"}
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
            {saving
              ? (batchProgress ? `Importing ${batchProgress.done + 1} of ${batchFiles.length + 1}…` : "Saving…")
              : batchFiles.length > 0 ? `Import All (${batchFiles.length + 1} statements)` : "Save"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
