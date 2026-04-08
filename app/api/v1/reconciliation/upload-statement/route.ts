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
  const base64 = Buffer.from(fileBytes).toString("base64");

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
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
  return JSON.parse(match[0]) as ParsedTransaction[];
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
    return NextResponse.json(
      { error: "Could not read the file. For PDFs, ensure it is a text-based PDF (not a scanned image)." },
      { status: 400 }
    );
  }

  if (transactions.length === 0) {
    return NextResponse.json({ error: "No transactions found in file. Check the file has transaction rows." }, { status: 400 });
  }

  const rows = transactions.map((txn) => ({
    tenant_id: tenantId,
    bank_name: bankName,
    transaction_date: txn.date,
    narration: txn.narration,
    ref_number: txn.ref_number,
    debit_amount: txn.debit,
    credit_amount: txn.credit,
    balance: txn.balance,
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
