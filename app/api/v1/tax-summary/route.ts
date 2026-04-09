import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const tenantId = profile.tenant_id;
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") ?? "this_month"; // this_month | last_month | this_quarter | this_year

  const now = new Date();
  const toDate = (d: Date) => d.toISOString().slice(0, 10); // YYYY-MM-DD
  let startDate: string;
  let endDate: string = toDate(now);

  if (period === "last_month") {
    startDate = toDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    endDate = toDate(new Date(now.getFullYear(), now.getMonth(), 0)); // last day of prev month
  } else if (period === "this_quarter") {
    startDate = toDate(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1));
  } else if (period === "this_year") {
    const fyYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
    startDate = toDate(new Date(fyYear, 3, 1)); // April 1 (Indian FY)
  } else if (period === "last_year") {
    // Last Indian FY: April 1 (year-1) → March 31 (year)
    const fyYear = now.getMonth() < 3 ? now.getFullYear() - 2 : now.getFullYear() - 1;
    startDate = toDate(new Date(fyYear, 3, 1));
    endDate = toDate(new Date(fyYear + 1, 2, 31));
  } else {
    // this_month
    startDate = toDate(new Date(now.getFullYear(), now.getMonth(), 1));
  }

  // Get all reviewed/reconciled/posted documents for this tenant
  // Period filtering is done on invoice_date (from extractions) not created_at
  const { data: docs } = await supabase
    .from("documents")
    .select("id, original_filename, document_type, created_at")
    .eq("tenant_id", tenantId)
    .in("status", ["reviewed", "reconciled", "posted"]);

  if (!docs || docs.length === 0) {
    return NextResponse.json({
      period,
      gst_summary: { total_taxable: 0, total_cgst: 0, total_sgst: 0, total_igst: 0, total_gst: 0 },
      tds_summary: {},
      itc_eligible: 0,
      itc_blocked: 0,
      documents: [],
    });
  }

  const docIds = docs.map((d) => d.id);

  // Get all relevant extraction fields
  const TAX_FIELDS = [
    "vendor_name", "vendor_gstin", "invoice_number", "invoice_date",
    "taxable_value", "cgst_amount", "sgst_amount", "igst_amount",
    "total_amount", "tds_section", "tds_amount", "reverse_charge"
  ];

  const { data: extractions } = await supabase
    .from("extractions")
    .select("document_id, field_name, extracted_value")
    .in("document_id", docIds)
    .in("field_name", TAX_FIELDS)
    .in("status", ["accepted", "corrected"]);

  // Build per-document field map
  const docFields: Record<string, Record<string, string | null>> = {};
  for (const ext of extractions ?? []) {
    if (!docFields[ext.document_id]) docFields[ext.document_id] = {};
    docFields[ext.document_id][ext.field_name] = ext.extracted_value;
  }

  // Aggregate GST
  let totalTaxable = 0, totalCGST = 0, totalSGST = 0, totalIGST = 0, totalTDS = 0;
  const tdsSection: Record<string, number> = {};

  // Filter by invoice_date falling in the period (more accurate than created_at)
  const filteredDocs = docs.filter((doc) => {
    const invDate = docFields[doc.id]?.invoice_date;
    const refDate = invDate ?? doc.created_at;
    return refDate >= startDate && refDate <= endDate;
  });

  // Reset totals — recalculate only for filtered docs
  totalTaxable = 0; totalCGST = 0; totalSGST = 0; totalIGST = 0; totalTDS = 0;
  Object.keys(tdsSection).forEach((k) => delete tdsSection[k]);

  const docRows = filteredDocs.map((doc) => {
    const f = docFields[doc.id] ?? {};
    const taxable = parseFloat(f.taxable_value ?? "0") || 0;
    const cgst = parseFloat(f.cgst_amount ?? "0") || 0;
    const sgst = parseFloat(f.sgst_amount ?? "0") || 0;
    const igst = parseFloat(f.igst_amount ?? "0") || 0;
    const tds = parseFloat(f.tds_amount ?? "0") || 0;
    const section = f.tds_section ?? null;

    totalTaxable += taxable;
    totalCGST += cgst;
    totalSGST += sgst;
    totalIGST += igst;
    totalTDS += tds;

    if (section && tds > 0) {
      tdsSection[section] = (tdsSection[section] ?? 0) + tds;
    }

    return {
      id: doc.id,
      filename: doc.original_filename,
      doc_type: doc.document_type,
      date: doc.created_at,
      vendor_name: f.vendor_name ?? null,
      vendor_gstin: f.vendor_gstin ?? null,
      invoice_number: f.invoice_number ?? null,
      invoice_date: f.invoice_date ?? null,
      taxable_value: taxable,
      cgst: cgst,
      sgst: sgst,
      igst: igst,
      total_gst: cgst + sgst + igst,
      tds_section: section,
      tds_amount: tds,
      reverse_charge: f.reverse_charge ?? "No",
    };
  });

  return NextResponse.json({
    period,
    gst_summary: {
      total_taxable: totalTaxable,
      total_cgst: totalCGST,
      total_sgst: totalSGST,
      total_igst: totalIGST,
      total_gst: totalCGST + totalSGST + totalIGST,
    },
    tds_summary: tdsSection,
    total_tds: totalTDS,
    document_count: filteredDocs.length,
    documents: docRows,
  });
  } catch (err) {
    console.error("[tax-summary] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
