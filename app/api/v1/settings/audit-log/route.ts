import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users")
    .select("tenant_id, role")
    .eq("id", user.id)
    .single();

  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });
  if (profile.role !== "admin" && profile.role !== "senior_reviewer") {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  // Fetch last 1000 audit log entries for this tenant
  const { data: logs } = await supabase
    .from("audit_log")
    .select("id, created_at, user_id, action, entity_type, entity_id, old_value, new_value")
    .eq("tenant_id", profile.tenant_id)
    .order("created_at", { ascending: false })
    .limit(1000);

  // Fetch user emails to make the log human-readable
  const userIds = [...new Set((logs ?? []).map((l) => l.user_id).filter(Boolean))];
  const { data: users } = userIds.length > 0
    ? await supabase.from("users").select("id, email, full_name").in("id", userIds)
    : { data: [] };
  const userMap: Record<string, string> = {};
  for (const u of users ?? []) {
    userMap[u.id] = u.full_name || u.email;
  }

  // Build CSV
  const headers = ["timestamp", "user", "action", "entity_type", "entity_id", "old_value", "new_value"];
  const rows = (logs ?? []).map((log) => [
    new Date(log.created_at).toISOString(),
    userMap[log.user_id] ?? log.user_id ?? "",
    log.action ?? "",
    log.entity_type ?? "",
    log.entity_id ?? "",
    log.old_value ? JSON.stringify(log.old_value) : "",
    log.new_value ? JSON.stringify(log.new_value) : "",
  ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","));

  const csv = [headers.join(","), ...rows].join("\n");

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
  } catch (err) {
    console.error("[settings/audit-log] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
