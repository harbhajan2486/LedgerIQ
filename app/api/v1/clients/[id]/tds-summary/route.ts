import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import * as XLSX from "xlsx";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const { id: clientId } = await params;
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");

  const { data: client } = await supabase
    .from("clients").select("client_name").eq("id", clientId).eq("tenant_id", profile.tenant_id).single();

  // Fetch all reviewed/reconciled purchase invoices and expenses for this client
  let docQ = supabase
    .from("documents")
    .select("id, original_filename, document_type, uploaded_at")
    .eq("tenant_id", profile.tenant_id)
    .eq("client_id", clientId)
    .in("document_type", ["purchase_invoice", "expense"])
    .in("status", ["reviewed", "reconciled", "posted", "review_required"]);

  if (from) docQ = docQ.gte("uploaded_at", from);
  if (to)   docQ = docQ.lte("uploaded_at", to);

  const { data: docs } = await docQ;
  if (!docs?.length) {
    return NextResponse.json({ summary: [], total_tds: 0 });
  }

  const docIds = docs.map((d) => d.id);

  const { data: extractions } = await supabase
    .from("extractions")
    .select("document_id, field_name, extracted_value")
    .in("document_id", docIds)
    .in("field_name", ["vendor_name", "invoice_number", "invoice_date", "total_amount", "taxable_value", "tds_section", "tds_rate", "tds_amount"])
    .not("status", "eq", "rejected");

  // Build per-document field map — deduplicated: accepted/corrected wins over pending, newest first
  type ExtRow = { document_id: string; field_name: string; extracted_value: string | null; status: string };
  const verifiedMap: Record<string, Record<string, string>> = {};
  const pendingMap:  Record<string, Record<string, string>> = {};
  for (const ext of (extractions ?? []) as ExtRow[]) {
    if (!ext.extracted_value) continue;
    const isVerified = ext.status === "accepted" || ext.status === "corrected";
    const target = isVerified ? verifiedMap : pendingMap;
    if (!target[ext.document_id]) target[ext.document_id] = {};
    if (!target[ext.document_id][ext.field_name]) target[ext.document_id][ext.field_name] = ext.extracted_value;
  }
  const fieldMap: Record<string, Record<string, string>> = {};
  for (const docId of docIds) {
    fieldMap[docId] = { ...pendingMap[docId], ...verifiedMap[docId] };
  }

  // Aggregate by vendor + section for 26Q summary
  interface VendorKey { vendor: string; section: string; rate: string }
  const aggregated: Record<string, VendorKey & { totalPayment: number; tdsAmount: number; invoiceCount: number; invoices: string[] }> = {};

  for (const doc of docs) {
    const f = fieldMap[doc.id] ?? {};
    const vendor  = f.vendor_name   ?? "Unknown Vendor";
    const section = f.tds_section   ?? "";
    const rate    = f.tds_rate      ?? "0";
    const payment = parseFloat(f.taxable_value ?? f.total_amount ?? "0") || 0;
    const invNo   = f.invoice_number ?? doc.original_filename;

    if (!section || section === "No TDS") continue;

    // Calculate TDS amount: use extracted value if available, else derive from rate × payment
    const extractedTds = parseFloat(f.tds_amount ?? "0") || 0;
    const tds = extractedTds > 0 ? extractedTds : (payment * parseFloat(rate) / 100);

    if (payment === 0) continue; // skip docs with no payment value at all

    const key = `${vendor}||${section}`;
    if (!aggregated[key]) {
      aggregated[key] = { vendor, section, rate, totalPayment: 0, tdsAmount: 0, invoiceCount: 0, invoices: [] };
    }
    aggregated[key].totalPayment += payment;
    aggregated[key].tdsAmount    += tds;
    aggregated[key].invoiceCount += 1;
    aggregated[key].invoices.push(invNo);
  }

  const summary = Object.values(aggregated).sort((a, b) => b.tdsAmount - a.tdsAmount);

  // Return JSON for API use
  if (url.searchParams.get("format") !== "excel") {
    return NextResponse.json({
      summary,
      total_tds: summary.reduce((s, r) => s + r.tdsAmount, 0),
      total_payment: summary.reduce((s, r) => s + r.totalPayment, 0),
    });
  }

  // ── Excel Export ──────────────────────────────────────────────────────────
  const wb = XLSX.utils.book_new();

  // Sheet 1: 26Q-style summary (vendor-wise TDS)
  const summaryRows = summary.map((r, i) => ({
    "Sr.":                 i + 1,
    "Vendor / Party Name": r.vendor,
    "TDS Section":         r.section,
    "TDS Rate (%)":        r.rate,
    "No. of Invoices":     r.invoiceCount,
    "Total Payment (₹)":  r.totalPayment.toFixed(2),
    "TDS Deducted (₹)":   r.tdsAmount.toFixed(2),
    "Net Payable (₹)":    (r.totalPayment - r.tdsAmount).toFixed(2),
  }));

  const totalTds = summary.reduce((s, r) => s + r.tdsAmount, 0);
  const totalPay = summary.reduce((s, r) => s + r.totalPayment, 0);
  (summaryRows as Record<string, unknown>[]).push({
    "Sr.": "",
    "Vendor / Party Name": "TOTAL",
    "TDS Section": "",
    "TDS Rate (%)": "",
    "No. of Invoices": summary.reduce((s, r) => s + r.invoiceCount, 0),
    "Total Payment (₹)": totalPay.toFixed(2),
    "TDS Deducted (₹)": totalTds.toFixed(2),
    "Net Payable (₹)": (totalPay - totalTds).toFixed(2),
  });

  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary["!cols"] = [{ wch: 5 },{ wch: 32 },{ wch: 14 },{ wch: 12 },{ wch: 14 },{ wch: 18 },{ wch: 18 },{ wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, "TDS Summary (26Q)");

  // Sheet 2: Invoice-level detail
  const detailRows = docs
    .filter((doc) => {
      const f = fieldMap[doc.id] ?? {};
      if (!f.tds_section || f.tds_section === "No TDS") return false;
      const payment = parseFloat(f.taxable_value ?? f.total_amount ?? "0") || 0;
      return payment > 0;
    })
    .map((doc, i) => {
      const f = fieldMap[doc.id] ?? {};
      const payment  = parseFloat(f.taxable_value ?? f.total_amount ?? "0") || 0;
      const rate     = parseFloat(f.tds_rate ?? "0") || 0;
      const extractedTds = parseFloat(f.tds_amount ?? "0") || 0;
      const tdsAmt   = extractedTds > 0 ? extractedTds : (payment * rate / 100);
      const total    = parseFloat(f.total_amount ?? "0") || 0;
      return {
        "Sr.":                i + 1,
        "Invoice Date":       f.invoice_date ?? "",
        "Invoice No":         f.invoice_number ?? "",
        "Vendor Name":        f.vendor_name ?? "",
        "Document Type":      doc.document_type.replace(/_/g, " "),
        "Total Amount (₹)":   total > 0 ? total.toFixed(2) : "",
        "Taxable Value (₹)":  payment > 0 ? payment.toFixed(2) : "",
        "TDS Section":        f.tds_section ?? "",
        "TDS Rate (%)":       f.tds_rate ?? "",
        "TDS Amount (₹)":     tdsAmt > 0 ? tdsAmt.toFixed(2) : "",
        "Net Payment (₹)":    total > 0 ? (total - tdsAmt).toFixed(2) : "",
      };
    });

  const wsDetail = XLSX.utils.json_to_sheet(detailRows);
  wsDetail["!cols"] = [{ wch: 5 },{ wch: 14 },{ wch: 18 },{ wch: 28 },{ wch: 16 },{ wch: 16 },{ wch: 16 },{ wch: 12 },{ wch: 12 },{ wch: 14 },{ wch: 14 }];
  XLSX.utils.book_append_sheet(wb, wsDetail, "Invoice Detail");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const safeName = (client?.client_name ?? "client").replace(/[^a-z0-9]/gi, "_");

  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="tds-summary-26Q-${safeName}.xlsx"`,
    },
  });
}
