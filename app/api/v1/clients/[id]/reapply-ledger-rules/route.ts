import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPattern, suggestLedger, ledgerToMeta } from "@/lib/ledger-rules";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const { id: clientId } = await params;

  // Fetch client's industry for Layer 2 lookup
  const { data: clientRow } = await supabase
    .from("clients")
    .select("industry_name")
    .eq("id", clientId)
    .single();
  const industryName = clientRow?.industry_name ?? null;

  // Step 0: Delete bogus rows (no debit AND no credit) — left over from pre-fix parser uploads
  await supabase
    .from("bank_transactions")
    .delete()
    .eq("tenant_id", profile.tenant_id)
    .eq("client_id", clientId)
    .is("debit_amount", null)
    .is("credit_amount", null);

  // Fetch transactions, valid ledger names, confirmed client rules, and industry rules in parallel
  const [txnsResult, ledgersResult, rulesResult, industryRulesResult] = await Promise.all([
    supabase
      .from("bank_transactions")
      .select("id, narration, ledger_name, category")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId),
    supabase
      .from("ledger_masters")
      .select("ledger_name")
      .eq("client_id", clientId)
      .eq("tenant_id", profile.tenant_id),
    supabase
      .from("ledger_mapping_rules")
      .select("pattern, ledger_name")
      .eq("client_id", clientId)
      .eq("tenant_id", profile.tenant_id)
      .eq("confirmed", true),
    industryName
      ? supabase
          .from("ledger_mapping_rules")
          .select("pattern, ledger_name")
          .eq("tenant_id", profile.tenant_id)
          .eq("industry_name", industryName)
          .is("client_id", null)
          .eq("confirmed", true)
      : Promise.resolve({ data: [] }),
  ]);

  const transactions = txnsResult.data ?? [];
  const validLedgerNames = new Set((ledgersResult.data ?? []).map((l) => l.ledger_name));

  // Build pattern → ledger maps
  // Layer 3: confirmed client rules (highest priority)
  const clientRuleMap: Record<string, string> = {};
  for (const rule of rulesResult.data ?? []) {
    clientRuleMap[rule.pattern] = rule.ledger_name;
  }
  // Layer 2: confirmed industry rules (middle priority)
  const industryRuleMap: Record<string, string> = {};
  for (const rule of (industryRulesResult as { data: { pattern: string; ledger_name: string }[] | null }).data ?? []) {
    industryRuleMap[rule.pattern] = rule.ledger_name;
  }

  const byLedger: Record<string, string[]> = {};
  const clearIds: string[] = [];
  // Rows where ledger is already correct but category is stale — just resync meta
  const categoryFixIds: Record<string, string[]> = {};

  for (const txn of transactions) {
    const pattern = extractPattern(txn.narration ?? "");
    const confirmedLedger  = clientRuleMap[pattern] ?? null;
    const industryLedger   = industryRuleMap[pattern] ?? null;
    const globalLedger     = suggestLedger(txn.narration ?? "");
    const bestSuggestion = confirmedLedger
      ?? (industryLedger && validLedgerNames.has(industryLedger) ? industryLedger : null)
      ?? (globalLedger && validLedgerNames.has(globalLedger) ? globalLedger : null);

    const current = txn.ledger_name;
    const isStale   = !!current && !validLedgerNames.has(current);
    const isWrong   = !!current && !!confirmedLedger && confirmedLedger !== current && validLedgerNames.has(confirmedLedger);
    const isMissing = !current;

    if (isMissing && bestSuggestion) {
      if (!byLedger[bestSuggestion]) byLedger[bestSuggestion] = [];
      byLedger[bestSuggestion].push(txn.id);
    } else if (isStale) {
      if (bestSuggestion) {
        if (!byLedger[bestSuggestion]) byLedger[bestSuggestion] = [];
        byLedger[bestSuggestion].push(txn.id);
      } else {
        clearIds.push(txn.id);
      }
    } else if (isWrong) {
      if (!byLedger[confirmedLedger]) byLedger[confirmedLedger] = [];
      byLedger[confirmedLedger].push(txn.id);
    } else if (current) {
      // Ledger is correct — check if category is out of sync
      const meta = ledgerToMeta(current);
      if (meta && txn.category !== meta.category) {
        if (!categoryFixIds[current]) categoryFixIds[current] = [];
        categoryFixIds[current].push(txn.id);
      }
    }
  }

  const totalUpdated = Object.values(byLedger).reduce((s, ids) => s + ids.length, 0)
    + Object.values(categoryFixIds).reduce((s, ids) => s + ids.length, 0)
    + clearIds.length;
  if (totalUpdated === 0) return NextResponse.json({ updated: 0 });

  await Promise.all([
    ...Object.entries(byLedger).map(([name, ids]) => {
      const meta = ledgerToMeta(name);
      const payload: Record<string, unknown> = { ledger_name: name };
      if (meta) { payload.category = meta.category; payload.voucher_type = meta.voucher_type; }
      return supabase.from("bank_transactions").update(payload).in("id", ids).then();
    }),
    ...Object.entries(categoryFixIds).map(([name, ids]) => {
      const meta = ledgerToMeta(name)!;
      return supabase.from("bank_transactions")
        .update({ category: meta.category, voucher_type: meta.voucher_type })
        .in("id", ids).then();
    }),
    clearIds.length > 0
      ? supabase.from("bank_transactions").update({ ledger_name: null }).in("id", clearIds).then()
      : null,
  ].filter(Boolean));

  return NextResponse.json({ updated: totalUpdated });
}
