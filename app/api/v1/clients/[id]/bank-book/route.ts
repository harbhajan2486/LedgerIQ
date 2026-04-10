import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import * as XLSX from "xlsx";

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

  const rows = (txns ?? []).map((txn) => ({
    Date:           txn.transaction_date,
    Narration:      txn.narration,
    "Ref No":       txn.ref_number ?? "",
    Bank:           txn.bank_name,
    "Voucher Type": txn.voucher_type ?? "",
    "Ledger Name":  txn.ledger_name ?? "",
    Category:       txn.category ?? "",
    "Debit (₹)":   txn.debit_amount  ? Number(txn.debit_amount)  : "",
    "Credit (₹)":  txn.credit_amount ? Number(txn.credit_amount) : "",
    "Balance (₹)": txn.balance       ? Number(txn.balance)       : "",
    Status:         txn.status,
  }));

  // Totals row
  const totalDebit  = (txns ?? []).reduce((s, t) => s + (Number(t.debit_amount)  || 0), 0);
  const totalCredit = (txns ?? []).reduce((s, t) => s + (Number(t.credit_amount) || 0), 0);
  rows.push({
    Date: "TOTAL", Narration: "", "Ref No": "", Bank: "", "Voucher Type": "",
    "Ledger Name": "", Category: "",
    "Debit (₹)": totalDebit || "", "Credit (₹)": totalCredit || "", "Balance (₹)": "", Status: "",
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [
    { wch: 14 }, { wch: 40 }, { wch: 18 }, { wch: 20 }, { wch: 14 },
    { wch: 28 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Bank Book");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const safeName = (client?.client_name ?? "client").replace(/[^a-z0-9]/gi, "_");

  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="bank-book-${safeName}.xlsx"`,
    },
  });
}
