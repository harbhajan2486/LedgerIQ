import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import * as XLSX from "xlsx";

// GET /api/v1/tally/export-excel
// Downloads an Excel workbook of reviewed/reconciled invoices formatted for Tally import
// Two sheets:
//   1. "Voucher Data" — one row per invoice, ready for manual Tally entry or import
//   2. "Instructions" — how to import this file into TallyPrime

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
    const period = searchParams.get("period") ?? "this_month";

    const now = new Date();
    let startDate: string;
    let endDate: string = now.toISOString().slice(0, 10);

    if (period === "last_month") {
      const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      startDate = lm.toISOString().slice(0, 10);
      endDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    } else if (period === "this_quarter") {
      startDate = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1).toISOString().slice(0, 10);
    } else if (period === "this_year") {
      const fyStart = now.getMonth() < 3
        ? new Date(now.getFullYear() - 1, 3, 1)
        : new Date(now.getFullYear(), 3, 1);
      startDate = fyStart.toISOString().slice(0, 10);
    } else {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    }

    // Fetch reviewed/reconciled/posted documents
    const { data: docs } = await supabase
      .from("documents")
      .select("id, original_filename, document_type, created_at")
      .eq("tenant_id", tenantId)
      .in("status", ["reviewed", "reconciled", "posted"])
      .order("created_at", { ascending: false });

    if (!docs || docs.length === 0) {
      return NextResponse.json({ error: "No documents ready for export" }, { status: 404 });
    }

    const docIds = docs.map((d) => d.id);

    const FIELDS = [
      "vendor_name", "vendor_gstin", "invoice_number", "invoice_date",
      "taxable_value", "cgst_rate", "cgst_amount", "sgst_rate", "sgst_amount",
      "igst_rate", "igst_amount", "total_amount", "tds_section", "tds_rate", "tds_amount",
      "reverse_charge", "place_of_supply",
    ];

    const { data: extractions } = await supabase
      .from("extractions")
      .select("document_id, field_name, extracted_value")
      .in("document_id", docIds)
      .in("field_name", FIELDS)
      .in("status", ["accepted", "corrected"]);

    const docFields: Record<string, Record<string, string>> = {};
    for (const e of extractions ?? []) {
      if (!docFields[e.document_id]) docFields[e.document_id] = {};
      docFields[e.document_id][e.field_name] = e.extracted_value ?? "";
    }

    // Fetch tally posting status
    const { data: postings } = await supabase
      .from("tally_postings")
      .select("document_id, status, posted_at")
      .in("document_id", docIds)
      .eq("status", "success");
    const postedSet = new Set((postings ?? []).map((p) => p.document_id));

    // Filter by invoice_date in period
    const voucherRows = docs
      .map((doc) => {
        const f = docFields[doc.id] ?? {};
        const invDate = f.invoice_date ?? doc.created_at?.slice(0, 10) ?? "";
        return { doc, f, invDate };
      })
      .filter(({ invDate }) => invDate >= startDate && invDate <= endDate)
      .map(({ doc, f }) => {
        const taxable = parseFloat(f.taxable_value ?? "0") || 0;
        const cgst = parseFloat(f.cgst_amount ?? "0") || 0;
        const sgst = parseFloat(f.sgst_amount ?? "0") || 0;
        const igst = parseFloat(f.igst_amount ?? "0") || 0;
        const tds = parseFloat(f.tds_amount ?? "0") || 0;
        const total = parseFloat(f.total_amount ?? "0") || 0;
        const netPayable = total - tds;

        return {
          "Invoice Date": f.invoice_date ?? "",
          "Invoice Number": f.invoice_number ?? "",
          "Vendor Name": f.vendor_name ?? "",
          "Vendor GSTIN": f.vendor_gstin ?? "",
          "Voucher Type": "Purchase",
          "Taxable Value": taxable || "",
          "CGST Rate (%)": f.cgst_rate ?? "",
          "CGST Amount": cgst || "",
          "SGST Rate (%)": f.sgst_rate ?? "",
          "SGST Amount": sgst || "",
          "IGST Rate (%)": f.igst_rate ?? "",
          "IGST Amount": igst || "",
          "Total GST": cgst + sgst + igst || "",
          "Total Amount": total || "",
          "TDS Section": f.tds_section ?? "",
          "TDS Rate (%)": f.tds_rate ?? "",
          "TDS Amount": tds || "",
          "Net Payable": netPayable || "",
          "Reverse Charge": f.reverse_charge ?? "No",
          "Place of Supply": f.place_of_supply ?? "",
          "Dr Ledger (Purchase)": f.vendor_name ?? "Purchase Account",
          "Cr Ledger (Creditor)": f.vendor_name ?? "Sundry Creditors",
          "Narration": `Purchase - ${f.invoice_number ?? ""} from ${f.vendor_name ?? ""}`.trim(),
          "Tally Posted": postedSet.has(doc.id) ? "Yes" : "No",
          "File Name": doc.original_filename,
        };
      });

    if (voucherRows.length === 0) {
      return NextResponse.json({ error: "No documents found for selected period" }, { status: 404 });
    }

    // Sheet 2: Instructions
    const instructionRows = [
      { Step: "1", Instructions: "Open TallyPrime → Gateway of Tally → Import → Masters/Transactions" },
      { Step: "2", Instructions: "Or use the 'Voucher Entry' screen — refer columns 'Dr Ledger (Purchase)' and 'Cr Ledger (Creditor)'" },
      { Step: "3", Instructions: "Invoice Date → Voucher Date field in Tally" },
      { Step: "4", Instructions: "Ensure ledger names match exactly — create missing ledgers under Sundry Creditors group first" },
      { Step: "5", Instructions: "For GST invoices: Input CGST / Input SGST / Input IGST must be created in Tally under Duties & Taxes" },
      { Step: "6", Instructions: "For TDS: Create TDS Payable ledger under Current Liabilities, set correct section code" },
      { Step: "7", Instructions: "Net Payable = Total Amount - TDS Amount (actual bank payment amount)" },
      { Step: "8", Instructions: "Reverse Charge = Yes means you owe GST directly to government, not vendor" },
    ];

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.json_to_sheet(voucherRows);
    const ws2 = XLSX.utils.json_to_sheet(instructionRows);

    // Style: set column widths
    ws1["!cols"] = [
      { wch: 14 }, { wch: 18 }, { wch: 28 }, { wch: 20 }, { wch: 14 },
      { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 },
      { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 18 },
      { wch: 24 }, { wch: 24 }, { wch: 40 }, { wch: 10 }, { wch: 30 },
    ];

    XLSX.utils.book_append_sheet(wb, ws1, "Voucher Data");
    XLSX.utils.book_append_sheet(wb, ws2, "Tally Instructions");

    const excelBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const periodLabel = period.replace(/_/g, "-");
    const filename = `tally-export-${periodLabel}-${new Date().toISOString().slice(0, 10)}.xlsx`;

    return new NextResponse(excelBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[tally/export-excel]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
