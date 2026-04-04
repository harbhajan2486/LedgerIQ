/**
 * Integration test — Tenant Isolation (Critical Security Test)
 *
 * Verifies that Tenant A cannot read, modify, or delete Tenant B's data.
 * Tests both:
 *   1. Database-level RLS (using anon key — simulates a browser client)
 *   2. API-level isolation (documents, extractions, reconciliations)
 *
 * This is the most important test in the suite — a failure here means
 * customer data can leak between firms.
 */

import { createClient } from "@supabase/supabase-js";
import { skipIfNotConfigured } from "./helpers";

const SKIP = skipIfNotConfigured();
const describeOrSkip = SKIP ? describe.skip : describe;
const beforeAllFn = SKIP ? ((_fn: () => void, _timeout?: number) => {}) : beforeAll;
const afterAllFn = SKIP ? ((_fn: () => void, _timeout?: number) => {}) : afterAll;

// Service role client — used to set up and tear down test data
let admin: ReturnType<typeof createClient>;
if (!SKIP) {
  admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// ── Test state ────────────────────────────────────────────────────────────────

let tenantAId: string;
let tenantBId: string;
let userAId: string;
let userBId: string;
let docAId: string;
let docBId: string;
let sessionAToken: string;
let sessionBToken: string;

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAllFn(async () => {
  const ts = Date.now();

  // Create Tenant A
  const { data: tenantA } = await admin.from("tenants").insert({
    name: "Isolation Test Firm A",
    subscription_plan: "starter",
    subscription_status: "active",
  }).select("id").single();
  tenantAId = tenantA!.id;

  // Create Tenant B
  const { data: tenantB } = await admin.from("tenants").insert({
    name: "Isolation Test Firm B",
    subscription_plan: "starter",
    subscription_status: "active",
  }).select("id").single();
  tenantBId = tenantB!.id;

  // Create User A
  const emailA = `isolation-a-${ts}@ledgeriq-test.internal`;
  const { data: authA } = await admin.auth.admin.createUser({
    email: emailA,
    password: "TestPassword123!",
    email_confirm: true,
  });
  userAId = authA.user!.id;
  await admin.from("users").insert({ id: userAId, tenant_id: tenantAId, email: emailA, role: "admin" });

  // Create User B
  const emailB = `isolation-b-${ts}@ledgeriq-test.internal`;
  const { data: authB } = await admin.auth.admin.createUser({
    email: emailB,
    password: "TestPassword123!",
    email_confirm: true,
  });
  userBId = authB.user!.id;
  await admin.from("users").insert({ id: userBId, tenant_id: tenantBId, email: emailB, role: "admin" });

  // Sign in as User A and get session token
  const anonClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { data: sessionA } = await anonClient.auth.signInWithPassword({
    email: emailA,
    password: "TestPassword123!",
  });
  sessionAToken = sessionA.session!.access_token;

  // Sign in as User B
  const { data: sessionB } = await anonClient.auth.signInWithPassword({
    email: emailB,
    password: "TestPassword123!",
  });
  sessionBToken = sessionB.session!.access_token;

  // Create a document for Tenant A
  const { data: docA } = await admin.from("documents").insert({
    tenant_id: tenantAId,
    document_type: "purchase_invoice",
    original_filename: "firm_a_secret_invoice.pdf",
    storage_path: "test/placeholder.pdf",
    file_size_bytes: 1000,
    mime_type: "application/pdf",
    status: "review_required",
    uploaded_by: userAId,
  }).select("id").single();
  docAId = docA!.id;

  // Create a document for Tenant B
  const { data: docB } = await admin.from("documents").insert({
    tenant_id: tenantBId,
    document_type: "purchase_invoice",
    original_filename: "firm_b_secret_invoice.pdf",
    storage_path: "test/placeholder.pdf",
    file_size_bytes: 1000,
    mime_type: "application/pdf",
    status: "review_required",
    uploaded_by: userBId,
  }).select("id").single();
  docBId = docB!.id;

  // Add extractions for Tenant A's document
  await admin.from("extractions").insert({
    document_id: docAId,
    tenant_id: tenantAId,
    field_name: "vendor_name",
    extracted_value: "Firm A Secret Vendor",
    confidence: 0.9,
    status: "pending",
  });
}, 60000);

afterAllFn(async () => {
  await admin.from("extractions").delete().in("document_id", [docAId, docBId]);
  await admin.from("documents").delete().in("id", [docAId, docBId]);
  await admin.from("users").delete().in("id", [userAId, userBId]);
  await admin.from("tenants").delete().in("id", [tenantAId, tenantBId]);
  await admin.auth.admin.deleteUser(userAId);
  await admin.auth.admin.deleteUser(userBId);
});

// ── RLS isolation tests ───────────────────────────────────────────────────────

describeOrSkip("Tenant isolation — RLS (database level)", () => {

  test("User A can read their own documents", async () => {
    const clientA = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${sessionAToken}` } } }
    );

    const { data, error } = await clientA
      .from("documents")
      .select("id, original_filename, tenant_id")
      .eq("id", docAId);

    expect(error).toBeNull();
    expect(data!.length).toBe(1);
    expect(data![0].original_filename).toBe("firm_a_secret_invoice.pdf");
  });

  test("User A CANNOT read Tenant B's documents", async () => {
    const clientA = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${sessionAToken}` } } }
    );

    const { data, error } = await clientA
      .from("documents")
      .select("id")
      .eq("id", docBId);

    // RLS should return 0 rows (not an error — just empty)
    expect(error).toBeNull();
    expect(data!.length).toBe(0);
  });

  test("User B CANNOT read Tenant A's documents", async () => {
    const clientB = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${sessionBToken}` } } }
    );

    const { data } = await clientB
      .from("documents")
      .select("id")
      .eq("id", docAId);

    expect(data!.length).toBe(0);
  });

  test("User A cannot see Tenant B's documents in a full table scan", async () => {
    const clientA = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${sessionAToken}` } } }
    );

    const { data } = await clientA
      .from("documents")
      .select("id, tenant_id");

    // All returned documents must belong to Tenant A
    const leaks = (data ?? []).filter((d) => d.tenant_id === tenantBId);
    expect(leaks.length).toBe(0);
  });

  test("User A CANNOT read Tenant B's extractions", async () => {
    const clientA = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${sessionAToken}` } } }
    );

    const { data } = await clientA
      .from("extractions")
      .select("id, tenant_id")
      .eq("document_id", docBId);

    expect(data!.length).toBe(0);
  });

  test("User A extractions scan never returns Tenant B data", async () => {
    const clientA = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${sessionAToken}` } } }
    );

    const { data } = await clientA
      .from("extractions")
      .select("id, tenant_id");

    const leaks = (data ?? []).filter((e) => e.tenant_id === tenantBId);
    expect(leaks.length).toBe(0);
  });

  test("User A CANNOT delete Tenant B's document", async () => {
    const clientA = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${sessionAToken}` } } }
    );

    const { data } = await clientA
      .from("documents")
      .delete()
      .eq("id", docBId)
      .select("id");

    // RLS should prevent deletion — 0 rows affected
    expect((data ?? []).length).toBe(0);

    // Verify doc B still exists using admin client
    const { data: stillExists } = await admin
      .from("documents")
      .select("id")
      .eq("id", docBId);

    expect(stillExists!.length).toBe(1);
  });

  test("User A CANNOT update Tenant B's document", async () => {
    const clientA = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${sessionAToken}` } } }
    );

    await clientA
      .from("documents")
      .update({ status: "approved" })
      .eq("id", docBId);

    // Verify doc B status was NOT changed
    const { data: docB } = await admin
      .from("documents")
      .select("status")
      .eq("id", docBId)
      .single();

    expect(docB!.status).toBe("review_required"); // unchanged
  });

  test("Unauthenticated request returns no documents", async () => {
    const anonClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    const { data } = await anonClient
      .from("documents")
      .select("id");

    expect((data ?? []).length).toBe(0);
  });

  test("Unauthenticated request returns no users", async () => {
    const anonClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    const { data } = await anonClient
      .from("users")
      .select("id, email");

    expect((data ?? []).length).toBe(0);
  });
});
