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
  const clientId = new URL(request.url).searchParams.get("clientId") ?? null;

  // Fetch reconciliations with their bank transaction + document data
  const reconQuery = supabase
    .from("reconciliations")
    .select(`
      id, status, match_score, match_reasons, matched_at,
      bank_transaction_id, document_id,
      bank_transactions(id, transaction_date, narration, ref_number, debit_amount, credit_amount, bank_name, category, voucher_type, client_id),
      documents(id, original_filename, document_type)
    `)
    .eq("tenant_id", tenantId)
    .order("matched_at", { ascending: false });

  const { data: recons } = await reconQuery;

  // Filter by client if requested
  const filteredRecons = clientId
    ? (recons ?? []).filter((r) => {
        const txn = Array.isArray(r.bank_transactions) ? r.bank_transactions[0] : r.bank_transactions;
        return (txn as { client_id?: string | null } | null)?.client_id === clientId;
      })
    : (recons ?? []);

  // Fetch total_amount and invoice_number extractions for matched/possible docs
  const reconDocIds = filteredRecons.map((r) => r.document_id).filter(Boolean) as string[];
  const { data: reconExtractions } = reconDocIds.length > 0
    ? await supabase
        .from("extractions")
        .select("document_id, field_name, extracted_value, status")
        .in("document_id", reconDocIds)
        .in("field_name", ["total_amount", "invoice_number"])
        .in("status", ["accepted", "corrected", "pending"])
        .order("status", { ascending: true }) // corrected last = wins
    : { data: [] };

  // Build per-doc extraction map: corrected > accepted > pending
  const reconExtMap: Record<string, { total_amount?: string; invoice_number?: string }> = {};
  for (const ext of (reconExtractions ?? [])) {
    if (!reconExtMap[ext.document_id]) reconExtMap[ext.document_id] = {};
    // Always overwrite — since corrected sorts last alphabetically, it wins
    (reconExtMap[ext.document_id] as Record<string, string>)[ext.field_name] = ext.extracted_value ?? "";
  }

  // Enrich each reconciliation with invoice amount + number
  const enrichedRecons = filteredRecons.map((r) => ({
    ...r,
    doc_total_amount:   reconExtMap[r.document_id]?.total_amount   ?? null,
    doc_invoice_number: reconExtMap[r.document_id]?.invoice_number ?? null,
  }));

  // Fetch unmatched bank transactions
  let txnQuery = supabase
    .from("bank_transactions")
    .select("id, transaction_date, narration, ref_number, debit_amount, credit_amount, bank_name, status, category, voucher_type")
    .eq("tenant_id", tenantId)
    .eq("status", "unmatched")
    .order("transaction_date", { ascending: false })
    .limit(1000);
  if (clientId) txnQuery = txnQuery.eq("client_id", clientId);
  const { data: allTxns } = await txnQuery;

  // Fetch unreconciled invoices — scoped to client if provided
  let docsQuery = supabase
    .from("documents")
    .select("id, original_filename, document_type, status")
    .eq("tenant_id", tenantId)
    .in("status", ["review_required", "reviewed"])
    .order("created_at", { ascending: false })
    .limit(200);
  if (clientId) docsQuery = docsQuery.eq("client_id", clientId);
  const { data: unmatchedDocs } = await docsQuery;

  // Get amounts for unmatched docs
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

  const matched    = enrichedRecons.filter((r) => r.status === "matched").length;
  const possible   = enrichedRecons.filter((r) => r.status === "possible_match").length;
  const exceptions = enrichedRecons.filter((r) => r.status === "exception").length;
  const unmatched  = (allTxns ?? []).length;

  return NextResponse.json({
    summary: { matched, possible, exceptions, unmatched_transactions: unmatched, unmatched_invoices: (unmatchedDocs ?? []).length },
    reconciliations: enrichedRecons,
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
