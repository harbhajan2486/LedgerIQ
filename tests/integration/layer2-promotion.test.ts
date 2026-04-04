/**
 * Integration test — Layer 2: Cross-Tenant Pattern Promotion
 *
 * Simulates 10 independent tenants all making the same correction
 * (same doc_fingerprint + field_name + correct_value), then calls
 * process-correction for the 10th and verifies:
 *   - A Layer 2 promotion entry appears in global_rules with active=false
 *   - The entry is awaiting super-admin review (not auto-activated)
 *
 * This is the "network effect moat": when enough firms independently
 * confirm the same correction, it becomes a candidate global rule.
 */

import { createClient } from "@supabase/supabase-js";
import { skipIfNotConfigured } from "./helpers";

const SKIP = skipIfNotConfigured();
let sb: ReturnType<typeof createClient>;
let EDGE_URL: string;

if (!SKIP) {
  sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  EDGE_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1`;
}

const describeOrSkip = SKIP ? describe.skip : describe;

const NUM_TENANTS = 10;
const DOC_FINGERPRINT = `TEST-LAYER2-${Date.now()}`;
const FIELD_NAME = "tds_section";
const CORRECT_VALUE = "194J";

const tenantIds: string[] = [];
const userIds: string[] = [];
const docIds: string[] = [];
const extractionIds: string[] = [];
const correctionIds: string[] = [];

async function callProcessCorrection(payload: Record<string, unknown>) {
  const res = await fetch(`${EDGE_URL}/process-correction`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ── Setup: create 10 synthetic tenants each with 1 correction ─────────────────

const beforeAllFn = SKIP ? ((_fn: () => void, _timeout?: number) => {}) : beforeAll;
const afterAllFn = SKIP ? ((_fn: () => void, _timeout?: number) => {}) : afterAll;

beforeAllFn(async () => {
  for (let i = 0; i < NUM_TENANTS; i++) {
    // Create tenant
    const { data: tenant } = await sb.from("tenants").insert({
      name: `Layer2 Test Firm ${i + 1}`,
      subscription_plan: "starter",
      subscription_status: "active",
    }).select("id").single();
    tenantIds.push(tenant!.id);

    // Create auth user
    const { data: authUser } = await sb.auth.admin.createUser({
      email: `layer2-test-${i}-${Date.now()}@ledgeriq-test.internal`,
      password: "TestPassword123!",
      email_confirm: true,
    });
    userIds.push(authUser.user!.id);

    // Create user profile
    await sb.from("users").insert({
      id: authUser.user!.id,
      tenant_id: tenant!.id,
      email: `layer2-test-${i}-${Date.now()}@ledgeriq-test.internal`,
      role: "member",
    });

    // Create document
    const { data: doc } = await sb.from("documents").insert({
      tenant_id: tenant!.id,
      document_type: "purchase_invoice",
      original_filename: `test_invoice_tenant${i}.pdf`,
      storage_path: "test/placeholder.pdf",
      file_size_bytes: 1000,
      mime_type: "application/pdf",
      status: "review_required",
      uploaded_by: authUser.user!.id,
      doc_fingerprint: DOC_FINGERPRINT,
    }).select("id").single();
    docIds.push(doc!.id);

    // Create extraction for the field
    const { data: extraction } = await sb.from("extractions").insert({
      document_id: doc!.id,
      tenant_id: tenant!.id,
      field_name: FIELD_NAME,
      extracted_value: "194C",    // AI got it wrong
      confidence: 0.50,
      status: "pending",
    }).select("id").single();
    extractionIds.push(extraction!.id);

    // Create the vendor_name extraction so process-correction can look it up
    await sb.from("extractions").insert({
      document_id: doc!.id,
      tenant_id: tenant!.id,
      field_name: "vendor_name",
      extracted_value: "IT Consulting Pvt Ltd",
      confidence: 0.9,
      status: "accepted",
    });
  }
}, 120000); // long timeout — creating 10 tenants

afterAllFn(async () => {
  // Clean up in reverse order
  if (correctionIds.length > 0) {
    await sb.from("correction_vectors").delete().in("correction_record_id", correctionIds);
    await sb.from("corrections").delete().in("id", correctionIds);
  }

  // Delete Layer 2 promotion entries created by this test
  await sb
    .from("global_rules")
    .delete()
    .eq("layer", 2)
    .eq("rule_type", "correction_pattern")
    .filter("rule_json->>doc_fingerprint", "eq", DOC_FINGERPRINT);

  for (let i = 0; i < docIds.length; i++) {
    await sb.from("extractions").delete().eq("document_id", docIds[i]);
    await sb.from("documents").delete().eq("id", docIds[i]);
  }
  for (let i = 0; i < tenantIds.length; i++) {
    await sb.from("vendor_profiles").delete().eq("tenant_id", tenantIds[i]);
    await sb.from("users").delete().eq("tenant_id", tenantIds[i]);
    await sb.from("tenants").delete().eq("id", tenantIds[i]);
    if (userIds[i]) await sb.auth.admin.deleteUser(userIds[i]);
  }
}, 60000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describeOrSkip("Layer 2 — Cross-tenant pattern promotion", () => {

  test("9 corrections from 9 different tenants: no promotion entry yet", async () => {
    for (let i = 0; i < 9; i++) {
      const { data: correction } = await sb.from("corrections").insert({
        extraction_id: extractionIds[i],
        tenant_id: tenantIds[i],
        wrong_value: "194C",
        correct_value: CORRECT_VALUE,
        corrected_by: userIds[i],
        doc_fingerprint: DOC_FINGERPRINT,
        original_confidence: 0.50,
      }).select("id").single();
      correctionIds.push(correction!.id);

      await callProcessCorrection({
        correctionId: correction!.id,
        extractionId: extractionIds[i],
        tenantId: tenantIds[i],
        documentId: docIds[i],
        fieldName: FIELD_NAME,
        wrongValue: "194C",
        correctValue: CORRECT_VALUE,
        docFingerprint: DOC_FINGERPRINT,
      });
    }

    // After 9 corrections, no Layer 2 promotion should exist yet (threshold = 10)
    const { data: promotions } = await sb
      .from("global_rules")
      .select("id")
      .eq("layer", 2)
      .eq("rule_type", "correction_pattern")
      .filter("rule_json->>doc_fingerprint", "eq", DOC_FINGERPRINT)
      .filter("rule_json->>field_name", "eq", FIELD_NAME);

    expect(promotions!.length).toBe(0);
  }, 120000);

  test("10th correction triggers Layer 2 promotion entry (inactive, awaiting review)", async () => {
    const { data: correction } = await sb.from("corrections").insert({
      extraction_id: extractionIds[9],
      tenant_id: tenantIds[9],
      wrong_value: "194C",
      correct_value: CORRECT_VALUE,
      corrected_by: userIds[9],
      doc_fingerprint: DOC_FINGERPRINT,
      original_confidence: 0.50,
    }).select("id").single();
    correctionIds.push(correction!.id);

    const result = await callProcessCorrection({
      correctionId: correction!.id,
      extractionId: extractionIds[9],
      tenantId: tenantIds[9],
      documentId: docIds[9],
      fieldName: FIELD_NAME,
      wrongValue: "194C",
      correctValue: CORRECT_VALUE,
      docFingerprint: DOC_FINGERPRINT,
    });

    expect(result.success).toBe(true);

    await new Promise((r) => setTimeout(r, 1000));

    // Layer 2 promotion entry SHOULD now exist
    const { data: promotions } = await sb
      .from("global_rules")
      .select("id, active, rule_json, tenant_count")
      .eq("layer", 2)
      .eq("rule_type", "correction_pattern")
      .filter("rule_json->>doc_fingerprint", "eq", DOC_FINGERPRINT)
      .filter("rule_json->>field_name", "eq", FIELD_NAME);

    expect(promotions!.length).toBe(1);

    const promo = promotions![0];
    expect(promo.active).toBe(false); // must require super-admin approval
    expect(promo.tenant_count).toBeGreaterThanOrEqual(10);

    const ruleJson = promo.rule_json as Record<string, unknown>;
    expect(ruleJson.correct_value).toBe(CORRECT_VALUE);
    expect(ruleJson.field_name).toBe(FIELD_NAME);
  }, 30000);

  test("Layer 2 entry is NOT active (super-admin must approve before it becomes global)", async () => {
    const { data: promotions } = await sb
      .from("global_rules")
      .select("active")
      .eq("layer", 2)
      .eq("rule_type", "correction_pattern")
      .filter("rule_json->>doc_fingerprint", "eq", DOC_FINGERPRINT);

    expect(promotions!.length).toBeGreaterThan(0);
    // Critical safety check: must never auto-activate
    for (const promo of promotions!) {
      expect(promo.active).toBe(false);
    }
  });
});
