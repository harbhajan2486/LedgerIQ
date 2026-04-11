import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import * as XLSX from "xlsx";

// ─── helpers ────────────────────────────────────────────────────────────────

function n(v: string | undefined | null): number {
  return parseFloat(v ?? "0") || 0;
}

function fmt2(v: number) {
  return v.toFixed(2);
}

// ─── types ──────────────────────────────────────────────────────────────────

interface FieldMap {
  vendor_name?: string;
  vendor_gstin?: string;
  buyer_gstin?: string;
  party_gstin?: string;
  invoice_number?: string;
  invoice_date?: string;
  total_amount?: string;
  taxable_value?: string;
  cgst_amount?: string;
  sgst_amount?: string;
  igst_amount?: string;
  gst_rate?: string;
  hsn_sac_code?: string;
  place_of_supply?: string;
  reverse_charge?: string;
  itc_eligible?: string;
  tds_section?: string;
  tds_amount?: string;
}

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
  const fmt  = url.searchParams.get("format");

  const { data: client } = await supabase
    .from("clients").select("client_name, gstin").eq("id", clientId).eq("tenant_id", profile.tenant_id).single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // ── Fetch all reviewed docs for this client ─────────────────────────────
  let docQ = supabase
    .from("documents")
    .select("id, document_type, original_filename, uploaded_at")
    .eq("tenant_id", profile.tenant_id)
    .eq("client_id", clientId)
    .in("document_type", ["sales_invoice", "purchase_invoice", "expense", "credit_note", "debit_note"])
    .in("status", ["reviewed", "reconciled", "posted", "review_required"]);

  if (from) docQ = docQ.gte("uploaded_at", from);
  if (to)   docQ = docQ.lte("uploaded_at", to);

  const { data: docs } = await docQ;
  if (!docs?.length) {
    if (fmt === "excel") return NextResponse.json({ error: "No documents found" }, { status: 404 });
    return NextResponse.json({ b2b: [], b2c_large: [], b2c_small: [], hsn: [], itc: [], gstr3b: null });
  }

  const docIds = docs.map((d) => d.id);

  const { data: extractions } = await supabase
    .from("extractions")
    .select("document_id, field_name, extracted_value")
    .in("document_id", docIds)
    .in("field_name", [
      "vendor_name", "vendor_gstin", "buyer_gstin", "party_gstin",
      "invoice_number", "invoice_date", "total_amount", "taxable_value",
      "cgst_amount", "sgst_amount", "igst_amount", "gst_rate",
      "hsn_sac_code", "place_of_supply", "reverse_charge", "itc_eligible",
      "tds_section", "tds_amount",
    ])
    .not("status", "eq", "rejected");

  // Build per-doc field map — deduplicate: one value per field per doc.
  // Priority: accepted/corrected (human-verified) over pending, newest first.
  // Handles duplicate rows from concurrent re-extractions.
  type ExtRow = { document_id: string; field_name: string; extracted_value: string | null; status: string };
  const verifiedMap: Record<string, Record<string, string>> = {}; // doc → field → value (human-verified)
  const pendingMap:  Record<string, Record<string, string>> = {}; // doc → field → value (AI, not yet reviewed)

  for (const ext of (extractions ?? []) as ExtRow[]) {
    if (!ext.extracted_value) continue;
    const isVerified = ext.status === "accepted" || ext.status === "corrected";
    const target = isVerified ? verifiedMap : pendingMap;
    if (!target[ext.document_id]) target[ext.document_id] = {};
    // First write wins (newest first from Supabase default order)
    if (!target[ext.document_id][ext.field_name]) {
      target[ext.document_id][ext.field_name] = ext.extracted_value;
    }
  }

  // Merge: verified value takes priority; fall back to pending AI value
  const fieldMap: Record<string, FieldMap> = {};
  const allDocIds = new Set([...Object.keys(verifiedMap), ...Object.keys(pendingMap)]);
  for (const docId of allDocIds) {
    fieldMap[docId] = { ...pendingMap[docId], ...verifiedMap[docId] } as FieldMap;
  }

  // ── Separate by doc type ─────────────────────────────────────────────────
  const salesDocs    = docs.filter((d) => d.document_type === "sales_invoice");
  const purchaseDocs = docs.filter((d) => ["purchase_invoice", "expense"].includes(d.document_type));
  const creditDocs   = docs.filter((d) => d.document_type === "credit_note");
  const debitDocs    = docs.filter((d) => d.document_type === "debit_note");

  // ── GSTR-1: B2B (sales with buyer GSTIN) ────────────────────────────────
  const b2b = salesDocs
    .map((doc, i) => {
      const f = fieldMap[doc.id] ?? {};
      const buyerGstin = f.buyer_gstin ?? f.party_gstin ?? f.vendor_gstin ?? "";
      if (!buyerGstin || buyerGstin.length < 10) return null;
      const taxable = n(f.taxable_value ?? f.total_amount);
      const cgst = n(f.cgst_amount);
      const sgst = n(f.sgst_amount);
      const igst = n(f.igst_amount);
      if (taxable === 0) return null;
      return {
        sr: i + 1,
        gstin: buyerGstin,
        invoice_no: f.invoice_number ?? "",
        invoice_date: f.invoice_date ?? "",
        invoice_value: n(f.total_amount ?? f.taxable_value),
        place_of_supply: f.place_of_supply ?? "",
        reverse_charge: f.reverse_charge === "Yes" ? "Y" : "N",
        applicable_tax_rate: n(f.gst_rate),
        taxable_value: taxable,
        igst, cgst, sgst,
        cess: 0,
      };
    })
    .filter(Boolean);

  // ── GSTR-1: B2C (sales without GSTIN) ──────────────────────────────────
  const b2cAll = salesDocs
    .map((doc) => {
      const f = fieldMap[doc.id] ?? {};
      const buyerGstin = f.buyer_gstin ?? f.party_gstin ?? f.vendor_gstin ?? "";
      if (buyerGstin && buyerGstin.length >= 10) return null;
      const taxable = n(f.taxable_value ?? f.total_amount);
      if (taxable === 0) return null;
      const igst = n(f.igst_amount);
      const cgst = n(f.cgst_amount);
      const sgst = n(f.sgst_amount);
      const invoiceValue = n(f.total_amount ?? f.taxable_value);
      // B2C Large: interstate (IGST > 0) and value > 2.5L
      const isLarge = igst > 0 && invoiceValue > 250000;
      return {
        type: isLarge ? "large" : "small" as "large" | "small",
        invoice_no: f.invoice_number ?? "",
        invoice_date: f.invoice_date ?? "",
        invoice_value: invoiceValue,
        place_of_supply: f.place_of_supply ?? "",
        applicable_tax_rate: n(f.gst_rate),
        taxable_value: taxable,
        igst, cgst, sgst,
        cess: 0,
      };
    })
    .filter(Boolean) as Array<{
      type: "large" | "small";
      invoice_no: string;
      invoice_date: string;
      invoice_value: number;
      place_of_supply: string;
      applicable_tax_rate: number;
      taxable_value: number;
      igst: number;
      cgst: number;
      sgst: number;
      cess: number;
    }>;

  const b2c_large = b2cAll.filter((r) => r.type === "large").map(({ type: _t, ...r }) => r);

  // B2C Small: aggregate by rate + place_of_supply
  const b2cSmallMap: Record<string, { place_of_supply: string; rate: number; taxable: number; igst: number; cgst: number; sgst: number }> = {};
  for (const r of b2cAll.filter((x) => x.type === "small")) {
    const key = `${r.place_of_supply}||${r.applicable_tax_rate}`;
    if (!b2cSmallMap[key]) b2cSmallMap[key] = { place_of_supply: r.place_of_supply, rate: r.applicable_tax_rate, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    b2cSmallMap[key].taxable += r.taxable_value;
    b2cSmallMap[key].igst    += r.igst;
    b2cSmallMap[key].cgst    += r.cgst;
    b2cSmallMap[key].sgst    += r.sgst;
  }
  const b2c_small = Object.values(b2cSmallMap);

  // ── GSTR-1: HSN/SAC Summary ──────────────────────────────────────────────
  // Aggregate all sales docs by HSN code
  const hsnMap: Record<string, { hsn: string; description: string; uqc: string; qty: number; taxable: number; igst: number; cgst: number; sgst: number; rate: number }> = {};
  for (const doc of salesDocs) {
    const f = fieldMap[doc.id] ?? {};
    const hsn = f.hsn_sac_code ?? "Unknown";
    const taxable = n(f.taxable_value ?? f.total_amount);
    if (taxable === 0) continue;
    if (!hsnMap[hsn]) hsnMap[hsn] = { hsn, description: "", uqc: "NOS", qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, rate: n(f.gst_rate) };
    hsnMap[hsn].qty     += 1;
    hsnMap[hsn].taxable += taxable;
    hsnMap[hsn].igst    += n(f.igst_amount);
    hsnMap[hsn].cgst    += n(f.cgst_amount);
    hsnMap[hsn].sgst    += n(f.sgst_amount);
  }
  const hsn = Object.values(hsnMap);

  // ── ITC Register (purchase docs) ────────────────────────────────────────
  const itc = purchaseDocs
    .map((doc, i) => {
      const f = fieldMap[doc.id] ?? {};
      const cgst = n(f.cgst_amount);
      const sgst = n(f.sgst_amount);
      const igst = n(f.igst_amount);
      if (cgst + sgst + igst === 0) return null;
      const itcEligible = (f.itc_eligible ?? "Yes") !== "No" && (f.itc_eligible ?? "Yes") !== "Blocked";
      return {
        sr: i + 1,
        vendor_name: f.vendor_name ?? "",
        vendor_gstin: f.vendor_gstin ?? "",
        invoice_no: f.invoice_number ?? "",
        invoice_date: f.invoice_date ?? "",
        taxable_value: n(f.taxable_value ?? f.total_amount),
        igst, cgst, sgst,
        total_itc: cgst + sgst + igst,
        itc_eligible: itcEligible ? "Eligible" : "Blocked",
        doc_type: doc.document_type.replace(/_/g, " "),
      };
    })
    .filter(Boolean);

  // ── GSTR-3B Summary ──────────────────────────────────────────────────────
  // 3.1(a): Outward taxable supplies (sales, non-RC)
  const outward = salesDocs.reduce((acc, doc) => {
    const f = fieldMap[doc.id] ?? {};
    if ((f.reverse_charge ?? "No") === "Yes") return acc;
    acc.taxable += n(f.taxable_value ?? f.total_amount);
    acc.igst    += n(f.igst_amount);
    acc.cgst    += n(f.cgst_amount);
    acc.sgst    += n(f.sgst_amount);
    return acc;
  }, { taxable: 0, igst: 0, cgst: 0, sgst: 0 });

  // 3.1(a) RCM outward
  const outwardRcm = salesDocs.reduce((acc, doc) => {
    const f = fieldMap[doc.id] ?? {};
    if ((f.reverse_charge ?? "No") !== "Yes") return acc;
    acc.taxable += n(f.taxable_value ?? f.total_amount);
    acc.igst    += n(f.igst_amount);
    acc.cgst    += n(f.cgst_amount);
    acc.sgst    += n(f.sgst_amount);
    return acc;
  }, { taxable: 0, igst: 0, cgst: 0, sgst: 0 });

  // 4(A): ITC from eligible purchase invoices
  const itcTotal = (itc as Array<{ igst: number; cgst: number; sgst: number; itc_eligible: string }>)
    .filter((r) => r.itc_eligible === "Eligible")
    .reduce((acc, r) => {
      acc.igst += r.igst; acc.cgst += r.cgst; acc.sgst += r.sgst;
      return acc;
    }, { igst: 0, cgst: 0, sgst: 0 });

  // Credit notes (reduce output tax)
  const cnReduction = creditDocs.reduce((acc, doc) => {
    const f = fieldMap[doc.id] ?? {};
    acc.igst += n(f.igst_amount);
    acc.cgst += n(f.cgst_amount);
    acc.sgst += n(f.sgst_amount);
    return acc;
  }, { igst: 0, cgst: 0, sgst: 0 });

  const outputTax = {
    igst: outward.igst - cnReduction.igst,
    cgst: outward.cgst - cnReduction.cgst,
    sgst: outward.sgst - cnReduction.sgst,
  };
  const netPayable = {
    igst: Math.max(0, outputTax.igst - itcTotal.igst),
    cgst: Math.max(0, outputTax.cgst - itcTotal.cgst),
    sgst: Math.max(0, outputTax.sgst - itcTotal.sgst),
  };

  const gstr3b = {
    outward_taxable: outward,
    outward_rcm: outwardRcm,
    credit_note_reduction: cnReduction,
    output_tax: outputTax,
    itc_available: itcTotal,
    net_payable: netPayable,
    total_net_payable: netPayable.igst + netPayable.cgst + netPayable.sgst,
    total_output: outputTax.igst + outputTax.cgst + outputTax.sgst,
    total_itc: itcTotal.igst + itcTotal.cgst + itcTotal.sgst,
    period_from: from ?? "",
    period_to: to ?? "",
    client_name: client.client_name,
    client_gstin: client.gstin ?? "",
  };

  // ── Return JSON ──────────────────────────────────────────────────────────
  if (fmt !== "excel") {
    return NextResponse.json({ gstr3b, b2b, b2c_large, b2c_small, hsn, itc });
  }

  // ── Excel Export ─────────────────────────────────────────────────────────
  const wb = XLSX.utils.book_new();

  // Sheet 1: GSTR-3B Filing Summary
  const safe = (n: number) => n.toFixed(2);
  const g3bRows = [
    ["GSTR-3B FILING DATA", "", "", "", ""],
    [`Client: ${client.client_name}`, `GSTIN: ${client.gstin ?? "N/A"}`, "", `Period: ${from ?? "All"} to ${to ?? "All"}`, ""],
    ["", "", "", "", ""],
    ["Section", "Description", "Taxable Value (₹)", "Integrated Tax (₹)", "Central Tax (₹)", "State/UT Tax (₹)"],
    ["3.1(a)", "Outward taxable supplies (other than zero, nil, exempt)", safe(outward.taxable), safe(outputTax.igst), safe(outputTax.cgst), safe(outputTax.sgst)],
    ["3.1(d)", "Inward supplies liable to RCM", safe(outwardRcm.taxable), safe(outwardRcm.igst), safe(outwardRcm.cgst), safe(outwardRcm.sgst)],
    ["", "", "", "", "", ""],
    ["4(A)(5)", "All other ITC (inputs/services from registered suppliers)", "", safe(itcTotal.igst), safe(itcTotal.cgst), safe(itcTotal.sgst)],
    ["", "", "", "", "", ""],
    ["NET", "Output Tax", "", safe(outputTax.igst), safe(outputTax.cgst), safe(outputTax.sgst)],
    ["NET", "Less: ITC Available", "", safe(itcTotal.igst), safe(itcTotal.cgst), safe(itcTotal.sgst)],
    ["NET", "TAX PAYABLE (after ITC)", "", safe(netPayable.igst), safe(netPayable.cgst), safe(netPayable.sgst)],
    ["", "", "", "", "", ""],
    ["TOTAL NET PAYABLE", "", "", "", "", safe(gstr3b.total_net_payable)],
  ];
  const ws3b = XLSX.utils.aoa_to_sheet(g3bRows);
  ws3b["!cols"] = [{ wch: 12 }, { wch: 52 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }];
  ws3b["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];
  XLSX.utils.book_append_sheet(wb, ws3b, "GSTR-3B Summary");

  // Sheet 2: GSTR-1 B2B
  const b2bRows = (b2b as Array<Record<string, unknown>>).map((r, i) => ({
    "Sr.": i + 1,
    "GSTIN of Recipient": r.gstin,
    "Invoice Number": r.invoice_no,
    "Invoice Date": r.invoice_date,
    "Invoice Value (₹)": fmt2(r.invoice_value as number),
    "Place of Supply": r.place_of_supply,
    "Reverse Charge": r.reverse_charge,
    "Applicable % of Tax Rate": r.applicable_tax_rate,
    "Taxable Value (₹)": fmt2(r.taxable_value as number),
    "IGST (₹)": fmt2(r.igst as number),
    "CGST (₹)": fmt2(r.cgst as number),
    "SGST/UTGST (₹)": fmt2(r.sgst as number),
    "Cess (₹)": "0.00",
  }));
  if (b2bRows.length > 0) {
    (b2bRows as Record<string, unknown>[]).push({
      "Sr.": "TOTAL", "GSTIN of Recipient": "", "Invoice Number": "", "Invoice Date": "",
      "Invoice Value (₹)": fmt2((b2b as Array<{ invoice_value: number }>).reduce((s, r) => s + r.invoice_value, 0)),
      "Place of Supply": "", "Reverse Charge": "", "Applicable % of Tax Rate": "",
      "Taxable Value (₹)": fmt2((b2b as Array<{ taxable_value: number }>).reduce((s, r) => s + r.taxable_value, 0)),
      "IGST (₹)": fmt2((b2b as Array<{ igst: number }>).reduce((s, r) => s + r.igst, 0)),
      "CGST (₹)": fmt2((b2b as Array<{ cgst: number }>).reduce((s, r) => s + r.cgst, 0)),
      "SGST/UTGST (₹)": fmt2((b2b as Array<{ sgst: number }>).reduce((s, r) => s + r.sgst, 0)),
      "Cess (₹)": "0.00",
    });
  }
  const wsB2B = XLSX.utils.json_to_sheet(b2bRows.length > 0 ? b2bRows : [{ "Note": "No B2B sales invoices found for this period" }]);
  wsB2B["!cols"] = [{ wch: 5 }, { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsB2B, "GSTR-1 B2B");

  // Sheet 3: GSTR-1 B2C Large
  const b2cLargeRows = b2c_large.map((r, i) => ({
    "Sr.": i + 1,
    "Invoice Number": r.invoice_no,
    "Invoice Date": r.invoice_date,
    "Invoice Value (₹)": fmt2(r.invoice_value),
    "Place of Supply": r.place_of_supply,
    "Applicable % of Tax Rate": r.applicable_tax_rate,
    "Taxable Value (₹)": fmt2(r.taxable_value),
    "IGST (₹)": fmt2(r.igst),
    "Cess (₹)": "0.00",
  }));
  const wsB2CL = XLSX.utils.json_to_sheet(b2cLargeRows.length > 0 ? b2cLargeRows : [{ "Note": "No B2C large invoices found" }]);
  wsB2CL["!cols"] = [{ wch: 5 }, { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsB2CL, "GSTR-1 B2C Large");

  // Sheet 4: GSTR-1 B2C Small (aggregated)
  const b2cSmallRows = b2c_small.map((r, i) => ({
    "Sr.": i + 1,
    "Place of Supply": r.place_of_supply || "—",
    "Applicable % of Tax Rate": r.rate,
    "Taxable Value (₹)": fmt2(r.taxable),
    "IGST (₹)": fmt2(r.igst),
    "CGST (₹)": fmt2(r.cgst),
    "SGST/UTGST (₹)": fmt2(r.sgst),
    "Cess (₹)": "0.00",
  }));
  const wsB2CS = XLSX.utils.json_to_sheet(b2cSmallRows.length > 0 ? b2cSmallRows : [{ "Note": "No B2C small invoices found" }]);
  wsB2CS["!cols"] = [{ wch: 5 }, { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsB2CS, "GSTR-1 B2C Small");

  // Sheet 5: HSN Summary (GSTR-1 Table 12)
  const hsnRows = hsn.map((r, i) => ({
    "Sr.": i + 1,
    "HSN/SAC": r.hsn,
    "Description": r.description || "—",
    "UQC": r.uqc,
    "Total Qty": r.qty,
    "Total Value (₹)": fmt2(r.taxable),
    "Taxable Value (₹)": fmt2(r.taxable),
    "IGST (₹)": fmt2(r.igst),
    "CGST (₹)": fmt2(r.cgst),
    "SGST/UTGST (₹)": fmt2(r.sgst),
    "Cess (₹)": "0.00",
  }));
  const wsHSN = XLSX.utils.json_to_sheet(hsnRows.length > 0 ? hsnRows : [{ "Note": "No HSN/SAC data found — ensure invoices have HSN codes" }]);
  wsHSN["!cols"] = [{ wch: 5 }, { wch: 14 }, { wch: 24 }, { wch: 8 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsHSN, "HSN Summary");

  // Sheet 6: ITC Register (purchase invoices)
  const itcRows = (itc as Array<Record<string, unknown>>).map((r) => ({
    "Sr.": r.sr,
    "Vendor Name": r.vendor_name,
    "Vendor GSTIN": r.vendor_gstin,
    "Invoice No": r.invoice_no,
    "Invoice Date": r.invoice_date,
    "Doc Type": r.doc_type,
    "Taxable Value (₹)": fmt2(r.taxable_value as number),
    "IGST (₹)": fmt2(r.igst as number),
    "CGST (₹)": fmt2(r.cgst as number),
    "SGST (₹)": fmt2(r.sgst as number),
    "Total ITC (₹)": fmt2(r.total_itc as number),
    "ITC Eligible": r.itc_eligible,
  }));
  if (itcRows.length > 0) {
    const eligibleItc = (itc as Array<{ itc_eligible: string; igst: number; cgst: number; sgst: number; total_itc: number }>)
      .filter((r) => r.itc_eligible === "Eligible");
    (itcRows as Record<string, unknown>[]).push({
      "Sr.": "TOTAL (Eligible)", "Vendor Name": "", "Vendor GSTIN": "", "Invoice No": "", "Invoice Date": "", "Doc Type": "",
      "Taxable Value (₹)": "",
      "IGST (₹)": fmt2(eligibleItc.reduce((s, r) => s + r.igst, 0)),
      "CGST (₹)": fmt2(eligibleItc.reduce((s, r) => s + r.cgst, 0)),
      "SGST (₹)": fmt2(eligibleItc.reduce((s, r) => s + r.sgst, 0)),
      "Total ITC (₹)": fmt2(eligibleItc.reduce((s, r) => s + r.total_itc, 0)),
      "ITC Eligible": "",
    });
  }
  const wsITC = XLSX.utils.json_to_sheet(itcRows.length > 0 ? itcRows : [{ "Note": "No purchase invoices with GST found" }]);
  wsITC["!cols"] = [{ wch: 5 }, { wch: 28 }, { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsITC, "ITC Register");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const safeName = (client.client_name ?? "client").replace(/[^a-z0-9]/gi, "_");
  const periodLabel = from ? `${from}_to_${to ?? "now"}` : "all";

  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="GST-Filing-${safeName}-${periodLabel}.xlsx"`,
    },
  });
}
