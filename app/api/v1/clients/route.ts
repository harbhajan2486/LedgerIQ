import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const createClientSchema = z.object({
  client_name: z.string().min(1).max(200),
  gstin: z.string().max(15).optional().nullable(),
  pan: z.string().max(10).optional().nullable(),
  industry_name: z.string().max(100).optional().nullable(),
});

// GET — list all clients for this tenant
export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

    const { data: clients, error } = await supabase
      .from("clients")
      .select("id, client_name, gstin, pan, industry_name, created_at")
      .eq("tenant_id", profile.tenant_id)
      .order("client_name", { ascending: true });

    if (error) throw error;

    // Enrich with document + bank transaction counts
    const clientIds = (clients ?? []).map((c) => c.id);
    const [{ data: docCounts }, { data: pendingCounts }, { data: unreconciledCounts }] = await Promise.all([
      supabase
        .from("documents")
        .select("client_id")
        .eq("tenant_id", profile.tenant_id)
        .in("client_id", clientIds),
      supabase
        .from("documents")
        .select("client_id")
        .eq("tenant_id", profile.tenant_id)
        .eq("status", "review_required")
        .in("client_id", clientIds),
      supabase
        .from("bank_transactions")
        .select("client_id")
        .eq("tenant_id", profile.tenant_id)
        .eq("status", "unmatched")
        .in("client_id", clientIds),
    ]);

    const docCountMap: Record<string, number> = {};
    const pendingCountMap: Record<string, number> = {};
    const unreconciledMap: Record<string, number> = {};
    (docCounts ?? []).forEach((d) => {
      if (d.client_id) docCountMap[d.client_id] = (docCountMap[d.client_id] ?? 0) + 1;
    });
    (pendingCounts ?? []).forEach((d) => {
      if (d.client_id) pendingCountMap[d.client_id] = (pendingCountMap[d.client_id] ?? 0) + 1;
    });
    (unreconciledCounts ?? []).forEach((d) => {
      if (d.client_id) unreconciledMap[d.client_id] = (unreconciledMap[d.client_id] ?? 0) + 1;
    });

    const enriched = (clients ?? []).map((c) => ({
      ...c,
      document_count: docCountMap[c.id] ?? 0,
      pending_review: pendingCountMap[c.id] ?? 0,
      unreconciled: unreconciledMap[c.id] ?? 0,
    }));

    return NextResponse.json({ clients: enriched });
  } catch (err) {
    console.error("[clients/GET]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST — create a new client
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

    const body = await request.json();
    const parsed = createClientSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten().fieldErrors }, { status: 400 });
    }

    const { data: client, error } = await supabase
      .from("clients")
      .insert({
        tenant_id: profile.tenant_id,
        client_name: parsed.data.client_name,
        gstin: parsed.data.gstin ?? null,
        pan: parsed.data.pan ?? null,
        industry_name: parsed.data.industry_name ?? null,
      })
      .select("id, client_name, gstin, pan, industry_name, created_at")
      .single();

    if (error) throw error;

    return NextResponse.json({ client }, { status: 201 });
  } catch (err) {
    console.error("[clients/POST]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
