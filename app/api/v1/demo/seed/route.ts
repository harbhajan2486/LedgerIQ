import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

// GET — check if demo data exists (so UI shows "Clear demo" even after page refresh)
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
      .from("users").select("tenant_id").eq("id", session.user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

    const tenantId = profile.tenant_id;

    const { data: demoDocs } = await sb
      .from("documents")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("doc_fingerprint", "DEMO");

    if (demoDocs && demoDocs.length > 10) {
      return NextResponse.json({ error: "Unexpected state — aborting to protect real data" }, { status: 500 });
    }

    if (demoDocs && demoDocs.length > 0) {
      const demoDocIds = demoDocs.map((d: { id: string }) => d.id);
      await sb.from("reconciliations").delete().in("document_id", demoDocIds);
      await sb.from("extractions").delete().in("document_id", demoDocIds);
      await sb.from("documents").delete().in("id", demoDocIds);
    }

    await sb.from("bank_transactions")
      .delete()
      .eq("tenant_id", tenantId)
      .like("ref_number", "DEMO-%");

    // Delete demo client (identified by name prefix)
    await sb.from("clients")
      .delete()
      .eq("tenant_id", tenantId)
      .like("client_name", "[DEMO]%");

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[demo/seed DELETE]", err);
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
      .from("users").select("tenant_id").eq("id", session.user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

    const tenantId = profile.tenant_id;

    // Clean up any previous demo data
    const { data: existingDemoDocs } = await sb
      .from("documents").select("id").eq("tenant_id", tenantId).eq("doc_fingerprint", "DEMO");
    if (existingDemoDocs && existingDemoDocs.length > 0) {
      const ids = existingDemoDocs.map((d: { id: string }) => d.id);
      await sb.from("reconciliations").delete().in("document_id", ids);
      await sb.from("extractions").delete().in("document_id", ids);
      await sb.from("documents").delete().in("id", ids);
    }
    await sb.from("bank_transactions").delete().eq("tenant_id", tenantId).like("ref_number", "DEMO-%");
    await sb.from("clients").delete().eq("tenant_id", tenantId).like("client_name", "[DEMO]%");

    // --- CREATE DEMO CLIENTS ---
    const { data: clients, error: clientsError } = await sb.from("clients").insert([
      {
        tenant_id: tenantId,
        client_name: "[DEMO] Tata Steel Ltd",
        gstin: "21AABCT3518Q1ZS",
        pan: "AABCT3518Q",
        industry_name: "Manufacturing",
      },
      {
        tenant_id: tenantId,
        client_name: "[DEMO] Reliance Industries Ltd",
        gstin: "27AAACR5055K1ZG",
        pan: "AAACR5055K",
        industry_name: "Retail / Trading",
      },
    ]).select("id");

    if (clientsError) {
      console.error("[demo/seed] clients insert error:", clientsError);
      return NextResponse.json({ error: "Failed to insert clients", detail: clientsError.message }, { status: 500 });
    }

    const [client1, client2] = clients ?? [];

    // --- INSERT 3 DEMO DOCUMENTS (with correct field names matching EXTRACTION_FIELDS) ---
    const { data: docs, error: docsError } = await sb.from("documents").insert([
      {
        tenant_id: tenantId,
        client_id: client1?.id ?? null,
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
        client_id: client2?.id ?? null,
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
        client_id: client1?.id ?? null,
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

    // --- EXTRACTIONS FOR DOC 1 (Tata Steel — using correct EXTRACTION_FIELDS names) ---
    if (doc1) {
      await sb.from("extractions").insert([
        { document_id: doc1.id, tenant_id: tenantId, field_name: "vendor_name",       extracted_value: "Tata Steel Limited",      confidence: 0.97, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "vendor_gstin",      extracted_value: "21AABCT3518Q1ZS",         confidence: 0.94, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "buyer_gstin",       extracted_value: "29AABCS1429B1Z4",         confidence: 0.91, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "invoice_number",    extracted_value: "TSL/2026/03/4821",        confidence: 0.99, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "invoice_date",      extracted_value: "15/03/2026",              confidence: 0.98, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "due_date",          extracted_value: "30/03/2026",              confidence: 0.85, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "taxable_value",     extracted_value: "420000",                  confidence: 0.95, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "cgst_rate",         extracted_value: "9",                       confidence: 0.92, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "cgst_amount",       extracted_value: "37800",                   confidence: 0.93, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "sgst_rate",         extracted_value: "9",                       confidence: 0.92, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "sgst_amount",       extracted_value: "37800",                   confidence: 0.93, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "igst_rate",         extracted_value: null,                      confidence: 0.0,  status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "igst_amount",       extracted_value: null,                      confidence: 0.0,  status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "total_amount",      extracted_value: "495600",                  confidence: 0.97, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "tds_section",       extracted_value: "194C",                    confidence: 0.54, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "tds_rate",          extracted_value: "2",                       confidence: 0.52, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "tds_amount",        extracted_value: "8400",                    confidence: 0.48, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "payment_reference", extracted_value: null,                      confidence: 0.0,  status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "reverse_charge",    extracted_value: "No",                      confidence: 0.95, status: "pending" },
        { document_id: doc1.id, tenant_id: tenantId, field_name: "place_of_supply",   extracted_value: "Odisha",                  confidence: 0.88, status: "pending" },
      ]);
    }

    // --- EXTRACTIONS FOR DOC 2 (Reliance — high confidence, IGST interstate) ---
    if (doc2) {
      await sb.from("extractions").insert([
        { document_id: doc2.id, tenant_id: tenantId, field_name: "vendor_name",       extracted_value: "Reliance Industries Ltd", confidence: 0.98, status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "vendor_gstin",      extracted_value: "27AAACR5055K1ZG",         confidence: 0.96, status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "buyer_gstin",       extracted_value: "29AABCS1429B1Z4",         confidence: 0.94, status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "invoice_number",    extracted_value: "RIL/MUM/2026/8834",       confidence: 0.99, status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "invoice_date",      extracted_value: "22/03/2026",              confidence: 0.97, status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "due_date",          extracted_value: null,                      confidence: 0.0,  status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "taxable_value",     extracted_value: "185000",                  confidence: 0.96, status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "cgst_rate",         extracted_value: null,                      confidence: 0.0,  status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "cgst_amount",       extracted_value: null,                      confidence: 0.0,  status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "sgst_rate",         extracted_value: null,                      confidence: 0.0,  status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "sgst_amount",       extracted_value: null,                      confidence: 0.0,  status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "igst_rate",         extracted_value: "18",                      confidence: 0.93, status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "igst_amount",       extracted_value: "33300",                   confidence: 0.94, status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "total_amount",      extracted_value: "218300",                  confidence: 0.98, status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "tds_section",       extracted_value: "194Q",                    confidence: 0.82, status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "tds_rate",          extracted_value: "0.1",                     confidence: 0.80, status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "tds_amount",        extracted_value: "185",                     confidence: 0.78, status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "payment_reference", extracted_value: null,                      confidence: 0.0,  status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "reverse_charge",    extracted_value: "No",                      confidence: 0.97, status: "pending" },
        { document_id: doc2.id, tenant_id: tenantId, field_name: "place_of_supply",   extracted_value: "Maharashtra",             confidence: 0.92, status: "pending" },
      ]);
    }

    // --- BANK TRANSACTIONS ---
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

    // --- RECONCILIATION (auto-matched) ---
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

    return NextResponse.json({
      success: true,
      documentsCreated: docs?.length ?? 0,
      clientsCreated: clients?.length ?? 0,
      reviewDocumentId: doc1?.id ?? null,
    });
  } catch (err) {
    console.error("[demo/seed] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
