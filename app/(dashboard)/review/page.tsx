"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ClipboardCheck, FileText, ChevronRight, AlertTriangle, RefreshCw, Loader2, Trash2, Building2 } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface QueueItem {
  id: string;
  fileName: string;
  type: string;
  uploadedAt: string;
  totalFields: number;
  lowConfidenceFields: number;
  avgConfidence: number;
  client_id: string | null;
  client_name: string | null;
}

interface StuckItem {
  id: string;
  fileName: string;
  type: string;
  status: string;
  uploadedAt: string;
}

interface ClientOption {
  id: string;
  client_name: string;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  purchase_invoice: "Purchase Invoice",
  sales_invoice:    "Sales Invoice",
  expense:          "Expense Bill",
  bank_statement:   "Bank Statement",
  credit_note:      "Credit Note",
  debit_note:       "Debit Note",
};

const STATUS_LABELS: Record<string, string> = {
  pending:    "Waiting to process",
  extracting: "AI reading…",
  queued:     "Budget limit — queued",
  failed:     "Extraction failed",
};

export default function InboxPage() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [stuck, setStuck] = useState<StuckItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; fileName: string } | null>(null);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [assigningTo, setAssigningTo] = useState<string | null>(null);

  function loadQueue() {
    fetch("/api/v1/review/queue")
      .then((r) => r.json())
      .then((d) => {
        setQueue(d.queue ?? []);
        setStuck(d.stuck ?? []);
        setLoading(false);
      })
      .catch(() => { setError("Failed to load review queue."); setLoading(false); });
  }

  useEffect(() => {
    loadQueue();
    fetch("/api/v1/clients").then((r) => r.json()).then((d) => setClients(d.clients ?? [])).catch(() => {});
  }, []);

  async function performDelete(docId: string, fileName: string) {
    setDeleting(docId);
    try {
      const res = await fetch(`/api/v1/documents/${docId}`, { method: "DELETE" });
      if (res.ok) {
        toast.success(`"${fileName}" archived.`);
        setQueue((prev) => prev.filter((d) => d.id !== docId));
        setStuck((prev) => prev.filter((d) => d.id !== docId));
        setDeleteTarget(null);
      } else {
        const data = await res.json();
        toast.error(data.error ?? "Could not archive document.");
      }
    } finally {
      setDeleting(null);
    }
  }

  async function retryExtraction(docId: string, fileName: string) {
    setRetrying(docId);
    try {
      const res = await fetch(`/api/v1/documents/${docId}/retry`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Extraction started for "${fileName}". Check back in 30–60 seconds.`);
        setStuck((prev) => prev.filter((d) => d.id !== docId));
      } else {
        toast.error(data.error ?? "Could not retry extraction.");
      }
    } finally {
      setRetrying(null);
    }
  }

  async function assignClient(docId: string, clientId: string) {
    const client = clients.find((c) => c.id === clientId);
    if (!client) return;
    const res = await fetch(`/api/v1/documents/${docId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId }),
    });
    if (res.ok) {
      toast.success(`Assigned to ${client.client_name}`);
      setQueue((prev) => prev.map((d) => d.id === docId ? { ...d, client_id: clientId, client_name: client.client_name } : d));
      setAssigningTo(null);
    } else {
      const d = await res.json();
      toast.error(d.error ?? "Could not assign client");
    }
  }

  if (loading) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div>
          <Skeleton className="h-7 w-40 mb-2" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  <Skeleton className="w-9 h-9 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                  <Skeleton className="h-6 w-24 rounded-full" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Inbox</h1>
          <p className="text-sm text-gray-500 mt-1">
            Documents waiting for your review across all clients. Every correction teaches the system.
          </p>
        </div>
        {queue.length > 0 && (
          <span className="text-sm font-medium text-gray-500">
            {queue.length} document{queue.length > 1 ? "s" : ""} waiting
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-md">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {/* Stuck documents — need retry */}
      {stuck.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Stuck — needs retry</p>
          {stuck.map((item) => (
            <Card key={item.id} className="border-amber-200 bg-amber-50">
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  <div className="w-9 h-9 bg-amber-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <AlertTriangle size={16} className="text-amber-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{item.fileName}</p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      {STATUS_LABELS[item.status] ?? item.status} · uploaded {new Date(item.uploadedAt).toLocaleDateString("en-IN")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => retryExtraction(item.id, item.fileName)}
                      disabled={retrying === item.id}
                      className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-amber-300 text-amber-700 hover:bg-amber-100 disabled:opacity-50 transition-colors"
                    >
                      {retrying === item.id
                        ? <><Loader2 size={12} className="animate-spin" /> Retrying…</>
                        : <><RefreshCw size={12} /> Retry</>
                      }
                    </button>
                    <button
                      onClick={() => setDeleteTarget({ id: item.id, fileName: item.fileName })}
                      disabled={deleting === item.id}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-gray-200 text-gray-400 hover:border-red-300 hover:text-red-500 disabled:opacity-50 transition-colors"
                      title="Delete document"
                    >
                      {deleting === item.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                    </button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Empty state */}
      {queue.length === 0 && stuck.length === 0 && !error && (
        <Card className="border-dashed border-2 border-gray-200">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-12 h-12 bg-green-50 rounded-full flex items-center justify-center mb-4">
              <ClipboardCheck size={24} className="text-green-500" />
            </div>
            <h3 className="text-base font-medium text-gray-900 mb-1">All caught up!</h3>
            <p className="text-sm text-gray-500 max-w-sm mb-6">
              No documents waiting for review. Open a client to get started.
            </p>
            <Link href="/clients" className={buttonVariants()}>
              Go to Clients
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Queue list */}
      {queue.length > 0 && (
        <div className="space-y-2">
          {queue.map((item) => (
            <div key={item.id} className="relative group">
              <Link href={`/review/${item.id}`}>
                <Card className="hover:shadow-md transition-shadow cursor-pointer">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-4">
                      <div className="w-9 h-9 bg-gray-100 rounded-lg flex items-center justify-center flex-shrink-0">
                        <FileText size={16} className="text-gray-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-sm font-medium text-gray-900 truncate">{item.fileName}</p>
                          <span className="text-xs text-gray-400 flex-shrink-0">
                            {DOC_TYPE_LABELS[item.type] ?? item.type}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-gray-400">
                          <span>{item.totalFields} fields extracted</span>
                          <span>·</span>
                          <span>{new Date(item.uploadedAt).toLocaleDateString("en-IN")}</span>
                          {item.client_name ? (
                            <span className="flex items-center gap-1 text-blue-600">
                              <Building2 size={10} /> {item.client_name}
                            </span>
                          ) : (
                            assigningTo === item.id ? (
                              <select
                                autoFocus
                                className="text-xs border border-amber-300 rounded px-1.5 py-0.5 bg-white"
                                defaultValue=""
                                onChange={(e) => { if (e.target.value) assignClient(item.id, e.target.value); }}
                                onBlur={() => setAssigningTo(null)}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <option value="" disabled>Select client…</option>
                                {clients.map((c) => <option key={c.id} value={c.id}>{c.client_name}</option>)}
                              </select>
                            ) : (
                              <button
                                onClick={(e) => { e.preventDefault(); setAssigningTo(item.id); }}
                                className="flex items-center gap-1 text-amber-600 hover:text-amber-800 font-medium"
                              >
                                <AlertTriangle size={10} /> No client — assign
                              </button>
                            )
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        {item.lowConfidenceFields > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-medium">
                            <AlertTriangle size={10} />
                            {item.lowConfidenceFields} need attention
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700 font-medium">
                            {item.avgConfidence}% confident
                          </span>
                        )}
                        <ChevronRight size={16} className="text-gray-400" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
              <button
                onClick={(e) => { e.preventDefault(); setDeleteTarget({ id: item.id, fileName: item.fileName }); }}
                disabled={deleting === item.id}
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1.5 rounded bg-white border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-300 transition-all shadow-sm disabled:opacity-50"
                title="Delete document"
              >
                {deleting === item.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              </button>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={`Archive "${deleteTarget?.fileName}"?`}
        description="This document will be removed from your active workspace. It is retained permanently in our records as required by CGST Act Section 35 (6-year retention). You can request recovery by contacting support."
        confirmLabel="Archive document"
        loading={!!deleting}
        onConfirm={() => deleteTarget && performDelete(deleteTarget.id, deleteTarget.fileName)}
        variant="warning"
      />
    </div>
  );
}
