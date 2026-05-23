import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractPattern, COMMON_LEDGERS } from "@/lib/ledger-rules";

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
    const maxPatterns = (aiConfig?.rule_suggestion_max_patterns as number | undefined) ?? 100;

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

    // Fetch trial balance ledgers (preferred vocabulary)
    const { data: clientLedgers } = await supabase
      .from("ledger_masters")
      .select("ledger_name")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId);

    const clientLedgerNames = (clientLedgers ?? []).map((l: { ledger_name: string }) => l.ledger_name);
    const fallbackLedgers = COMMON_LEDGERS.map(l => l.ledger_name).filter(n => !clientLedgerNames.includes(n));
    const ledgerVocabulary = clientLedgerNames.length > 0
      ? [...clientLedgerNames, ...fallbackLedgers]
      : COMMON_LEDGERS.map(l => l.ledger_name);

    const prompt = `You are an expert Indian business accountant. For each bank narration pattern, suggest the most appropriate ledger name.

CLIENT: ${clientRow.client_name}${clientRow.industry_name ? ` (${clientRow.industry_name})` : ""}

HOW THIS CLIENT ALREADY MAPS TRANSACTIONS (use as your style guide — prefer the same ledger names):
${exampleLines.length > 0 ? exampleLines.join("\n") : "  (no existing mappings yet — use your best judgement)"}

ALLOWED LEDGER NAMES (use exact names from this list, prefer client ledgers over generic ones):
${clientLedgerNames.length > 0
  ? `[Client's Tally ledgers]\n${clientLedgerNames.map(l => `  - ${l}`).join("\n")}\n\n[Generic fallback]\n${fallbackLedgers.slice(0, 40).map(l => `  - ${l}`).join("\n")}`
  : ledgerVocabulary.map(l => `  - ${l}`).join("\n")}

PATTERNS TO CLASSIFY:
${JSON.stringify(patternsToSend.map(([pattern, example]) => ({ pattern, example })), null, 2)}

RULES:
1. Return ONLY a JSON array — no markdown, no explanation
2. Each item: {"pattern": "...", "suggested_ledger": "...", "confidence": 0.0-1.0, "reason": "one short sentence"}
3. suggested_ledger must be exactly one of the allowed ledger names, or null if truly unsure
4. Use confidence < 0.6 for ambiguous patterns (person names, generic reference codes)
5. Person names without context → professional fees or salary at 0.5 confidence
6. Use mapped examples above to match the client's naming style exactly`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: suggestionModel,
      max_tokens: 2000,
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

    const ledgerSet = new Set(ledgerVocabulary);
    const valid = aiSuggestions.filter(s => s.suggested_ledger && ledgerSet.has(s.suggested_ledger) && s.confidence >= 0.5);

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
