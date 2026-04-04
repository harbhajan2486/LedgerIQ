import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId: targetUserId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (user.id === targetUserId) {
    return NextResponse.json({ error: "You cannot remove yourself." }, { status: 400 });
  }

  const { data: caller } = await supabase
    .from("users")
    .select("tenant_id, role")
    .eq("id", user.id)
    .single();

  if (!caller?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });
  if (caller.role !== "admin") {
    return NextResponse.json({ error: "Only admins can remove team members." }, { status: 403 });
  }

  // Verify target belongs to same tenant
  const { data: target } = await supabase
    .from("users")
    .select("id, email, tenant_id")
    .eq("id", targetUserId)
    .eq("tenant_id", caller.tenant_id)
    .single();

  if (!target) return NextResponse.json({ error: "User not found in your firm." }, { status: 404 });

  const serviceClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Delete from users table first (RLS allows, we own the tenant)
  await serviceClient.from("users").delete().eq("id", targetUserId);

  // Delete the auth user — revokes all sessions immediately
  await serviceClient.auth.admin.deleteUser(targetUserId);

  await supabase.from("audit_log").insert({
    tenant_id: caller.tenant_id,
    user_id: user.id,
    action: "remove_team_member",
    entity_type: "user",
    entity_id: targetUserId,
    new_value: { email: target.email },
  });

  return NextResponse.json({ success: true });
}
