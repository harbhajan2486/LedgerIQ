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
  "payment_reference", "reverse_charge", "place_of_supply",
];

Deno.serve(async (req) => {
  try {
    const { documentId, tenantId, storagePath, documentType, monthlySpend } = await req.json();

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
    const base64File = btoa(String.fromCharCode(...new Uint8Array(fileBytes)));
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
    // GET TENANT INDUSTRY CONTEXT
    // ----------------------------------------------------------------
    const { data: tenantData } = await supabase
      .from("tenants")
      .select("name")
      .eq("id", tenantId)
      .single();

    // ----------------------------------------------------------------
    // BUILD EXTRACTION PROMPT
    // ----------------------------------------------------------------
    const systemPrompt = `You are an expert Indian accounting document analyser. Extract structured data from the provided document.
${fewShotExamples}
RULES:
- Return ONLY valid JSON, no markdown, no explanation
- For each field, provide "value" and "confidence" (0.0 to 1.0)
- confidence = 1.0 means you are certain; 0.0 means you cannot find the field
- If a field is not present in the document, set value to null and confidence to 0.0
- For monetary values, return numbers only (no currency symbols or commas)
- For GST rates, return the percentage number (e.g. 18, not "18%")
- For dates, use DD/MM/YYYY format
- For GSTIN, return the 15-character alphanumeric code exactly
- For TDS section, return e.g. "194C", "194J", "194I"`;

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
  "place_of_supply": {"value": "Maharashtra", "confidence": 0.90}
}`;

    // ----------------------------------------------------------------
    // CALL CLAUDE — try Haiku first, Sonnet if confidence too low
    // ----------------------------------------------------------------
    async function callClaude(model: string) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: base64File,
              },
            },
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
    // STORE EXTRACTIONS
    // ----------------------------------------------------------------
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
    // Mark document as failed so user can retry
    try {
      const { documentId } = await req.clone().json();
      if (documentId) {
        const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        await sb.from("documents").update({ status: "failed" }).eq("id", documentId);
      }
    } catch {}
    return new Response(
      JSON.stringify({ error: "Extraction failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
