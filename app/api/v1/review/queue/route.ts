import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users")
      .select("tenant_id")
      .eq("id", user.id)
      .single();

    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));
    const offset = (page - 1) * limit;
    const clientFilter = searchParams.get("client") ?? null;

    // "Stuck" = failed (always retryable) OR still processing after 2 minutes
    const stuckCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    let countQuery = supabase
      .from("documents")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", profile.tenant_id)
      .eq("status", "review_required")
      .is("deleted_at", null);
    if (clientFilter) countQuery = countQuery.eq("client_id", clientFilter);

    let docsQuery = supabase
      .from("documents")
      .select(`
        id, original_filename, document_type, status, uploaded_at, client_id,
        clients(client_name),
        extractions(id, field_name, extracted_value, confidence, status)
      `)
      .eq("tenant_id", profile.tenant_id)
      .eq("status", "review_required")
      .is("deleted_at", null)
      .order("uploaded_at", { ascending: true })
      .range(offset, offset + limit - 1);
    if (clientFilter) docsQuery = docsQuery.eq("client_id", clientFilter);

    const [{ count }, { data: documents, error }, { data: failedDocs }, { data: stalledDocs }] = await Promise.all([
      countQuery,
      docsQuery,
      // Failed docs — always show with retry option
      supabase
        .from("documents")
        .select("id, original_filename, document_type, status, uploaded_at")
        .eq("tenant_id", profile.tenant_id)
        .eq("status", "failed")
        .is("deleted_at", null)
        .order("uploaded_at", { ascending: false })
        .limit(20),
      // Docs still processing/queued after 2 minutes
      supabase
        .from("documents")
        .select("id, original_filename, document_type, status, uploaded_at")
        .eq("tenant_id", profile.tenant_id)
        .in("status", ["extracting", "queued"])
        .is("deleted_at", null)
        .lt("uploaded_at", stuckCutoff)
        .order("uploaded_at", { ascending: false })
        .limit(20),
    ]);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Compute per-document summary
    const queue = (documents ?? []).map((doc) => {
      const extractions = (doc.extractions ?? []) as Array<{
        id: string; field_name: string; extracted_value: string;
        confidence: number; status: string;
      }>;
      const lowConfidence = extractions.filter((e) => e.confidence < 0.7).length;
      const avgConfidence = extractions.length > 0
        ? extractions.reduce((s, e) => s + e.confidence, 0) / extractions.length
        : 0;

      const clientInfo = Array.isArray(doc.clients) ? doc.clients[0] : doc.clients;
      return {
        id: doc.id,
        fileName: doc.original_filename,
        type: doc.document_type,
        uploadedAt: doc.uploaded_at,
        totalFields: extractions.length,
        lowConfidenceFields: lowConfidence,
        avgConfidence: Math.round(avgConfidence * 100),
        client_id: (doc as { client_id?: string | null }).client_id ?? null,
        client_name: (clientInfo as { client_name?: string } | null)?.client_name ?? null,
      };
    });

    return NextResponse.json({
      queue,
      stuck: [...(failedDocs ?? []), ...(stalledDocs ?? [])].map((d) => ({
        id: d.id,
        fileName: d.original_filename,
        type: d.document_type,
        status: d.status,
        uploadedAt: d.uploaded_at,
      })),
      pagination: { page, limit, total: count ?? 0, pages: Math.ceil((count ?? 0) / limit) },
    });
  } catch (err) {
    console.error("[review/queue] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
