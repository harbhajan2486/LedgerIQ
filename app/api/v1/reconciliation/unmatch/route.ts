import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const { reconciliationId } = await request.json();
  if (!reconciliationId) return NextResponse.json({ error: "reconciliationId required" }, { status: 400 });

  const tenantId = profile.tenant_id;

  const { data: recon } = await supabase
    .from("reconciliations")
    .select("document_id, bank_transaction_id")
    .eq("id", reconciliationId)
    .eq("tenant_id", tenantId)
    .single();

  if (!recon) return NextResponse.json({ error: "Reconciliation not found" }, { status: 404 });

  // Remove the reconciliation record
  await supabase.from("reconciliations").delete().eq("id", reconciliationId);

  // Reset statuses
  await supabase.from("bank_transactions").update({ status: "unmatched" }).eq("id", recon.bank_transaction_id);
  await supabase.from("documents").update({ status: "reviewed" }).eq("id", recon.document_id);

  await supabase.from("audit_log").insert({
    tenant_id: tenantId,
    user_id: user.id,
    action: "reconciliation_unmatch",
    entity_type: "reconciliation",
    entity_id: reconciliationId,
    new_value: { document_id: recon.document_id, transaction_id: recon.bank_transaction_id },
  });

  return NextResponse.json({ success: true });
}
