"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, BarChart3 } from "lucide-react";

interface UsageSummary {
  total_docs_all_time: number;
  total_docs_this_month: number;
  total_corrections_all_time: number;
  total_corrections_this_month: number;
  avg_accuracy_this_month: number;
  layer2_rules_active: number;
  layer2_rules_pending: number;
  top_firms_by_docs: Array<{ name: string; count: number }>;
  docs_by_status: Record<string, number>;
  corrections_by_day: Array<{ date: string; count: number }>;
}

export default function AdminUsagePage() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/admin/usage")
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
          <BarChart3 className="w-6 h-6" /> Usage Overview
        </h1>
        <p className="text-sm text-gray-500 mt-1">Platform-wide usage and learning metrics.</p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading...
        </div>
      ) : !data ? (
        <p className="text-sm text-gray-500">Could not load usage data.</p>
      ) : (
        <>
          {/* KPI grid */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: "Documents this month", value: data.total_docs_this_month.toLocaleString() },
              { label: "Corrections this month", value: data.total_corrections_this_month.toLocaleString() },
              { label: "Avg extraction accuracy", value: `${(data.avg_accuracy_this_month * 100).toFixed(1)}%` },
              { label: "Active global rules", value: data.layer2_rules_active.toLocaleString() },
            ].map((kpi) => (
              <Card key={kpi.label}>
                <CardContent className="pt-5">
                  <p className="text-xs text-gray-500 mb-1">{kpi.label}</p>
                  <p className="text-2xl font-bold text-gray-900">{kpi.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: "Total documents (all time)", value: data.total_docs_all_time.toLocaleString() },
              { label: "Total corrections (all time)", value: data.total_corrections_all_time.toLocaleString() },
              { label: "Rules pending approval", value: data.layer2_rules_pending.toLocaleString() },
            ].map((kpi) => (
              <Card key={kpi.label}>
                <CardContent className="pt-5">
                  <p className="text-xs text-gray-500 mb-1">{kpi.label}</p>
                  <p className="text-xl font-semibold text-gray-700">{kpi.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Docs by status */}
            <Card>
              <CardHeader><CardTitle className="text-base">Documents by status (all time)</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {Object.entries(data.docs_by_status).map(([status, count]) => (
                    <div key={status} className="flex items-center justify-between text-sm">
                      <span className="capitalize text-gray-600">{status.replace(/_/g, " ")}</span>
                      <span className="font-medium text-gray-900">{Number(count).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Top firms by docs */}
            <Card>
              <CardHeader><CardTitle className="text-base">Top firms by documents</CardTitle></CardHeader>
              <CardContent>
                {data.top_firms_by_docs.length === 0 ? (
                  <p className="text-sm text-gray-400">No data yet.</p>
                ) : (
                  <div className="space-y-2">
                    {data.top_firms_by_docs.map((f) => (
                      <div key={f.name} className="flex items-center gap-3">
                        <div className="flex-1">
                          <div className="flex justify-between text-sm mb-1">
                            <span className="text-gray-700 truncate max-w-[180px]">{f.name}</span>
                            <span className="text-gray-500 ml-2">{f.count}</span>
                          </div>
                          <div className="w-full bg-gray-100 rounded-full h-1.5">
                            <div
                              className="bg-blue-500 h-1.5 rounded-full"
                              style={{ width: `${Math.min(100, (f.count / (data.top_firms_by_docs[0]?.count || 1)) * 100)}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Corrections trend (last 14 days) */}
          {data.corrections_by_day.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Corrections per day (last 14 days)</CardTitle></CardHeader>
              <CardContent>
                <div className="flex items-end gap-1 h-20">
                  {data.corrections_by_day.slice(-14).map((d) => {
                    const max = Math.max(...data.corrections_by_day.map((x) => x.count), 1);
                    const pct = (d.count / max) * 100;
                    return (
                      <div key={d.date} className="flex-1 flex flex-col items-center gap-1" title={`${d.date}: ${d.count}`}>
                        <div
                          className="w-full bg-blue-400 rounded-t"
                          style={{ height: `${Math.max(4, pct)}%` }}
                        />
                        <span className="text-[9px] text-gray-400 rotate-45 origin-left">{d.date.slice(5)}</span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
