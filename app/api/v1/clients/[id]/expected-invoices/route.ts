import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const createSchema = z.object({
  vendor_name:    z.string().min(1).max(200),
  approx_amount:  z.number().positive().optional().nullable(),
  expected_by:    z.string().optional().nullable(), // ISO date string
  notes:          z.string().max(500).optional().nullable(),
});

// GET — list all expected invoices for this client
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const { id: clientId } = await params;

  const { data, error } = await supabase
    .from("expected_invoices")
    .select("id, vendor_name, approx_amount, expected_by, notes, status, created_at")
    .eq("client_id", clientId)
    .eq("tenant_id", profile.tenant_id)
    .order("expected_by", { ascending: true, nullsFirst: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ expected: data ?? [] });
}

// POST — create a new expected invoice entry
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const { id: clientId } = await params;
  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", details: parsed.error.flatten().fieldErrors }, { status: 400 });

  const { data, error } = await supabase
    .from("expected_invoices")
    .insert({
      tenant_id:     profile.tenant_id,
      client_id:     clientId,
      vendor_name:   parsed.data.vendor_name,
      approx_amount: parsed.data.approx_amount ?? null,
      expected_by:   parsed.data.expected_by ?? null,
      notes:         parsed.data.notes ?? null,
      status:        "pending",
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id });
}

// PATCH — mark as received or delete
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const body = await req.json();
  const { expectedId, action } = body as { expectedId: string; action: "received" | "delete" };

  if (action === "delete") {
    await supabase.from("expected_invoices").delete()
      .eq("id", expectedId).eq("tenant_id", profile.tenant_id);
    return NextResponse.json({ success: true });
  }

  if (action === "received") {
    await supabase.from("expected_invoices").update({ status: "received" })
      .eq("id", expectedId).eq("tenant_id", profile.tenant_id);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
