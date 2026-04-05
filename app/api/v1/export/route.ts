// Data export — lets a firm download all their data as a ZIP-like CSV bundle.
// Satisfies GDPR right to portability and CA firm audit requirements.
// Returns a single CSV with all documents, extractions, bank transactions,
// and reconciliations — one section each, separated by blank lines.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id, role").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    // Only admins and senior reviewers can export all data
    if (!["admin", "senior_reviewer"].includes(profile.role)) {
      return NextResponse.json({ error: "Only admins can export firm data." }, { status: 403 });
    }

    const tenantId = profile.tenant_id;

    // Fetch all tables in parallel
    const [docsRes, extractionsRes, txnsRes, reconcRes] = await Promise.all([
      supabase
        .from("documents")
        .select("id, original_filename, document_type, status, uploaded_at, file_size_bytes")
        .eq("tenant_id", tenantId)
        .order("uploaded_at", { ascending: true }),

      supabase
        .from("extractions")
        .select("document_id, field_name, extracted_value, confidence, status")
        .eq("tenant_id", tenantId),

      supabase
        .from("bank_transactions")
        .select("id, transaction_date, narration, ref_number, debit_amount, credit_amount, bank_name, status")
        .eq("tenant_id", tenantId)
        .order("transaction_date", { ascending: true }),

      supabase
        .from("reconciliations")
        .select("id, document_id, bank_transaction_id, match_score, status, matched_at")
        .eq("tenant_id", tenantId)
        .order("matched_at", { ascending: true }),
    ]);

    function csvRow(cells: (string | number | null | undefined)[]) {
      return cells.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",");
    }

    const sections: string[] = [];

    // Section 1: Documents
    sections.push("# DOCUMENTS");
    sections.push(csvRow(["ID", "Filename", "Type", "Status", "Uploaded At", "Size (bytes)"]));
    for (const d of docsRes.data ?? []) {
      sections.push(csvRow([d.id, d.original_filename, d.document_type, d.status, d.uploaded_at, d.file_size_bytes]));
    }

    sections.push("");

    // Section 2: Extractions
    sections.push("# EXTRACTIONS");
    sections.push(csvRow(["Document ID", "Field", "Extracted Value", "Confidence", "Status"]));
    for (const e of extractionsRes.data ?? []) {
      sections.push(csvRow([e.document_id, e.field_name, e.extracted_value, e.confidence, e.status]));
    }

    sections.push("");

    // Section 3: Bank Transactions
    sections.push("# BANK TRANSACTIONS");
    sections.push(csvRow(["ID", "Date", "Narration", "Ref Number", "Debit", "Credit", "Bank", "Status"]));
    for (const t of txnsRes.data ?? []) {
      sections.push(csvRow([t.id, t.transaction_date, t.narration, t.ref_number, t.debit_amount, t.credit_amount, t.bank_name, t.status]));
    }

    sections.push("");

    // Section 4: Reconciliations
    sections.push("# RECONCILIATIONS");
    sections.push(csvRow(["ID", "Document ID", "Transaction ID", "Match Score", "Status", "Matched At"]));
    for (const r of reconcRes.data ?? []) {
      sections.push(csvRow([r.id, r.document_id, r.bank_transaction_id, r.match_score, r.status, r.matched_at]));
    }

    const csv = sections.join("\n");
    const date = new Date().toISOString().slice(0, 10);

    // Audit log the export
    await supabase.from("audit_log").insert({
      tenant_id: tenantId,
      user_id: user.id,
      action: "export_firm_data",
      entity_type: "tenant",
      entity_id: tenantId,
      new_value: {
        documents: docsRes.data?.length ?? 0,
        extractions: extractionsRes.data?.length ?? 0,
        transactions: txnsRes.data?.length ?? 0,
        reconciliations: reconcRes.data?.length ?? 0,
      },
    });

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="ledgeriq-export-${date}.csv"`,
      },
    });
  } catch (err) {
    console.error("[export] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
