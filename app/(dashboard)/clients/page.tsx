"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Building2, Plus, Loader2, ChevronRight, FileText, Clock } from "lucide-react";
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

  useEffect(() => {
    fetch("/api/v1/clients")
      .then((r) => r.json())
      .then((d) => setClients(d.clients ?? []))
      .finally(() => setLoading(false));
  }, []);

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
      setClients((prev) => [{ ...data.client, document_count: 0, pending_review: 0 }, ...prev]);
      setForm({ client_name: "", gstin: "", pan: "", industry_name: "" });
      setShowForm(false);
      toast.success("Client created");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Clients</h1>
          <p className="text-sm text-gray-500 mt-1">
            Each client is a company your firm manages. Documents, reviews, and reconciliation are organised per client.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className={buttonVariants()}
        >
          <Plus size={14} className="mr-1.5" /> New client
        </button>
      </div>

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
                    type="text"
                    required
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
                    {INDUSTRIES.map((ind) => (
                      <option key={ind} value={ind}>{ind}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">GSTIN (optional)</label>
                  <input
                    type="text"
                    value={form.gstin}
                    onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))}
                    placeholder="15-character GSTIN"
                    maxLength={15}
                    className="w-full text-sm border border-gray-200 rounded px-3 py-1.5 outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">PAN (optional)</label>
                  <input
                    type="text"
                    value={form.pan}
                    onChange={(e) => setForm((f) => ({ ...f, pan: e.target.value.toUpperCase() }))}
                    placeholder="10-character PAN"
                    maxLength={10}
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
        <div className="grid gap-3">
          {clients.map((client) => (
            <Link key={client.id} href={`/clients/${client.id}`}>
              <Card className="hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer">
                <CardContent className="py-4 px-5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                        <Building2 size={16} className="text-blue-600" />
                      </div>
                      <div>
                        <p className="font-semibold text-gray-900">{client.client_name}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {client.industry_name && (
                            <span className="text-xs text-gray-500">{client.industry_name}</span>
                          )}
                          {client.gstin && (
                            <>
                              {client.industry_name && <span className="text-gray-300">·</span>}
                              <span className="text-xs text-gray-400 font-mono">{client.gstin}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="flex items-center gap-1.5 text-xs text-gray-500">
                          <FileText size={12} />
                          <span>{client.document_count} document{client.document_count !== 1 ? "s" : ""}</span>
                        </div>
                        {client.pending_review > 0 && (
                          <div className="flex items-center gap-1 mt-0.5">
                            <Clock size={11} className="text-amber-500" />
                            <span className="text-xs text-amber-600 font-medium">{client.pending_review} pending review</span>
                          </div>
                        )}
                      </div>
                      <ChevronRight size={16} className="text-gray-300" />
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
