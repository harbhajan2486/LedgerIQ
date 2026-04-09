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
          text: `Extract ALL bank transactions from this statement. Return ONLY a CSV with no extra text.

Header row (exactly):
date,narration,ref_number,debit,credit,balance

Rules:
- date: DD/MM/YYYY
- narration: full description, no commas (replace commas with semicolons)
- ref_number: UTR/cheque/reference or empty
- debit: number or empty (not null)
- credit: number or empty (not null)
- balance: number or empty (not null)
- Skip opening/closing balance rows

Example:
date,narration,ref_number,debit,credit,balance
01/04/2025,NEFT CR-HDFC0001234-TATA STEEL LTD,N2025040112345,,495600,1234567.89
02/04/2025,IMPS-987654321-VENDOR PAYMENT,987654321,50000,,1184567.89`,
        },
      ],
    }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  if (!text.trim()) throw new Error("No response from AI");

  // Parse the CSV response
  const lines = text.trim().split("\n").filter((l) => l.trim());
  const transactions: ParsedTransaction[] = [];

  // Find the header row
  const headerIdx = lines.findIndex((l) => l.toLowerCase().includes("date,narration"));
  const dataLines = headerIdx >= 0 ? lines.slice(headerIdx + 1) : lines.slice(1);

  for (const line of dataLines) {
    const parts = line.split(",");
    if (parts.length < 2) continue;
    const [date, narration, ref_number, debitStr, creditStr, balanceStr] = parts;
    if (!date || !narration) continue;
    const debit = debitStr?.trim() ? parseFloat(debitStr.trim()) || null : null;
    const credit = creditStr?.trim() ? parseFloat(creditStr.trim()) || null : null;
    const balance = balanceStr?.trim() ? parseFloat(balanceStr.trim()) || null : null;
    transactions.push({
      date: date.trim(),
      narration: narration.trim().replace(/;/g, ","),
      ref_number: ref_number?.trim() || null,
      debit: isNaN(debit as number) ? null : debit,
      credit: isNaN(credit as number) ? null : credit,
      balance: isNaN(balance as number) ? null : balance,
    });
  }

  return transactions;
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
  const clientId = (formData.get("client_id") as string) || null;

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

  // Classify each transaction by category + voucher type
  function classifyTransaction(narration: string, isDebit: boolean): { category: string; voucher_type: string } {
    const n = narration.toUpperCase();
    if (/\bGSTIN\b|\bGST\s*PAY|\bGSTP\b|\bCGST\b|\bSGST\b|\bIGST\b/.test(n))
      return { category: "GST Payment", voucher_type: "Payment" };
    if (/\bTDS\b|\b26QB\b|\b26QC\b|\bINCOME.?TAX\b/.test(n))
      return { category: "TDS Payment", voucher_type: "Journal" };
    if (/\bSALARY\b|\bSALARIES\b|\bPAYROLL\b|\bWAGES\b|\bSTIPEND\b/.test(n))
      return { category: "Salary", voucher_type: "Payment" };
    if (/\bCHARGES\b|\bSERVICE FEE\b|\bANNUAL FEE\b|\bSMS CHARGE|\bATM CHARGE|\bBANK FEE|\bPROCESSING FEE|\bMAINTENANCE CHARGE/.test(n))
      return { category: "Bank Charges", voucher_type: "Journal" };
    if (/\bEMI\b|\bLOAN\b|\bREPAYMENT\b|\bINSTAL/.test(n))
      return { category: "Loan Repayment", voucher_type: "Payment" };
    if (/\bRENT\b|\bRENTAL\b|\bLEASE\b/.test(n))
      return { category: "Rent", voucher_type: "Payment" };
    if (/\bINSURANCE\b|\bPREMIUM\b|\bLIC\b|\bPOLICY\b/.test(n))
      return { category: "Insurance", voucher_type: "Payment" };
    if (/\bINTEREST\b/.test(n))
      return { category: isDebit ? "Interest Expense" : "Interest Income", voucher_type: "Journal" };
    if (/\bSELF TRANSFER\b|\bFD TRANSFER\b|\bSWEEP\b|\bOD ACCOUNT\b|\bOWN ACCOUNT\b/.test(n))
      return { category: "Inter-bank Transfer", voucher_type: "Contra" };
    if (!isDebit)
      return { category: "Customer Receipt", voucher_type: "Receipt" };
    return { category: "Vendor Payment", voucher_type: "Payment" };
  }

  // Build rows with hash-based dedup
  const rowsToInsert: Record<string, unknown>[] = [];
  const allHashes: string[] = [];
  let minDate = "9999-12-31", maxDate = "0000-01-01";

  for (const txn of transactions) {
    const isoDate = toISODate(txn.date);
    const isDebit = !!txn.debit;
    const { category, voucher_type } = classifyTransaction(txn.narration ?? "", isDebit);

    // Hash = bank + date + narration (normalised) + debit + credit for dedup
    const hashStr = `${bankName}|${isoDate}|${(txn.narration ?? "").toLowerCase().trim()}|${txn.debit ?? ""}|${txn.credit ?? ""}`;
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
      txn_hash: txnHash,
      ...(clientId ? { client_id: clientId } : {}),
    });
  }

  // Smart incremental merge:
  // 1. Remove old NULL-hash rows in same bank+date range (pre-migration duplicates)
  if (minDate !== "9999-12-31") {
    await supabase
      .from("bank_transactions")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("bank_name", bankName)
      .is("txn_hash", null)
      .gte("transaction_date", minDate)
      .lte("transaction_date", maxDate);
  }

  // 2. Check which hashes already exist — only insert the missing ones
  const { data: existingRows } = await supabase
    .from("bank_transactions")
    .select("txn_hash")
    .eq("tenant_id", tenantId)
    .in("txn_hash", allHashes);
  const existingHashes = new Set((existingRows ?? []).map((r) => r.txn_hash));
  const alreadyPresent = existingHashes.size;

  // 3. Only insert rows whose hash isn't already in the DB
  const newRows = rowsToInsert.filter((r) => !existingHashes.has(r.txn_hash as string));

  if (newRows.length === 0) {
    return NextResponse.json({
      success: true,
      count: 0,
      already_present: alreadyPresent,
      total_in_file: transactions.length,
      message: `All ${transactions.length} transactions already present — no duplicates added.`,
    });
  }

  const { data: inserted, error: insertError } = await supabase
    .from("bank_transactions")
    .insert(newRows)
    .select("id");

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  const newlyAdded = (inserted ?? []).length;
  const total = transactions.length;

  await supabase.from("audit_log").insert({
    tenant_id: tenantId,
    user_id: user.id,
    action: "upload_bank_statement",
    entity_type: "bank_transactions",
    entity_id: tenantId,
    new_value: { file_name: file.name, bank_name: bankName, total, newly_added: newlyAdded, already_present: alreadyPresent },
  });

  const transactionIds = (inserted ?? []).map((r) => r.id);
  if (transactionIds.length > 0) {
    fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/v1/reconciliation/auto-match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, transactionIds }),
    }).catch(() => {});
  }

  // Build a user-friendly message
  let message: string;
  if (newlyAdded === 0 && alreadyPresent > 0) {
    message = `All ${total} transactions already present — no duplicates added.`;
  } else if (alreadyPresent > 0) {
    message = `${newlyAdded} new transactions added. ${alreadyPresent} already present (skipped). Statement has ${total} total transactions.`;
  } else {
    message = `${newlyAdded} transactions imported successfully.`;
  }

  return NextResponse.json({
    success: true,
    count: newlyAdded,
    already_present: alreadyPresent,
    total_in_file: total,
    message,
  });
}
