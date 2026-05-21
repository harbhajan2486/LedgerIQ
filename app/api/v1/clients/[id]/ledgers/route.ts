import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { COMMON_LEDGERS } from "@/lib/ledger-rules";

async function getTenantId(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
  return profile?.tenant_id ?? null;
}

// GET — list ledgers for a client
// Paginates internally in 1,000-row pages to work around PostgREST's
// server-side max_rows cap (default 1000 on hosted Supabase).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const tenantId = await getTenantId(supabase);
  if (!tenantId) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { id: clientId } = await params;

  const PAGE = 1000;
  const allLedgers: Record<string, unknown>[] = [];
  let from = 0;

  while (true) {
    const { data: page, error } = await supabase
      .from("ledger_masters")
      .select("id, ledger_name, ledger_type, tally_group, closing_balance, balance_type, financial_year, source, created_at")
      .eq("tenant_id", tenantId)
      .eq("client_id", clientId)
      .order("ledger_type")
      .order("tally_group", { nullsFirst: false })
      .order("ledger_name")
      .range(from, from + PAGE - 1);

    if (error || !page || page.length === 0) break;
    allLedgers.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }

  return NextResponse.json({ ledgers: allLedgers });
}

// POST — add a ledger OR seed common ledgers
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const tenantId = await getTenantId(supabase);
  if (!tenantId) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { id: clientId } = await params;
  const body = await request.json();

  // Seed mode: insert all common ledgers at once
  if (body.seed === true) {
    const rows = COMMON_LEDGERS.map((l) => ({
      tenant_id: tenantId,
      client_id: clientId,
      ledger_name: l.ledger_name,
      ledger_type: l.ledger_type,
    }));
    const { error } = await supabase
      .from("ledger_masters")
      .upsert(rows, { onConflict: "tenant_id,client_id,ledger_name", ignoreDuplicates: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ seeded: rows.length });
  }

  // Single ledger add
  const { ledger_name, ledger_type } = body;
  if (!ledger_name || !ledger_type) return NextResponse.json({ error: "ledger_name and ledger_type required" }, { status: 400 });

  const { data, error } = await supabase
    .from("ledger_masters")
    .insert({ tenant_id: tenantId, client_id: clientId, ledger_name: ledger_name.trim(), ledger_type })
    .select("id, ledger_name, ledger_type")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ledger: data });
}

// DELETE — remove a single ledger by id, or all ledgers for the client
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const tenantId = await getTenantId(supabase);
  if (!tenantId) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { id: clientId } = await params;
  const body = await request.json();

  if (body.clearAll === true) {
    const { error } = await supabase
      .from("ledger_masters")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("client_id", clientId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  const { ledgerId } = body;
  if (!ledgerId) return NextResponse.json({ error: "ledgerId required" }, { status: 400 });

  const { error } = await supabase
    .from("ledger_masters")
    .delete()
    .eq("id", ledgerId)
    .eq("tenant_id", tenantId)
    .eq("client_id", clientId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
