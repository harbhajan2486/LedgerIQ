"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Building2, ChevronLeft, FileText, Loader2, Upload,
  CheckCircle2, AlertTriangle, Clock, RefreshCw
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

const STATUS_CONFIG: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  review_required: { label: "Needs review",  cls: "bg-amber-50 text-amber-700 border-amber-200",   icon: <AlertTriangle size={10} /> },
  reviewed:        { label: "Reviewed",      cls: "bg-green-50 text-green-700 border-green-200",    icon: <CheckCircle2 size={10} /> },
  reconciled:      { label: "Reconciled",    cls: "bg-blue-50 text-blue-700 border-blue-200",       icon: <CheckCircle2 size={10} /> },
  posted:          { label: "Posted",        cls: "bg-purple-50 text-purple-700 border-purple-200", icon: <CheckCircle2 size={10} /> },
  extracting:      { label: "Processing",    cls: "bg-gray-50 text-gray-600 border-gray-200",       icon: <Loader2 size={10} className="animate-spin" /> },
  pending:         { label: "Processing",    cls: "bg-gray-50 text-gray-600 border-gray-200",       icon: <Loader2 size={10} className="animate-spin" /> },
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

const RETRYABLE = new Set(["pending", "extracting", "queued", "failed"]);

export default function ClientDetailPage() {
  const params = useParams();
  const clientId = params.clientId as string;

  const [client, setClient] = useState<Client | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);

  function loadData() {
    fetch(`/api/v1/clients/${clientId}`)
      .then((r) => r.json())
      .then((d) => {
        setClient(d.client);
        setDocuments(d.documents ?? []);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadData(); }, [clientId]);

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

      {/* Document list */}
      <Card>
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
      </Card>
    </div>
  );
}
