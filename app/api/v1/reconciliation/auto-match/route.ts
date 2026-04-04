import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { scoreMatch } from "@/lib/bank-statement-parser";

const MATCH_THRESHOLD = 70;   // auto-match if score >= 70
const POSSIBLE_THRESHOLD = 30; // flag as possible match if 30-69

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { tenantId, transactionIds } = await request.json();

  if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

  // Fetch the transactions to match
  const txnQuery = supabase
    .from("bank_transactions")
    .select("id, transaction_date, narration, ref_number, debit_amount, credit_amount, balance")
    .eq("tenant_id", tenantId)
    .eq("status", "unmatched");

  if (transactionIds?.length > 0) {
    txnQuery.in("id", transactionIds);
  }

  const { data: transactions } = await txnQuery;
  if (!transactions || transactions.length === 0) return NextResponse.json({ matched: 0 });

  // Fetch all reviewed invoices (documents that are in "reviewed" status)
  const { data: docs } = await supabase
    .from("documents")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "reviewed");

  if (!docs || docs.length === 0) return NextResponse.json({ matched: 0 });

  const docIds = docs.map((d) => d.id);

  // Get extractions for invoice fields we need for matching
  const MATCH_FIELDS = ["invoice_number", "invoice_date", "due_date", "total_amount", "tds_amount", "vendor_name", "payment_reference"];
  const { data: extractions } = await supabase
    .from("extractions")
    .select("document_id, field_name, extracted_value")
    .in("document_id", docIds)
    .in("field_name", MATCH_FIELDS)
    .eq("status", "accepted");

  // Build invoice objects from extractions
  const invoiceMap: Record<string, Record<string, string | null>> = {};
  for (const ext of extractions ?? []) {
    if (!invoiceMap[ext.document_id]) invoiceMap[ext.document_id] = {};
    invoiceMap[ext.document_id][ext.field_name] = ext.extracted_value;
  }

  const invoices = Object.entries(invoiceMap).map(([id, fields]) => ({
    id,
    invoice_number: fields.invoice_number ?? null,
    invoice_date: fields.invoice_date ?? null,
    due_date: fields.due_date ?? null,
    total_amount: fields.total_amount ? parseFloat(fields.total_amount) : null,
    tds_amount: fields.tds_amount ? parseFloat(fields.tds_amount) : null,
    vendor_name: fields.vendor_name ?? null,
    payment_reference: fields.payment_reference ?? null,
  }));

  // Also exclude invoices already reconciled
  const { data: existingRecons } = await supabase
    .from("reconciliations")
    .select("document_id")
    .eq("tenant_id", tenantId)
    .neq("status", "exception");
  const reconciledDocIds = new Set((existingRecons ?? []).map((r) => r.document_id));
  const unmatchedInvoices = invoices.filter((inv) => !reconciledDocIds.has(inv.id));

  let autoMatched = 0;
  let possibleMatched = 0;

  for (const txn of transactions) {
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
    let bestInvoice = null;
    let bestReasons: string[] = [];

    for (const invoice of unmatchedInvoices) {
      const { score, reasons } = scoreMatch(txnForScoring, invoice);
      if (score > bestScore) {
        bestScore = score;
        bestInvoice = invoice;
        bestReasons = reasons;
      }
    }

    if (bestInvoice && bestScore >= POSSIBLE_THRESHOLD) {
      const status = bestScore >= MATCH_THRESHOLD ? "matched" : "possible_match";

      // Upsert reconciliation record
      await supabase.from("reconciliations").upsert({
        tenant_id: tenantId,
        document_id: bestInvoice.id,
        bank_transaction_id: txn.id,
        match_score: bestScore,
        match_reasons: bestReasons,
        status,
        matched_at: new Date().toISOString(),
      }, { onConflict: "tenant_id,bank_transaction_id" });

      // Update transaction status
      await supabase
        .from("bank_transactions")
        .update({ status })
        .eq("id", txn.id);

      if (status === "matched") {
        // Mark invoice as reconciled
        await supabase.from("documents").update({ status: "reconciled" }).eq("id", bestInvoice.id);
        autoMatched++;
        // Remove from unmatched pool so it doesn't match again
        const idx = unmatchedInvoices.findIndex((i) => i.id === bestInvoice!.id);
        if (idx !== -1) unmatchedInvoices.splice(idx, 1);
      } else {
        possibleMatched++;
      }
    }
  }

  return NextResponse.json({ matched: autoMatched, possible: possibleMatched });
}
