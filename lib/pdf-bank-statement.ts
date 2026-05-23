// Shared PDF bank statement extractor using Claude Haiku vision.
// Returns StatementRow[] (YYYY-MM-DD dates) compatible with bank-book-matcher.
//
// Strategy: split the PDF into 25-page chunks with pdf-lib, then send each
// chunk once. A 360-page PDF at ~300 tokens/page = ~108k tokens total if sent
// whole — already over the 50k tokens/min rate limit in a single call. With
// 25-page chunks (~7.5k tokens each) we stay well under the limit and never
// need cursor-based multi-pass.

import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import type { StatementRow } from "./bank-statement-parser";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function callWithRetry(fn: () => Promise<Anthropic.Message>): Promise<Anthropic.Message> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        const retryAfterHeader = err.headers?.get?.("retry-after") ?? (err.headers as unknown as Record<string, string>)?.["retry-after"];
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

/** Convert DD/MM/YYYY or DD-MM-YYYY to YYYY-MM-DD. Returns null if unparseable. */
function normaliseDateToIso(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const m2 = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})$/);
  if (m2) {
    const yr = parseInt(m2[3], 10);
    return `${yr >= 0 && yr <= 30 ? 2000 + yr : 1900 + yr}-${m2[2].padStart(2, "0")}-${m2[1].padStart(2, "0")}`;
  }
  return null;
}

function parseTsvLines(text: string): StatementRow[] {
  const lines = text.trim().split("\n").filter((l) => l.trim());
  const rows: StatementRow[] = [];
  const dataLines = lines[0]?.toLowerCase().startsWith("date") ? lines.slice(1) : lines;

  for (const line of dataLines) {
    const parts = line.split("\t").map((p) => p.trim());
    if (parts.length < 4) continue;
    const [rawDate, narration, , debitStr, creditStr] = parts;
    if (!rawDate || !/\d/.test(rawDate)) continue;
    if (!narration) continue;

    const date = normaliseDateToIso(rawDate);
    if (!date) continue;

    let debit = debitStr ? parseFloat(debitStr.replace(/[₹,\s]/g, "")) || null : null;
    let credit = creditStr ? parseFloat(creditStr.replace(/[₹,\s]/g, "")) || null : null;
    if (debit !== null && debit < 0) { credit = Math.abs(debit); debit = null; }
    if (credit !== null && credit < 0) { debit = Math.abs(credit); credit = null; }
    if (debit === null && credit === null) continue;

    rows.push({ date, narration, debit, credit });
  }
  return rows;
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

export interface PdfExtractResult {
  rows: StatementRow[];
  tokensIn: number;
  tokensOut: number;
  chunks: number;
}

export async function extractStatementFromPdf(fileBytes: ArrayBuffer): Promise<PdfExtractResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }

  const uint8 = new Uint8Array(fileBytes);

  // Split into 25-page chunks. Each chunk ≈ 7,500 input tokens — well under
  // the 50k/min org rate limit regardless of how many chunks there are.
  const chunks = await splitPdfIntoChunks(uint8, 25);

  const allRows: StatementRow[] = [];
  let totalIn = 0;
  let totalOut = 0;

  for (let i = 0; i < chunks.length; i++) {
    // Small delay between chunks so burst usage doesn't spike the per-minute counter.
    if (i > 0) await sleep(2000);

    const base64 = toBase64(chunks[i]);
    const response = await callWithRetry(() => client.messages.create({
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

    totalIn += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    allRows.push(...parseTsvLines(text));
  }

  return { rows: allRows, tokensIn: totalIn, tokensOut: totalOut, chunks: chunks.length };
}
