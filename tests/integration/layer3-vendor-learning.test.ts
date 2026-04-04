/**
 * Integration test — Layer 3: Per-firm Vendor Learning
 *
 * Simulates a CA firm making 3+ corrections for the same vendor+field,
 * then calls the process-correction Edge Function and verifies:
 *   1. A correction_vector is stored (embedding generated)
 *   2. After 3 corrections, vendor_profiles is updated with the learned quirk
 *
 * Uses a synthetic test tenant + documents (created and cleaned up in this test).
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
const beforeAllOrSkip = SKIP ? ((_fn: () => void, _timeout?: number) => {}) : beforeAll;
const afterAllOrSkip = SKIP ? ((_fn: () => void, _timeout?: number) => {}) : afterAll;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Test data setup ───────────────────────────────────────────────────────────

let testTenantId: string;
let testUserId: string;
let testDocId: string;
let testExtractionId: string;
const correctionIds: string[] = [];
const DOC_FINGERPRINT = `TEST-LAYER3-${Date.now()}`;
const VENDOR_NAME = "Synthetic Test Vendor Ltd";

beforeAllOrSkip(async () => {
  // Create a test tenant
  const { data: tenant, error: tenantErr } = await sb.from("tenants").insert({
    name: "Layer3 Test Firm",
    subscription_plan: "starter",
    subscription_status: "active",
  }).select("id").single();
  expect(tenantErr).toBeNull();
  testTenantId = tenant!.id;

  // Create a test user in auth (use service role to create without email confirmation)
  const { data: authUser, error: authErr } = await sb.auth.admin.createUser({
    email: `layer3-test-${Date.now()}@ledgeriq-test.internal`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  expect(authErr).toBeNull();
  testUserId = authUser.user!.id;

  // Create user profile
  await sb.from("users").insert({
    id: testUserId,
    tenant_id: testTenantId,
    email: `layer3-test-${Date.now()}@ledgeriq-test.internal`,
    role: "member",
  });

  // Create a test document
  const { data: doc, error: docErr } = await sb.from("documents").insert({
    tenant_id: testTenantId,
    document_type: "purchase_invoice",
    original_filename: "test_vendor_invoice.pdf",
    storage_path: "test/placeholder.pdf",
    file_size_bytes: 1000,
    mime_type: "application/pdf",
    status: "review_required",
    uploaded_by: testUserId,
    doc_fingerprint: DOC_FINGERPRINT,
  }).select("id").single();
  expect(docErr).toBeNull();
  testDocId = doc!.id;

  // Create an extraction for vendor_name field
  const { data: extraction, error: extErr } = await sb.from("extractions").insert({
    document_id: testDocId,
    tenant_id: testTenantId,
    field_name: "vendor_name",
    extracted_value: "Wrong Vendor Name Inc",
    confidence: 0.45,
    status: "pending",
  }).select("id").single();
  expect(extErr).toBeNull();
  testExtractionId = extraction!.id;

  // Also seed the vendor_name extraction so process-correction can look it up
  await sb.from("extractions").insert({
    document_id: testDocId,
    tenant_id: testTenantId,
    field_name: "vendor_name",
    extracted_value: VENDOR_NAME,
    confidence: 0.9,
    status: "accepted",
  });
});

afterAllOrSkip(async () => {
  // Clean up all test data in order
  if (correctionIds.length > 0) {
    await sb.from("correction_vectors").delete().in("correction_record_id", correctionIds);
    await sb.from("corrections").delete().in("id", correctionIds);
  }
  if (testDocId) {
    await sb.from("extractions").delete().eq("document_id", testDocId);
    await sb.from("documents").delete().eq("id", testDocId);
  }
  if (testTenantId) {
    await sb.from("vendor_profiles").delete().eq("tenant_id", testTenantId);
    await sb.from("users").delete().eq("tenant_id", testTenantId);
    await sb.from("tenants").delete().eq("id", testTenantId);
  }
  if (testUserId) {
    await sb.auth.admin.deleteUser(testUserId);
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describeOrSkip("Layer 3 — Per-firm vendor learning (process-correction Edge Function)", () => {

  test("process-correction rejects request without correctionId", async () => {
    const result = await callProcessCorrection({ tenantId: testTenantId });
    expect(result.error).toBeDefined();
    expect(result.error).toContain("required");
  });

  test("Correction 1/3: vector embedding is generated and stored", async () => {
    // Insert correction record
    const { data: correction, error } = await sb.from("corrections").insert({
      extraction_id: testExtractionId,
      tenant_id: testTenantId,
      wrong_value: "Wrong Vendor Name Inc",
      correct_value: VENDOR_NAME,
      corrected_by: testUserId,
      doc_fingerprint: DOC_FINGERPRINT,
      original_confidence: 0.45,
    }).select("id").single();

    expect(error).toBeNull();
    correctionIds.push(correction!.id);

    // Call Edge Function
    const result = await callProcessCorrection({
      correctionId: correction!.id,
      extractionId: testExtractionId,
      tenantId: testTenantId,
      documentId: testDocId,
      fieldName: "vendor_name",
      wrongValue: "Wrong Vendor Name Inc",
      correctValue: VENDOR_NAME,
      docFingerprint: DOC_FINGERPRINT,
    });

    expect(result.success).toBe(true);
    expect(result.embeddingGenerated).toBe(true);

    // Verify vector was stored in DB
    const { data: vectors } = await sb
      .from("correction_vectors")
      .select("id, doc_fingerprint")
      .eq("tenant_id", testTenantId)
      .eq("correction_record_id", correction!.id);

    expect(vectors!.length).toBe(1);
    expect(vectors![0].doc_fingerprint).toBe(DOC_FINGERPRINT);
  }, 30000);

  test("Correction 2/3: second correction stored — no vendor profile yet", async () => {
    const { data: correction } = await sb.from("corrections").insert({
      extraction_id: testExtractionId,
      tenant_id: testTenantId,
      wrong_value: "Wrong Inc",
      correct_value: VENDOR_NAME,
      corrected_by: testUserId,
      doc_fingerprint: DOC_FINGERPRINT,
      original_confidence: 0.40,
    }).select("id").single();

    correctionIds.push(correction!.id);

    await callProcessCorrection({
      correctionId: correction!.id,
      extractionId: testExtractionId,
      tenantId: testTenantId,
      documentId: testDocId,
      fieldName: "vendor_name",
      wrongValue: "Wrong Inc",
      correctValue: VENDOR_NAME,
      docFingerprint: DOC_FINGERPRINT,
    });

    // After 2 corrections, vendor_profiles should NOT yet be updated (threshold is 3)
    const { data: profiles } = await sb
      .from("vendor_profiles")
      .select("id")
      .eq("tenant_id", testTenantId)
      .eq("vendor_name", VENDOR_NAME);

    expect(profiles!.length).toBe(0);
  }, 30000);

  test("Correction 3/3: vendor profile is created with learned field value", async () => {
    const { data: correction } = await sb.from("corrections").insert({
      extraction_id: testExtractionId,
      tenant_id: testTenantId,
      wrong_value: "Synthetic Test",
      correct_value: VENDOR_NAME,
      corrected_by: testUserId,
      doc_fingerprint: DOC_FINGERPRINT,
      original_confidence: 0.42,
    }).select("id").single();

    correctionIds.push(correction!.id);

    const result = await callProcessCorrection({
      correctionId: correction!.id,
      extractionId: testExtractionId,
      tenantId: testTenantId,
      documentId: testDocId,
      fieldName: "vendor_name",
      wrongValue: "Synthetic Test",
      correctValue: VENDOR_NAME,
      docFingerprint: DOC_FINGERPRINT,
    });

    expect(result.success).toBe(true);

    // Wait a moment for DB consistency
    await new Promise((r) => setTimeout(r, 500));

    // After 3 corrections, vendor_profiles SHOULD be created
    const { data: profiles } = await sb
      .from("vendor_profiles")
      .select("id, vendor_name, invoice_quirks")
      .eq("tenant_id", testTenantId)
      .eq("vendor_name", VENDOR_NAME);

    expect(profiles!.length).toBe(1);
    const quirks = profiles![0].invoice_quirks as Record<string, string>;
    // The learned quirk: vendor_name field → VENDOR_NAME
    expect(quirks["vendor_name"]).toBe(VENDOR_NAME);
  }, 30000);

  test("correction_vectors has 3 vectors stored for this tenant+fingerprint", async () => {
    const { data: vectors } = await sb
      .from("correction_vectors")
      .select("id")
      .eq("tenant_id", testTenantId)
      .eq("doc_fingerprint", DOC_FINGERPRINT);

    expect(vectors!.length).toBe(3);
  });

  test("4th correction updates existing vendor profile (upsert)", async () => {
    const { data: correction } = await sb.from("corrections").insert({
      extraction_id: testExtractionId,
      tenant_id: testTenantId,
      wrong_value: "Synth Ltd",
      correct_value: VENDOR_NAME,
      corrected_by: testUserId,
      doc_fingerprint: DOC_FINGERPRINT,
    }).select("id").single();

    correctionIds.push(correction!.id);

    await callProcessCorrection({
      correctionId: correction!.id,
      extractionId: testExtractionId,
      tenantId: testTenantId,
      documentId: testDocId,
      fieldName: "vendor_name",
      wrongValue: "Synth Ltd",
      correctValue: VENDOR_NAME,
      docFingerprint: DOC_FINGERPRINT,
    });

    await new Promise((r) => setTimeout(r, 500));

    // Should still be only 1 profile (upsert, not duplicate)
    const { data: profiles } = await sb
      .from("vendor_profiles")
      .select("id")
      .eq("tenant_id", testTenantId)
      .eq("vendor_name", VENDOR_NAME);

    expect(profiles!.length).toBe(1);
  }, 30000);
});
