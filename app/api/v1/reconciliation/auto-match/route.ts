import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { scoreMatch } from "@/lib/bank-statement-parser";

const MATCH_THRESHOLD = 70;   // auto-match if score >= 70
const POSSIBLE_THRESHOLD = 40; // flag as possible match if 40-69 (raised from 15 — reduces noise)

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
  // Include already-matched/possible_match txns so we can re-score and update reasons
  const txnQuery = supabase
    .from("bank_transactions")
    .select("id, transaction_date, narration, ref_number, debit_amount, credit_amount, balance")
    .eq("tenant_id", tenantId)
    .in("status", ["unmatched", "matched", "possible_match"]);

  if (transactionIds?.length > 0) txnQuery.in("id", transactionIds);

  const MATCH_FIELDS = [
    "invoice_number", "invoice_date", "due_date", "total_amount",
    "tds_amount", "vendor_name", "buyer_name", "payment_reference", "suggested_ledger",
  ];

  const [
    { data: transactions },
    { data: docs },
    { data: existingRecons },
  ] = await Promise.all([
    txnQuery,
    supabase.from("documents").select("id, document_type").eq("tenant_id", tenantId)
      .in("status", ["reviewed", "reconciled", "posted"]), // only human-verified docs
    supabase.from("reconciliations").select("document_id, bank_transaction_id, status")
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

  // Build doc_type lookup
  const docTypeMap: Record<string, string> = {};
  for (const d of docs ?? []) docTypeMap[d.id] = (d as { id: string; document_type: string }).document_type;

  // Only exclude docs that are firmly matched — possible_match is tentative and can be re-scored
  const firmlyMatchedDocIds = new Set(
    (existingRecons ?? []).filter((r) => (r as { status: string }).status === "matched").map((r) => r.document_id)
  );
  const reconciledTxnIds = new Set((existingRecons ?? []).map((r) => r.bank_transaction_id));

  // Only invoices that have ANY extraction data and aren't already firmly matched
  const unmatchedInvoices = Object.entries(invoiceMap)
    .filter(([id]) => !firmlyMatchedDocIds.has(id))
    .map(([id, fields]) => ({
      id,
      doc_type: docTypeMap[id] ?? null,
      invoice_number: fields.invoice_number ?? null,
      invoice_date: fields.invoice_date ?? null,
      due_date: fields.due_date ?? null,
      total_amount: fields.total_amount ? parseFloat(fields.total_amount) : null,
      tds_amount: fields.tds_amount ? parseFloat(fields.tds_amount) : null,
      vendor_name: fields.vendor_name ?? null,
      buyer_name: fields.buyer_name ?? null,
      payment_reference: fields.payment_reference ?? null,
      suggested_ledger: fields.suggested_ledger ?? null,
    }));

  // ── 3. Score all pairs, then assign highest-confidence matches first ────────
  //
  // WHY: Greedy matching in transaction order (chronological) is unfair — the
  // first txn chronologically "claims" a document even if a later txn scores 95
  // vs the first one scoring 65. By scoring all pairs upfront and sorting by
  // score descending, the best evidence locks in first.

  // Build map: txn_id → already-paired doc_id (only firm matches)
  const existingPairMap: Record<string, string> = {};
  for (const r of existingRecons ?? []) {
    if (r.bank_transaction_id && r.document_id && (r as { status: string }).status === "matched") {
      existingPairMap[r.bank_transaction_id] = r.document_id;
    }
  }

  // Score every (txn, invoice) combination
  interface ScoredPair {
    txnId: string;
    invoiceId: string;
    score: number;
    reasons: string[];
    alreadyPaired: boolean; // this txn was previously firmly matched to this invoice
  }
  const allPairs: ScoredPair[] = [];

  for (const txn of transactions) {
    const alreadyPairedDocId = existingPairMap[txn.id] ?? null;
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

    for (const invoice of unmatchedInvoices) {
      // For already-paired txns, only score against their original document
      if (alreadyPairedDocId && invoice.id !== alreadyPairedDocId) continue;
      const { score, reasons } = scoreMatch(txnForScoring, invoice);
      if (score >= POSSIBLE_THRESHOLD || alreadyPairedDocId) {
        allPairs.push({
          txnId: txn.id,
          invoiceId: invoice.id,
          score,
          reasons,
          alreadyPaired: !!alreadyPairedDocId,
        });
      }
    }
  }

  // Sort descending by score — best evidence claims its match first
  allPairs.sort((a, b) => b.score - a.score);

  const reconRows: Record<string, unknown>[] = [];
  const matchedTxnUpdates: { id: string; status: string }[] = [];
  const matchedDocIds: string[] = [];
  const usedDocIds = new Set<string>();
  const usedTxnIds = new Set<string>();

  for (const pair of allPairs) {
    // Skip if either side is already claimed (except re-evaluation of existing pairs)
    if (!pair.alreadyPaired && usedDocIds.has(pair.invoiceId)) continue;
    if (usedTxnIds.has(pair.txnId)) continue;

    const status: string = pair.score >= MATCH_THRESHOLD ? "matched" : "possible_match";

    // Only "claim" the document slot for confirmed matches (not possible_match)
    // so multiple txns can still be flagged as possible_match for the same doc
    if (status === "matched") {
      usedDocIds.add(pair.invoiceId);
      matchedDocIds.push(pair.invoiceId);
    }
    usedTxnIds.add(pair.txnId);

    reconRows.push({
      tenant_id: tenantId,
      document_id: pair.invoiceId,
      bank_transaction_id: pair.txnId,
      match_score: pair.score,
      match_reasons: pair.reasons,
      status,
      matched_at: new Date().toISOString(),
    });
    matchedTxnUpdates.push({ id: pair.txnId, status });
  }

  if (reconRows.length === 0) return NextResponse.json({ matched: 0, possible: 0 });

  // ── 4. Batch write everything ─────────────────────────────────────────────
  const matchedTxnIds  = matchedTxnUpdates.filter((u) => u.status === "matched").map((u) => u.id);
  const possibleTxnIds = matchedTxnUpdates.filter((u) => u.status === "possible_match").map((u) => u.id);

  // Build ledger_name update map: for each matched txn, propagate suggested_ledger from invoice
  const ledgerUpdates: { txnId: string; ledger: string }[] = [];
  for (const row of reconRows) {
    if ((row as { status: string }).status !== "matched") continue;
    const docId = (row as { document_id: string }).document_id;
    const txnId = (row as { bank_transaction_id: string }).bank_transaction_id;
    const ledger = invoiceMap[docId]?.suggested_ledger;
    if (ledger) ledgerUpdates.push({ txnId, ledger });
  }

  await Promise.all([
    supabase.from("reconciliations").upsert(reconRows, { onConflict: "tenant_id,bank_transaction_id" }).then(),
    matchedTxnIds.length  > 0 ? supabase.from("bank_transactions").update({ status: "matched" }).in("id", matchedTxnIds).then() : null,
    possibleTxnIds.length > 0 ? supabase.from("bank_transactions").update({ status: "possible_match" }).in("id", possibleTxnIds).then() : null,
    matchedDocIds.length  > 0 ? supabase.from("documents").update({ status: "reconciled" }).in("id", matchedDocIds).then() : null,
    // Auto-populate ledger_name on matched bank transactions from document's suggested_ledger
    ...ledgerUpdates.map(({ txnId, ledger }) =>
      supabase.from("bank_transactions").update({ ledger_name: ledger }).eq("id", txnId).then()
    ),
  ].filter(Boolean));

  return NextResponse.json({ matched: matchedTxnIds.length, possible: possibleTxnIds.length });
  } catch (err) {
    console.error("[reconciliation/auto-match] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
