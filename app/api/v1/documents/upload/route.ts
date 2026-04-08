import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { log } from "@/lib/logger";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// Allowed MIME types
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/octet-stream", // some systems send this for CSV
]);

export async function POST(request: NextRequest) {
  try {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const rl = await checkRateLimit(user.id);
  if (!rl.allowed) return rateLimitResponse(rl.resetAt);

  const { data: profile } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", user.id)
    .single();

  if (!profile?.tenant_id) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 400 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File;
  const documentType = formData.get("documentType") as string;
  const clientId = formData.get("clientId") as string | null;

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!documentType) return NextResponse.json({ error: "Document type is required" }, { status: 400 });

  // Validate file size
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "File is too large. Maximum size is 50MB." },
      { status: 400 }
    );
  }

  // Validate MIME type
  if (!ALLOWED_MIMES.has(file.type)) {
    return NextResponse.json(
      { error: "Unsupported file type. Please upload PDF, JPG, PNG, Excel, or CSV." },
      { status: 400 }
    );
  }

  // Check AI cost guard — don't accept new docs if over monthly limit
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { data: usageData } = await supabase
    .from("ai_usage")
    .select("cost_usd")
    .gte("created_at", monthStart);

  const monthlySpend = (usageData ?? []).reduce((sum, row) => sum + Number(row.cost_usd), 0);
  const budgetLimit = Number(process.env.AI_MONTHLY_BUDGET_USD ?? 50);

  const bytes = await file.arrayBuffer();

  // Compute SHA-256 hash for duplicate detection
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const fileHash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");

  // Reject if this exact file has already been uploaded by this tenant
  const { data: existing } = await supabase
    .from("documents")
    .select("id, original_filename, status")
    .eq("tenant_id", profile.tenant_id)
    .eq("file_hash", fileHash)
    .maybeSingle();

  if (existing) {
    const statusMsg = existing.status === "review_required" ? "is waiting in your review queue" : `has status: ${existing.status}`;
    return NextResponse.json(
      { error: `This file was already uploaded as "${existing.original_filename}" and ${statusMsg}.` },
      { status: 409 }
    );
  }

  // Store the file in Supabase Storage
  const fileExt = file.name.split(".").pop() ?? "bin";
  const fileId = crypto.randomUUID();
  const storagePath = `${profile.tenant_id}/invoices/${fileId}.${fileExt}`;
  const { error: storageError } = await supabase.storage
    .from("documents")
    .upload(storagePath, bytes, {
      contentType: file.type,
      upsert: false,
    });

  if (storageError) {
    return NextResponse.json({ error: "Failed to upload file: " + storageError.message }, { status: 500 });
  }

  // Create the document record
  // If over budget, set status to 'queued' — it will process when budget resets
  const status = monthlySpend >= budgetLimit ? "queued" : "queued";

  const { data: doc, error: docError } = await supabase
    .from("documents")
    .insert({
      tenant_id: profile.tenant_id,
      client_id: clientId || null,
      document_type: documentType,
      storage_path: storagePath,
      original_filename: file.name,
      file_hash: fileHash,
      file_size_bytes: file.size,
      mime_type: file.type,
      status,
      uploaded_by: user.id,
    })
    .select("id")
    .single();

  if (docError) {
    return NextResponse.json({ error: docError.message }, { status: 500 });
  }

  // Write audit log
  await supabase.from("audit_log").insert({
    tenant_id: profile.tenant_id,
    user_id: user.id,
    action: "upload_document",
    entity_type: "document",
    entity_id: doc.id,
    new_value: { file_name: file.name, type: documentType, size_bytes: file.size },
  });

  // Trigger extraction Edge Function asynchronously (fire and forget)
  // Only if under budget — otherwise document stays as 'queued'
  if (monthlySpend < budgetLimit) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    if (serviceKey) {
      // Look up client industry for Layer 1/3 injection in extraction prompt
      let clientIndustry: string | null = null;
      if (clientId) {
        const { data: clientData } = await supabase
          .from("clients")
          .select("industry_name")
          .eq("id", clientId)
          .eq("tenant_id", profile.tenant_id)
          .single();
        clientIndustry = clientData?.industry_name ?? null;
      }

      // Retry up to 3 times with exponential backoff if the Edge Function call fails
      const triggerPayload = JSON.stringify({
        documentId: doc.id,
        tenantId: profile.tenant_id,
        storagePath,
        documentType,
        monthlySpend,
        budgetLimit,
        clientId: clientId || null,
        clientIndustry,
      });

      (async () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const res = await fetch(`${supabaseUrl}/functions/v1/extract-document`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
              body: triggerPayload,
            });
            if (res.ok) break;
            throw new Error(`HTTP ${res.status}`);
          } catch (err) {
            if (attempt === 3) {
              console.error(`[upload] Extraction trigger failed after 3 attempts for doc ${doc.id}:`, err);
              // Mark document as failed so the user sees the error instead of infinite "processing"
              try {
                await supabase.from("documents").update({ status: "failed" }).eq("id", doc.id);
              } catch { /* best-effort */ }
            } else {
              await new Promise((r) => setTimeout(r, attempt * 1000));
            }
          }
        }
      })();
    }
  }

  log.info("document_uploaded", { userId: user.id, tenantId: profile.tenant_id, documentId: doc.id, fileName: file.name, queued: monthlySpend >= budgetLimit });

  return NextResponse.json({
    success: true,
    documentId: doc.id,
    budgetWarning: monthlySpend >= budgetLimit * 0.8
      ? `AI spend is at $${monthlySpend.toFixed(2)} of $${budgetLimit} monthly limit.`
      : null,
    queued: monthlySpend >= budgetLimit,
  });
  } catch (err) {
    log.error("document_upload_failed", { error: String(err) });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
