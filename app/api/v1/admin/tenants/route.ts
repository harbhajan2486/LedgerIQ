import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (profile?.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Use service role to get cross-tenant data
  const { createClient: createServiceClient } = await import("@supabase/supabase-js");
  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: tenants } = await sb
    .from("tenants")
    .select("id, name, created_at, subscription_plan, subscription_status")
    .order("created_at", { ascending: false });

  if (!tenants) return NextResponse.json({ tenants: [] });

  // For each tenant, get stats
  const tenantIds = tenants.map((t) => t.id);

  const [usersRes, docsRes, correctionsRes, aiRes] = await Promise.all([
    sb.from("users").select("tenant_id").in("tenant_id", tenantIds),
    sb.from("documents").select("tenant_id").in("tenant_id", tenantIds),
    sb.from("corrections").select("tenant_id").in("tenant_id", tenantIds),
    sb.from("ai_usage").select("tenant_id, cost_usd").in("tenant_id", tenantIds),
  ]);

  // Count per tenant
  const userCount: Record<string, number> = {};
  const docCount: Record<string, number> = {};
  const corrCount: Record<string, number> = {};
  const aiSpend: Record<string, number> = {};

  for (const u of usersRes.data ?? []) userCount[u.tenant_id] = (userCount[u.tenant_id] ?? 0) + 1;
  for (const d of docsRes.data ?? []) docCount[d.tenant_id] = (docCount[d.tenant_id] ?? 0) + 1;
  for (const c of correctionsRes.data ?? []) corrCount[c.tenant_id] = (corrCount[c.tenant_id] ?? 0) + 1;
  for (const a of aiRes.data ?? []) aiSpend[a.tenant_id] = (aiSpend[a.tenant_id] ?? 0) + Number(a.cost_usd);

  const result = tenants.map((t) => ({
    ...t,
    user_count: userCount[t.id] ?? 0,
    doc_count: docCount[t.id] ?? 0,
    correction_count: corrCount[t.id] ?? 0,
    ai_spend_total: aiSpend[t.id] ?? 0,
  }));

  return NextResponse.json({ tenants: result });
}
