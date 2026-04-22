import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const VALID_TYPES = ["purchase_invoice", "sales_invoice", "expense", "credit_note", "debit_note"];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const { id: documentId } = await params;
  const body = await request.json();

  const patch: Record<string, unknown> = {};

  if (body.document_type !== undefined) {
    if (!VALID_TYPES.includes(body.document_type)) {
      return NextResponse.json({ error: "Invalid document type" }, { status: 400 });
    }
    patch.document_type = body.document_type;
  }

  if (body.client_id !== undefined) {
    patch.client_id = body.client_id ?? null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { error } = await supabase
    .from("documents")
    .update(patch)
    .eq("id", documentId)
    .eq("tenant_id", profile.tenant_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const { id: documentId } = await params;

  // Soft delete: set deleted_at timestamp. File stays in storage.
  // CGST Act Section 35 — accounting records must be retained for 6 years.
  // Hard deletes are blocked by RLS (migration 020).
  const { error } = await supabase
    .from("documents")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("tenant_id", profile.tenant_id)
    .is("deleted_at", null); // only archive if not already archived

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Audit trail
  await supabase.from("audit_log").insert({
    tenant_id: profile.tenant_id,
    user_id: user.id,
    action: "archive_document",
    entity_type: "documents",
    entity_id: documentId,
  });

  return NextResponse.json({ ok: true });
}
