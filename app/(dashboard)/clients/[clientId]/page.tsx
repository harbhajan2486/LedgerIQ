"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Building2, ChevronLeft, FileText, Loader2, Upload,
  CheckCircle2, AlertTriangle, Clock, RefreshCw, Landmark,
  Link2, Link2Off, X, Pencil, BookOpen, Download, Plus, Trash2
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
}

interface Document {
  id: string;
  original_filename: string;
  document_type: string;
  status: string;
  uploaded_at: string;
  ai_model_used: string | null;
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
}

interface ReconData {
  summary: { matched: number; possible: number; exceptions: number; unmatched_transactions: number; unmatched_invoices: number };
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
  const clientId = params.clientId as string;

  const [client, setClient] = useState<Client | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"documents" | "bank" | "reconciliation" | "ledgers">("documents");
  const [bankTxns, setBankTxns] = useState<BankTxn[]>([]);
  const [bankSummary, setBankSummary] = useState<BankSummary | null>(null);
  const [bankLoading, setBankLoading] = useState(false);

  // Reconciliation tab state
  const [reconData, setReconData] = useState<ReconData | null>(null);
  const [reconLoading, setReconLoading] = useState(false);
  const [reconMatching, setReconMatching] = useState(false);
  const [reconTab, setReconTab] = useState<"matched" | "possible" | "unmatched">("matched");
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

  function loadData() {
    fetch(`/api/v1/clients/${clientId}`)
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

  useEffect(() => { loadData(); }, [clientId]);
  useEffect(() => { if (activeTab === "bank") { loadBankTxns(); loadLedgers(); } }, [activeTab, clientId]);
  useEffect(() => { if (activeTab === "reconciliation") loadRecon(); }, [activeTab, clientId]);
  useEffect(() => { if (activeTab === "ledgers") loadLedgers(); }, [activeTab, clientId]);

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
          { key: "bank", label: "Bank Statements", icon: <Landmark size={14} />, count: bankSummary?.total ?? null },
          { key: "reconciliation", label: "Reconciliation", icon: <Link2 size={14} />, count: reconData?.summary.matched ?? null },
          { key: "ledgers", label: "Ledger Master", icon: <BookOpen size={14} />, count: ledgers.length || null },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
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

      {/* Document list */}
      {activeTab === "documents" && <Card>
        <CardHeader className="py-4 px-5 border-b">
          <CardTitle className="text-sm text-gray-700">Documents</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {documents.length === 0 ? (
            <div className="text-center py-12">
              <FileText size={32} className="text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">No documents yet</p>
              <Link href={`/upload?client=${clientId}`} className={`${buttonVariants()} mt-3 inline-flex`}>
                <Upload size={14} className="mr-1.5" /> Upload first document
              </Link>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left text-xs font-medium text-gray-500 px-5 py-3">File</th>
                  <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Type</th>
                  <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Status</th>
                  <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Uploaded</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => {
                  const cfg = STATUS_CONFIG[doc.status] ?? { label: doc.status, cls: "bg-gray-50 text-gray-600 border-gray-200", icon: null };
                  const canRetry = RETRYABLE.has(doc.status);
                  return (
                    <tr key={doc.id} className="border-b last:border-0 hover:bg-gray-50/50">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <FileText size={14} className="text-gray-400 flex-shrink-0" />
                          <span className="truncate max-w-xs text-gray-800">{doc.original_filename}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{DOC_TYPE_LABELS[doc.document_type] ?? doc.document_type}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${cfg.cls}`}>
                          {cfg.icon} {cfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {new Date(doc.uploaded_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                      </td>
                      <td className="px-4 py-3">
                        {doc.status === "review_required" && (
                          <Link href={`/review/${doc.id}`} className="text-xs text-blue-600 hover:underline">Review →</Link>
                        )}
                        {canRetry && (
                          <button
                            onClick={() => retryExtraction(doc.id, doc.original_filename)}
                            disabled={retrying === doc.id}
                            className="inline-flex items-center gap-1 text-xs text-amber-600 hover:text-amber-800 disabled:opacity-50"
                          >
                            {retrying === doc.id
                              ? <><Loader2 size={11} className="animate-spin" /> Retrying…</>
                              : <><RefreshCw size={11} /> Retry</>
                            }
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>}

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

          {/* Summary + actions */}
          <div className="flex items-center justify-between">
            <div className="flex gap-3">
              {reconData && ([
                { label: "Matched",   value: reconData.summary.matched,               cls: "text-green-700" },
                { label: "Possible",  value: reconData.summary.possible,              cls: "text-yellow-700" },
                { label: "Unmatched txns", value: reconData.summary.unmatched_transactions, cls: "text-gray-700" },
                { label: "Unmatched invoices", value: reconData.summary.unmatched_invoices, cls: "text-gray-700" },
              ].map(({ label, value, cls }) => (
                <div key={label} className="text-center px-3 py-2 rounded-lg bg-gray-50 border border-gray-200">
                  <p className="text-xs text-gray-500">{label}</p>
                  <p className={`text-xl font-bold ${cls}`}>{value}</p>
                </div>
              )))}
            </div>
            <button onClick={runReconMatch} disabled={reconMatching}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
              <RefreshCw size={13} className={reconMatching ? "animate-spin" : ""} />
              {reconMatching ? "Matching…" : "Re-run matching"}
            </button>
          </div>

          {/* Sub-tabs */}
          <div className="flex gap-1 border-b border-gray-200">
            {(["matched","possible","unmatched"] as const).map((t) => (
              <button key={t} onClick={() => setReconTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${reconTab === t ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
                {t === "unmatched" ? "Unmatched" : t === "possible" ? "Possible matches" : "Matched"}
              </button>
            ))}
          </div>

          {reconLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-400 py-8 justify-center"><Loader2 size={16} className="animate-spin" /> Loading…</div>
          ) : (
            <>
              {/* Matched */}
              {reconTab === "matched" && (
                <Card><CardContent className="p-0">
                  {reconData?.reconciliations.filter(r => r.status === "matched").length === 0 ? (
                    <div className="py-10 text-center text-gray-400 text-sm">No matched transactions yet. Click Re-run matching.</div>
                  ) : (
                    <div className="divide-y">
                      {reconData?.reconciliations.filter(r => r.status === "matched").map((r) => {
                        const txn = Array.isArray(r.bank_transactions) ? r.bank_transactions[0] : r.bank_transactions;
                        const doc = Array.isArray(r.documents) ? r.documents[0] : r.documents;
                        return (
                          <div key={r.id} className="p-4 flex items-start justify-between gap-4">
                            <div className="flex-1 grid grid-cols-2 gap-4">
                              <div>
                                <p className="text-xs text-gray-400">{txn?.bank_name} · {txn?.transaction_date}</p>
                                <p className="text-sm font-medium text-gray-900 truncate">{txn?.narration}</p>
                                <p className="text-sm font-semibold text-gray-700 mt-0.5">
                                  {txn?.debit_amount ? `₹${Number(txn.debit_amount).toLocaleString("en-IN")} debit` : txn?.credit_amount ? `₹${Number(txn.credit_amount).toLocaleString("en-IN")} credit` : ""}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400 capitalize">{doc?.document_type?.replace(/_/g, " ")}</p>
                                <p className="text-sm font-medium text-gray-900 truncate">{doc?.original_filename}</p>
                                <p className="text-xs text-gray-400 mt-0.5">{r.match_score}% match · {(r.match_reasons ?? []).slice(0,2).join(" · ")}</p>
                              </div>
                            </div>
                            <button onClick={() => handleUnmatch(r.id)} className="text-xs text-gray-400 hover:text-red-500 flex items-center gap-1 flex-shrink-0">
                              <Link2Off size={12} /> Unmatch
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent></Card>
              )}

              {/* Possible */}
              {reconTab === "possible" && (
                <Card><CardContent className="p-0">
                  {reconData?.reconciliations.filter(r => r.status === "possible_match").length === 0 ? (
                    <div className="py-10 text-center text-gray-400 text-sm">No possible matches.</div>
                  ) : (
                    <div className="divide-y">
                      {reconData?.reconciliations.filter(r => r.status === "possible_match").map((r) => {
                        const txn = Array.isArray(r.bank_transactions) ? r.bank_transactions[0] : r.bank_transactions;
                        const doc = Array.isArray(r.documents) ? r.documents[0] : r.documents;
                        return (
                          <div key={r.id} className="p-4 flex items-start justify-between gap-4">
                            <div className="flex-1 grid grid-cols-2 gap-4">
                              <div>
                                <p className="text-xs text-gray-400">{txn?.bank_name} · {txn?.transaction_date}</p>
                                <p className="text-sm font-medium text-gray-900 truncate">{txn?.narration}</p>
                                <p className="text-sm font-semibold text-gray-700 mt-0.5">
                                  {txn?.debit_amount ? `₹${Number(txn.debit_amount).toLocaleString("en-IN")} debit` : txn?.credit_amount ? `₹${Number(txn.credit_amount).toLocaleString("en-IN")} credit` : ""}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs text-gray-400 capitalize">{doc?.document_type?.replace(/_/g, " ")}</p>
                                <p className="text-sm font-medium text-gray-900 truncate">{doc?.original_filename}</p>
                                <span className="text-xs bg-yellow-50 text-yellow-700 px-1.5 py-0.5 rounded">{r.match_score}% confidence</span>
                              </div>
                            </div>
                            <div className="flex gap-2 flex-shrink-0">
                              <button onClick={() => handleUnmatch(r.id)} className="text-xs text-gray-400 hover:text-red-500 flex items-center gap-1">
                                <Link2Off size={12} /> Reject
                              </button>
                              <button onClick={() => approvePossible(r.id)} className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700 flex items-center gap-1">
                                <CheckCircle2 size={11} /> Confirm
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent></Card>
              )}

              {/* Unmatched */}
              {reconTab === "unmatched" && (
                <div className="space-y-4">
                  <Card><CardContent className="p-0">
                    <div className="px-4 py-3 border-b bg-gray-50 text-xs font-semibold text-gray-600">
                      Bank transactions without match ({reconData?.unmatched_transactions.length ?? 0})
                    </div>
                    {(reconData?.unmatched_transactions ?? []).length === 0 ? (
                      <div className="py-8 text-center text-gray-400 text-sm">All bank transactions are matched.</div>
                    ) : (
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
                            {(reconData?.unmatched_transactions ?? []).map((txn) => (
                              <tr key={txn.id} className="border-b hover:bg-gray-50">
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
                    )}
                  </CardContent></Card>

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
              )}
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

          <Card>
            <CardHeader className="py-4 px-5 border-b flex flex-row items-center justify-between">
              <CardTitle className="text-sm text-gray-700">Bank transactions</CardTitle>
              <div className="flex items-center gap-3">
                <button onClick={reapplyLedgerRules} disabled={reapplying}
                  className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1 disabled:opacity-50">
                  {reapplying ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  Re-apply ledger rules
                </button>
                <button onClick={() => openClaimModal()} className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1">
                  <Link2 size={11} /> Link existing
                </button>
                <a href={`/api/v1/clients/${clientId}/bank-book`}
                  className="inline-flex items-center gap-1 text-xs text-green-600 hover:text-green-800">
                  <Download size={12} /> Export Bank Book
                </a>
                <Link href={`/reconciliation?client=${clientId}`} className="text-xs text-blue-600 hover:underline">
                  Upload bank statement →
                </Link>
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
                        <th className="px-4 py-3 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bankTxns.map((txn) => (
                        <tr key={txn.id} className="border-b last:border-0 hover:bg-gray-50/50 text-xs">
                          <td className="px-5 py-2.5 text-gray-500 whitespace-nowrap">{txn.transaction_date}</td>
                          <td className="px-4 py-2.5 max-w-xs">
                            <p className="truncate text-gray-800">{txn.narration}</p>
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
                          <td className="px-4 py-2.5">
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${
                              txn.status === "matched" ? "bg-green-50 text-green-700" :
                              txn.status === "possible_match" ? "bg-yellow-50 text-yellow-700" :
                              "bg-gray-100 text-gray-500"
                            }`}>
                              {txn.status === "matched" ? <CheckCircle2 size={9} /> : null}
                              {txn.status.replace("_", " ")}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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

      {/* Ledger Master tab */}
      {activeTab === "ledgers" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Ledger Master</h2>
              <p className="text-xs text-gray-500 mt-0.5">Define Tally ledger names for this client. Used to auto-classify bank transactions.</p>
            </div>
            <button onClick={seedLedgers} disabled={seedingLedgers}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
              {seedingLedgers ? <Loader2 size={13} className="animate-spin" /> : <BookOpen size={13} />}
              Load 25 common ledgers
            </button>
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
        </div>
      )}
    </div>
  );
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
