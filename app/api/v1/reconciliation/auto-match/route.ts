import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { scoreMatch } from "@/lib/bank-statement-parser";

const MATCH_THRESHOLD = 70;   // auto-match if score >= 70
const POSSIBLE_THRESHOLD = 15; // flag as possible match if 15-69

export async function POST(request: NextRequest) {
  try {
  const supabase = await createClient();
  const body = await request.json().catch(() => ({}));
  let { tenantId, transactionIds } = body;

  if (!tenantId) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });
    tenantId = profile.tenant_id;
  }

  // ── 1. Fetch data in parallel ──────────────────────────────────────────────
  const txnQuery = supabase
    .from("bank_transactions")
    .select("id, transaction_date, narration, ref_number, debit_amount, credit_amount, balance")
    .eq("tenant_id", tenantId)
    .eq("status", "unmatched");

  if (transactionIds?.length > 0) txnQuery.in("id", transactionIds);

  const MATCH_FIELDS = ["invoice_number", "invoice_date", "due_date", "total_amount", "tds_amount", "vendor_name", "payment_reference"];

  const [
    { data: transactions },
    { data: docs },
    { data: existingRecons },
  ] = await Promise.all([
    txnQuery,
    supabase.from("documents").select("id").eq("tenant_id", tenantId)
      .in("status", ["review_required", "reviewed", "reconciled", "posted"]),
    supabase.from("reconciliations").select("document_id, bank_transaction_id")
      .eq("tenant_id", tenantId).neq("status", "exception"),
  ]);

  if (!transactions?.length || !docs?.length) return NextResponse.json({ matched: 0 });

  const docIds = docs.map((d) => d.id);
  const { data: extractions } = await supabase
    .from("extractions")
    .select("document_id, field_name, extracted_value")
    .in("document_id", docIds)
    .in("field_name", MATCH_FIELDS)
    .not("status", "eq", "rejected");

  // ── 2. Build invoice objects ───────────────────────────────────────────────
  const invoiceMap: Record<string, Record<string, string | null>> = {};
  for (const ext of extractions ?? []) {
    if (!invoiceMap[ext.document_id]) invoiceMap[ext.document_id] = {};
    invoiceMap[ext.document_id][ext.field_name] = ext.extracted_value;
  }

  const reconciledDocIds = new Set((existingRecons ?? []).map((r) => r.document_id));
  const reconciledTxnIds = new Set((existingRecons ?? []).map((r) => r.bank_transaction_id));

  // Only invoices that have ANY extraction data and aren't already matched
  const unmatchedInvoices = Object.entries(invoiceMap)
    .filter(([id]) => !reconciledDocIds.has(id))
    .map(([id, fields]) => ({
      id,
      invoice_number: fields.invoice_number ?? null,
      invoice_date: fields.invoice_date ?? null,
      due_date: fields.due_date ?? null,
      total_amount: fields.total_amount ? parseFloat(fields.total_amount) : null,
      tds_amount: fields.tds_amount ? parseFloat(fields.tds_amount) : null,
      vendor_name: fields.vendor_name ?? null,
      payment_reference: fields.payment_reference ?? null,
    }));

  // ── 3. Score all transactions in memory (no DB writes) ────────────────────
  const reconRows: Record<string, unknown>[] = [];
  const matchedTxnUpdates: { id: string; status: string }[] = [];
  const matchedDocIds: string[] = [];
  const usedDocIds = new Set<string>();

  for (const txn of transactions) {
    // Skip txns already in a reconciliation record
    if (reconciledTxnIds.has(txn.id)) continue;

    const txnForScoring = {
      id: txn.id,
      date: txn.transaction_date,
      narration: txn.narration ?? "",
      ref_number: txn.ref_number ?? null,
      debit: txn.debit_amount ?? null,
      credit: txn.credit_amount ?? null,
      balance: txn.balance ?? null,
      raw_row: {},
    };

    let bestScore = 0;
    let bestInvoice: (typeof unmatchedInvoices)[0] | null = null;
    let bestReasons: string[] = [];

    for (const invoice of unmatchedInvoices) {
      if (usedDocIds.has(invoice.id)) continue; // already claimed by a better-scoring txn
      const { score, reasons } = scoreMatch(txnForScoring, invoice);
      if (score > bestScore) {
        bestScore = score;
        bestInvoice = invoice;
        bestReasons = reasons;
      }
    }

    if (bestInvoice && bestScore >= POSSIBLE_THRESHOLD) {
      const status = bestScore >= MATCH_THRESHOLD ? "matched" : "possible_match";
      if (status === "matched") usedDocIds.add(bestInvoice.id); // reserve this invoice

      reconRows.push({
        tenant_id: tenantId,
        document_id: bestInvoice.id,
        bank_transaction_id: txn.id,
        match_score: bestScore,
        match_reasons: bestReasons,
        status,
        matched_at: new Date().toISOString(),
      });
      matchedTxnUpdates.push({ id: txn.id, status });
      if (status === "matched") matchedDocIds.push(bestInvoice.id);
    }
  }

  if (reconRows.length === 0) return NextResponse.json({ matched: 0, possible: 0 });

  // ── 4. Batch write everything ─────────────────────────────────────────────
  // Batch-update bank transaction statuses (group by status to minimise calls)
  const matchedTxnIds  = matchedTxnUpdates.filter((u) => u.status === "matched").map((u) => u.id);
  const possibleTxnIds = matchedTxnUpdates.filter((u) => u.status === "possible_match").map((u) => u.id);

  await Promise.all([
    supabase.from("reconciliations").upsert(reconRows, { onConflict: "tenant_id,bank_transaction_id" }).then(),
    matchedTxnIds.length  > 0 ? supabase.from("bank_transactions").update({ status: "matched" }).in("id", matchedTxnIds).then() : null,
    possibleTxnIds.length > 0 ? supabase.from("bank_transactions").update({ status: "possible_match" }).in("id", possibleTxnIds).then() : null,
    matchedDocIds.length  > 0 ? supabase.from("documents").update({ status: "reconciled" }).in("id", matchedDocIds).then() : null,
  ].filter(Boolean));

  return NextResponse.json({ matched: matchedTxnIds.length, possible: possibleTxnIds.length });
  } catch (err) {
    console.error("[reconciliation/auto-match] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
