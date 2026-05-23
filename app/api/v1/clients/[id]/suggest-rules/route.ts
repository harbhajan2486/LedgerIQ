import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractPattern } from "@/lib/ledger-rules";

// POST /api/v1/clients/[id]/suggest-rules
// AI bulk suggestion: scan unrecognised bank narrations → suggest ledger mappings → save as pending rules
// Saves to ledger_mapping_rules (source='ai_suggest', confirmed=false) so suggestions persist across sessions.

export async function POST(
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

    const { data: clientRow } = await supabase
      .from("clients").select("id, client_name, industry_name")
      .eq("id", clientId).eq("tenant_id", profile.tenant_id).single();
    if (!clientRow) return NextResponse.json({ error: "Client not found" }, { status: 404 });

    const { data: aiSettings } = await supabase
      .from("ai_settings").select("config").eq("id", "global").maybeSingle();
    const aiConfig = aiSettings?.config as Record<string, unknown> | null;
    if (aiConfig?.rule_suggestion_enabled === false) {
      return NextResponse.json({ error: "AI rule suggestion is disabled" }, { status: 403 });
    }
    const suggestionModel = (aiConfig?.rule_suggestion_model as string | undefined) ?? "claude-haiku-4-5-20251001";
    const maxPatterns = (aiConfig?.rule_suggestion_max_patterns as number | undefined) ?? 50;

    // Fetch unmapped transactions (debit + credit)
    const { data: txns } = await supabase
      .from("bank_transactions")
      .select("narration")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId)
      .is("ledger_name", null)
      .not("narration", "is", null)
      .limit(500);

    if (!txns?.length) {
      return NextResponse.json({ saved: 0, already_pending: 0, message: "No unmapped transactions found. Transactions may have been uploaded without a client selected, or all are already mapped." });
    }

    // Build pattern → example narration map
    const patternMap = new Map<string, string>();
    for (const txn of txns) {
      if (!txn.narration) continue;
      const pat = extractPattern(txn.narration);
      if (pat.length < 3) continue;
      if (!patternMap.has(pat)) patternMap.set(pat, txn.narration);
    }

    if (patternMap.size === 0) {
      return NextResponse.json({ saved: 0, already_pending: 0, message: `Found ${txns.length} unmapped transactions but narration patterns were too short to classify.` });
    }

    // Fetch already-pending ai_suggest rules — skip re-generating these
    const { data: pendingAi } = await supabase
      .from("ledger_mapping_rules")
      .select("pattern")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId)
      .eq("source", "ai_suggest")
      .eq("confirmed", false);
    const pendingPatterns = new Set((pendingAi ?? []).map((r: { pattern: string }) => r.pattern));

    // Fetch existing confirmed rules — skip suggesting these too
    const { data: confirmedRules } = await supabase
      .from("ledger_mapping_rules")
      .select("pattern, ledger_name")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId)
      .eq("confirmed", true);
    const confirmedPatterns = new Set((confirmedRules ?? []).map((r: { pattern: string }) => r.pattern));

    const patternsToSend = [...patternMap.entries()]
      .filter(([p]) => !pendingPatterns.has(p) && !confirmedPatterns.has(p))
      .slice(0, maxPatterns);

    if (patternsToSend.length === 0) {
      const msg = pendingPatterns.size > 0
        ? `${pendingPatterns.size} suggestion${pendingPatterns.size !== 1 ? "s" : ""} already waiting in Pending Review — check your Mapping Rules tab`
        : "All patterns already have rules — nothing new to suggest";
      return NextResponse.json({ saved: 0, already_pending: pendingPatterns.size, message: msg });
    }

    // Fetch already-mapped narrations as examples → gives Claude context on this client's mapping style
    const { data: mappedExamples } = await supabase
      .from("bank_transactions")
      .select("narration, ledger_name")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId)
      .not("ledger_name", "is", null)
      .limit(80);

    const seenNarrations = new Set<string>();
    const exampleLines: string[] = [];
    for (const ex of mappedExamples ?? []) {
      if (!ex.narration || !ex.ledger_name || seenNarrations.has(ex.narration)) continue;
      seenNarrations.add(ex.narration);
      exampleLines.push(`  "${ex.narration}" → ${ex.ledger_name}`);
      if (exampleLines.length >= 30) break;
    }

    // Fetch trial balance ledgers (preferred vocabulary — exact Tally names)
    const { data: clientLedgers } = await supabase
      .from("ledger_masters")
      .select("ledger_name")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId);

    const clientLedgerNames = (clientLedgers ?? []).map((l: { ledger_name: string }) => l.ledger_name);
    const hasClientLedgers = clientLedgerNames.length > 0;

    // Build prompt differently depending on whether we have a trial balance
    const ledgerSection = hasClientLedgers
      ? `USE THESE EXACT LEDGER NAMES (from client's Tally chart of accounts):
${clientLedgerNames.map(l => `  - ${l}`).join("\n")}

If no client ledger fits, fall back to standard names like: Salary Expenses, Rent, Bank Charges, Insurance Expenses, Professional Fees, Travelling Expenses, Miscellaneous Expenses, Sales Account, Other Income, Interest Income.`
      : `Suggest standard Indian accounting ledger names (Tally-style). Examples: Salary Expenses, Rent, Bank Charges, Electricity Expenses, Insurance Expenses, Professional Fees, Petrol / Vehicle Expenses, Telephone / Internet Expenses, Travelling Expenses, PF / ESI Contributions, Advertising & Marketing, Loan Repayment, GST Cash Ledger, TDS Payable, Sales Account, Other Income, Interest Income, Miscellaneous Expenses. You are not limited to this list — use any appropriate standard ledger name.`;

    const prompt = `You are an expert Indian business accountant. For each bank narration pattern, suggest the most appropriate Tally ledger name.

CLIENT: ${clientRow.client_name}${clientRow.industry_name ? ` (${clientRow.industry_name})` : ""}

HOW THIS CLIENT ALREADY MAPS TRANSACTIONS (mirror this naming style exactly):
${exampleLines.length > 0 ? exampleLines.join("\n") : "  (no existing mappings yet — use standard Tally ledger names)"}

${ledgerSection}

PATTERNS TO CLASSIFY:
${JSON.stringify(patternsToSend.map(([pattern, example]) => ({ pattern, example })), null, 2)}

RULES:
1. Return ONLY a JSON array — no markdown, no explanation
2. Each item: {"pattern": "...", "suggested_ledger": "...", "confidence": 0.0-1.0, "reason": "one short sentence"}
3. confidence < 0.6 for ambiguous patterns (person names, generic codes like RTGS/NEFT with no payee info)
4. Set suggested_ledger to null only if you truly cannot determine the category
5. Person names without context → "Professional Fees" or "Salary Expenses" at 0.5 confidence`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: suggestionModel,
      max_tokens: 8192,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    });

    // Track AI usage
    supabase.from("ai_usage").insert({
      tenant_id: profile.tenant_id,
      model: suggestionModel,
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
      cost_usd: (response.usage.input_tokens / 1_000_000) * 0.80 + (response.usage.output_tokens / 1_000_000) * 4.00,
    }).then();

    const raw = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";

    let aiSuggestions: Array<{ pattern: string; suggested_ledger: string | null; confidence: number; reason?: string }> = [];
    try {
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      const jsonStr = start !== -1 && end !== -1 ? raw.slice(start, end + 1) : raw;
      aiSuggestions = Array.isArray(JSON.parse(jsonStr)) ? JSON.parse(jsonStr) : [];
    } catch {
      return NextResponse.json({ saved: 0, already_pending: pendingPatterns.size, message: "AI returned an unexpected response — try again" });
    }

    // When client has a trial balance, enforce exact name match so we only use real Tally ledgers.
    // When no trial balance exists, trust Claude's judgement — just filter by confidence.
    const ledgerSet = new Set(clientLedgerNames);
    const valid = aiSuggestions.filter(s =>
      s.suggested_ledger &&
      s.confidence >= 0.5 &&
      (!hasClientLedgers || ledgerSet.has(s.suggested_ledger))
    );

    if (valid.length === 0) {
      return NextResponse.json({ saved: 0, already_pending: pendingPatterns.size, message: "AI could not confidently map any patterns — try uploading a Trial Balance first so it has your ledger names" });
    }

    // Save to ledger_mapping_rules as pending (confirmed=false, source='ai_suggest')
    // ignoreDuplicates=true so we never overwrite an existing confirmed rule
    const toInsert = valid.map(s => ({
      tenant_id: profile.tenant_id,
      client_id: clientId,
      pattern: s.pattern,
      ledger_name: s.suggested_ledger!,
      match_count: 0,
      confirmed: false,
      source: "ai_suggest",
    }));

    await supabase.from("ledger_mapping_rules")
      .upsert(toInsert, { onConflict: "tenant_id,client_id,pattern", ignoreDuplicates: true });

    return NextResponse.json({
      saved: valid.length,
      already_pending: pendingPatterns.size,
      total_patterns: patternMap.size,
      message: `${valid.length} suggestion${valid.length !== 1 ? "s" : ""} saved to Pending Review in the Mapping Rules tab`,
    });
  } catch (err) {
    console.error("[suggest-rules POST]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
