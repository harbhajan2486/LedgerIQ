import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractPattern, suggestLedger, COMMON_LEDGERS } from "@/lib/ledger-rules";

// POST /api/v1/clients/[id]/suggest-rules
// AI bulk suggestion: scan unrecognised bank narrations and suggest ledger mappings
// Only processes narrations where ALL 3 rule layers returned no match (suggested_ledger IS NULL)

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

    // Verify client belongs to this tenant
    const { data: clientRow } = await supabase
      .from("clients").select("id, client_name, industry_name")
      .eq("id", clientId).eq("tenant_id", profile.tenant_id).single();
    if (!clientRow) return NextResponse.json({ error: "Client not found" }, { status: 404 });

    // Check rule_suggestion_enabled from ai_settings
    const { data: aiSettings } = await supabase
      .from("ai_settings").select("config").eq("id", "global").maybeSingle();
    const aiConfig = aiSettings?.config as Record<string, unknown> | null;
    if (aiConfig?.rule_suggestion_enabled === false) {
      return NextResponse.json({ error: "AI rule suggestion is disabled" }, { status: 403 });
    }
    const suggestionModel = (aiConfig?.rule_suggestion_model as string | undefined) ?? "claude-haiku-4-5-20251001";
    const maxPatterns = (aiConfig?.rule_suggestion_max_patterns as number | undefined) ?? 100;

    // Fetch bank transactions with no suggested_ledger (debit only — expenses)
    const { data: txns } = await supabase
      .from("bank_transactions")
      .select("narration")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId)
      .is("suggested_ledger", null)
      .gt("debit_amount", 0)
      .not("narration", "is", null)
      .limit(500);

    if (!txns?.length) return NextResponse.json({ suggestions: [], message: "No unrecognised transactions found" });

    // Extract + deduplicate patterns
    const patternMap = new Map<string, string>(); // pattern → example narration
    for (const txn of txns) {
      if (!txn.narration) continue;
      // Sanity check: skip if Layer 1 actually covers this (shouldn't be null but guard anyway)
      if (suggestLedger(txn.narration)) continue;
      const pat = extractPattern(txn.narration);
      if (pat.length < 3) continue; // too short to be meaningful
      if (!patternMap.has(pat)) patternMap.set(pat, txn.narration);
    }

    if (patternMap.size === 0) return NextResponse.json({ suggestions: [], message: "All transactions already mapped" });

    // Get existing client rules to pass as context (avoid re-suggesting what's already mapped)
    const { data: existingRules } = await supabase
      .from("ledger_mapping_rules")
      .select("pattern, ledger_name")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId)
      .eq("confirmed", true)
      .limit(50);

    // Limit patterns to maxPatterns
    const patternsToSend = [...patternMap.entries()].slice(0, maxPatterns);
    const ledgerVocabulary = COMMON_LEDGERS.map(l => l.ledger_name);

    const prompt = `You are an expert Indian business accountant. For each bank narration pattern below, suggest the most appropriate accounting ledger name.

CONTEXT:
- Client: ${clientRow.client_name}${clientRow.industry_name ? ` (${clientRow.industry_name})` : ""}
- These are debit transactions from an Indian business bank account
- Patterns are extracted narration keywords (payment prefixes and reference numbers already removed)

ALLOWED LEDGER NAMES (use these exact names, or null if truly unsure):
${ledgerVocabulary.map(l => `  - ${l}`).join("\n")}

EXISTING RULES FOR THIS CLIENT (do NOT re-suggest these):
${(existingRules ?? []).map(r => `  ${r.pattern} → ${r.ledger_name}`).join("\n") || "  (none yet)"}

PATTERNS TO CLASSIFY (JSON array of {pattern, example} objects):
${JSON.stringify(patternsToSend.map(([pattern, example]) => ({ pattern, example })), null, 2)}

RULES:
1. Return ONLY a JSON array, no markdown, no explanation
2. Each item: {"pattern": "...", "suggested_ledger": "...", "confidence": 0.0-1.0}
3. Use confidence < 0.6 for ambiguous patterns (person names, generic codes)
4. If you cannot determine a ledger confidently, set suggested_ledger to null
5. Common mappings: salary/wages→Salary Expenses, rent→Rent, jio/airtel→Telephone/Internet, epfo→PF/ESI, electricity boards→Electricity Expenses
6. Person name payments are often salary or professional fees — use confidence 0.5 unless context is clear`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: suggestionModel,
      max_tokens: 2000,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";

    // Parse AI response — strip any accidental markdown fences
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let aiSuggestions: Array<{ pattern: string; suggested_ledger: string | null; confidence: number }> = [];
    try {
      const parsed = JSON.parse(jsonStr);
      aiSuggestions = Array.isArray(parsed) ? parsed : [];
    } catch {
      return NextResponse.json({ error: "AI returned unparseable response", raw }, { status: 500 });
    }

    // Filter: only return suggestions where AI has a ledger, confidence >= 0.5, and ledger is in vocabulary
    const ledgerSet = new Set(ledgerVocabulary);
    const suggestions = aiSuggestions
      .filter(s => s.suggested_ledger && ledgerSet.has(s.suggested_ledger) && s.confidence >= 0.5)
      .map(s => ({
        pattern: s.pattern,
        example_narration: patternMap.get(s.pattern) ?? s.pattern,
        suggested_ledger: s.suggested_ledger!,
        confidence: Math.round(s.confidence * 100),
      }));

    return NextResponse.json({ suggestions, total_patterns: patternMap.size });
  } catch (err) {
    console.error("[suggest-rules POST]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
