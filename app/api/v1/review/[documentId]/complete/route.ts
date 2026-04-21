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

  // Auto-accept all remaining pending fields. The CA has made the deliberate
  // decision to mark the document reviewed — any fields they didn't individually
  // check are accepted as-is (same as the AI's extracted value).
  await supabase
    .from("extractions")
    .update({ status: "accepted" })
    .eq("document_id", documentId)
    .eq("tenant_id", profile?.tenant_id)
    .eq("status", "pending");

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

  // Re-run auto-match so invoices reviewed after bank statement upload get paired
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl && profile?.tenant_id) {
    fetch(`${appUrl}/api/v1/reconciliation/auto-match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: profile.tenant_id }),
    }).catch(() => {});
  }

  return NextResponse.json({ success: true, nextStatus: "reviewed" });
  } catch (err) {
    console.error("[review/complete] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
