/**
 * Cross-tenant global rule learning system.
 *
 * Flow:
 *   Layer 3 (client confirms 3×) → Layer 2 (3+ clients in same industry) →
 *   nominated for admin approval → approved = Layer 1 augmentation (global)
 *
 * Privacy: only PII-safe pattern keywords are nominated cross-tenant.
 * A pattern that looks like a person name is never promoted.
 */

import { createClient } from "@/lib/supabase/server";

// ── PII safety ────────────────────────────────────────────────────────────────
// A pattern is "safe to nominate" cross-tenant if it:
// 1. Has ≤ 3 words total (long word sequences are likely full names)
// 2. Does not look like "FirstName LastName [something]":
//    - 3+ consecutive words all ≥ 4 chars in a row = likely a name
// 3. Is at least 4 characters (avoid trivially generic patterns)
export function isSafeToNominate(pattern: string): boolean {
  if (!pattern || pattern === "__unknown__") return false;
  if (pattern.length < 4) return false;

  const words = pattern.trim().split(/\s+/).filter(Boolean);
  if (words.length > 3) {
    // Count consecutive long words (≥4 chars) — indicative of full name
    let consecutiveLong = 0;
    for (const w of words) {
      if (w.length >= 4) { consecutiveLong++; if (consecutiveLong >= 3) return false; }
      else consecutiveLong = 0;
    }
  }
  return true;
}

// ── Min tenants before a pattern gets nominated ────────────────────────────────
export const NOMINATION_THRESHOLD = 3; // at least 3 distinct tenants must confirm

// ── Nominate or increment a cross-tenant pattern vote ─────────────────────────
/**
 * Called after a Layer 2 (industry) rule is confirmed.
 * Uses the Supabase anon/server client — RLS must allow this tenant's writes.
 * The nomination table is deliberately public-write (tenants contribute to global pool).
 */
export async function tryNominate(params: {
  pattern: string;
  ledgerName: string;
  industryName: string | null;
  tenantId: string;
  rcmApplicable?: boolean;
  tdsSection?: string | null;
  suggestedGstRate?: number | null;
}): Promise<void> {
  const { pattern, ledgerName, industryName, tenantId, rcmApplicable, tdsSection, suggestedGstRate } = params;

  if (!isSafeToNominate(pattern)) return;

  try {
    const supabase = await createClient();

    // Upsert the nomination row (idempotent on pattern+ledger)
    const { data: nomination, error: upsertErr } = await supabase
      .from("global_rule_nominations")
      .upsert(
        {
          pattern,
          ledger_name:         ledgerName,
          industry_name:       industryName,
          rcm_applicable:      rcmApplicable ?? false,
          tds_section:         tdsSection    ?? null,
          suggested_gst_rate:  suggestedGstRate ?? null,
          updated_at:          new Date().toISOString(),
        },
        { onConflict: "pattern,ledger_name", ignoreDuplicates: false }
      )
      .select("id")
      .single();

    if (upsertErr || !nomination) return;

    // Record this tenant's vote (ignore if already voted)
    const { error: voteErr } = await supabase
      .from("global_rule_nomination_votes")
      .insert({ nomination_id: nomination.id, tenant_id: tenantId })
      .select();

    if (voteErr) return; // duplicate vote — already counted, ignore

    // Update tenant_count + total_confirmations from actual vote rows
    const { count } = await supabase
      .from("global_rule_nomination_votes")
      .select("*", { count: "exact", head: true })
      .eq("nomination_id", nomination.id);

    await supabase
      .from("global_rule_nominations")
      .update({
        tenant_count:         count ?? 1,
        total_confirmations:  (count ?? 1),
        updated_at:           new Date().toISOString(),
      })
      .eq("id", nomination.id);
  } catch {
    // Nomination is best-effort — never block the main save
  }
}

// ── Fetch approved global rules (augments Layer 1 at query time) ───────────────
export interface ApprovedGlobalRule {
  pattern: string;
  ledger_name: string;
  industry_name: string | null;
  rcm_applicable: boolean;
  tds_section: string | null;
  suggested_gst_rate: number | null;
}

export async function fetchApprovedGlobalRules(): Promise<ApprovedGlobalRule[]> {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("global_rule_nominations")
      .select("pattern, ledger_name, industry_name, rcm_applicable, tds_section, suggested_gst_rate")
      .eq("status", "approved");
    return (data ?? []) as ApprovedGlobalRule[];
  } catch {
    return [];
  }
}
