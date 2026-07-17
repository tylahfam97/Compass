import { useState } from "react";
import { motion } from "motion/react";
import { Upload, Loader2, Info } from "lucide-react";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import { upsertLoanStatement, type LoanAccount } from "@/lib/db";
import { parseLoanStatementPdf } from "@/lib/pdfParse";

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

  const handlePdfUpload = async (file: File) => {
    setParsing(true);
    setError(null);
    setPdfNotice(null);
    try {
      const fields = await parseLoanStatementPdf(file);
      let foundAny = false;
      if (fields.balance) { setBalance(fields.balance.replace(/,/g, "")); foundAny = true; }
      if (fields.interestRatePct) { setInterestRate(fields.interestRatePct); foundAny = true; }
      if (fields.minimumPayment) { setMinimumPayment(fields.minimumPayment.replace(/,/g, "")); foundAny = true; }
      if (fields.statementDate) { setStatementDate(parseLooseDate(fields.statementDate)); foundAny = true; }
      setPdfNotice(
        foundAny
          ? "Pulled what we could find from the PDF - double-check the fields below before saving."
          : "Couldn't find recognizable fields in that PDF - please fill in the details manually below."
      );
    } catch {
      setPdfNotice("Could not read that PDF. Please fill in the details manually below.");
    }
    setParsing(false);
  };

  const handleSave = async () => {
    if (!name.trim()) { setError("Loan name is required."); return; }
    const balanceCents = Math.round(parseDollarInput(balance) * 100);
    if (balanceCents <= 0) { setError("Enter the current balance owed on this loan."); return; }
    setSaving(true);
    setError(null);
    try {
      const rateInput = interestRate.trim();
      const paymentInput = minimumPayment.trim();
      await upsertLoanStatement({
        profileId,
        accountId: existingLoan?.id ?? null,
        name: name.trim(),
        institution: institution.trim(),
        interestRateBps: rateInput ? Math.round(parseFloat(rateInput) * 100) : null,
        minimumPaymentCents: paymentInput ? Math.round(parseDollarInput(paymentInput) * 100) : null,
        statementDate,
        balanceCents,
      });
      onSaved();
      onClose();
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

        <label
          className={`mb-4 flex items-center justify-center gap-2 border-2 border-dashed rounded-xl p-4 text-sm cursor-pointer
                      transition-colors hover:border-[hsl(var(--primary))]
                      ${parsing ? "opacity-60 cursor-wait" : ""}`}
        >
          {parsing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
          <span>{parsing ? "Reading PDF…" : "Upload statement PDF (optional) - pre-fills the fields below"}</span>
          <input
            type="file"
            accept=".pdf"
            className="hidden"
            disabled={parsing}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePdfUpload(f); e.target.value = ""; }}
          />
        </label>

        {pdfNotice && (
          <p className="mb-4 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
            <Info size={12} className="shrink-0 mt-0.5" />
            {pdfNotice}
          </p>
        )}

        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Loan Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdd}
              placeholder="e.g. Car Loan, Student Loan"
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] disabled:opacity-60" />
          </div>

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
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
