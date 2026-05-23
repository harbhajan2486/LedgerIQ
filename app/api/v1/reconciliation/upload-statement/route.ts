import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseCSV, parseXLSX } from "@/lib/bank-statement-parser";
import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import { suggestLedger, extractPattern, ledgerToMeta } from "@/lib/ledger-rules";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function callWithRetry(fn: () => Promise<Anthropic.Message>): Promise<Anthropic.Message> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        const headers = err.headers as unknown as Record<string, string> | undefined;
        const retryAfterHeader = headers?.["retry-after"];
        const waitSec = retryAfterHeader ? Math.ceil(parseFloat(retryAfterHeader)) : 15 * (attempt + 1);
        await sleep(waitSec * 1000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Rate limit exceeded after retries — try again in a minute.");
}

async function splitPdfIntoChunks(bytes: Uint8Array, pagesPerChunk: number): Promise<Uint8Array[]> {
  const pdf = await PDFDocument.load(bytes);
  const totalPages = pdf.getPageCount();
  const chunks: Uint8Array[] = [];

  for (let start = 0; start < totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, totalPages);
    const chunk = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    const copied = await chunk.copyPages(pdf, indices);
    copied.forEach((p: import("pdf-lib").PDFPage) => chunk.addPage(p));
    chunks.push(await chunk.save());
  }

  return chunks;
}

function toBase64(uint8: Uint8Array): string {
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < uint8.length; i += CHUNK) {
    binary += String.fromCharCode(...uint8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

interface ParsedTransaction {
  date: string;
  narration: string;
  ref_number: string | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
}

function parseTsvLines(text: string): ParsedTransaction[] {
  const lines = text.trim().split("\n").filter((l) => l.trim());
  const transactions: ParsedTransaction[] = [];
  const dataLines = lines[0]?.toLowerCase().startsWith("date") ? lines.slice(1) : lines;

  for (const line of dataLines) {
    const parts = line.split("\t").map((p) => p.trim());
    if (parts.length < 5) continue;
    const [date, narration, ref_number, debitStr, creditStr, balanceStr] = parts;
    if (!date || !/\d/.test(date)) continue;
    if (!narration) continue;
    let debitNum = debitStr ? parseFloat(debitStr.replace(/[₹,\s]/g, "")) || null : null;
    let creditNum = creditStr ? parseFloat(creditStr.replace(/[₹,\s]/g, "")) || null : null;
    const balanceNum = balanceStr ? parseFloat(balanceStr.replace(/[₹,\s]/g, "")) || null : null;
    if (debitNum !== null && debitNum < 0) { creditNum = Math.abs(debitNum); debitNum = null; }
    if (creditNum !== null && creditNum < 0) { debitNum = Math.abs(creditNum); creditNum = null; }
    transactions.push({ date, narration, ref_number: ref_number || null, debit: debitNum, credit: creditNum, balance: balanceNum });
  }
  return transactions;
}

const TSV_PROMPT = `Extract bank transactions from this statement. Return ONLY tab-separated values (TSV), no markdown, no explanation, no code block.

Exact header line: date\tnarration\tref_number\tdebit\tcredit\tbalance
Rules:
- date: DD/MM/YYYY
- narration: full text exactly as printed, keep any commas as-is
- ref_number: UTR/cheque/ref number or leave empty
- debit: withdrawal amount as positive number or empty
- credit: deposit amount as positive number or empty
- balance: closing balance as number or empty
- Skip opening balance and closing balance summary rows
- Separate every field with a TAB character, not a comma`;

// Extract a single pre-split PDF chunk — one Claude call, no further splitting.
async function extractChunkDirect(fileBytes: ArrayBuffer): Promise<{ transactions: ParsedTransaction[]; tokensIn: number; tokensOut: number }> {
  const base64 = toBase64(new Uint8Array(fileBytes));
  const response = await callWithRetry(() => anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8192,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
        { type: "text", text: TSV_PROMPT },
      ],
    }],
  }));
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return { transactions: parseTsvLines(text), tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens };
}

// Full-file PDF extraction (server-side splitting for backwards compat with direct uploads).
async function parsePDFStatement(fileBytes: ArrayBuffer): Promise<{ transactions: ParsedTransaction[]; tokensIn: number; tokensOut: number; rawSample: string; chunks: number }> {
  const uint8 = new Uint8Array(fileBytes);
  const chunks = await splitPdfIntoChunks(uint8, 25);

  const allTransactions: ParsedTransaction[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let rawSample = "";

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(2000);
    const result = await extractChunkDirect(chunks[i].buffer as ArrayBuffer);
    totalTokensIn += result.tokensIn;
    totalTokensOut += result.tokensOut;
    if (i === 0) {
      const text = result.transactions.slice(0, 3).map(t => `${t.date}\t${t.narration}\t${t.debit ?? ""}\t${t.credit ?? ""}`).join("\n");
      rawSample = text;
    }
    allTransactions.push(...result.transactions);
  }

  return { transactions: allTransactions, tokensIn: totalTokensIn, tokensOut: totalTokensOut, rawSample, chunks: chunks.length };
}

// ── Save helper — shared by regular upload and save_rows mode ─────────────────

const MONTHS: Record<string, string> = {
  jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
  jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",
};

function toISODate(d: string): string {
  if (!d) return d;
  const s = d.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}$/.test(s)) {
    const [dd, mm, yyyy] = s.split(/[\/\-\.]/);
    return `${yyyy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}`;
  }
  if (/^\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}$/.test(s)) {
    const [yyyy, mm, dd] = s.split(/[\/\-\.]/);
    return `${yyyy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}`;
  }
  const monMatch = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3})[\s\-\/](\d{4})$/);
  if (monMatch) {
    const mm = MONTHS[monMatch[2].toLowerCase()];
    if (mm) return `${monMatch[3]}-${mm}-${monMatch[1].padStart(2,"0")}`;
  }
  const longMonMatch = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (longMonMatch) {
    const mm = MONTHS[longMonMatch[2].slice(0,3).toLowerCase()];
    if (mm) return `${longMonMatch[3]}-${mm}-${longMonMatch[1].padStart(2,"0")}`;
  }
  return s;
}

function categoryFromLedger(ledgerName: string | null, narration: string, isDebit: boolean): { category: string; voucher_type: string } {
  if (ledgerName) {
    const meta = ledgerToMeta(ledgerName);
    if (meta) return meta;
  }
  const n = narration.toUpperCase();
  if (/\bSELF TRANSFER\b|\bFD TRANSFER\b|\bSWEEP\b|\bOD ACCOUNT\b|\bOWN ACCOUNT\b/.test(n))
    return { category: "Inter-bank Transfer", voucher_type: "Contra" };
  if (!isDebit) return { category: "Customer Receipt", voucher_type: "Receipt" };
  return { category: "Vendor Payment", voucher_type: "Payment" };
}

async function saveTransactionsToDb(
  transactions: ParsedTransaction[],
  bankName: string,
  clientId: string | null,
  tenantId: string,
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  fileName: string,
): Promise<NextResponse> {
  if (transactions.length === 0) {
    return NextResponse.json({ error: "No transactions found." }, { status: 400 });
  }

  // Pre-load confirmed client-specific and industry rules
  const clientRules: Map<string, string> = new Map();
  const industryRules: Map<string, string> = new Map();
  if (clientId) {
    const { data: rules } = await supabase
      .from("ledger_mapping_rules")
      .select("pattern, ledger_name")
      .eq("tenant_id", tenantId)
      .eq("client_id", clientId)
      .eq("confirmed", true);
    for (const r of rules ?? []) clientRules.set(r.pattern, r.ledger_name);

    const { data: clientRow } = await supabase
      .from("clients")
      .select("industry_name")
      .eq("id", clientId)
      .single();
    const industryName = clientRow?.industry_name ?? null;
    if (industryName) {
      const { data: iRules } = await supabase
        .from("ledger_mapping_rules")
        .select("pattern, ledger_name")
        .eq("tenant_id", tenantId)
        .eq("industry_name", industryName)
        .is("client_id", null)
        .eq("confirmed", true);
      for (const r of iRules ?? []) industryRules.set(r.pattern, r.ledger_name);
    }
  }

  const rowsToInsert: Record<string, unknown>[] = [];
  const allHashes: string[] = [];
  let minDate = "9999-12-31", maxDate = "0000-01-01";

  for (const txn of transactions) {
    const isoDate = toISODate(txn.date);
    const isDebit = !!txn.debit;
    const pattern = extractPattern(txn.narration ?? "");
    const ledger_name = clientRules.get(pattern) ?? industryRules.get(pattern) ?? suggestLedger(txn.narration ?? "") ?? null;
    const { category, voucher_type } = categoryFromLedger(ledger_name, txn.narration ?? "", isDebit);

    const hashStr = `${bankName}|${isoDate}|${(txn.narration ?? "").toLowerCase().trim()}|${txn.debit ?? ""}|${txn.credit ?? ""}|${txn.balance ?? ""}`;
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashStr));
    const txnHash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    allHashes.push(txnHash);

    if (isoDate < minDate) minDate = isoDate;
    if (isoDate > maxDate) maxDate = isoDate;

    rowsToInsert.push({
      tenant_id: tenantId,
      bank_name: bankName,
      transaction_date: isoDate,
      narration: txn.narration,
      ref_number: txn.ref_number,
      debit_amount: txn.debit,
      credit_amount: txn.credit,
      balance: txn.balance,
      amount: txn.debit ?? txn.credit ?? 0,
      type: isDebit ? "debit" : "credit",
      status: "unmatched",
      category,
      voucher_type,
      ledger_name,
      txn_hash: txnHash,
      ...(clientId ? { client_id: clientId } : {}),
    });
  }

  let alreadyPresent = 0;

  if (minDate !== "9999-12-31" && clientId) {
    const { data: existingTxns } = await supabase
      .from("bank_transactions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("client_id", clientId)
      .eq("bank_name", bankName)
      .gte("transaction_date", minDate)
      .lte("transaction_date", maxDate);

    const existingIds = (existingTxns ?? []).map((t: { id: string }) => t.id);
    alreadyPresent = existingIds.length;

    if (existingIds.length > 0) {
      for (let i = 0; i < existingIds.length; i += 100) {
        await supabase.from("reconciliations").delete()
          .eq("tenant_id", tenantId)
          .in("bank_transaction_id", existingIds.slice(i, i + 100));
      }
      await supabase.from("bank_transactions").delete()
        .eq("tenant_id", tenantId)
        .eq("client_id", clientId)
        .eq("bank_name", bankName)
        .gte("transaction_date", minDate)
        .lte("transaction_date", maxDate);
    }
  } else if (minDate !== "9999-12-31") {
    const existingHashSet = new Set<string>();
    for (let i = 0; i < allHashes.length; i += 100) {
      const batch = allHashes.slice(i, i + 100);
      const { data } = await supabase.from("bank_transactions")
        .select("txn_hash").eq("tenant_id", tenantId).in("txn_hash", batch);
      for (const r of data ?? []) existingHashSet.add(r.txn_hash);
    }
    alreadyPresent = existingHashSet.size;
    rowsToInsert.splice(0, rowsToInsert.length,
      ...rowsToInsert.filter((r) => !existingHashSet.has(r.txn_hash as string))
    );
  }

  if (rowsToInsert.length === 0) {
    return NextResponse.json({
      success: true, count: 0, already_present: alreadyPresent,
      total_in_file: transactions.length,
      message: `All ${transactions.length} transactions already present — no duplicates added.`,
    });
  }

  const { data: inserted, error: insertError } = await supabase
    .from("bank_transactions")
    .insert(rowsToInsert)
    .select("id");

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  const newlyAdded = (inserted ?? []).length;
  const total = transactions.length;

  await supabase.from("audit_log").insert({
    tenant_id: tenantId,
    user_id: userId,
    action: "upload_bank_statement",
    entity_type: "bank_transactions",
    entity_id: tenantId,
    new_value: { file_name: fileName, bank_name: bankName, total, newly_added: newlyAdded, already_present: alreadyPresent },
  });

  const transactionIds = (inserted ?? []).map((r: { id: string }) => r.id);
  if (transactionIds.length > 0) {
    fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/v1/reconciliation/auto-match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, transactionIds }),
    }).catch(() => {});
  }

  const message = alreadyPresent > 0
    ? `${newlyAdded} transactions imported (replaced ${alreadyPresent} previous rows for this period).`
    : `${newlyAdded} transactions imported successfully.`;

  return NextResponse.json({ success: true, count: newlyAdded, already_present: alreadyPresent, total_in_file: total, message });
}

// ── Route ─────────────────────────────────────────────────────────────────────

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });
  const tenantId = profile.tenant_id;

  const formData = await request.formData();
  const mode = (formData.get("mode") as string | null) ?? "";

  // ── Mode: extract_chunk ───────────────────────────────────────────────────
  // Client sends one pre-split 25-page PDF blob. Server calls Claude once and
  // returns extracted transactions. No saving — client accumulates all chunks,
  // then calls save_rows at the end.
  if (mode === "extract_chunk") {
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });
    try {
      const buffer = await file.arrayBuffer();
      const result = await extractChunkDirect(buffer);
      const costUsd = (result.tokensIn / 1_000_000) * 0.80 + (result.tokensOut / 1_000_000) * 4.00;
      supabase.from("ai_usage").insert({ tenant_id: tenantId, model: "claude-haiku-4-5-20251001", tokens_in: result.tokensIn, tokens_out: result.tokensOut, cost_usd: costUsd }).then();
      return NextResponse.json({ transactions: result.transactions, tokens_in: result.tokensIn, tokens_out: result.tokensOut });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: msg }, { status: 422 });
    }
  }

  // ── Mode: save_rows ───────────────────────────────────────────────────────
  // Client has finished extracting all chunks and sends the full accumulated
  // transactions array. Server runs dedup + save + auto-match.
  if (mode === "save_rows") {
    const rowsJson = formData.get("rows_json") as string | null;
    const bankName = (formData.get("bank_name") as string) || "Unknown Bank";
    const clientId = (formData.get("client_id") as string) || null;
    const fileName = (formData.get("file_name") as string) || "statement.pdf";

    let transactions: ParsedTransaction[];
    try { transactions = JSON.parse(rowsJson ?? "[]"); }
    catch { return NextResponse.json({ error: "Invalid rows_json" }, { status: 400 }); }

    return saveTransactionsToDb(transactions, bankName, clientId, tenantId, user.id, supabase, fileName);
  }

  // ── Regular upload: CSV / XLSX / PDF (full-file, server-side splitting) ───
  const file = formData.get("file") as File | null;
  const bankName = (formData.get("bank_name") as string) || "Unknown Bank";
  const clientId = (formData.get("client_id") as string) || null;

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "File too large (max 20MB)" }, { status: 400 });

  const fileName = file.name.toLowerCase();
  let transactions: ParsedTransaction[];
  try {
    if (fileName.endsWith(".csv")) {
      transactions = parseCSV(await file.text()) as ParsedTransaction[];
    } else if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
      transactions = parseXLSX(await file.arrayBuffer()) as ParsedTransaction[];
    } else if (fileName.endsWith(".pdf")) {
      const pdfResult = await parsePDFStatement(await file.arrayBuffer());
      transactions = pdfResult.transactions;
      const costUsd = (pdfResult.tokensIn / 1_000_000) * 0.80 + (pdfResult.tokensOut / 1_000_000) * 4.00;
      supabase.from("ai_usage").insert({ tenant_id: tenantId, model: "claude-haiku-4-5-20251001", tokens_in: pdfResult.tokensIn, tokens_out: pdfResult.tokensOut, cost_usd: costUsd }).then();
    } else {
      return NextResponse.json({ error: "Unsupported format. Upload CSV, Excel, or PDF bank statement." }, { status: 400 });
    }
  } catch (err) {
    console.error("[upload-statement] parse error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("API key") || msg.includes("auth") || msg.includes("401")) {
      return NextResponse.json({ error: "AI service not configured. Add ANTHROPIC_API_KEY to Vercel environment variables." }, { status: 503 });
    }
    return NextResponse.json({ error: `Could not read the file: ${msg}` }, { status: 400 });
  }

  return saveTransactionsToDb(transactions, bankName, clientId, tenantId, user.id, supabase, file.name);
}
