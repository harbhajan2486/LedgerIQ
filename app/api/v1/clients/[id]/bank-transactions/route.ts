import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPattern, suggestLedger } from "@/lib/ledger-rules";

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

    // Fetch client industry + confirmed rules for ledger source derivation
    const [txnsResult, clientRow, rulesResult, industryRulesResult] = await Promise.all([
      supabase
        .from("bank_transactions")
        .select("id, transaction_date, narration, ref_number, debit_amount, credit_amount, balance, bank_name, status, category, voucher_type, ledger_name")
        .eq("tenant_id", profile.tenant_id)
        .eq("client_id", clientId)
        .order("transaction_date", { ascending: true })
        .limit(1000),
      supabase.from("clients").select("industry_name").eq("id", clientId).single(),
      supabase.from("ledger_mapping_rules").select("pattern, ledger_name")
        .eq("client_id", clientId).eq("tenant_id", profile.tenant_id).eq("confirmed", true),
      supabase.from("ledger_mapping_rules").select("pattern, ledger_name, industry_name")
        .eq("tenant_id", profile.tenant_id).is("client_id", null).eq("confirmed", true),
    ]);

    const txns = txnsResult;

    const rows = txns.data ?? [];

    // Build rule maps for ledger source derivation
    const industryName = clientRow.data?.industry_name ?? null;
    const clientRuleMap: Record<string, string> = {};
    for (const r of rulesResult.data ?? []) clientRuleMap[r.pattern] = r.ledger_name;
    const industryRuleMap: Record<string, string> = {};
    for (const r of (industryRulesResult.data ?? []).filter(r => r.industry_name === industryName)) {
      industryRuleMap[r.pattern] = r.ledger_name;
    }

    function deriveLedgerSource(narration: string, ledgerName: string | null): string | null {
      if (!ledgerName) return null;
      const pattern = extractPattern(narration);
      if (clientRuleMap[pattern] === ledgerName) return "Layer 3 – client rule";
      if (industryRuleMap[pattern] === ledgerName) return "Layer 2 – industry rule";
      if (suggestLedger(narration) === ledgerName) return "Layer 1 – global keyword";
      return "Manually assigned";
    }

    // Fetch reconciliation data for matched/possible_match transactions
    const reconTxnIds = rows
      .filter((r) => r.status === "matched" || r.status === "possible_match")
      .map((r) => r.id);

    let reconMap: Record<string, { match_score: number; match_reasons: string[]; document_id: string | null }> = {};
    let docInfoMap: Record<string, { invoice_number: string | null; filename: string | null }> = {};

    if (reconTxnIds.length > 0) {
      const { data: recons } = await supabase
        .from("reconciliations")
        .select("bank_transaction_id, match_score, match_reasons, document_id, status")
        .in("bank_transaction_id", reconTxnIds)
        .neq("status", "exception");

      for (const r of recons ?? []) {
        reconMap[r.bank_transaction_id] = {
          match_score: r.match_score,
          match_reasons: r.match_reasons ?? [],
          document_id: r.document_id,
        };
      }

      // Fetch invoice numbers and filenames for matched documents
      const docIds = Object.values(reconMap).map((r) => r.document_id).filter(Boolean) as string[];
      if (docIds.length > 0) {
        const [{ data: docs }, { data: extractions }] = await Promise.all([
          supabase.from("documents").select("id, original_filename").in("id", docIds),
          supabase.from("extractions")
            .select("document_id, extracted_value")
            .in("document_id", docIds)
            .eq("field_name", "invoice_number")
            .in("status", ["accepted", "corrected", "pending"])
            .order("status", { ascending: true }), // corrected sorts last → wins
        ]);

        const filenameMap: Record<string, string> = {};
        for (const d of docs ?? []) filenameMap[d.id] = d.original_filename;

        const invoiceNumMap: Record<string, string> = {};
        for (const e of extractions ?? []) invoiceNumMap[e.document_id] = e.extracted_value ?? "";

        for (const [, recon] of Object.entries(reconMap)) {
          if (recon.document_id) {
            docInfoMap[recon.document_id] = {
              invoice_number: invoiceNumMap[recon.document_id] ?? null,
              filename: filenameMap[recon.document_id] ?? null,
            };
          }
        }
      }
    }

    // Enrich transactions with match info + ledger source
    const enrichedRows = rows.map((txn) => {
      const recon = reconMap[txn.id];
      const docInfo = recon?.document_id ? docInfoMap[recon.document_id] : null;
      return {
        ...txn,
        ledger_source: deriveLedgerSource(txn.narration ?? "", txn.ledger_name),
        ...(recon ? {
          match_score: recon.match_score,
          match_reasons: recon.match_reasons,
          matched_invoice_number: docInfo?.invoice_number ?? null,
          matched_doc_filename: docInfo?.filename ?? null,
        } : {}),
      };
    });

    // Summary stats
    const totalDebit = rows.reduce((s, r) => s + (r.debit_amount ?? 0), 0);
    const totalCredit = rows.reduce((s, r) => s + (r.credit_amount ?? 0), 0);
    const matched = rows.filter((r) => r.status === "matched").length;
    const unmatched = rows.filter((r) => r.status === "unmatched").length;

    return NextResponse.json({
      transactions: enrichedRows,
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
