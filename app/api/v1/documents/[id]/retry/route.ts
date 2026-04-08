import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Retry extraction for a document stuck in "queued", "pending", or "failed" state
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { id } = await params;

    const { data: profile } = await supabase
      .from("users")
      .select("tenant_id")
      .eq("id", user.id)
      .single();

    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const { data: doc } = await supabase
      .from("documents")
      .select("id, storage_path, document_type, client_id, status")
      .eq("id", id)
      .eq("tenant_id", profile.tenant_id)
      .single();

    if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

    const retryableStatuses = ["queued", "pending", "failed", "extracting"];
    if (!retryableStatuses.includes(doc.status)) {
      return NextResponse.json({ error: `Cannot retry document with status "${doc.status}"` }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    if (!serviceKey) {
      return NextResponse.json({ error: "Extraction service not configured. Check SUPABASE_SERVICE_ROLE_KEY in environment variables." }, { status: 503 });
    }

    // Look up client industry if client is set
    let clientIndustry: string | null = null;
    if (doc.client_id) {
      const { data: clientData } = await supabase
        .from("clients")
        .select("industry_name")
        .eq("id", doc.client_id)
        .eq("tenant_id", profile.tenant_id)
        .single();
      clientIndustry = clientData?.industry_name ?? null;
    }

    // Reset status to pending before retrying
    await supabase.from("documents").update({ status: "pending" }).eq("id", id);

    // Check monthly spend
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const { data: usageData } = await supabase.from("ai_usage").select("cost_usd").gte("created_at", monthStart);
    const monthlySpend = (usageData ?? []).reduce((s, r) => s + Number(r.cost_usd), 0);
    const budgetLimit = Number(process.env.AI_MONTHLY_BUDGET_USD ?? 50);

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
      }),
    });

    if (!res.ok) {
      await supabase.from("documents").update({ status: "failed" }).eq("id", id);
      return NextResponse.json({ error: "Failed to trigger extraction. Check Edge Function deployment." }, { status: 502 });
    }

    return NextResponse.json({ success: true, message: "Extraction started. Check the review queue in 30–60 seconds." });
  } catch (err) {
    console.error("[documents/retry] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
