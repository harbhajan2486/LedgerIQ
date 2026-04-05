import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { z } from "zod";

const matchSchema = z.object({
  transactionId: z.string().uuid(),
  documentId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const rl = await checkRateLimit(user.id);
  if (!rl.allowed) return rateLimitResponse(rl.resetAt);

  const { data: profile } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const body = await request.json();
  const parsed = matchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  const { transactionId, documentId } = parsed.data;

  const tenantId = profile.tenant_id;

  // Verify both belong to this tenant
  const [txnRes, docRes] = await Promise.all([
    supabase.from("bank_transactions").select("id").eq("id", transactionId).eq("tenant_id", tenantId).single(),
    supabase.from("documents").select("id").eq("id", documentId).eq("tenant_id", tenantId).single(),
  ]);

  if (!txnRes.data) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
  if (!docRes.data) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  // Create or update reconciliation record
  await supabase.from("reconciliations").upsert({
    tenant_id: tenantId,
    document_id: documentId,
    bank_transaction_id: transactionId,
    match_score: 100, // manual = 100
    match_reasons: ["Manual match by reviewer"],
    status: "matched",
    matched_at: new Date().toISOString(),
    matched_by: user.id,
  }, { onConflict: "tenant_id,bank_transaction_id" });

  await supabase.from("bank_transactions").update({ status: "matched" }).eq("id", transactionId);
  await supabase.from("documents").update({ status: "reconciled" }).eq("id", documentId);

  await supabase.from("audit_log").insert({
    tenant_id: tenantId,
    user_id: user.id,
    action: "manual_reconciliation_match",
    entity_type: "reconciliation",
    entity_id: transactionId,
    new_value: { document_id: documentId, transaction_id: transactionId },
  });

  return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[reconciliation/match] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
