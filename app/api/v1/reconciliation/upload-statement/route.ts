import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseCSV, parseXLSX } from "@/lib/bank-statement-parser";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

interface ParsedTransaction {
  date: string;
  narration: string;
  ref_number: string | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
}

async function parsePDFStatement(fileBytes: ArrayBuffer): Promise<ParsedTransaction[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in Vercel environment variables.");
  }
  const base64 = Buffer.from(fileBytes).toString("base64");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 },
        },
        {
          type: "text",
          text: `Extract all bank transactions from this bank statement.

Return ONLY a JSON array, no markdown, no explanation. Each item must have:
- "date": transaction date in DD/MM/YYYY format
- "narration": full transaction description/narration
- "ref_number": UTR, cheque number, or reference number (null if not present)
- "debit": amount debited as a number (null if not a debit)
- "credit": amount credited as a number (null if not a credit)
- "balance": running balance as a number (null if not shown)

Example:
[
  {"date":"01/04/2025","narration":"NEFT CR-HDFC0001234-TATA STEEL LTD","ref_number":"N2025040112345","debit":null,"credit":495600,"balance":1234567.89},
  {"date":"02/04/2025","narration":"IMPS-987654321-VENDOR PAYMENT","ref_number":"987654321","debit":50000,"credit":null,"balance":1184567.89}
]

Return only the JSON array.`,
        },
      ],
    }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "[]";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("No JSON array found in AI response");

  let jsonStr = match[0];
  // If truncated (response hit token limit), close the array cleanly
  if (response.stop_reason === "max_tokens") {
    // Find last complete object by trimming to last closing brace
    const lastClose = jsonStr.lastIndexOf("}");
    if (lastClose !== -1) {
      jsonStr = jsonStr.slice(0, lastClose + 1) + "]";
    }
  }

  return JSON.parse(jsonStr) as ParsedTransaction[];
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", user.id)
    .single();

  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });
  const tenantId = profile.tenant_id;

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const bankName = (formData.get("bank_name") as string) || "Unknown Bank";

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  const fileName = file.name.toLowerCase();
  const fileSize = file.size;

  if (fileSize > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 20MB)" }, { status: 400 });
  }

  let transactions: ParsedTransaction[];
  try {
    if (fileName.endsWith(".csv")) {
      const text = await file.text();
      transactions = parseCSV(text);
    } else if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
      const buffer = await file.arrayBuffer();
      transactions = parseXLSX(buffer);
    } else if (fileName.endsWith(".pdf")) {
      const buffer = await file.arrayBuffer();
      transactions = await parsePDFStatement(buffer);
    } else {
      return NextResponse.json(
        { error: "Unsupported format. Upload CSV, Excel, or PDF bank statement." },
        { status: 400 }
      );
    }
  } catch (err) {
    console.error("[upload-statement] parse error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("API key") || msg.includes("auth") || msg.includes("401")) {
      return NextResponse.json({ error: "AI service not configured. Add ANTHROPIC_API_KEY to Vercel environment variables." }, { status: 503 });
    }
    return NextResponse.json(
      { error: `Could not read the file: ${msg}` },
      { status: 400 }
    );
  }

  if (transactions.length === 0) {
    return NextResponse.json({ error: "No transactions found in file. Check the file has transaction rows." }, { status: 400 });
  }

  // Normalise any date format → YYYY-MM-DD for PostgreSQL
  const MONTHS: Record<string, string> = {
    jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
    jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",
  };
  function toISODate(d: string): string {
    if (!d) return d;
    const s = d.trim();
    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
    if (/^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}$/.test(s)) {
      const [dd, mm, yyyy] = s.split(/[\/\-\.]/);
      return `${yyyy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}`;
    }
    // YYYY/MM/DD or YYYY.MM.DD
    if (/^\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}$/.test(s)) {
      const [yyyy, mm, dd] = s.split(/[\/\-\.]/);
      return `${yyyy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}`;
    }
    // DD-Mon-YYYY or DD/Mon/YYYY (e.g. 13-Apr-2024, 13 Apr 2024)
    const monMatch = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3})[\s\-\/](\d{4})$/);
    if (monMatch) {
      const mm = MONTHS[monMatch[2].toLowerCase()];
      if (mm) return `${monMatch[3]}-${mm}-${monMatch[1].padStart(2,"0")}`;
    }
    // DD Month YYYY (e.g. 13 April 2024)
    const longMonMatch = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (longMonMatch) {
      const mm = MONTHS[longMonMatch[2].slice(0,3).toLowerCase()];
      if (mm) return `${longMonMatch[3]}-${mm}-${longMonMatch[1].padStart(2,"0")}`;
    }
    // Fallback — return as-is and let DB error surface
    return s;
  }

  const rows = transactions.map((txn) => ({
    tenant_id: tenantId,
    bank_name: bankName,
    transaction_date: toISODate(txn.date),
    narration: txn.narration,
    ref_number: txn.ref_number,
    debit_amount: txn.debit,
    credit_amount: txn.credit,
    balance: txn.balance,
    amount: txn.debit ?? txn.credit ?? 0,
    type: txn.debit ? "debit" : "credit",
    status: "unmatched",
  }));

  const { data: inserted, error: insertError } = await supabase
    .from("bank_transactions")
    .insert(rows)
    .select("id");

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  await supabase.from("audit_log").insert({
    tenant_id: tenantId,
    user_id: user.id,
    action: "upload_bank_statement",
    entity_type: "bank_transactions",
    entity_id: tenantId,
    new_value: { file_name: file.name, bank_name: bankName, transaction_count: transactions.length },
  });

  const transactionIds = (inserted ?? []).map((r) => r.id);
  fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/v1/reconciliation/auto-match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, transactionIds }),
  }).catch(() => {});

  return NextResponse.json({ success: true, count: transactions.length });
}
