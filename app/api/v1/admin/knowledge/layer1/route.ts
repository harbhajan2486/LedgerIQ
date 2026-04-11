import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("role").eq("id", user.id).single();
    if (profile?.role !== "super_admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { data: rules } = await supabase
      .from("global_rules")
      .select("id, rule_type, rule_json, pattern, action, source, confidence, created_at")
      .eq("layer", 1)
      .eq("is_active", true)
      .order("rule_type");

    return NextResponse.json({ rules: rules ?? [] });
  } catch (err) {
    console.error("[admin/knowledge/layer1]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("role").eq("id", user.id).single();
    if (profile?.role !== "super_admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const { rule_type, section, description, keywords, rate, threshold, rate_label, source_ref } = body;

    if (!rule_type || !section) {
      return NextResponse.json({ error: "rule_type and section are required" }, { status: 400 });
    }

    const keywordList = (keywords ?? "").split(",").map((k: string) => k.trim().toLowerCase()).filter(Boolean);

    const rule_json = { section, description: description ?? "", rate, threshold };
    const pattern = { section, description: description ?? "", keywords: keywordList };
    const action: Record<string, unknown> = { rate, notes: description ?? "" };
    if (threshold) action.threshold_inr = threshold;
    if (rate_label) action.rate_label = rate_label;

    const sb = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: inserted, error } = await sb
      .from("global_rules")
      .insert({
        layer: 1,
        rule_type,
        rule_json,
        pattern,
        action,
        confidence: 1.0,
        source: source_ref ?? `Manually added by super-admin on ${new Date().toLocaleDateString("en-IN")}`,
        is_active: true,
        approved_by: user.id,
        approved_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await sb.from("audit_log").insert({
      user_id: user.id,
      action: "add_global_rule",
      entity_type: "global_rule",
      entity_id: inserted.id,
      new_value: { rule_type, section, layer: 1 },
    });

    return NextResponse.json({ success: true, id: inserted.id });
  } catch (err) {
    console.error("[admin/knowledge/layer1 POST]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
