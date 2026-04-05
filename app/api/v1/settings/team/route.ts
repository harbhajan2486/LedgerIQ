import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { z } from "zod";

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["reviewer", "senior_reviewer", "admin"]),
});

async function getCallerInfo(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data } = await supabase
    .from("users")
    .select("tenant_id, role")
    .eq("id", userId)
    .single();
  return data;
}

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const caller = await getCallerInfo(supabase, user.id);
    if (!caller?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const { data: members } = await supabase
      .from("users")
      .select("id, email, full_name, role, created_at")
      .eq("tenant_id", caller.tenant_id)
      .order("created_at", { ascending: true });

    return NextResponse.json({ members: members ?? [] });
  } catch (err) {
    console.error("[settings/team GET] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const rl = await checkRateLimit(user.id);
  if (!rl.allowed) return rateLimitResponse(rl.resetAt);

  const caller = await getCallerInfo(supabase, user.id);
  if (!caller?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });
  if (caller.role !== "admin") {
    return NextResponse.json({ error: "Only admins can invite team members." }, { status: 403 });
  }

  const body = await request.json();
  const parsed = inviteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  const { email, role } = parsed.data;

  // Use service role to invite user via Supabase Auth
  const serviceClient = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Check if user already exists in this tenant
  const { data: existing } = await supabase
    .from("users")
    .select("id")
    .eq("tenant_id", caller.tenant_id)
    .eq("email", email.toLowerCase())
    .single();

  if (existing) {
    return NextResponse.json({ error: "This email is already a member of your firm." }, { status: 409 });
  }

  // Invite user — Supabase sends a magic link / invite email
  const { data: invited, error: inviteError } = await serviceClient.auth.admin.inviteUserByEmail(email, {
    data: {
      tenant_id: caller.tenant_id,
      role,
      invited_by: user.id,
    },
    redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/accept-invite`,
  });

  if (inviteError) {
    return NextResponse.json({ error: inviteError.message }, { status: 500 });
  }

  // Pre-create the user profile so RLS works immediately on accept
  await serviceClient.from("users").upsert({
    id: invited.user.id,
    email: email.toLowerCase(),
    tenant_id: caller.tenant_id,
    role,
    full_name: null,
  }, { onConflict: "id" });

  await supabase.from("audit_log").insert({
    tenant_id: caller.tenant_id,
    user_id: user.id,
    action: "invite_team_member",
    entity_type: "user",
    entity_id: invited.user.id,
    new_value: { email, role },
  });

  return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[settings/team POST] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
