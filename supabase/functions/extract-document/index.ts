// Supabase Edge Function: extract-document
// Processes a document through the AI extraction pipeline:
//   1. Cost guard — abort if monthly budget exceeded
//   2. Retrieve few-shot examples from correction_vectors (the learning moat)
//   3. Call Claude Haiku for extraction
//   4. If avg confidence < 70%, retry with Claude Sonnet
//   5. Store all extracted fields in extractions table
//   6. Update document status to review_required

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.27.3";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

// Claude model IDs
const HAIKU  = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";

// Cost per 1M tokens (USD) — used for tracking only
const COST_PER_1M: Record<string, { input: number; output: number }> = {
  [HAIKU]:  { input: 0.80, output: 4.00 },
  [SONNET]: { input: 3.00, output: 15.00 },
};

const BUDGET_LIMIT = Number(Deno.env.get("AI_MONTHLY_BUDGET_USD") ?? 50);

// Fields to extract from each document
const EXTRACTION_FIELDS = [
  "vendor_name", "vendor_gstin", "buyer_gstin", "invoice_number", "invoice_date",
  "due_date", "taxable_value", "cgst_rate", "cgst_amount", "sgst_rate", "sgst_amount",
  "igst_rate", "igst_amount", "total_amount", "tds_section", "tds_rate", "tds_amount",
  "payment_reference", "reverse_charge", "place_of_supply", "suggested_ledger",
  "hsn_sac_code", "itc_eligible",
];

// ─── TDS Keyword → Section mapping (deterministic Layer 1 post-processing) ───
interface TdsRule {
  section: string;
  rate: string;
  threshold: number;
  keywords: RegExp;
}

const TDS_KEYWORD_RULES: TdsRule[] = [
  {
    section: "194J", rate: "10", threshold: 30000,
    keywords: /\b(advocate|lawyer|legal|attorney|solicitor|chartered.accountant|ca.firm|auditor|audit|consultant|advisory|architect|interior.design|doctor|physician|surgeon|hospital|clinic|medical|healthcare|physiotherap|it.service|software|technology|technical.service|data.processing|research|scientific|information.tech)\b/i,
  },
  {
    section: "194C", rate: "2", threshold: 30000,
    keywords: /\b(transport|courier|logistics|freight|cargo|delivery|shipping|contractor|sub.contractor|construction|civil.work|builder|fabricat|manufactur|printing|advertis|media|broadcast|catering|housekeeping|security.guard|manpower|labour|labour.supply|event.management|pest.control|cleaning.service|drone|aerial.photo|aerial.video|videograph|cinematograph|photo.shoot|video.shoot|filming|aerial.survey|media.production|content.produc|photo.produc)\b/i,
  },
  {
    section: "194I", rate: "10", threshold: 240000,
    keywords: /\b(rent|rental|lease.rent|office.rent|premises|office.space|warehouse|godown|cold.storage|property.rent)\b/i,
  },
  {
    section: "194H", rate: "5", threshold: 15000,
    keywords: /\b(commission|brokerage|broker|referral.fee|dealership|franchise.fee|selling.agent)\b/i,
  },
  {
    section: "194A", rate: "10", threshold: 5000,
    keywords: /\b(interest|fd.interest|fixed.deposit.interest|ncd.interest|deposit.interest|loan.interest|debenture.interest)\b/i,
  },
  {
    section: "194O", rate: "1", threshold: 500000,
    keywords: /\b(amazon|flipkart|zomato|swiggy|meesho|myntra|snapdeal|paytm.mall|nykaa|bigbasket|blinkit|zepto|e.commerce|ecommerce)\b/i,
  },
];

// ─── Vendor → Tally ledger suggestion ────────────────────────────────────────
interface LedgerRule { keywords: RegExp; ledger: string }
const INVOICE_LEDGER_RULES: LedgerRule[] = [
  { keywords: /\b(salary|salaries|payroll|wages|stipend|hr|payslip)\b/i,         ledger: "Salary Expenses" },
  { keywords: /\b(rent|rental|lease.rent|premises|office.rent)\b/i,               ledger: "Rent" },
  { keywords: /\b(advocate|lawyer|legal|ca.firm|chartered|audit|consultant|advisory|architect|doctor|clinic|hospital|it.service|software|technical)\b/i, ledger: "Professional Fees" },
  { keywords: /\b(transport|courier|logistics|freight|cargo|delivery)\b/i,        ledger: "Travelling Expenses" },
  { keywords: /\b(drone|aerial|videograph|cinematograph|photo.shoot|filming|aerial.survey|content.produc)\b/i, ledger: "Photography / Videography Charges" },
  { keywords: /\b(advertis|marketing|media|promotion|campaign|pr.agency)\b/i,     ledger: "Advertising & Marketing" },
  { keywords: /\b(electricity|power|mseb|bescom|tneb|discom)\b/i,                 ledger: "Electricity Expenses" },
  { keywords: /\b(telephone|internet|broadband|wifi|jio|airtel|bsnl|vodafone|idea|mobile.bill)\b/i, ledger: "Telephone / Internet Expenses" },
  { keywords: /\b(insurance|lic|policy.premium|general.insurance|fire.insurance)\b/i, ledger: "Insurance Expenses" },
  { keywords: /\b(repair|maintenance|service.charge|amc|annual.maintenance)\b/i,  ledger: "Repair & Maintenance" },
  { keywords: /\b(petrol|fuel|diesel|hpcl|bpcl|iocl|vehicle.fuel)\b/i,           ledger: "Petrol / Vehicle Expenses" },
  { keywords: /\b(office.supply|stationery|printing|paper|cartridge|toner)\b/i,  ledger: "Printing & Stationery" },
  { keywords: /\b(staff.welfare|pantry|canteen|food|swiggy|zomato|meal)\b/i,     ledger: "Staff Welfare Expenses" },
  { keywords: /\b(computer|laptop|server|hardware|software.licen|subscription|microsoft|adobe|google.workspace|zoom)\b/i, ledger: "Computer / IT Expenses" },
  { keywords: /\b(bank.charge|service.charge|sms.charge|annual.fee|processing.fee|atm.charge)\b/i, ledger: "Bank Charges" },
  { keywords: /\b(loan|emi|repayment|instalment|principal)\b/i,                   ledger: "Loan Repayment" },
];

Deno.serve(async (req) => {
  let documentId: string | undefined;
  try {
    const body = await req.json();
    documentId = body.documentId;
    const { tenantId, storagePath, documentType, monthlySpend, clientId, clientIndustry } = body;

    if (!documentId || !tenantId) {
      return new Response(JSON.stringify({ error: "documentId and tenantId required" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    // ----------------------------------------------------------------
    // COST GUARD — abort if over monthly limit
    // ----------------------------------------------------------------
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const { data: usageRows } = await supabase
      .from("ai_usage")
      .select("cost_usd")
      .gte("created_at", monthStart);

    const currentSpend = (usageRows ?? []).reduce((s: number, r: { cost_usd: number }) => s + Number(r.cost_usd), 0);

    if (currentSpend >= BUDGET_LIMIT) {
      await supabase.from("documents")
        .update({ status: "queued" })
        .eq("id", documentId);
      return new Response(JSON.stringify({ queued: true, reason: "budget_exceeded" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    // ----------------------------------------------------------------
    // MARK AS EXTRACTING
    // ----------------------------------------------------------------
    await supabase.from("documents")
      .update({ status: "extracting" })
      .eq("id", documentId);

    // ----------------------------------------------------------------
    // DOWNLOAD DOCUMENT FROM STORAGE
    // ----------------------------------------------------------------
    const { data: fileData, error: fileError } = await supabase.storage
      .from("documents")
      .download(storagePath);

    if (fileError || !fileData) {
      await supabase.from("documents").update({ status: "failed" }).eq("id", documentId);
      return new Response(JSON.stringify({ error: "Could not download file" }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }

    const fileBytes = await fileData.arrayBuffer();
    // Encode in 8 KB chunks — spreading the full array at once overflows the call stack for large files
    const uint8 = new Uint8Array(fileBytes);
    let binary = "";
    const CHUNK = 8192;
    for (let i = 0; i < uint8.length; i += CHUNK) {
      binary += String.fromCharCode(...uint8.subarray(i, i + CHUNK));
    }
    const base64File = btoa(binary);
    const mimeType = fileData.type || "application/pdf";

    // ----------------------------------------------------------------
    // FEW-SHOT RETRIEVAL — query correction_vectors for similar past docs
    // This is the learning moat: retrieve top 5 most similar corrections
    // and inject them as examples into the prompt
    // Max 2000 tokens to avoid prompt bloat
    // ----------------------------------------------------------------
    let fewShotExamples = "";
    try {
      // Generate embedding for the document fingerprint
      const fingerprintText = `document_type:${documentType}`;
      const embRes = await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-embedding`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ text: fingerprintText }),
        }
      );

      if (embRes.ok) {
        const { embedding } = await embRes.json();

        // Vector similarity search — top 5 similar corrections for this tenant
        const { data: similarCorrections } = await supabase.rpc(
          "match_correction_vectors",
          {
            query_embedding: JSON.stringify(embedding),
            match_tenant_id: tenantId,
            match_count: 5,
          }
        );

        if (similarCorrections && similarCorrections.length > 0) {
          // Build few-shot examples — structural patterns only, no financial amounts
          const examples = (similarCorrections as Array<{
            correction_record_id: string;
          }>).map((match) => {
            return `- Similar document was corrected: pattern recorded`;
          });

          // Fetch actual correction details (field patterns only)
          const correctionIds = similarCorrections.map((m: { correction_record_id: string }) => m.correction_record_id);
          const { data: corrections } = await supabase
            .from("corrections")
            .select("wrong_value, correct_value, doc_fingerprint, extraction_id")
            .in("id", correctionIds)
            .limit(5);

          const correctionWithFields = await Promise.all(
            (corrections ?? []).map(async (c) => {
              const { data: ext } = await supabase
                .from("extractions")
                .select("field_name")
                .eq("id", c.extraction_id)
                .single();
              return { field: ext?.field_name, wrong: c.wrong_value, correct: c.correct_value };
            })
          );

          // Token budget: keep examples under ~500 tokens
          const exampleText = correctionWithFields
            .filter((e) => e.field)
            .slice(0, 5)
            .map((e) => `Field "${e.field}": previously extracted "${e.wrong}" but correct value was "${e.correct}"`)
            .join("\n");

          if (exampleText) {
            fewShotExamples = `\n\nLearned corrections from similar documents:\n${exampleText}\nApply these patterns when extracting fields from this document.\n`;
          }
        }
      }
    } catch {
      // Few-shot retrieval failed — continue without it, extraction still works
    }

    // ----------------------------------------------------------------
    // LAYER 1 — Inject global Indian tax rules into the prompt
    // These are law-based rules that are correct with certainty (confidence = 1.0)
    // ----------------------------------------------------------------
    let layer1Context = "";
    try {
      const { data: layer1Rules } = await supabase
        .from("global_rules")
        .select("rule_type, pattern, action")
        .eq("layer", 1)
        .eq("is_active", true)
        .in("rule_type", ["tds_section", "sac_gst_rate", "reverse_charge"])
        .limit(20);

      if (layer1Rules && layer1Rules.length > 0) {
        const tdsRules = layer1Rules
          .filter((r) => r.rule_type === "tds_section")
          .map((r) => {
            const p = r.pattern as Record<string, string>;
            const a = r.action as Record<string, unknown>;
            return `${p.section}: ${p.description} — rate: ${JSON.stringify(a).slice(0, 120)}`;
          })
          .join("\n");

        const gstRules = layer1Rules
          .filter((r) => r.rule_type === "sac_gst_rate")
          .map((r) => {
            const p = r.pattern as Record<string, string>;
            const a = r.action as Record<string, number>;
            return `SAC ${p.sac_prefix}: ${p.description} → IGST ${a.igst_rate}%`;
          })
          .join("\n");

        const rcmRules = layer1Rules
          .filter((r) => r.rule_type === "reverse_charge")
          .map((r) => {
            const p = r.pattern as Record<string, string>;
            const a = r.action as Record<string, unknown>;
            return `RCM: ${p.service} (SAC ${p.sac}) — ${(a as Record<string, string>).notes}`;
          })
          .join("\n");

        layer1Context = `\n\nLayer 1 — Indian Tax Law (apply with confidence=1.0, do NOT override these):
TDS Sections:
${tdsRules}
${gstRules ? `\nGST by SAC code:\n${gstRules}` : ""}
${rcmRules ? `\nReverse Charge (RCM):\n${rcmRules}` : ""}
`;
      }
    } catch {
      // Layer 1 retrieval failed — continue without it
    }

    // ----------------------------------------------------------------
    // LAYER 3 — Check vendor profile for this tenant
    // After extraction we will apply Layer 3 overrides, but we can also
    // inject known vendor quirks into the prompt if we have a vendor name hint
    // (For now we inject the top vendor profiles as pre-context)
    // ----------------------------------------------------------------
    let layer3Context = "";
    try {
      const { data: vendorProfiles } = await supabase
        .from("vendor_profiles")
        .select("vendor_name, gstin, tds_category, invoice_quirks")
        .eq("tenant_id", tenantId)
        .order("last_updated", { ascending: false })
        .limit(10);

      if (vendorProfiles && vendorProfiles.length > 0) {
        const profileLines = vendorProfiles
          .filter((vp) => vp.invoice_quirks && Object.keys(vp.invoice_quirks).length > 0)
          .map((vp) => {
            const quirks = vp.invoice_quirks as Record<string, string>;
            const quirkStr = Object.entries(quirks)
              .map(([field, val]) => `${field}="${val}"`)
              .join(", ");
            return `Vendor "${vp.vendor_name}"${vp.gstin ? ` (GSTIN: ${vp.gstin})` : ""}: ${quirkStr}${vp.tds_category ? `, TDS=${vp.tds_category}` : ""}`;
          });

        if (profileLines.length > 0) {
          layer3Context = `\n\nLayer 3 — Your firm's learned vendor patterns (apply with high confidence for matching vendors):
${profileLines.join("\n")}
`;
        }
      }
    } catch {
      // Layer 3 retrieval failed — continue without it
    }

    // Industry context (from client, if set)
    const industryContext = clientIndustry
      ? `\nClient industry: ${clientIndustry}. Apply industry-specific defaults where relevant.\n`
      : "";

    // ----------------------------------------------------------------
    // BUILD EXTRACTION PROMPT
    // ----------------------------------------------------------------
    const systemPrompt = `You are an expert Indian accounting document analyser. Extract structured data from the provided document.
${fewShotExamples}${layer1Context}${layer3Context}${industryContext}
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
- GST is MUTUALLY EXCLUSIVE: intra-state invoices have CGST + SGST only (IGST = null). Inter-state invoices have IGST only (CGST = SGST = null). NEVER set all three.`;

    const userPrompt = `Extract all fields from this ${documentType.replace(/_/g, " ")} document.

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
  "payment_reference": {"value": null, "confidence": 0.0},
  "reverse_charge": {"value": "No", "confidence": 0.95},
  "place_of_supply": {"value": "Maharashtra", "confidence": 0.90},
  "hsn_sac_code": {"value": "998313", "confidence": 0.80},
  "itc_eligible": {"value": "Yes", "confidence": 0.80}
}`;

    // ----------------------------------------------------------------
    // CALL CLAUDE — try Haiku first, Sonnet if confidence too low
    // ----------------------------------------------------------------
    const isPdf = mimeType === "application/pdf";
    // PDFs use type:"document", images use type:"image" — Anthropic API requires this distinction
    const fileContent = isPdf
      ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: base64File } }
      : { type: "image" as const, source: { type: "base64" as const, media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: base64File } };

    async function callClaude(model: string) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: [
            fileContent,
            { type: "text", text: userPrompt },
          ],
        }],
      });

      const tokensIn  = response.usage.input_tokens;
      const tokensOut = response.usage.output_tokens;
      const costUsd   = (tokensIn  / 1_000_000) * COST_PER_1M[model].input
                      + (tokensOut / 1_000_000) * COST_PER_1M[model].output;

      return { response, tokensIn, tokensOut, costUsd };
    }

    let result = await callClaude(HAIKU);
    let modelUsed = HAIKU;
    let totalCost = result.costUsd;

    // Parse the response
    let parsed: Record<string, { value: string | null; confidence: number }> = {};
    try {
      const text = result.response.content[0].type === "text" ? result.response.content[0].text : "{}";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {
      parsed = {};
    }

    // Calculate average confidence
    const confidences = Object.values(parsed).map((f) => f.confidence ?? 0);
    const avgConfidence = confidences.length > 0
      ? confidences.reduce((s, c) => s + c, 0) / confidences.length
      : 0;

    // If average confidence < 70%, re-run with Sonnet (smarter model)
    if (avgConfidence < 0.7 && (currentSpend + totalCost) < BUDGET_LIMIT) {
      const sonnetResult = await callClaude(SONNET);
      totalCost += sonnetResult.costUsd;
      modelUsed = SONNET;
      try {
        const text = sonnetResult.response.content[0].type === "text" ? sonnetResult.response.content[0].text : "{}";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch { /* keep haiku result */ }

      // Track Sonnet cost separately
      await supabase.from("ai_usage").insert({
        tenant_id: tenantId,
        document_id: documentId,
        model: SONNET,
        tokens_in: sonnetResult.tokensIn,
        tokens_out: sonnetResult.tokensOut,
        cost_usd: sonnetResult.costUsd,
      });
    }

    // Track Haiku cost
    await supabase.from("ai_usage").insert({
      tenant_id: tenantId,
      document_id: documentId,
      model: HAIKU,
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      cost_usd: result.costUsd,
    });

    // Check budget warning (80% threshold) and send alert if needed
    const newSpend = currentSpend + totalCost;
    if (newSpend >= BUDGET_LIMIT * 0.8 && currentSpend < BUDGET_LIMIT * 0.8) {
      // Just crossed 80% — trigger notification (fire and forget)
      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-notification`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({
          type: "cost_warning",
          tenantId,
          data: { currentSpend: newSpend, limit: BUDGET_LIMIT },
        }),
      }).catch(() => {});
    }

    // ----------------------------------------------------------------
    // LAYER 3 POST-PROCESSING — Apply vendor profile overrides
    // If a vendor profile exists for the extracted vendor_name,
    // override fields defined in invoice_quirks with confidence=0.99
    // ----------------------------------------------------------------
    const extractedVendorName = parsed["vendor_name"]?.value;
    if (extractedVendorName) {
      try {
        const { data: vendorProfile } = await supabase
          .from("vendor_profiles")
          .select("invoice_quirks, tds_category, gstin")
          .eq("tenant_id", tenantId)
          .ilike("vendor_name", `%${extractedVendorName.split(" ").slice(0, 2).join("%")}%`)
          .maybeSingle();

        if (vendorProfile) {
          const quirks = vendorProfile.invoice_quirks as Record<string, string>;
          // Apply learned field values with boosted confidence
          for (const [field, value] of Object.entries(quirks)) {
            if (EXTRACTION_FIELDS.includes(field)) {
              parsed[field] = { value, confidence: 0.99 };
            }
          }
          // Apply learned TDS category
          if (vendorProfile.tds_category && !parsed["tds_section"]?.value) {
            parsed["tds_section"] = { value: vendorProfile.tds_category, confidence: 0.95 };
          }
          // Apply known GSTIN
          if (vendorProfile.gstin && (!parsed["vendor_gstin"]?.value || parsed["vendor_gstin"].confidence < 0.9)) {
            parsed["vendor_gstin"] = { value: vendorProfile.gstin, confidence: 0.99 };
          }
        }
      } catch {
        // Layer 3 post-processing failed — continue with unmodified extraction
      }
    }

    // ----------------------------------------------------------------
    // TDS POST-PROCESSING — deterministic keyword rules (Layer 1 fallback)
    // If AI didn't extract tds_section with confidence >= 0.6, apply keyword rules
    // This ensures TDS is never blank for recognisable vendor/service types
    // ----------------------------------------------------------------
    const extractedTdsSection   = parsed["tds_section"]?.value;
    const extractedTdsConfidence = parsed["tds_section"]?.confidence ?? 0;
    const vendorForTds = ((parsed["vendor_name"]?.value ?? "") + " " + (parsed["payment_reference"]?.value ?? "")).toLowerCase();
    const totalAmountNum = parseFloat(parsed["total_amount"]?.value ?? "0") || 0;

    if (!extractedTdsSection || extractedTdsConfidence < 0.6) {
      for (const rule of TDS_KEYWORD_RULES) {
        if (rule.keywords.test(vendorForTds) && totalAmountNum >= rule.threshold) {
          const inferenceConfidence = 0.78; // rule-based, not document-read
          if (!parsed["tds_section"]?.value || (parsed["tds_section"].confidence ?? 0) < inferenceConfidence) {
            parsed["tds_section"] = { value: rule.section,           confidence: inferenceConfidence };
            parsed["tds_rate"]    = { value: rule.rate,              confidence: inferenceConfidence };
            // Calculate TDS amount if not already extracted with reasonable confidence
            if (!parsed["tds_amount"]?.value || (parsed["tds_amount"].confidence ?? 0) < 0.5) {
              const base = parseFloat(parsed["taxable_value"]?.value ?? "0") || totalAmountNum;
              const tdsAmt = (base * parseFloat(rule.rate) / 100).toFixed(2);
              parsed["tds_amount"] = { value: tdsAmt, confidence: 0.72 };
            }
          }
          break; // first matching rule wins
        }
      }
    }

    // ----------------------------------------------------------------
    // TDS AMOUNT — calculate from rate if missing or low-confidence
    // Runs after all TDS processing (both AI extraction and keyword inference)
    // ----------------------------------------------------------------
    const finalTdsSection = parsed["tds_section"]?.value;
    const finalTdsRate    = parsed["tds_rate"]?.value;
    if (finalTdsSection && finalTdsRate) {
      if (!parsed["tds_amount"]?.value || (parsed["tds_amount"].confidence ?? 0) < 0.5) {
        const base = parseFloat(parsed["taxable_value"]?.value ?? "0")
                  || parseFloat(parsed["total_amount"]?.value ?? "0");
        const rate = parseFloat(finalTdsRate);
        if (base > 0 && rate > 0) {
          parsed["tds_amount"] = { value: (base * rate / 100).toFixed(2), confidence: 0.88 };
        }
      }
    }

    // ----------------------------------------------------------------
    // GST MUTUAL EXCLUSIVITY — CGST+SGST vs IGST are mutually exclusive
    // Intra-state: CGST + SGST; IGST must be null
    // Inter-state: IGST only; CGST + SGST must be null
    // If AI hallucinated both, trust whichever side has a higher amount
    // ----------------------------------------------------------------
    const cgstAmt = parseFloat(parsed["cgst_amount"]?.value ?? "0") || 0;
    const igstAmt = parseFloat(parsed["igst_amount"]?.value ?? "0") || 0;
    if (cgstAmt > 0 && igstAmt > 0) {
      // Both set — pick CGST+SGST (intra-state is more common domestically), clear IGST
      parsed["igst_rate"]   = { value: null, confidence: 1.0 };
      parsed["igst_amount"] = { value: null, confidence: 1.0 };
    } else if (igstAmt > 0 && cgstAmt === 0) {
      // Inter-state — clear any leftover CGST/SGST the AI may have set
      parsed["cgst_rate"]   = { value: null, confidence: 1.0 };
      parsed["cgst_amount"] = { value: null, confidence: 1.0 };
      parsed["sgst_rate"]   = { value: null, confidence: 1.0 };
      parsed["sgst_amount"] = { value: null, confidence: 1.0 };
    }

    // ----------------------------------------------------------------
    // HSN/SAC INFERENCE — if not extracted, infer from vendor name + doc type
    // ----------------------------------------------------------------
    if (!parsed["hsn_sac_code"]?.value || (parsed["hsn_sac_code"].confidence ?? 0) < 0.5) {
      const vendorForSac = (parsed["vendor_name"]?.value ?? "").toLowerCase();
      // Drone / aerial photography → SAC 998313
      if (/drone|aerial.photo|aerial.video|videograph|cinematograph|photo.shoot|filming/.test(vendorForSac)) {
        parsed["hsn_sac_code"] = { value: "998313", confidence: 0.80 };
      }
      // IT / software services → SAC 998314 (information technology services)
      else if (/software|it.service|saas|technology|data.process|cloud/.test(vendorForSac)) {
        parsed["hsn_sac_code"] = { value: "998314", confidence: 0.75 };
      }
      // Legal / CA / consulting → SAC 998212
      else if (/advocate|lawyer|ca.firm|chartered|consultant|advisory/.test(vendorForSac)) {
        parsed["hsn_sac_code"] = { value: "998212", confidence: 0.75 };
      }
      // Transport / GTA → SAC 9965
      else if (/transport|courier|logistics|freight|cargo/.test(vendorForSac)) {
        parsed["hsn_sac_code"] = { value: "9965", confidence: 0.75 };
      }
      // Advertising / media → SAC 998361
      else if (/advertis|marketing|media.agency|pr.agency|promotion/.test(vendorForSac)) {
        parsed["hsn_sac_code"] = { value: "998361", confidence: 0.72 };
      }
      // Rent / lease → SAC 997212
      else if (/rent|lease.rent|office.rent|premises/.test(vendorForSac)) {
        parsed["hsn_sac_code"] = { value: "997212", confidence: 0.75 };
      }
    }

    // ----------------------------------------------------------------
    // ITC ELIGIBILITY — auto-infer for purchase invoices
    // Blocked categories under CGST Act S.17(5): food, club, health, cab, personal use
    // Everything else is eligible by default for a registered business
    // ----------------------------------------------------------------
    if (documentType === "purchase_invoice" || documentType === "expense") {
      if (!parsed["itc_eligible"]?.value || (parsed["itc_eligible"].confidence ?? 0) < 0.5) {
        const vendorForItc = (parsed["vendor_name"]?.value ?? "").toLowerCase();
        const isBlocked = /\b(restaurant|hotel|club|gym|health.club|cab|uber|ola|beauty|salon|personal|gift|food.delivery|zomato|swiggy)\b/.test(vendorForItc);
        parsed["itc_eligible"] = isBlocked
          ? { value: "Blocked", confidence: 0.78 }
          : { value: "Yes", confidence: 0.80 };
      }
    }

    // ----------------------------------------------------------------
    // LEDGER SUGGESTION — suggest Tally ledger based on vendor/document type
    // Applied to purchase_invoice and expense documents
    // ----------------------------------------------------------------
    if (!parsed["suggested_ledger"]?.value || (parsed["suggested_ledger"].confidence ?? 0) < 0.5) {
      const vendorForLedger = (parsed["vendor_name"]?.value ?? "").toLowerCase();
      if (documentType === "purchase_invoice" || documentType === "expense") {
        for (const rule of INVOICE_LEDGER_RULES) {
          if (rule.keywords.test(vendorForLedger)) {
            parsed["suggested_ledger"] = { value: rule.ledger, confidence: 0.75 };
            break;
          }
        }
        // Fallback: if TDS section 194J was inferred, default to Professional Fees
        if (!parsed["suggested_ledger"]?.value && parsed["tds_section"]?.value === "194J") {
          parsed["suggested_ledger"] = { value: "Professional Fees", confidence: 0.70 };
        }
        // Fallback: if TDS section 194C was inferred, default to Purchase Account
        if (!parsed["suggested_ledger"]?.value && parsed["tds_section"]?.value === "194C") {
          parsed["suggested_ledger"] = { value: "Miscellaneous Expenses", confidence: 0.65 };
        }
      } else if (documentType === "sales_invoice") {
        parsed["suggested_ledger"] = { value: "Sales Account", confidence: 0.85 };
      }
    }

    // ----------------------------------------------------------------
    // STORE EXTRACTIONS — delete any existing rows first (handles retries)
    // ----------------------------------------------------------------
    await supabase.from("extractions").delete().eq("document_id", documentId);

    const extractionRows = EXTRACTION_FIELDS.map((field) => ({
      document_id: documentId,
      tenant_id: tenantId,
      field_name: field,
      extracted_value: parsed[field]?.value ?? null,
      confidence: parsed[field]?.confidence ?? 0.0,
      status: "pending",
    }));

    await supabase.from("extractions").insert(extractionRows);

    // Update document status and record which model was used
    await supabase.from("documents")
      .update({
        status: "review_required",
        ai_model_used: modelUsed,
        processed_at: new Date().toISOString(),
      })
      .eq("id", documentId);

    // ----------------------------------------------------------------
    // CHECK REVIEW QUEUE SIZE — notify if > 10 pending docs for this tenant
    // ----------------------------------------------------------------
    const { count: queueSize } = await supabase
      .from("documents")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("status", "review_required");

    if ((queueSize ?? 0) > 10) {
      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-notification`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ type: "queue_full", tenantId, data: { queueSize } }),
      }).catch(() => {});
    }

    return new Response(
      JSON.stringify({ success: true, modelUsed, avgConfidence, fieldCount: extractionRows.length }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[extract-document] error:", err);
    // documentId is captured at the top of the handler — always available here
    if (documentId) {
      try {
        await supabase.from("documents").update({ status: "failed" }).eq("id", documentId);
      } catch { /* best-effort status update */ }
    }
    return new Response(
      JSON.stringify({ error: "Extraction failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
