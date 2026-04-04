import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseCSV, parseXLSX } from "@/lib/bank-statement-parser";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", user.id)
    .single();

  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });
  const tenantId = profile.tenant_id;

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const bankName = (formData.get("bank_name") as string) || "Unknown Bank";

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  const fileName = file.name.toLowerCase();
  const fileSize = file.size;

  if (fileSize > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
  }

  let transactions;
  try {
    if (fileName.endsWith(".csv")) {
      const text = await file.text();
      transactions = parseCSV(text);
    } else if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
      const buffer = await file.arrayBuffer();
      transactions = parseXLSX(buffer);
    } else {
      return NextResponse.json({ error: "Only CSV and Excel files are supported. For PDF statements, download them as CSV from your internet banking." }, { status: 400 });
    }
  } catch (err) {
    console.error("[upload-statement] parse error:", err);
    return NextResponse.json({ error: "Could not parse the file. Please check the format and try again." }, { status: 400 });
  }

  if (transactions.length === 0) {
    return NextResponse.json({ error: "No transactions found in file. Check the file has transaction rows." }, { status: 400 });
  }

  // Insert bank_transactions rows
  const rows = transactions.map((txn) => ({
    tenant_id: tenantId,
    bank_name: bankName,
    transaction_date: txn.date,
    narration: txn.narration,
    ref_number: txn.ref_number,
    debit_amount: txn.debit,
    credit_amount: txn.credit,
    balance: txn.balance,
    status: "unmatched",
  }));

  const { data: inserted, error: insertError } = await supabase
    .from("bank_transactions")
    .insert(rows)
    .select("id");

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  await supabase.from("audit_log").insert({
    tenant_id: tenantId,
    user_id: user.id,
    action: "upload_bank_statement",
    entity_type: "bank_transactions",
    entity_id: tenantId,
    new_value: { file_name: file.name, bank_name: bankName, transaction_count: transactions.length },
  });

  // Trigger auto-matching in background
  const transactionIds = (inserted ?? []).map((r) => r.id);
  fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/v1/reconciliation/auto-match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, transactionIds }),
  }).catch(() => {});

  return NextResponse.json({ success: true, count: transactions.length });
}
