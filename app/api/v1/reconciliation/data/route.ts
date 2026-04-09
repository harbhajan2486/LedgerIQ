import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const tenantId = profile.tenant_id;

  // Fetch reconciliations with their bank transaction + document data
  const { data: recons } = await supabase
    .from("reconciliations")
    .select(`
      id, status, match_score, match_reasons, matched_at,
      bank_transaction_id, document_id,
      bank_transactions(id, transaction_date, narration, ref_number, debit_amount, credit_amount, bank_name),
      documents(id, original_filename, document_type)
    `)
    .eq("tenant_id", tenantId)
    .order("matched_at", { ascending: false });

  // Fetch unmatched bank transactions (no reconciliation record)
  const { data: allTxns } = await supabase
    .from("bank_transactions")
    .select("id, transaction_date, narration, ref_number, debit_amount, credit_amount, bank_name, status, category, voucher_type")
    .eq("tenant_id", tenantId)
    .eq("status", "unmatched")
    .order("transaction_date", { ascending: false })
    .limit(100);

  // Fetch unreconciled invoices (reviewed but not matched)
  const { data: unmatchedDocs } = await supabase
    .from("documents")
    .select("id, original_filename, document_type")
    .eq("tenant_id", tenantId)
    .eq("status", "reviewed")
    .order("created_at", { ascending: false })
    .limit(100);

  // For unmatched docs, get total_amount field
  const unmatchedDocIds = (unmatchedDocs ?? []).map((d) => d.id);
  const { data: amounts } = unmatchedDocIds.length > 0
    ? await supabase
        .from("extractions")
        .select("document_id, extracted_value")
        .in("document_id", unmatchedDocIds)
        .eq("field_name", "total_amount")
        .in("status", ["accepted", "corrected"])
    : { data: [] };
  const amountMap: Record<string, string> = {};
  for (const a of amounts ?? []) amountMap[a.document_id] = a.extracted_value;

  // Summary stats
  const matched = (recons ?? []).filter((r) => r.status === "matched").length;
  const possible = (recons ?? []).filter((r) => r.status === "possible_match").length;
  const exceptions = (recons ?? []).filter((r) => r.status === "exception").length;
  const unmatched = (allTxns ?? []).length;

  return NextResponse.json({
    summary: { matched, possible, exceptions, unmatched_transactions: unmatched, unmatched_invoices: (unmatchedDocs ?? []).length },
    reconciliations: recons ?? [],
    unmatched_transactions: allTxns ?? [],
    unmatched_invoices: (unmatchedDocs ?? []).map((d) => ({
      ...d,
      total_amount: amountMap[d.id] ?? null,
    })),
  });
  } catch (err) {
    console.error("[reconciliation/data] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
