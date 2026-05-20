"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Building2, ChevronLeft, FileText, Loader2, Upload,
  CheckCircle2, AlertTriangle, Clock, RefreshCw, Landmark,
  Link2, Link2Off, X, Pencil, BookOpen, Download, Plus, Trash2,
  ShoppingCart, Receipt, Wallet, CreditCard, FolderOpen, ScrollText,
  BarChart3, ChevronDown, ChevronRight, ExternalLink, Search,
  Filter, ArrowUp, ArrowDown, Info
} from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";
import { toast } from "sonner";
import { extractPattern } from "@/lib/ledger-rules";
import { fuzzyMatchLedgers } from "@/lib/party-match";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { GLOBAL_RULES_DISPLAY } from "@/lib/ledger-rules";

interface Client {
  id: string;
  client_name: string;
  gstin: string | null;
  pan: string | null;
  industry_name: string | null;
  tds_applicable: boolean;
}

interface Document {
  id: string;
  original_filename: string;
  document_type: string;
  status: string;
  uploaded_at: string;
  processed_at: string | null;
  ai_model_used: string | null;
  conf: { high: number; medium: number; low: number } | null;
  possible_misclassification: boolean;
  invoice_number: string | null;
  invoice_date: string | null;
  total_amount: string | null;
  tds_amount: string | null;
  tds_section: string | null;
}

interface BankTxn {
  id: string;
  transaction_date: string;
  narration: string;
  ref_number: string | null;
  debit_amount: number | null;
  credit_amount: number | null;
  balance: number | null;
  bank_name: string;
  status: string;
  category: string | null;
  voucher_type: string | null;
  ledger_name: string | null;
  ledger_source?: string | null;
  ledger_rule_progress?: { count: number; total: number } | null;
  // match reasoning (only present for matched/possible_match)
  match_score?: number | null;
  match_reasons?: string[] | null;
  matched_invoice_number?: string | null;
  matched_doc_filename?: string | null;
  flags?: string[];
}

interface BankSummary {
  total: number;
  total_rows_in_db: number;
  truncated: boolean;
  total_debit: number;
  total_credit: number;
  matched: number;
  unmatched: number;
  ledger_mapped: number;
  flag_count: number;
}

interface ReconDoc {
  id: string;
  original_filename: string;
  document_type: string;
  status?: string;
  total_amount?: string | null;
  invoice_date?: string | null;
  invoice_number?: string | null;
}

interface Reconciliation {
  id: string;
  status: string;
  match_score: number;
  match_reasons: string[];
  matched_at: string;
  bank_transactions: BankTxn | BankTxn[];
  documents: ReconDoc | ReconDoc[];
  doc_total_amount: string | null;
  doc_invoice_number: string | null;
  doc_tds_amount: string | null;
  doc_tds_section: string | null;
}

interface ReconData {
  summary: { matched: number; possible: number; exceptions: number; unmatched_transactions: number; unresolved: number; categorized_no_invoice: number; unmatched_invoices: number; total_bank_transactions: number; explained: number; doc_type_breakdown: Record<string, { total: number; matched: number }> };
  reconciliations: Reconciliation[];
  unmatched_transactions: BankTxn[];
  unmatched_invoices: ReconDoc[];
}

const CATEGORIES = [
  "Vendor Payment","Customer Receipt","GST Payment","TDS Payment","Salary","Rent",
  "Bank Charges","Loan Repayment","Insurance","Interest Income","Interest Expense",
  "Inter-bank Transfer","Other Payment","Other Receipt",
];
const VOUCHER_TYPES = ["Payment","Receipt","Journal","Contra","Purchase","Sales"];

const FLAG_CONFIG: Record<string, { label: string; description: string; severity: "high" | "medium" }> = {
  direction_mismatch:    { label: "Direction mismatch", description: "Debit assigned to income ledger or credit assigned to expense ledger — likely wrong mapping", severity: "high" },
  cash_limit_269st:      { label: "Cash >₹2L (269ST)", description: "Cash/contra transaction exceeds ₹2,00,000 — may violate Section 269ST", severity: "high" },
  round_trip:            { label: "Round trip", description: "Same pattern, same amount, opposite direction within 7 days — possible circular transaction", severity: "medium" },
  salary_tds_missing:    { label: "Salary TDS missing", description: "Salary payment in this month but no TDS payment found — possible non-compliance", severity: "medium" },
  not_in_ledger_master:  { label: "Not in ledger master", description: "Assigned ledger does not exist in this client's ledger master", severity: "medium" },
};

// Transactions in these categories never have an invoice — hide "unmatched" for them
const DIRECT_EXPENSE_CATEGORIES = new Set([
  "Bank Charges","Salary","GST Payment","TDS Payment","Loan Repayment",
  "Insurance","Interest Income","Interest Expense","Inter-bank Transfer",
]);
// Ledger keywords that also indicate no invoice expected
const DIRECT_EXPENSE_LEDGER_PATTERNS = [
  "bank charges","salary","payroll","wages","gst cash","tds payable",
  "pf / esi","pf/esi","provident fund","loan repayment","interest income",
  "interest expense","insurance","electricity","telephone","internet",
];

function needsInvoiceMatch(txn: { category?: string | null; ledger_name?: string | null }): boolean {
  if (txn.category && DIRECT_EXPENSE_CATEGORIES.has(txn.category)) return false;
  if (txn.ledger_name) {
    const l = txn.ledger_name.toLowerCase();
    if (DIRECT_EXPENSE_LEDGER_PATTERNS.some(p => l.includes(p))) return false;
  }
  return true;
}

function MiniCategoryChip({ txnId, value, field, editingTxn, setEditingTxn, onSave }: {
  txnId: string; value: string | null | undefined; field: "category" | "voucher_type";
  editingTxn: string | null; setEditingTxn: (v: string | null) => void;
  onSave: (id: string, field: "category" | "voucher_type", value: string) => void;
}) {
  const key = `${txnId}-${field}`;
  if (editingTxn === key) {
    return (
      <select autoFocus defaultValue={value ?? ""}
        className="text-xs rounded border border-blue-300 px-1 py-0.5 max-w-[130px]"
        onBlur={(e) => { if (e.target.value) onSave(txnId, field, e.target.value); else setEditingTxn(null); }}
        onChange={(e) => { if (e.target.value) onSave(txnId, field, e.target.value); }}>
        <option value="">— select —</option>
        {(field === "category" ? CATEGORIES : VOUCHER_TYPES).map((o) => <option key={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <button onClick={() => setEditingTxn(key)}
      className="group inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 hover:opacity-80 max-w-[130px] truncate">
      <span className="truncate">{value ?? "Set category"}</span>
      <Pencil size={9} className="opacity-0 group-hover:opacity-60 flex-shrink-0" />
    </button>
  );
}

const STATUS_CONFIG: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  review_required: { label: "Needs review",  cls: "bg-amber-50 text-amber-700 border-amber-200",   icon: <AlertTriangle size={10} /> },
  reviewed:        { label: "Reviewed",      cls: "bg-green-50 text-green-700 border-green-200",    icon: <CheckCircle2 size={10} /> },
  reconciled:      { label: "Reconciled",    cls: "bg-blue-50 text-blue-700 border-blue-200",       icon: <CheckCircle2 size={10} /> },
  posted:          { label: "Posted",        cls: "bg-purple-50 text-purple-700 border-purple-200", icon: <CheckCircle2 size={10} /> },
  extracting:      { label: "Processing",    cls: "bg-gray-50 text-gray-600 border-gray-200",       icon: <Loader2 size={10} className="animate-spin" /> },
  queued:          { label: "Queued",        cls: "bg-gray-50 text-gray-500 border-gray-200",       icon: <Clock size={10} /> },
  failed:          { label: "Failed",        cls: "bg-red-50 text-red-700 border-red-200",          icon: <AlertTriangle size={10} /> },
};

const DOC_TYPE_LABELS: Record<string, string> = {
  purchase_invoice: "Purchase Invoice",
  sales_invoice: "Sales Invoice",
  expense: "Expense",
  bank_statement: "Bank Statement",
  credit_note: "Credit Note",
  debit_note: "Debit Note",
};

const RETRYABLE = new Set(["extracting", "queued", "failed"]);

export default function ClientDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const clientId = params.clientId as string;

  const [client, setClient] = useState<Client | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [livePendingCount, setLivePendingCount] = useState<number | null>(null);
  const [editClientOpen, setEditClientOpen] = useState(false);
  const [editClientForm, setEditClientForm] = useState({ client_name: "", gstin: "", pan: "", industry_name: "" });
  const [savingClient, setSavingClient] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retagging, setRetagging] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"documents" | "bank" | "reconciliation" | "ledgers" | "gst" | "expected" | "summary" | "ledger_view" | "mapping">("documents");
  const [docFolder, setDocFolder] = useState<string | null>(() => searchParams.get("folder")); // restore folder from back-navigation
  const [bankTxns, setBankTxns] = useState<BankTxn[]>([]);
  const [bankSummary, setBankSummary] = useState<BankSummary | null>(null);
  const [bankLoading, setBankLoading] = useState(false);
  const [bankUploadOpen, setBankUploadOpen] = useState(false);
  const [bankUploading, setBankUploading] = useState(false);
  const [bankUploadMsg, setBankUploadMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [bankUploadBankName, setBankUploadBankName] = useState("HDFC Bank");
  const bankUploadRef = useRef<HTMLInputElement>(null);

  // Reconciliation tab state
  const [reconData, setReconData] = useState<ReconData | null>(null);
  const [reconLoading, setReconLoading] = useState(false);
  const [reconMatching, setReconMatching] = useState(false);
  const [bankMatching, setBankMatching] = useState(false);
  const [wipingBank, setWipingBank] = useState(false);
  const [wipeDialogOpen, setWipeDialogOpen] = useState(false);
  const [deleteDocTarget, setDeleteDocTarget] = useState<{ id: string; fileName: string } | null>(null);
  const [showCategorised, setShowCategorised] = useState(false);
  const [reconTab, setReconTab] = useState<"matched" | "possible" | "unmatched" | "invoices">("unmatched");
  const [reconFilter, setReconFilter] = useState("");
  const [bankFilter, setBankFilter] = useState("");
  const [bsFromDate, setBsFromDate] = useState("");
  const [bsToDate,   setBsToDate]   = useState("");
  const [bsLedgerFilters, setBsLedgerFilters] = useState<Set<string>>(new Set());
  const [bsStatusFilters, setBsStatusFilters] = useState<Set<string>>(new Set());
  const [bsCategoryFilters, setBsCategoryFilters] = useState<Set<string>>(new Set());
  const [bsFlagsOnly, setBsFlagsOnly] = useState(false);
  const [bsDateSort, setBsDateSort] = useState<"asc" | "desc">("asc");
  const [openFilterCol, setOpenFilterCol] = useState<string | null>(null);
  const [bsColFilterSearch, setBsColFilterSearch] = useState("");
  const [linkingTxn, setLinkingTxn] = useState<BankTxn | null>(null);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [editingTxn, setEditingTxn] = useState<string | null>(null);

  // Claim transactions state
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimTxns, setClaimTxns] = useState<{ id: string; transaction_date: string; narration: string; bank_name: string; debit_amount: number | null; credit_amount: number | null }[]>([]);
  const [claimBanks, setClaimBanks] = useState<string[]>([]);
  const [claimBankFilter, setClaimBankFilter] = useState("");
  const [claimSelected, setClaimSelected] = useState<Set<string>>(new Set());
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimSaving, setClaimSaving] = useState(false);

  // Bank book import state — two-file flow: bank statement + bank book → match → rules
  type BbRuleCandidate = { pattern: string; ledger_name: string; occurrences: number; sample_narration: string; sample_date: string; amount: number; direction: "debit"|"credit"; status: "auto"|"conflicted"; conflict_ledgers?: string[] };
  type BbAmbiguous = { bb_row: { date: string; particulars: string; debit: number|null; credit: number|null }; candidates: { date: string; narration: string; debit: number|null; credit: number|null }[] };
  type BbMatchResult = { total_bb_rows: number; total_stmt_rows: number; matched_count: number; ambiguous_count: number; unmatched_count: number; rule_candidates: BbRuleCandidate[]; ambiguous: BbAmbiguous[]; unmatched_bb: { date: string; particulars: string; debit: number|null; credit: number|null }[] };
  type BbColsNeeded = { needs_column_mapping: true; bb_raw_headers: string[]; bb_preview: Record<string,string>[]; stmt_raw_headers: string[]; stmt_preview: Record<string,string>[]; bb_confident: boolean; stmt_confident: boolean };

  const [bbImportOpen, setBbImportOpen] = useState(false);
  const [bbStep, setBbStep] = useState<"upload"|"columns"|"review">("upload");
  const [bbUploading, setBbUploading] = useState(false);
  const [bbConfirming, setBbConfirming] = useState(false);
  const [bbResult, setBbResult] = useState<BbMatchResult | null>(null);
  const [bbColsNeeded, setBbColsNeeded] = useState<BbColsNeeded | null>(null);
  const [bbFinancialYear, setBbFinancialYear] = useState<string>(() => {
    const now = new Date();
    const yr = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return `${yr}-${String(yr + 1).slice(-2)}`;
  });
  const [bbColDate, setBbColDate] = useState("");
  const [bbColParticulars, setBbColParticulars] = useState("");
  const [bbColDebit, setBbColDebit] = useState("");
  const [bbColCredit, setBbColCredit] = useState("");
  const [stmtColDate, setStmtColDate] = useState("");
  const [stmtColNarration, setStmtColNarration] = useState("");
  const [stmtColDebit, setStmtColDebit] = useState("");
  const [stmtColCredit, setStmtColCredit] = useState("");
  // Key: particulars+date → chosen statement narration
  const [bbAmbiguousSelections, setBbAmbiguousSelections] = useState<Record<string, string>>({});
  // Key: pattern → chosen ledger_name (for conflicted rules)
  const [bbConflictOverrides, setBbConflictOverrides] = useState<Record<string, string>>({});
  const bbFileRef = useRef<HTMLInputElement>(null);
  const stmtFileRef = useRef<HTMLInputElement>(null);
  const [bbFileObj, setBbFileObj] = useState<File | null>(null);
  const [stmtFileObj, setStmtFileObj] = useState<File | null>(null);

  function bbReset() {
    setBbStep("upload"); setBbResult(null); setBbColsNeeded(null);
    setBbAmbiguousSelections({}); setBbConflictOverrides({});
    setBbColDate(""); setBbColParticulars(""); setBbColDebit(""); setBbColCredit("");
    setStmtColDate(""); setStmtColNarration(""); setStmtColDebit(""); setStmtColCredit("");
    setBbFileObj(null); setStmtFileObj(null);
  }

  async function submitBbFiles(colOverrides?: {
    bb_date?: string; bb_particulars?: string; bb_debit?: string; bb_credit?: string;
    stmt_date?: string; stmt_narration?: string; stmt_debit?: string; stmt_credit?: string;
  }) {
    if (!bbFileObj || !stmtFileObj) return;
    setBbUploading(true);
    const fd = new FormData();
    fd.append("bankbook_file", bbFileObj);
    fd.append("statement_file", stmtFileObj);
    if (colOverrides?.bb_date)        fd.append("bb_column_date", colOverrides.bb_date);
    if (colOverrides?.bb_particulars) fd.append("bb_column_particulars", colOverrides.bb_particulars);
    if (colOverrides?.bb_debit)       fd.append("bb_column_debit", colOverrides.bb_debit);
    if (colOverrides?.bb_credit)      fd.append("bb_column_credit", colOverrides.bb_credit);
    if (colOverrides?.stmt_date)      fd.append("stmt_column_date", colOverrides.stmt_date);
    if (colOverrides?.stmt_narration) fd.append("stmt_column_narration", colOverrides.stmt_narration);
    if (colOverrides?.stmt_debit)     fd.append("stmt_column_debit", colOverrides.stmt_debit);
    if (colOverrides?.stmt_credit)    fd.append("stmt_column_credit", colOverrides.stmt_credit);
    try {
      const res = await fetch(`/api/v1/clients/${clientId}/import-bank-book`, { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) { toast.error(d.error ?? "Import failed"); return; }
      if (d.needs_column_mapping) {
        setBbColsNeeded(d as BbColsNeeded);
        setBbStep("columns");
      } else {
        setBbResult(d as BbMatchResult);
        setBbStep("review");
      }
    } finally {
      setBbUploading(false);
    }
  }

  async function confirmBbRules() {
    if (!bbResult) return;
    setBbConfirming(true);
    const autoRules = bbResult.rule_candidates
      .filter(c => c.status === "auto")
      .map(c => ({ pattern: c.pattern, ledger_name: c.ledger_name }));
    const conflictRules = bbResult.rule_candidates
      .filter(c => c.status === "conflicted" && bbConflictOverrides[c.pattern])
      .map(c => ({ pattern: c.pattern, ledger_name: bbConflictOverrides[c.pattern] }));
    // Ambiguous: CA picked a specific statement row → its narration is stored
    const ambigRules = bbResult.ambiguous
      .filter(amb => bbAmbiguousSelections[amb.bb_row.particulars + amb.bb_row.date])
      .map(amb => ({ pattern: bbAmbiguousSelections[amb.bb_row.particulars + amb.bb_row.date], ledger_name: amb.bb_row.particulars, _isNarration: true }));
    const rules = [
      ...autoRules,
      ...conflictRules,
      // For ambiguous, pattern is already computed server-side in candidates; we send narration and let server extract
      ...ambigRules.map(r => ({ pattern: r.pattern, ledger_name: r.ledger_name })),
    ];
    if (rules.length === 0) { toast.info("No rules to create"); setBbConfirming(false); return; }
    try {
      const res = await fetch(`/api/v1/clients/${clientId}/import-bank-book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, rules, financial_year: bbFinancialYear }),
      });
      const d = await res.json();
      if (res.ok) {
        const conflictNote = d.cross_year_conflicts?.length > 0
          ? ` (${d.cross_year_conflicts.length} rule${d.cross_year_conflicts.length > 1 ? "s" : ""} updated from a prior year)`
          : "";
        toast.success(`${d.created} ledger rule${d.created !== 1 ? "s" : ""} saved for FY ${bbFinancialYear}${conflictNote}`);
        setBbImportOpen(false);
        bbReset();
        loadBankTxns();
      } else {
        toast.error(d.error ?? "Failed to save rules");
      }
    } finally {
      setBbConfirming(false);
    }
  }

  // Ledger master state
  const [ledgers, setLedgers] = useState<{ id: string; ledger_name: string; ledger_type: string; closing_balance?: number | null; balance_type?: string | null; financial_year?: string | null; source?: string | null }[]>([]);
  const [ledgersLoading, setLedgersLoading] = useState(false);
  const [newLedgerName, setNewLedgerName] = useState("");
  const [newLedgerType, setNewLedgerType] = useState("expense");
  const [addingLedger, setAddingLedger] = useState(false);
  const [seedingLedgers, setSeedingLedgers] = useState(false);
  const [reapplying, setReapplying] = useState(false);
  const [importingLedgers, setImportingLedgers] = useState(false);
  const [trialBalanceFY, setTrialBalanceFY] = useState(() => {
    // Default to current Indian financial year e.g. "2024-25"
    const now = new Date();
    const yr = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return `${yr}-${String(yr + 1).slice(-2)}`;
  });
  const ledgerImportRef = useRef<HTMLInputElement>(null);
  const [selectedLedgerIds, setSelectedLedgerIds] = useState<Set<string>>(new Set());
  const [deletingLedgers, setDeletingLedgers] = useState(false);
  const [ledgerSearch, setLedgerSearch] = useState("");

  // Ledger mapping rules state
  interface MappingRule {
    id: string; client_id: string | null; industry_name: string | null;
    pattern: string; ledger_name: string; match_count: number; confirmed: boolean; updated_at: string; source?: string | null; financial_year?: string | null;
  }
  const [clientMappingRules, setClientMappingRules] = useState<MappingRule[]>([]);
  const [industryMappingRules, setIndustryMappingRules] = useState<MappingRule[]>([]);
  const [industryNameForRules, setIndustryNameForRules] = useState<string | null>(null);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [newRulePattern, setNewRulePattern] = useState("");
  const [newRuleLedger, setNewRuleLedger] = useState("");
  const [newRuleScope, setNewRuleScope] = useState<"client" | "industry">("client");
  const [addingRule, setAddingRule] = useState(false);
  const [ruleSearch, setRuleSearch] = useState("");
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editingRuleField, setEditingRuleField] = useState<"pattern" | "ledger_name" | null>(null);
  const [editingRuleValue, setEditingRuleValue] = useState("");

  // AI bulk rule suggestion state
  interface RuleSuggestion { pattern: string; example_narration: string; suggested_ledger: string; confidence: number; reason: string }
  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([]);
  const [suggestionOverrides, setSuggestionOverrides] = useState<Record<string, string>>({});
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [acceptingPatterns, setAcceptingPatterns] = useState<Set<string>>(new Set());

  // Summary note state
  interface ClientSummary { id: string; summary_md: string; generated_at: string; period_from: string | null; period_to: string | null; }
  const [summary, setSummary] = useState<ClientSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryGenerating, setSummaryGenerating] = useState(false);
  const [summaryPeriodFrom, setSummaryPeriodFrom] = useState("");
  const [summaryPeriodTo, setSummaryPeriodTo] = useState("");

  // Ledger view state
  interface InvoiceLine {
    doc_id: string; doc_type: string;
    invoice_number: string | null; invoice_date: string | null;
    taxable_value: number; cgst: number; sgst: number; igst: number;
    gst_rate_pct: string; total_gst: number; total_amount: number;
    tds_section: string | null; tds_rate: string | null; tds_amount: number;
    tds_reasoning: string | null; reverse_charge: string | null;
    net_payable: number; itc_eligible: string | null; suggested_ledger: string | null;
    payment: { date: string; amount: number; ref: string | null; narration: string } | null;
  }
  interface VendorLedger {
    vendor_name: string; invoice_count: number;
    total_taxable: number; total_gst: number; total_invoiced: number;
    total_tds: number; net_payable: number; paid: number; outstanding: number;
    invoices: InvoiceLine[];
  }
  interface CustomerLedger {
    customer_name: string; invoice_count: number;
    total_taxable: number; total_gst: number; total_invoiced: number;
    received: number; outstanding: number;
    invoices: InvoiceLine[];
  }
  interface ExpenseHead {
    ledger_name: string; invoice_count: number;
    total_taxable: number; total_gst: number; total_invoiced: number;
    total_tds: number; itc_eligible: number; itc_blocked: number;
  }
  interface LedgerData {
    purchase: {
      vendors: VendorLedger[];
      expense_heads: ExpenseHead[];
      totals: { invoiced: number; taxable: number; gst: number; itc_eligible: number; itc_blocked: number; tds: number; net_payable: number; paid: number; outstanding: number };
    };
    sales: {
      customers: CustomerLedger[];
      totals: { invoiced: number; taxable: number; output_gst: number; received: number; outstanding: number };
    };
    gst_position: { output_gst: number; itc_eligible: number; net_payable: number };
    tds_summary: { total_deducted: number; by_section: Record<string, number>; this_month: number; due_date: string | null };
  }
  const [ledgerData, setLedgerData] = useState<LedgerData | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerView, setLedgerView] = useState<"vendor" | "sales" | "head">("vendor");
  const [ledgerFromDate, setLedgerFromDate] = useState(() => currentFY().from);
  const [ledgerToDate, setLedgerToDate] = useState(() => currentFY().to);
  const [expandedVendors, setExpandedVendors] = useState<Set<string>>(new Set());

  function loadLedger(from?: string, to?: string) {
    setLedgerLoading(true);
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to)   p.set("to", to);
    fetch(`/api/v1/clients/${clientId}/ledger?${p}`)
      .then(r => r.json())
      .then(d => setLedgerData(d))
      .finally(() => setLedgerLoading(false));
  }

  function toggleVendor(name: string) {
    setExpandedVendors(prev => {
      const s = new Set(prev);
      s.has(name) ? s.delete(name) : s.add(name);
      return s;
    });
  }

  function loadSummary() {
    setSummaryLoading(true);
    fetch(`/api/v1/clients/${clientId}/summary`)
      .then(r => r.json())
      .then(d => setSummary(d.summary ?? null))
      .finally(() => setSummaryLoading(false));
  }

  async function generateSummary() {
    setSummaryGenerating(true);
    try {
      const res = await fetch(`/api/v1/clients/${clientId}/summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period_from: summaryPeriodFrom || null, period_to: summaryPeriodTo || null }),
      });
      const d = await res.json();
      if (res.ok) {
        setSummary(d.summary);
        toast.success("Summary note generated");
      } else {
        toast.error(d.error ?? "Generation failed");
      }
    } finally {
      setSummaryGenerating(false);
    }
  }

  function downloadSummary() {
    if (!summary) return;
    const clientName = client?.client_name ?? "client";
    const date = new Date(summary.generated_at).toISOString().slice(0, 10);
    const filename = `${clientName.replace(/\s+/g, "_")}_summary_${date}.md`;
    const blob = new Blob([summary.summary_md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // Expected invoices state
  interface ExpectedInvoice { id: string; vendor_name: string; approx_amount: number | null; expected_by: string | null; notes: string | null; status: string; created_at: string; }
  const [expectedInvoices, setExpectedInvoices] = useState<ExpectedInvoice[]>([]);
  const [expectedLoading, setExpectedLoading] = useState(false);
  const [newExpVendor, setNewExpVendor] = useState("");
  const [newExpAmount, setNewExpAmount] = useState("");
  const [newExpDate, setNewExpDate] = useState("");
  const [newExpNotes, setNewExpNotes] = useState("");
  const [addingExpected, setAddingExpected] = useState(false);

  function loadExpected() {
    setExpectedLoading(true);
    fetch(`/api/v1/clients/${clientId}/expected-invoices`)
      .then(r => r.json())
      .then(d => setExpectedInvoices(d.expected ?? []))
      .finally(() => setExpectedLoading(false));
  }

  async function addExpected() {
    if (!newExpVendor.trim()) return;
    setAddingExpected(true);
    await fetch(`/api/v1/clients/${clientId}/expected-invoices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor_name: newExpVendor.trim(), approx_amount: newExpAmount ? parseFloat(newExpAmount) : null, expected_by: newExpDate || null, notes: newExpNotes || null }),
    });
    setNewExpVendor(""); setNewExpAmount(""); setNewExpDate(""); setNewExpNotes("");
    setAddingExpected(false);
    loadExpected();
  }

  async function updateExpected(id: string, action: "received" | "delete") {
    await fetch(`/api/v1/clients/${clientId}/expected-invoices`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedId: id, action }),
    });
    loadExpected();
  }

  // GST Filing tab state
  interface Gstr3b {
    outward_taxable: { taxable: number; igst: number; cgst: number; sgst: number };
    inward_rcm: { taxable: number; igst: number; cgst: number; sgst: number };
    output_tax: { igst: number; cgst: number; sgst: number };
    itc_available: { igst: number; cgst: number; sgst: number };
    net_payable: { igst: number; cgst: number; sgst: number };
    total_output: number;
    total_itc: number;
    total_net_payable: number;
    client_name: string;
    client_gstin: string;
  }
  const [gstData, setGstData] = useState<Gstr3b | null>(null);
  const [gstLoading, setGstLoading] = useState(false);
  const [gstPeriodFrom, setGstPeriodFrom] = useState(() => {
    const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10);
  });
  const [gstPeriodTo, setGstPeriodTo] = useState(() => new Date().toISOString().slice(0, 10));

  // GST quick period presets
  const GST_PERIOD_PRESETS = (() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth(); // 0-indexed
    const fyYear = m >= 3 ? y : y - 1; // FY starts April (month 3)
    const pad = (n: number) => String(n).padStart(2, "0");
    const lastDay = (year: number, month: number) =>
      new Date(year, month + 1, 0).getDate();
    // Current month
    const cmFrom = `${y}-${pad(m + 1)}-01`;
    const cmTo   = `${y}-${pad(m + 1)}-${lastDay(y, m)}`;
    // GST quarters (Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar)
    const quarters = [
      { label: "Q1 (Apr–Jun)", from: `${fyYear}-04-01`,   to: `${fyYear}-06-30` },
      { label: "Q2 (Jul–Sep)", from: `${fyYear}-07-01`,   to: `${fyYear}-09-30` },
      { label: "Q3 (Oct–Dec)", from: `${fyYear}-10-01`,   to: `${fyYear}-12-31` },
      { label: "Q4 (Jan–Mar)", from: `${fyYear + 1}-01-01`, to: `${fyYear + 1}-03-31` },
    ];
    // Build FY list: current FY + up to (currentYear - 2021) prior years, max 5
    const fyLabels = Array.from({ length: Math.min(5, fyYear - 2020) }, (_, i) => fyYear - i).map((fy) => ({
      label: `FY ${fy}-${String(fy + 1).slice(2)}`,
      from:  `${fy}-04-01`,
      to:    `${fy + 1}-03-31`,
    }));
    return [
      { label: "This Month", from: cmFrom, to: cmTo },
      ...quarters,
      ...fyLabels,
    ];
  })();

  function loadGstData(from = gstPeriodFrom, to = gstPeriodTo) {
    setGstLoading(true);
    fetch(`/api/v1/clients/${clientId}/gst-filing?from=${from}&to=${to}`)
      .then((r) => r.json())
      .then((d) => setGstData(d.gstr3b ?? null))
      .finally(() => setGstLoading(false));
  }

  // Financial year filter — defaults to current FY (Apr–Mar)
  function currentFY() {
    const now = new Date();
    const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return { from: `${year}-04-01`, to: `${year + 1}-03-31`, label: `FY ${year}-${String(year + 1).slice(2)}` };
  }
  const [fyFrom, setFyFrom] = useState(currentFY().from);
  const [fyTo,   setFyTo]   = useState(currentFY().to);

  const FY_OPTIONS = (() => {
    const now = new Date();
    const curYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return [
      { label: `FY ${curYear}-${String(curYear + 1).slice(2)}`,     from: `${curYear}-04-01`,     to: `${curYear + 1}-03-31` },
      { label: `FY ${curYear - 1}-${String(curYear).slice(2)}`,     from: `${curYear - 1}-04-01`, to: `${curYear}-03-31` },
      { label: "All time", from: "", to: "" },
    ];
  })();

  function loadData(from = fyFrom, to = fyTo) {
    const q = from ? `?from=${from}&to=${to}` : "";
    fetch(`/api/v1/clients/${clientId}${q}`)
      .then((r) => r.json())
      .then((d) => {
        setClient(d.client);
        setDocuments(d.documents ?? []);
      })
      .finally(() => setLoading(false));
  }

  function refreshPendingCount() {
    fetch(`/api/v1/review/queue?client=${clientId}`)
      .then(r => r.json())
      .then(d => setLivePendingCount(d.queue?.length ?? 0))
      .catch(() => setLivePendingCount(0));
  }

  function loadBankTxns() {
    setBankLoading(true);
    fetch(`/api/v1/clients/${clientId}/bank-transactions`)
      .then((r) => r.json())
      .then((d) => {
        setBankTxns(d.transactions ?? []);
        setBankSummary(d.summary ?? null);
      })
      .finally(() => setBankLoading(false));
  }

  async function uploadBankStatement(e: React.FormEvent) {
    e.preventDefault();
    const file = bankUploadRef.current?.files?.[0];
    if (!file) return;
    setBankUploading(true);
    setBankUploadMsg(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4 * 60 * 1000);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("bank_name", bankUploadBankName);
      formData.append("client_id", clientId);
      const res = await fetch("/api/v1/reconciliation/upload-statement", {
        method: "POST", body: formData, signal: controller.signal,
      });
      const d = await res.json();
      if (res.ok) {
        setBankUploadMsg({ type: "success", text: `Done — ${d.count ?? d.inserted ?? 0} new transactions added.` });
        if (bankUploadRef.current) bankUploadRef.current.value = "";
        loadBankTxns();
      } else {
        setBankUploadMsg({ type: "error", text: d.error ?? "Upload failed" });
      }
    } catch {
      setBankUploadMsg({ type: "error", text: "Upload timed out or failed. Try a smaller file." });
    } finally {
      clearTimeout(timer);
      setBankUploading(false);
    }
  }

  function loadRecon() {
    setReconLoading(true);
    fetch(`/api/v1/reconciliation/data?clientId=${clientId}`)
      .then((r) => r.json())
      .then((d) => setReconData(d))
      .finally(() => setReconLoading(false));
  }

  async function runReconMatch() {
    setReconMatching(true);
    await fetch("/api/v1/reconciliation/auto-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setReconMatching(false);
    loadRecon();
  }

  async function runBankMatch() {
    setBankMatching(true);
    await fetch("/api/v1/reconciliation/auto-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setBankMatching(false);
    loadBankTxns();
  }

  async function doWipeBankData() {
    setWipingBank(true);
    const res = await fetch(`/api/v1/clients/${clientId}/bank-transactions`, { method: "DELETE" });
    setWipingBank(false);
    setWipeDialogOpen(false);
    if (res.ok) {
      setBankTxns([]);
      setBankSummary(null);
      toast.success("All bank transactions wiped. Upload a fresh statement.");
    } else {
      toast.error("Failed to wipe bank data. Please try again.");
    }
  }

  async function updateTxnField(txnId: string, field: "category" | "voucher_type", value: string) {
    await fetch(`/api/v1/reconciliation/transactions/${txnId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    setEditingTxn(null);
    loadRecon();
  }

  async function handleManualMatch(documentId: string) {
    if (!linkingTxn) return;
    setLinkingId(documentId);
    await fetch("/api/v1/reconciliation/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: linkingTxn.id, documentId }),
    });
    setLinkingTxn(null);
    setLinkingId(null);
    loadRecon();
  }

  async function handleUnmatch(reconId: string) {
    if (!confirm("Remove this match?")) return;
    await fetch("/api/v1/reconciliation/unmatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reconciliationId: reconId }),
    });
    loadRecon();
  }

  async function approvePossible(reconId: string) {
    await fetch("/api/v1/reconciliation/match-approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reconciliationId: reconId }),
    });
    loadRecon();
  }

  async function openClaimModal(bank?: string) {
    setClaimOpen(true);
    setClaimLoading(true);
    setClaimSelected(new Set());
    const url = `/api/v1/clients/${clientId}/claim-transactions${bank ? `?bank=${encodeURIComponent(bank)}` : ""}`;
    const res = await fetch(url);
    const d = await res.json();
    setClaimTxns(d.transactions ?? []);
    setClaimBanks(d.bank_names ?? []);
    setClaimLoading(false);
  }

  async function applyClaimFilter(bank: string) {
    setClaimBankFilter(bank);
    setClaimLoading(true);
    setClaimSelected(new Set());
    const url = `/api/v1/clients/${clientId}/claim-transactions${bank ? `?bank=${encodeURIComponent(bank)}` : ""}`;
    const res = await fetch(url);
    const d = await res.json();
    setClaimTxns(d.transactions ?? []);
    setClaimLoading(false);
  }

  async function saveClaim() {
    if (claimSelected.size === 0) return;
    setClaimSaving(true);
    const res = await fetch(`/api/v1/clients/${clientId}/claim-transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionIds: [...claimSelected] }),
    });
    const d = await res.json();
    if (res.ok) {
      toast.success(`${d.assigned} transactions linked to ${client?.client_name}`);
      setClaimOpen(false);
      loadBankTxns();
    } else {
      toast.error(d.error ?? "Could not assign transactions");
    }
    setClaimSaving(false);
  }

  function loadLedgers() {
    setLedgersLoading(true);
    fetch(`/api/v1/clients/${clientId}/ledgers`)
      .then((r) => r.json())
      .then((d) => setLedgers(d.ledgers ?? []))
      .finally(() => setLedgersLoading(false));
  }

  function loadMappingRules() {
    setRulesLoading(true);
    fetch(`/api/v1/ledger-rules?clientId=${clientId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Rules API error: ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setClientMappingRules(d.client_rules ?? []);
        setIndustryMappingRules(d.industry_rules ?? []);
        setIndustryNameForRules(d.industry_name ?? null);
      })
      .catch((err) => {
        console.error("[loadMappingRules]", err);
        toast.error("Could not load rules — try refreshing");
      })
      .finally(() => setRulesLoading(false));
  }

  async function addMappingRule(e: React.FormEvent) {
    e.preventDefault();
    if (!newRulePattern.trim() || !newRuleLedger.trim()) return;
    setAddingRule(true);
    const res = await fetch("/api/v1/ledger-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: newRuleScope === "client" ? clientId : null,
        industry_name: newRuleScope === "industry" ? (industryNameForRules ?? null) : null,
        pattern: newRulePattern.trim().toLowerCase(),
        ledger_name: newRuleLedger.trim(),
      }),
    });
    if (res.ok) {
      setNewRulePattern(""); setNewRuleLedger("");
      loadMappingRules();
      toast.success("Rule added");
    } else {
      const d = await res.json();
      toast.error(d.error ?? "Could not add rule");
    }
    setAddingRule(false);
  }

  async function deleteMappingRule(ruleId: string) {
    await fetch(`/api/v1/ledger-rules/${ruleId}`, { method: "DELETE" });
    loadMappingRules();
  }

  async function saveRuleEdit(ruleId: string) {
    const field = editingRuleField;
    const value = editingRuleValue.trim();
    setEditingRuleId(null);
    setEditingRuleField(null);
    if (!field || !value) return;
    const res = await fetch(`/api/v1/ledger-rules/${ruleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    if (res.ok) {
      const updater = (r: MappingRule) => r.id === ruleId ? { ...r, [field]: value } : r;
      setClientMappingRules(prev => prev.map(updater));
      setIndustryMappingRules(prev => prev.map(updater));
    } else {
      toast.error(`Could not update ${field === "pattern" ? "pattern" : "ledger name"}`);
    }
  }

  function startEdit(ruleId: string, field: "pattern" | "ledger_name", currentValue: string) {
    setEditingRuleId(ruleId);
    setEditingRuleField(field);
    setEditingRuleValue(currentValue);
  }

  async function fetchSuggestions() {
    setSuggestLoading(true);
    setSuggestOpen(true);
    setSuggestions([]);
    setSuggestionOverrides({});
    try {
      const res = await fetch(`/api/v1/clients/${clientId}/suggest-rules`, { method: "POST" });
      const d = await res.json();
      if (res.ok) {
        setSuggestions(d.suggestions ?? []);
        if ((d.suggestions ?? []).length === 0) {
          toast.info(d.message ?? "No new suggestions — all transactions already mapped");
          setSuggestOpen(false);
        }
      } else {
        toast.error(d.error ?? "Failed to get suggestions");
        setSuggestOpen(false);
      }
    } finally {
      setSuggestLoading(false);
    }
  }

  async function acceptSuggestion(pattern: string, ledger: string) {
    setAcceptingPatterns(prev => new Set([...prev, pattern]));
    try {
      const res = await fetch("/api/v1/ledger-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, pattern, ledger_name: ledger }),
      });
      if (res.ok) {
        setSuggestions(prev => prev.filter(s => s.pattern !== pattern));
        loadMappingRules();
      } else {
        const d = await res.json();
        toast.error(d.error ?? "Could not save rule");
      }
    } finally {
      setAcceptingPatterns(prev => { const s = new Set(prev); s.delete(pattern); return s; });
    }
  }

  async function toggleRuleConfirmed(ruleId: string, current: boolean) {
    await fetch(`/api/v1/ledger-rules/${ruleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: !current }),
    });
    loadMappingRules();
  }

  async function promoteToIndustry(ruleId: string) {
    const res = await fetch(`/api/v1/ledger-rules/${ruleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promote_to_industry: true }),
    });
    const d = await res.json();
    if (res.ok) {
      toast.success(`Rule promoted to ${d.promoted_to} industry`);
      loadMappingRules();
    } else {
      toast.error(d.error ?? "Could not promote rule");
    }
  }

  async function addLedger(e: React.FormEvent) {
    e.preventDefault();
    if (!newLedgerName.trim()) return;
    setAddingLedger(true);
    const res = await fetch(`/api/v1/clients/${clientId}/ledgers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ledger_name: newLedgerName.trim(), ledger_type: newLedgerType }),
    });
    if (res.ok) { setNewLedgerName(""); loadLedgers(); }
    else { const d = await res.json(); toast.error(d.error ?? "Could not add ledger"); }
    setAddingLedger(false);
  }

  async function seedLedgers() {
    setSeedingLedgers(true);
    const res = await fetch(`/api/v1/clients/${clientId}/ledgers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seed: true }),
    });
    if (res.ok) { const d = await res.json(); toast.success(`${d.seeded} common ledgers loaded`); loadLedgers(); }
    setSeedingLedgers(false);
  }

  async function reapplyLedgerRules() {
    setReapplying(true);
    const res = await fetch(`/api/v1/clients/${clientId}/reapply-ledger-rules`, { method: "POST" });
    const d = await res.json();
    if (res.ok) {
      toast.success(d.updated > 0 ? `Updated ${d.updated} transaction${d.updated === 1 ? "" : "s"}` : "All ledgers are already up to date");
      loadBankTxns();
    } else {
      toast.error(d.error ?? "Could not re-apply rules");
    }
    setReapplying(false);
  }

  async function deleteLedger(ledgerId: string) {
    await fetch(`/api/v1/clients/${clientId}/ledgers`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ledgerId }),
    });
    loadLedgers();
  }

  async function deleteSelectedLedgers() {
    if (selectedLedgerIds.size === 0) return;
    setDeletingLedgers(true);
    await Promise.all(
      Array.from(selectedLedgerIds).map((id) =>
        fetch(`/api/v1/clients/${clientId}/ledgers`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ledgerId: id }),
        })
      )
    );
    setSelectedLedgerIds(new Set());
    setDeletingLedgers(false);
    loadLedgers();
  }

  async function clearAllLedgers() {
    if (!confirm(`Delete ALL ${ledgers.length} ledgers for this client? This cannot be undone.`)) return;
    setDeletingLedgers(true);
    await Promise.all(
      ledgers.map((l) =>
        fetch(`/api/v1/clients/${clientId}/ledgers`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ledgerId: l.id }),
        })
      )
    );
    setSelectedLedgerIds(new Set());
    setDeletingLedgers(false);
    loadLedgers();
  }

  async function importLedgers(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportingLedgers(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("financial_year", trialBalanceFY);
    const res = await fetch(`/api/v1/clients/${clientId}/ledgers/import`, { method: "POST", body: fd });
    const d = await res.json();
    if (res.ok) {
      const balanceNote = d.has_balance_data ? " with balances" : "";
      toast.success(`Imported ${d.imported} ledgers${balanceNote}${d.skipped > 0 ? ` (${d.skipped} skipped)` : ""}. Re-mapping transactions…`);
      loadLedgers();
      // Step 1: Re-apply rules so existing transactions use the new TB ledger names
      try {
        await fetch(`/api/v1/clients/${clientId}/reapply-ledger-rules`, { method: "POST" });
      } catch { /* best-effort */ }
      // Step 2: Suggest rules for any transactions still unassigned after re-apply
      setSuggestLoading(true);
      setSuggestOpen(true);
      setSuggestions([]);
      setSuggestionOverrides({});
      try {
        const sugRes = await fetch(`/api/v1/clients/${clientId}/suggest-rules`, { method: "POST" });
        const sugData = await sugRes.json();
        if (sugRes.ok && (sugData.suggestions ?? []).length > 0) {
          setSuggestions(sugData.suggestions);
          toast.info(`${sugData.suggestions.length} rule drafts ready for review — approve to auto-map future transactions`);
        } else {
          setSuggestOpen(false);
          toast.success("All transactions mapped using TB ledgers — nothing left to review");
        }
      } catch {
        setSuggestOpen(false);
      } finally {
        setSuggestLoading(false);
      }
    } else {
      toast.error(d.error ?? "Could not import ledgers");
    }
    setImportingLedgers(false);
  }

  useEffect(() => {
    loadData();
    loadRecon();
    refreshPendingCount();
    // Re-fetch live pending count when user returns from review page
    const onFocus = () => refreshPendingCount();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [clientId]);
  useEffect(() => { if (activeTab === "bank") { loadBankTxns(); if (ledgers.length === 0) loadLedgers(); } }, [activeTab, clientId]);
  useEffect(() => { if (activeTab === "reconciliation") loadRecon(); }, [activeTab, clientId]);
  useEffect(() => { if (activeTab === "ledger_view" && !ledgerData) loadLedger(ledgerFromDate || undefined, ledgerToDate || undefined); }, [activeTab, clientId]);
  useEffect(() => { if (activeTab === "ledgers") { if (ledgers.length === 0) loadLedgers(); loadMappingRules(); } }, [activeTab, clientId]);
  useEffect(() => { if (activeTab === "mapping") { loadMappingRules(); if (ledgers.length === 0) loadLedgers(); } }, [activeTab, clientId]);
  useEffect(() => { if (activeTab === "gst") loadGstData(); }, [activeTab, clientId, gstPeriodFrom, gstPeriodTo]);
  useEffect(() => { if (activeTab === "expected") loadExpected(); }, [activeTab, clientId]);

  // Poll status for any documents currently extracting/queued
  useEffect(() => {
    const inFlight = documents.filter((d) => d.status === "extracting" || d.status === "queued");
    if (inFlight.length === 0) return;
    const timer = setInterval(async () => {
      const updates = await Promise.all(
        inFlight.map((d) =>
          fetch(`/api/v1/documents/${d.id}/status`)
            .then((r) => r.json())
            .then((j) => ({ id: d.id, status: j.status as string, processed_at: j.processed_at as string | null }))
            .catch(() => ({ id: d.id, status: d.status, processed_at: d.processed_at }))
        )
      );
      setDocuments((prev) =>
        prev.map((d) => {
          const u = updates.find((u) => u.id === d.id);
          if (!u || u.status === d.status) return d;
          return { ...d, status: u.status, processed_at: u.processed_at ?? d.processed_at };
        })
      );
    }, 5000);
    return () => clearInterval(timer);
  }, [documents]);

  async function retryExtraction(docId: string, fileName: string) {
    setRetrying(docId);
    try {
      const res = await fetch(`/api/v1/documents/${docId}/retry`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Extraction started for "${fileName}". Check back in 30–60 seconds.`);
        setDocuments((prev) =>
          prev.map((d) => d.id === docId ? { ...d, status: "extracting" } : d)
        );
      } else {
        toast.error(data.error ?? "Could not retry extraction.");
      }
    } finally {
      setRetrying(null);
    }
  }

  async function reExtract(docId: string, fileName: string) {
    if (!window.confirm(`Re-run AI extraction for "${fileName}"? This will clear existing extracted fields and re-process with the latest rules (TDS inference, ledger suggestion).`)) return;
    setRetrying(docId);
    try {
      const res = await fetch(`/api/v1/documents/${docId}/reextract`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Re-extraction started for "${fileName}". Review it again in 30–60 seconds.`);
        setDocuments((prev) => prev.map((d) => d.id === docId ? { ...d, status: "extracting" } : d));
      } else {
        toast.error(data.error ?? "Re-extraction failed.");
      }
    } finally {
      setRetrying(null);
    }
  }

  async function performDeleteDocument(docId: string, fileName: string) {
    setDeleting(docId);
    try {
      const res = await fetch(`/api/v1/documents/${docId}`, { method: "DELETE" });
      if (res.ok) {
        setDocuments((prev) => prev.filter((d) => d.id !== docId));
        toast.success(`"${fileName}" archived.`);
        setDeleteDocTarget(null);
      } else {
        const data = await res.json();
        toast.error(data.error ?? "Archive failed.");
      }
    } finally {
      setDeleting(null);
    }
  }

  async function retagDocument(docId: string, newType: string) {
    setRetagging(docId);
    const res = await fetch(`/api/v1/documents/${docId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_type: newType }),
    });
    if (res.ok) {
      setDocuments((prev) => prev.map((d) => d.id === docId ? { ...d, document_type: newType } : d));
      toast.success("Document type updated");
    } else {
      toast.error("Could not update document type");
    }
    setRetagging(null);
  }

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <Loader2 size={24} className="animate-spin text-gray-400" />
    </div>
  );

  if (!client) return (
    <div className="p-4 bg-red-50 border border-red-200 text-red-700 text-sm rounded-md">Client not found.</div>
  );

  const pendingCount = documents.filter((d) => d.status === "review_required").length;
  const failedCount = documents.filter((d) => RETRYABLE.has(d.status)).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/clients" className="text-gray-400 hover:text-gray-600">
            <ChevronLeft size={20} />
          </Link>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
              <Building2 size={18} className="text-blue-600" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold text-gray-900">{client.client_name}</h1>
                <button
                  onClick={() => {
                    setEditClientForm({
                      client_name: client.client_name,
                      gstin: client.gstin ?? "",
                      pan: client.pan ?? "",
                      industry_name: client.industry_name ?? "",
                    });
                    setEditClientOpen(true);
                  }}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                  title="Edit client details"
                >
                  <Pencil size={13} />
                </button>
              </div>
              <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400">
                {client.industry_name
                  ? <span>{client.industry_name}</span>
                  : <button onClick={() => { setEditClientForm({ client_name: client.client_name, gstin: client.gstin ?? "", pan: client.pan ?? "", industry_name: "" }); setEditClientOpen(true); }} className="text-amber-500 hover:text-amber-700 italic">+ add industry</button>
                }
                {client.gstin
                  ? <><span className="text-gray-300">·</span><span className="font-mono">{client.gstin}</span></>
                  : <><span className="text-gray-300">·</span><button onClick={() => { setEditClientForm({ client_name: client.client_name, gstin: "", pan: client.pan ?? "", industry_name: client.industry_name ?? "" }); setEditClientOpen(true); }} className="text-amber-500 hover:text-amber-700 italic">+ GSTIN</button></>
                }
                {client.pan
                  ? <><span className="text-gray-300">·</span><span className="font-mono">PAN: {client.pan}</span></>
                  : <><span className="text-gray-300">·</span><button onClick={() => { setEditClientForm({ client_name: client.client_name, gstin: client.gstin ?? "", pan: "", industry_name: client.industry_name ?? "" }); setEditClientOpen(true); }} className="text-amber-500 hover:text-amber-700 italic">+ PAN</button></>
                }
                <span className="text-gray-300">·</span>
                <button
                  onClick={async () => {
                    const newVal = !client.tds_applicable;
                    const res = await fetch(`/api/v1/clients/${clientId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ tds_applicable: newVal }),
                    });
                    if (res.ok) {
                      setClient((prev) => prev ? { ...prev, tds_applicable: newVal } : prev);
                      toast.success(newVal ? "TDS deduction enabled" : "TDS marked as not applicable");
                    } else {
                      toast.error("Could not update TDS setting");
                    }
                  }}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium transition-colors ${
                    client.tds_applicable
                      ? "border-green-300 bg-green-50 text-green-700 hover:bg-green-100"
                      : "border-gray-300 bg-gray-100 text-gray-500 hover:bg-gray-200"
                  }`}
                  title={client.tds_applicable ? "Click to mark client as not liable for TDS" : "Click to enable TDS deduction for this client"}
                >
                  TDS: {client.tds_applicable ? "Applicable" : "Not applicable"}
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!!livePendingCount && (
            <Link href={`/review?client=${clientId}`} className={buttonVariants({ variant: "outline" })}>
              <AlertTriangle size={14} className="mr-1.5 text-amber-500" />
              Review {livePendingCount} pending
            </Link>
          )}
        </div>
      </div>

      {/* Edit client details modal */}
      {editClientOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Edit client details</h2>
              <button onClick={() => setEditClientOpen(false)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Company name *</label>
                <input
                  value={editClientForm.client_name}
                  onChange={e => setEditClientForm(f => ({ ...f, client_name: e.target.value }))}
                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  placeholder="e.g. Sharma Enterprises"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Industry <span className="text-gray-400 font-normal">(optional)</span></label>
                <input
                  value={editClientForm.industry_name}
                  onChange={e => setEditClientForm(f => ({ ...f, industry_name: e.target.value }))}
                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  placeholder="e.g. Manufacturing, Retail, Services"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">GSTIN <span className="text-gray-400 font-normal">(optional)</span></label>
                  <input
                    value={editClientForm.gstin}
                    onChange={e => setEditClientForm(f => ({ ...f, gstin: e.target.value.toUpperCase() }))}
                    className="w-full text-sm font-mono border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                    placeholder="29ABCDE1234F1Z5"
                    maxLength={15}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">PAN <span className="text-gray-400 font-normal">(optional)</span></label>
                  <input
                    value={editClientForm.pan}
                    onChange={e => setEditClientForm(f => ({ ...f, pan: e.target.value.toUpperCase() }))}
                    className="w-full text-sm font-mono border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                    placeholder="ABCDE1234F"
                    maxLength={10}
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={async () => {
                  if (!editClientForm.client_name.trim()) return;
                  setSavingClient(true);
                  try {
                    const res = await fetch(`/api/v1/clients/${clientId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        client_name: editClientForm.client_name.trim(),
                        gstin: editClientForm.gstin.trim() || null,
                        pan: editClientForm.pan.trim() || null,
                        industry_name: editClientForm.industry_name.trim() || null,
                      }),
                    });
                    if (res.ok) {
                      const d = await res.json();
                      setClient(prev => prev ? { ...prev, ...d.client } : prev);
                      toast.success("Client details updated");
                      setEditClientOpen(false);
                    } else {
                      const d = await res.json();
                      toast.error(d.error ?? "Could not update client");
                    }
                  } finally {
                    setSavingClient(false);
                  }
                }}
                disabled={savingClient || !editClientForm.client_name.trim()}
                className="flex-1 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                {savingClient ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : "Save changes"}
              </button>
              <button onClick={() => setEditClientOpen(false)} className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total documents", value: documents.length,      cls: "text-gray-900" },
          { label: "Pending review",  value: pendingCount,          cls: "text-amber-600" },
          { label: "Reviewed",        value: documents.filter((d) => ["reviewed","reconciled","posted"].includes(d.status)).length, cls: "text-green-600" },
          { label: "Processing / Failed", value: failedCount,       cls: failedCount > 0 ? "text-red-600" : "text-gray-500" },
        ].map(({ label, value, cls }) => (
          <Card key={label}>
            <CardContent className="py-4 px-4">
              <p className="text-xs text-gray-500">{label}</p>
              <p className={`text-2xl font-bold mt-1 ${cls}`}>{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs — two-level: 4 primary groups + sub-tabs within each group */}
      {(() => {
        type TabKey = typeof activeTab;
        const PRIMARY_GROUPS: { key: string; label: string; icon: React.ReactNode; tabs: TabKey[]; flagCount: number }[] = [
          { key: "docs_group",     label: "Documents",  icon: <FileText size={14} />,  tabs: ["documents", "expected"],                         flagCount: 0 },
          { key: "banking_group",  label: "Banking",    icon: <Landmark size={14} />,  tabs: ["bank", "mapping"],                               flagCount: bankSummary?.flag_count ?? 0 },
          { key: "accounts_group", label: "Accounts",   icon: <Link2 size={14} />,     tabs: ["reconciliation", "ledger_view", "ledgers"],       flagCount: 0 },
          { key: "reports_group",  label: "Tax & Reports", icon: <Receipt size={14} />, tabs: ["gst", "summary"],                               flagCount: 0 },
        ];

        const SUB_TABS: Record<TabKey, { label: string; count: number | null; flagCount: number }> = {
          documents:     { label: "All Documents",     count: documents.length || null,                                                                         flagCount: 0 },
          expected:      { label: "Expected Invoices", count: expectedInvoices.filter(e => e.status === "pending").length || null,                              flagCount: 0 },
          bank:          { label: "Transactions",      count: bankSummary?.total ?? null,                                                                        flagCount: bankSummary?.flag_count ?? 0 },
          mapping:       { label: "Mapping Rules",     count: clientMappingRules.length || null,                                                                 flagCount: 0 },
          reconciliation:{ label: "Reconciliation",    count: reconData?.summary.matched ?? null,                                                                flagCount: 0 },
          ledger_view:   { label: "Ledger View",       count: ledgerData ? (ledgerData.purchase.vendors.length + ledgerData.sales.customers.length) || null : null, flagCount: 0 },
          ledgers:       { label: "Chart of Accounts", count: ledgers.length || null,                                                                            flagCount: 0 },
          gst:           { label: "GST Filing",        count: null,                                                                                              flagCount: 0 },
          summary:       { label: "Summary Note",      count: null,                                                                                              flagCount: 0 },
        };

        const activeGroup = PRIMARY_GROUPS.find(g => g.tabs.includes(activeTab)) ?? PRIMARY_GROUPS[0];
        const activeSubTabs = activeGroup.tabs;

        return (
          <>
            {/* Primary row */}
            <div className="flex border-b border-gray-200 gap-1">
              {PRIMARY_GROUPS.map(group => {
                const isActive = group.tabs.includes(activeTab);
                return (
                  <button
                    key={group.key}
                    onClick={() => {
                      const target = group.tabs[0];
                      setActiveTab(target);
                      if (target === "summary" && !summary && !summaryLoading) loadSummary();
                      if (target === "ledger_view" && !ledgerData && !ledgerLoading) loadLedger(ledgerFromDate || undefined, ledgerToDate || undefined);
                    }}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                      isActive ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {group.icon} {group.label}
                    {group.flagCount > 0 && (
                      <span className="ml-0.5 text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-semibold">⚑ {group.flagCount}</span>
                    )}
                  </button>
                );
              })}
            </div>
            {/* Sub-tab row — only shown when group has more than 1 tab */}
            {activeSubTabs.length > 1 && (
              <div className="flex gap-1 px-1 border-b border-gray-100 bg-gray-50">
                {activeSubTabs.map(tabKey => {
                  const sub = SUB_TABS[tabKey];
                  const isActive = activeTab === tabKey;
                  return (
                    <button
                      key={tabKey}
                      onClick={() => {
                        setActiveTab(tabKey);
                        if (tabKey === "summary" && !summary && !summaryLoading) loadSummary();
                        if (tabKey === "ledger_view" && !ledgerData && !ledgerLoading) loadLedger(ledgerFromDate || undefined, ledgerToDate || undefined);
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                        isActive ? "bg-white border border-b-white border-gray-200 text-blue-600 -mb-px" : "text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      {sub.label}
                      {sub.count !== null && sub.count > 0 && (
                        <span className="ml-0.5 bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full text-[10px]">{sub.count}</span>
                      )}
                      {sub.flagCount > 0 && (
                        <span className="ml-0.5 bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full text-[10px] font-semibold">⚑ {sub.flagCount}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        );
      })()}

      {/* Document folders */}
      {activeTab === "documents" && (() => {
        const FOLDERS = [
          { type: "sales_invoice",    label: "Sales Invoices",    icon: <ShoppingCart size={18} />, color: "blue" },
          { type: "purchase_invoice", label: "Purchase Invoices", icon: <Receipt size={18} />,      color: "purple" },
          { type: "expense",          label: "Expenses",          icon: <Wallet size={18} />,        color: "orange" },
          { type: "credit_note",      label: "Credit Notes",      icon: <CreditCard size={18} />,    color: "green" },
          { type: "debit_note",       label: "Debit Notes",       icon: <CreditCard size={18} />,    color: "red" },
        ] as const;
        const RETAG_TYPES = [
          { value: "sales_invoice",    label: "Sales Invoice" },
          { value: "purchase_invoice", label: "Purchase Invoice" },
          { value: "expense",          label: "Expense" },
          { value: "credit_note",      label: "Credit Note" },
          { value: "debit_note",       label: "Debit Note" },
        ];
        const folderColors: Record<string, string> = {
          blue:   "bg-blue-50 border-blue-200 text-blue-700",
          purple: "bg-purple-50 border-purple-200 text-purple-700",
          orange: "bg-orange-50 border-orange-200 text-orange-700",
          green:  "bg-green-50 border-green-200 text-green-700",
          red:    "bg-red-50 border-red-200 text-red-700",
        };
        const visibleDocs = docFolder ? documents.filter((d) => d.document_type === docFolder) : documents;

        return (
          <div className="space-y-4">
            {/* FY filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 font-medium">Financial Year:</span>
              <div className="flex gap-1">
                {FY_OPTIONS.map((fy) => (
                  <button key={fy.label}
                    onClick={() => { setFyFrom(fy.from); setFyTo(fy.to); setLoading(true); loadData(fy.from, fy.to); }}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      fyFrom === fy.from
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-gray-600 border-gray-200 hover:border-blue-300"
                    }`}>{fy.label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-gray-400 ml-auto">{documents.length} document{documents.length !== 1 ? "s" : ""}</span>
            </div>

            {/* Register downloads */}
            <div className="flex items-center justify-end gap-3">
              <a href={`/api/v1/clients/${clientId}/tds-summary?format=excel`}
                className="inline-flex items-center gap-1 text-xs text-orange-600 hover:text-orange-800">
                <Download size={12} /> TDS Summary (26Q)
              </a>
              <a href={`/api/v1/clients/${clientId}/sales-register?type=sales`}
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800">
                <Download size={12} /> Sales Register
              </a>
              <a href={`/api/v1/clients/${clientId}/sales-register?type=purchase`}
                className="inline-flex items-center gap-1 text-xs text-purple-600 hover:text-purple-800">
                <Download size={12} /> Purchase Register
              </a>
            </div>

            {/* Folder cards */}
            <div className="grid grid-cols-5 gap-3">
              {FOLDERS.map((f) => {
                const count = documents.filter((d) => d.document_type === f.type).length;
                const pendingInFolder = documents.filter((d) => d.document_type === f.type && d.status === "review_required").length;
                const isActive = docFolder === f.type;
                return (
                  <button key={f.type} onClick={() => setDocFolder(isActive ? null : f.type)}
                    className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                      isActive ? folderColors[f.color] + " border-2 shadow-sm" : "border-gray-200 hover:border-gray-300 bg-white"
                    }`}>
                    {pendingInFolder > 0 && (
                      <span className="absolute top-2 left-2 inline-flex items-center justify-center w-4 h-4 bg-amber-500 text-white text-[9px] font-bold rounded-full leading-none">{pendingInFolder}</span>
                    )}
                    <div className={`${isActive ? "" : "text-gray-400"}`}>{f.icon}</div>
                    <span className="text-xs font-medium text-center leading-tight">{f.label}</span>
                    <span className={`text-lg font-bold ${isActive ? "" : "text-gray-700"}`}>{count}</span>
                    <Link href={`/upload?client=${clientId}&type=${f.type}`}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-2 right-2 text-gray-300 hover:text-blue-500 transition-colors">
                      <Upload size={12} />
                    </Link>
                  </button>
                );
              })}
            </div>

            {/* Document list */}
            <Card>
              <CardHeader className="py-3 px-5 border-b flex flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                  {docFolder ? (
                    <>
                      <button onClick={() => setDocFolder(null)} className="text-gray-400 hover:text-gray-600">
                        <ChevronLeft size={16} />
                      </button>
                      <CardTitle className="text-sm text-gray-700">
                        {FOLDERS.find((f) => f.type === docFolder)?.label} ({visibleDocs.length})
                      </CardTitle>
                    </>
                  ) : (
                    <CardTitle className="text-sm text-gray-700">All Documents ({documents.length})</CardTitle>
                  )}
                </div>
                {docFolder && (
                  <Link href={`/upload?client=${clientId}&type=${docFolder}`}
                    className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800">
                    <Upload size={12} /> Upload to this folder
                  </Link>
                )}
              </CardHeader>
              <CardContent className="p-0">
                {visibleDocs.length === 0 ? (
                  <div className="text-center py-12">
                    <FolderOpen size={32} className="text-gray-300 mx-auto mb-2" />
                    <p className="text-sm text-gray-500 mb-3">
                      {docFolder ? "No documents in this folder yet." : "Select a folder above to upload documents."}
                    </p>
                    {docFolder && (
                      <Link href={`/upload?client=${clientId}&type=${docFolder}`}
                        className={`${buttonVariants()} inline-flex`}>
                        <Upload size={14} className="mr-1.5" /> Upload to this folder
                      </Link>
                    )}
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-gray-50">
                        <th className="text-left text-xs font-medium text-gray-500 px-5 py-3">File</th>
                        <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Type</th>
                        <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Invoice #</th>
                        <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Invoice Date</th>
                        <th className="text-right text-xs font-medium text-gray-500 px-4 py-3">Amount (Gross / Net)</th>
                        <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Status</th>
                        <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Confidence</th>
                        <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Uploaded / Last run</th>
                        <th className="px-4 py-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleDocs.map((doc) => {
                        const cfg = STATUS_CONFIG[doc.status] ?? { label: doc.status, cls: "bg-gray-50 text-gray-600 border-gray-200", icon: null };
                        const canRetry = RETRYABLE.has(doc.status);
                        return (
                          <tr key={doc.id} className="border-b last:border-0 hover:bg-gray-50/50">
                            <td className="px-5 py-3">
                              <div className="flex items-center gap-2">
                                <FileText size={14} className="text-gray-400 flex-shrink-0" />
                                <span className="truncate max-w-xs text-gray-800">{doc.original_filename}</span>
                              {doc.possible_misclassification && (
                                <span className="flex-shrink-0 text-xs px-1.5 py-0.5 rounded bg-amber-50 border border-amber-300 text-amber-700 font-medium" title="Vendor name matches this client — may be a Sales Invoice">⚠ wrong folder?</span>
                              )}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              {retagging === doc.id ? (
                                <Loader2 size={12} className="animate-spin text-gray-400" />
                              ) : (
                                <select value={doc.document_type} onChange={(e) => retagDocument(doc.id, e.target.value)}
                                  className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-400">
                                  {RETAG_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                                </select>
                              )}
                            </td>
                            <td className="px-4 py-3 text-xs font-mono text-gray-700">
                              {["reviewed", "reconciled", "posted"].includes(doc.status) && doc.invoice_number
                                ? doc.invoice_number
                                : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                              {["reviewed", "reconciled", "posted"].includes(doc.status) && doc.invoice_date
                                ? doc.invoice_date
                                : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-4 py-3 text-xs text-right font-medium">
                              {["reviewed", "reconciled", "posted"].includes(doc.status) && doc.total_amount ? (() => {
                                const gross = Number(doc.total_amount);
                                const tds = Number(doc.tds_amount ?? 0);
                                const net = gross - tds;
                                return (
                                  <div className="space-y-0.5">
                                    <div className="text-gray-800">₹{gross.toLocaleString("en-IN")}</div>
                                    {tds > 0 && (
                                      <div className="text-gray-400 text-[10px]">
                                        Net: ₹{net.toLocaleString("en-IN")}
                                        <span className="ml-1 text-orange-500">−TDS</span>
                                      </div>
                                    )}
                                  </div>
                                );
                              })() : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${cfg.cls}`}>
                                {cfg.icon} {cfg.label}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              {doc.conf ? (
                                <span className="inline-flex items-center gap-1.5 text-xs">
                                  <span className="text-green-600 font-medium">H:{doc.conf.high}</span>
                                  <span className="text-amber-500 font-medium">M:{doc.conf.medium}</span>
                                  <span className="text-red-500 font-medium">L:{doc.conf.low}</span>
                                </span>
                              ) : (
                                <span className="text-xs text-gray-300">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-xs">
                              <div className="text-gray-400">{new Date(doc.uploaded_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</div>
                              {doc.processed_at && (
                                <div className="text-gray-400 mt-0.5">
                                  Run: {new Date(doc.processed_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}{" "}
                                  {new Date(doc.processed_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-3">
                                {doc.status === "review_required" && (
                                  <Link href={`/review/${doc.id}?clientId=${clientId}${docFolder ? `&folder=${docFolder}` : ""}`} className="text-xs text-blue-600 hover:underline">Review →</Link>
                                )}
                                {["reviewed", "reconciled", "posted"].includes(doc.status) && (
                                  <Link href={`/review/${doc.id}?clientId=${clientId}${docFolder ? `&folder=${docFolder}` : ""}&readonly=1`} className="text-xs text-gray-500 hover:text-blue-600 hover:underline">View fields →</Link>
                                )}
                                {canRetry && (
                                  <button onClick={() => retryExtraction(doc.id, doc.original_filename)} disabled={retrying === doc.id}
                                    className="inline-flex items-center gap-1 text-xs text-amber-600 hover:text-amber-800 disabled:opacity-50">
                                    {retrying === doc.id ? <><Loader2 size={11} className="animate-spin" /> Retrying…</> : <><RefreshCw size={11} /> Retry</>}
                                  </button>
                                )}
                                {["reviewed", "reconciled", "posted", "review_required"].includes(doc.status) && (
                                  <button onClick={() => reExtract(doc.id, doc.original_filename)} disabled={retrying === doc.id}
                                    className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-amber-600 disabled:opacity-50"
                                    title="Re-run AI extraction with latest rules">
                                    <RefreshCw size={11} /> Re-run
                                  </button>
                                )}
                                <button onClick={() => setDeleteDocTarget({ id: doc.id, fileName: doc.original_filename })} disabled={deleting === doc.id}
                                  className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-red-500 disabled:opacity-50"
                                  title="Archive document">
                                  {deleting === doc.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </div>
        );
      })()}

      {/* Reconciliation tab */}
      {activeTab === "reconciliation" && (
        <div className="space-y-4">
          {/* manual match modal */}
          {linkingTxn && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <Card className="w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col">
                <CardHeader className="flex-shrink-0 pb-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-base">Link to invoice</CardTitle>
                      <p className="text-xs text-gray-500 mt-1 line-clamp-1">
                        {linkingTxn.narration} · {linkingTxn.debit_amount ? `₹${Number(linkingTxn.debit_amount).toLocaleString("en-IN")} debit` : `₹${Number(linkingTxn.credit_amount).toLocaleString("en-IN")} credit`}
                      </p>
                    </div>
                    <button onClick={() => setLinkingTxn(null)} className="text-gray-400 hover:text-gray-600 ml-4">
                      <X size={18} />
                    </button>
                  </div>
                </CardHeader>
                <CardContent className="overflow-y-auto flex-1 pt-0">
                  {(reconData?.unmatched_invoices ?? []).length === 0 ? (
                    <p className="text-sm text-gray-400 py-6 text-center">No unmatched invoices.</p>
                  ) : (
                    <div className="space-y-2">
                      {(reconData?.unmatched_invoices ?? []).map((doc) => (
                        <button key={doc.id} onClick={() => handleManualMatch(doc.id)} disabled={linkingId === doc.id}
                          className="w-full text-left p-3 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition-all flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{doc.original_filename}</p>
                            <p className="text-xs text-gray-500 capitalize mt-0.5">{doc.document_type?.replace(/_/g, " ")}
                              {doc.status === "review_required" && <span className="ml-2 text-amber-600">· Pending review</span>}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {doc.total_amount && <span className="text-sm font-semibold text-gray-700">₹{Number(doc.total_amount).toLocaleString("en-IN")}</span>}
                            {linkingId === doc.id ? <Loader2 size={14} className="animate-spin text-blue-500" /> : <Link2 size={14} className="text-blue-400" />}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Invoice matching summary */}
          {reconData && (() => {
            const TYPE_LABELS: Record<string, string> = {
              sales_invoice:    "Sales Invoices",
              purchase_invoice: "Purchase Invoices",
              expense:          "Expenses",
              credit_note:      "Credit Notes",
              debit_note:       "Debit Notes",
            };
            const breakdown = reconData.summary.doc_type_breakdown ?? {};
            const typeEntries = Object.entries(breakdown)
              .filter(([, v]) => v.total > 0)
              .sort(([a], [b]) => (TYPE_LABELS[a] ?? a).localeCompare(TYPE_LABELS[b] ?? b));
            return (
              <div className="space-y-3">
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { label: "Invoices matched",    value: reconData.summary.matched,            cls: "text-green-600" },
                    { label: "Possible matches",    value: reconData.summary.possible,           cls: "text-amber-600" },
                    { label: "Awaiting payment",    value: reconData.summary.unmatched_invoices, cls: "text-blue-600" },
                    { label: "Unexplained txns",    value: reconData.summary.unresolved,         cls: reconData.summary.unresolved > 0 ? "text-red-600" : "text-gray-500" },
                  ].map(({ label, value, cls }) => (
                    <Card key={label}><CardContent className="py-3 px-4">
                      <p className="text-xs text-gray-500">{label}</p>
                      <p className={`text-xl font-bold mt-0.5 ${cls}`}>{value}</p>
                    </CardContent></Card>
                  ))}
                </div>
                {typeEntries.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {typeEntries.map(([type, { total, matched }]) => {
                      const allDone = matched === total;
                      const partial = matched > 0 && matched < total;
                      const cls = allDone
                        ? "bg-green-50 border-green-200 text-green-700"
                        : partial
                        ? "bg-amber-50 border-amber-200 text-amber-700"
                        : "bg-gray-50 border-gray-200 text-gray-500";
                      return (
                        <span key={type} className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border font-medium ${cls}`}>
                          <span className="font-bold">{matched}/{total}</span>
                          <span>{TYPE_LABELS[type] ?? type} matched</span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Summary + progress */}
          {reconData && (() => {
            const total = reconData.summary.total_bank_transactions;
            const explained = reconData.summary.explained;
            const pct = total > 0 ? Math.round((explained / total) * 100) : 0;
            const unresolved = reconData.summary.unresolved;
            return (
              <div className="space-y-3">
                {/* Progress bar */}
                <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                  <span className="font-medium text-gray-700">{explained} of {total} transactions explained</span>
                  <div className="flex items-center gap-3">
                    <span className={pct === 100 ? "text-green-600 font-semibold" : "text-gray-400"}>{pct}% complete</span>
                    <button onClick={runReconMatch} disabled={reconMatching}
                      className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
                      <RefreshCw size={11} className={reconMatching ? "animate-spin" : ""} />
                      {reconMatching ? "Matching…" : "Re-run matching"}
                    </button>
                  </div>
                </div>
                <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                </div>

                {/* Stat chips */}
                <div className="flex flex-wrap gap-2 pt-1">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-50 border border-green-200 text-xs font-medium text-green-700">
                    <CheckCircle2 size={12} /> {reconData.summary.matched} invoice matched
                  </div>
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-100 border border-gray-200 text-xs font-medium text-gray-600">
                    {reconData.summary.categorized_no_invoice} categorised (no invoice)
                  </div>
                  {reconData.summary.possible > 0 && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-yellow-50 border border-yellow-200 text-xs font-medium text-yellow-700 cursor-pointer hover:bg-yellow-100" onClick={() => setReconTab("possible")}>
                      <AlertTriangle size={12} /> {reconData.summary.possible} to review
                    </div>
                  )}
                  {unresolved > 0 ? (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-50 border border-red-200 text-xs font-medium text-red-700 cursor-pointer hover:bg-red-100" onClick={() => setReconTab("unmatched")}>
                      <AlertTriangle size={12} /> {unresolved} unexplained
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-50 border border-green-200 text-xs font-medium text-green-600">
                      <CheckCircle2 size={12} /> All transactions explained
                    </div>
                  )}
                  {reconData.summary.unmatched_invoices > 0 && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-xs font-medium text-blue-700 cursor-pointer hover:bg-blue-100" onClick={() => setReconTab("invoices")}>
                      <FileText size={12} /> {reconData.summary.unmatched_invoices} invoice{reconData.summary.unmatched_invoices !== 1 ? "s" : ""} awaiting payment
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Confidence scoring legend */}
          <div className="flex items-start gap-2 text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
            <Info size={13} className="text-gray-400 mt-0.5 flex-shrink-0" />
            <div className="space-y-1">
              <p className="font-medium text-gray-700">How match confidence is scored</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span><span className="font-semibold text-green-700">≥ 70%</span> — Auto-matched by LedgerIQ</span>
                <span><span className="font-semibold text-amber-600">40–69%</span> — Possible match, needs your review</span>
                <span><span className="font-semibold text-gray-600">&lt; 40%</span> — Not suggested</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-gray-400 pt-0.5">
                <span>Exact amount <span className="text-gray-600">+50</span></span>
                <span>Invoice # in narration <span className="text-gray-600">+45–55</span></span>
                <span>UTR/ref match <span className="text-gray-600">+55</span></span>
                <span>Amount = invoice − TDS <span className="text-gray-600">+35</span></span>
                <span>Date within 3 days <span className="text-gray-600">+20–30</span></span>
                <span>Vendor GSTIN in narration <span className="text-gray-600">+40</span></span>
                <span>Vendor name match <span className="text-gray-600">+10–15</span></span>
              </div>
            </div>
          </div>

          {/* Sub-tabs */}
          <div className="flex gap-1 border-b border-gray-200">
            <button onClick={() => setReconTab("unmatched")}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${reconTab === "unmatched" ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              Unexplained {reconData && reconData.summary.unresolved > 0 && <span className="ml-1 bg-red-100 text-red-700 text-xs px-1.5 py-0.5 rounded-full font-semibold">{reconData.summary.unresolved}</span>}
            </button>
            <button onClick={() => setReconTab("possible")}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${reconTab === "possible" ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              Possible matches {reconData && reconData.summary.possible > 0 && <span className="ml-1 bg-yellow-100 text-yellow-700 text-xs px-1.5 py-0.5 rounded-full font-semibold">{reconData.summary.possible}</span>}
            </button>
            <button onClick={() => setReconTab("matched")}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${reconTab === "matched" ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              Invoice matched {reconData && <span className="ml-1 bg-gray-100 text-gray-500 text-xs px-1.5 py-0.5 rounded-full">{reconData.summary.matched}</span>}
            </button>
            <button onClick={() => setReconTab("invoices")}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${reconTab === "invoices" ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              Unmatched invoices {reconData && reconData.summary.unmatched_invoices > 0 && <span className="ml-1 bg-blue-100 text-blue-700 text-xs px-1.5 py-0.5 rounded-full font-semibold">{reconData.summary.unmatched_invoices}</span>}
            </button>
          </div>

          {/* Filter bar — shown for matched + possible tabs */}
          {(reconTab === "matched" || reconTab === "possible") && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Filter by narration, invoice #, vendor, amount…"
                value={reconFilter}
                onChange={e => setReconFilter(e.target.value)}
                className="flex-1 text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
              {reconFilter && (
                <button onClick={() => setReconFilter("")} className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1.5 rounded border border-gray-200">
                  Clear
                </button>
              )}
            </div>
          )}

          {reconLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-400 py-8 justify-center"><Loader2 size={16} className="animate-spin" /> Loading…</div>
          ) : (
            <>
              {/* Matched */}
              {reconTab === "matched" && (() => {
                const inr = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
                const q = reconFilter.toLowerCase();
                const matched = (reconData?.reconciliations.filter(r => r.status === "matched") ?? []).filter(r => {
                  if (!q) return true;
                  const txn = Array.isArray(r.bank_transactions) ? r.bank_transactions[0] : r.bank_transactions;
                  const doc = Array.isArray(r.documents) ? r.documents[0] : r.documents;
                  return (
                    txn?.narration?.toLowerCase().includes(q) ||
                    txn?.ref_number?.toLowerCase().includes(q) ||
                    doc?.original_filename?.toLowerCase().includes(q) ||
                    r.doc_invoice_number?.toLowerCase().includes(q) ||
                    r.doc_total_amount?.includes(q) ||
                    String(txn?.debit_amount ?? txn?.credit_amount ?? "").includes(q)
                  );
                });
                return (
                  <Card><CardContent className="p-0">
                    {matched.length === 0 ? (
                      <div className="py-10 text-center text-gray-400 text-sm">
                        {q ? `No results for "${reconFilter}"` : "No matched transactions yet. Click Re-run matching."}
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-gray-50 border-b text-gray-500 uppercase tracking-wide text-[11px]">
                              <th className="text-left px-4 py-2.5 font-semibold whitespace-nowrap">Date</th>
                              <th className="text-left px-4 py-2.5 font-semibold">Bank Narration</th>
                              <th className="text-right px-4 py-2.5 font-semibold whitespace-nowrap">Bank Amount</th>
                              <th className="text-left px-4 py-2.5 font-semibold whitespace-nowrap">Invoice #</th>
                              <th className="text-left px-4 py-2.5 font-semibold">Invoice File</th>
                              <th className="text-right px-4 py-2.5 font-semibold whitespace-nowrap">Invoice Amount</th>
                              <th className="text-center px-4 py-2.5 font-semibold whitespace-nowrap">Conf.</th>
                              <th className="text-left px-4 py-2.5 font-semibold">Match Reasons</th>
                              <th className="px-4 py-2.5" />
                            </tr>
                          </thead>
                          <tbody>
                            {matched.map((r) => {
                              const txn = Array.isArray(r.bank_transactions) ? r.bank_transactions[0] : r.bank_transactions;
                              const doc = Array.isArray(r.documents) ? r.documents[0] : r.documents;
                              const bankAmt = Number(txn?.debit_amount ?? txn?.credit_amount ?? 0);
                              const isDebit = !!txn?.debit_amount;
                              const invAmt = r.doc_total_amount ? Number(r.doc_total_amount) : null;
                              const tdsAmt = r.doc_tds_amount ? Number(r.doc_tds_amount) : 0;
                              const netAmt = invAmt !== null ? invAmt - tdsAmt : null;
                              const score = r.match_score ?? 0;
                              const scoreColor = score >= 80 ? "bg-green-100 text-green-700" : score >= 60 ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700";
                              const amtMismatch = invAmt !== null && bankAmt > 0 && Math.abs(bankAmt - invAmt) / Math.max(bankAmt, invAmt) > 0.02;
                              return (
                                <tr key={r.id} className="border-b hover:bg-gray-50 align-top">
                                  <td className="px-4 py-3 whitespace-nowrap text-gray-500">{txn?.transaction_date ?? "—"}</td>
                                  <td className="px-4 py-3 min-w-[200px] max-w-[280px]">
                                    <p className="font-medium text-gray-900 break-words leading-snug">{txn?.narration ?? "—"}</p>
                                    <p className="text-gray-400 mt-0.5">{txn?.bank_name}{txn?.ref_number ? ` · Ref: ${txn.ref_number}` : ""}</p>
                                  </td>
                                  <td className={`px-4 py-3 text-right font-semibold whitespace-nowrap ${isDebit ? "text-red-600" : "text-green-700"}`}>
                                    {bankAmt ? `₹${inr(bankAmt)}` : "—"}
                                    <span className="text-gray-400 font-normal ml-1 text-[10px]">{isDebit ? "Dr" : "Cr"}</span>
                                  </td>
                                  <td className="px-4 py-3 whitespace-nowrap font-mono text-gray-700 text-[11px]">
                                    {r.doc_invoice_number ?? "—"}
                                  </td>
                                  <td className="px-4 py-3 min-w-[160px] max-w-[220px]">
                                    <p className="font-medium text-gray-900 break-words leading-snug">{doc?.original_filename ?? "—"}</p>
                                    <p className="text-gray-400 mt-0.5 capitalize">{doc?.document_type?.replace(/_/g, " ")}</p>
                                  </td>
                                  <td className={`px-4 py-3 text-right whitespace-nowrap ${amtMismatch ? "text-amber-600" : "text-gray-700"}`}>
                                    {invAmt !== null ? (
                                      <div>
                                        <div className="font-semibold">₹{inr(invAmt)}</div>
                                        {tdsAmt > 0 && (
                                          <div className="text-[10px] font-normal text-gray-400 mt-0.5">
                                            Net: ₹{inr(netAmt!)} <span className="text-orange-500">−TDS</span>
                                          </div>
                                        )}
                                        {amtMismatch && <div className="text-[10px] font-normal text-amber-500">Amt diff</div>}
                                      </div>
                                    ) : "—"}
                                  </td>
                                  <td className="px-4 py-3 text-center">
                                    <span className={`px-2 py-0.5 rounded-full font-bold ${scoreColor}`}>{score}%</span>
                                  </td>
                                  <td className="px-4 py-3 min-w-[160px]">
                                    <div className="flex flex-wrap gap-1">
                                      {(r.match_reasons ?? []).map((reason, i) => (
                                        <span key={i} className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[11px]">{reason}</span>
                                      ))}
                                    </div>
                                  </td>
                                  <td className="px-4 py-3">
                                    <button onClick={() => handleUnmatch(r.id)} className="text-gray-400 hover:text-red-500 flex items-center gap-1 whitespace-nowrap">
                                      <Link2Off size={12} /> Unmatch
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <div className="px-4 py-2 border-t bg-gray-50 text-xs text-gray-400">
                          {matched.length} {matched.length === 1 ? "match" : "matches"}{q ? ` matching "${reconFilter}"` : ""}
                          {" · "}Total bank: ₹{inr(matched.reduce((s, r) => { const txn = Array.isArray(r.bank_transactions) ? r.bank_transactions[0] : r.bank_transactions; return s + Number(txn?.debit_amount ?? txn?.credit_amount ?? 0); }, 0))}
                          {" · "}Total invoiced: ₹{inr(matched.reduce((s, r) => s + (r.doc_total_amount ? Number(r.doc_total_amount) : 0), 0))}
                        </div>
                      </div>
                    )}
                  </CardContent></Card>
                );
              })()}

              {/* Possible */}
              {reconTab === "possible" && (() => {
                const inr = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
                const q = reconFilter.toLowerCase();
                const possible = (reconData?.reconciliations.filter(r => r.status === "possible_match") ?? []).filter(r => {
                  if (!q) return true;
                  const txn = Array.isArray(r.bank_transactions) ? r.bank_transactions[0] : r.bank_transactions;
                  const doc = Array.isArray(r.documents) ? r.documents[0] : r.documents;
                  return (
                    txn?.narration?.toLowerCase().includes(q) ||
                    txn?.ref_number?.toLowerCase().includes(q) ||
                    doc?.original_filename?.toLowerCase().includes(q) ||
                    r.doc_invoice_number?.toLowerCase().includes(q) ||
                    r.doc_total_amount?.includes(q) ||
                    String(txn?.debit_amount ?? txn?.credit_amount ?? "").includes(q)
                  );
                });
                return (
                  <Card><CardContent className="p-0">
                    {possible.length === 0 ? (
                      <div className="py-10 text-center text-gray-400 text-sm">
                        {q ? `No results for "${reconFilter}"` : "No possible matches."}
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-gray-50 border-b text-gray-500 uppercase tracking-wide text-[11px]">
                              <th className="text-left px-4 py-2.5 font-semibold whitespace-nowrap">Date</th>
                              <th className="text-left px-4 py-2.5 font-semibold">Bank Narration</th>
                              <th className="text-right px-4 py-2.5 font-semibold whitespace-nowrap">Bank Amount</th>
                              <th className="text-left px-4 py-2.5 font-semibold whitespace-nowrap">Invoice #</th>
                              <th className="text-left px-4 py-2.5 font-semibold">Invoice File</th>
                              <th className="text-right px-4 py-2.5 font-semibold whitespace-nowrap">Invoice Amount</th>
                              <th className="text-center px-4 py-2.5 font-semibold whitespace-nowrap">Conf.</th>
                              <th className="text-left px-4 py-2.5 font-semibold">Match Reasons</th>
                              <th className="px-4 py-2.5" />
                            </tr>
                          </thead>
                          <tbody>
                            {possible.map((r) => {
                              const txn = Array.isArray(r.bank_transactions) ? r.bank_transactions[0] : r.bank_transactions;
                              const doc = Array.isArray(r.documents) ? r.documents[0] : r.documents;
                              const bankAmt = Number(txn?.debit_amount ?? txn?.credit_amount ?? 0);
                              const isDebit = !!txn?.debit_amount;
                              const invAmt = r.doc_total_amount ? Number(r.doc_total_amount) : null;
                              const tdsAmt = r.doc_tds_amount ? Number(r.doc_tds_amount) : 0;
                              const netAmt = invAmt !== null ? invAmt - tdsAmt : null;
                              const score = r.match_score ?? 0;
                              const scoreColor = score >= 70 ? "bg-yellow-100 text-yellow-700" : "bg-orange-100 text-orange-700";
                              const amtMismatch = invAmt !== null && bankAmt > 0 && Math.abs(bankAmt - invAmt) / Math.max(bankAmt, invAmt) > 0.02;
                              return (
                                <tr key={r.id} className="border-b hover:bg-yellow-50/40 align-top">
                                  <td className="px-4 py-3 whitespace-nowrap text-gray-500">{txn?.transaction_date ?? "—"}</td>
                                  <td className="px-4 py-3 min-w-[200px] max-w-[280px]">
                                    <p className="font-medium text-gray-900 break-words leading-snug">{txn?.narration ?? "—"}</p>
                                    <p className="text-gray-400 mt-0.5">{txn?.bank_name}{txn?.ref_number ? ` · Ref: ${txn.ref_number}` : ""}</p>
                                  </td>
                                  <td className={`px-4 py-3 text-right font-semibold whitespace-nowrap ${isDebit ? "text-red-600" : "text-green-700"}`}>
                                    {bankAmt ? `₹${inr(bankAmt)}` : "—"}
                                    <span className="text-gray-400 font-normal ml-1 text-[10px]">{isDebit ? "Dr" : "Cr"}</span>
                                  </td>
                                  <td className="px-4 py-3 whitespace-nowrap font-mono text-gray-700 text-[11px]">
                                    {r.doc_invoice_number ?? "—"}
                                  </td>
                                  <td className="px-4 py-3 min-w-[160px] max-w-[220px]">
                                    <p className="font-medium text-gray-900 break-words leading-snug">{doc?.original_filename ?? "—"}</p>
                                    <p className="text-gray-400 mt-0.5 capitalize">{doc?.document_type?.replace(/_/g, " ")}</p>
                                  </td>
                                  <td className={`px-4 py-3 text-right whitespace-nowrap ${amtMismatch ? "text-amber-600" : "text-gray-700"}`}>
                                    {invAmt !== null ? (
                                      <div>
                                        <div className="font-semibold">₹{inr(invAmt)}</div>
                                        {tdsAmt > 0 && (
                                          <div className="text-[10px] font-normal text-gray-400 mt-0.5">
                                            Net: ₹{inr(netAmt!)} <span className="text-orange-500">−TDS</span>
                                          </div>
                                        )}
                                        {amtMismatch && <div className="text-[10px] font-normal text-amber-500">Amt diff</div>}
                                      </div>
                                    ) : "—"}
                                  </td>
                                  <td className="px-4 py-3 text-center">
                                    <span className={`px-2 py-0.5 rounded-full font-bold ${scoreColor}`}>{score}%</span>
                                  </td>
                                  <td className="px-4 py-3 min-w-[160px]">
                                    <div className="flex flex-wrap gap-1">
                                      {(r.match_reasons ?? []).map((reason, i) => (
                                        <span key={i} className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[11px]">{reason}</span>
                                      ))}
                                    </div>
                                  </td>
                                  <td className="px-4 py-3">
                                    <div className="flex gap-2 whitespace-nowrap">
                                      <button onClick={() => handleUnmatch(r.id)} className="text-gray-400 hover:text-red-500 flex items-center gap-1">
                                        <Link2Off size={12} /> Reject
                                      </button>
                                      <button onClick={() => approvePossible(r.id)} className="bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700 flex items-center gap-1">
                                        <CheckCircle2 size={11} /> Confirm
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <div className="px-4 py-2 border-t bg-gray-50 text-xs text-gray-400">
                          {possible.length} suggestion{possible.length !== 1 ? "s" : ""}{q ? ` matching "${reconFilter}"` : ""}
                        </div>
                      </div>
                    )}
                  </CardContent></Card>
                );
              })()}

              {/* Unmatched */}
              {reconTab === "unmatched" && (() => {
                const allUnmatched = reconData?.unmatched_transactions ?? [];
                const needsAttention = allUnmatched.filter(t => !t.category);
                const categorised    = allUnmatched.filter(t => !!t.category);

                const TxnTable = ({ txns, dimmed }: { txns: BankTxn[]; dimmed?: boolean }) => (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead><tr className="border-b bg-gray-50 text-gray-500">
                        <th className="text-left px-4 py-2 font-medium">Date</th>
                        <th className="text-left px-4 py-2 font-medium">Narration</th>
                        <th className="text-left px-4 py-2 font-medium">Category</th>
                        <th className="text-right px-4 py-2 font-medium">Debit</th>
                        <th className="text-right px-4 py-2 font-medium">Credit</th>
                        <th className="px-4 py-2" />
                      </tr></thead>
                      <tbody>
                        {txns.map((txn) => (
                          <tr key={txn.id} className={`border-b hover:bg-gray-50 ${dimmed ? "opacity-50" : ""}`}>
                            <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{txn.transaction_date}</td>
                            <td className="px-4 py-2 max-w-[220px]">
                              <p className="truncate font-medium text-gray-900">{txn.narration}</p>
                              <p className="text-gray-400">{txn.bank_name}</p>
                            </td>
                            <td className="px-4 py-2">
                              <MiniCategoryChip txnId={txn.id} value={txn.category} field="category" editingTxn={editingTxn} setEditingTxn={setEditingTxn} onSave={updateTxnField} />
                            </td>
                            <td className="px-4 py-2 text-right text-red-600 font-medium">{txn.debit_amount ? `₹${Number(txn.debit_amount).toLocaleString("en-IN")}` : "—"}</td>
                            <td className="px-4 py-2 text-right text-green-700 font-medium">{txn.credit_amount ? `₹${Number(txn.credit_amount).toLocaleString("en-IN")}` : "—"}</td>
                            <td className="px-4 py-2">
                              <button onClick={() => setLinkingTxn(txn)}
                                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50">
                                <Link2 size={11} /> Link
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );

                return (
                <div className="space-y-4">
                  {/* Unexplained — no category, no invoice match */}
                  <Card><CardContent className="p-0">
                    <div className={`px-4 py-3 border-b flex items-center justify-between ${needsAttention.length > 0 ? "bg-red-50" : "bg-green-50"}`}>
                      <div>
                        {needsAttention.length > 0 ? (
                          <>
                            <span className="text-xs font-semibold text-red-700">Unexplained transactions ({needsAttention.length}) — action needed</span>
                            <p className="text-xs text-red-500 mt-0.5">No invoice and no category. Set a category or link to an invoice to explain each payment.</p>
                          </>
                        ) : (
                          <>
                            <span className="text-xs font-semibold text-green-700 flex items-center gap-1"><CheckCircle2 size={13} /> All transactions explained</span>
                            <p className="text-xs text-green-600 mt-0.5">Every bank payment has either matched an invoice or been categorised.</p>
                          </>
                        )}
                      </div>
                    </div>
                    {needsAttention.length === 0 ? (
                      <div className="py-8 text-center text-gray-400 text-sm">Nothing left to do here.</div>
                    ) : (
                      <TxnTable txns={needsAttention} />
                    )}
                  </CardContent></Card>

                  {/* Categorised — already done, collapsible */}
                  {categorised.length > 0 && (
                    <Card><CardContent className="p-0">
                      <button
                        onClick={() => setShowCategorised(v => !v)}
                        className="w-full px-4 py-3 border-b bg-gray-50 flex items-center justify-between hover:bg-gray-100 transition-colors">
                        <div className="text-left">
                          <span className="text-xs font-semibold text-gray-500">Done — categorised, no invoice needed ({categorised.length})</span>
                          <p className="text-xs text-gray-400 mt-0.5">Salary, bank charges, GST/TDS payments, etc. Already accounted for.</p>
                        </div>
                        <span className="text-gray-400 text-xs ml-4">{showCategorised ? "▲ Hide" : "▼ Show"}</span>
                      </button>
                      {showCategorised && <TxnTable txns={categorised} dimmed />}
                    </CardContent></Card>
                  )}
                </div>
                );
              })()}
              {reconTab === "invoices" && (
                <Card><CardContent className="p-0">
                  {(reconData?.unmatched_invoices ?? []).length === 0 ? (
                    <div className="py-12 text-center">
                      <CheckCircle2 size={24} className="text-green-500 mx-auto mb-2" />
                      <p className="text-sm text-gray-500">All invoices have been reconciled.</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b bg-gray-50 text-gray-500 uppercase tracking-wide text-[11px]">
                            <th className="text-left px-4 py-2.5 font-semibold">File / Invoice #</th>
                            <th className="text-left px-4 py-2.5 font-semibold">Type</th>
                            <th className="text-left px-4 py-2.5 font-semibold">Invoice Date</th>
                            <th className="text-left px-4 py-2.5 font-semibold">Status</th>
                            <th className="text-right px-4 py-2.5 font-semibold">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(reconData?.unmatched_invoices ?? []).map((doc) => (
                            <tr key={doc.id} className="border-b hover:bg-gray-50">
                              <td className="px-4 py-3 font-medium text-gray-900 max-w-[240px]">
                                <p className="truncate">{doc.original_filename}</p>
                                {doc.invoice_number && <p className="text-xs text-gray-400 font-normal mt-0.5">#{doc.invoice_number}</p>}
                              </td>
                              <td className="px-4 py-3 text-gray-500 capitalize whitespace-nowrap">{doc.document_type?.replace(/_/g, " ")}</td>
                              <td className="px-4 py-3 text-gray-600 whitespace-nowrap text-sm">{doc.invoice_date ?? "—"}</td>
                              <td className="px-4 py-3">
                                <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${doc.status === "reviewed" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                                  {doc.status === "reviewed" ? "Reviewed" : "Pending review"}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-right font-semibold text-gray-700 whitespace-nowrap">
                                {doc.total_amount ? `₹${Number(doc.total_amount).toLocaleString("en-IN")}` : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent></Card>
              )}
            </>
          )}
        </div>
      )}

      {/* Bank Statements tab */}
      {activeTab === "bank" && (
        <div className="space-y-4">
          {/* BS summary cards */}
          {bankSummary && bankSummary.total > 0 && (() => {
            const mappedPct = bankSummary.total > 0 ? Math.round((bankSummary.ledger_mapped / bankSummary.total) * 100) : 0;
            return (
              <div className="grid grid-cols-5 gap-3">
                {[
                  { label: "Total transactions", value: bankSummary.total, cls: "text-gray-900" },
                  { label: "Total debits", value: `₹${bankSummary.total_debit.toLocaleString("en-IN")}`, cls: "text-red-600" },
                  { label: "Total credits", value: `₹${bankSummary.total_credit.toLocaleString("en-IN")}`, cls: "text-green-600" },
                  { label: "Unmatched", value: bankSummary.unmatched, cls: bankSummary.unmatched > 0 ? "text-amber-600" : "text-gray-500" },
                ].map(({ label, value, cls }) => (
                  <Card key={label}><CardContent className="py-3 px-4">
                    <p className="text-xs text-gray-500">{label}</p>
                    <p className={`text-xl font-bold mt-0.5 ${cls}`}>{value}</p>
                  </CardContent></Card>
                ))}
                <Card><CardContent className="py-3 px-4">
                  <p className="text-xs text-gray-500">Ledger mapping</p>
                  <p className={`text-xl font-bold mt-0.5 ${mappedPct === 100 ? "text-green-600" : mappedPct >= 70 ? "text-blue-600" : "text-amber-600"}`}>
                    {mappedPct}%
                  </p>
                  <div className="mt-1.5 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${mappedPct === 100 ? "bg-green-500" : mappedPct >= 70 ? "bg-blue-500" : "bg-amber-500"}`}
                      style={{ width: `${mappedPct}%` }} />
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1">{bankSummary.ledger_mapped}/{bankSummary.total} mapped</p>
                </CardContent></Card>
              </div>
            );
          })()}

          {/* Truncation warning — shown when DB has more than 2000 rows */}
          {bankSummary?.truncated && (
            <div className="flex items-center gap-2 px-3 py-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-700">
              <AlertTriangle size={13} />
              Showing 2,000 of {bankSummary.total_rows_in_db.toLocaleString("en-IN")} transactions.
              Use the date filter or upload the statement in monthly batches to see all rows.
            </div>
          )}

          {/* How ledger matching works — shown when there are transactions */}
          {bankSummary && bankSummary.total > 0 && (
            <div className="px-3 py-2.5 rounded bg-gray-50 border border-gray-200 text-xs text-gray-500 space-y-1">
              <p className="font-medium text-gray-600">How auto-matching works</p>
              <p>
                <span className="font-medium text-gray-700">Pattern key</span> — each narration is normalised: payment prefixes (UPI/, NEFT/, MB:SENT TO) are stripped, reference numbers (6+ digits) removed, lowercased, and the first 30 characters are used as the pattern key shown as <span className="font-mono text-gray-600">→ key</span> below each transaction.
              </p>
              <p>
                <span className="font-medium text-gray-700">Layers</span> — ledger suggestions come from four sources in priority order: <span className="text-blue-600">Layer 3</span> (your confirmed assignments for this client, 3+ times), <span className="text-blue-600">Layer 2</span> (industry-shared rules), <span className="text-blue-600">Layer 1</span> (built-in keyword rules e.g. "salary", "rent", "gst"), and manual assignment. Fuzzy prefix matching is used — so your T&amp;B ledger "Salary" will match the global rule "Salary Expenses".
              </p>
            </div>
          )}

          {/* Inline bank statement upload panel */}
          {bankUploadOpen && (
            <Card className="border-blue-200 bg-blue-50/40">
              <CardContent className="py-3 px-4">
                <form onSubmit={uploadBankStatement} className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-gray-600">Bank</label>
                    <select value={bankUploadBankName} onChange={e => setBankUploadBankName(e.target.value)}
                      className="h-8 px-2 rounded border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {["HDFC Bank","ICICI Bank","SBI","Axis Bank","Kotak Mahindra Bank","Yes Bank","IndusInd Bank","Other"].map(b => (
                        <option key={b}>{b}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1 flex-1 min-w-[200px]">
                    <label className="text-xs font-medium text-gray-600">Statement file (CSV, Excel, or PDF)</label>
                    <input ref={bankUploadRef} type="file" required accept=".csv,.xlsx,.xls,.pdf"
                      className="block w-full text-xs text-gray-500 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-blue-100 file:text-blue-700 hover:file:bg-blue-200" />
                  </div>
                  <div className="flex gap-2 items-center">
                    <button type="submit" disabled={bankUploading}
                      className="h-8 px-3 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1">
                      {bankUploading ? <><Loader2 size={11} className="animate-spin" /> Processing…</> : <><Upload size={11} /> Upload</>}
                    </button>
                    <button type="button" onClick={() => { setBankUploadOpen(false); setBankUploadMsg(null); }}
                      className="h-8 px-3 rounded border border-gray-200 text-xs text-gray-500 hover:bg-gray-50">
                      Cancel
                    </button>
                  </div>
                  {bankUploading && (
                    <p className="w-full text-xs text-blue-600">PDF statements take 30–90 seconds — please wait…</p>
                  )}
                  {bankUploadMsg && (
                    <p className={`w-full text-xs font-medium ${bankUploadMsg.type === "success" ? "text-green-700" : "text-red-600"}`}>
                      {bankUploadMsg.text}
                    </p>
                  )}
                </form>
              </CardContent>
            </Card>
          )}

          {/* Bank filter bar — text search + date range */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              placeholder="Filter by narration, ref number, category, ledger, amount…"
              value={bankFilter}
              onChange={e => setBankFilter(e.target.value)}
              className="flex-1 min-w-[200px] text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            <div className="flex items-center gap-1.5 text-sm text-gray-500">
              <span className="text-xs">From</span>
              <input type="date" value={bsFromDate} onChange={e => setBsFromDate(e.target.value)}
                className="text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
              <span className="text-xs">To</span>
              <input type="date" value={bsToDate} onChange={e => setBsToDate(e.target.value)}
                className="text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
            </div>
            {(bankFilter || bsFromDate || bsToDate) && (
              <button onClick={() => { setBankFilter(""); setBsFromDate(""); setBsToDate(""); }}
                className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1.5 rounded border border-gray-200">Clear</button>
            )}
          </div>

          {/* Column filters — Excel-style dropdowns */}
          {bankTxns.length > 0 && (() => {
            const bsAllLedgers   = Array.from(new Set(bankTxns.map(t => t.ledger_name   ?? ""))).sort();
            const bsAllStatuses  = Array.from(new Set(bankTxns.map(t => t.status        ?? "unmatched"))).sort();
            const bsAllCategories = Array.from(new Set(bankTxns.map(t => t.category     ?? ""))).filter(Boolean).sort();
            const hasFilters = bsLedgerFilters.size > 0 || bsStatusFilters.size > 0 || bsCategoryFilters.size > 0;

            function FilterPill({ col, label, all, selected, setSelected }: {
              col: string; label: string; all: string[];
              selected: Set<string>; setSelected: (s: Set<string>) => void;
            }) {
              const isOpen = openFilterCol === col;
              const active = selected.size > 0;
              return (
                <div className="relative">
                  <button
                    onClick={() => { setOpenFilterCol(isOpen ? null : col); setBsColFilterSearch(""); }}
                    className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors select-none ${
                      active ? "border-amber-400 bg-amber-50 text-amber-700 font-medium" : "border-gray-200 text-gray-500 hover:border-gray-300 hover:bg-gray-50"
                    }`}
                  >
                    <Filter size={10} />
                    {label}{active ? ` (${selected.size})` : ""}
                    <ChevronDown size={10} />
                  </button>
                  {isOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setOpenFilterCol(null)} />
                      <div className="absolute top-8 left-0 z-50 bg-white border border-gray-200 rounded-lg shadow-xl w-56 py-2">
                        {all.length > 5 && (
                          <div className="px-2 pb-1.5 border-b border-gray-100">
                            <input autoFocus type="text" value={bsColFilterSearch}
                              onChange={e => setBsColFilterSearch(e.target.value)}
                              placeholder={`Search ${label.toLowerCase()}…`}
                              className="w-full text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                          </div>
                        )}
                        <div className="flex gap-3 px-2 py-1 border-b border-gray-100">
                          <button onClick={() => setSelected(new Set(all))} className="text-xs text-blue-600 hover:underline">Select all</button>
                          <button onClick={() => setSelected(new Set())} className="text-xs text-gray-400 hover:underline">Clear</button>
                        </div>
                        <div className="max-h-56 overflow-y-auto">
                          {all
                            .filter(v => !bsColFilterSearch || v.toLowerCase().includes(bsColFilterSearch.toLowerCase()))
                            .map(v => (
                            <label key={v || "__none__"} className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-50 cursor-pointer">
                              <input type="checkbox" checked={selected.has(v)}
                                onChange={e => { const n = new Set(selected); e.target.checked ? n.add(v) : n.delete(v); setSelected(n); }}
                                className="h-3 w-3 rounded border-gray-300" />
                              <span className="text-xs truncate">{v || "(no value)"}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              );
            }

            return (
              <div className="flex items-center gap-2 flex-wrap">
                <FilterPill col="ledger"   label="Ledger"   all={bsAllLedgers}    selected={bsLedgerFilters}   setSelected={setBsLedgerFilters} />
                <FilterPill col="status"   label="Status"   all={bsAllStatuses}   selected={bsStatusFilters}   setSelected={setBsStatusFilters} />
                <FilterPill col="category" label="Category" all={bsAllCategories} selected={bsCategoryFilters} setSelected={setBsCategoryFilters} />
                <button
                  onClick={() => setBsDateSort(s => s === "asc" ? "desc" : "asc")}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-gray-200 text-gray-500 hover:border-gray-300 hover:bg-gray-50"
                >
                  Date {bsDateSort === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
                </button>
                {bankSummary && bankSummary.flag_count > 0 && (
                  <button
                    onClick={() => setBsFlagsOnly(v => !v)}
                    className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border font-medium transition-colors ${
                      bsFlagsOnly
                        ? "border-red-400 bg-red-50 text-red-700"
                        : "border-gray-200 text-gray-500 hover:border-red-300 hover:text-red-600"
                    }`}
                  >
                    ⚑ Flags only {bsFlagsOnly && `(${bankTxns.filter(t => (t.flags?.length ?? 0) > 0).length})`}
                  </button>
                )}
                {(hasFilters || bsFlagsOnly) && (
                  <button
                    onClick={() => { setBsLedgerFilters(new Set()); setBsStatusFilters(new Set()); setBsCategoryFilters(new Set()); setBsFlagsOnly(false); }}
                    className="inline-flex items-center gap-1 text-xs text-red-400 hover:text-red-600 ml-1"
                  >
                    <X size={10} /> Clear filters
                  </button>
                )}
              </div>
            );
          })()}

          <Card>
            <CardHeader className="py-4 px-5 border-b flex flex-row items-center justify-between">
              <CardTitle className="text-sm text-gray-700">Bank transactions</CardTitle>
              <div className="flex items-center gap-3">
                <button onClick={reapplyLedgerRules} disabled={reapplying}
                  className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1 disabled:opacity-50">
                  {reapplying ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  Re-apply ledger rules
                </button>
                <button onClick={runBankMatch} disabled={bankMatching}
                  className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1 disabled:opacity-50">
                  {bankMatching ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  {bankMatching ? "Matching…" : "Re-run matching"}
                </button>
                <button onClick={() => openClaimModal()} className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1">
                  <Link2 size={11} /> Link existing
                </button>
                <a href={`/api/v1/clients/${clientId}/day-book`}
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800">
                  <Download size={12} /> Day Book
                </a>
                <a href={`/api/v1/clients/${clientId}/bank-book`}
                  className="inline-flex items-center gap-1 text-xs text-green-600 hover:text-green-800">
                  <Download size={12} /> Bank Book
                </a>
                <button
                  onClick={() => { setBankUploadOpen(!bankUploadOpen); setBankUploadMsg(null); }}
                  className="text-xs text-blue-600 hover:text-blue-800 inline-flex items-center gap-1"
                >
                  <Upload size={11} /> Upload statement
                </button>
                <button onClick={() => setWipeDialogOpen(true)} disabled={wipingBank}
                  className="text-xs text-red-400 hover:text-red-600 inline-flex items-center gap-1 disabled:opacity-50"
                  title="Wipe all bank data and re-upload">
                  {wipingBank ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                  Wipe & re-upload
                </button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {bankLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-400 py-10 justify-center">
                  <Loader2 size={16} className="animate-spin" /> Loading…
                </div>
              ) : bankTxns.length === 0 ? (
                <div className="text-center py-12">
                  <Landmark size={28} className="text-gray-300 mx-auto mb-2" />
                  <p className="text-sm text-gray-500 mb-1">No bank transactions linked to this client</p>
                  <p className="text-xs text-gray-400 mb-3">
                    Upload a bank statement in Reconciliation and select this client, or link existing transactions below.
                  </p>
                  <button onClick={() => openClaimModal()}
                    className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700">
                    <Link2 size={13} /> Link existing transactions
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  {(() => {
                    // Build a txn_id → recon info map from reconData (already loaded)
                    const reconByTxnId: Record<string, { score: number; reasons: string[]; invoiceNum: string | null; filename: string | null }> = {};
                    for (const r of reconData?.reconciliations ?? []) {
                      const txn = Array.isArray(r.bank_transactions) ? r.bank_transactions[0] : r.bank_transactions;
                      const doc = Array.isArray(r.documents) ? r.documents[0] : r.documents;
                      if (txn?.id) {
                        reconByTxnId[txn.id] = {
                          score: r.match_score,
                          reasons: r.match_reasons ?? [],
                          invoiceNum: r.doc_invoice_number ?? null,
                          filename: doc?.original_filename ?? null,
                        };
                      }
                    }
                    const filteredBankTxns = bankTxns
                      .filter(txn => {
                        if (!bankFilter) return true;
                        const q = bankFilter.toLowerCase();
                        const rInfo = reconByTxnId[txn.id];
                        return (
                          txn.narration?.toLowerCase().includes(q) ||
                          txn.ref_number?.toLowerCase().includes(q) ||
                          txn.category?.toLowerCase().includes(q) ||
                          txn.ledger_name?.toLowerCase().includes(q) ||
                          txn.bank_name?.toLowerCase().includes(q) ||
                          rInfo?.invoiceNum?.toLowerCase().includes(q) ||
                          rInfo?.filename?.toLowerCase().includes(q) ||
                          String(txn.debit_amount ?? "").includes(q) ||
                          String(txn.credit_amount ?? "").includes(q)
                        );
                      })
                      .filter(txn => !bsFromDate || txn.transaction_date >= bsFromDate)
                      .filter(txn => !bsToDate   || txn.transaction_date <= bsToDate)
                      .filter(txn => bsLedgerFilters.size   === 0 || bsLedgerFilters.has(txn.ledger_name ?? ""))
                      .filter(txn => bsStatusFilters.size   === 0 || bsStatusFilters.has(txn.status ?? "unmatched"))
                      .filter(txn => bsCategoryFilters.size === 0 || bsCategoryFilters.has(txn.category ?? ""))
                      .filter(txn => !bsFlagsOnly || (txn.flags?.length ?? 0) > 0)
                      .sort((a, b) => {
                        const d1 = new Date(a.transaction_date).getTime();
                        const d2 = new Date(b.transaction_date).getTime();
                        return bsDateSort === "asc" ? d1 - d2 : d2 - d1;
                      });
                  return (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-gray-50 text-xs text-gray-500">
                        <th className="text-left px-5 py-3 font-medium">Date</th>
                        <th className="text-left px-4 py-3 font-medium">Narration</th>
                        <th className="text-left px-4 py-3 font-medium">Ledger</th>
                        <th className="text-left px-4 py-3 font-medium">Category</th>
                        <th className="text-right px-4 py-3 font-medium">Debit</th>
                        <th className="text-right px-4 py-3 font-medium">Credit</th>
                        <th className="text-right px-4 py-3 font-medium">Balance</th>
                        <th className="px-4 py-3 font-medium">Status / Match</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredBankTxns.map((txn) => {
                        const rInfo = reconByTxnId[txn.id];
                        return (
                        <tr key={txn.id} className={`border-b last:border-0 hover:bg-gray-50/50 text-xs ${
                          txn.status === "matched" ? "bg-green-50/30" :
                          txn.status === "possible_match" ? "bg-yellow-50/30" : ""
                        }`}>
                          <td className="px-5 py-2.5 text-gray-500 whitespace-nowrap">{txn.transaction_date}</td>
                          <td className="px-4 py-2.5 max-w-xs">
                            <p className="text-gray-800">{txn.narration}</p>
                            {txn.ref_number && <p className="text-gray-400 text-xs">Ref: {txn.ref_number}</p>}
                            <p className="text-gray-400 text-xs mt-0.5">
                              <span className="text-gray-300">→</span>{" "}
                              <span className="font-mono">{extractPattern(txn.narration ?? "")}</span>
                            </p>
                            {(txn.flags ?? []).length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {(txn.flags ?? []).map(f => (
                                  <span key={f} title={FLAG_CONFIG[f]?.description ?? f}
                                    className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium cursor-help ${
                                      FLAG_CONFIG[f]?.severity === "high"
                                        ? "bg-red-100 text-red-700"
                                        : "bg-amber-100 text-amber-700"
                                    }`}>
                                    ⚑ {FLAG_CONFIG[f]?.label ?? f}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <LedgerCell
                              txnId={txn.id}
                              narration={txn.narration ?? ""}
                              value={txn.ledger_name}
                              ledgers={ledgers}
                              similarCount={bankTxns.filter(
                                (t) => t.id !== txn.id && !t.ledger_name &&
                                  extractPattern(t.narration ?? "") === extractPattern(txn.narration ?? "")
                              ).length}
                              onSave={async (txnId, val) => {
                                const res = await fetch(`/api/v1/reconciliation/transactions/${txnId}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ ledger_name: val }),
                                });
                                const d = await res.json();
                                if (d.rule_confirmed) {
                                  toast.success(`Rule confirmed — "${d.pattern}" → ${d.ledger} will now auto-map on future uploads`);
                                } else if (d.match_count && d.match_count < 3) {
                                  toast.info(`Learning (${d.match_count}/3) — assign ${3 - d.match_count} more time${3 - d.match_count !== 1 ? "s" : ""} to auto-confirm this rule`);
                                }
                                loadBankTxns();
                                return { pattern: d.pattern };
                              }}
                              onBulkApply={async (pattern, ledgerName) => {
                                const res = await fetch(`/api/v1/clients/${clientId}/bulk-apply-ledger`, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ pattern, ledger_name: ledgerName }),
                                });
                                const d = await res.json();
                                if (d.updated > 0) {
                                  toast.success(`Applied "${ledgerName}" to ${d.updated} transaction${d.updated !== 1 ? "s" : ""}`);
                                } else {
                                  toast.info("No additional transactions matched");
                                }
                                loadBankTxns();
                              }}
                            />
                            {txn.ledger_rule_progress && (
                              <p className="text-xs text-amber-500 mt-0.5 flex items-center gap-1"
                                title={`Learning: ${txn.ledger_rule_progress.count}/${txn.ledger_rule_progress.total} assignments. Assign ${txn.ledger_rule_progress.total - txn.ledger_rule_progress.count} more time(s) to auto-confirm.`}>
                                {[...Array(txn.ledger_rule_progress.total)].map((_, i) => (
                                  <span key={i} className={`inline-block w-1.5 h-1.5 rounded-full ${i < txn.ledger_rule_progress!.count ? "bg-amber-400" : "bg-gray-200"}`} />
                                ))}
                                <span>Learning ({txn.ledger_rule_progress.count}/{txn.ledger_rule_progress.total})</span>
                              </p>
                            )}
                            {txn.ledger_source && !txn.ledger_rule_progress && (
                              <p className="text-xs text-gray-400 mt-0.5 italic" title={txn.ledger_source}>{txn.ledger_source}</p>
                            )}
                            {txn.ledger_name && ledgers.length > 0 && !ledgers.some(l => l.ledger_name === txn.ledger_name) && (
                              <p className="text-xs text-amber-500 mt-0.5 flex items-center gap-1" title="This ledger name is not in your ledger master — the CA should map it to their T&B name">
                                <AlertTriangle size={9} /> Not in ledger master
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            {txn.category && (
                              <span className="px-1.5 py-0.5 rounded text-xs bg-blue-50 text-blue-700">{txn.category}</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right text-red-600 font-medium whitespace-nowrap">
                            {txn.debit_amount ? `₹${Number(txn.debit_amount).toLocaleString("en-IN")}` : ""}
                          </td>
                          <td className="px-4 py-2.5 text-right text-green-600 font-medium whitespace-nowrap">
                            {txn.credit_amount ? `₹${Number(txn.credit_amount).toLocaleString("en-IN")}` : ""}
                          </td>
                          <td className="px-4 py-2.5 text-right text-gray-500 whitespace-nowrap">
                            {txn.balance != null ? `₹${Number(txn.balance).toLocaleString("en-IN")}` : ""}
                          </td>
                          <td className="px-4 py-2.5 min-w-[160px]">
                            {(() => {
                              const isDirectExp = !needsInvoiceMatch(txn);
                              // For direct expenses that are unmatched: show ledger status only
                              if (isDirectExp && txn.status === "unmatched") {
                                return (
                                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${
                                    txn.ledger_name ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-400"
                                  }`}>
                                    {txn.ledger_name ? <><CheckCircle2 size={9} /> Ledger set</> : "No ledger"}
                                  </span>
                                );
                              }
                              // All other cases: show full reconciliation status + match info
                              return (
                                <div className="flex flex-col gap-1">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${
                                      txn.status === "matched" ? "bg-green-100 text-green-700" :
                                      txn.status === "possible_match" ? "bg-yellow-100 text-yellow-700" :
                                      "bg-gray-100 text-gray-500"
                                    }`}>
                                      {txn.status === "matched" ? <CheckCircle2 size={9} /> : null}
                                      {txn.status === "unmatched" ? "needs matching" : txn.status.replace(/_/g, " ")}
                                    </span>
                                    {rInfo?.score != null && (
                                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold ${
                                        rInfo.score >= 70 ? "bg-green-100 text-green-800" :
                                        rInfo.score >= 40 ? "bg-yellow-100 text-yellow-800" :
                                        "bg-gray-100 text-gray-600"
                                      }`}>
                                        {rInfo.score}%
                                      </span>
                                    )}
                                  </div>
                                  {(rInfo?.invoiceNum || rInfo?.filename) && (
                                    <p className="text-gray-500 text-xs truncate max-w-[180px]" title={rInfo.invoiceNum ?? rInfo.filename ?? ""}>
                                      <span className="text-gray-400">Invoice:</span>{" "}
                                      {rInfo.invoiceNum ?? rInfo.filename}
                                    </p>
                                  )}
                                  {rInfo?.reasons && rInfo.reasons.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mt-0.5">
                                      {rInfo.reasons.map((reason, i) => (
                                        <span key={i} className="px-1 py-px rounded text-xs bg-blue-50 text-blue-600 border border-blue-100">{reason}</span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  );
                  })()}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Claim transactions modal */}
      {claimOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col">
            <CardHeader className="flex-shrink-0 pb-3">
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base">Link transactions to {client?.client_name}</CardTitle>
                  <p className="text-xs text-gray-500 mt-1">These transactions have no client assigned. Select the ones belonging to this client.</p>
                </div>
                <button onClick={() => setClaimOpen(false)} className="text-gray-400 hover:text-gray-600 ml-4"><X size={18} /></button>
              </div>
              {claimBanks.length > 1 && (
                <div className="flex items-center gap-2 mt-3">
                  <span className="text-xs text-gray-500">Filter by bank:</span>
                  <select value={claimBankFilter} onChange={(e) => applyClaimFilter(e.target.value)}
                    className="text-xs rounded border border-gray-300 px-2 py-1">
                    <option value="">All banks</option>
                    {claimBanks.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
              )}
            </CardHeader>
            <CardContent className="overflow-y-auto flex-1 pt-0">
              {claimLoading ? (
                <div className="py-8 flex items-center justify-center gap-2 text-gray-400 text-sm">
                  <Loader2 size={16} className="animate-spin" /> Loading…
                </div>
              ) : claimTxns.length === 0 ? (
                <p className="text-sm text-gray-400 py-6 text-center">No unassigned transactions found. All transactions may already be linked to clients.</p>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-500">{claimSelected.size} of {claimTxns.length} selected</span>
                    <button onClick={() => setClaimSelected(claimSelected.size === claimTxns.length ? new Set() : new Set(claimTxns.map((t) => t.id)))}
                      className="text-xs text-blue-600 hover:underline">
                      {claimSelected.size === claimTxns.length ? "Deselect all" : "Select all"}
                    </button>
                  </div>
                  <div className="space-y-1">
                    {claimTxns.map((txn) => (
                      <label key={txn.id} className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${claimSelected.has(txn.id) ? "border-blue-400 bg-blue-50" : "border-gray-200 hover:border-gray-300"}`}>
                        <input type="checkbox" checked={claimSelected.has(txn.id)}
                          onChange={(e) => {
                            const s = new Set(claimSelected);
                            e.target.checked ? s.add(txn.id) : s.delete(txn.id);
                            setClaimSelected(s);
                          }}
                          className="rounded border-gray-300" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{txn.narration}</p>
                          <p className="text-xs text-gray-500">{txn.bank_name} · {txn.transaction_date}</p>
                        </div>
                        <span className="text-sm font-semibold flex-shrink-0">
                          {txn.debit_amount ? <span className="text-red-600">₹{Number(txn.debit_amount).toLocaleString("en-IN")}</span>
                            : <span className="text-green-700">₹{Number(txn.credit_amount).toLocaleString("en-IN")}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
            {claimTxns.length > 0 && (
              <div className="flex-shrink-0 px-6 py-4 border-t flex justify-end gap-2">
                <button onClick={() => setClaimOpen(false)} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
                <button onClick={saveClaim} disabled={claimSelected.size === 0 || claimSaving}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2">
                  {claimSaving ? <Loader2 size={13} className="animate-spin" /> : null}
                  Link {claimSelected.size > 0 ? claimSelected.size : ""} transactions
                </button>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Ledger View tab */}
      {activeTab === "ledger_view" && (() => {
        const inr = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
        return (
          <div className="space-y-4">
            {/* Controls */}
            <div className="flex items-end gap-3 flex-wrap">
              <div>
                <label className="text-xs text-gray-500 block mb-1">From</label>
                <input type="date" value={ledgerFromDate} onChange={e => setLedgerFromDate(e.target.value)}
                  className="text-sm border border-gray-300 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">To</label>
                <input type="date" value={ledgerToDate} onChange={e => setLedgerToDate(e.target.value)}
                  className="text-sm border border-gray-300 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
              </div>
              <button onClick={() => loadLedger(ledgerFromDate || undefined, ledgerToDate || undefined)} disabled={ledgerLoading}
                className={buttonVariants({ variant: "outline" }) + " inline-flex items-center gap-2"}>
                {ledgerLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
              </button>
              {/* View toggle */}
              <div className="flex rounded-md border border-gray-300 overflow-hidden ml-auto">
                <button onClick={() => setLedgerView("vendor")}
                  className={`px-3 py-1.5 text-sm ${ledgerView === "vendor" ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
                  Purchase Ledger
                </button>
                <button onClick={() => setLedgerView("sales")}
                  className={`px-3 py-1.5 text-sm border-l border-gray-300 ${ledgerView === "sales" ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
                  Sales Ledger
                </button>
                <button onClick={() => setLedgerView("head")}
                  className={`px-3 py-1.5 text-sm border-l border-gray-300 ${ledgerView === "head" ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
                  By Expense Head
                </button>
              </div>
            </div>

            {ledgerLoading ? (
              <div className="flex items-center justify-center py-20 gap-2 text-gray-400 text-sm">
                <Loader2 size={18} className="animate-spin" /> Building ledger…
              </div>
            ) : !ledgerData || (ledgerData.purchase.vendors.length === 0 && ledgerData.sales.customers.length === 0 && ledgerData.purchase.expense_heads.length === 0) ? (
              <div className="flex flex-col items-center justify-center py-20 gap-2 text-gray-400">
                <BarChart3 size={36} className="opacity-30" />
                <p className="text-sm">No reviewed documents found for this period.</p>
                <p className="text-xs">Upload documents and complete AI review to populate the ledger.</p>
              </div>
            ) : (
              <>
                {/* GST Net Position strip */}
                <div className="grid grid-cols-3 gap-3 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <div>
                    <p className="text-xs text-blue-600 font-medium uppercase tracking-wide">Output GST (Sales)</p>
                    <p className="text-xl font-bold text-blue-700 mt-0.5">₹{inr(ledgerData.gst_position.output_gst)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-green-600 font-medium uppercase tracking-wide">ITC Eligible (Purchases)</p>
                    <p className="text-xl font-bold text-green-700 mt-0.5">₹{inr(ledgerData.gst_position.itc_eligible)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-600 font-medium uppercase tracking-wide">Net GST Payable (GSTR-3B)</p>
                    <p className={`text-xl font-bold mt-0.5 ${ledgerData.gst_position.net_payable > 0 ? "text-red-600" : "text-green-700"}`}>
                      ₹{inr(Math.abs(ledgerData.gst_position.net_payable))}
                      {ledgerData.gst_position.net_payable <= 0 && <span className="text-xs font-normal ml-1">(credit)</span>}
                    </p>
                  </div>
                </div>

                {/* TDS payable strip */}
                {ledgerData.tds_summary.total_deducted > 0 && (
                  <div className="flex items-start gap-6 p-3 bg-orange-50 border border-orange-200 rounded-lg text-sm flex-wrap">
                    <div>
                      <span className="text-xs text-orange-600 font-medium uppercase tracking-wide">TDS Deducted (Period)</span>
                      <p className="font-bold text-orange-700">₹{inr(ledgerData.tds_summary.total_deducted)}</p>
                    </div>
                    <div>
                      <span className="text-xs text-orange-600 font-medium uppercase tracking-wide">This Month</span>
                      <p className="font-bold text-orange-700">₹{inr(ledgerData.tds_summary.this_month)}</p>
                    </div>
                    {ledgerData.tds_summary.due_date && (
                      <div>
                        <span className="text-xs text-orange-600 font-medium uppercase tracking-wide">Due to Govt</span>
                        <p className="font-bold text-orange-700">{ledgerData.tds_summary.due_date}</p>
                      </div>
                    )}
                    {Object.entries(ledgerData.tds_summary.by_section).map(([section, amt]) => (
                      <div key={section}>
                        <span className="text-xs text-orange-500 uppercase tracking-wide">{section}</span>
                        <p className="font-semibold text-orange-700">₹{inr(amt)}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Purchase summary cards */}
                {(ledgerView === "vendor" || ledgerView === "head") && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                    {[
                      { label: "Total Invoiced",  value: `₹${inr(ledgerData.purchase.totals.invoiced)}`,     cls: "text-gray-900" },
                      { label: "ITC Eligible",    value: `₹${inr(ledgerData.purchase.totals.itc_eligible)}`, cls: "text-green-700" },
                      { label: "ITC Blocked",     value: `₹${inr(ledgerData.purchase.totals.itc_blocked)}`,  cls: "text-red-600" },
                      { label: "TDS Deducted",    value: `₹${inr(ledgerData.purchase.totals.tds)}`,          cls: "text-orange-700" },
                      { label: "Paid",            value: `₹${inr(ledgerData.purchase.totals.paid)}`,         cls: "text-green-700" },
                      { label: "Outstanding",     value: `₹${inr(ledgerData.purchase.totals.outstanding)}`,  cls: ledgerData.purchase.totals.outstanding > 0 ? "text-red-600" : "text-green-700" },
                    ].map(({ label, value, cls }) => (
                      <Card key={label} className="border border-gray-200">
                        <CardContent className="p-3">
                          <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
                          <p className={`text-lg font-bold mt-0.5 ${cls}`}>{value}</p>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}

                {/* Sales summary cards */}
                {ledgerView === "sales" && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                    {[
                      { label: "Total Invoiced", value: `₹${inr(ledgerData.sales.totals.invoiced)}`,    cls: "text-gray-900" },
                      { label: "Taxable Value",  value: `₹${inr(ledgerData.sales.totals.taxable)}`,     cls: "text-gray-700" },
                      { label: "Output GST",     value: `₹${inr(ledgerData.sales.totals.output_gst)}`,  cls: "text-blue-700" },
                      { label: "Received",       value: `₹${inr(ledgerData.sales.totals.received)}`,    cls: "text-green-700" },
                      { label: "Outstanding",    value: `₹${inr(ledgerData.sales.totals.outstanding)}`, cls: ledgerData.sales.totals.outstanding > 0 ? "text-red-600" : "text-green-700" },
                    ].map(({ label, value, cls }) => (
                      <Card key={label} className="border border-gray-200">
                        <CardContent className="p-3">
                          <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
                          <p className={`text-lg font-bold mt-0.5 ${cls}`}>{value}</p>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}

                {/* Purchase Ledger — By Vendor */}
                {ledgerView === "vendor" && (
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_1fr_40px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      <span>Vendor</span>
                      <span className="text-right">Invoices</span>
                      <span className="text-right">Taxable</span>
                      <span className="text-right">GST</span>
                      <span className="text-right">TDS</span>
                      <span className="text-right">Net Payable</span>
                      <span className="text-right">Outstanding</span>
                      <span />
                    </div>
                    {ledgerData.purchase.vendors.map((v) => (
                      <div key={v.vendor_name} className="border-b border-gray-100 last:border-0">
                        <button
                          onClick={() => toggleVendor(v.vendor_name)}
                          className="w-full grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_1fr_40px] gap-2 px-4 py-3 hover:bg-gray-50 transition-colors text-sm text-left items-center">
                          <span className="font-medium text-gray-900 truncate flex items-center gap-2">
                            {expandedVendors.has(v.vendor_name)
                              ? <ChevronDown size={14} className="text-gray-400 flex-shrink-0" />
                              : <ChevronRight size={14} className="text-gray-400 flex-shrink-0" />}
                            {v.vendor_name}
                          </span>
                          <span className="text-right text-gray-500">{v.invoice_count}</span>
                          <span className="text-right text-gray-700">₹{inr(v.total_taxable)}</span>
                          <span className="text-right text-blue-700">₹{inr(v.total_gst)}</span>
                          <span className="text-right text-orange-700">₹{inr(v.total_tds)}</span>
                          <span className="text-right text-gray-900 font-medium">₹{inr(v.net_payable)}</span>
                          <span className={`text-right font-semibold ${v.outstanding > 100 ? "text-red-600" : "text-green-700"}`}>
                            ₹{inr(v.outstanding)}
                          </span>
                          <span />
                        </button>
                        {expandedVendors.has(v.vendor_name) && (
                          <div className="bg-gray-50 border-t border-gray-100">
                            <div className="grid grid-cols-[100px_120px_1fr_70px_1fr_1fr_1fr_70px_110px_80px] gap-1 px-8 py-1.5 text-xs font-medium text-gray-400 uppercase tracking-wide border-b border-gray-200">
                              <span>Date</span>
                              <span>Invoice #</span>
                              <span className="text-right">Taxable</span>
                              <span className="text-center">GST%</span>
                              <span className="text-right">GST</span>
                              <span className="text-right">TDS</span>
                              <span className="text-right">Net Pay</span>
                              <span className="text-center">ITC</span>
                              <span className="text-center">Payment</span>
                              <span />
                            </div>
                            {v.invoices.map((inv) => (
                              <div key={inv.doc_id}
                                className="grid grid-cols-[100px_120px_1fr_70px_1fr_1fr_1fr_70px_110px_80px] gap-1 px-8 py-2.5 text-xs border-b border-gray-100 last:border-0 items-center hover:bg-white transition-colors">
                                <span className="text-gray-500">{inv.invoice_date ?? "—"}</span>
                                <span className="text-gray-700 font-medium truncate" title={inv.invoice_number ?? ""}>{inv.invoice_number ?? "—"}</span>
                                <span className="text-right text-gray-700">₹{inr(inv.taxable_value)}</span>
                                <span className="text-center text-gray-500 text-xs">{inv.gst_rate_pct || "—"}</span>
                                <span className="text-right text-blue-700">₹{inr(inv.total_gst)}</span>
                                <span className="text-right text-orange-700">
                                  {inv.tds_section ? (
                                    <span title={inv.tds_reasoning ? `${inv.tds_section} @ ${inv.tds_rate ?? "?"}% — ${inv.tds_reasoning}` : `${inv.tds_section} @ ${inv.tds_rate ?? "?"}%`}>
                                      ₹{inr(inv.tds_amount)}
                                    </span>
                                  ) : "—"}
                                </span>
                                <span className="text-right font-medium text-gray-900">₹{inr(inv.net_payable)}</span>
                                <span className="text-center">
                                  <span className={`px-1 py-0.5 rounded text-xs font-medium ${
                                    inv.itc_eligible === "Yes" ? "bg-green-100 text-green-700" :
                                    inv.itc_eligible === "Blocked" ? "bg-red-100 text-red-700" :
                                    "bg-gray-100 text-gray-400"
                                  }`}>
                                    {inv.itc_eligible ?? "—"}
                                  </span>
                                </span>
                                <span className="text-center">
                                  {inv.payment ? (
                                    <span className="text-green-700" title={`Paid ₹${inr(inv.payment.amount)} on ${inv.payment.date}`}>
                                      ✓ {inv.payment.date}
                                    </span>
                                  ) : (
                                    <span className="text-amber-600">Unpaid</span>
                                  )}
                                </span>
                                <span className="flex items-center justify-end gap-1">
                                  {inv.reverse_charge === "Yes" && (
                                    <span className="px-1 py-0.5 rounded bg-purple-100 text-purple-700 text-xs" title="Reverse Charge Mechanism — you owe GST directly to govt">RCM</span>
                                  )}
                                  <Link href={`/review/${inv.doc_id}`}
                                    className="inline-flex items-center text-blue-600 hover:underline">
                                    <ExternalLink size={10} />
                                  </Link>
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Sales Ledger — By Customer */}
                {ledgerView === "sales" && (
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_40px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      <span>Customer</span>
                      <span className="text-right">Invoices</span>
                      <span className="text-right">Taxable</span>
                      <span className="text-right">Output GST</span>
                      <span className="text-right">Total Invoiced</span>
                      <span className="text-right">Outstanding</span>
                      <span />
                    </div>
                    {ledgerData.sales.customers.length === 0 ? (
                      <div className="py-10 text-center text-gray-400 text-sm">No sales invoices found for this period.</div>
                    ) : ledgerData.sales.customers.map((c) => (
                      <div key={c.customer_name} className="border-b border-gray-100 last:border-0">
                        <button
                          onClick={() => toggleVendor(c.customer_name)}
                          className="w-full grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_40px] gap-2 px-4 py-3 hover:bg-gray-50 transition-colors text-sm text-left items-center">
                          <span className="font-medium text-gray-900 truncate flex items-center gap-2">
                            {expandedVendors.has(c.customer_name)
                              ? <ChevronDown size={14} className="text-gray-400 flex-shrink-0" />
                              : <ChevronRight size={14} className="text-gray-400 flex-shrink-0" />}
                            {c.customer_name}
                          </span>
                          <span className="text-right text-gray-500">{c.invoice_count}</span>
                          <span className="text-right text-gray-700">₹{inr(c.total_taxable)}</span>
                          <span className="text-right text-blue-700">₹{inr(c.total_gst)}</span>
                          <span className="text-right text-gray-900 font-medium">₹{inr(c.total_invoiced)}</span>
                          <span className={`text-right font-semibold ${c.outstanding > 100 ? "text-red-600" : "text-green-700"}`}>
                            ₹{inr(c.outstanding)}
                          </span>
                          <span />
                        </button>
                        {expandedVendors.has(c.customer_name) && (
                          <div className="bg-gray-50 border-t border-gray-100">
                            <div className="grid grid-cols-[100px_120px_1fr_70px_1fr_1fr_110px_80px] gap-1 px-8 py-1.5 text-xs font-medium text-gray-400 uppercase tracking-wide border-b border-gray-200">
                              <span>Date</span>
                              <span>Invoice #</span>
                              <span className="text-right">Taxable</span>
                              <span className="text-center">GST%</span>
                              <span className="text-right">GST</span>
                              <span className="text-right">Total</span>
                              <span className="text-center">Payment</span>
                              <span />
                            </div>
                            {c.invoices.map((inv) => (
                              <div key={inv.doc_id}
                                className="grid grid-cols-[100px_120px_1fr_70px_1fr_1fr_110px_80px] gap-1 px-8 py-2.5 text-xs border-b border-gray-100 last:border-0 items-center hover:bg-white transition-colors">
                                <span className="text-gray-500">{inv.invoice_date ?? "—"}</span>
                                <span className="text-gray-700 font-medium truncate" title={inv.invoice_number ?? ""}>{inv.invoice_number ?? "—"}</span>
                                <span className="text-right text-gray-700">₹{inr(inv.taxable_value)}</span>
                                <span className="text-center text-gray-500 text-xs">{inv.gst_rate_pct || "—"}</span>
                                <span className="text-right text-blue-700">₹{inr(inv.total_gst)}</span>
                                <span className="text-right font-medium text-gray-900">₹{inr(inv.total_amount)}</span>
                                <span className="text-center">
                                  {inv.payment ? (
                                    <span className="text-green-700" title={`Received ₹${inr(inv.payment.amount)} on ${inv.payment.date}`}>
                                      ✓ {inv.payment.date}
                                    </span>
                                  ) : (
                                    <span className="text-amber-600">Pending</span>
                                  )}
                                </span>
                                <span className="text-right">
                                  <Link href={`/review/${inv.doc_id}`}
                                    className="inline-flex items-center text-blue-600 hover:underline">
                                    <ExternalLink size={10} />
                                  </Link>
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* By Expense Head view */}
                {ledgerView === "head" && (
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_1fr] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      <span>Expense Head</span>
                      <span className="text-right">Invoices</span>
                      <span className="text-right">Taxable</span>
                      <span className="text-right">GST</span>
                      <span className="text-right">TDS</span>
                      <span className="text-right">ITC Eligible</span>
                      <span className="text-right">ITC Blocked</span>
                    </div>
                    {ledgerData.purchase.expense_heads.map((h) => (
                      <div key={h.ledger_name}
                        className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_1fr] gap-2 px-4 py-3 border-b border-gray-100 last:border-0 text-sm items-center hover:bg-gray-50">
                        <span className="font-medium text-gray-900">{h.ledger_name}</span>
                        <span className="text-right text-gray-500">{h.invoice_count}</span>
                        <span className="text-right text-gray-700">₹{inr(h.total_taxable)}</span>
                        <span className="text-right text-blue-700">₹{inr(h.total_gst)}</span>
                        <span className="text-right text-orange-700">₹{inr(h.total_tds)}</span>
                        <span className="text-right text-green-700">₹{inr(h.itc_eligible)}</span>
                        <span className="text-right text-red-600">₹{inr(h.itc_blocked)}</span>
                      </div>
                    ))}
                    <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_1fr] gap-2 px-4 py-3 bg-gray-100 text-sm font-semibold border-t border-gray-300">
                      <span className="text-gray-700">Total</span>
                      <span className="text-right text-gray-700">{ledgerData.purchase.expense_heads.reduce((s, h) => s + h.invoice_count, 0)}</span>
                      <span className="text-right">₹{inr(ledgerData.purchase.totals.taxable)}</span>
                      <span className="text-right text-blue-700">₹{inr(ledgerData.purchase.totals.gst)}</span>
                      <span className="text-right text-orange-700">₹{inr(ledgerData.purchase.totals.tds)}</span>
                      <span className="text-right text-green-700">₹{inr(ledgerData.purchase.totals.itc_eligible)}</span>
                      <span className="text-right text-red-600">₹{inr(ledgerData.purchase.totals.itc_blocked)}</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })()}

      {/* Summary Note tab */}
      {activeTab === "summary" && (
        <div className="space-y-4">
          {/* Controls */}
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Period from</label>
              <input type="date" value={summaryPeriodFrom} onChange={e => setSummaryPeriodFrom(e.target.value)}
                className="text-sm border border-gray-300 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Period to</label>
              <input type="date" value={summaryPeriodTo} onChange={e => setSummaryPeriodTo(e.target.value)}
                className="text-sm border border-gray-300 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400" />
            </div>
            <button onClick={generateSummary} disabled={summaryGenerating}
              className={buttonVariants() + " inline-flex items-center gap-2"}>
              {summaryGenerating
                ? <><Loader2 size={14} className="animate-spin" /> Generating…</>
                : <><RefreshCw size={14} /> {summary ? "Regenerate" : "Generate"} Summary</>}
            </button>
            {summary && (
              <button onClick={downloadSummary}
                className={buttonVariants({ variant: "outline" }) + " inline-flex items-center gap-2"}>
                <Download size={14} /> Download .md
              </button>
            )}
            {summary && (
              <span className="text-xs text-gray-400 self-end pb-2">
                Last generated: {new Date(summary.generated_at).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                {summary.period_from && ` · Period: ${summary.period_from} – ${summary.period_to ?? "present"}`}
              </span>
            )}
          </div>

          {/* Content */}
          {summaryLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 size={22} className="animate-spin text-gray-400" /></div>
          ) : summaryGenerating ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-400">
              <Loader2 size={28} className="animate-spin" />
              <p className="text-sm">Analysing documents and generating summary…</p>
              <p className="text-xs">This takes 15–30 seconds</p>
            </div>
          ) : summary ? (
            <Card>
              <CardContent className="py-6 px-8 prose prose-sm max-w-none
                prose-headings:text-gray-900 prose-headings:font-semibold
                prose-h2:text-base prose-h2:mt-5 prose-h2:mb-2
                prose-p:text-gray-700 prose-p:leading-relaxed
                prose-li:text-gray-700 prose-strong:text-gray-900
                prose-hr:border-gray-200">
                <SummaryRenderer markdown={summary.summary_md} />
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-gray-400">
              <ScrollText size={36} className="opacity-30" />
              <p className="text-sm">No summary yet.</p>
              <p className="text-xs">Click "Generate Summary" to create a comprehensive accountant note for this client.</p>
            </div>
          )}
        </div>
      )}

      {/* Mapping History tab */}
      {activeTab === "mapping" && (
        <div className="space-y-5">
          {/* Import CTA */}
          <Card className="border-purple-200 bg-purple-50/40">
            <CardContent className="py-5 px-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                    <BookOpen size={15} className="text-purple-600" /> Historical Bank Book Import
                  </h2>
                  <p className="text-xs text-gray-500 mt-1 max-w-lg">
                    Upload last year&apos;s bank statement and Tally bank book together. The system matches transactions by date &amp; amount, learns which bank narration maps to which ledger, and creates rules automatically for this client.
                  </p>
                  <ul className="mt-2 space-y-0.5 text-xs text-gray-400">
                    <li>• <strong className="text-gray-600">Bank statement</strong> — CSV/Excel from your bank portal (has messy narrations like NEFT/REF/…)</li>
                    <li>• <strong className="text-gray-600">Bank book</strong> — Tally export (has clean Particulars like "Reliance Steel Works")</li>
                  </ul>
                </div>
                <button
                  onClick={() => { setBbImportOpen(true); bbReset(); }}
                  className="flex-shrink-0 px-4 py-2 rounded-md bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 inline-flex items-center gap-2"
                >
                  <Upload size={13} /> Import bank book
                </button>
              </div>
            </CardContent>
          </Card>

          {/* Rules list — reuses mapping rules state already loaded */}
          {rulesLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-400 py-6"><Loader2 size={15} className="animate-spin" /> Loading rules…</div>
          ) : clientMappingRules.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-gray-400 text-sm">
                <BookOpen size={26} className="mx-auto mb-2 text-gray-300" />
                No mapping rules yet for this client. Import a bank book to create rules automatically, or assign ledgers manually in the Bank Statements tab.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="py-3 px-5 border-b flex flex-row items-center justify-between">
                <CardTitle className="text-sm text-gray-700">
                  Ledger Mapping Rules <span className="text-gray-400 font-normal">({clientMappingRules.length})</span>
                </CardTitle>
                <div className="relative">
                  <input value={ruleSearch} onChange={e => setRuleSearch(e.target.value)}
                    placeholder="Search rules…"
                    className="text-xs h-7 pl-7 pr-2 rounded border border-gray-200 focus:outline-none focus:ring-1 focus:ring-purple-400 w-48" />
                  <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-gray-50 text-gray-500">
                      <th className="text-left px-5 py-2.5 font-medium">Pattern</th>
                      <th className="text-left px-4 py-2.5 font-medium">Ledger</th>
                      <th className="text-left px-4 py-2.5 font-medium">Source</th>
                      <th className="text-left px-4 py-2.5 font-medium">FY</th>
                      <th className="text-right px-4 py-2.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clientMappingRules
                      .filter(r => !ruleSearch || r.pattern.includes(ruleSearch.toLowerCase()) || r.ledger_name.toLowerCase().includes(ruleSearch.toLowerCase()))
                      .sort((a, b) => (b.confirmed ? 1 : -1) - (a.confirmed ? 1 : -1) || a.pattern.localeCompare(b.pattern))
                      .map(r => (
                        <tr key={r.id} className="border-b last:border-0 hover:bg-gray-50/50">
                          <td className="px-5 py-2.5 font-mono text-gray-700">{r.pattern}</td>
                          <td className="px-4 py-2.5 text-gray-800 font-medium">{r.ledger_name}</td>
                          <td className="px-4 py-2.5 text-gray-400">
                            {r.source === "bank_book_import" ? "Bank Book Import" : r.match_count >= 3 ? `Learned (${r.match_count}×)` : `Draft (${r.match_count}/3)`}
                          </td>
                          <td className="px-4 py-2.5 text-gray-400">
                            {r.financial_year ? <span className="bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded text-[10px] font-medium">{r.financial_year}</span> : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${r.confirmed ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                              {r.confirmed ? "Active" : "Draft"}
                            </span>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Ledger Master tab */}
      {activeTab === "ledgers" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Ledger Master</h2>
              <p className="text-xs text-gray-500 mt-0.5">Define Tally ledger names for this client. Used to auto-classify bank transactions.</p>
            </div>
            <div className="flex items-center gap-2">
              <input ref={ledgerImportRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={importLedgers} />
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">FY</span>
                <input
                  type="text"
                  value={trialBalanceFY}
                  onChange={e => setTrialBalanceFY(e.target.value)}
                  placeholder="2024-25"
                  className="w-20 text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </div>
              <button onClick={() => ledgerImportRef.current?.click()} disabled={importingLedgers}
                className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
                {importingLedgers ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                Import Ledger List
              </button>
              <button onClick={seedLedgers} disabled={seedingLedgers}
                className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
                {seedingLedgers ? <Loader2 size={13} className="animate-spin" /> : <BookOpen size={13} />}
                Load 25 common ledgers
              </button>
              {ledgers.length > 0 && (
                <button onClick={clearAllLedgers} disabled={deletingLedgers}
                  className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {deletingLedgers ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  Clear all
                </button>
              )}
            </div>
          </div>

          {/* Add ledger form */}
          <Card>
            <CardContent className="pt-4 pb-4">
              <form onSubmit={addLedger} className="flex gap-2 items-end">
                <div className="flex-1 space-y-1">
                  <label className="text-xs font-medium text-gray-600">Ledger name</label>
                  <input value={newLedgerName} onChange={(e) => setNewLedgerName(e.target.value)}
                    placeholder="e.g. Petrol Expenses"
                    className="w-full h-9 px-3 rounded-md border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-600">Type</label>
                  <select value={newLedgerType} onChange={(e) => setNewLedgerType(e.target.value)}
                    className="h-9 px-2 rounded-md border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {["expense","income","asset","liability","capital","bank","tax"].map((t) => (
                      <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                    ))}
                  </select>
                </div>
                <button type="submit" disabled={addingLedger || !newLedgerName.trim()}
                  className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1">
                  {addingLedger ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add
                </button>
              </form>
            </CardContent>
          </Card>

          {/* Ledger search */}
          <div className="relative">
            <input
              value={ledgerSearch}
              onChange={e => setLedgerSearch(e.target.value)}
              placeholder="Search ledgers…"
              className="w-full h-9 pl-8 pr-3 rounded-md border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            {ledgerSearch && (
              <button onClick={() => setLedgerSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <X size={12} />
              </button>
            )}
          </div>

          {/* Ledger list */}
          <Card>
            <CardContent className="p-0">
              {ledgersLoading ? (
                <div className="py-8 flex items-center justify-center gap-2 text-gray-400 text-sm">
                  <Loader2 size={16} className="animate-spin" /> Loading…
                </div>
              ) : ledgers.length === 0 ? (
                <div className="py-12 text-center text-gray-400 text-sm">
                  <BookOpen size={28} className="mx-auto mb-2 text-gray-300" />
                  No ledgers yet. Add one above or click "Load 25 common ledgers".
                </div>
              ) : (
                <>
                {/* Bulk action bar */}
                {selectedLedgerIds.size > 0 && (
                  <div className="flex items-center gap-3 px-4 py-2 bg-indigo-50 border-b border-indigo-100">
                    <span className="text-xs text-indigo-700 font-medium">{selectedLedgerIds.size} selected</span>
                    <button onClick={deleteSelectedLedgers} disabled={deletingLedgers}
                      className="text-xs px-3 py-1 rounded bg-red-600 text-white font-medium hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-1">
                      {deletingLedgers ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                      Delete selected
                    </button>
                    <button onClick={() => setSelectedLedgerIds(new Set())}
                      className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>
                  </div>
                )}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className="px-3 py-3 w-8">
                        <input type="checkbox"
                          checked={selectedLedgerIds.size === ledgers.length && ledgers.length > 0}
                          onChange={(e) => setSelectedLedgerIds(e.target.checked ? new Set(ledgers.map(l => l.id)) : new Set())}
                          className="rounded border-gray-300" />
                      </th>
                      <th className="text-left px-5 py-3 text-xs font-medium text-gray-500">Ledger Name</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Type</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500">
                        Closing Balance
                        {(() => { const fy = ledgers.find(l => l.financial_year)?.financial_year; return fy ? <span className="ml-1 font-normal text-gray-400">· FY {fy}</span> : null; })()}
                      </th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {ledgers.filter(l => !ledgerSearch || l.ledger_name.toLowerCase().includes(ledgerSearch.toLowerCase()) || l.ledger_type.includes(ledgerSearch.toLowerCase())).map((l) => (
                      <tr key={l.id} className={`border-b last:border-0 hover:bg-gray-50/50 ${selectedLedgerIds.has(l.id) ? "bg-indigo-50/40" : ""}`}>
                        <td className="px-3 py-2.5">
                          <input type="checkbox" checked={selectedLedgerIds.has(l.id)}
                            onChange={(e) => {
                              const next = new Set(selectedLedgerIds);
                              e.target.checked ? next.add(l.id) : next.delete(l.id);
                              setSelectedLedgerIds(next);
                            }}
                            className="rounded border-gray-300" />
                        </td>
                        <td className="px-5 py-2.5 font-medium text-gray-800">
                          <span className="flex items-center gap-2">
                            {l.ledger_name}
                            {l.source === "trial_balance" && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 font-semibold tracking-wide">TB</span>
                            )}
                            {l.financial_year && <span className="text-[10px] text-gray-400">FY {l.financial_year}</span>}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            l.ledger_type === "expense"   ? "bg-red-50 text-red-700" :
                            l.ledger_type === "income"    ? "bg-green-50 text-green-700" :
                            l.ledger_type === "tax"       ? "bg-orange-50 text-orange-700" :
                            l.ledger_type === "capital"   ? "bg-purple-50 text-purple-700" :
                            l.ledger_type === "bank"      ? "bg-blue-50 text-blue-700" :
                            "bg-gray-100 text-gray-600"
                          }`}>{l.ledger_type}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right text-sm">
                          {l.closing_balance != null ? (
                            <span className={l.balance_type === "Cr" ? "text-green-700 font-medium" : "text-red-700 font-medium"}>
                              ₹{Number(l.closing_balance).toLocaleString("en-IN")}
                              <span className="ml-1 text-[10px] font-normal opacity-70">{l.balance_type}</span>
                            </span>
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button onClick={() => deleteLedger(l.id)} className="text-gray-300 hover:text-red-500 transition-colors">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </>
              )}
            </CardContent>
          </Card>

          {/* ── Mapping Rules section ──────────────────────────────────────── */}
          <div>
            {/* How auto-mapping works — info box */}
            <details className="mb-3 rounded-lg border border-blue-100 bg-blue-50/60 text-xs">
              <summary className="px-4 py-2.5 cursor-pointer font-medium text-blue-800 flex items-center gap-1.5 select-none">
                <span className="text-base leading-none">ℹ</span> How auto-mapping rules work
              </summary>
              <div className="px-4 pb-3 pt-1 space-y-2 text-gray-600 leading-relaxed">
                <p><span className="font-semibold text-gray-700">Layer 1 — Global keywords</span> &nbsp;Always-on built-in rules that match common Indian bank narrations: SALARY → Salary Expenses, GSTIN/GST PAY → GST Cash Ledger, EPFO/ESIC → PF / ESI, etc. These apply to every client automatically.</p>
                <p><span className="font-semibold text-gray-700">Layer 2 — Industry rules</span> &nbsp;Rules shared across all your clients in the same industry (e.g. all Retail clients). Auto-promoted when 3+ of your own clients confirm the same pattern. You can also promote manually using "→ Industry". Industry rules are private to your firm — never shared with other CAs.</p>
                <p><span className="font-semibold text-gray-700">Layer 3 Active — Confirmed client rules</span> &nbsp;Narration patterns you&apos;ve confirmed for this specific client. Applied automatically on every bank statement upload. A rule is confirmed once assigned 3 times to the same pattern, or when you click "Activate now".</p>
                <p><span className="font-semibold text-gray-700">Layer 3 Draft — Awaiting confirmation</span> &nbsp;Patterns seen 1–2 times. Not yet applied automatically. Activate manually or keep assigning the same ledger until it auto-confirms at 3 hits.</p>
                <p><span className="font-semibold text-amber-700">✦ AI Suggest</span> &nbsp;Scans unassigned bank transactions and suggests ledger mappings using your Trial Balance ledger names as the vocabulary. After uploading a Trial Balance, AI Suggest will prefer exact Tally ledger names (e.g. "RENT (MR KATEKAR)") over generic names. Review and approve each suggestion — approved rules become Draft rules and start counting toward auto-confirmation.</p>
              </div>
            </details>

            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Auto-Mapping Rules</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Narration keyword → Ledger. Sorted alphabetically — similar patterns appear together.
                  {industryNameForRules && (
                    <span className="ml-1 text-blue-600">Industry: <strong>{industryNameForRules}</strong></span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={loadMappingRules}
                  disabled={rulesLoading}
                  className="text-xs px-2.5 py-1.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 inline-flex items-center gap-1 disabled:opacity-50"
                  title="Reload rules from database"
                >
                  {rulesLoading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                </button>
                <button
                  onClick={fetchSuggestions}
                  disabled={suggestLoading}
                  className="text-xs px-2.5 py-1.5 rounded border border-purple-200 text-purple-700 hover:bg-purple-50 inline-flex items-center gap-1 disabled:opacity-50"
                  title="AI scans unrecognised transactions and suggests ledger mappings"
                >
                  {suggestLoading ? <Loader2 size={11} className="animate-spin" /> : <span>✦</span>} AI Suggest
                </button>
                <button
                  onClick={() => { setNewRulePattern(""); setNewRuleLedger(""); setAddingRule(false); document.getElementById("quick-rule-modal")?.classList.remove("hidden"); }}
                  className="text-xs px-2.5 py-1.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1"
                >
                  <Plus size={11} /> Quick add
                </button>
                <a href="/rules-library" className="text-xs text-blue-600 hover:text-blue-800">
                  Manage all →
                </a>
              </div>
            </div>

            {/* Quick-add inline form (hidden by default) */}
            <div id="quick-rule-modal" className="hidden mb-3">
              <Card className="border-blue-200 bg-blue-50/30">
                <CardContent className="pt-3 pb-3">
                  <form onSubmit={addMappingRule} className="flex gap-2 items-end flex-wrap">
                    <div className="flex-1 min-w-[120px] space-y-1">
                      <label className="text-xs font-medium text-gray-600">Keyword</label>
                      <input value={newRulePattern} onChange={(e) => setNewRulePattern(e.target.value)}
                        placeholder="e.g. swiggy"
                        className="w-full h-8 px-2 rounded border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                    <div className="flex-1 min-w-[120px] space-y-1">
                      <label className="text-xs font-medium text-gray-600">Ledger</label>
                      <select value={newRuleLedger} onChange={(e) => setNewRuleLedger(e.target.value)}
                        className="w-full h-8 px-2 rounded border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="">Select…</option>
                        {ledgers.map((l) => <option key={l.id} value={l.ledger_name}>{l.ledger_name}</option>)}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-600">Scope</label>
                      <select value={newRuleScope} onChange={(e) => setNewRuleScope(e.target.value as "client" | "industry")}
                        className="h-8 px-2 rounded border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="client">This client</option>
                        {industryNameForRules && <option value="industry">Industry</option>}
                      </select>
                    </div>
                    <div className="flex gap-1">
                      <button type="submit" disabled={!newRulePattern.trim() || !newRuleLedger}
                        className="h-8 px-3 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50">
                        Save
                      </button>
                      <button type="button"
                        onClick={() => document.getElementById("quick-rule-modal")?.classList.add("hidden")}
                        className="h-8 px-3 rounded border border-gray-200 text-xs text-gray-500 hover:bg-gray-50">
                        Cancel
                      </button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            </div>

            {/* AI suggestion review panel */}
            {suggestOpen && suggestions.length > 0 && (
              <Card className="mb-3 border-purple-200">
                <CardHeader className="pb-2 pt-3">
                  <CardTitle className="text-sm font-medium text-purple-800 flex items-center justify-between">
                    <span>✦ AI Suggestions — {suggestions.length} pattern{suggestions.length !== 1 ? "s" : ""} found</span>
                    <button onClick={() => setSuggestOpen(false)} className="text-xs text-gray-400 hover:text-gray-600 font-normal">Dismiss</button>
                  </CardTitle>
                  <p className="text-xs text-gray-500">Review each suggestion. Edit the ledger if needed, then Accept. Skip anything you&apos;re unsure about.</p>
                </CardHeader>
                <CardContent className="p-0">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-purple-50 text-gray-500">
                        <th className="text-left px-5 py-2 font-medium">Pattern</th>
                        <th className="text-left px-4 py-2 font-medium">Example narration</th>
                        <th className="text-left px-4 py-2 font-medium">Suggested ledger</th>
                        <th className="text-left px-4 py-2 font-medium">Reason</th>
                        <th className="text-center px-4 py-2 font-medium">Confidence</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {suggestions.map(s => {
                        const ledger = suggestionOverrides[s.pattern] ?? s.suggested_ledger;
                        return (
                          <tr key={s.pattern} className="border-b last:border-0 hover:bg-gray-50/50">
                            <td className="px-5 py-2 font-mono text-gray-700">{s.pattern}</td>
                            <td className="px-4 py-2 text-gray-500 max-w-[180px] truncate" title={s.example_narration}>{s.example_narration}</td>
                            <td className="px-4 py-2">
                              <input
                                value={ledger}
                                onChange={e => setSuggestionOverrides(prev => ({ ...prev, [s.pattern]: e.target.value }))}
                                className="w-full h-7 px-2 rounded border border-gray-200 text-xs focus:outline-none focus:ring-1 focus:ring-purple-400"
                              />
                            </td>
                            <td className="px-4 py-2 text-gray-500 max-w-[200px] italic" title={s.reason}>{s.reason || "—"}</td>
                            <td className="px-4 py-2 text-center">
                              <span className={`text-xs font-medium ${s.confidence >= 80 ? "text-green-600" : s.confidence >= 60 ? "text-amber-600" : "text-gray-400"}`}>
                                {s.confidence}%
                              </span>
                            </td>
                            <td className="px-4 py-2 text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  onClick={() => acceptSuggestion(s.pattern, ledger)}
                                  disabled={acceptingPatterns.has(s.pattern) || !ledger}
                                  className="text-xs px-2.5 py-1 rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
                                >
                                  {acceptingPatterns.has(s.pattern) ? <Loader2 size={10} className="animate-spin" /> : "Accept"}
                                </button>
                                <button
                                  onClick={() => setSuggestions(prev => prev.filter(x => x.pattern !== s.pattern))}
                                  className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-400 hover:text-gray-600"
                                >
                                  Skip
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )}

            {/* Rules columns */}
            {(() => {
              const draftRules  = clientMappingRules.filter(r => !r.confirmed);
              const activeRules = clientMappingRules.filter(r => r.confirmed);
              const q = ruleSearch.toLowerCase();
              const filterRule = (r: MappingRule) =>
                !q || r.pattern.includes(q) || r.ledger_name.toLowerCase().includes(q);
              const filteredDraft    = draftRules.filter(filterRule).sort((a,b) => a.pattern.localeCompare(b.pattern));
              const filteredActive   = activeRules.filter(filterRule).sort((a,b) => a.pattern.localeCompare(b.pattern));
              const filteredIndustry = industryMappingRules.filter(filterRule).sort((a,b) => a.pattern.localeCompare(b.pattern));
              const filteredGlobal   = GLOBAL_RULES_DISPLAY.filter(g =>
                !q || g.label.toLowerCase().includes(q) || g.ledger.toLowerCase().includes(q) || g.examples.toLowerCase().includes(q)
              );

              const EditableText = ({
                ruleId, field, value, className, placeholder,
              }: { ruleId: string; field: "pattern" | "ledger_name"; value: string; className?: string; placeholder?: string }) => {
                const isEditing = editingRuleId === ruleId && editingRuleField === field;
                if (isEditing) {
                  return (
                    <input
                      autoFocus
                      value={editingRuleValue}
                      onChange={e => setEditingRuleValue(e.target.value)}
                      onBlur={() => saveRuleEdit(ruleId)}
                      onKeyDown={e => {
                        if (e.key === "Enter") saveRuleEdit(ruleId);
                        if (e.key === "Escape") { setEditingRuleId(null); setEditingRuleField(null); }
                      }}
                      placeholder={placeholder}
                      className="w-full border border-blue-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                    />
                  );
                }
                return (
                  <span
                    className={`${className} cursor-text hover:bg-blue-50 hover:text-blue-700 rounded px-0.5 transition-colors`}
                    title={`Click to edit ${field === "pattern" ? "pattern" : "ledger"}`}
                    onClick={() => startEdit(ruleId, field, value)}
                  >
                    {value}
                  </span>
                );
              };

              const RuleRow = ({ r, kind }: { r: MappingRule; kind: "draft" | "active" | "industry" }) => (
                <div className="border-b last:border-0 px-3 py-2.5 hover:bg-gray-50/50 group space-y-1">
                  {/* Pattern — primary, prominent, editable */}
                  <EditableText
                    ruleId={r.id} field="pattern" value={r.pattern}
                    className="block font-mono text-xs font-semibold text-gray-700 leading-snug"
                    placeholder="narration keyword"
                  />
                  {/* Ledger — secondary, editable */}
                  <div className="flex items-center gap-1">
                    <span className="text-gray-300 text-[10px]">→</span>
                    <EditableText
                      ruleId={r.id} field="ledger_name" value={r.ledger_name}
                      className="text-[11px] text-gray-600 font-medium"
                      placeholder="ledger name"
                    />
                  </div>
                  {/* Actions row */}
                  <div className="flex items-center justify-between pt-0.5">
                    {kind === "draft" ? (
                      <div className="flex items-center gap-1">
                        <div className="flex gap-0.5">
                          {[1,2,3].map(i => (
                            <div key={i} className={`w-2 h-2 rounded-sm ${i <= (r.match_count ?? 0) ? "bg-amber-400" : "bg-gray-200"}`} />
                          ))}
                        </div>
                        <span className="text-[9px] text-gray-400">{Math.max(0,3-(r.match_count??0))} more</span>
                      </div>
                    ) : (
                      <span className="text-[9px] text-gray-400">{r.match_count} hit{r.match_count !== 1 ? "s" : ""}</span>
                    )}
                    <div className="flex items-center gap-1">
                      {kind === "draft" && (
                        <button onClick={() => toggleRuleConfirmed(r.id, false)}
                          className="text-[9px] px-1.5 py-0.5 rounded border border-green-200 text-green-700 hover:bg-green-50 whitespace-nowrap">
                          Activate
                        </button>
                      )}
                      {kind === "active" && industryNameForRules && (
                        <button onClick={() => promoteToIndustry(r.id)}
                          className="text-[9px] px-1.5 py-0.5 rounded border border-blue-200 text-blue-600 hover:bg-blue-50 whitespace-nowrap">
                          → Ind.
                        </button>
                      )}
                      {kind === "industry" && (
                        <button onClick={() => toggleRuleConfirmed(r.id, r.confirmed)}
                          className={`text-[9px] px-1.5 py-0.5 rounded-full border font-medium ${r.confirmed ? "border-blue-200 text-blue-700 bg-blue-50" : "border-gray-200 text-gray-500"}`}>
                          {r.confirmed ? "On" : "Off"}
                        </button>
                      )}
                      <button onClick={() => deleteMappingRule(r.id)} className="text-gray-200 hover:text-red-400 transition-colors">
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                </div>
              );

              const colCount = industryNameForRules ? 4 : 3;

              return (
                <>
                  {/* Search + summary bar */}
                  <div className="flex items-center gap-3 mb-3">
                    <div className="relative flex-1">
                      <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input
                        value={ruleSearch}
                        onChange={e => setRuleSearch(e.target.value)}
                        placeholder="Search patterns, ledgers, or keywords…"
                        className="w-full pl-7 pr-3 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400"
                      />
                      {ruleSearch && (
                        <button onClick={() => setRuleSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                          <X size={11} />
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] shrink-0">
                      <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-100 font-medium">{draftRules.length} Draft</span>
                      <span className="px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-100 font-medium">{activeRules.length} Active</span>
                      {industryNameForRules && <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-100 font-medium">{industryMappingRules.length} Industry</span>}
                      <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200 font-medium">{GLOBAL_RULES_DISPLAY.length} Global</span>
                    </div>
                  </div>

                  {rulesLoading ? (
                    <div className="py-8 flex items-center justify-center gap-2 text-gray-400 text-sm">
                      <Loader2 size={14} className="animate-spin" /> Loading rules…
                    </div>
                  ) : (
                    <div className={`grid gap-2 grid-cols-${colCount}`} style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}>

                      {/* ── Draft ── */}
                      <div className="border border-amber-200 rounded-lg overflow-hidden flex flex-col">
                        <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 flex items-center gap-1.5 shrink-0">
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                          <span className="text-[11px] font-bold text-amber-800 uppercase tracking-wide">Draft</span>
                          <span className="text-[9px] text-amber-500 ml-auto">needs confirmation</span>
                        </div>
                        <div className="overflow-y-auto flex-1" style={{ maxHeight: 360 }}>
                          {filteredDraft.length === 0 ? (
                            <p className="px-3 py-5 text-[11px] text-gray-400 text-center">{q ? "No matches" : "None yet — assign ledgers to transactions to learn"}</p>
                          ) : filteredDraft.map(r => <RuleRow key={r.id} r={r} kind="draft" />)}
                        </div>
                      </div>

                      {/* ── Active ── */}
                      <div className="border border-green-200 rounded-lg overflow-hidden flex flex-col">
                        <div className="px-3 py-2 bg-green-50 border-b border-green-200 flex items-center gap-1.5 shrink-0">
                          <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                          <span className="text-[11px] font-bold text-green-800 uppercase tracking-wide">Active</span>
                          <span className="text-[9px] text-green-500 ml-auto">auto-applied</span>
                        </div>
                        <div className="overflow-y-auto flex-1" style={{ maxHeight: 360 }}>
                          {filteredActive.length === 0 ? (
                            <p className="px-3 py-5 text-[11px] text-gray-400 text-center">{q ? "No matches" : "None yet — activate a draft rule or assign 3×"}</p>
                          ) : filteredActive.map(r => <RuleRow key={r.id} r={r} kind="active" />)}
                        </div>
                      </div>

                      {/* ── Industry ── */}
                      {industryNameForRules && (
                        <div className="border border-blue-200 rounded-lg overflow-hidden flex flex-col">
                          <div className="px-3 py-2 bg-blue-50 border-b border-blue-200 flex items-center gap-1.5 shrink-0">
                            <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                            <span className="text-[11px] font-bold text-blue-800 uppercase tracking-wide">Industry</span>
                            <span className="text-[9px] text-blue-500 ml-auto truncate">{industryNameForRules}</span>
                          </div>
                          <div className="overflow-y-auto flex-1" style={{ maxHeight: 360 }}>
                            {filteredIndustry.length === 0 ? (
                              <p className="px-3 py-5 text-[11px] text-gray-400 text-center">{q ? "No matches" : "None yet — promote an active rule"}</p>
                            ) : filteredIndustry.map(r => <RuleRow key={r.id} r={r} kind="industry" />)}
                          </div>
                        </div>
                      )}

                      {/* ── Global (read-only reference) ── */}
                      <div className="border border-gray-200 rounded-lg overflow-hidden flex flex-col">
                        <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-1.5 shrink-0">
                          <div className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                          <span className="text-[11px] font-bold text-gray-600 uppercase tracking-wide">Global</span>
                          <span className="text-[9px] text-gray-400 ml-auto">built-in · read-only</span>
                        </div>
                        <div className="overflow-y-auto flex-1" style={{ maxHeight: 360 }}>
                          {filteredGlobal.length === 0 ? (
                            <p className="px-3 py-5 text-[11px] text-gray-400 text-center">No matches</p>
                          ) : filteredGlobal.map(g => (
                            <div key={g.ledger} className="border-b last:border-0 px-3 py-2.5">
                              <div className="text-xs font-semibold text-gray-600 leading-snug">{g.label}</div>
                              <div className="flex items-center gap-1 mt-0.5">
                                <span className="text-gray-300 text-[10px]">→</span>
                                <span className="text-[11px] text-gray-500 font-medium">{g.ledger}</span>
                              </div>
                              <div className="text-[9px] text-gray-400 mt-1 leading-relaxed">{g.examples}</div>
                            </div>
                          ))}
                        </div>
                      </div>

                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── GST FILING TAB ─────────────────────────────────────────────── */}
      {activeTab === "gst" && (
        <div className="space-y-4">
          {/* Period picker + presets + download */}
          <div className="space-y-2">
            {/* Quick preset buttons */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-gray-400 mr-1">Quick:</span>
              {GST_PERIOD_PRESETS.map((p) => {
                const active = gstPeriodFrom === p.from && gstPeriodTo === p.to;
                return (
                  <button key={p.label}
                    onClick={() => { setGstPeriodFrom(p.from); setGstPeriodTo(p.to); loadGstData(p.from, p.to); }}
                    className={`text-xs px-2 py-0.5 rounded border transition-colors ${active
                      ? "bg-blue-600 border-blue-600 text-white"
                      : "border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600"}`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500">Custom:</label>
                <input type="date" value={gstPeriodFrom} onChange={(e) => setGstPeriodFrom(e.target.value)}
                  className="text-xs border border-gray-300 rounded px-2 py-1" />
                <span className="text-xs text-gray-400">to</span>
                <input type="date" value={gstPeriodTo} onChange={(e) => setGstPeriodTo(e.target.value)}
                  className="text-xs border border-gray-300 rounded px-2 py-1" />
                <button onClick={() => loadGstData()}
                  className="text-xs px-2.5 py-1 rounded bg-gray-100 hover:bg-gray-200 border border-gray-300 text-gray-700">
                  Load
                </button>
              </div>
              <a
                href={`/api/v1/clients/${clientId}/gst-filing?from=${gstPeriodFrom}&to=${gstPeriodTo}&format=excel`}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-green-600 text-white hover:bg-green-700"
              >
                <Download size={12} /> Download GST Filing Excel (GSTR-1 + 3B)
              </a>
            </div>
          </div>

          {gstLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 py-8">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading GST data…
            </div>
          ) : !gstData ? (
            <Card>
              <CardContent className="py-12 text-center text-gray-400 text-sm">
                No reviewed invoices found for this period. Upload and review sales/purchase invoices first.
              </CardContent>
            </Card>
          ) : (
            <>
              {/* GSTR-3B Pre-filled Numbers */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-base font-semibold text-gray-900">GSTR-3B Filing Numbers</h2>
                  <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">Copy these into the GST portal</span>
                </div>
                <div className={`grid gap-4 ${gstData.inward_rcm && (gstData.inward_rcm.igst + gstData.inward_rcm.cgst + gstData.inward_rcm.sgst) > 0 ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-3"}`}>
                  {/* 3.1(a) Output Tax */}
                  <Card className="border-blue-200">
                    <CardHeader className="py-2 px-4 border-b bg-blue-50/50">
                      <CardTitle className="text-xs font-semibold text-blue-700 uppercase tracking-wide">3.1(a) — Outward Supplies</CardTitle>
                    </CardHeader>
                    <CardContent className="py-3 px-4 space-y-1.5">
                      {[
                        { label: "Taxable Value", value: gstData.outward_taxable.taxable },
                        { label: "IGST", value: gstData.outward_taxable.igst },
                        { label: "CGST", value: gstData.outward_taxable.cgst },
                        { label: "SGST", value: gstData.outward_taxable.sgst },
                      ].map(({ label, value }) => (
                        <div key={label} className="flex justify-between text-xs">
                          <span className="text-gray-500">{label}</span>
                          <span className="font-mono font-medium text-gray-900">₹{value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                        </div>
                      ))}
                      <div className="border-t pt-1.5 flex justify-between text-xs font-semibold">
                        <span className="text-blue-700">Total Output Tax</span>
                        <span className="font-mono text-blue-700">₹{gstData.total_output.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                      </div>
                    </CardContent>
                  </Card>

                  {/* 3.1(d) Inward RCM — only shown when there are RCM purchases */}
                  {gstData.inward_rcm && (gstData.inward_rcm.igst + gstData.inward_rcm.cgst + gstData.inward_rcm.sgst) > 0 && (
                    <Card className="border-purple-200">
                      <CardHeader className="py-2 px-4 border-b bg-purple-50/50">
                        <CardTitle className="text-xs font-semibold text-purple-700 uppercase tracking-wide">3.1(d) — Inward RCM</CardTitle>
                      </CardHeader>
                      <CardContent className="py-3 px-4 space-y-1.5">
                        <p className="text-[10px] text-gray-400 leading-tight">GTA, security, legal — you pay tax as recipient</p>
                        {[
                          { label: "Taxable Value", value: gstData.inward_rcm.taxable },
                          { label: "IGST", value: gstData.inward_rcm.igst },
                          { label: "CGST", value: gstData.inward_rcm.cgst },
                          { label: "SGST", value: gstData.inward_rcm.sgst },
                        ].map(({ label, value }) => (
                          <div key={label} className="flex justify-between text-xs">
                            <span className="text-gray-500">{label}</span>
                            <span className="font-mono font-medium text-gray-900">₹{value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}

                  {/* 4(A) ITC Available */}
                  <Card className="border-green-200">
                    <CardHeader className="py-2 px-4 border-b bg-green-50/50">
                      <CardTitle className="text-xs font-semibold text-green-700 uppercase tracking-wide">4(A) — ITC Available</CardTitle>
                    </CardHeader>
                    <CardContent className="py-3 px-4 space-y-1.5">
                      {[
                        { label: "IGST", value: gstData.itc_available.igst },
                        { label: "CGST", value: gstData.itc_available.cgst },
                        { label: "SGST", value: gstData.itc_available.sgst },
                      ].map(({ label, value }) => (
                        <div key={label} className="flex justify-between text-xs">
                          <span className="text-gray-500">{label}</span>
                          <span className="font-mono font-medium text-gray-900">₹{value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                        </div>
                      ))}
                      <div className="border-t pt-1.5 flex justify-between text-xs font-semibold">
                        <span className="text-green-700">Total ITC</span>
                        <span className="font-mono text-green-700">₹{gstData.total_itc.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                      </div>
                      <p className="text-[10px] text-gray-400 mt-1">Applied as per Rule 88A order</p>
                    </CardContent>
                  </Card>

                  {/* Net Payable */}
                  <Card className="border-orange-200 bg-orange-50/20">
                    <CardHeader className="py-2 px-4 border-b bg-orange-50/50">
                      <CardTitle className="text-xs font-semibold text-orange-700 uppercase tracking-wide">Net Tax Payable</CardTitle>
                    </CardHeader>
                    <CardContent className="py-3 px-4 space-y-1.5">
                      {[
                        { label: "IGST Payable", value: gstData.net_payable.igst },
                        { label: "CGST Payable", value: gstData.net_payable.cgst },
                        { label: "SGST Payable", value: gstData.net_payable.sgst },
                      ].map(({ label, value }) => (
                        <div key={label} className="flex justify-between text-xs">
                          <span className="text-gray-500">{label}</span>
                          <span className="font-mono font-medium text-gray-900">₹{value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                        </div>
                      ))}
                      <div className="border-t pt-1.5 flex justify-between text-sm font-bold">
                        <span className="text-orange-700">TOTAL PAYABLE</span>
                        <span className="font-mono text-orange-700">₹{gstData.total_net_payable.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>

              {/* What's in the Excel */}
              <Card className="border-dashed">
                <CardContent className="py-4 px-5">
                  <p className="text-xs font-medium text-gray-600 mb-2">The Excel download contains 6 sheets:</p>
                  <div className="grid grid-cols-3 gap-2 text-xs text-gray-500">
                    {[
                      ["GSTR-3B Summary", "Pre-filled filing numbers for the GST portal"],
                      ["GSTR-1 B2B", "Invoice-wise list for registered buyers (with GSTIN)"],
                      ["GSTR-1 B2C Large", "Interstate invoices > ₹2.5L without GSTIN"],
                      ["GSTR-1 B2C Small", "Aggregated rate-wise totals for small B2C"],
                      ["HSN Summary", "HSN/SAC-wise summary (GSTR-1 Table 12)"],
                      ["ITC Register", "Purchase invoices with eligible input tax credit"],
                    ].map(([title, desc]) => (
                      <div key={title} className="flex gap-1.5">
                        <span className="text-green-500 mt-0.5">▸</span>
                        <div>
                          <p className="font-medium text-gray-700">{title}</p>
                          <p className="text-gray-400">{desc}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}

      {/* ── EXPECTED INVOICES TAB ──────────────────────────────────────── */}
      {activeTab === "expected" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Clock size={16} /> Expected Invoices — Pending from Client
              </CardTitle>
              <p className="text-sm text-gray-500">Track invoices you&apos;re waiting for. Mark as received when uploaded.</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Add form */}
              <div className="grid grid-cols-4 gap-2 p-3 rounded-lg bg-gray-50 border border-gray-200">
                <div>
                  <label className="text-xs text-gray-500 font-medium">Vendor Name *</label>
                  <input value={newExpVendor} onChange={e => setNewExpVendor(e.target.value)}
                    placeholder="e.g. Reliance Jio"
                    className="mt-1 w-full text-sm px-2 py-1.5 rounded border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-medium">Approx Amount (₹)</label>
                  <input type="number" value={newExpAmount} onChange={e => setNewExpAmount(e.target.value)}
                    placeholder="Optional"
                    className="mt-1 w-full text-sm px-2 py-1.5 rounded border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-medium">Expected by</label>
                  <input type="date" value={newExpDate} onChange={e => setNewExpDate(e.target.value)}
                    className="mt-1 w-full text-sm px-2 py-1.5 rounded border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div className="flex items-end">
                  <button onClick={addExpected} disabled={addingExpected || !newExpVendor.trim()}
                    className="w-full text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                    {addingExpected ? "Adding…" : "+ Add"}
                  </button>
                </div>
              </div>

              {expectedLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </div>
              ) : expectedInvoices.length === 0 ? (
                <div className="text-center py-8 text-sm text-gray-400">
                  No expected invoices. Add one above when you&apos;re waiting for an invoice from a vendor.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-gray-400 uppercase">
                      <th className="text-left py-2 px-3 font-medium">Vendor</th>
                      <th className="text-right py-2 px-3 font-medium">Amount</th>
                      <th className="text-left py-2 px-3 font-medium">Expected by</th>
                      <th className="text-left py-2 px-3 font-medium">Status</th>
                      <th className="text-right py-2 px-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expectedInvoices.map((ei) => {
                      const isOverdue = ei.status === "pending" && ei.expected_by && new Date(ei.expected_by) < new Date();
                      return (
                        <tr key={ei.id} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-2.5 px-3 font-medium text-gray-900">{ei.vendor_name}</td>
                          <td className="py-2.5 px-3 text-right text-gray-700">
                            {ei.approx_amount ? `₹${ei.approx_amount.toLocaleString("en-IN")}` : "—"}
                          </td>
                          <td className={`py-2.5 px-3 text-xs ${isOverdue ? "text-red-600 font-medium" : "text-gray-500"}`}>
                            {ei.expected_by ? new Date(ei.expected_by).toLocaleDateString("en-IN", { day:"2-digit", month:"short" }) : "—"}
                            {isOverdue && " (overdue)"}
                          </td>
                          <td className="py-2.5 px-3">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                              ei.status === "received" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"
                            }`}>{ei.status === "received" ? "Received" : "Pending"}</span>
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {ei.status === "pending" && (
                                <button onClick={() => updateExpected(ei.id, "received")}
                                  className="text-xs px-2 py-0.5 rounded bg-green-50 text-green-700 hover:bg-green-100">
                                  Mark received
                                </button>
                              )}
                              <button onClick={() => updateExpected(ei.id, "delete")}
                                className="text-xs px-2 py-0.5 rounded bg-red-50 text-red-600 hover:bg-red-100">
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Wipe bank data — two-step confirm (type WIPE) */}
      <ConfirmDialog
        open={wipeDialogOpen}
        onOpenChange={setWipeDialogOpen}
        title="Wipe all bank transactions?"
        description="This will delete every bank transaction and reconciliation match for this client. The data cannot be recovered. Only do this if you need to re-upload a corrected bank statement."
        confirmWord="WIPE"
        confirmLabel="Wipe all transactions"
        loading={wipingBank}
        onConfirm={doWipeBankData}
        variant="danger"
      />

      {/* Archive document — single confirm (soft delete, retained for compliance) */}
      <ConfirmDialog
        open={!!deleteDocTarget}
        onOpenChange={(open) => { if (!open) setDeleteDocTarget(null); }}
        title={`Archive "${deleteDocTarget?.fileName}"?`}
        description="This document will be removed from your active workspace. It is retained permanently in our records as required by CGST Act Section 35 (6-year retention). Contact support to recover it."
        confirmLabel="Archive document"
        loading={!!deleting}
        onConfirm={() => deleteDocTarget && performDeleteDocument(deleteDocTarget.id, deleteDocTarget.fileName)}
        variant="warning"
      />

      {/* Bank book import modal — two-file matching flow */}
      {bbImportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Import Historical Bank Data</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Match previous year bank statement against bank book to auto-learn ledger mapping rules
                </p>
              </div>
              <button onClick={() => setBbImportOpen(false)} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
            </div>

            {/* Step indicator */}
            <div className="flex border-b px-6 flex-shrink-0">
              {(["upload","columns","review"] as const).map((s, i) => (
                <div key={s} className={`flex items-center gap-1.5 text-xs py-2.5 mr-6 border-b-2 -mb-px font-medium ${bbStep === s ? "border-purple-600 text-purple-700" : "border-transparent text-gray-400"}`}>
                  <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${bbStep === s ? "bg-purple-600 text-white" : "bg-gray-200 text-gray-500"}`}>{i+1}</span>
                  {s === "upload" ? "Upload files" : s === "columns" ? "Map columns" : "Review & confirm"}
                </div>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">

              {/* ── Step 1: upload ── */}
              {bbStep === "upload" && (
                <div className="space-y-5">
                  <div className="p-4 bg-purple-50 rounded-lg border border-purple-100 text-xs text-purple-800 space-y-1">
                    <p className="font-semibold text-sm text-purple-900">How this works</p>
                    <p>Upload a past year&apos;s bank statement (from your bank) <strong>and</strong> the bank book (from Tally) for the <em>same period</em>. The system matches transactions by date &amp; amount, learns which bank narration maps to which ledger name, and creates rules automatically.</p>
                    <p className="text-purple-600 mt-1">You can repeat this for multiple financial years — more history = more accurate auto-classification.</p>
                  </div>

                  {/* Financial year picker */}
                  <div className="flex items-center gap-3">
                    <label className="text-xs font-semibold text-gray-700 whitespace-nowrap">Financial Year</label>
                    <div className="flex gap-2">
                      {(() => {
                        const now = new Date();
                        const baseYr = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
                        return [0, 1, 2].map(offset => {
                          const yr = baseYr - offset;
                          const label = `FY ${yr}-${String(yr + 1).slice(-2)}`;
                          const value = `${yr}-${String(yr + 1).slice(-2)}`;
                          return (
                            <button key={value} onClick={() => setBbFinancialYear(value)}
                              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                                bbFinancialYear === value
                                  ? "bg-purple-600 text-white border-purple-600"
                                  : "border-gray-200 text-gray-600 hover:border-purple-300"
                              }`}>
                              {label}
                            </button>
                          );
                        });
                      })()}
                    </div>
                    <span className="text-[11px] text-gray-400">Select the year these files are from</span>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Bank statement */}
                    <div className="border rounded-lg p-4 space-y-2">
                      <p className="text-xs font-semibold text-gray-700">1. Bank Statement <span className="text-gray-400 font-normal">(from bank portal)</span></p>
                      <p className="text-[11px] text-gray-400">Has: Date, Narration (bank text), Debit, Credit</p>
                      <input ref={stmtFileRef} type="file" accept=".xlsx,.xls,.csv,.pdf"
                        className="block w-full text-xs text-gray-500 file:mr-2 file:py-1 file:px-2 file:rounded file:border file:border-gray-200 file:text-xs file:bg-white hover:file:bg-gray-50"
                        onChange={e => setStmtFileObj(e.target.files?.[0] ?? null)} />
                      {stmtFileObj && (
                        <p className="text-[11px] text-purple-600">
                          {stmtFileObj.name}
                          {stmtFileObj.name.toLowerCase().endsWith(".pdf") && (
                            <span className="ml-1 text-amber-600">(AI extraction — may take ~30s)</span>
                          )}
                        </p>
                      )}
                    </div>
                    {/* Bank book */}
                    <div className="border rounded-lg p-4 space-y-2">
                      <p className="text-xs font-semibold text-gray-700">2. Bank Book <span className="text-gray-400 font-normal">(Tally export)</span></p>
                      <p className="text-[11px] text-gray-400">Has: Date, Particulars (CA ledger name), Debit, Credit</p>
                      <input ref={bbFileRef} type="file" accept=".xlsx,.xls,.csv"
                        className="block w-full text-xs text-gray-500 file:mr-2 file:py-1 file:px-2 file:rounded file:border file:border-gray-200 file:text-xs file:bg-white hover:file:bg-gray-50"
                        onChange={e => setBbFileObj(e.target.files?.[0] ?? null)} />
                      {bbFileObj && <p className="text-[11px] text-purple-600">{bbFileObj.name}</p>}
                    </div>
                  </div>

                  <button disabled={!bbFileObj || !stmtFileObj || bbUploading} onClick={() => submitBbFiles()}
                    className="px-5 py-2 rounded-md bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 disabled:opacity-50 inline-flex items-center gap-2">
                    {bbUploading ? <><Loader2 size={14} className="animate-spin" /> Matching transactions…</> : `Analyse FY ${bbFinancialYear}`}
                  </button>
                </div>
              )}

              {/* ── Step 2: column mapping ── */}
              {bbStep === "columns" && bbColsNeeded && (
                <div className="space-y-5">
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                    <AlertTriangle size={12} className="inline mr-1" />
                    Some column headers weren&apos;t recognised automatically. Map them below.
                  </div>

                  {/* Bank statement columns */}
                  {!bbColsNeeded.stmt_confident && (
                    <div>
                      <p className="text-xs font-semibold text-gray-700 mb-2">Bank Statement columns</p>
                      <div className="overflow-x-auto mb-3">
                        <table className="w-full text-xs border border-gray-200 rounded">
                          <thead className="bg-gray-50"><tr>{bbColsNeeded.stmt_raw_headers.map(h => <th key={h} className="px-2 py-1.5 text-left font-medium text-gray-500 border-b whitespace-nowrap">{h}</th>)}</tr></thead>
                          <tbody>{bbColsNeeded.stmt_preview.slice(0,2).map((row,i)=><tr key={i} className="border-b">{bbColsNeeded.stmt_raw_headers.map(h=><td key={h} className="px-2 py-1 text-gray-600 truncate max-w-[100px]">{row[h]}</td>)}</tr>)}</tbody>
                        </table>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {([["Date", stmtColDate, setStmtColDate],["Narration", stmtColNarration, setStmtColNarration],["Debit", stmtColDebit, setStmtColDebit],["Credit", stmtColCredit, setStmtColCredit]] as [string,string,(v:string)=>void][]).map(([label,val,set])=>(
                          <div key={label}><label className="text-[11px] font-medium text-gray-500 mb-0.5 block">{label}</label>
                            <select value={val} onChange={e=>set(e.target.value)} className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-purple-400">
                              <option value="">— select —</option>
                              {bbColsNeeded.stmt_raw_headers.map(h=><option key={h} value={h}>{h}</option>)}
                            </select>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Bank book columns */}
                  {!bbColsNeeded.bb_confident && (
                    <div>
                      <p className="text-xs font-semibold text-gray-700 mb-2">Bank Book columns</p>
                      <div className="overflow-x-auto mb-3">
                        <table className="w-full text-xs border border-gray-200 rounded">
                          <thead className="bg-gray-50"><tr>{bbColsNeeded.bb_raw_headers.map(h => <th key={h} className="px-2 py-1.5 text-left font-medium text-gray-500 border-b whitespace-nowrap">{h}</th>)}</tr></thead>
                          <tbody>{bbColsNeeded.bb_preview.slice(0,2).map((row,i)=><tr key={i} className="border-b">{bbColsNeeded.bb_raw_headers.map(h=><td key={h} className="px-2 py-1 text-gray-600 truncate max-w-[100px]">{row[h]}</td>)}</tr>)}</tbody>
                        </table>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {([["Date", bbColDate, setBbColDate],["Particulars", bbColParticulars, setBbColParticulars],["Debit", bbColDebit, setBbColDebit],["Credit", bbColCredit, setBbColCredit]] as [string,string,(v:string)=>void][]).map(([label,val,set])=>(
                          <div key={label}><label className="text-[11px] font-medium text-gray-500 mb-0.5 block">{label}</label>
                            <select value={val} onChange={e=>set(e.target.value)} className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-purple-400">
                              <option value="">— select —</option>
                              {bbColsNeeded.bb_raw_headers.map(h=><option key={h} value={h}>{h}</option>)}
                            </select>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <button
                    disabled={bbUploading}
                    onClick={() => submitBbFiles({ bb_date: bbColDate||undefined, bb_particulars: bbColParticulars||undefined, bb_debit: bbColDebit||undefined, bb_credit: bbColCredit||undefined, stmt_date: stmtColDate||undefined, stmt_narration: stmtColNarration||undefined, stmt_debit: stmtColDebit||undefined, stmt_credit: stmtColCredit||undefined })}
                    className="px-4 py-2 rounded-md bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 disabled:opacity-50 inline-flex items-center gap-2">
                    {bbUploading ? <><Loader2 size={14} className="animate-spin" /> Re-analysing…</> : "Analyse with these columns"}
                  </button>
                </div>
              )}

              {/* ── Step 3: review ── */}
              {bbStep === "review" && bbResult && (
                <div className="space-y-5">
                  {/* Stats bar */}
                  <div className="grid grid-cols-4 gap-3">
                    {[
                      { label: "Bank book rows", value: bbResult.total_bb_rows, cls: "text-gray-700" },
                      { label: "Matched (rules)", value: bbResult.matched_count, cls: "text-green-700" },
                      { label: "Needs attention", value: bbResult.ambiguous_count, cls: "text-amber-700" },
                      { label: "No match", value: bbResult.unmatched_count, cls: "text-gray-400" },
                    ].map(({ label, value, cls }) => (
                      <div key={label} className="bg-gray-50 rounded-lg px-3 py-2 text-center">
                        <p className={`text-lg font-bold ${cls}`}>{value}</p>
                        <p className="text-[11px] text-gray-400 mt-0.5">{label}</p>
                      </div>
                    ))}
                  </div>

                  {/* Auto rules — green */}
                  {bbResult.rule_candidates.filter(c=>c.status==="auto").length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">✓ Auto rules — {bbResult.rule_candidates.filter(c=>c.status==="auto").length}</span>
                        <span className="text-xs text-gray-400">Created automatically — no action needed</span>
                      </div>
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {bbResult.rule_candidates.filter(c=>c.status==="auto").map(c => (
                          <div key={c.pattern} className="flex items-center gap-2 text-xs px-3 py-1.5 bg-green-50 rounded border border-green-100">
                            <span className="text-gray-500 truncate flex-1" title={c.sample_narration}>{c.sample_narration}</span>
                            <span className="text-gray-300 flex-shrink-0">→</span>
                            <span className="text-green-700 font-medium flex-shrink-0">{c.ledger_name}</span>
                            <span className="text-gray-400 flex-shrink-0 ml-1">{c.occurrences}×</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Ambiguous — CA picks the correct statement row */}
                  {bbResult.ambiguous.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-semibold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">⚠ Multiple matches — pick one for each</span>
                      </div>
                      <div className="space-y-3">
                        {bbResult.ambiguous.map(amb => {
                          const key = amb.bb_row.particulars + amb.bb_row.date;
                          return (
                            <div key={key} className="border border-amber-200 rounded-lg p-3 bg-amber-50/50">
                              <div className="flex items-center gap-2 mb-2">
                                <span className="text-xs font-medium text-gray-700">Bank book:</span>
                                <span className="text-xs text-gray-800 font-semibold">{amb.bb_row.particulars}</span>
                                <span className="text-xs text-gray-400">{amb.bb_row.date} · ₹{((amb.bb_row.debit ?? amb.bb_row.credit) ?? 0).toLocaleString("en-IN")}</span>
                              </div>
                              <p className="text-[11px] text-amber-700 mb-2">{amb.candidates.length} bank statement rows match by date &amp; amount — which one is this?</p>
                              <div className="space-y-1">
                                {amb.candidates.map((cand, ci) => (
                                  <label key={ci} className="flex items-center gap-2 cursor-pointer text-xs px-2 py-1.5 rounded border border-transparent hover:border-amber-300 hover:bg-white">
                                    <input type="radio" name={key} value={cand.narration}
                                      checked={bbAmbiguousSelections[key] === cand.narration}
                                      onChange={() => setBbAmbiguousSelections(prev => ({ ...prev, [key]: cand.narration }))}
                                      className="flex-shrink-0" />
                                    <span className="text-gray-700 truncate">{cand.narration}</span>
                                    <span className="text-gray-400 flex-shrink-0 ml-auto">{cand.date}</span>
                                  </label>
                                ))}
                                <label className="flex items-center gap-2 cursor-pointer text-xs px-2 py-1 rounded text-gray-400 hover:text-gray-600">
                                  <input type="radio" name={key} value="__skip__"
                                    checked={bbAmbiguousSelections[key] === "__skip__" || !bbAmbiguousSelections[key]}
                                    onChange={() => setBbAmbiguousSelections(prev => ({ ...prev, [key]: "__skip__" }))}
                                    className="flex-shrink-0" />
                                  Skip this one
                                </label>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Conflicted — same narration pattern mapped to 2 different ledgers */}
                  {bbResult.rule_candidates.filter(c=>c.status==="conflicted").length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-semibold text-red-700 bg-red-100 px-2 py-0.5 rounded-full">⚑ Conflicted — pick one ledger</span>
                        <span className="text-xs text-gray-400">Same narration pattern mapped to different ledgers in your bank book</span>
                      </div>
                      <div className="space-y-2">
                        {bbResult.rule_candidates.filter(c=>c.status==="conflicted").map(c => (
                          <div key={c.pattern} className="border border-red-200 rounded-lg px-3 py-2 bg-red-50/30">
                            <p className="text-xs text-gray-600 mb-1.5 truncate" title={c.sample_narration}>{c.sample_narration}</p>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-gray-500">Use ledger:</span>
                              <select value={bbConflictOverrides[c.pattern] ?? ""}
                                onChange={e => setBbConflictOverrides(prev => ({ ...prev, [c.pattern]: e.target.value }))}
                                className="text-xs border border-red-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-red-400 flex-1">
                                <option value="">— skip —</option>
                                {(c.conflict_ledgers ?? []).map(l => <option key={l} value={l}>{l}</option>)}
                              </select>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Unmatched — informational only */}
                  {bbResult.unmatched_bb.length > 0 && (
                    <details className="group">
                      <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600 flex items-center gap-1">
                        <ChevronRight size={12} className="group-open:rotate-90 transition-transform" />
                        {bbResult.unmatched_count} bank book rows had no matching statement row — skipped
                      </summary>
                      <div className="mt-2 space-y-0.5 pl-4">
                        {bbResult.unmatched_bb.slice(0,10).map((row,i) => (
                          <p key={i} className="text-[11px] text-gray-400">{row.date} · {row.particulars} · ₹{((row.debit ?? row.credit) ?? 0).toLocaleString("en-IN")}</p>
                        ))}
                        {bbResult.unmatched_count > 10 && <p className="text-[11px] text-gray-400">…and {bbResult.unmatched_count - 10} more</p>}
                      </div>
                    </details>
                  )}

                  {bbResult.matched_count === 0 && bbResult.ambiguous_count === 0 && (
                    <div className="text-center py-6 text-sm text-gray-400">
                      No matches found. Check that both files are for the same account and period.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            {bbStep === "review" && bbResult && (
              <div className="px-6 py-4 border-t flex-shrink-0 flex items-center justify-between">
                <p className="text-xs text-gray-400">
                  {bbResult.rule_candidates.filter(c=>c.status==="auto").length} auto rules
                  {bbResult.ambiguous.filter(a=>bbAmbiguousSelections[a.bb_row.particulars+a.bb_row.date] && bbAmbiguousSelections[a.bb_row.particulars+a.bb_row.date]!=="__skip__").length > 0 && ` + ${bbResult.ambiguous.filter(a=>bbAmbiguousSelections[a.bb_row.particulars+a.bb_row.date] && bbAmbiguousSelections[a.bb_row.particulars+a.bb_row.date]!=="__skip__").length} confirmed`}
                </p>
                <div className="flex gap-3">
                  <button onClick={() => { setBbImportOpen(false); bbReset(); }} className="text-sm px-4 py-2 rounded border border-gray-200 text-gray-600 hover:bg-gray-50">Cancel</button>
                  <button onClick={confirmBbRules} disabled={bbConfirming || bbResult.matched_count === 0}
                    className="text-sm px-4 py-2 rounded bg-purple-600 text-white font-medium hover:bg-purple-700 disabled:opacity-50 inline-flex items-center gap-2">
                    {bbConfirming ? <><Loader2 size={14} className="animate-spin" /> Creating rules…</> : "Create rules"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Simple markdown → JSX renderer supporting headings, lists, tables, bold, italic
function SummaryRenderer({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];
  let tableLines: string[] = [];

  function renderInline(text: string) {
    // Escape HTML first to prevent XSS from AI-generated content
    const safe = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
    return safe
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, "<code class='bg-gray-100 px-1 rounded text-xs font-mono'>$1</code>");
  }

  function flushList() {
    if (listItems.length === 0) return;
    elements.push(
      <ul key={`ul-${elements.length}`} className="list-disc pl-5 space-y-0.5 my-2">
        {listItems.map((li, i) => <li key={i} className="text-sm text-gray-700" dangerouslySetInnerHTML={{ __html: renderInline(li) }} />)}
      </ul>
    );
    listItems = [];
  }

  function flushTable() {
    if (tableLines.length < 2) { tableLines = []; return; }
    const parseRow = (row: string) => row.split("|").map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
    const headers = parseRow(tableLines[0]);
    const body = tableLines.slice(2); // skip separator row
    elements.push(
      <div key={`tbl-${elements.length}`} className="overflow-x-auto my-3">
        <table className="w-full text-xs border border-gray-200 rounded">
          <thead className="bg-gray-50">
            <tr>
              {headers.map((h, i) => (
                <th key={i} className="px-3 py-2 text-left font-semibold text-gray-700 border-b border-gray-200"
                  dangerouslySetInnerHTML={{ __html: renderInline(h) }} />
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                {parseRow(row).map((cell, ci) => (
                  <td key={ci} className="px-3 py-1.5 border-b border-gray-100 text-gray-700"
                    dangerouslySetInnerHTML={{ __html: renderInline(cell) }} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    tableLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableRow = line.trim().startsWith("|") && line.trim().endsWith("|");

    if (isTableRow) {
      flushList();
      tableLines.push(line);
    } else if (line.startsWith("## ")) {
      flushList(); flushTable();
      elements.push(<h2 key={i} className="text-base font-semibold text-gray-900 mt-5 mb-2 border-b pb-1">{line.slice(3)}</h2>);
    } else if (line.startsWith("### ")) {
      flushList(); flushTable();
      elements.push(<h3 key={i} className="text-sm font-semibold text-gray-800 mt-3 mb-1">{line.slice(4)}</h3>);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      flushTable();
      listItems.push(line.slice(2));
    } else if (line.startsWith("---")) {
      flushList(); flushTable();
      elements.push(<hr key={i} className="border-gray-200 my-3" />);
    } else if (line.trim() === "") {
      flushList(); flushTable();
    } else {
      flushList(); flushTable();
      elements.push(<p key={i} className="text-sm text-gray-700 leading-relaxed my-1.5" dangerouslySetInnerHTML={{ __html: renderInline(line) }} />);
    }
  }
  flushList();
  flushTable();
  return <div>{elements}</div>;
}

function LedgerCell({ txnId, narration, value, ledgers, similarCount, onSave, onBulkApply }: {
  txnId: string;
  narration: string;
  value: string | null | undefined;
  ledgers: { id: string; ledger_name: string; ledger_type: string }[];
  similarCount: number; // unassigned txns with same pattern (excluding self)
  onSave: (txnId: string, value: string) => Promise<{ pattern?: string }>;
  onBulkApply: (pattern: string, ledgerName: string) => Promise<void>;
}) {
  const [editing, setEditing]       = useState(false);
  const [saving, setSaving]         = useState(false);
  const [search, setSearch]         = useState("");
  const [bulkPattern, setBulkPattern] = useState<string | null>(null);
  const [bulkLedger, setBulkLedger]   = useState<string | null>(null);
  const [bulkApplying, setBulkApplying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Compute fuzzy suggestions only when dropdown opens, memoised on narration+ledgers
  const suggestions = useMemo(() => {
    if (!editing) return [];
    return fuzzyMatchLedgers(narration ?? "", ledgers, 6);
  }, [editing, narration, ledgers]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return ledgers;
    return ledgers.filter((l) =>
      l.ledger_name.toLowerCase().includes(q) || l.ledger_type.toLowerCase().includes(q)
    );
  }, [search, ledgers]);

  async function pick(ledgerName: string) {
    setEditing(false);
    setSearch("");
    if (ledgerName === value) return;
    setSaving(true);
    const result = await onSave(txnId, ledgerName);
    setSaving(false);
    if (result?.pattern && similarCount > 0) {
      setBulkPattern(result.pattern);
      setBulkLedger(ledgerName);
    }
  }

  async function applyBulk() {
    if (!bulkPattern || !bulkLedger) return;
    setBulkApplying(true);
    await onBulkApply(bulkPattern, bulkLedger);
    setBulkApplying(false);
    setBulkPattern(null);
    setBulkLedger(null);
  }

  if (saving) return <span className="text-xs text-gray-400 italic">Saving…</span>;

  return (
    <div className="relative">
      {/* Value button */}
      <button onClick={() => { setEditing(true); setTimeout(() => inputRef.current?.focus(), 50); }}
        className={`group inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded max-w-[180px] truncate ${
          value ? "bg-green-50 text-green-800 hover:opacity-80" : "bg-amber-50 text-amber-700 hover:opacity-80 italic"
        }`}>
        <span className="truncate">{value ?? "Set ledger"}</span>
        <Pencil size={9} className="flex-shrink-0 opacity-0 group-hover:opacity-60" />
      </button>

      {/* Bulk apply prompt */}
      {bulkPattern && bulkLedger && !editing && (
        <div className="mt-1 flex items-center gap-1.5 text-xs bg-blue-50 border border-blue-200 rounded px-2 py-1">
          <span className="text-blue-700 font-medium">{similarCount} more</span>
          <span className="text-blue-600">same pattern — apply?</span>
          <button
            onClick={applyBulk}
            disabled={bulkApplying}
            className="ml-1 text-xs font-semibold text-blue-700 hover:text-blue-900 disabled:opacity-50 flex items-center gap-0.5"
          >
            {bulkApplying ? <><Loader2 size={9} className="animate-spin" /> Applying…</> : "Apply all"}
          </button>
          <button onClick={() => { setBulkPattern(null); setBulkLedger(null); }} className="text-gray-400 hover:text-gray-600 ml-1">
            <X size={10} />
          </button>
        </div>
      )}

      {/* Dropdown */}
      {editing && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-10" onClick={() => { setEditing(false); setSearch(""); }} />
          <div className="absolute left-0 top-full mt-1 z-20 w-72 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
            {/* Search */}
            <div className="p-2 border-b border-gray-100">
              <input
                ref={inputRef}
                type="text"
                placeholder="Search ledgers…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setEditing(false); setSearch(""); }
                  if (e.key === "Enter" && filtered.length === 1) pick(filtered[0].ledger_name);
                }}
                className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>

            <div className="max-h-72 overflow-y-auto">
              {/* Fuzzy suggestions — only show when not searching */}
              {!search && suggestions.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100 flex items-center gap-1">
                    <Search size={9} /> Best matches for this narration
                  </div>
                  {suggestions.map((s) => (
                    <button
                      key={s.ledger_name}
                      onClick={() => pick(s.ledger_name)}
                      className="w-full text-left px-3 py-2 hover:bg-blue-50 flex items-center justify-between group border-b border-gray-50 last:border-0"
                    >
                      <div>
                        <span className="text-xs font-medium text-gray-800">{s.ledger_name}</span>
                        {s.matchedTokens.length > 0 && (
                          <div className="flex gap-1 mt-0.5">
                            {s.matchedTokens.map((t) => (
                              <span key={t} className="text-[10px] px-1 py-0 rounded bg-blue-100 text-blue-700">{t}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className="text-[10px] text-gray-400 flex-shrink-0 ml-2">{s.ledger_type.replace(/_/g, " ")}</span>
                    </button>
                  ))}
                  <div className="border-t border-dashed border-gray-200 my-1" />
                </div>
              )}

              {/* All / filtered ledgers */}
              {!search && (
                <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100">
                  All ledgers ({ledgers.length})
                </div>
              )}
              {filtered.length === 0 ? (
                <p className="text-xs text-gray-400 px-3 py-3">No ledgers match "{search}"</p>
              ) : (
                filtered.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => pick(l.ledger_name)}
                    className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center justify-between text-xs"
                  >
                    <span className={`truncate ${l.ledger_name === value ? "font-semibold text-green-700" : "text-gray-700"}`}>{l.ledger_name}</span>
                    <span className="text-[10px] text-gray-400 flex-shrink-0 ml-2">{l.ledger_type.replace(/_/g, " ")}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
