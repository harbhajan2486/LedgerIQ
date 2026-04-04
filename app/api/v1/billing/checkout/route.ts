import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import Stripe from "stripe";

const PLANS: Record<string, { priceId: string; name: string }> = {
  starter:    { priceId: process.env.STRIPE_PRICE_STARTER ?? "",    name: "Starter" },
  pro:        { priceId: process.env.STRIPE_PRICE_PRO ?? "",        name: "Pro" },
  business:   { priceId: process.env.STRIPE_PRICE_BUSINESS ?? "",   name: "Business" },
  enterprise: { priceId: process.env.STRIPE_PRICE_ENTERPRISE ?? "", name: "Enterprise" },
};

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users").select("tenant_id, role, email").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });
  if (profile.role !== "admin") return NextResponse.json({ error: "Only admins can manage billing" }, { status: 403 });

  const { plan } = await request.json();
  const planConfig = PLANS[plan];
  if (!planConfig || !planConfig.priceId) {
    return NextResponse.json({ error: "Invalid plan or Stripe not configured" }, { status: 400 });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

  const { data: tenant } = await supabase
    .from("tenants").select("name, stripe_customer_id").eq("id", profile.tenant_id).single();

  // Create or reuse Stripe customer
  let customerId = tenant?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: profile.email ?? user.email ?? "",
      name: tenant?.name ?? "",
      metadata: { tenant_id: profile.tenant_id },
    });
    customerId = customer.id;
    await supabase.from("tenants").update({ stripe_customer_id: customerId }).eq("id", profile.tenant_id);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [{ price: planConfig.priceId, quantity: 1 }],
    mode: "subscription",
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings?billing=success`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings`,
    metadata: { tenant_id: profile.tenant_id, plan },
    subscription_data: {
      metadata: { tenant_id: profile.tenant_id, plan },
    },
  });

  return NextResponse.json({ url: session.url });
}
