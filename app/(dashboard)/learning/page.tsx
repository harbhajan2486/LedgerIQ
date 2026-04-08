"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Brain, Building2, CheckCircle2, BookOpen, ChevronDown, ChevronRight } from "lucide-react";

interface VendorProfile {
  id: string;
  vendor_name: string;
  gstin: string | null;
  tds_category: string | null;
  learned_fields: string[];
  learned_values: Record<string, string>;
  last_updated: string;
  field_count: number;
}

interface KnowledgeData {
  vendors: VendorProfile[];
  total_vendors: number;
  total_corrections: number;
  total_learned_fields: number;
}

const FIELD_LABELS: Record<string, string> = {
  vendor_name: "Vendor Name", vendor_gstin: "Vendor GSTIN", buyer_gstin: "Buyer GSTIN",
  invoice_number: "Invoice Number", invoice_date: "Invoice Date", due_date: "Due Date",
  taxable_value: "Taxable Value", cgst_rate: "CGST Rate", cgst_amount: "CGST Amount",
  sgst_rate: "SGST Rate", sgst_amount: "SGST Amount", igst_rate: "IGST Rate",
  igst_amount: "IGST Amount", total_amount: "Total Amount", tds_section: "TDS Section",
  tds_rate: "TDS Rate", tds_amount: "TDS Amount", payment_reference: "Payment Ref",
  reverse_charge: "Reverse Charge", place_of_supply: "Place of Supply",
};

export default function LearningPage() {
  const [data, setData] = useState<KnowledgeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v1/knowledge/vendors")
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-6 max-w-4xl">
        <Skeleton className="h-7 w-48 mb-2" />
        <div className="grid grid-cols-3 gap-4">
          {[1,2,3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">AI Learning</h1>
        <p className="text-sm text-gray-500 mt-1">
          Everything the system has learned from your corrections — applied automatically to future invoices.
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="py-4 px-5">
            <div className="flex items-center gap-2 mb-1">
              <Building2 size={14} className="text-blue-500" />
              <p className="text-xs text-gray-500">Vendors learned</p>
            </div>
            <p className="text-3xl font-bold text-gray-900">{data?.total_vendors ?? 0}</p>
            <p className="text-xs text-gray-400 mt-1">Unique vendors from your invoices</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4 px-5">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 size={14} className="text-green-500" />
              <p className="text-xs text-gray-500">Total corrections made</p>
            </div>
            <p className="text-3xl font-bold text-gray-900">{data?.total_corrections ?? 0}</p>
            <p className="text-xs text-gray-400 mt-1">Each one trains the system</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4 px-5">
            <div className="flex items-center gap-2 mb-1">
              <BookOpen size={14} className="text-purple-500" />
              <p className="text-xs text-gray-500">Fields auto-filled</p>
            </div>
            <p className="text-3xl font-bold text-gray-900">{data?.total_learned_fields ?? 0}</p>
            <p className="text-xs text-gray-400 mt-1">Applied on next upload</p>
          </CardContent>
        </Card>
      </div>

      {/* Vendor profiles */}
      {(!data?.vendors || data.vendors.length === 0) ? (
        <Card className="border-dashed border-2 border-gray-200">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Brain size={32} className="text-gray-300 mb-3" />
            <h3 className="text-base font-medium text-gray-900 mb-1">No learning yet</h3>
            <p className="text-sm text-gray-500 max-w-sm">
              Review and correct AI-extracted fields in the review queue. The system learns from every correction you make.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="py-4 px-5 border-b">
            <CardTitle className="text-sm text-gray-700">Vendor memory — {data.vendors.length} vendors</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {data.vendors.map((vendor) => (
              <div key={vendor.id} className="border-b last:border-0">
                <button
                  className="w-full text-left px-5 py-3.5 hover:bg-gray-50 transition-colors flex items-center justify-between"
                  onClick={() => setExpanded(expanded === vendor.id ? null : vendor.id)}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
                      <Building2 size={14} className="text-blue-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{vendor.vendor_name}</p>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400">
                        {vendor.gstin && <span className="font-mono">{vendor.gstin}</span>}
                        {vendor.tds_category && (
                          <span className="px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded">
                            TDS {vendor.tds_category}
                          </span>
                        )}
                        <span className="text-gray-300">·</span>
                        <span>Last updated {new Date(vendor.last_updated).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {vendor.field_count > 0 ? (
                      <span className="text-xs px-2 py-0.5 bg-green-50 text-green-700 rounded-full font-medium">
                        {vendor.field_count} field{vendor.field_count !== 1 ? "s" : ""} learned
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">No fields learned yet</span>
                    )}
                    {expanded === vendor.id
                      ? <ChevronDown size={14} className="text-gray-400" />
                      : <ChevronRight size={14} className="text-gray-400" />
                    }
                  </div>
                </button>

                {expanded === vendor.id && (
                  <div className="px-5 pb-4 bg-gray-50 border-t">
                    {vendor.field_count === 0 ? (
                      <p className="text-xs text-gray-500 py-3">
                        Vendor profile exists but no field corrections recorded yet. Make corrections in the review queue to train it.
                      </p>
                    ) : (
                      <div className="pt-3 grid grid-cols-2 gap-x-8 gap-y-2">
                        {Object.entries(vendor.learned_values).map(([field, value]) => (
                          <div key={field} className="flex items-start justify-between gap-2 text-xs py-1 border-b border-gray-100 last:border-0">
                            <span className="text-gray-500 flex-shrink-0">{FIELD_LABELS[field] ?? field}</span>
                            <span className="text-gray-900 font-medium text-right truncate max-w-[160px]" title={value}>{value}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
