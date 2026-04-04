import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { isPasswordBreached } from "@/lib/hibp";

export async function POST(request: NextRequest) {
  try {
    const { email, password, firmName } = await request.json();

    if (!email || !password || !firmName) {
      return NextResponse.json(
        { error: "Email, password, and firm name are required." },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 }
      );
    }

    const breached = await isPasswordBreached(password);
    if (breached) {
      return NextResponse.json(
        { error: "This password has appeared in a data breach. Please choose a different password." },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    // Create the auth user
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/onboarding`,
      },
    });

    if (authError) {
      return NextResponse.json({ error: authError.message }, { status: 400 });
    }

    if (!authData.user) {
      return NextResponse.json(
        { error: "Signup failed. Please try again." },
        { status: 500 }
      );
    }

    // Use service role key for DB inserts — the user isn't authenticated
    // yet (email confirmation may be pending), so the anon client would be
    // blocked by RLS. Service role bypasses RLS safely server-side.
    const sb = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Create the tenant
    const { data: tenant, error: tenantError } = await sb
      .from("tenants")
      .insert({ name: firmName, plan: "starter", status: "active" })
      .select("id")
      .single();

    if (tenantError) {
      return NextResponse.json({ error: tenantError.message }, { status: 500 });
    }

    // Create the user profile
    const { error: profileError } = await sb.from("users").insert({
      id: authData.user.id,
      tenant_id: tenant.id,
      email: email.toLowerCase(),
      role: "admin",
    });

    if (profileError) {
      // If profile insert fails, clean up the tenant to avoid orphaned rows
      await sb.from("tenants").delete().eq("id", tenant.id);
      return NextResponse.json({ error: profileError.message }, { status: 500 });
    }

    // Audit log
    await sb.from("audit_log").insert({
      tenant_id: tenant.id,
      user_id: authData.user.id,
      action: "signup",
      entity_type: "tenant",
      entity_id: tenant.id,
      new_value: { firm_name: firmName, email },
    });

    // Notify super-admin about new signup
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/send-notification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ type: "new_signup", tenantId: tenant.id }),
    }).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[signup] unexpected error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
