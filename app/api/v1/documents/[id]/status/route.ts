import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Lightweight status check — used by re-extraction polling
export async function GET(
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
    if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

    const { data: doc } = await supabase
      .from("documents")
      .select("status, processed_at")
      .eq("id", id)
      .eq("tenant_id", profile.tenant_id)
      .single();

    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json({ status: doc.status, processed_at: doc.processed_at });
  } catch (err) {
    console.error("[documents/status]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
