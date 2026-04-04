/**
 * Integration test — Layer 1: Global Knowledge Base
 *
 * Verifies that the global_rules table is populated with the correct
 * Indian tax rules (GST rates, TDS sections, RCM, ITC, matching heuristics).
 * These rules ship with the product and give every new firm 75%+ day-one accuracy.
 *
 * Requires: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

import { createClient } from "@supabase/supabase-js";
import { skipIfNotConfigured } from "./helpers";

let sb: ReturnType<typeof createClient>;
const SKIP = skipIfNotConfigured();

if (!SKIP) {
  sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip("Layer 1 — Global rules seeded in database", () => {
  test("global_rules table exists and has rows", async () => {
    const { count, error } = await sb
      .from("global_rules")
      .select("*", { count: "exact", head: true });

    expect(error).toBeNull();
    expect(count).toBeGreaterThan(0);
  });

  // ── GST Rate Rules ──────────────────────────────────────────────────────────

  test("Layer 1 has GST rate rules (hsn_gst_rate)", async () => {
    const { data, error } = await sb
      .from("global_rules")
      .select("rule_type, pattern, action")
      .eq("rule_type", "hsn_gst_rate")
      .eq("is_active", true);

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(10);
  });

  test("HSN 8471 (computers) is mapped to 18% GST", async () => {
    const { data, error } = await sb
      .from("global_rules")
      .select("action")
      .eq("rule_type", "hsn_gst_rate")
      .contains("pattern", { hsn_prefix: "8471" })
      .single();

    expect(error).toBeNull();
    const action = data!.action as Record<string, number>;
    expect(action.cgst_rate).toBe(9);
    expect(action.sgst_rate).toBe(9);
    expect(action.igst_rate).toBe(18);
  });

  test("HSN 8703 (motor cars) is mapped to 28% GST", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("action")
      .eq("rule_type", "hsn_gst_rate")
      .contains("pattern", { hsn_prefix: "8703" })
      .single();

    const action = data!.action as Record<string, number>;
    expect(action.igst_rate).toBe(28);
  });

  test("HSN 4901 (printed books) is exempt (0% GST)", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("action")
      .eq("rule_type", "hsn_gst_rate")
      .contains("pattern", { hsn_prefix: "4901" })
      .single();

    const action = data!.action as Record<string, unknown>;
    expect(action.exempt).toBe(true);
    expect(action.igst_rate).toBe(0);
  });

  // ── SAC Rate Rules ──────────────────────────────────────────────────────────

  test("Layer 1 has SAC code rules (sac_gst_rate)", async () => {
    const { data, error } = await sb
      .from("global_rules")
      .select("rule_type")
      .eq("rule_type", "sac_gst_rate")
      .eq("is_active", true);

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(10);
  });

  test("SAC 998221 (accounting services) is at 18% GST", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("action")
      .eq("rule_type", "sac_gst_rate")
      .contains("pattern", { sac: "998221" })
      .single();

    const action = data!.action as Record<string, number>;
    expect(action.cgst_rate).toBe(9);
    expect(action.igst_rate).toBe(18);
  });

  test("SAC 9992 (education) is exempt", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("action")
      .eq("rule_type", "sac_gst_rate")
      .contains("pattern", { sac: "9992" })
      .single();

    const action = data!.action as Record<string, unknown>;
    expect(action.exempt).toBe(true);
  });

  // ── TDS Section Rules ───────────────────────────────────────────────────────

  test("Layer 1 has TDS section rules", async () => {
    const { data, error } = await sb
      .from("global_rules")
      .select("rule_type")
      .eq("rule_type", "tds_section")
      .eq("is_active", true);

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(15);
  });

  test("TDS 194C (contractors): individual rate 1%, company rate 2%", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("action")
      .eq("rule_type", "tds_section")
      .contains("pattern", { section: "194C" })
      .single();

    const action = data!.action as Record<string, unknown>;
    expect(action.rate_individual).toBe(1);
    expect(action.rate_company).toBe(2);
    expect(action.threshold_inr_single).toBe(30000);
  });

  test("TDS 194J (professional fees): rate 10%", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("action")
      .eq("rule_type", "tds_section")
      .contains("pattern", { section: "194J" })
      .single();

    const action = data!.action as Record<string, unknown>;
    expect(action.rate_professional).toBe(10);
  });

  test("TDS 194I (rent): land/building rate 10%", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("action")
      .eq("rule_type", "tds_section")
      .contains("pattern", { section: "194I" })
      .single();

    const action = data!.action as Record<string, unknown>;
    expect(action.rate_land_building).toBe(10);
    expect(action.threshold_inr).toBe(240000);
  });

  // ── Reverse Charge Rules ────────────────────────────────────────────────────

  test("Layer 1 has reverse charge rules", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("rule_type")
      .eq("rule_type", "reverse_charge");

    expect(data!.length).toBeGreaterThanOrEqual(5);
  });

  test("GTA services are under RCM at 5%", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("action")
      .eq("rule_type", "reverse_charge")
      .contains("pattern", { sac: "9965" })
      .single();

    const action = data!.action as Record<string, unknown>;
    expect(action.rcm_applicable).toBe(true);
    expect(action.rate).toBe(5);
  });

  // ── Matching Heuristics ─────────────────────────────────────────────────────

  test("Layer 1 has invoice matching heuristics", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("rule_type")
      .eq("rule_type", "matching_heuristic");

    expect(data!.length).toBeGreaterThanOrEqual(5);
  });

  test("exact_amount_match heuristic has score 50", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("action")
      .eq("rule_type", "matching_heuristic")
      .contains("pattern", { name: "exact_amount_match" })
      .single();

    const action = data!.action as Record<string, unknown>;
    expect(action.score).toBe(50);
  });

  // ── ITC Eligibility Rules ───────────────────────────────────────────────────

  test("Layer 1 has ITC eligibility rules", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("rule_type")
      .eq("rule_type", "itc_eligibility");

    expect(data!.length).toBeGreaterThanOrEqual(8);
  });

  test("motor vehicles for personal use: ITC blocked", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("action")
      .eq("rule_type", "itc_eligibility")
      .ilike("pattern->category", "%Motor vehicles%")
      .single();

    const action = data!.action as Record<string, unknown>;
    expect(action.itc_allowed).toBe(false);
  });

  test("professional services: ITC allowed", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("action")
      .eq("rule_type", "itc_eligibility")
      .ilike("pattern->category", "%Professional services%")
      .single();

    const action = data!.action as Record<string, unknown>;
    expect(action.itc_allowed).toBe(true);
  });

  // ── Summary ─────────────────────────────────────────────────────────────────

  test("all active rules have confidence = 1.0 (Layer 1 rules are authoritative)", async () => {
    const { data } = await sb
      .from("global_rules")
      .select("confidence")
      .eq("is_active", true)
      .neq("rule_type", "matching_heuristic"); // heuristics don't have confidence

    const allConfident = (data ?? []).every((r) => Number(r.confidence) === 1.0);
    expect(allConfident).toBe(true);
  });
});
