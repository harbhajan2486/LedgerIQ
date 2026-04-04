"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, FileText, Download, TrendingUp } from "lucide-react";

type Period = "this_month" | "last_month" | "this_quarter" | "this_year";

interface GSTSummary {
  total_taxable: number;
  total_cgst: number;
  total_sgst: number;
  total_igst: number;
  total_gst: number;
}

interface DocRow {
  id: string;
  filename: string;
  doc_type: string;
  vendor_name: string | null;
  vendor_gstin: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  total_gst: number;
  tds_section: string | null;
  tds_amount: number;
  reverse_charge: string;
}

interface TaxData {
  period: string;
  gst_summary: GSTSummary;
  tds_summary: Record<string, number>;
  total_tds: number;
  document_count: number;
  documents: DocRow[];
}

const PERIOD_LABELS: Record<Period, string> = {
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  this_year: "This financial year",
};

function fmt(n: number) {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export default function TaxSummaryPage() {
  const [period, setPeriod] = useState<Period>("this_month");
  const [data, setData] = useState<TaxData | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/v1/tax-summary?period=${period}`);
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, [period]);

  useEffect(() => { loadData(); }, [loadData]);

  function exportCSV() {
    if (!data) return;
    setExporting(true);

    const headers = [
      "Invoice Date", "Vendor Name", "Vendor GSTIN", "Invoice Number",
      "Taxable Value", "CGST", "SGST", "IGST", "Total GST",
      "TDS Section", "TDS Amount", "Reverse Charge", "File Name"
    ];
    const rows = data.documents.map((d) => [
      d.invoice_date ?? "", d.vendor_name ?? "", d.vendor_gstin ?? "",
      d.invoice_number ?? "", d.taxable_value, d.cgst, d.sgst, d.igst,
      d.total_gst, d.tds_section ?? "", d.tds_amount, d.reverse_charge, d.filename,
    ].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","));

    const csv = [headers.map((h) => `"${h}"`).join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tax-summary-${period}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setExporting(false);
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <TrendingUp className="w-6 h-6" /> Tax Summary
          </h1>
          <p className="text-sm text-gray-500 mt-1">GST and TDS summary across all reviewed invoices.</p>
        </div>
        <div className="flex gap-2">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
            className="h-9 px-3 rounded-md border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {Object.entries(PERIOD_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <Button variant="outline" onClick={exportCSV} disabled={exporting || !data?.documents.length}>
            {exporting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Download className="w-4 h-4 mr-2" />}
            Export CSV
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading tax data...
        </div>
      ) : !data ? (
        <p className="text-sm text-gray-500">Could not load data.</p>
      ) : (
        <>
          {/* GST Summary */}
          <div>
            <h2 className="text-base font-semibold text-gray-900 mb-3">GST Summary — {PERIOD_LABELS[period]}</h2>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              {[
                { label: "Taxable Value", value: fmt(data.gst_summary.total_taxable) },
                { label: "CGST (Input)", value: fmt(data.gst_summary.total_cgst) },
                { label: "SGST (Input)", value: fmt(data.gst_summary.total_sgst) },
                { label: "IGST (Input)", value: fmt(data.gst_summary.total_igst) },
                { label: "Total GST Credit", value: fmt(data.gst_summary.total_gst), highlight: true },
              ].map((kpi) => (
                <Card key={kpi.label} className={kpi.highlight ? "border-blue-200" : ""}>
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-gray-500 mb-1">{kpi.label}</p>
                    <p className={`text-xl font-bold ${kpi.highlight ? "text-blue-700" : "text-gray-900"}`}>
                      {kpi.value}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* TDS Summary */}
          {Object.keys(data.tds_summary).length > 0 && (
            <div>
              <h2 className="text-base font-semibold text-gray-900 mb-3">TDS Deducted by Section</h2>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {Object.entries(data.tds_summary).map(([section, amount]) => (
                  <Card key={section}>
                    <CardContent className="pt-4 pb-4">
                      <p className="text-xs font-mono text-gray-500 mb-1">Section {section}</p>
                      <p className="text-xl font-bold text-gray-900">{fmt(amount)}</p>
                    </CardContent>
                  </Card>
                ))}
                <Card className="border-orange-200">
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-gray-500 mb-1">Total TDS</p>
                    <p className="text-xl font-bold text-orange-700">{fmt(data.total_tds)}</p>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* Document table */}
          <div>
            <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <FileText className="w-4 h-4" />
              All invoices ({data.document_count})
            </h2>
            {data.documents.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center text-gray-400">
                  No reviewed invoices in this period.
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100 bg-gray-50">
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Vendor</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">GSTIN</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Invoice #</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                          <th className="text-right px-4 py-3 font-medium text-gray-600">Taxable</th>
                          <th className="text-right px-4 py-3 font-medium text-gray-600">CGST</th>
                          <th className="text-right px-4 py-3 font-medium text-gray-600">SGST</th>
                          <th className="text-right px-4 py-3 font-medium text-gray-600">IGST</th>
                          <th className="text-right px-4 py-3 font-medium text-gray-600">TDS §</th>
                          <th className="text-right px-4 py-3 font-medium text-gray-600">TDS Amt</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">RC</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.documents.map((d) => (
                          <tr key={d.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                            <td className="px-4 py-2 font-medium text-gray-900 truncate max-w-[160px]">{d.vendor_name ?? "—"}</td>
                            <td className="px-4 py-2 font-mono text-xs text-gray-500">{d.vendor_gstin ?? "—"}</td>
                            <td className="px-4 py-2 text-gray-700 text-xs">{d.invoice_number ?? "—"}</td>
                            <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">{d.invoice_date ?? "—"}</td>
                            <td className="px-4 py-2 text-right text-gray-700">{d.taxable_value > 0 ? fmt(d.taxable_value) : "—"}</td>
                            <td className="px-4 py-2 text-right text-gray-600">{d.cgst > 0 ? fmt(d.cgst) : "—"}</td>
                            <td className="px-4 py-2 text-right text-gray-600">{d.sgst > 0 ? fmt(d.sgst) : "—"}</td>
                            <td className="px-4 py-2 text-right text-gray-600">{d.igst > 0 ? fmt(d.igst) : "—"}</td>
                            <td className="px-4 py-2 text-right text-gray-500 text-xs">{d.tds_section ?? "—"}</td>
                            <td className="px-4 py-2 text-right text-gray-600">{d.tds_amount > 0 ? fmt(d.tds_amount) : "—"}</td>
                            <td className="px-4 py-2 text-gray-500 text-xs">{d.reverse_charge === "Yes" ? "Yes" : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-gray-50 font-semibold">
                          <td className="px-4 py-3 text-gray-900" colSpan={4}>Totals</td>
                          <td className="px-4 py-3 text-right text-gray-900">{fmt(data.gst_summary.total_taxable)}</td>
                          <td className="px-4 py-3 text-right text-gray-900">{fmt(data.gst_summary.total_cgst)}</td>
                          <td className="px-4 py-3 text-right text-gray-900">{fmt(data.gst_summary.total_sgst)}</td>
                          <td className="px-4 py-3 text-right text-gray-900">{fmt(data.gst_summary.total_igst)}</td>
                          <td className="px-4 py-3" />
                          <td className="px-4 py-3 text-right text-gray-900">{fmt(data.total_tds)}</td>
                          <td className="px-4 py-3" />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}
