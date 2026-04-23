import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseCSV, parseXLSX } from "@/lib/bank-statement-parser";
import Anthropic from "@anthropic-ai/sdk";
import { suggestLedger, extractPattern, ledgerToMeta } from "@/lib/ledger-rules";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

interface ParsedTransaction {
  date: string;
  narration: string;
  ref_number: string | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
}

function parseCsvLines(text: string): ParsedTransaction[] {
  const lines = text.trim().split("\n").filter((l) => l.trim());
  const transactions: ParsedTransaction[] = [];
  const headerIdx = lines.findIndex((l) => /^date[,\t]/i.test(l.trim()));
  const dataLines = headerIdx >= 0 ? lines.slice(headerIdx + 1) : lines;

  for (const line of dataLines) {
    const parts = line.split(",");
    if (parts.length < 4) continue;
    // Format: date, narration (may span multiple commas), ref, debit, credit, balance
    // Take last 4 as ref/debit/credit/balance, rest between index 1 and -4 as narration
    const date = parts[0]?.trim();
    if (!date || !/\d/.test(date)) continue;
    const balance = parts[parts.length - 1]?.trim();
    const credit = parts[parts.length - 2]?.trim();
    const debit = parts[parts.length - 3]?.trim();
    const ref_number = parts[parts.length - 4]?.trim();
    const narration = parts.slice(1, parts.length - 4).join(",").trim().replace(/;/g, ",") || parts[1]?.trim() || "";
    if (!narration) continue;
    const debitNum = debit ? parseFloat(debit) || null : null;
    const creditNum = credit ? parseFloat(credit) || null : null;
    const balanceNum = balance ? parseFloat(balance) || null : null;
    transactions.push({
      date,
      narration,
      ref_number: ref_number || null,
      debit: debitNum,
      credit: creditNum,
      balance: balanceNum,
    });
  }
  return transactions;
}

async function parsePDFStatement(fileBytes: ArrayBuffer): Promise<ParsedTransaction[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in Vercel environment variables.");
  }

  // Encode once, reuse across passes
  const uint8 = new Uint8Array(fileBytes);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < uint8.length; i += CHUNK) {
    binary += String.fromCharCode(...uint8.subarray(i, i + CHUNK));
  }
  const base64 = btoa(binary);

  const CSV_PROMPT = `Extract bank transactions from this statement. Return ONLY a CSV, no markdown, no explanation.

Exact header: date,narration,ref_number,debit,credit,balance
- date: DD/MM/YYYY
- narration: replace any commas with semicolons
- ref_number: UTR/cheque/ref or empty
- debit/credit/balance: number or empty
- Skip opening balance, closing balance rows`;

  const allTransactions: ParsedTransaction[] = [];
  let afterCursor: { date: string; narration: string } | null = null;

  for (let pass = 0; pass < 4; pass++) {
    const promptText = pass === 0
      ? CSV_PROMPT
      : `${CSV_PROMPT}

IMPORTANT: Only extract transactions that appear AFTER this transaction in the statement:
Date: ${afterCursor!.date}
Narration starts with: ${afterCursor!.narration.slice(0, 60)}

Skip all transactions up to and including that one. Continue from the next transaction onwards.`;

    const response = await anthropic.messages.create({
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

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const batch = parseCsvLines(text);

    if (batch.length === 0) break;
    allTransactions.push(...batch);

    if (response.stop_reason !== "max_tokens") break;

    const last = batch[batch.length - 1];
    afterCursor = { date: last.date, narration: last.narration };
  }

  return allTransactions;
}

// Tell Vercel this route needs more than the default 10s timeout
// Requires Vercel Pro or higher (free plan max is 10s)
export const maxDuration = 300; // 5 minutes — enough for multi-pass large PDFs

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

  // Derive category + voucher_type from ledger name (shared ledgerToMeta),
  // falling back to narration heuristics for unrecognized/custom ledgers.
  function categoryFromLedger(
    ledgerName: string | null,
    narration: string,
    isDebit: boolean,
  ): { category: string; voucher_type: string } {
    if (ledgerName) {
      const meta = ledgerToMeta(ledgerName);
      if (meta) return meta;
    }
    const n = narration.toUpperCase();
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

  // Pre-load confirmed client-specific rules (Layer 3) and industry rules (Layer 2)
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

    // Fetch industry for this client, then load industry rules
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

  for (const txn of transactions) {
    const isoDate = toISODate(txn.date);
    const isDebit = !!txn.debit;

    // Compute ledger first (Layer 3 → Layer 2 → Layer 1), then derive category from it.
    // This keeps category and ledger in sync — no more "Bank Charges ledger / Vendor Payment category" splits.
    const pattern = extractPattern(txn.narration ?? "");
    const ledger_name = clientRules.get(pattern) ?? industryRules.get(pattern) ?? suggestLedger(txn.narration ?? "") ?? null;
    const { category, voucher_type } = categoryFromLedger(ledger_name, txn.narration ?? "", isDebit);

    // Hash = bank + date + narration (normalised) + debit + credit + balance for dedup
    // Balance included so genuinely identical-looking transactions (same date/amount/narration)
    // that differ only in running balance still get unique hashes.
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

  // ── Clean re-upload strategy ──────────────────────────────────────────────
  //
  // PROBLEM with the old incremental approach:
  //   1. Hash check used `.in("txn_hash", 434 hashes)` → ~28 KB URL → Supabase
  //      silently returns empty → all hashes look "new" → INSERT all → duplicate
  //      key constraint error on the second upload of the same file.
  //   2. When the CSV parser had bugs (split amounts), old wrong rows (hash based
  //      on "11" + "947.00") stayed in the DB forever. Uploading fixed parser
  //      produced different hashes → rows stacked on top → 447 + 434 = 881 rows.
  //
  // SOLUTION: for a scoped (client-specific) upload, DELETE all existing rows
  // for this client + bank + date range, then INSERT the freshly parsed rows.
  // This is the right semantics: re-uploading a statement replaces it.
  // Reconciliation entries linked to those transactions are deleted first to
  // avoid FK violations.
  //
  // For uploads without a clientId (rare / global), fall back to hash dedup
  // in batches of 100 to stay well under URL limits.

  let alreadyPresent = 0;

  if (minDate !== "9999-12-31" && clientId) {
    // Step 1: find IDs of existing rows in this period
    const { data: existingTxns } = await supabase
      .from("bank_transactions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("client_id", clientId)
      .eq("bank_name", bankName)
      .gte("transaction_date", minDate)
      .lte("transaction_date", maxDate);

    const existingIds = (existingTxns ?? []).map((t) => (t as { id: string }).id);
    alreadyPresent = existingIds.length;

    if (existingIds.length > 0) {
      // Step 2: delete reconciliation rows linked to these transactions (FK safety)
      for (let i = 0; i < existingIds.length; i += 100) {
        await supabase.from("reconciliations").delete()
          .eq("tenant_id", tenantId)
          .in("bank_transaction_id", existingIds.slice(i, i + 100));
      }
      // Step 3: delete the bank transaction rows themselves
      await supabase.from("bank_transactions").delete()
        .eq("tenant_id", tenantId)
        .eq("client_id", clientId)
        .eq("bank_name", bankName)
        .gte("transaction_date", minDate)
        .lte("transaction_date", maxDate);
    }
  } else if (minDate !== "9999-12-31") {
    // No clientId: batch hash-check (100 at a time to stay under URL limits)
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
      success: true,
      count: 0,
      already_present: alreadyPresent,
      total_in_file: transactions.length,
      message: `All ${transactions.length} transactions already present — no duplicates added.`,
    });
  }

  const { data: inserted, error: insertError } = await supabase
    .from("bank_transactions")
    .upsert(rowsToInsert, { onConflict: "tenant_id,txn_hash", ignoreDuplicates: true })
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
  if (alreadyPresent > 0) {
    message = `${newlyAdded} transactions imported (replaced ${alreadyPresent} previous rows for this period).`;
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
