import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const start = Date.now();
  const checks: Record<string, "ok" | "error"> = {};

  // DB check — lightweight ping
  try {
    const supabase = await createClient();
    const { error } = await supabase.from("tenants").select("id").limit(1);
    checks.db = error ? "error" : "ok";
  } catch {
    checks.db = "error";
  }

  const latency_ms = Date.now() - start;
  const allOk = Object.values(checks).every((v) => v === "ok");

  return NextResponse.json(
    { status: allOk ? "ok" : "degraded", ...checks, latency_ms },
    { status: allOk ? 200 : 503 }
  );
}
