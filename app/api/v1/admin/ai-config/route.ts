import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const configSchema = z.object({
  // Model selection
  default_model:              z.enum(["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6"]),
  upgrade_model:              z.enum(["claude-sonnet-4-6", "claude-opus-4-6"]),
  confidence_upgrade_threshold: z.number().min(0).max(1),   // below this → upgrade to smarter model

  // Generation parameters
  temperature:  z.number().min(0).max(1),
  top_p:        z.number().min(0).max(1),
  max_tokens:   z.number().int().min(500).max(4096),

  // Prompt templates
  // {INJECTIONS} is replaced at runtime with few-shot + L1 + L3 context
  system_prompt: z.string().min(50).max(8000),
  // {DOC_TYPE} is replaced at runtime with the document type
  user_prompt:   z.string().min(20).max(4000),

  // Cost controls
  monthly_budget_usd: z.number().positive().max(500),
  alert_threshold_pct: z.number().min(50).max(99),  // % of budget before alert
});

export type AiConfig = z.infer<typeof configSchema>;

// Default config — matches current hardcoded values in edge function
export const DEFAULT_CONFIG: AiConfig = {
  default_model:               "claude-haiku-4-5-20251001",
  upgrade_model:               "claude-sonnet-4-6",
  confidence_upgrade_threshold: 0.70,
  temperature:  0.1,
  top_p:        0.95,
  max_tokens:   1500,
  system_prompt: `You are an expert Indian accounting document analyser. Extract structured data from the provided document.
{INJECTIONS}
RULES:
- Return ONLY valid JSON, no markdown, no explanation
- For each field, provide "value" and "confidence" (0.0 to 1.0)
- confidence = 1.0 means you are certain; 0.0 means you cannot find the field
- If a field is not present in the document, set value to null and confidence to 0.0
- For monetary values, return numbers only (no currency symbols or commas)
- For GST rates, return the percentage number (e.g. 18, not "18%")
- For dates, use DD/MM/YYYY format
- For GSTIN, return the 15-character alphanumeric code exactly
- For TDS section, return e.g. "194C", "194J", "194I"
- GST is MUTUALLY EXCLUSIVE: intra-state invoices have CGST + SGST only (IGST = null). Inter-state invoices have IGST only (CGST = SGST = null). NEVER set all three.
- For hsn_sac_code: HSN codes are for GOODS (4, 6, or 8 digits, e.g. "84212120", "9403", "94030001"). SAC codes are for SERVICES (6 digits starting with 99, e.g. "998313"). Extract whichever appears in the document line items or header. Goods invoices nearly always have HSN codes printed — look carefully in the line-item table.`,
  user_prompt: `Extract all fields from this {DOC_TYPE} document.

Return JSON in this exact format:
{
  "vendor_name": {"value": "...", "confidence": 0.95},
  "vendor_gstin": {"value": "...", "confidence": 0.90},
  "buyer_gstin": {"value": "...", "confidence": 0.85},
  "invoice_number": {"value": "...", "confidence": 0.99},
  "invoice_date": {"value": "...", "confidence": 0.99},
  "due_date": {"value": null, "confidence": 0.0},
  "taxable_value": {"value": "50000", "confidence": 0.95},
  "cgst_rate": {"value": "9", "confidence": 0.90},
  "cgst_amount": {"value": "4500", "confidence": 0.95},
  "sgst_rate": {"value": "9", "confidence": 0.90},
  "sgst_amount": {"value": "4500", "confidence": 0.95},
  "igst_rate": {"value": null, "confidence": 0.0},
  "igst_amount": {"value": null, "confidence": 0.0},
  "total_amount": {"value": "59000", "confidence": 0.99},
  "tds_section": {"value": "194C", "confidence": 0.80},
  "tds_rate": {"value": "1", "confidence": 0.80},
  "tds_amount": {"value": "500", "confidence": 0.75},
  "reverse_charge": {"value": "No", "confidence": 0.95},
  "place_of_supply": {"value": "Maharashtra", "confidence": 0.90},
  "hsn_sac_code": {"value": "998313", "confidence": 0.80},
  "itc_eligible": {"value": "Yes", "confidence": 0.80}
}`,
  monthly_budget_usd:  50,
  alert_threshold_pct: 80,
};

async function isAdmin(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data } = await supabase
    .from("users").select("role").eq("id", userId).single();
  return data?.role === "super_admin";
}

// GET — return current config (falls back to defaults if not set)
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!(await isAdmin(supabase, user.id))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data } = await supabase
    .from("ai_settings")
    .select("config")
    .eq("id", "global")
    .maybeSingle();

  const config = data?.config ? { ...DEFAULT_CONFIG, ...(data.config as Partial<AiConfig>) } : DEFAULT_CONFIG;
  return NextResponse.json({ config });
}

// POST — save config
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!(await isAdmin(supabase, user.id))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid config", details: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { error } = await supabase
    .from("ai_settings")
    .upsert({ id: "global", config: parsed.data, updated_at: new Date().toISOString(), updated_by: user.id });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from("audit_log").insert({
    user_id: user.id,
    action: "update_ai_config",
    entity_type: "ai_settings",
    entity_id: "global",
    new_value: parsed.data,
  });

  return NextResponse.json({ success: true });
}
