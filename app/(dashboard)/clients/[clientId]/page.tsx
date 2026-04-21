"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Building2, ChevronLeft, FileText, Loader2, Upload,
  CheckCircle2, AlertTriangle, Clock, RefreshCw, Landmark,
  Link2, Link2Off, X, Pencil, BookOpen, Download, Plus, Trash2,
  ShoppingCart, Receipt, Wallet, CreditCard, FolderOpen, ScrollText,
  BarChart3, ChevronDown, ChevronRight, ExternalLink
} from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";
import { toast } from "sonner";

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
  total_amount: string | null;
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
  // match reasoning (only present for matched/possible_match)
  match_score?: number | null;
  match_reasons?: string[] | null;
  matched_invoice_number?: string | null;
  matched_doc_filename?: string | null;
}

interface BankSummary {
  total: number;
  total_debit: number;
  total_credit: number;
  matched: number;
  unmatched: number;
}

interface ReconDoc {
  id: string;
  original_filename: string;
  document_type: string;
  status?: string;
  total_amount?: string | null;
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
}

interface ReconData {
  summary: { matched: number; possible: number; exceptions: number; unmatched_transactions: number; unresolved: number; categorized_no_invoice: number; unmatched_invoices: number; total_bank_transactions: number; explained: number };
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
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retagging, setRetagging] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"documents" | "bank" | "reconciliation" | "ledgers" | "gst" | "expected" | "summary" | "ledger_view">("documents");
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
  const [showCategorised, setShowCategorised] = useState(false);
  const [reconTab, setReconTab] = useState<"matched" | "possible" | "unmatched">("unmatched");
  const [reconFilter, setReconFilter] = useState("");
  const [bankFilter, setBankFilter] = useState("");
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

  // Ledger master state
  const [ledgers, setLedgers] = useState<{ id: string; ledger_name: string; ledger_type: string }[]>([]);
  const [ledgersLoading, setLedgersLoading] = useState(false);
  const [newLedgerName, setNewLedgerName] = useState("");
  const [newLedgerType, setNewLedgerType] = useState("expense");
  const [addingLedger, setAddingLedger] = useState(false);
  const [seedingLedgers, setSeedingLedgers] = useState(false);
  const [reapplying, setReapplying] = useState(false);
  const [importingLedgers, setImportingLedgers] = useState(false);
  const ledgerImportRef = useRef<HTMLInputElement>(null);

  // Ledger mapping rules state
  interface MappingRule {
    id: string; client_id: string | null; industry_name: string | null;
    pattern: string; ledger_name: string; match_count: number; confirmed: boolean; updated_at: string;
  }
  const [clientMappingRules, setClientMappingRules] = useState<MappingRule[]>([]);
  const [industryMappingRules, setIndustryMappingRules] = useState<MappingRule[]>([]);
  const [industryNameForRules, setIndustryNameForRules] = useState<string | null>(null);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [newRulePattern, setNewRulePattern] = useState("");
  const [newRuleLedger, setNewRuleLedger] = useState("");
  const [newRuleScope, setNewRuleScope] = useState<"client" | "industry">("client");
  const [addingRule, setAddingRule] = useState(false);

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
    itc_available: { igst: number; cgst: number; sgst: number };
    output_tax: { igst: number; cgst: number; sgst: number };
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

  function loadGstData() {
    setGstLoading(true);
    fetch(`/api/v1/clients/${clientId}/gst-filing?from=${gstPeriodFrom}&to=${gstPeriodTo}`)
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
        setBankUploadMsg({ type: "success", text: `Done — ${d.inserted ?? 0} new transactions added.` });
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
      .then((r) => r.json())
      .then((d) => {
        setClientMappingRules(d.client_rules ?? []);
        setIndustryMappingRules(d.industry_rules ?? []);
        setIndustryNameForRules(d.industry_name ?? null);
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

  async function importLedgers(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportingLedgers(true);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/v1/clients/${clientId}/ledgers/import`, { method: "POST", body: fd });
    const d = await res.json();
    if (res.ok) {
      toast.success(`Imported ${d.imported} ledgers${d.skipped > 0 ? ` (${d.skipped} skipped)` : ""}`);
      loadLedgers();
    } else {
      toast.error(d.error ?? "Could not import ledgers");
    }
    setImportingLedgers(false);
  }

  useEffect(() => { loadData(); loadRecon(); }, [clientId]);
  useEffect(() => { if (activeTab === "bank") { loadBankTxns(); loadLedgers(); } }, [activeTab, clientId]);
  useEffect(() => { if (activeTab === "reconciliation") loadRecon(); }, [activeTab, clientId]);
  useEffect(() => { if (activeTab === "ledger_view" && !ledgerData) loadLedger(ledgerFromDate || undefined, ledgerToDate || undefined); }, [activeTab, clientId]);
  useEffect(() => { if (activeTab === "ledgers") { loadLedgers(); loadMappingRules(); } }, [activeTab, clientId]);
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

  async function deleteDocument(docId: string, fileName: string) {
    if (!window.confirm(`Delete "${fileName}"?\n\nThis will permanently remove the document and all extracted fields. This cannot be undone.`)) return;
    setDeleting(docId);
    try {
      const res = await fetch(`/api/v1/documents/${docId}`, { method: "DELETE" });
      if (res.ok) {
        setDocuments((prev) => prev.filter((d) => d.id !== docId));
        toast.success(`"${fileName}" deleted.`);
      } else {
        const data = await res.json();
        toast.error(data.error ?? "Delete failed.");
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
              <h1 className="text-xl font-semibold text-gray-900">{client.client_name}</h1>
              <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400">
                {client.industry_name && <span>{client.industry_name}</span>}
                {client.gstin && <><span className="text-gray-300">·</span><span className="font-mono">{client.gstin}</span></>}
                {client.pan && <><span className="text-gray-300">·</span><span className="font-mono">PAN: {client.pan}</span></>}
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
          {pendingCount > 0 && (
            <Link href={`/review?client=${clientId}`} className={buttonVariants({ variant: "outline" })}>
              <AlertTriangle size={14} className="mr-1.5 text-amber-500" />
              Review {pendingCount} pending
            </Link>
          )}
          <Link href={`/upload?client=${clientId}`} className={buttonVariants()}>
            <Upload size={14} className="mr-1.5" /> Upload document
          </Link>
        </div>
      </div>

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

      {/* Tabs */}
      <div className="flex border-b border-gray-200 gap-1">
        {([
          { key: "documents", label: "Documents", icon: <FileText size={14} />, count: documents.length },
          { key: "expected", label: "Expected Invoices", icon: <Clock size={14} />, count: expectedInvoices.filter(e => e.status === "pending").length || null },
          { key: "bank", label: "Bank Statements", icon: <Landmark size={14} />, count: bankSummary?.total ?? null },
          { key: "reconciliation", label: "Reconciliation", icon: <Link2 size={14} />, count: reconData?.summary.matched ?? null },
          { key: "ledger_view", label: "Ledger", icon: <BarChart3 size={14} />, count: ledgerData ? (ledgerData.purchase.vendors.length + ledgerData.sales.customers.length) || null : null },
          { key: "ledgers", label: "Ledger Master", icon: <BookOpen size={14} />, count: ledgers.length || null },
          { key: "gst", label: "GST Filing", icon: <Receipt size={14} />, count: null },
          { key: "summary", label: "Summary Note", icon: <ScrollText size={14} />, count: null },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => { setActiveTab(tab.key); if (tab.key === "summary" && !summary && !summaryLoading) loadSummary(); if (tab.key === "ledger_view" && !ledgerData && !ledgerLoading) loadLedger(ledgerFromDate || undefined, ledgerToDate || undefined); }}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab.icon} {tab.label}
            {tab.count !== null && tab.count > 0 && (
              <span className="ml-1 text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full">{tab.count}</span>
            )}
          </button>
        ))}
      </div>

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
                const isActive = docFolder === f.type;
                return (
                  <button key={f.type} onClick={() => setDocFolder(isActive ? null : f.type)}
                    className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                      isActive ? folderColors[f.color] + " border-2 shadow-sm" : "border-gray-200 hover:border-gray-300 bg-white"
                    }`}>
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
                      {docFolder ? "No documents in this folder yet." : "No documents yet."}
                    </p>
                    <Link href={`/upload?client=${clientId}${docFolder ? `&type=${docFolder}` : ""}`}
                      className={`${buttonVariants()} inline-flex`}>
                      <Upload size={14} className="mr-1.5" /> Upload documents
                    </Link>
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-gray-50">
                        <th className="text-left text-xs font-medium text-gray-500 px-5 py-3">File</th>
                        <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Type</th>
                        <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Invoice #</th>
                        <th className="text-right text-xs font-medium text-gray-500 px-4 py-3">Amount</th>
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
                            <td className="px-4 py-3 text-xs text-right font-medium">
                              {["reviewed", "reconciled", "posted"].includes(doc.status) && doc.total_amount
                                ? <span className="text-gray-800">₹{Number(doc.total_amount).toLocaleString("en-IN")}</span>
                                : <span className="text-gray-300">—</span>}
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
                                <button onClick={() => deleteDocument(doc.id, doc.original_filename)} disabled={deleting === doc.id}
                                  className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-red-500 disabled:opacity-50"
                                  title="Delete document">
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
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-xs font-medium text-blue-700">
                      {reconData.summary.unmatched_invoices} invoice{reconData.summary.unmatched_invoices !== 1 ? "s" : ""} awaiting payment
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

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
                                  <td className={`px-4 py-3 text-right font-semibold whitespace-nowrap ${amtMismatch ? "text-amber-600" : "text-gray-700"}`}>
                                    {invAmt !== null ? `₹${inr(invAmt)}` : "—"}
                                    {amtMismatch && <span className="block text-[10px] font-normal text-amber-500">Amt diff</span>}
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
                                  <td className={`px-4 py-3 text-right font-semibold whitespace-nowrap ${amtMismatch ? "text-amber-600" : "text-gray-700"}`}>
                                    {invAmt !== null ? `₹${inr(invAmt)}` : "—"}
                                    {amtMismatch && <span className="block text-[10px] font-normal text-amber-500">Amt diff</span>}
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
                  <Card><CardContent className="p-0">
                    <div className="px-4 py-3 border-b bg-gray-50 text-xs font-semibold text-gray-600">
                      Invoices without payment ({reconData?.unmatched_invoices.length ?? 0})
                    </div>
                    {(reconData?.unmatched_invoices ?? []).length === 0 ? (
                      <div className="py-8 text-center text-gray-400 text-sm">All invoices are reconciled.</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead><tr className="border-b bg-gray-50 text-gray-500">
                            <th className="text-left px-4 py-2 font-medium">File</th>
                            <th className="text-left px-4 py-2 font-medium">Type</th>
                            <th className="text-left px-4 py-2 font-medium">Status</th>
                            <th className="text-right px-4 py-2 font-medium">Amount</th>
                          </tr></thead>
                          <tbody>
                            {(reconData?.unmatched_invoices ?? []).map((doc) => (
                              <tr key={doc.id} className="border-b hover:bg-gray-50">
                                <td className="px-4 py-2 font-medium text-gray-900 max-w-[220px] truncate">{doc.original_filename}</td>
                                <td className="px-4 py-2 text-gray-500 capitalize">{doc.document_type?.replace(/_/g, " ")}</td>
                                <td className="px-4 py-2">
                                  <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${doc.status === "reviewed" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                                    {doc.status === "reviewed" ? "Reviewed" : "Pending review"}
                                  </span>
                                </td>
                                <td className="px-4 py-2 text-right font-semibold text-gray-700">{doc.total_amount ? `₹${Number(doc.total_amount).toLocaleString("en-IN")}` : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent></Card>
                </div>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* Bank Statements tab */}
      {activeTab === "bank" && (
        <div className="space-y-4">
          {/* BS summary cards */}
          {bankSummary && bankSummary.total > 0 && (
            <div className="grid grid-cols-4 gap-3">
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

          {/* Bank filter bar */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Filter by narration, ref number, category, ledger, amount…"
              value={bankFilter}
              onChange={e => setBankFilter(e.target.value)}
              className="flex-1 text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            {bankFilter && (
              <button onClick={() => setBankFilter("")} className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1.5 rounded border border-gray-200">Clear</button>
            )}
          </div>

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
                      {bankTxns.filter(txn => {
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
                      }).map((txn) => {
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
                          </td>
                          <td className="px-4 py-2.5">
                            <LedgerCell
                              txnId={txn.id} value={txn.ledger_name}
                              ledgers={ledgers}
                              onSave={async (txnId, val) => {
                                await fetch(`/api/v1/reconciliation/transactions/${txnId}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ ledger_name: val }),
                                });
                                loadBankTxns();
                              }}
                            />
                            {txn.ledger_source && (
                              <p className="text-xs text-gray-400 mt-0.5 italic" title={txn.ledger_source}>{txn.ledger_source}</p>
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
              <button onClick={() => ledgerImportRef.current?.click()} disabled={importingLedgers}
                className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
                {importingLedgers ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                Import from Tally
              </button>
              <button onClick={seedLedgers} disabled={seedingLedgers}
                className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
                {seedingLedgers ? <Loader2 size={13} className="animate-spin" /> : <BookOpen size={13} />}
                Load 25 common ledgers
              </button>
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
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className="text-left px-5 py-3 text-xs font-medium text-gray-500">Ledger Name</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Type</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {ledgers.map((l) => (
                      <tr key={l.id} className="border-b last:border-0 hover:bg-gray-50/50">
                        <td className="px-5 py-2.5 font-medium text-gray-800">{l.ledger_name}</td>
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
                        <td className="px-4 py-2.5 text-right">
                          <button onClick={() => deleteLedger(l.id)} className="text-gray-300 hover:text-red-500 transition-colors">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {/* ── Mapping Rules section ──────────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Auto-Mapping Rules</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Narration keyword → Ledger. Learned automatically as you assign ledgers.
                  {industryNameForRules && (
                    <span className="ml-1 text-blue-600">Industry rules for <strong>{industryNameForRules}</strong> shown below.</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
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

            {/* Client-level rules */}
            <Card className="mb-3">
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm font-medium text-gray-700 flex items-center gap-2">
                  Client Rules
                  <span className="text-xs font-normal text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">{clientMappingRules.length}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {rulesLoading ? (
                  <div className="py-6 flex items-center justify-center gap-2 text-gray-400 text-sm">
                    <Loader2 size={14} className="animate-spin" /> Loading…
                  </div>
                ) : clientMappingRules.length === 0 ? (
                  <p className="px-5 py-4 text-xs text-gray-400">No rules yet. Assign ledgers to transactions — rules are learned automatically.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-gray-50 text-gray-500">
                        <th className="text-left px-5 py-2.5 font-medium">Pattern</th>
                        <th className="text-left px-4 py-2.5 font-medium">→ Ledger</th>
                        <th className="text-center px-4 py-2.5 font-medium">Hits</th>
                        <th className="text-center px-4 py-2.5 font-medium">Status</th>
                        <th className="px-4 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {clientMappingRules.map((r) => (
                        <tr key={r.id} className="border-b last:border-0 hover:bg-gray-50/50">
                          <td className="px-5 py-2 font-mono text-gray-700">{r.pattern}</td>
                          <td className="px-4 py-2 text-gray-800 font-medium">{r.ledger_name}</td>
                          <td className="px-4 py-2 text-center text-gray-500">{r.match_count}</td>
                          <td className="px-4 py-2 text-center">
                            <button onClick={() => toggleRuleConfirmed(r.id, r.confirmed)}
                              title={r.confirmed ? "Click to disable rule" : "Click to confirm rule"}
                              className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
                                r.confirmed ? "bg-green-100 text-green-700 hover:bg-green-200" : "bg-gray-100 text-gray-500 hover:bg-yellow-50 hover:text-yellow-700"
                              }`}>
                              {r.confirmed ? "Active" : "Learning"}
                            </button>
                          </td>
                          <td className="px-4 py-2 text-right">
                            <button onClick={() => deleteMappingRule(r.id)} className="text-gray-300 hover:text-red-500 transition-colors">
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            {/* Industry-level rules */}
            {industryNameForRules && (
              <Card>
                <CardHeader className="pb-2 pt-4">
                  <CardTitle className="text-sm font-medium text-gray-700 flex items-center gap-2">
                    Industry Rules
                    <span className="text-xs font-normal text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full">{industryNameForRules}</span>
                    <span className="text-xs font-normal text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">{industryMappingRules.length}</span>
                    <span className="text-xs font-normal text-gray-400 ml-auto">Auto-promoted when 3+ clients in this industry confirm the same rule</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {industryMappingRules.length === 0 ? (
                    <p className="px-5 py-4 text-xs text-gray-400">No industry rules yet. Rules are promoted here automatically once 3 clients in <strong>{industryNameForRules}</strong> confirm the same pattern.</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b bg-gray-50 text-gray-500">
                          <th className="text-left px-5 py-2.5 font-medium">Pattern</th>
                          <th className="text-left px-4 py-2.5 font-medium">→ Ledger</th>
                          <th className="text-center px-4 py-2.5 font-medium">Clients</th>
                          <th className="text-center px-4 py-2.5 font-medium">Status</th>
                          <th className="px-4 py-2.5" />
                        </tr>
                      </thead>
                      <tbody>
                        {industryMappingRules.map((r) => (
                          <tr key={r.id} className="border-b last:border-0 hover:bg-gray-50/50">
                            <td className="px-5 py-2 font-mono text-gray-700">{r.pattern}</td>
                            <td className="px-4 py-2 text-gray-800 font-medium">{r.ledger_name}</td>
                            <td className="px-4 py-2 text-center text-gray-500">{r.match_count}</td>
                            <td className="px-4 py-2 text-center">
                              <button onClick={() => toggleRuleConfirmed(r.id, r.confirmed)}
                                title={r.confirmed ? "Click to disable rule" : "Click to confirm rule"}
                                className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
                                  r.confirmed ? "bg-blue-100 text-blue-700 hover:bg-blue-200" : "bg-gray-100 text-gray-500 hover:bg-yellow-50 hover:text-yellow-700"
                                }`}>
                                {r.confirmed ? "Active" : "Paused"}
                              </button>
                            </td>
                            <td className="px-4 py-2 text-right">
                              <button onClick={() => deleteMappingRule(r.id)} className="text-gray-300 hover:text-red-500 transition-colors">
                                <Trash2 size={13} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* ── GST FILING TAB ─────────────────────────────────────────────── */}
      {activeTab === "gst" && (
        <div className="space-y-4">
          {/* Period picker + download */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500">Period:</label>
              <input type="date" value={gstPeriodFrom} onChange={(e) => setGstPeriodFrom(e.target.value)}
                className="text-xs border border-gray-300 rounded px-2 py-1" />
              <span className="text-xs text-gray-400">to</span>
              <input type="date" value={gstPeriodTo} onChange={(e) => setGstPeriodTo(e.target.value)}
                className="text-xs border border-gray-300 rounded px-2 py-1" />
            </div>
            <a
              href={`/api/v1/clients/${clientId}/gst-filing?from=${gstPeriodFrom}&to=${gstPeriodTo}&format=excel`}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-green-600 text-white hover:bg-green-700"
            >
              <Download size={12} /> Download GST Filing Excel (GSTR-1 + 3B)
            </a>
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
                <div className="grid grid-cols-3 gap-4">
                  {/* Output Tax */}
                  <Card className="border-blue-200">
                    <CardHeader className="py-2 px-4 border-b bg-blue-50/50">
                      <CardTitle className="text-xs font-semibold text-blue-700 uppercase tracking-wide">3.1(a) — Output Tax</CardTitle>
                    </CardHeader>
                    <CardContent className="py-3 px-4 space-y-1.5">
                      {[
                        { label: "Taxable Value", value: gstData.outward_taxable.taxable },
                        { label: "Integrated Tax (IGST)", value: gstData.output_tax.igst },
                        { label: "Central Tax (CGST)", value: gstData.output_tax.cgst },
                        { label: "State Tax (SGST)", value: gstData.output_tax.sgst },
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

                  {/* ITC Available */}
                  <Card className="border-green-200">
                    <CardHeader className="py-2 px-4 border-b bg-green-50/50">
                      <CardTitle className="text-xs font-semibold text-green-700 uppercase tracking-wide">4(A) — ITC Available</CardTitle>
                    </CardHeader>
                    <CardContent className="py-3 px-4 space-y-1.5">
                      {[
                        { label: "Integrated Tax (IGST)", value: gstData.itc_available.igst },
                        { label: "Central Tax (CGST)", value: gstData.itc_available.cgst },
                        { label: "State Tax (SGST)", value: gstData.itc_available.sgst },
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

function LedgerCell({ txnId, value, ledgers, onSave }: {
  txnId: string;
  value: string | null | undefined;
  ledgers: { id: string; ledger_name: string; ledger_type: string }[];
  onSave: (txnId: string, value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  if (editing) {
    return (
      <select autoFocus defaultValue={value ?? ""}
        className="text-xs rounded border border-blue-300 px-1 py-0.5 max-w-[160px] focus:outline-none focus:ring-1 focus:ring-blue-400"
        onBlur={(e) => { setEditing(false); if (e.target.value && e.target.value !== value) { setSaving(true); onSave(txnId, e.target.value).finally(() => setSaving(false)); } }}
        onChange={async (e) => { if (e.target.value) { setEditing(false); setSaving(true); await onSave(txnId, e.target.value); setSaving(false); } }}>
        <option value="">— select ledger —</option>
        {ledgers.map((l) => <option key={l.id} value={l.ledger_name}>{l.ledger_name}</option>)}
      </select>
    );
  }

  if (saving) return <span className="text-xs text-gray-400 italic">Saving…</span>;

  return (
    <button onClick={() => setEditing(true)}
      className={`group inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded max-w-[160px] truncate ${
        value ? "bg-green-50 text-green-800 hover:opacity-80" : "bg-amber-50 text-amber-700 hover:opacity-80 italic"
      }`}>
      <span className="truncate">{value ?? "Set ledger"}</span>
      <Pencil size={9} className="flex-shrink-0 opacity-0 group-hover:opacity-60" />
    </button>
  );
}
