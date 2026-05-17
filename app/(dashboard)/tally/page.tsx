"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Loader2, Send, CheckCircle2, XCircle, AlertCircle,
  Plug, RefreshCw, FileText, Building2, Download, ChevronDown, ChevronRight,
} from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";
import { toast } from "sonner";

interface TallyDoc {
  id: string;
  original_filename: string;
  document_type: string;
  status: string;
  client_id: string | null;
  client_name: string | null;
  vendor_name: string | null;
  total_amount: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  posting: { status: string; posted_at: string | null } | null;
}

interface ClientInQueue {
  id: string;
  name: string;
}

const DOC_TYPE_LABEL: Record<string, string> = {
  sales_invoice:    "Sales Voucher",
  purchase_invoice: "Purchase Voucher",
  expense:          "Payment Voucher",
  credit_note:      "Credit Note",
  debit_note:       "Debit Note",
};

const DOC_TYPE_COLOR: Record<string, string> = {
  sales_invoice:    "bg-blue-50 text-blue-700 border-blue-200",
  purchase_invoice: "bg-purple-50 text-purple-700 border-purple-200",
  expense:          "bg-orange-50 text-orange-700 border-orange-200",
  credit_note:      "bg-green-50 text-green-700 border-green-200",
  debit_note:       "bg-red-50 text-red-700 border-red-200",
};

export default function TallyPage() {
  const [docs, setDocs] = useState<TallyDoc[]>([]);
  const [clientsInQueue, setClientsInQueue] = useState<ClientInQueue[]>([]);
  const [tallyEndpoint, setTallyEndpoint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tallyStatus, setTallyStatus] = useState<"idle" | "checking" | "connected" | "error">("idle");
  const [postingIds, setPostingIds] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, { success: boolean; error?: string }>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filterClient, setFilterClient] = useState<string>("all");

  const loadQueue = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/v1/tally/queue");
    if (res.ok) {
      const d = await res.json();
      setDocs(d.documents ?? []);
      setTallyEndpoint(d.tally_endpoint ?? null);
      setClientsInQueue(d.clients_in_queue ?? []);
      // Auto-test connection whenever we load
      if (d.tally_endpoint) testConnection(d.tally_endpoint);
    }
    setLoading(false);
  }, []); // eslint-disable-line

  useEffect(() => { loadQueue(); }, [loadQueue]);

  async function testConnection(endpoint?: string) {
    const ep = endpoint ?? tallyEndpoint;
    if (!ep) return;
    setTallyStatus("checking");
    const res = await fetch("/api/v1/tally/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: ep }),
    });
    setTallyStatus(res.ok ? "connected" : "error");
  }

  async function postDoc(docId: string): Promise<boolean> {
    setPostingIds((prev) => new Set(prev).add(docId));
    const res = await fetch("/api/v1/tally/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: docId }),
    });
    const data = await res.json();
    const success = res.ok && data.success;
    setResults((prev) => ({ ...prev, [docId]: { success, error: data.error ?? undefined } }));
    setPostingIds((prev) => { const n = new Set(prev); n.delete(docId); return n; });
    if (success) {
      setDocs((prev) => prev.filter((d) => d.id !== docId));
      setSelected((prev) => { const n = new Set(prev); n.delete(docId); return n; });
    } else if (data.already_posted) {
      toast.warning("Already posted — duplicate blocked.");
    } else {
      toast.error(data.error ?? "Failed to post. Check Tally is open.");
    }
    return success;
  }

  async function postSelected() {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    let ok = 0;
    for (const id of ids) {
      const success = await postDoc(id);
      if (success) ok++;
    }
    setSelected(new Set());
    if (ok > 0) toast.success(`${ok} of ${ids.length} voucher${ids.length > 1 ? "s" : ""} posted to Tally.`);
  }

  const pendingDocs = docs.filter((d) => !d.posting || d.posting.status === "failed");
  const postedDocs  = docs.filter((d) => d.posting?.status === "success");

  const visiblePending = filterClient === "all"
    ? pendingDocs
    : pendingDocs.filter((d) => d.client_id === filterClient);

  // Group by client
  const byClient: Record<string, { name: string; docs: TallyDoc[] }> = {};
  for (const doc of visiblePending) {
    const key = doc.client_id ?? "__unknown__";
    if (!byClient[key]) byClient[key] = { name: doc.client_name ?? "Unknown client", docs: [] };
    byClient[key].docs.push(doc);
  }
  const clientGroups = Object.entries(byClient).sort(([, a], [, b]) => a.name.localeCompare(b.name));

  const allPendingIds = visiblePending.map((d) => d.id);
  const allSelected   = allPendingIds.length > 0 && allPendingIds.every((id) => selected.has(id));

  function toggleAll() {
    if (allSelected) {
      setSelected((prev) => { const n = new Set(prev); allPendingIds.forEach((id) => n.delete(id)); return n; });
    } else {
      setSelected((prev) => { const n = new Set(prev); allPendingIds.forEach((id) => n.add(id)); return n; });
    }
  }

  function toggleGroup(clientId: string, groupDocs: TallyDoc[]) {
    const ids = groupDocs.map((d) => d.id);
    const allGroupSelected = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const n = new Set(prev);
      if (allGroupSelected) ids.forEach((id) => n.delete(id));
      else ids.forEach((id) => n.add(id));
      return n;
    });
    // Auto-expand group when selecting
    if (!allGroupSelected) {
      setCollapsed((prev) => { const n = new Set(prev); n.delete(clientId); return n; });
    }
  }

  const isPosting = postingIds.size > 0;

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Post to Tally</h1>
          <p className="text-sm text-gray-500 mt-1">
            Send reviewed invoices to TallyPrime. Voucher type is auto-determined by document type.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => window.open("/api/v1/tally/export-excel?period=this_month")}>
            <Download className="w-4 h-4 mr-1.5" /> Export Excel
          </Button>
          <Button variant="outline" size="sm" onClick={loadQueue} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      {/* Connection status — compact strip */}
      <div className={`flex items-center justify-between px-4 py-2.5 rounded-lg border text-sm ${
        tallyStatus === "connected" ? "bg-green-50 border-green-200" :
        tallyStatus === "error"     ? "bg-red-50 border-red-200" :
        "bg-gray-50 border-gray-200"
      }`}>
        <div className="flex items-center gap-2.5">
          <Plug className={`w-4 h-4 ${
            tallyStatus === "connected" ? "text-green-500" :
            tallyStatus === "error"     ? "text-red-500" : "text-gray-400"
          }`} />
          <span className={`font-medium ${
            tallyStatus === "connected" ? "text-green-800" :
            tallyStatus === "error"     ? "text-red-800" : "text-gray-700"
          }`}>
            {tallyStatus === "connected" ? "TallyPrime connected" :
             tallyStatus === "error"     ? "Cannot reach TallyPrime — ensure it is open" :
             tallyStatus === "checking"  ? "Checking connection…" :
             tallyEndpoint               ? tallyEndpoint : "Tally not configured"}
          </span>
          {tallyStatus === "connected" && <CheckCircle2 className="w-4 h-4 text-green-500" />}
          {tallyStatus === "error"     && <XCircle className="w-4 h-4 text-red-500" />}
        </div>
        <div className="flex items-center gap-2">
          {tallyEndpoint ? (
            <button
              onClick={() => testConnection()}
              disabled={tallyStatus === "checking"}
              className="text-xs text-gray-500 hover:text-gray-800 underline disabled:opacity-50"
            >
              {tallyStatus === "checking" ? "Checking…" : "Re-test"}
            </button>
          ) : (
            <Link href="/settings" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Configure
            </Link>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-12 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading posting queue…
        </div>
      ) : (
        <>
          {/* Controls row */}
          {pendingDocs.length > 0 && (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="rounded"
                  />
                  Select all ({allPendingIds.length})
                </label>
                {clientsInQueue.length > 1 && (
                  <select
                    value={filterClient}
                    onChange={(e) => { setFilterClient(e.target.value); setSelected(new Set()); }}
                    className="text-sm border border-gray-200 rounded px-2 py-1 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  >
                    <option value="all">All clients</option>
                    {clientsInQueue.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}
              </div>
              <div className="flex items-center gap-2">
                {selected.size > 0 && (
                  <Button
                    size="sm"
                    onClick={postSelected}
                    disabled={isPosting || tallyStatus !== "connected"}
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    {isPosting
                      ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Posting…</>
                      : <><Send className="w-3.5 h-3.5 mr-1.5" /> Post {selected.size} selected</>
                    }
                  </Button>
                )}
              </div>
            </div>
          )}

          {tallyStatus !== "connected" && pendingDocs.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-4 py-2.5">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              Open TallyPrime on this computer, then click Re-test above before posting.
            </div>
          )}

          {/* Client groups */}
          {clientGroups.length > 0 ? (
            <div className="space-y-3">
              {clientGroups.map(([clientId, { name, docs: groupDocs }]) => {
                const isCollapsed = collapsed.has(clientId);
                const groupIds = groupDocs.map((d) => d.id);
                const groupAllSelected = groupIds.every((id) => selected.has(id));
                const groupSomeSelected = groupIds.some((id) => selected.has(id));
                return (
                  <Card key={clientId} className="overflow-hidden">
                    {/* Group header */}
                    <div
                      className="flex items-center gap-3 px-4 py-3 bg-gray-50 border-b border-gray-100 cursor-pointer hover:bg-gray-100 transition-colors"
                      onClick={() => setCollapsed((prev) => {
                        const n = new Set(prev);
                        isCollapsed ? n.delete(clientId) : n.add(clientId);
                        return n;
                      })}
                    >
                      <input
                        type="checkbox"
                        checked={groupAllSelected}
                        ref={(el) => { if (el) el.indeterminate = groupSomeSelected && !groupAllSelected; }}
                        onChange={(e) => { e.stopPropagation(); toggleGroup(clientId, groupDocs); }}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded"
                      />
                      <Building2 className="w-4 h-4 text-gray-400" />
                      <span className="text-sm font-semibold text-gray-800 flex-1">{name}</span>
                      <span className="text-xs text-gray-400 font-medium">{groupDocs.length} voucher{groupDocs.length !== 1 ? "s" : ""}</span>
                      {isCollapsed ? <ChevronRight className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                    </div>

                    {/* Doc rows */}
                    {!isCollapsed && (
                      <div className="divide-y divide-gray-50">
                        {groupDocs.map((doc) => {
                          const result = results[doc.id];
                          const isDocPosting = postingIds.has(doc.id);
                          const hasFailed = doc.posting?.status === "failed" || result?.success === false;
                          const voucherLabel = DOC_TYPE_LABEL[doc.document_type] ?? doc.document_type;
                          const voucherColor = DOC_TYPE_COLOR[doc.document_type] ?? "bg-gray-100 text-gray-600 border-gray-200";

                          return (
                            <div key={doc.id} className={`flex items-center gap-3 px-4 py-3 ${hasFailed ? "bg-red-50" : "hover:bg-gray-50/60"}`}>
                              <input
                                type="checkbox"
                                checked={selected.has(doc.id)}
                                onChange={() => setSelected((prev) => { const n = new Set(prev); n.has(doc.id) ? n.delete(doc.id) : n.add(doc.id); return n; })}
                                className="rounded flex-shrink-0"
                              />
                              <FileText className="w-4 h-4 text-gray-300 flex-shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${voucherColor}`}>
                                    {voucherLabel}
                                  </span>
                                  <p className="text-sm text-gray-800 truncate">{doc.original_filename}</p>
                                </div>
                                <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400">
                                  {doc.vendor_name && <span>{doc.vendor_name}</span>}
                                  {doc.invoice_number && <span>#{doc.invoice_number}</span>}
                                  {doc.invoice_date && <span>{doc.invoice_date}</span>}
                                  {hasFailed && (
                                    <span className="text-red-600">{result?.error ?? "Posting failed — retry"}</span>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-3 flex-shrink-0">
                                {doc.total_amount && (
                                  <span className="text-sm font-semibold text-gray-700">
                                    ₹{Number(doc.total_amount).toLocaleString("en-IN")}
                                  </span>
                                )}
                                <Button
                                  size="sm"
                                  variant={hasFailed ? "destructive" : "outline"}
                                  onClick={() => postDoc(doc.id)}
                                  disabled={isDocPosting || tallyStatus !== "connected"}
                                  className="text-xs"
                                >
                                  {isDocPosting
                                    ? <Loader2 className="w-3 h-3 animate-spin" />
                                    : <><Send className="w-3 h-3 mr-1" />{hasFailed ? "Retry" : "Post"}</>
                                  }
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          ) : (
            <Card>
              <CardContent className="py-14 text-center">
                <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-3" />
                <p className="text-gray-700 font-medium">Nothing in the posting queue</p>
                <p className="text-sm text-gray-400 mt-1">
                  Reviewed invoices will appear here. Go to{" "}
                  <Link href="/review" className="text-blue-600 hover:underline">Inbox</Link>{" "}
                  to process pending documents.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Posted history */}
          {postedDocs.length > 0 && (
            <div className="space-y-2 pt-2">
              <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> Posted this session ({postedDocs.length})
              </h2>
              <Card>
                <CardContent className="p-0">
                  <div className="divide-y divide-gray-50">
                    {postedDocs.map((doc) => (
                      <div key={doc.id} className="flex items-center justify-between px-4 py-2.5">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${DOC_TYPE_COLOR[doc.document_type] ?? "bg-gray-100 border-gray-200 text-gray-500"}`}>
                              {DOC_TYPE_LABEL[doc.document_type] ?? doc.document_type}
                            </span>
                            <p className="text-sm text-gray-700">{doc.original_filename}</p>
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {doc.client_name && <span>{doc.client_name} · </span>}
                            {doc.vendor_name}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          {doc.total_amount && (
                            <span className="text-sm text-gray-600">₹{Number(doc.total_amount).toLocaleString("en-IN")}</span>
                          )}
                          <span className="text-xs font-medium bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Posted</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}
