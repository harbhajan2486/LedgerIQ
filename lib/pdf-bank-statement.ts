// Shared PDF bank statement extractor using Claude Haiku vision.
// Returns StatementRow[] (YYYY-MM-DD dates) compatible with bank-book-matcher.

import Anthropic from "@anthropic-ai/sdk";
import type { StatementRow } from "./bank-statement-parser";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

/** Convert DD/MM/YYYY or DD-MM-YYYY to YYYY-MM-DD. Returns null if unparseable. */
function normaliseDateToIso(raw: string): string | null {
  const s = raw.trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD/MM/YYYY or DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  // DD/MM/YY
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
}

export async function extractStatementFromPdf(fileBytes: ArrayBuffer): Promise<PdfExtractResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }

  const uint8 = new Uint8Array(fileBytes);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < uint8.length; i += CHUNK) {
    binary += String.fromCharCode(...uint8.subarray(i, i + CHUNK));
  }
  const base64 = btoa(binary);

  const allRows: StatementRow[] = [];
  let afterCursor: { date: string; narration: string } | null = null;
  let totalIn = 0;
  let totalOut = 0;

  for (let pass = 0; pass < 4; pass++) {
    const promptText = pass === 0
      ? TSV_PROMPT
      : `${TSV_PROMPT}

IMPORTANT: Only extract transactions that appear AFTER this transaction in the statement:
Date: ${afterCursor!.date}
Narration starts with: ${afterCursor!.narration.slice(0, 60)}

Skip all transactions up to and including that one. Continue from the next transaction onwards.`;

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: promptText },
        ],
      }],
    });

    totalIn += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const batch = parseTsvLines(text);

    if (batch.length === 0) break;
    allRows.push(...batch);

    if (response.stop_reason !== "max_tokens") break;

    const last = batch[batch.length - 1];
    afterCursor = { date: last.date, narration: last.narration };
  }

  return { rows: allRows, tokensIn: totalIn, tokensOut: totalOut };
}
