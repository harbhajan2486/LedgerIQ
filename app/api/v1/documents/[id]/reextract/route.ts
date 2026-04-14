import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Force re-extraction for any document, including already-reviewed ones.
// Use when AI rules have been updated (e.g. TDS inference added) and you want
// the document to be re-processed with the new rules.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const { data: doc } = await supabase
      .from("documents")
      .select("id, storage_path, document_type, client_id, status")
      .eq("id", id)
      .eq("tenant_id", profile.tenant_id)
      .single();

    if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

    // Race condition guard: if already extracting, reject the duplicate request
    if (doc.status === "extracting") {
      return NextResponse.json({ error: "Extraction already in progress for this document" }, { status: 409 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    if (!serviceKey) return NextResponse.json({ error: "Extraction service not configured" }, { status: 503 });

    // Lock document immediately — any concurrent request will hit the 409 above
    await supabase.from("documents").update({ status: "extracting" }).eq("id", id);

    // Mark all existing extractions as rejected so the fresh run has a clean slate
    await supabase
      .from("extractions")
      .update({ status: "rejected" })
      .eq("document_id", id);

    // Look up client industry and TDS flag
    let clientIndustry: string | null = null;
    let clientTdsApplicable: boolean = true;
    if (doc.client_id) {
      const { data: clientData } = await supabase
        .from("clients").select("industry_name, tds_applicable").eq("id", doc.client_id).single();
      clientIndustry = clientData?.industry_name ?? null;
      clientTdsApplicable = clientData?.tds_applicable ?? true;
    }

    // Check monthly AI spend
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const { data: usageData } = await supabase.from("ai_usage").select("cost_usd").gte("created_at", monthStart);
    const monthlySpend = (usageData ?? []).reduce((s, r) => s + Number(r.cost_usd), 0);
    const budgetLimit  = Number(process.env.AI_MONTHLY_BUDGET_USD ?? 50);

    const res = await fetch(`${supabaseUrl}/functions/v1/extract-document`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({
        documentId: doc.id,
        tenantId: profile.tenant_id,
        storagePath: doc.storage_path,
        documentType: doc.document_type,
        monthlySpend,
        budgetLimit,
        clientId: doc.client_id ?? null,
        clientIndustry,
        clientTdsApplicable,
      }),
    });

    if (!res.ok) {
      await supabase.from("documents").update({ status: "failed" }).eq("id", id);
      return NextResponse.json({ error: "Edge function call failed" }, { status: 502 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[documents/reextract]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
