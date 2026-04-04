"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, Send, CheckCircle2, XCircle, AlertCircle,
  Plug, RefreshCw, FileText, Building2
} from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";

interface TallyDoc {
  id: string;
  original_filename: string;
  document_type: string;
  status: string;
  vendor_name: string | null;
  total_amount: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  posting: { status: string; posted_at: string | null } | null;
}

export default function TallyPage() {
  const [docs, setDocs] = useState<TallyDoc[]>([]);
  const [tallyEndpoint, setTallyEndpoint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tallyStatus, setTallyStatus] = useState<"idle" | "checking" | "connected" | "error">("idle");
  const [postingId, setPostingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { success: boolean; error?: string }>>({});
  const [bulkPosting, setBulkPosting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const loadQueue = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/v1/tally/queue");
    if (res.ok) {
      const d = await res.json();
      setDocs(d.documents ?? []);
      setTallyEndpoint(d.tally_endpoint ?? null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  async function testConnection() {
    if (!tallyEndpoint) return;
    setTallyStatus("checking");
    const res = await fetch("/api/v1/tally/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: tallyEndpoint }),
    });
    setTallyStatus(res.ok ? "connected" : "error");
  }

  async function postDoc(docId: string) {
    setPostingId(docId);
    setResults((prev) => ({ ...prev, [docId]: undefined as unknown as { success: boolean } }));
    const res = await fetch("/api/v1/tally/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId: docId }),
    });
    const data = await res.json();
    setResults((prev) => ({
      ...prev,
      [docId]: { success: res.ok && data.success, error: data.error ?? undefined },
    }));
    setPostingId(null);
    if (data.success) {
      setDocs((prev) => prev.filter((d) => d.id !== docId));
    }
  }

  async function postSelected() {
    if (selected.size === 0) return;
    setBulkPosting(true);
    for (const docId of Array.from(selected)) {
      await postDoc(docId);
    }
    setSelected(new Set());
    setBulkPosting(false);
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const pendingDocs = docs.filter((d) => !d.posting || d.posting.status === "failed");
  const postedDocs = docs.filter((d) => d.posting?.status === "success");

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Post to Tally</h1>
          <p className="text-sm text-gray-500 mt-1">
            Send reviewed invoices to TallyPrime as purchase vouchers.
          </p>
        </div>
        <Button variant="outline" onClick={loadQueue} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* Tally connection status */}
      <Card className={`border-l-4 ${
        tallyStatus === "connected" ? "border-l-green-400" :
        tallyStatus === "error" ? "border-l-red-400" :
        "border-l-gray-300"
      }`}>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Plug className="w-5 h-5 text-gray-400" />
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {tallyEndpoint ? tallyEndpoint : "Tally not configured"}
                </p>
                <p className="text-xs text-gray-500">
                  {tallyStatus === "connected" ? "Connected — TallyPrime is running" :
                   tallyStatus === "error" ? "Cannot connect — open TallyPrime and try again" :
                   tallyStatus === "checking" ? "Checking..." :
                   "Not tested — click Test to check connection"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {tallyStatus === "connected" && <CheckCircle2 className="w-5 h-5 text-green-500" />}
              {tallyStatus === "error" && <XCircle className="w-5 h-5 text-red-500" />}
              {tallyEndpoint ? (
                <Button variant="outline" size="sm" onClick={testConnection} disabled={tallyStatus === "checking"}>
                  {tallyStatus === "checking" ? <Loader2 className="w-3 h-3 animate-spin" /> : "Test connection"}
                </Button>
              ) : (
                <Link href="/settings" className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Configure in Settings
                </Link>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading queue...
        </div>
      ) : (
        <>
          {/* Ready to post */}
          {pendingDocs.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  Ready to post ({pendingDocs.length})
                </h2>
                {selected.size > 0 && (
                  <Button
                    size="sm"
                    onClick={postSelected}
                    disabled={bulkPosting || tallyStatus !== "connected"}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    {bulkPosting ? <Loader2 className="w-4 h-4 animate-spin" /> : `Post ${selected.size} selected`}
                  </Button>
                )}
              </div>

              {tallyStatus !== "connected" && (
                <div className="flex items-center gap-2 text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-md p-3">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  Test your Tally connection above before posting.
                </div>
              )}

              {pendingDocs.map((doc) => {
                const result = results[doc.id];
                const isPosting = postingId === doc.id;
                const hasFailed = doc.posting?.status === "failed" || result?.success === false;

                return (
                  <Card key={doc.id} className={`${hasFailed ? "border-red-200" : ""}`}>
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={selected.has(doc.id)}
                          onChange={() => toggleSelect(doc.id)}
                          className="mt-1"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-900 truncate">{doc.original_filename}</p>
                              <div className="flex items-center gap-2 mt-0.5">
                                {doc.vendor_name && (
                                  <span className="text-xs text-gray-500 flex items-center gap-1">
                                    <Building2 className="w-3 h-3" /> {doc.vendor_name}
                                  </span>
                                )}
                                {doc.invoice_number && (
                                  <span className="text-xs text-gray-400">#{doc.invoice_number}</span>
                                )}
                                {doc.invoice_date && (
                                  <span className="text-xs text-gray-400">{doc.invoice_date}</span>
                                )}
                              </div>
                              {hasFailed && (
                                <p className="text-xs text-red-600 mt-1">
                                  {result?.error ?? "Posting failed — check Tally is open and try again"}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-3 flex-shrink-0">
                              {doc.total_amount && (
                                <span className="text-sm font-semibold text-gray-700">
                                  ₹{Number(doc.total_amount).toLocaleString("en-IN")}
                                </span>
                              )}
                              <Badge variant="secondary" className="text-xs capitalize">
                                {doc.status}
                              </Badge>
                              <Button
                                size="sm"
                                onClick={() => postDoc(doc.id)}
                                disabled={isPosting || tallyStatus !== "connected"}
                              >
                                {isPosting
                                  ? <Loader2 className="w-3 h-3 animate-spin" />
                                  : <><Send className="w-3 h-3 mr-1" /> Post</>
                                }
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {pendingDocs.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center">
                <CheckCircle2 className="w-10 h-10 text-green-400 mx-auto mb-3" />
                <p className="text-gray-700 font-medium">Nothing in the posting queue</p>
                <p className="text-sm text-gray-500 mt-1">
                  Reviewed invoices will appear here. Go to{" "}
                  <Link href="/review" className="text-blue-600 hover:underline">Review Queue</Link>{" "}
                  to process pending documents.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Already posted */}
          {postedDocs.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> Posted ({postedDocs.length})
              </h2>
              <Card>
                <CardContent className="p-0">
                  <div className="divide-y divide-gray-50">
                    {postedDocs.map((doc) => (
                      <div key={doc.id} className="flex items-center justify-between px-4 py-3">
                        <div>
                          <p className="text-sm text-gray-700">{doc.original_filename}</p>
                          {doc.vendor_name && <p className="text-xs text-gray-400">{doc.vendor_name}</p>}
                        </div>
                        <div className="flex items-center gap-2">
                          {doc.total_amount && (
                            <span className="text-sm text-gray-600">₹{Number(doc.total_amount).toLocaleString("en-IN")}</span>
                          )}
                          <Badge className="bg-green-100 text-green-700 text-xs">Posted</Badge>
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
