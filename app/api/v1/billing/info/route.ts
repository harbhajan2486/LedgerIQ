import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", user.id)
    .single();

  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  // Get tenant subscription info
  const { data: tenant } = await supabase
    .from("tenants")
    .select("subscription_plan, subscription_status, subscription_period_end, stripe_customer_id")
    .eq("id", profile.tenant_id)
    .single();

  // Count documents this month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { count: docsThisMonth } = await supabase
    .from("documents")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", profile.tenant_id)
    .gte("created_at", monthStart);

  const { data: aiUsage } = await supabase
    .from("ai_usage")
    .select("cost_usd")
    .eq("tenant_id", profile.tenant_id)
    .gte("created_at", monthStart);

  const aiSpend = (aiUsage ?? []).reduce((s, r) => s + Number(r.cost_usd), 0);

  return NextResponse.json({
    plan: tenant?.subscription_plan ?? "free",
    status: tenant?.subscription_status ?? "active",
    current_period_end: tenant?.subscription_period_end ?? null,
    docs_this_month: docsThisMonth ?? 0,
    ai_spend_this_month: aiSpend,
  });
  } catch (err) {
    console.error("[billing/info] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
