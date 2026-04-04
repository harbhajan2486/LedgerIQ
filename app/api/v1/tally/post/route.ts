import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildPurchaseVoucher, generateVoucherXml, postToTally } from "@/lib/tally-xml";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const tenantId = profile.tenant_id;
  const { documentId } = await request.json();
  if (!documentId) return NextResponse.json({ error: "documentId required" }, { status: 400 });

  // Verify document belongs to tenant and is in the right state
  const { data: doc } = await supabase
    .from("documents")
    .select("id, original_filename, status")
    .eq("id", documentId)
    .eq("tenant_id", tenantId)
    .single();

  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  // Idempotency check — block duplicate posting
  const { data: existingPosting } = await supabase
    .from("tally_postings")
    .select("id, status")
    .eq("document_id", documentId)
    .eq("tenant_id", tenantId)
    .eq("status", "success")
    .single();

  if (existingPosting) {
    return NextResponse.json({
      error: "This invoice has already been posted to Tally. Duplicate posting blocked.",
      already_posted: true,
    }, { status: 409 });
  }

  // Get tenant Tally config
  const { data: tenant } = await supabase
    .from("tenants")
    .select("tally_endpoint, tally_company_name")
    .eq("id", tenantId)
    .single();

  if (!tenant?.tally_endpoint) {
    return NextResponse.json({ error: "Tally endpoint not configured. Go to Settings → Tally." }, { status: 400 });
  }

  // Get ledger mappings
  const { data: mappingRows } = await supabase
    .from("tally_ledger_mappings")
    .select("standard_account, tally_ledger_name")
    .eq("tenant_id", tenantId);

  const ledgerMap = {
    purchase_account: "Purchase Account",
    input_igst_18: "Input IGST 18%",
    input_igst_12: "Input IGST 12%",
    input_igst_5: "Input IGST 5%",
    input_cgst: "Input CGST",
    input_sgst: "Input SGST",
    sundry_creditors: "Sundry Creditors",
    tds_payable: "TDS Payable",
  } as Record<string, string>;

  for (const m of mappingRows ?? []) {
    if (m.tally_ledger_name) ledgerMap[m.standard_account] = m.tally_ledger_name;
  }

  // Get all accepted extractions for this document
  const { data: extractions } = await supabase
    .from("extractions")
    .select("field_name, extracted_value")
    .eq("document_id", documentId)
    .eq("status", "accepted");

  const fields: Record<string, string | null> = {};
  for (const ext of extractions ?? []) fields[ext.field_name] = ext.extracted_value;

  // Build invoice fields
  const invoiceFields = {
    vendor_name: fields.vendor_name ?? "Unknown Vendor",
    invoice_number: fields.invoice_number ?? null,
    invoice_date: fields.invoice_date ?? null,
    taxable_value: parseFloat(fields.taxable_value ?? "0") || 0,
    cgst_amount: fields.cgst_amount ? parseFloat(fields.cgst_amount) : null,
    sgst_amount: fields.sgst_amount ? parseFloat(fields.sgst_amount) : null,
    igst_amount: fields.igst_amount ? parseFloat(fields.igst_amount) : null,
    tds_amount: fields.tds_amount ? parseFloat(fields.tds_amount) : null,
    total_amount: parseFloat(fields.total_amount ?? "0") || 0,
    tds_section: fields.tds_section ?? null,
  };

  // Generate XML
  const voucherParams = buildPurchaseVoucher(invoiceFields, ledgerMap as unknown as Parameters<typeof buildPurchaseVoucher>[1], tenant.tally_company_name ?? undefined);
  const xml = generateVoucherXml(voucherParams);

  // Create a pending tally_postings record first (for idempotency)
  const { data: posting } = await supabase.from("tally_postings").insert({
    tenant_id: tenantId,
    document_id: documentId,
    voucher_type: "purchase",
    voucher_xml: xml,
    status: "pending",
    posted_by: user.id,
  }).select("id").single();

  // Post to Tally
  const result = await postToTally(tenant.tally_endpoint, xml);

  // Update posting status
  await supabase.from("tally_postings").update({
    status: result.success ? "success" : "failed",
    tally_response: result.response ?? result.error ?? null,
    posted_at: result.success ? new Date().toISOString() : null,
  }).eq("id", posting?.id);

  if (result.success) {
    await supabase.from("documents").update({ status: "posted" }).eq("id", documentId);
    await supabase.from("audit_log").insert({
      tenant_id: tenantId,
      user_id: user.id,
      action: "post_to_tally",
      entity_type: "document",
      entity_id: documentId,
      new_value: { voucher_type: "purchase", vendor: invoiceFields.vendor_name },
    });
  }

  return NextResponse.json({
    success: result.success,
    error: result.error ?? null,
    posting_id: posting?.id ?? null,
  });
}
