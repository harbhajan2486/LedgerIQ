import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  if (profile?.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const [docsAll, docsMonth, corrsAll, corrsMonth, layer2, tenantDocs, docStatuses, corrsRecent] = await Promise.all([
    sb.from("documents").select("id", { count: "exact", head: true }),
    sb.from("documents").select("id", { count: "exact", head: true }).gte("created_at", monthStart),
    sb.from("corrections").select("id", { count: "exact", head: true }),
    sb.from("corrections").select("id", { count: "exact", head: true }).gte("created_at", monthStart),
    sb.from("global_rules").select("is_active"),
    sb.from("documents").select("tenant_id").gte("created_at", monthStart),
    sb.from("documents").select("status"),
    sb.from("corrections").select("created_at").gte("created_at", twoWeeksAgo),
  ]);

  // Accuracy: avg confidence of reviewed extractions this month
  const { data: extractionConf } = await sb
    .from("extractions")
    .select("confidence")
    .eq("status", "accepted")
    .gte("created_at", monthStart)
    .limit(1000);

  const avgAccuracy = extractionConf && extractionConf.length > 0
    ? extractionConf.reduce((s, e) => s + Number(e.confidence), 0) / extractionConf.length
    : 0;

  // Top firms by docs
  const { data: tenants } = await sb.from("tenants").select("id, name");
  const tenantMap: Record<string, string> = {};
  for (const t of tenants ?? []) tenantMap[t.id] = t.name;

  const docsByTenant: Record<string, number> = {};
  for (const d of tenantDocs.data ?? []) {
    docsByTenant[d.tenant_id] = (docsByTenant[d.tenant_id] ?? 0) + 1;
  }
  const topFirms = Object.entries(docsByTenant)
    .map(([id, count]) => ({ name: tenantMap[id] ?? id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Docs by status
  const docsByStatus: Record<string, number> = {};
  for (const d of docStatuses.data ?? []) {
    docsByStatus[d.status] = (docsByStatus[d.status] ?? 0) + 1;
  }

  // Corrections per day
  const corrsByDay: Record<string, number> = {};
  for (const c of corrsRecent.data ?? []) {
    const day = c.created_at.slice(0, 10);
    corrsByDay[day] = (corrsByDay[day] ?? 0) + 1;
  }
  const corrsByDayArr = Object.entries(corrsByDay)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const layer2Active = (layer2.data ?? []).filter((r) => r.is_active).length;
  const layer2Pending = (layer2.data ?? []).filter((r) => !r.is_active).length;

  return NextResponse.json({
    total_docs_all_time: docsAll.count ?? 0,
    total_docs_this_month: docsMonth.count ?? 0,
    total_corrections_all_time: corrsAll.count ?? 0,
    total_corrections_this_month: corrsMonth.count ?? 0,
    avg_accuracy_this_month: avgAccuracy,
    layer2_rules_active: layer2Active,
    layer2_rules_pending: layer2Pending,
    top_firms_by_docs: topFirms,
    docs_by_status: docsByStatus,
    corrections_by_day: corrsByDayArr,
  });
}
