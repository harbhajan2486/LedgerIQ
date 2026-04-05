import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// POST — mark a document as fully reviewed
// Only allowed when all extractions are accepted or corrected
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { documentId } = await params;

  const { data: profile } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", user.id)
    .single();

  // Check all extractions are resolved
  const { data: pending } = await supabase
    .from("extractions")
    .select("id")
    .eq("document_id", documentId)
    .eq("tenant_id", profile?.tenant_id)
    .eq("status", "pending");

  if (pending && pending.length > 0) {
    return NextResponse.json(
      { error: `${pending.length} field(s) still need review. Accept or correct all fields before marking as done.` },
      { status: 400 }
    );
  }

  // Move document to reconciliation queue
  const { error } = await supabase
    .from("documents")
    .update({ status: "reviewed", processed_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("tenant_id", profile?.tenant_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("audit_log").insert({
    tenant_id: profile?.tenant_id,
    user_id: user.id,
    action: "complete_review",
    entity_type: "document",
    entity_id: documentId,
  });

  return NextResponse.json({ success: true, nextStatus: "reviewed" });
  } catch (err) {
    console.error("[review/complete] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
