"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, Upload, CheckCircle2, AlertCircle, HelpCircle,
  Link2, Link2Off, Download, RefreshCw, FileText, Building2, Pencil, X
} from "lucide-react";

type ReconciliationStatus = "matched" | "possible_match" | "exception" | "unmatched";

interface BankTxn {
  id: string;
  transaction_date: string;
  narration: string;
  ref_number: string | null;
  debit_amount: number | null;
  credit_amount: number | null;
  bank_name: string;
  status?: ReconciliationStatus;
  category?: string | null;
  voucher_type?: string | null;
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
  status: ReconciliationStatus;
  match_score: number;
  match_reasons: string[];
  matched_at: string;
  bank_transactions: BankTxn | BankTxn[];
  documents: ReconDoc | ReconDoc[];
}

interface ReconData {
  summary: {
    matched: number;
    possible: number;
    exceptions: number;
    unmatched_transactions: number;
    unmatched_invoices: number;
  };
  reconciliations: Reconciliation[];
  unmatched_transactions: BankTxn[];
  unmatched_invoices: ReconDoc[];
}

type ActiveTab = "matched" | "possible" | "exceptions" | "unmatched";

const STATUS_CONFIG: Record<ActiveTab, { label: string; color: string; icon: React.ElementType }> = {
  matched:    { label: "Matched",    color: "text-green-600 bg-green-50",   icon: CheckCircle2 },
  possible:   { label: "Possible",   color: "text-yellow-600 bg-yellow-50", icon: HelpCircle },
  exceptions: { label: "Exceptions", color: "text-red-600 bg-red-50",       icon: AlertCircle },
  unmatched:  { label: "Unmatched",  color: "text-gray-600 bg-gray-50",     icon: Link2Off },
};

const BANKS = ["HDFC Bank", "ICICI Bank", "SBI", "Axis Bank", "Kotak Mahindra Bank", "Yes Bank", "IndusInd Bank", "Other"];
const CATEGORIES = [
  "Vendor Payment", "Customer Receipt", "GST Payment", "TDS Payment",
  "Salary", "Rent", "Bank Charges", "Loan Repayment", "Insurance",
  "Interest Income", "Interest Expense", "Inter-bank Transfer",
  "Other Payment", "Other Receipt",
];
const VOUCHER_TYPES = ["Payment", "Receipt", "Journal", "Contra", "Purchase", "Sales"];

function fmt(n: number | string | null | undefined) {
  if (!n) return "";
  return `₹${Number(n).toLocaleString("en-IN")}`;
}

export default function ReconciliationPage() {
  const [data, setData] = useState<ReconData | null>(null);
  const [loading, setLoading] = useState(true);
  const [matching, setMatching] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>("matched");

  // Upload state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [bankName, setBankName] = useState("HDFC Bank");
  const [uploadClientId, setUploadClientId] = useState<string>("");
  const [clients, setClients] = useState<{ id: string; client_name: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Inline category/voucher edit
  const [editingTxn, setEditingTxn] = useState<string | null>(null);

  // Manual match modal: which txn is being linked
  const [linkingTxn, setLinkingTxn] = useState<BankTxn | null>(null);
  const [matchingId, setMatchingId] = useState<string | null>(null);
  const [unmatchingId, setUnmatchingId] = useState<string | null>(null);

  async function updateTxnField(txnId: string, field: "category" | "voucher_type", value: string) {
    await fetch(`/api/v1/reconciliation/transactions/${txnId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    setEditingTxn(null);
    loadData();
  }

  const loadData = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/v1/reconciliation/data");
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, []);

  async function runAutoMatch() {
    setMatching(true);
    await fetch("/api/v1/reconciliation/auto-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setMatching(false);
    await loadData();
  }

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    fetch("/api/v1/clients").then((r) => r.json()).then((d) => setClients(d.clients ?? [])).catch(() => {});
  }, []);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadMsg(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4 * 60 * 1000);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("bank_name", bankName);
      if (uploadClientId) formData.append("client_id", uploadClientId);
      const res = await fetch("/api/v1/reconciliation/upload-statement", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setUploadMsg({ type: "success", text: d.message ?? `${d.count} transactions imported.` });
        setTimeout(() => { setUploadOpen(false); setUploadMsg(null); loadData(); }, 2500);
      } else {
        setUploadMsg({ type: "error", text: d.error ?? `Upload failed (${res.status}).` });
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "AbortError";
      setUploadMsg({
        type: "error",
        text: isTimeout
          ? "Upload timed out — try splitting the PDF or use CSV/Excel instead."
          : "Upload failed. Check your connection and try again.",
      });
    } finally {
      clearTimeout(timer);
      setUploading(false);
    }
  }

  async function handleManualMatch(documentId: string) {
    if (!linkingTxn) return;
    setMatchingId(documentId);
    await fetch("/api/v1/reconciliation/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: linkingTxn.id, documentId }),
    });
    setLinkingTxn(null);
    setMatchingId(null);
    loadData();
  }

  async function handleUnmatch(reconId: string) {
    if (!confirm("Remove this match? Both the transaction and invoice will return to unmatched.")) return;
    setUnmatchingId(reconId);
    await fetch("/api/v1/reconciliation/unmatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reconciliationId: reconId }),
    });
    setUnmatchingId(null);
    loadData();
  }

  async function approvePossible(reconId: string) {
    setMatchingId(reconId);
    await fetch("/api/v1/reconciliation/match-approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reconciliationId: reconId }),
    });
    setMatchingId(null);
    loadData();
  }

  const getTxn = (r: Reconciliation) => Array.isArray(r.bank_transactions) ? r.bank_transactions[0] : r.bank_transactions;
  const getDoc = (r: Reconciliation) => Array.isArray(r.documents) ? r.documents[0] : r.documents;

  const matched    = (data?.reconciliations ?? []).filter((r) => r.status === "matched");
  const possible   = (data?.reconciliations ?? []).filter((r) => r.status === "possible_match");
  const exceptions = (data?.reconciliations ?? []).filter((r) => r.status === "exception");

  const counts: Record<ActiveTab, number> = {
    matched:    matched.length,
    possible:   possible.length,
    exceptions: exceptions.length,
    unmatched:  data?.summary.unmatched_transactions ?? 0,
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Bank Reconciliation</h1>
          <p className="text-sm text-gray-500 mt-1">Match invoices with bank transactions automatically.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={runAutoMatch} disabled={matching}>
            <RefreshCw className={`w-4 h-4 mr-2 ${matching ? "animate-spin" : ""}`} />
            {matching ? "Matching…" : "Re-run matching"}
          </Button>
          <Button variant="outline" onClick={() => window.open("/api/v1/reconciliation/export?format=csv")}>
            <Download className="w-4 h-4 mr-2" /> Export CSV
          </Button>
          <Button onClick={() => setUploadOpen(true)}>
            <Upload className="w-4 h-4 mr-2" /> Upload bank statement
          </Button>
        </div>
      </div>

      {/* Upload modal */}
      {uploadOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md mx-4">
            <CardHeader>
              <CardTitle>Upload bank statement</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleUpload} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-gray-700">Bank</label>
                  <select value={bankName} onChange={(e) => setBankName(e.target.value)}
                    className="w-full h-10 px-3 rounded-md border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {BANKS.map((b) => <option key={b}>{b}</option>)}
                  </select>
                </div>
                {clients.length > 0 && (
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-700">Client (optional)</label>
                    <select value={uploadClientId} onChange={(e) => setUploadClientId(e.target.value)}
                      className="w-full h-10 px-3 rounded-md border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="">— All / Unassigned —</option>
                      {clients.map((c) => <option key={c.id} value={c.id}>{c.client_name}</option>)}
                    </select>
                  </div>
                )}
                <div className="space-y-1">
                  <label className="text-sm font-medium text-gray-700">Statement file</label>
                  <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls,.pdf" required
                    className="w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" />
                  <p className="text-xs text-gray-400">CSV, Excel, or PDF — AI reads transactions automatically.</p>
                </div>
                {uploading && (
                  <div className="flex items-center gap-2 text-sm text-blue-600 bg-blue-50 rounded-md px-3 py-2">
                    <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
                    <span>Processing… PDF statements take 30–90 seconds. Please wait.</span>
                  </div>
                )}
                {uploadMsg && (
                  <p className={`text-sm ${uploadMsg.type === "success" ? "text-green-600" : "text-red-600"}`}>
                    {uploadMsg.text}
                  </p>
                )}
                <div className="flex gap-2 justify-end">
                  <Button type="button" variant="outline" onClick={() => { setUploadOpen(false); setUploadMsg(null); }} disabled={uploading}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={uploading}>
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                    {uploading ? "Processing…" : "Upload & match"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Manual match modal */}
      {linkingTxn && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col">
            <CardHeader className="flex-shrink-0 pb-3">
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base">Link to invoice</CardTitle>
                  <p className="text-xs text-gray-500 mt-1 line-clamp-1">
                    Bank: {linkingTxn.narration} &nbsp;·&nbsp;
                    {linkingTxn.debit_amount ? fmt(linkingTxn.debit_amount) + " debit" : fmt(linkingTxn.credit_amount) + " credit"}
                    &nbsp;·&nbsp; {linkingTxn.transaction_date}
                  </p>
                </div>
                <button onClick={() => setLinkingTxn(null)} className="text-gray-400 hover:text-gray-600 ml-4">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </CardHeader>
            <CardContent className="overflow-y-auto flex-1 pt-0">
              {(data?.unmatched_invoices ?? []).length === 0 ? (
                <p className="text-sm text-gray-400 py-6 text-center">No unmatched invoices available.</p>
              ) : (
                <div className="space-y-2">
                  {(data?.unmatched_invoices ?? []).map((doc) => (
                    <button
                      key={doc.id}
                      onClick={() => handleManualMatch(doc.id)}
                      disabled={matchingId === doc.id}
                      className="w-full text-left p-3 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition-all flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{doc.original_filename}</p>
                        <p className="text-xs text-gray-500 capitalize mt-0.5">
                          {doc.document_type?.replace(/_/g, " ")}
                          {doc.status === "review_required" && <span className="ml-2 text-amber-600">· Pending review</span>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {doc.total_amount && (
                          <span className="text-sm font-semibold text-gray-700">{fmt(doc.total_amount)}</span>
                        )}
                        {matchingId === doc.id
                          ? <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                          : <Link2 className="w-4 h-4 text-blue-400" />
                        }
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Summary cards */}
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {(["matched", "possible", "exceptions", "unmatched"] as ActiveTab[]).map((tab) => {
            const cfg = STATUS_CONFIG[tab];
            const Icon = cfg.icon;
            return (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`text-left p-3 rounded-lg border-2 transition-all ${activeTab === tab ? "border-blue-500 bg-blue-50" : "border-gray-200 bg-white hover:border-gray-300"}`}>
                <div className={`flex items-center gap-1 text-xs font-medium mb-1 ${cfg.color.split(" ")[0]}`}>
                  <Icon className="w-3 h-3" /> {cfg.label}
                </div>
                <p className="text-2xl font-bold text-gray-900">{counts[tab]}</p>
              </button>
            );
          })}
          <div className="text-left p-3 rounded-lg border border-gray-200 bg-white">
            <p className="text-xs text-gray-500 mb-1">Unmatched invoices</p>
            <p className="text-2xl font-bold text-gray-900">{data.summary.unmatched_invoices}</p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading reconciliation data...
        </div>
      ) : (
        <div className="space-y-3">
          {/* MATCHED TAB */}
          {activeTab === "matched" && (
            matched.length === 0 ? (
              <Card><CardContent className="py-12 text-center text-gray-400">
                <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                No matched transactions yet. Upload a bank statement and click Re-run matching.
              </CardContent></Card>
            ) : matched.map((r) => {
              const txn = getTxn(r);
              const doc = getDoc(r);
              return (
                <Card key={r.id} className="border-l-4 border-l-green-400">
                  <CardContent className="pt-4 pb-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="flex items-start gap-3">
                        <Building2 className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="text-xs text-gray-500 mb-0.5">{txn?.bank_name} · {txn?.transaction_date}</p>
                          <p className="text-sm font-medium text-gray-900 line-clamp-2">{txn?.narration}</p>
                          {txn?.ref_number && <p className="text-xs text-gray-400 mt-0.5">Ref: {txn.ref_number}</p>}
                          <p className="text-sm font-semibold text-gray-700 mt-1">
                            {txn?.debit_amount ? `${fmt(txn.debit_amount)} debit` : txn?.credit_amount ? `${fmt(txn.credit_amount)} credit` : ""}
                          </p>
                          {txn && (
                            <div className="flex gap-1 mt-1 flex-wrap">
                              <CategoryChip txnId={txn.id} value={txn.category} field="category" editingTxn={editingTxn} setEditingTxn={setEditingTxn} onSave={updateTxnField} />
                              <CategoryChip txnId={txn.id} value={txn.voucher_type} field="voucher_type" editingTxn={editingTxn} setEditingTxn={setEditingTxn} onSave={updateTxnField} />
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <FileText className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <p className="text-xs text-gray-500 mb-0.5 capitalize">{doc?.document_type?.replace(/_/g, " ")}</p>
                          <p className="text-sm font-medium text-gray-900 line-clamp-1">{doc?.original_filename}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <Badge variant="secondary" className="text-xs">{r.match_score}% match</Badge>
                            <span className="text-xs text-gray-400">{(r.match_reasons ?? []).join(" · ")}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-end mt-2">
                      <button onClick={() => handleUnmatch(r.id)} disabled={unmatchingId === r.id}
                        className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition-colors">
                        {unmatchingId === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2Off className="w-3 h-3" />}
                        Unmatch
                      </button>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}

          {/* POSSIBLE MATCHES TAB */}
          {activeTab === "possible" && (
            possible.length === 0 ? (
              <Card><CardContent className="py-12 text-center text-gray-400">
                <HelpCircle className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                No possible matches.
              </CardContent></Card>
            ) : possible.map((r) => {
              const txn = getTxn(r);
              const doc = getDoc(r);
              return (
                <Card key={r.id} className="border-l-4 border-l-yellow-400">
                  <CardContent className="pt-4 pb-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="flex items-start gap-3">
                        <Building2 className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="text-xs text-gray-500 mb-0.5">{txn?.bank_name} · {txn?.transaction_date}</p>
                          <p className="text-sm font-medium text-gray-900 line-clamp-2">{txn?.narration}</p>
                          <p className="text-sm font-semibold text-gray-700 mt-1">
                            {txn?.debit_amount ? `${fmt(txn.debit_amount)} debit` : txn?.credit_amount ? `${fmt(txn.credit_amount)} credit` : ""}
                          </p>
                          {txn && (
                            <div className="flex gap-1 mt-1 flex-wrap">
                              <CategoryChip txnId={txn.id} value={txn.category} field="category" editingTxn={editingTxn} setEditingTxn={setEditingTxn} onSave={updateTxnField} />
                              <CategoryChip txnId={txn.id} value={txn.voucher_type} field="voucher_type" editingTxn={editingTxn} setEditingTxn={setEditingTxn} onSave={updateTxnField} />
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <FileText className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <p className="text-xs text-gray-500 mb-0.5 capitalize">{doc?.document_type?.replace(/_/g, " ")}</p>
                          <p className="text-sm font-medium text-gray-900 line-clamp-1">{doc?.original_filename}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge className="text-xs bg-yellow-100 text-yellow-700 border-yellow-200">{r.match_score}% confidence</Badge>
                            <span className="text-xs text-gray-400">{(r.match_reasons ?? []).slice(0, 2).join(" · ")}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 mt-3">
                      <button onClick={() => handleUnmatch(r.id)} className="text-xs text-gray-400 hover:text-red-500 flex items-center gap-1">
                        <Link2Off className="w-3 h-3" /> Reject
                      </button>
                      <Button size="sm" className="h-7 text-xs bg-green-600 hover:bg-green-700"
                        onClick={() => approvePossible(r.id)} disabled={matchingId === r.id}>
                        {matchingId === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><CheckCircle2 className="w-3 h-3 mr-1" /> Confirm match</>}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}

          {/* EXCEPTIONS TAB */}
          {activeTab === "exceptions" && (
            exceptions.length === 0 ? (
              <Card><CardContent className="py-12 text-center text-gray-400">
                <AlertCircle className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                No exceptions.
              </CardContent></Card>
            ) : exceptions.map((r) => {
              const txn = getTxn(r);
              const doc = getDoc(r);
              return (
                <Card key={r.id} className="border-l-4 border-l-red-400">
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-start gap-3">
                      <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-gray-900">{txn?.narration}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{doc?.original_filename}</p>
                        <p className="text-xs text-red-500 mt-1">{(r.match_reasons ?? []).join(", ")}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}

          {/* UNMATCHED TAB — table layout */}
          {activeTab === "unmatched" && (
            <div className="space-y-6">
              {/* Unmatched bank transactions */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2 mb-3">
                  <Building2 className="w-4 h-4" />
                  Bank transactions without match ({data?.unmatched_transactions.length ?? 0})
                </h3>
                {(data?.unmatched_transactions ?? []).length === 0 ? (
                  <Card><CardContent className="py-8 text-center text-gray-400 text-sm">All bank transactions are matched.</CardContent></Card>
                ) : (
                  <Card>
                    <CardContent className="p-0">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-100 bg-gray-50">
                              <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                              <th className="text-left px-4 py-3 font-medium text-gray-600">Narration</th>
                              <th className="text-left px-4 py-3 font-medium text-gray-600">Category</th>
                              <th className="text-left px-4 py-3 font-medium text-gray-600">Voucher</th>
                              <th className="text-right px-4 py-3 font-medium text-gray-600">Debit</th>
                              <th className="text-right px-4 py-3 font-medium text-gray-600">Credit</th>
                              <th className="px-4 py-3" />
                            </tr>
                          </thead>
                          <tbody>
                            {(data?.unmatched_transactions ?? []).map((txn) => (
                              <tr key={txn.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                                <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{txn.transaction_date}</td>
                                <td className="px-4 py-2 max-w-[260px]">
                                  <p className="font-medium text-gray-900 truncate text-xs">{txn.narration}</p>
                                  {txn.ref_number && <p className="text-xs text-gray-400">Ref: {txn.ref_number}</p>}
                                  <p className="text-xs text-gray-400">{txn.bank_name}</p>
                                </td>
                                <td className="px-4 py-2">
                                  <CategoryChip txnId={txn.id} value={txn.category} field="category" editingTxn={editingTxn} setEditingTxn={setEditingTxn} onSave={updateTxnField} />
                                </td>
                                <td className="px-4 py-2">
                                  <CategoryChip txnId={txn.id} value={txn.voucher_type} field="voucher_type" editingTxn={editingTxn} setEditingTxn={setEditingTxn} onSave={updateTxnField} />
                                </td>
                                <td className="px-4 py-2 text-right text-red-600 font-medium text-xs">
                                  {txn.debit_amount ? fmt(txn.debit_amount) : "—"}
                                </td>
                                <td className="px-4 py-2 text-right text-green-700 font-medium text-xs">
                                  {txn.credit_amount ? fmt(txn.credit_amount) : "—"}
                                </td>
                                <td className="px-4 py-2">
                                  <Button
                                    size="sm" variant="outline"
                                    className="h-7 text-xs whitespace-nowrap"
                                    onClick={() => setLinkingTxn(txn)}
                                  >
                                    <Link2 className="w-3 h-3 mr-1" /> Link
                                  </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>

              {/* Unmatched invoices */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2 mb-3">
                  <FileText className="w-4 h-4" />
                  Invoices without payment ({data?.unmatched_invoices.length ?? 0})
                </h3>
                {(data?.unmatched_invoices ?? []).length === 0 ? (
                  <Card><CardContent className="py-8 text-center text-gray-400 text-sm">All invoices are reconciled.</CardContent></Card>
                ) : (
                  <Card>
                    <CardContent className="p-0">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-100 bg-gray-50">
                              <th className="text-left px-4 py-3 font-medium text-gray-600">File</th>
                              <th className="text-left px-4 py-3 font-medium text-gray-600">Type</th>
                              <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                              <th className="text-right px-4 py-3 font-medium text-gray-600">Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(data?.unmatched_invoices ?? []).map((doc) => (
                              <tr key={doc.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                                <td className="px-4 py-2 font-medium text-gray-900 text-xs max-w-[260px] truncate">{doc.original_filename}</td>
                                <td className="px-4 py-2 text-xs text-gray-500 capitalize">{doc.document_type?.replace(/_/g, " ")}</td>
                                <td className="px-4 py-2">
                                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${doc.status === "reviewed" ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                                    {doc.status === "reviewed" ? "Reviewed" : "Pending review"}
                                  </span>
                                </td>
                                <td className="px-4 py-2 text-right font-semibold text-gray-700 text-xs">
                                  {doc.total_amount ? fmt(doc.total_amount) : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>

              {(data?.unmatched_transactions ?? []).length === 0 && (data?.unmatched_invoices ?? []).length === 0 && (
                <Card><CardContent className="py-12 text-center text-gray-400">
                  <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-green-400" />
                  All transactions are matched.
                </CardContent></Card>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CategoryChip({
  txnId, value, field, editingTxn, setEditingTxn, onSave,
}: {
  txnId: string;
  value: string | null | undefined;
  field: "category" | "voucher_type";
  editingTxn: string | null;
  setEditingTxn: (id: string | null) => void;
  onSave: (txnId: string, field: "category" | "voucher_type", value: string) => void;
}) {
  const editKey = `${txnId}-${field}`;
  const isEditing = editingTxn === editKey;
  const options = field === "category" ? CATEGORIES : VOUCHER_TYPES;
  const chipCls = field === "category" ? "bg-blue-50 text-blue-700" : "bg-purple-50 text-purple-700";

  if (isEditing) {
    return (
      <select
        autoFocus
        className="text-xs rounded border border-blue-300 px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 max-w-[140px]"
        defaultValue={value ?? ""}
        onBlur={(e) => { if (e.target.value) onSave(txnId, field, e.target.value); else setEditingTxn(null); }}
        onChange={(e) => { if (e.target.value) onSave(txnId, field, e.target.value); }}
      >
        <option value="">— select —</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }

  return (
    <button
      className={`group inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium ${chipCls} hover:opacity-80 max-w-[140px] truncate`}
      title="Click to edit"
      onClick={() => setEditingTxn(editKey)}
    >
      <span className="truncate">{value ?? `Set ${field === "category" ? "category" : "voucher"}`}</span>
      <Pencil className="w-2.5 h-2.5 flex-shrink-0 opacity-0 group-hover:opacity-60" />
    </button>
  );
}
