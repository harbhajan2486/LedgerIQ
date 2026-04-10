import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPattern, suggestLedger } from "@/lib/ledger-rules";

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

  // Fetch transactions, valid ledger names, and confirmed mapping rules in parallel
  const [txnsResult, ledgersResult, rulesResult] = await Promise.all([
    supabase
      .from("bank_transactions")
      .select("id, narration, ledger_name")
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
  ]);

  const transactions = txnsResult.data ?? [];
  const validLedgerNames = new Set((ledgersResult.data ?? []).map((l) => l.ledger_name));

  // Build pattern → ledger map from confirmed client rules (Layer 3)
  const ruleMap: Record<string, string> = {};
  for (const rule of rulesResult.data ?? []) {
    ruleMap[rule.pattern] = rule.ledger_name;
  }

  const byLedger: Record<string, string[]> = {};
  const clearIds: string[] = [];

  for (const txn of transactions) {
    const pattern = extractPattern(txn.narration ?? "");
    const confirmedLedger = ruleMap[pattern] ?? null;           // Layer 3: client-learned rule
    const globalLedger    = suggestLedger(txn.narration ?? ""); // Layer 1: global keyword rule
    // Best suggestion: confirmed rule first, then global, then nothing
    const bestSuggestion = confirmedLedger ?? (globalLedger && validLedgerNames.has(globalLedger) ? globalLedger : null);

    const current = txn.ledger_name;
    const isStale   = !!current && !validLedgerNames.has(current);           // set but ledger deleted/renamed
    const isWrong   = !!current && !!confirmedLedger && confirmedLedger !== current && validLedgerNames.has(confirmedLedger); // confirmed rule disagrees
    const isMissing = !current;

    if (isMissing && bestSuggestion) {
      // Fill missing with best available suggestion
      if (!byLedger[bestSuggestion]) byLedger[bestSuggestion] = [];
      byLedger[bestSuggestion].push(txn.id);
    } else if (isStale) {
      if (bestSuggestion) {
        // Replace stale name with best suggestion
        if (!byLedger[bestSuggestion]) byLedger[bestSuggestion] = [];
        byLedger[bestSuggestion].push(txn.id);
      } else {
        // No rule matches → clear to amber so CA manually picks
        clearIds.push(txn.id);
      }
    } else if (isWrong) {
      // Confirmed rule overrides previously set (now-wrong) value
      if (!byLedger[confirmedLedger]) byLedger[confirmedLedger] = [];
      byLedger[confirmedLedger].push(txn.id);
    }
  }

  const totalUpdated = Object.values(byLedger).reduce((s, ids) => s + ids.length, 0) + clearIds.length;
  if (totalUpdated === 0) return NextResponse.json({ updated: 0 });

  await Promise.all([
    ...Object.entries(byLedger).map(([name, ids]) =>
      supabase.from("bank_transactions").update({ ledger_name: name }).in("id", ids).then()
    ),
    clearIds.length > 0
      ? supabase.from("bank_transactions").update({ ledger_name: null }).in("id", clearIds).then()
      : null,
  ].filter(Boolean));

  return NextResponse.json({ updated: totalUpdated });
}
