import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isPasswordBreached } from "@/lib/hibp";

export async function POST(request: NextRequest) {
  try {
    const { email, password, firmName } = await request.json();

    // Validate inputs
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

    // Check against known breached passwords
    const breached = await isPasswordBreached(password);
    if (breached) {
      return NextResponse.json(
        {
          error:
            "This password has appeared in a data breach. Please choose a different password.",
        },
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

    // Create the tenant (the accounting firm)
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .insert({ name: firmName, plan: "starter", status: "active" })
      .select("id")
      .single();

    if (tenantError) {
      return NextResponse.json({ error: tenantError.message }, { status: 500 });
    }

    // Create the user profile linked to the tenant as admin
    const { error: profileError } = await supabase.from("users").insert({
      id: authData.user.id,
      tenant_id: tenant.id,
      email,
      role: "admin",
    });

    if (profileError) {
      return NextResponse.json({ error: profileError.message }, { status: 500 });
    }

    // Write to audit log
    await supabase.from("audit_log").insert({
      tenant_id: tenant.id,
      user_id: authData.user.id,
      action: "signup",
      entity_type: "tenant",
      entity_id: tenant.id,
      new_value: { firm_name: firmName, email },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[signup] unexpected error:", error);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
