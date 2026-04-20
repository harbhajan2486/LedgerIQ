"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ClipboardCheck, FileText, ChevronRight, AlertTriangle, RefreshCw, Loader2 } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";
import { toast } from "sonner";

interface QueueItem {
  id: string;
  fileName: string;
  type: string;
  uploadedAt: string;
  totalFields: number;
  lowConfidenceFields: number;
  avgConfidence: number;
}

interface StuckItem {
  id: string;
  fileName: string;
  type: string;
  status: string;
  uploadedAt: string;
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

  useEffect(() => { loadQueue(); }, []);

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
            <Link key={item.id} href={`/review/${item.id}`}>
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
          ))}
        </div>
      )}
    </div>
  );
}
