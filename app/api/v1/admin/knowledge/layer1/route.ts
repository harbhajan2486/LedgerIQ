import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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
      .select("id, rule_type, pattern, action, source, confidence")
      .eq("layer", 1)
      .eq("is_active", true)
      .order("rule_type");

    return NextResponse.json({ rules: rules ?? [] });
  } catch (err) {
    console.error("[admin/knowledge/layer1]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
