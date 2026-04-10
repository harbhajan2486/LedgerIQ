import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — list unassigned transactions for this tenant (no client_id set)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const bank = new URL(request.url).searchParams.get("bank") ?? null;

  let q = supabase
    .from("bank_transactions")
    .select("id, transaction_date, narration, bank_name, debit_amount, credit_amount")
    .eq("tenant_id", profile.tenant_id)
    .is("client_id", null)
    .order("transaction_date", { ascending: false })
    .limit(500);

  if (bank) q = q.eq("bank_name", bank);

  const { data: txns } = await q;

  // Also return distinct bank names for the filter
  const { data: banks } = await supabase
    .from("bank_transactions")
    .select("bank_name")
    .eq("tenant_id", profile.tenant_id)
    .is("client_id", null);

  const bankNames = [...new Set((banks ?? []).map((b) => b.bank_name))].sort();

  return NextResponse.json({ transactions: txns ?? [], bank_names: bankNames });
}

// POST — assign selected transaction IDs to this client
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const { id: clientId } = await params;
  const { transactionIds } = await request.json();
  if (!Array.isArray(transactionIds) || transactionIds.length === 0)
    return NextResponse.json({ error: "transactionIds required" }, { status: 400 });

  const { error } = await supabase
    .from("bank_transactions")
    .update({ client_id: clientId })
    .in("id", transactionIds)
    .eq("tenant_id", profile.tenant_id)
    .is("client_id", null); // only claim truly unassigned ones

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ assigned: transactionIds.length });
}
