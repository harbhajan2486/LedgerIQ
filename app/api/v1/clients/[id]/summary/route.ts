import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// GET — fetch latest summary for client
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

    const { id } = await params;

    const { data: summary } = await supabase
      .from("client_summaries")
      .select("id, summary_md, generated_at, period_from, period_to")
      .eq("client_id", id)
      .eq("tenant_id", profile.tenant_id)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return NextResponse.json({ summary });
  } catch (err) {
    console.error("[client/summary/GET]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST — generate (or regenerate) summary
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const periodFrom: string | null = body.period_from ?? null;
    const periodTo: string | null   = body.period_to   ?? null;

    // ── 1. Client profile ──────────────────────────────────────────────────────
    const { data: client } = await supabase
      .from("clients")
      .select("client_name, gstin, pan, industry_name, tds_applicable")
      .eq("id", id)
      .eq("tenant_id", profile.tenant_id)
      .single();
    if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

    // ── 2. Documents ───────────────────────────────────────────────────────────
    let docQuery = supabase
      .from("documents")
      .select("id, document_type, status, uploaded_at, ai_model_used")
      .eq("client_id", id)
      .eq("tenant_id", profile.tenant_id);
    if (periodFrom) docQuery = docQuery.gte("uploaded_at", periodFrom);
    if (periodTo)   docQuery = docQuery.lte("uploaded_at", periodTo + "T23:59:59");
    const { data: documents } = await docQuery;

    const docs = documents ?? [];
    const docIds = docs.map(d => d.id);

    // ── 3. Extractions aggregate ───────────────────────────────────────────────
    const numericFields = [
      "taxable_value", "cgst_amount", "sgst_amount", "igst_amount",
      "tds_amount", "total_amount",
    ];
    const metaFields = [
      "vendor_name", "tds_section", "suggested_ledger", "itc_eligible",
      "invoice_number", "invoice_date",
    ];

    let allExtractions: Array<{ document_id: string; field_name: string; extracted_value: string | null; status: string }> = [];
    if (docIds.length > 0) {
      const { data: exts } = await supabase
        .from("extractions")
        .select("document_id, field_name, extracted_value, status")
        .in("document_id", docIds)
        .in("field_name", [...numericFields, ...metaFields])
        .not("status", "eq", "rejected")
        .not("extracted_value", "is", null);
      allExtractions = exts ?? [];
    }

    // Latest value per doc per field (dedup)
    const latestByDocField = new Map<string, string | null>();
    for (const ext of allExtractions) {
      const key = `${ext.document_id}__${ext.field_name}`;
      if (!latestByDocField.has(key)) latestByDocField.set(key, ext.extracted_value);
    }

    // Numeric aggregates
    const totals: Record<string, number> = {};
    for (const f of numericFields) totals[f] = 0;
    for (const [key, val] of latestByDocField.entries()) {
      const field = key.split("__")[1];
      if (numericFields.includes(field)) totals[field] += parseFloat(val ?? "0") || 0;
    }

    // Vendor spend map
    const vendorSpend: Record<string, number> = {};
    for (const doc of docs) {
      if (!["purchase_invoice", "expense"].includes(doc.document_type)) continue;
      const vendor = latestByDocField.get(`${doc.id}__vendor_name`) ?? "Unknown Vendor";
      const total  = parseFloat(latestByDocField.get(`${doc.id}__total_amount`) ?? "0") || 0;
      vendorSpend[vendor] = (vendorSpend[vendor] ?? 0) + total;
    }
    const topVendors = Object.entries(vendorSpend)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    // TDS by section
    const tdsBySection: Record<string, number> = {};
    for (const doc of docs) {
      if (!["purchase_invoice", "expense"].includes(doc.document_type)) continue;
      const section = latestByDocField.get(`${doc.id}__tds_section`) ?? "";
      const amount  = parseFloat(latestByDocField.get(`${doc.id}__tds_amount`) ?? "0") || 0;
      if (section && section !== "No TDS" && amount > 0) {
        tdsBySection[section] = (tdsBySection[section] ?? 0) + amount;
      }
    }

    // ITC breakdown
    let itcYes = 0, itcBlocked = 0;
    for (const doc of docs) {
      if (!["purchase_invoice", "expense"].includes(doc.document_type)) continue;
      const itc = latestByDocField.get(`${doc.id}__itc_eligible`) ?? "";
      const gst = (parseFloat(latestByDocField.get(`${doc.id}__cgst_amount`) ?? "0") || 0) * 2
                + (parseFloat(latestByDocField.get(`${doc.id}__igst_amount`) ?? "0") || 0);
      if (itc === "Yes") itcYes += gst;
      else if (itc === "Blocked") itcBlocked += gst;
    }

    // Ledger breakdown
    const ledgerBreakdown: Record<string, number> = {};
    for (const doc of docs) {
      if (!["purchase_invoice", "expense"].includes(doc.document_type)) continue;
      const ledger = latestByDocField.get(`${doc.id}__suggested_ledger`) ?? "Unclassified";
      const total  = parseFloat(latestByDocField.get(`${doc.id}__total_amount`) ?? "0") || 0;
      ledgerBreakdown[ledger] = (ledgerBreakdown[ledger] ?? 0) + total;
    }
    const topLedgers = Object.entries(ledgerBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // Sales invoices
    const salesDocs = docs.filter(d => d.document_type === "sales_invoice");
    let salesTotal = 0, salesTaxable = 0;
    for (const doc of salesDocs) {
      salesTotal   += parseFloat(latestByDocField.get(`${doc.id}__total_amount`)   ?? "0") || 0;
      salesTaxable += parseFloat(latestByDocField.get(`${doc.id}__taxable_value`) ?? "0") || 0;
    }

    // Reconciliation
    const { data: reconStats } = await supabase
      .from("bank_transactions")
      .select("status")
      .eq("client_id", id)
      .eq("tenant_id", profile.tenant_id);
    const reconSummary = { matched: 0, possible: 0, unmatched: 0 };
    for (const t of reconStats ?? []) {
      if (t.status === "matched")   reconSummary.matched++;
      else if (t.status === "possible") reconSummary.possible++;
      else reconSummary.unmatched++;
    }

    // Exceptions
    const pendingDocs      = docs.filter(d => d.status === "review_required").length;
    const failedDocs       = docs.filter(d => ["failed", "error"].includes(d.status)).length;
    const reviewedDocs     = docs.filter(d => ["reviewed","reconciled","posted"].includes(d.status)).length;

    // Low-confidence field count (across reviewed docs)
    let lowConfCount = 0;
    if (docIds.length > 0) {
      const { data: confRows } = await supabase
        .from("extractions")
        .select("confidence")
        .in("document_id", docIds)
        .not("status", "eq", "rejected")
        .not("extracted_value", "is", null)
        .lt("confidence", 0.5);
      lowConfCount = (confRows ?? []).length;
    }

    const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
    const periodLabel = periodFrom && periodTo
      ? `${periodFrom} to ${periodTo}`
      : periodFrom ? `from ${periodFrom}` : "all available data";

    // ── 4. Build data context for Claude ──────────────────────────────────────
    const dataContext = `
CLIENT PROFILE
Name: ${client.client_name}
GSTIN: ${client.gstin ?? "Not provided"}
PAN: ${client.pan ?? "Not provided"}
Industry: ${client.industry_name ?? "Not specified"}
TDS Deduction Applicable: ${client.tds_applicable ? "Yes" : "No (turnover below threshold)"}
Analysis Period: ${periodLabel}

DOCUMENT SUMMARY
Total documents: ${docs.length}
  Purchase invoices: ${docs.filter(d => d.document_type === "purchase_invoice").length}
  Sales invoices: ${salesDocs.length}
  Expenses: ${docs.filter(d => d.document_type === "expense").length}
  Credit notes: ${docs.filter(d => d.document_type === "credit_note").length}
  Debit notes: ${docs.filter(d => d.document_type === "debit_note").length}
Status breakdown:
  Reviewed/Reconciled/Posted: ${reviewedDocs}
  Pending review: ${pendingDocs}
  Failed extraction: ${failedDocs}

PURCHASE & EXPENSE ANALYSIS
Total taxable value (purchases + expenses): ₹${fmt(totals["taxable_value"])}
Total invoice value (gross): ₹${fmt(totals["total_amount"])}
CGST paid: ₹${fmt(totals["cgst_amount"])}
SGST paid: ₹${fmt(totals["sgst_amount"])}
IGST paid: ₹${fmt(totals["igst_amount"])}
Total GST input: ₹${fmt(totals["cgst_amount"] + totals["sgst_amount"] + totals["igst_amount"])}
ITC eligible (claimable): ₹${fmt(itcYes)}
ITC blocked (non-claimable under S.17(5)): ₹${fmt(itcBlocked)}

TDS DEDUCTIONS (₹ deducted)
${Object.entries(tdsBySection).length > 0
  ? Object.entries(tdsBySection).map(([s, a]) => `  ${s}: ₹${fmt(a)}`).join("\n")
  : "  No TDS deductions recorded"}
Total TDS deducted: ₹${fmt(totals["tds_amount"])}

TOP VENDORS BY SPEND
${topVendors.map(([v, a], i) => `  ${i + 1}. ${v}: ₹${fmt(a)}`).join("\n") || "  No vendor data"}

EXPENSE LEDGER BREAKDOWN
${topLedgers.map(([l, a], i) => `  ${i + 1}. ${l}: ₹${fmt(a)}`).join("\n") || "  No ledger data"}

SALES ANALYSIS
Total sales invoices: ${salesDocs.length}
Total sales value (gross): ₹${fmt(salesTotal)}
Total taxable sales: ₹${fmt(salesTaxable)}

BANK RECONCILIATION
Matched transactions: ${reconSummary.matched}
Possible matches (pending confirmation): ${reconSummary.possible}
Unmatched transactions: ${reconSummary.unmatched}

DATA QUALITY FLAGS
Low-confidence extractions: ${lowConfCount}
Documents pending review: ${pendingDocs}
Failed extractions: ${failedDocs}
`.trim();

    // ── 5. Call Claude Sonnet ──────────────────────────────────────────────────
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      temperature: 0.3,
      system: `You are a senior chartered accountant writing a technical review note for an Indian accounting firm.
Write in clear, professional English. Use proper Indian accounting terminology (CGST, SGST, IGST, ITC, TDS sections, etc.).
Structure the note with numbered sections. Be concise but thorough.
Highlight anything that needs attention. Do NOT make up numbers — use only what is provided.
Format using markdown: ## for section headers, **bold** for key figures, bullet points for lists.
Do not add disclaimers or sign-offs.`,
      messages: [{
        role: "user",
        content: `Write a comprehensive accountant summary note for this client based on the following data:\n\n${dataContext}\n\nThe note should cover:\n1. Executive Summary (2-3 sentences)\n2. Document & Review Status\n3. GST Analysis (purchase-side input tax, sales-side output tax if applicable)\n4. TDS Compliance\n5. Expense Analysis & Top Vendors\n6. Bank Reconciliation Status\n7. Observations & Action Points (specific items needing attention)\n\nBe specific with numbers. Flag anything unusual.`,
      }],
    });

    const summaryMd = response.content[0].type === "text" ? response.content[0].text : "";

    // Track AI cost
    const SONNET_COST = { input: 3.00, output: 15.00 };
    const costUsd = (response.usage.input_tokens / 1_000_000) * SONNET_COST.input
                  + (response.usage.output_tokens / 1_000_000) * SONNET_COST.output;
    await supabase.from("ai_usage").insert({
      tenant_id: profile.tenant_id,
      model: "claude-sonnet-4-6",
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
      cost_usd: costUsd,
    });

    // ── 6. Store ───────────────────────────────────────────────────────────────
    const { data: saved } = await supabase
      .from("client_summaries")
      .insert({
        client_id: id,
        tenant_id: profile.tenant_id,
        period_from: periodFrom,
        period_to: periodTo,
        summary_md: summaryMd,
        generated_by: user.id,
      })
      .select("id, generated_at, period_from, period_to")
      .single();

    return NextResponse.json({ summary: { ...saved, summary_md: summaryMd } });
  } catch (err) {
    console.error("[client/summary/POST]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
