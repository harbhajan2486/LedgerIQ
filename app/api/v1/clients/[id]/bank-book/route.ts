import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import ExcelJS from "exceljs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const { id: clientId } = await params;
  const { data: client } = await supabase.from("clients").select("client_name").eq("id", clientId).eq("tenant_id", profile.tenant_id).single();

  const { data: txns } = await supabase
    .from("bank_transactions")
    .select("transaction_date, narration, ref_number, bank_name, voucher_type, ledger_name, category, debit_amount, credit_amount, balance, status")
    .eq("tenant_id", profile.tenant_id)
    .eq("client_id", clientId)
    .order("transaction_date", { ascending: true })
    .order("created_at", { ascending: true });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Bank Book");

  // Title rows
  ws.addRow([client?.client_name ?? "Bank Book"]);
  ws.addRow(["Bank Book"]);
  ws.addRow([]);

  // Header
  const headerRow = ws.addRow([
    "Date", "Narration", "Ref No", "Bank", "Voucher Type",
    "Ledger Name", "Category", "Debit (₹)", "Credit (₹)", "Balance (₹)", "Recon Status"
  ]);
  headerRow.font = { bold: true };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };

  // Column widths
  ws.columns = [
    { width: 14 }, { width: 40 }, { width: 18 }, { width: 20 }, { width: 14 },
    { width: 28 }, { width: 22 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 },
  ];

  for (const txn of txns ?? []) {
    const row = ws.addRow([
      txn.transaction_date,
      txn.narration,
      txn.ref_number ?? "",
      txn.bank_name,
      txn.voucher_type ?? "",
      txn.ledger_name ?? "",
      txn.category ?? "",
      txn.debit_amount ? Number(txn.debit_amount) : null,
      txn.credit_amount ? Number(txn.credit_amount) : null,
      txn.balance ? Number(txn.balance) : null,
      txn.status,
    ]);
    // Highlight unmatched rows
    if (txn.status === "unmatched") {
      row.getCell(6).font = { color: { argb: "FFB45309" } }; // amber for missing ledger
    }
    if (!txn.ledger_name) {
      row.getCell(6).value = "— not set —";
      row.getCell(6).font = { color: { argb: "FFB45309" }, italic: true };
    }
  }

  // Totals row
  const totalDebit  = (txns ?? []).reduce((s, t) => s + (Number(t.debit_amount) || 0), 0);
  const totalCredit = (txns ?? []).reduce((s, t) => s + (Number(t.credit_amount) || 0), 0);
  const totRow = ws.addRow(["TOTAL", "", "", "", "", "", "", totalDebit || null, totalCredit || null, "", ""]);
  totRow.font = { bold: true };
  totRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };

  const buf = await wb.xlsx.writeBuffer();
  const safeName = (client?.client_name ?? "client").replace(/[^a-z0-9]/gi, "_");
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="bank-book-${safeName}.xlsx"`,
    },
  });
}
