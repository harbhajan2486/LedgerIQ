import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import * as XLSX from "xlsx";

const EXTRACT_FIELDS = [
  "invoice_number", "invoice_date", "vendor_name", "buyer_name",
  "buyer_gstin", "vendor_gstin", "party_gstin", "taxable_value", "total_amount",
  "cgst_amount", "sgst_amount", "igst_amount", "tds_amount",
];

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
  const type = url.searchParams.get("type") ?? "sales"; // "sales" | "purchase" | "all"
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");

  const { data: client } = await supabase
    .from("clients").select("client_name").eq("id", clientId).eq("tenant_id", profile.tenant_id).single();

  // Fetch relevant documents for this client
  const docTypes = type === "sales"
    ? ["sales_invoice"]
    : type === "purchase"
    ? ["purchase_invoice", "expense"]
    : ["sales_invoice", "purchase_invoice", "expense"];

  let docQ = supabase
    .from("documents")
    .select("id, original_filename, document_type, status, uploaded_at")
    .eq("tenant_id", profile.tenant_id)
    .eq("client_id", clientId)
    .in("document_type", docTypes)
    .in("status", ["reviewed", "reconciled", "posted", "review_required"])
    .order("uploaded_at", { ascending: true });

  if (from) docQ = docQ.gte("uploaded_at", from);
  if (to)   docQ = docQ.lte("uploaded_at", to);

  const { data: docs } = await docQ;
  if (!docs?.length) {
    // Return empty workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([{ Note: "No invoices found for this client." }]);
    XLSX.utils.book_append_sheet(wb, ws, "Register");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const safeName = (client?.client_name ?? "client").replace(/[^a-z0-9]/gi, "_");
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${type}-register-${safeName}.xlsx"`,
      },
    });
  }

  const docIds = docs.map((d) => d.id);

  // Fetch extractions — select status for deduplication
  const { data: extractions } = await supabase
    .from("extractions")
    .select("document_id, field_name, extracted_value, status")
    .in("document_id", docIds)
    .in("field_name", EXTRACT_FIELDS)
    .not("status", "eq", "rejected")
    .order("created_at", { ascending: false });

  // Build field map — verified (accepted/corrected) wins over pending; newest first
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

  const rows = docs.map((doc, i) => {
    const f = fieldMap[doc.id] ?? {};
    const partyName = f.buyer_name ?? f.vendor_name ?? "";
    const partyGstin = f.buyer_gstin ?? f.vendor_gstin ?? f.party_gstin ?? "";
    const taxable = f.taxable_value ? Number(f.taxable_value) : "";
    const total   = f.total_amount   ? Number(f.total_amount)   : "";
    const cgst    = f.cgst_amount    ? Number(f.cgst_amount)    : "";
    const sgst    = f.sgst_amount    ? Number(f.sgst_amount)    : "";
    const igst    = f.igst_amount    ? Number(f.igst_amount)    : "";
    const tds     = f.tds_amount     ? Number(f.tds_amount)     : "";

    return {
      "Sr.":                i + 1,
      "Invoice Date":       f.invoice_date ?? "",
      "Invoice No":         f.invoice_number ?? "",
      "File":               doc.original_filename,
      "Type":               doc.document_type.replace(/_/g, " "),
      "Party Name":         partyName,
      "Party GSTIN":        partyGstin,
      "Taxable Value (₹)": taxable,
      "CGST (₹)":          cgst,
      "SGST (₹)":          sgst,
      "IGST (₹)":          igst,
      "TDS (₹)":           tds,
      "Total Amount (₹)":  total,
      "Status":             doc.status,
    };
  });

  // Totals row
  const sumOf = (key: string) =>
    rows.reduce((s, r) => s + (typeof r[key as keyof typeof r] === "number" ? (r[key as keyof typeof r] as number) : 0), 0);

  (rows as Record<string, unknown>[]).push({
    "Sr.": "", "Invoice Date": "", "Invoice No": "", "File": "TOTAL",
    "Type": "", "Party Name": "", "Party GSTIN": "",
    "Taxable Value (₹)": sumOf("Taxable Value (₹)") || "",
    "CGST (₹)":          sumOf("CGST (₹)")          || "",
    "SGST (₹)":          sumOf("SGST (₹)")          || "",
    "IGST (₹)":          sumOf("IGST (₹)")          || "",
    "TDS (₹)":           sumOf("TDS (₹)")           || "",
    "Total Amount (₹)":  sumOf("Total Amount (₹)")  || "",
    "Status": "",
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [
    { wch: 5 }, { wch: 14 }, { wch: 18 }, { wch: 35 }, { wch: 16 },
    { wch: 28 }, { wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 14 },
  ];

  const wb = XLSX.utils.book_new();
  const sheetName = type === "sales" ? "Sales Register" : type === "purchase" ? "Purchase Register" : "Invoice Register";
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const safeName = (client?.client_name ?? "client").replace(/[^a-z0-9]/gi, "_");

  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${type}-register-${safeName}.xlsx"`,
    },
  });
}
