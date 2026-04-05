import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

// GET — check if demo data exists (so the UI can show "Clear demo" even after page refresh)
export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return NextResponse.json({ hasDemo: false });

    const sb = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const { data: profile } = await sb
      .from("users").select("tenant_id").eq("id", session.user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ hasDemo: false });

    const { count } = await sb
      .from("documents")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", profile.tenant_id)
      .eq("doc_fingerprint", "DEMO");

    return NextResponse.json({ hasDemo: (count ?? 0) > 0 });
  } catch {
    return NextResponse.json({ hasDemo: false });
  }
}

export async function DELETE() {
  try {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: profile } = await sb
    .from("users")
    .select("tenant_id")
    .eq("id", session.user.id)
    .single();

  if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const tenantId = profile.tenant_id;

  const { data: demoDocs } = await sb
    .from("documents")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("doc_fingerprint", "DEMO");   // ONLY rows with exactly this fingerprint

  // Safety hard-stop: demo seed creates exactly 3 docs.
  // If somehow more than 10 rows match, something is wrong — abort.
  if (demoDocs && demoDocs.length > 10) {
    console.error("[demo/clear] Unexpectedly large demo doc count:", demoDocs.length);
    return NextResponse.json({ error: "Unexpected state — aborting to protect real data" }, { status: 500 });
  }

  if (demoDocs && demoDocs.length > 0) {
    const demoDocIds = demoDocs.map((d: { id: string }) => d.id);
    // Delete child rows first (foreign key order), then documents
    await sb.from("reconciliations").delete().in("document_id", demoDocIds);
    await sb.from("extractions").delete().in("document_id", demoDocIds);
    await sb.from("documents").delete().in("id", demoDocIds);
    // ^^ .in() only matches the exact IDs from the DEMO fingerprint query above —
    //    real documents are never in this list
  }

  // Only deletes transactions whose ref_number starts with "DEMO-"
  // Real bank imports never use this prefix
  await sb.from("bank_transactions")
    .delete()
    .eq("tenant_id", tenantId)
    .like("ref_number", "DEMO-%");

  return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[demo/seed] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST() {
  try {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: profile } = await sb
    .from("users")
    .select("tenant_id")
    .eq("id", session.user.id)
    .single();

  if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const tenantId = profile.tenant_id;

  // Clean up any previous demo data
  const { data: existingDemoDocs } = await sb
    .from("documents")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("doc_fingerprint", "DEMO");

  if (existingDemoDocs && existingDemoDocs.length > 0) {
    const demoDocIds = existingDemoDocs.map((d: { id: string }) => d.id);
    await sb.from("reconciliations").delete().in("document_id", demoDocIds);
    await sb.from("extractions").delete().in("document_id", demoDocIds);
    await sb.from("documents").delete().in("id", demoDocIds);
  }
  await sb.from("bank_transactions").delete().eq("tenant_id", tenantId).like("ref_number", "DEMO-%");

  // --- INSERT 3 DEMO DOCUMENTS ---
  const { data: docs, error: docsError } = await sb.from("documents").insert([
    {
      tenant_id: tenantId,
      document_type: "purchase_invoice",
      original_filename: "Tata_Steel_Invoice_March2026.pdf",
      storage_path: "demo/placeholder.pdf",
      file_size_bytes: 245000,
      mime_type: "application/pdf",
      status: "review_required",
      uploaded_by: session.user.id,
      doc_fingerprint: "DEMO",
    },
    {
      tenant_id: tenantId,
      document_type: "purchase_invoice",
      original_filename: "Reliance_Petro_Invoice_March2026.pdf",
      storage_path: "demo/placeholder.pdf",
      file_size_bytes: 187000,
      mime_type: "application/pdf",
      status: "review_required",
      uploaded_by: session.user.id,
      doc_fingerprint: "DEMO",
    },
    {
      tenant_id: tenantId,
      document_type: "expense",
      original_filename: "Office_Rent_March2026.pdf",
      storage_path: "demo/placeholder.pdf",
      file_size_bytes: 98000,
      mime_type: "application/pdf",
      status: "reviewed",
      uploaded_by: session.user.id,
      doc_fingerprint: "DEMO",
    },
  ]).select("id");

  if (docsError) {
    console.error("[demo/seed] documents insert error:", docsError);
    return NextResponse.json({ error: "Failed to insert documents", detail: docsError.message }, { status: 500 });
  }

  const [doc1, doc2, doc3] = docs ?? [];

  // --- INSERT EXTRACTIONS FOR DOC 1 (Tata Steel — some low confidence) ---
  if (doc1) {
    await sb.from("extractions").insert([
      { document_id: doc1.id, tenant_id: tenantId, field_name: "vendor_name",    extracted_value: "Tata Steel Ltd",        confidence: 0.97, status: "accepted" },
      { document_id: doc1.id, tenant_id: tenantId, field_name: "gstin",          extracted_value: "21AABCT3518Q1ZS",       confidence: 0.94, status: "accepted" },
      { document_id: doc1.id, tenant_id: tenantId, field_name: "invoice_number", extracted_value: "TSL/2026/03/4821",      confidence: 0.99, status: "accepted" },
      { document_id: doc1.id, tenant_id: tenantId, field_name: "invoice_date",   extracted_value: "2026-03-15",             confidence: 0.98, status: "accepted" },
      { document_id: doc1.id, tenant_id: tenantId, field_name: "taxable_amount", extracted_value: "₹4,20,000",             confidence: 0.91, status: "accepted" },
      { document_id: doc1.id, tenant_id: tenantId, field_name: "cgst",           extracted_value: "₹37,800",               confidence: 0.88, status: "accepted" },
      { document_id: doc1.id, tenant_id: tenantId, field_name: "sgst",           extracted_value: "₹37,800",               confidence: 0.88, status: "accepted" },
      { document_id: doc1.id, tenant_id: tenantId, field_name: "total_amount",   extracted_value: "₹4,95,600",             confidence: 0.95, status: "accepted" },
      { document_id: doc1.id, tenant_id: tenantId, field_name: "hsn_code",       extracted_value: "7208",                  confidence: 0.62, status: "pending" },
      { document_id: doc1.id, tenant_id: tenantId, field_name: "tds_section",    extracted_value: "194C",                  confidence: 0.54, status: "pending" },
    ]);
  }

  // --- INSERT EXTRACTIONS FOR DOC 2 (Reliance — good confidence) ---
  if (doc2) {
    await sb.from("extractions").insert([
      { document_id: doc2.id, tenant_id: tenantId, field_name: "vendor_name",    extracted_value: "Reliance Industries Ltd", confidence: 0.98, status: "accepted" },
      { document_id: doc2.id, tenant_id: tenantId, field_name: "gstin",          extracted_value: "27AAACR5055K1ZG",         confidence: 0.96, status: "accepted" },
      { document_id: doc2.id, tenant_id: tenantId, field_name: "invoice_number", extracted_value: "RIL/MUM/2026/8834",       confidence: 0.99, status: "accepted" },
      { document_id: doc2.id, tenant_id: tenantId, field_name: "invoice_date",   extracted_value: "2026-03-22",               confidence: 0.97, status: "accepted" },
      { document_id: doc2.id, tenant_id: tenantId, field_name: "taxable_amount", extracted_value: "₹1,85,000",               confidence: 0.93, status: "accepted" },
      { document_id: doc2.id, tenant_id: tenantId, field_name: "igst",           extracted_value: "₹33,300",                 confidence: 0.91, status: "accepted" },
      { document_id: doc2.id, tenant_id: tenantId, field_name: "total_amount",   extracted_value: "₹2,18,300",               confidence: 0.96, status: "accepted" },
      { document_id: doc2.id, tenant_id: tenantId, field_name: "hsn_code",       extracted_value: "2710",                    confidence: 0.89, status: "accepted" },
    ]);
  }

  // --- INSERT BANK TRANSACTIONS ---
  const { data: txns, error: txnsError } = await sb.from("bank_transactions").insert([
    {
      tenant_id: tenantId,
      transaction_date: "2026-03-17",
      narration: "NEFT-TATA STEEL LTD-INV4821",
      amount: 495600,
      type: "debit",
      debit_amount: 495600,
      ref_number: "DEMO-NEFT20260317001",
      bank_name: "HDFC Bank",
      status: "unmatched",
    },
    {
      tenant_id: tenantId,
      transaction_date: "2026-03-24",
      narration: "IMPS-RELIANCE IND-RIL8834",
      amount: 218300,
      type: "debit",
      debit_amount: 218300,
      ref_number: "DEMO-IMPS20260324002",
      bank_name: "HDFC Bank",
      status: "unmatched",
    },
    {
      tenant_id: tenantId,
      transaction_date: "2026-03-28",
      narration: "UPI-OFFICE RENT-MAR26",
      amount: 85000,
      type: "debit",
      debit_amount: 85000,
      ref_number: "DEMO-UPI20260328003",
      bank_name: "HDFC Bank",
      status: "unmatched",
    },
    {
      tenant_id: tenantId,
      transaction_date: "2026-03-29",
      narration: "NEFT-UNKNOWN VENDOR-INV9921",
      amount: 72500,
      type: "debit",
      debit_amount: 72500,
      ref_number: "DEMO-NEFT20260329004",
      bank_name: "HDFC Bank",
      status: "unmatched",
    },
  ]).select("id");

  if (txnsError) {
    console.error("[demo/seed] bank_transactions insert error:", txnsError);
    return NextResponse.json({ error: "Failed to insert transactions", detail: txnsError.message }, { status: 500 });
  }

  const [txn1, txn2] = txns ?? [];

  // --- INSERT RECONCILIATION (auto-matched) ---
  if (doc1 && txn1) {
    await sb.from("reconciliations").insert({
      tenant_id: tenantId,
      document_id: doc1.id,
      bank_transaction_id: txn1.id,
      match_score: 94,
      status: "matched",
      match_reasons: ["Amount matches ₹4,95,600", "Vendor name TATA STEEL in description", "Date within 2 days"],
      matched_at: new Date().toISOString(),
    });
    await sb.from("bank_transactions").update({ status: "matched" }).eq("id", txn1.id);
  }

  if (doc2 && txn2) {
    await sb.from("reconciliations").insert({
      tenant_id: tenantId,
      document_id: doc2.id,
      bank_transaction_id: txn2.id,
      match_score: 91,
      status: "matched",
      match_reasons: ["Amount matches ₹2,18,300", "RELIANCE in bank description", "Date within 2 days"],
      matched_at: new Date().toISOString(),
    });
    await sb.from("bank_transactions").update({ status: "matched" }).eq("id", txn2.id);
  }

  return NextResponse.json({ success: true, documentsCreated: docs?.length ?? 0 });
  } catch (err) {
    console.error("[demo/seed] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
