"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, DollarSign } from "lucide-react";

interface CostRow {
  tenant_name: string;
  model: string;
  doc_count: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

interface Summary {
  total_spend: number;
  budget_limit: number;
  spend_by_model: Record<string, number>;
  spend_by_tenant: Array<{ tenant_name: string; cost: number }>;
}

export default function AdminCostsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<CostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<"this_month" | "last_month">("this_month");

  useEffect(() => {
    setLoading(true);
    fetch(`/api/v1/admin/costs?period=${period}`)
      .then((r) => r.json())
      .then((d) => {
        setSummary(d.summary ?? null);
        setRows(d.rows ?? []);
      })
      .finally(() => setLoading(false));
  }, [period]);

  const budgetPct = summary ? Math.min(100, (summary.total_spend / summary.budget_limit) * 100) : 0;
  const barColor = budgetPct >= 100 ? "bg-red-500" : budgetPct >= 80 ? "bg-yellow-400" : "bg-green-500";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <DollarSign className="w-6 h-6" /> AI Cost Dashboard
          </h1>
          <p className="text-sm text-gray-500 mt-1">Monitor Claude API spend across all firms.</p>
        </div>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as "this_month" | "last_month")}
          className="h-9 px-3 rounded-md border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="this_month">This month</option>
          <option value="last_month">Last month</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading...
        </div>
      ) : (
        <>
          {/* Budget bar */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Monthly budget usage</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-end justify-between text-sm">
                <span className="text-gray-600">
                  <span className="text-2xl font-bold text-gray-900">${(summary?.total_spend ?? 0).toFixed(2)}</span>
                  <span className="text-gray-400 ml-1">/ ${summary?.budget_limit ?? 50} limit</span>
                </span>
                <span className="text-gray-500">{budgetPct.toFixed(1)}% used</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div className={`h-3 rounded-full transition-all ${barColor}`} style={{ width: `${budgetPct}%` }} />
              </div>
              {budgetPct >= 80 && (
                <p className={`text-sm font-medium ${budgetPct >= 100 ? "text-red-600" : "text-yellow-600"}`}>
                  {budgetPct >= 100
                    ? "Budget exceeded — new documents are queued until next month."
                    : "Warning: 80% of budget used. New documents will queue at $50."}
                </p>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-base">Spend by model</CardTitle></CardHeader>
              <CardContent>
                {summary?.spend_by_model && Object.entries(summary.spend_by_model).length > 0 ? (
                  <div className="space-y-2">
                    {Object.entries(summary.spend_by_model).sort(([, a], [, b]) => b - a).map(([model, cost]) => (
                      <div key={model} className="flex items-center justify-between text-sm">
                        <span className="text-gray-600 font-mono text-xs truncate max-w-[200px]">{model}</span>
                        <span className="font-medium text-gray-900">${cost.toFixed(3)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">No usage recorded yet.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Top firms by spend</CardTitle></CardHeader>
              <CardContent>
                {summary?.spend_by_tenant && summary.spend_by_tenant.length > 0 ? (
                  <div className="space-y-2">
                    {summary.spend_by_tenant.slice(0, 8).map((t) => (
                      <div key={t.tenant_name} className="flex items-center justify-between text-sm">
                        <span className="text-gray-600 truncate max-w-[200px]">{t.tenant_name}</span>
                        <span className="font-medium text-gray-900">${t.cost.toFixed(3)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">No usage recorded yet.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">Detailed usage ({rows.length} records)</CardTitle></CardHeader>
            <CardContent className="p-0">
              {rows.length === 0 ? (
                <p className="text-sm text-gray-400 p-6">No usage data for this period.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <th className="text-left px-4 py-3 font-medium text-gray-600">Firm</th>
                        <th className="text-left px-4 py-3 font-medium text-gray-600">Model</th>
                        <th className="text-right px-4 py-3 font-medium text-gray-600">Docs</th>
                        <th className="text-right px-4 py-3 font-medium text-gray-600">Tokens in</th>
                        <th className="text-right px-4 py-3 font-medium text-gray-600">Tokens out</th>
                        <th className="text-right px-4 py-3 font-medium text-gray-600">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="px-4 py-2 text-gray-700">{r.tenant_name}</td>
                          <td className="px-4 py-2 font-mono text-xs text-gray-500">{r.model}</td>
                          <td className="px-4 py-2 text-right text-gray-700">{r.doc_count}</td>
                          <td className="px-4 py-2 text-right text-gray-500">{r.tokens_in.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right text-gray-500">{r.tokens_out.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right font-medium text-gray-900">${r.cost_usd.toFixed(3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
