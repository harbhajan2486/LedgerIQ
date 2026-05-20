import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPattern, suggestLedger } from "@/lib/ledger-rules";
import { fetchApprovedGlobalRules } from "@/lib/global-rules";

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
    const [txnsResult, clientRow, rulesResult, industryRulesResult, allClientRulesResult, ledgerMastersResult] = await Promise.all([
      supabase
        .from("bank_transactions")
        .select("id, transaction_date, narration, ref_number, debit_amount, credit_amount, balance, bank_name, status, category, voucher_type, ledger_name")
        .eq("tenant_id", profile.tenant_id)
        .eq("client_id", clientId)
        .order("transaction_date", { ascending: true })
        .limit(2000),
      supabase.from("clients").select("industry_name").eq("id", clientId).single(),
      supabase.from("ledger_mapping_rules").select("pattern, ledger_name")
        .eq("client_id", clientId).eq("tenant_id", profile.tenant_id).eq("confirmed", true),
      supabase.from("ledger_mapping_rules").select("pattern, ledger_name, industry_name")
        .eq("tenant_id", profile.tenant_id).is("client_id", null).eq("confirmed", true),
      // Load all client rules including unconfirmed, for Learning (X/3) progress display
      supabase.from("ledger_mapping_rules").select("pattern, match_count, confirmed")
        .eq("client_id", clientId).eq("tenant_id", profile.tenant_id),
      // Load ledger masters for taxation flag computation
      supabase.from("ledger_masters").select("ledger_name, ledger_type")
        .eq("tenant_id", profile.tenant_id).eq("client_id", clientId),
    ]);

    const rows = txnsResult.data ?? [];

    // Build ledger master lookup structures for O(1) flag checks
    const ledgerMasters = ledgerMastersResult.data ?? [];
    const ledgerTypeMap: Record<string, string> = {};
    const ledgerNameSet: Set<string> = new Set();
    for (const lm of ledgerMasters) {
      const key = (lm.ledger_name as string).toLowerCase();
      ledgerTypeMap[key] = (lm.ledger_type as string).toLowerCase();
      ledgerNameSet.add(key);
    }

    // Load approved global rules (dynamic Layer 1 from crowd-sourced nominations)
    const approvedGlobalRules = await fetchApprovedGlobalRules();

    // Build rule maps for ledger source derivation
    const industryName = clientRow.data?.industry_name ?? null;
    const clientRuleMap: Record<string, string> = {};
    for (const r of rulesResult.data ?? []) clientRuleMap[r.pattern] = r.ledger_name;
    const industryRuleMap: Record<string, string> = {};
    for (const r of (industryRulesResult.data ?? []).filter(r => r.industry_name === industryName)) {
      industryRuleMap[r.pattern] = r.ledger_name;
    }
    // Map for Learning (X/3) progress: pattern → {count, confirmed}
    const ruleProgressMap: Record<string, { count: number; confirmed: boolean }> = {};
    for (const r of allClientRulesResult.data ?? []) {
      ruleProgressMap[r.pattern] = { count: r.match_count ?? 1, confirmed: r.confirmed ?? false };
    }

    function deriveLedgerSource(narration: string, ledgerName: string | null): string | null {
      if (!ledgerName) return null;
      const pattern = extractPattern(narration);
      if (clientRuleMap[pattern] === ledgerName) return "Layer 3 – client rule";
      if (industryRuleMap[pattern] === ledgerName) return "Layer 2 – industry rule";

      // Check approved global rules (dynamic Layer 1 from crowd-sourced nominations)
      const approvedMatch = approvedGlobalRules.find(
        (r) => r.pattern === pattern && r.ledger_name.toLowerCase() === ledgerName.toLowerCase()
      );
      if (approvedMatch) return "Layer 1 – global keyword";

      // Check built-in Layer 1 keyword rules
      const globalSuggestion = suggestLedger(narration);
      if (globalSuggestion) {
        const gLower = globalSuggestion.toLowerCase();
        const lLower = ledgerName.toLowerCase();
        const gFirst = gLower.split(/\s+/)[0];
        if (gLower === lLower || gLower.startsWith(lLower) || lLower.startsWith(gLower)
            || (gFirst.length >= 5 && lLower.startsWith(gFirst))) {
          return "Layer 1 – global keyword";
        }
      }
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

    // Enrich transactions with match info + ledger source + rule progress
    const enrichedRows = rows.map((txn) => {
      const recon = reconMap[txn.id];
      const docInfo = recon?.document_id ? docInfoMap[recon.document_id] : null;
      const pattern = extractPattern(txn.narration ?? "");
      const progress = ruleProgressMap[pattern];
      // Show Learning (X/3) if rule exists but not yet confirmed
      const ledgerRuleProgress = (progress && !progress.confirmed)
        ? { count: progress.count, total: 3 }
        : null;
      return {
        ...txn,
        ledger_source: deriveLedgerSource(txn.narration ?? "", txn.ledger_name),
        ledger_rule_progress: ledgerRuleProgress,
        ...(recon ? {
          match_score: recon.match_score,
          match_reasons: recon.match_reasons,
          matched_invoice_number: docInfo?.invoice_number ?? null,
          matched_doc_filename: docInfo?.filename ?? null,
        } : {}),
      };
    });

    // ── Taxation / mapping flag computation ──────────────────────────────────

    // Flag 3 (round_trip) prep: group by pattern for pair detection
    type TxnRef = { id: string; date: Date; amount: number; isDebit: boolean };
    const patternGroups: Record<string, TxnRef[]> = {};
    for (const txn of rows) {
      const amount = (txn.debit_amount ?? 0) > 0 ? txn.debit_amount! : (txn.credit_amount ?? 0);
      if (amount <= 10000) continue; // ignore trivial amounts for round-trip
      const pat = extractPattern(txn.narration ?? "");
      if (!patternGroups[pat]) patternGroups[pat] = [];
      patternGroups[pat].push({
        id: txn.id,
        date: new Date(txn.transaction_date),
        amount,
        isDebit: (txn.debit_amount ?? 0) > 0,
      });
    }

    const roundTripIds = new Set<string>();
    for (const group of Object.values(patternGroups)) {
      const debits = group.filter((t) => t.isDebit);
      const credits = group.filter((t) => !t.isDebit);
      for (const d of debits) {
        for (const c of credits) {
          const daysDiff = Math.abs(d.date.getTime() - c.date.getTime()) / (1000 * 60 * 60 * 24);
          if (daysDiff <= 7 && Math.abs(d.amount - c.amount) <= 1) {
            roundTripIds.add(d.id);
            roundTripIds.add(c.id);
          }
        }
      }
    }

    // Flag 4 (salary_tds_missing) prep: group salary txns by month
    const salaryByMonth: Record<string, string[]> = {}; // YYYY-MM → txn ids
    const tdsByMonth: Set<string> = new Set();           // YYYY-MM keys with TDS present
    for (const txn of rows) {
      const narLower = (txn.narration ?? "").toLowerCase();
      const narUpper = (txn.narration ?? "").toUpperCase();
      const ledgerLower = (txn.ledger_name ?? "").toLowerCase();

      const isSalary =
        narLower.includes("salary") ||
        narLower.includes("sal ") ||
        ledgerLower.includes("salary");

      const isTds =
        narUpper.includes("TDS") ||
        narUpper.includes("ITNS") ||
        narUpper.includes("TRACES") ||
        narUpper.includes("192");

      const month = (txn.transaction_date ?? "").slice(0, 7); // YYYY-MM
      if (!month) continue;

      if (isSalary) {
        if (!salaryByMonth[month]) salaryByMonth[month] = [];
        salaryByMonth[month].push(txn.id);
      }
      if (isTds) tdsByMonth.add(month);
    }

    const salaryTdsMissingIds = new Set<string>();
    for (const [month, ids] of Object.entries(salaryByMonth)) {
      if (!tdsByMonth.has(month)) {
        for (const id of ids) salaryTdsMissingIds.add(id);
      }
    }

    // Build flagsByTxnId
    const flagsByTxnId: Record<string, string[]> = {};
    function addFlag(id: string, flag: string) {
      if (!flagsByTxnId[id]) flagsByTxnId[id] = [];
      flagsByTxnId[id].push(flag);
    }

    for (const txn of rows) {
      const narLower = (txn.narration ?? "").toLowerCase();
      const ledgerKey = (txn.ledger_name ?? "").toLowerCase();
      const isDebit = (txn.debit_amount ?? 0) > 0;
      const isCredit = (txn.credit_amount ?? 0) > 0;
      const amount = isDebit ? txn.debit_amount! : (txn.credit_amount ?? 0);

      // Flag 1: direction_mismatch
      if (txn.ledger_name && ledgerNameSet.has(ledgerKey)) {
        const ltype = ledgerTypeMap[ledgerKey];
        if (isDebit && ltype === "income") addFlag(txn.id, "direction_mismatch");
        else if (isCredit && ltype === "expense") addFlag(txn.id, "direction_mismatch");
      }

      // Flag 2: cash_limit_269st
      if (
        (narLower.includes("cash") || (txn.category ?? "").toLowerCase() === "contra") &&
        amount > 200000
      ) {
        addFlag(txn.id, "cash_limit_269st");
      }

      // Flag 3: round_trip
      if (roundTripIds.has(txn.id)) addFlag(txn.id, "round_trip");

      // Flag 4: salary_tds_missing
      if (salaryTdsMissingIds.has(txn.id)) addFlag(txn.id, "salary_tds_missing");

      // Flag 5: not_in_ledger_master
      if (
        txn.ledger_name &&
        ledgerMasters.length > 5 &&
        !ledgerNameSet.has(ledgerKey)
      ) {
        addFlag(txn.id, "not_in_ledger_master");
      }
    }

    // Attach flags to enriched rows
    const flaggedRows = enrichedRows.map((txn) => ({
      ...txn,
      flags: flagsByTxnId[txn.id] ?? [],
    }));

    // Summary stats
    const totalDebit = rows.reduce((s, r) => s + (r.debit_amount ?? 0), 0);
    const totalCredit = rows.reduce((s, r) => s + (r.credit_amount ?? 0), 0);
    const matched = rows.filter((r) => r.status === "matched").length;
    const unmatched = rows.filter((r) => r.status === "unmatched").length;
    const ledgerMapped = rows.filter((r) => !!r.ledger_name).length;

    // Get true total count to detect if we hit the 2000-row cap
    const { count: totalRowsInDb } = await supabase
      .from("bank_transactions")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId);

    const flagCount = flaggedRows.filter((t) => t.flags.length > 0).length;

    return NextResponse.json({
      transactions: flaggedRows,
      summary: {
        total: rows.length,
        total_rows_in_db: totalRowsInDb ?? rows.length,
        truncated: rows.length === 2000 && (totalRowsInDb ?? 0) > 2000,
        total_debit: totalDebit,
        total_credit: totalCredit,
        matched,
        unmatched,
        ledger_mapped: ledgerMapped,
        flag_count: flagCount,
      },
    });
  } catch (err) {
    console.error("[clients/bank-transactions]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE — wipe all bank transactions for a client (and their reconciliation entries)
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const { id: clientId } = await params;

    // Get all transaction IDs for this client
    const { data: txns } = await supabase
      .from("bank_transactions")
      .select("id")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId);

    const txnIds = (txns ?? []).map((t) => t.id);

    if (txnIds.length > 0) {
      // Delete reconciliation rows first (FK safety), in batches
      for (let i = 0; i < txnIds.length; i += 100) {
        await supabase.from("reconciliations").delete()
          .eq("tenant_id", profile.tenant_id)
          .in("bank_transaction_id", txnIds.slice(i, i + 100));
      }
    }

    // Delete all bank transactions for this client
    const { error } = await supabase
      .from("bank_transactions")
      .delete()
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await supabase.from("audit_log").insert({
      tenant_id: profile.tenant_id,
      user_id: user.id,
      action: "wipe_bank_transactions",
      entity_type: "bank_transactions",
      entity_id: clientId,
    });

    return NextResponse.json({ ok: true, deleted: txnIds.length });
  } catch (err) {
    console.error("[clients/bank-transactions DELETE]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
