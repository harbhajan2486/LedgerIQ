"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Building2, Users, FileText, TrendingUp } from "lucide-react";

interface TenantRow {
  id: string;
  name: string;
  created_at: string;
  subscription_plan: string;
  subscription_status: string;
  user_count: number;
  doc_count: number;
  correction_count: number;
  ai_spend_total: number;
}

const PLAN_COLORS: Record<string, string> = {
  starter: "bg-gray-100 text-gray-700",
  pro: "bg-blue-100 text-blue-700",
  business: "bg-purple-100 text-purple-700",
  enterprise: "bg-yellow-100 text-yellow-700",
  free: "bg-green-100 text-green-700",
};

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  trialing: "bg-blue-100 text-blue-700",
  past_due: "bg-yellow-100 text-yellow-700",
  canceled: "bg-red-100 text-red-700",
};

export default function AdminTenantsPage() {
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/v1/admin/tenants")
      .then((r) => r.json())
      .then((d) => setTenants(d.tenants ?? []))
      .finally(() => setLoading(false));
  }, []);

  const filtered = tenants.filter((t) =>
    t.name.toLowerCase().includes(search.toLowerCase())
  );

  const totalFirms = tenants.length;
  const activeFirms = tenants.filter((t) => t.subscription_status === "active").length;
  const totalDocs = tenants.reduce((s, t) => s + t.doc_count, 0);
  const totalSpend = tenants.reduce((s, t) => s + t.ai_spend_total, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
          <Building2 className="w-6 h-6" /> Firms
        </h1>
        <p className="text-sm text-gray-500 mt-1">All accounting firms using LedgerIQ.</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs text-gray-500 mb-1">Total firms</p>
            <p className="text-2xl font-bold text-gray-900">{totalFirms}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs text-gray-500 mb-1">Active subscriptions</p>
            <p className="text-2xl font-bold text-gray-900">{activeFirms}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs text-gray-500 mb-1">Total documents</p>
            <p className="text-2xl font-bold text-gray-900">{totalDocs.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs text-gray-500 mb-1">Total AI spend</p>
            <p className="text-2xl font-bold text-gray-900">${totalSpend.toFixed(2)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search firms by name..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full max-w-sm h-10 px-3 rounded-md border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">All firms ({filtered.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 p-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-gray-500 p-6">No firms found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Firm</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Plan</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">
                      <span className="flex items-center justify-end gap-1"><Users className="w-3 h-3" /> Users</span>
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">
                      <span className="flex items-center justify-end gap-1"><FileText className="w-3 h-3" /> Docs</span>
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">
                      <span className="flex items-center justify-end gap-1"><TrendingUp className="w-3 h-3" /> Corrections</span>
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">AI spend</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => (
                    <tr key={t.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{t.name}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${PLAN_COLORS[t.subscription_plan] ?? "bg-gray-100 text-gray-700"}`}>
                          {t.subscription_plan ?? "free"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${STATUS_COLORS[t.subscription_status] ?? "bg-gray-100 text-gray-700"}`}>
                          {t.subscription_status ?? "active"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">{t.user_count}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{t.doc_count.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{t.correction_count.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right text-gray-700">${t.ai_spend_total.toFixed(2)}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {new Date(t.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
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
  );
}
