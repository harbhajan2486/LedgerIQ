import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

export async function GET(request: NextRequest) {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (profile?.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") ?? "this_month";

  const now = new Date();
  let periodStart: string;
  if (period === "last_month") {
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    periodStart = lastMonth.toISOString();
  } else {
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }
  const periodEnd = period === "last_month"
    ? new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    : now.toISOString();

  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: usage } = await sb
    .from("ai_usage")
    .select("tenant_id, model, tokens_in, tokens_out, cost_usd, document_id, created_at")
    .gte("created_at", periodStart)
    .lte("created_at", periodEnd);

  const { data: tenants } = await sb.from("tenants").select("id, name");
  const tenantMap: Record<string, string> = {};
  for (const t of tenants ?? []) tenantMap[t.id] = t.name;

  const totalSpend = (usage ?? []).reduce((s, r) => s + Number(r.cost_usd), 0);
  const budgetLimit = Number(process.env.AI_MONTHLY_BUDGET_USD ?? 50);

  // Group by model
  const spendByModel: Record<string, number> = {};
  for (const r of usage ?? []) {
    spendByModel[r.model] = (spendByModel[r.model] ?? 0) + Number(r.cost_usd);
  }

  // Group by tenant
  const spendByTenantMap: Record<string, number> = {};
  for (const r of usage ?? []) {
    const name = tenantMap[r.tenant_id] ?? r.tenant_id;
    spendByTenantMap[name] = (spendByTenantMap[name] ?? 0) + Number(r.cost_usd);
  }
  const spendByTenant = Object.entries(spendByTenantMap)
    .map(([tenant_name, cost]) => ({ tenant_name, cost }))
    .sort((a, b) => b.cost - a.cost);

  // Build row-level aggregation: by tenant+model
  const rowMap: Record<string, { tenant_name: string; model: string; doc_count: number; tokens_in: number; tokens_out: number; cost_usd: number }> = {};
  for (const r of usage ?? []) {
    const key = `${r.tenant_id}|${r.model}`;
    if (!rowMap[key]) {
      rowMap[key] = {
        tenant_name: tenantMap[r.tenant_id] ?? r.tenant_id,
        model: r.model,
        doc_count: 0,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
      };
    }
    rowMap[key].doc_count++;
    rowMap[key].tokens_in += r.tokens_in ?? 0;
    rowMap[key].tokens_out += r.tokens_out ?? 0;
    rowMap[key].cost_usd += Number(r.cost_usd);
  }

  return NextResponse.json({
    summary: { total_spend: totalSpend, budget_limit: budgetLimit, spend_by_model: spendByModel, spend_by_tenant: spendByTenant },
    rows: Object.values(rowMap).sort((a, b) => b.cost_usd - a.cost_usd),
  });
  } catch (err) {
    console.error("[admin/costs] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
