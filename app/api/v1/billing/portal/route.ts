import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users")
    .select("tenant_id, role")
    .eq("id", user.id)
    .single();

  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });
  if (profile.role !== "admin") {
    return NextResponse.json({ error: "Only admins can manage billing." }, { status: 403 });
  }

  const { data: tenant } = await supabase
    .from("tenants")
    .select("stripe_customer_id")
    .eq("id", profile.tenant_id)
    .single();

  if (!tenant?.stripe_customer_id) {
    // No Stripe customer yet — redirect to checkout instead
    return NextResponse.json({
      url: `${process.env.NEXT_PUBLIC_APP_URL}/api/v1/billing/checkout`,
    });
  }

  // Create Stripe billing portal session
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 500 });
  }

  const res = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      customer: tenant.stripe_customer_id,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings`,
    }),
  });

  const session = await res.json();
  if (!res.ok) {
    return NextResponse.json({ error: session.error?.message ?? "Stripe error" }, { status: 500 });
  }

  return NextResponse.json({ url: session.url });
}
