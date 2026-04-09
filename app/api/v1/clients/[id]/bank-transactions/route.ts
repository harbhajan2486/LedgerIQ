import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const { id: clientId } = await params;

    const { data: txns } = await supabase
      .from("bank_transactions")
      .select("id, transaction_date, narration, ref_number, debit_amount, credit_amount, balance, bank_name, status, category, voucher_type")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId)
      .order("transaction_date", { ascending: false })
      .limit(1000);

    // Summary stats
    const rows = txns ?? [];
    const totalDebit = rows.reduce((s, r) => s + (r.debit_amount ?? 0), 0);
    const totalCredit = rows.reduce((s, r) => s + (r.credit_amount ?? 0), 0);
    const matched = rows.filter((r) => r.status === "matched").length;
    const unmatched = rows.filter((r) => r.status === "unmatched").length;

    return NextResponse.json({
      transactions: rows,
      summary: {
        total: rows.length,
        total_debit: totalDebit,
        total_credit: totalCredit,
        matched,
        unmatched,
      },
    });
  } catch (err) {
    console.error("[clients/bank-transactions]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
