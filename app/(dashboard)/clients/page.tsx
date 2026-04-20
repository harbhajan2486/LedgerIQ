"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Building2, Plus, Loader2, ChevronRight, FileText, AlertTriangle, GitMerge, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";
import { toast } from "sonner";

interface Client {
  id: string;
  client_name: string;
  gstin: string | null;
  pan: string | null;
  industry_name: string | null;
  document_count: number;
  pending_review: number;
  unreconciled: number;
  created_at: string;
}

const INDUSTRIES = [
  "IT Services", "Manufacturing", "Restaurant & Food Service",
  "Healthcare", "Real Estate & Construction", "Retail / Trading",
  "Logistics & Transport", "Education", "Finance & Banking", "Other",
];

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ client_name: "", gstin: "", pan: "", industry_name: "" });

  function load() {
    setLoading(true);
    fetch("/api/v1/clients")
      .then((r) => r.json())
      .then((d) => setClients(d.clients ?? []))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  async function createClient(e: React.FormEvent) {
    e.preventDefault();
    if (!form.client_name.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/v1/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: form.client_name.trim(),
          gstin: form.gstin.trim() || null,
          pan: form.pan.trim() || null,
          industry_name: form.industry_name || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to create client"); return; }
      setForm({ client_name: "", gstin: "", pan: "", industry_name: "" });
      setShowForm(false);
      toast.success("Client created");
      load();
    } finally {
      setSaving(false);
    }
  }

  // Sorted: clients with work pending first, then alphabetical
  const sorted = [...clients].sort((a, b) => {
    const aWork = a.pending_review + a.unreconciled;
    const bWork = b.pending_review + b.unreconciled;
    if (aWork !== bWork) return bWork - aWork;
    return a.client_name.localeCompare(b.client_name);
  });

  const totalPending     = clients.reduce((s, c) => s + c.pending_review, 0);
  const totalUnreconciled = clients.reduce((s, c) => s + c.unreconciled, 0);

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Clients</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            All clients managed by your firm. Documents, reviews, and reconciliation are per client.
          </p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className={buttonVariants({ size: "sm" })}>
          <Plus size={13} className="mr-1.5" /> New client
        </button>
      </div>

      {/* Summary banner — only show if there's work to do */}
      {!loading && (totalPending > 0 || totalUnreconciled > 0) && (
        <div className="flex gap-3">
          {totalPending > 0 && (
            <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
              <AlertTriangle size={13} />
              <span><strong>{totalPending}</strong> document{totalPending !== 1 ? "s" : ""} pending review</span>
              <Link href="/review" className="underline font-medium hover:text-amber-900">Open Inbox →</Link>
            </div>
          )}
          {totalUnreconciled > 0 && (
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700">
              <GitMerge size={13} />
              <span><strong>{totalUnreconciled}</strong> unreconciled transaction{totalUnreconciled !== 1 ? "s" : ""} across clients</span>
            </div>
          )}
        </div>
      )}

      {/* New client form */}
      {showForm && (
        <Card className="border-blue-200 bg-blue-50/40">
          <CardContent className="pt-5 pb-4">
            <form onSubmit={createClient} className="space-y-4">
              <h2 className="text-sm font-semibold text-gray-800">Add new client</h2>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Company name *</label>
                  <input
                    type="text" required
                    value={form.client_name}
                    onChange={(e) => setForm((f) => ({ ...f, client_name: e.target.value }))}
                    placeholder="e.g. Tata Steel Ltd"
                    className="w-full text-sm border border-gray-200 rounded px-3 py-1.5 outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Industry</label>
                  <select
                    value={form.industry_name}
                    onChange={(e) => setForm((f) => ({ ...f, industry_name: e.target.value }))}
                    className="w-full text-sm border border-gray-200 rounded px-3 py-1.5 bg-white outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select industry…</option>
                    {INDUSTRIES.map((ind) => <option key={ind} value={ind}>{ind}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">GSTIN (optional)</label>
                  <input
                    type="text"
                    value={form.gstin}
                    onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))}
                    placeholder="15-character GSTIN" maxLength={15}
                    className="w-full text-sm border border-gray-200 rounded px-3 py-1.5 outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">PAN (optional)</label>
                  <input
                    type="text"
                    value={form.pan}
                    onChange={(e) => setForm((f) => ({ ...f, pan: e.target.value.toUpperCase() }))}
                    placeholder="10-character PAN" maxLength={10}
                    className="w-full text-sm border border-gray-200 rounded px-3 py-1.5 outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={saving} className={buttonVariants()}>
                  {saving && <Loader2 size={12} className="mr-1.5 animate-spin" />}
                  {saving ? "Saving…" : "Save client"}
                </button>
                <button type="button" onClick={() => setShowForm(false)} className={buttonVariants({ variant: "outline" })}>
                  Cancel
                </button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Client list */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-400 py-8">
          <Loader2 size={16} className="animate-spin" /> Loading clients…
        </div>
      ) : clients.length === 0 ? (
        <div className="text-center py-16">
          <Building2 size={36} className="text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 font-medium">No clients yet</p>
          <p className="text-sm text-gray-400 mt-1">Add your first client to start organising documents.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Column headers */}
          <div className="hidden sm:grid grid-cols-[1fr_auto] px-5 text-xs text-gray-400 font-medium uppercase tracking-wide">
            <span>Client</span>
            <span className="text-right pr-8">Activity</span>
          </div>

          {sorted.map((client) => {
            const hasWork = client.pending_review > 0 || client.unreconciled > 0;
            return (
              <Link key={client.id} href={`/clients/${client.id}`}>
                <Card className={`hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer ${hasWork ? "border-amber-200" : ""}`}>
                  <CardContent className="py-3.5 px-5">
                    <div className="flex items-center justify-between gap-4">
                      {/* Left: client identity */}
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${hasWork ? "bg-amber-100" : "bg-blue-50"}`}>
                          <Building2 size={14} className={hasWork ? "text-amber-600" : "text-blue-500"} />
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900 text-sm truncate">{client.client_name}</p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            {client.industry_name && (
                              <span className="text-xs text-gray-400">{client.industry_name}</span>
                            )}
                            {client.gstin && (
                              <>
                                {client.industry_name && <span className="text-gray-200">·</span>}
                                <span className="text-xs text-gray-300 font-mono">{client.gstin}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Right: activity signals */}
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <div className="flex items-center gap-2 text-xs">
                          {client.document_count > 0 && (
                            <span className="flex items-center gap-1 text-gray-400">
                              <FileText size={11} /> {client.document_count}
                            </span>
                          )}
                          {client.pending_review > 0 ? (
                            <span className="flex items-center gap-1 bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full font-medium">
                              <AlertTriangle size={10} /> {client.pending_review} review
                            </span>
                          ) : null}
                          {client.unreconciled > 0 ? (
                            <span className="flex items-center gap-1 bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full font-medium">
                              <GitMerge size={10} /> {client.unreconciled} unreconciled
                            </span>
                          ) : null}
                          {!hasWork && client.document_count > 0 && (
                            <span className="flex items-center gap-1 text-green-600 text-xs">
                              <CheckCircle2 size={11} /> Up to date
                            </span>
                          )}
                        </div>
                        <ChevronRight size={14} className="text-gray-300" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
