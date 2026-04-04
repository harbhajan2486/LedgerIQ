"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ClipboardCheck, FileText, ChevronRight, Loader2, AlertTriangle, Upload } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";

interface QueueItem {
  id: string;
  fileName: string;
  type: string;
  uploadedAt: string;
  totalFields: number;
  lowConfidenceFields: number;
  avgConfidence: number;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  purchase_invoice: "Purchase Invoice",
  sales_invoice:    "Sales Invoice",
  expense:          "Expense Bill",
  bank_statement:   "Bank Statement",
  credit_note:      "Credit Note",
  debit_note:       "Debit Note",
};

export default function ReviewQueuePage() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v1/review/queue")
      .then((r) => r.json())
      .then((d) => { setQueue(d.queue ?? []); setLoading(false); })
      .catch(() => { setError("Failed to load review queue."); setLoading(false); });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={24} className="animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Review Queue</h1>
          <p className="text-sm text-gray-500 mt-1">
            Check and correct AI-extracted fields. Every correction teaches the system.
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

      {/* Empty state */}
      {queue.length === 0 && !error && (
        <Card className="border-dashed border-2 border-gray-200">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-12 h-12 bg-green-50 rounded-full flex items-center justify-center mb-4">
              <ClipboardCheck size={24} className="text-green-500" />
            </div>
            <h3 className="text-base font-medium text-gray-900 mb-1">All caught up!</h3>
            <p className="text-sm text-gray-500 max-w-sm mb-6">
              No documents waiting for review. Upload invoices or bank statements to get started.
            </p>
            <Link href="/upload" className={buttonVariants()}>
              <Upload size={14} className="mr-2" /> Upload documents
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
