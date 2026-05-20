import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPattern, ledgerToMeta } from "@/lib/ledger-rules";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const { id: clientId } = await params;
    const tenantId = profile.tenant_id;
    const body = await request.json();
    const { pattern, ledger_name, overwrite = false } = body as {
      pattern: string;
      ledger_name: string;
      overwrite?: boolean;
    };

    if (!pattern || !ledger_name) {
      return NextResponse.json({ error: "pattern and ledger_name are required" }, { status: 400 });
    }

    // Fetch all transactions for this client that are candidates for bulk mapping
    const { data: txns } = await supabase
      .from("bank_transactions")
      .select("id, narration, ledger_name")
      .eq("tenant_id", tenantId)
      .eq("client_id", clientId)
      .limit(5000);

    // Filter to those that share the same extracted pattern
    const matches = (txns ?? []).filter((t) => {
      if (!t.narration) return false;
      if (!overwrite && t.ledger_name) return false; // skip already-assigned unless overwrite
      return extractPattern(t.narration) === pattern;
    });

    if (matches.length === 0) {
      return NextResponse.json({ updated: 0 });
    }

    const matchIds = matches.map((t) => t.id);

    // Derive category + voucher_type from the ledger name (same as single-txn PATCH)
    const meta = ledgerToMeta(ledger_name);
    const updatePayload: Record<string, unknown> = { ledger_name };
    if (meta) { updatePayload.category = meta.category; updatePayload.voucher_type = meta.voucher_type; }

    // Batch update in chunks of 100 to stay within Supabase limits
    for (let i = 0; i < matchIds.length; i += 100) {
      await supabase
        .from("bank_transactions")
        .update(updatePayload)
        .eq("tenant_id", tenantId)
        .eq("client_id", clientId)
        .in("id", matchIds.slice(i, i + 100));
    }

    await supabase.from("audit_log").insert({
      tenant_id: tenantId,
      user_id: user.id,
      action: "bulk_apply_ledger",
      entity_type: "bank_transactions",
      entity_id: clientId,
      new_value: { pattern, ledger_name, count: matchIds.length },
    });

    return NextResponse.json({ updated: matchIds.length });
  } catch (err) {
    console.error("[bulk-apply-ledger]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
