import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const updateClientSchema = z.object({
  client_name: z.string().min(1).max(200).optional(),
  gstin: z.string().max(15).optional().nullable(),
  pan: z.string().max(10).optional().nullable(),
  industry_name: z.string().max(100).optional().nullable(),
});

// GET — single client + their documents
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

    const { id } = await params;
    const urlParams = new URL(_request.url).searchParams;
    const fromDate = urlParams.get("from");
    const toDate   = urlParams.get("to");

    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id, client_name, gstin, pan, industry_name, created_at")
      .eq("id", id)
      .eq("tenant_id", profile.tenant_id)
      .single();

    if (clientError || !client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    let docQuery = supabase
      .from("documents")
      .select("id, original_filename, document_type, status, uploaded_at, processed_at, ai_model_used")
      .eq("client_id", id)
      .eq("tenant_id", profile.tenant_id)
      .order("uploaded_at", { ascending: false })
      .limit(200);
    if (fromDate) docQuery = docQuery.gte("uploaded_at", fromDate);
    if (toDate)   docQuery = docQuery.lte("uploaded_at", toDate + "T23:59:59");
    const { data: documents } = await docQuery;

    // Per-doc confidence breakdown: high (≥0.8), medium (0.5–0.8), low (<0.5)
    const docIds = (documents ?? []).map((d) => d.id);
    const confMap: Record<string, { high: number; medium: number; low: number }> = {};
    if (docIds.length > 0) {
      const { data: confRows } = await supabase
        .from("extractions")
        .select("document_id, confidence")
        .in("document_id", docIds)
        .not("status", "eq", "rejected")
        .not("extracted_value", "is", null);
      for (const row of confRows ?? []) {
        if (!confMap[row.document_id]) confMap[row.document_id] = { high: 0, medium: 0, low: 0 };
        const c = row.confidence ?? 0;
        if (c >= 0.8) confMap[row.document_id].high++;
        else if (c >= 0.5) confMap[row.document_id].medium++;
        else confMap[row.document_id].low++;
      }
    }

    // Misclassification detection: flag purchase invoices where vendor IS the client.
    // GSTIN-first: if vendor_gstin matches client's own GSTIN → definitive flag.
    // Fall back to name-word overlap only when vendor_gstin is absent.
    const purchaseDocIds = (documents ?? [])
      .filter((d) => d.document_type === "purchase_invoice")
      .map((d) => d.id);
    const mismatchSet = new Set<string>();
    if (purchaseDocIds.length > 0) {
      const { data: vendorExts } = await supabase
        .from("extractions").select("document_id, extracted_value")
        .in("document_id", purchaseDocIds).eq("field_name", "vendor_name")
        .not("status", "eq", "rejected").not("extracted_value", "is", null);
      const { data: gstinExts } = await supabase
        .from("extractions").select("document_id, extracted_value")
        .in("document_id", purchaseDocIds).eq("field_name", "vendor_gstin")
        .not("status", "eq", "rejected").not("extracted_value", "is", null);

      // Build a map: document_id → vendor_gstin
      const vendorGstinMap: Record<string, string> = {};
      for (const ext of gstinExts ?? []) {
        vendorGstinMap[ext.document_id] = (ext.extracted_value ?? "").trim().toUpperCase();
      }
      const clientGstin = (client.gstin ?? "").trim().toUpperCase();
      const clientWords = client.client_name.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);

      for (const ext of vendorExts ?? []) {
        const vendorGstin = vendorGstinMap[ext.document_id] ?? "";
        if (vendorGstin && clientGstin) {
          // Definitive: vendor GSTIN matches client's own GSTIN
          if (vendorGstin === clientGstin) mismatchSet.add(ext.document_id);
          // If present but different → not a mismatch, skip
        } else if (!vendorGstin) {
          // No GSTIN — fall back to name-word overlap
          const v = (ext.extracted_value ?? "").toLowerCase();
          if (clientWords.some((word: string) => v.includes(word))) mismatchSet.add(ext.document_id);
        }
      }
    }

    const docsWithConf = (documents ?? []).map((d) => ({
      ...d,
      conf: confMap[d.id] ?? null,
      possible_misclassification: mismatchSet.has(d.id),
    }));

    return NextResponse.json({ client, documents: docsWithConf });
  } catch (err) {
    console.error("[clients/[id]/GET]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH — update client details
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

    const { id } = await params;
    const body = await request.json();
    const parsed = updateClientSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten().fieldErrors }, { status: 400 });
    }

    const { data: client, error } = await supabase
      .from("clients")
      .update(parsed.data)
      .eq("id", id)
      .eq("tenant_id", profile.tenant_id)
      .select("id, client_name, gstin, pan, industry_name")
      .single();

    if (error || !client) {
      return NextResponse.json({ error: "Client not found or update failed" }, { status: 404 });
    }

    return NextResponse.json({ client });
  } catch (err) {
    console.error("[clients/[id]/PATCH]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
