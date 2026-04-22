// Bank Statement Parser
// Supports: CSV, XLSX, and common Indian bank PDF statement formats
// Handles major banks: HDFC, ICICI, SBI, Axis, Kotak, Yes, IndusInd

import Papa from "papaparse";
import * as XLSX from "xlsx";

export interface BankTransaction {
  date: string;         // ISO format YYYY-MM-DD
  narration: string;
  ref_number: string | null;  // UTR/NEFT/RTGS reference
  debit: number | null;
  credit: number | null;
  balance: number | null;
  raw_row: Record<string, string>;  // original row for debugging
}

// ---- CSV pre-processor: fix unquoted comma-formatted numbers ----
//
// Problem: Indian bank CSVs often contain amounts like 11,947.00 or 1,00,000.00
// WITHOUT quoting. PapaParse treats the commas as delimiters, splitting the amount
// across columns: debit="11", credit="947.00" instead of debit="11,947.00".
// This causes wrong debit/credit values AND inflated row counts.
//
// Fix: before passing to PapaParse, count expected columns from the header row.
// For any data row with more columns than expected, merge adjacent fields that
// together form a comma-formatted number (e.g. "11"+"947.00" → "11,947.00").

/** Split a single CSV line correctly — respects quoted fields. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; } // escaped quote
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Merge adjacent fields that are numeric fragments of a comma-formatted number.
 *
 * Criteria for a merge:
 *   field A: 1–3 digits, optionally already has comma-groups (e.g. "1,00" from a prior pass)
 *   field B: exactly 2–3 digits, optionally followed by a decimal part (e.g. "947.00")
 *
 * Iterates until row reaches targetCount or no more merges are possible.
 * Handles both international (1,234) and Indian lakh (1,23,456) formats in multiple passes.
 */
function mergeNumericFragments(fields: string[], targetCount: number): string[] {
  const isFragmentA = (s: string) => /^\d{1,3}(,\d{2,3})*$/.test(s);
  const isFragmentB = (s: string) => /^\d{2,3}(?:\.\d{1,2})?$/.test(s);

  const result = [...fields];
  let maxIter = result.length * 2; // safety cap

  while (result.length > targetCount && maxIter-- > 0) {
    let merged = false;
    for (let i = 0; i < result.length - 1; i++) {
      if (isFragmentA(result[i]) && isFragmentB(result[i + 1])) {
        result.splice(i, 2, `${result[i]},${result[i + 1]}`);
        merged = true;
        break; // restart scan — earlier pair might now be eligible
      }
    }
    if (!merged) break;
  }

  return result;
}

/** Re-join a field array as CSV, quoting any field that contains a comma. */
function reJoinCsv(fields: string[]): string {
  return fields.map((f) => {
    const bare = f.startsWith('"') && f.endsWith('"') ? f.slice(1, -1) : f;
    return bare.includes(",") ? `"${bare.replace(/"/g, '""')}"` : f;
  }).join(",");
}

/**
 * Pre-process raw CSV text so that unquoted commas inside amount fields AND
 * inside narration fields are handled before PapaParse runs.
 *
 * Two-pass strategy for rows with more columns than the header:
 *
 * Pass 1 — merge adjacent numeric fragments (e.g. "11" + "947.00" → "11,947.00").
 *   Handles: Indian bank amounts like ₹11,947.00 or ₹1,00,000.00 written without quotes.
 *
 * Pass 2 — narration fallback. If the row STILL has too many columns after pass 1,
 *   the remaining excess must be from unquoted commas in the narration field (index 1).
 *   UPI narrations very commonly contain commas, e.g.:
 *     "Paid via CRED,UPI-420318523888" (the comma between the two parts)
 *   We join fields[1 .. 1+excess] back as a single narration field.
 *   This is safe because: col[0] is always the date (no commas), and the
 *   numeric tail columns (ref / debit / credit / balance) were already fixed in pass 1.
 */
function fixUnquotedAmounts(csvText: string): string {
  const lines = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length < 2) return csvText;

  const expectedCols = splitCsvLine(lines[0]).length;

  return lines.map((line, idx) => {
    if (idx === 0) return line; // header: never touch
    if (!line.trim()) return line;

    const fields = splitCsvLine(line);
    if (fields.length <= expectedCols) return line; // already correct

    // Pass 1: merge numeric fragments (amount splits)
    const merged = mergeNumericFragments(fields, expectedCols);
    if (merged.length <= expectedCols) return reJoinCsv(merged);

    // Pass 2: narration fallback — remaining excess columns are from the narration
    const excess = merged.length - expectedCols;
    const narration = merged.slice(1, 2 + excess).join(","); // join narration fragments
    const tail = merged.slice(2 + excess);                    // structural fields (ref/debit/credit/balance)
    return reJoinCsv([merged[0], narration, ...tail]);
  }).join("\n");
}

// ---- Column name normalizers per bank ----
// Each entry is { date, narration, ref, debit, credit, balance }
const BANK_COLUMN_MAPS: Array<{
  match: RegExp;  // matches column header string
  map: Record<string, string[]>;
}> = [
  // HDFC Bank
  {
    match: /hdfc|withdrawal amt/i,
    map: {
      date: ["date", "txn date", "transaction date", "value date"],
      narration: ["narration", "description", "particulars", "remarks"],
      ref: ["chq./ ref.no.", "chq/ref no", "ref no", "reference number", "utr"],
      debit: ["withdrawal amt.", "debit", "dr", "withdrawal", "amount(dr)"],
      credit: ["deposit amt.", "credit", "cr", "deposit", "amount(cr)"],
      balance: ["closing balance", "balance", "running balance"],
    },
  },
  // ICICI Bank
  {
    match: /icici|transaction remarks|s no\./i,
    map: {
      date: ["transaction date", "date", "value date"],
      narration: ["transaction remarks", "narration", "description", "particulars"],
      ref: ["transaction id", "chq / ref no.", "ref no", "reference"],
      debit: ["withdrawal(dr)", "debit amount", "dr amount", "debit", "dr"],
      credit: ["deposit(cr)", "credit amount", "cr amount", "credit", "cr"],
      balance: ["balance(in rs.)", "balance", "closing balance"],
    },
  },
  // Axis Bank
  {
    match: /axis|tran date|chq no|tran particular/i,
    map: {
      date: ["tran date", "date", "transaction date", "value date"],
      narration: ["tran particulars", "particulars", "narration", "description"],
      ref: ["chq no", "chq/ref no", "ref no", "utr"],
      debit: ["debit", "dr", "withdrawal amount", "withdrawal"],
      credit: ["credit", "cr", "deposit amount", "deposit"],
      balance: ["balance", "closing balance", "running balance"],
    },
  },
  // Kotak Mahindra Bank
  {
    match: /kotak|dr \/ cr|transaction reference/i,
    map: {
      date: ["date", "transaction date", "value date"],
      narration: ["description", "narration", "particulars", "transaction description"],
      ref: ["transaction reference", "reference number", "ref no", "cheque number"],
      debit: ["debit", "dr", "withdrawal"],
      credit: ["credit", "cr", "deposit"],
      balance: ["balance", "closing balance"],
    },
  },
  // Yes Bank
  {
    match: /yes bank|yes_bank|instabiz/i,
    map: {
      date: ["date", "transaction date", "value date"],
      narration: ["description", "narration", "remarks", "particulars"],
      ref: ["reference", "utr no", "chq no", "ref no"],
      debit: ["debit amount", "debit", "dr"],
      credit: ["credit amount", "credit", "cr"],
      balance: ["balance", "closing balance"],
    },
  },
  // IndusInd Bank
  {
    match: /indusind|indus ind/i,
    map: {
      date: ["date", "txn date", "transaction date"],
      narration: ["narration", "particulars", "description"],
      ref: ["reference number", "ref no", "cheque no"],
      debit: ["debit", "withdrawal amount", "dr"],
      credit: ["credit", "deposit amount", "cr"],
      balance: ["balance", "closing balance"],
    },
  },
  // SBI
  {
    match: /sbi|txn date|ref no\/ cheque no/i,
    map: {
      date: ["txn date", "date", "value date"],
      narration: ["description", "particulars", "narration", "remarks"],
      ref: ["ref no/ cheque no.", "ref no", "cheque number", "reference"],
      debit: ["debit", "dr", "withdrawal", "debit amount"],
      credit: ["credit", "cr", "deposit", "credit amount"],
      balance: ["balance", "closing balance"],
    },
  },
  // Generic fallback
  {
    match: /.*/,
    map: {
      date: ["date", "txn date", "transaction date", "value date", "posting date"],
      narration: ["narration", "description", "particulars", "remarks", "details", "transaction details", "tran particulars"],
      ref: ["ref", "ref no", "reference", "utr", "cheque", "chq no", "transaction id", "transaction reference"],
      debit: ["debit", "dr", "withdrawal", "withdrawal amount", "debit amount", "amount dr"],
      credit: ["credit", "cr", "deposit", "deposit amount", "credit amount", "amount cr"],
      balance: ["balance", "closing balance", "running balance", "available balance"],
    },
  },
];

function normalizeColumnName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ").replace(/[^a-z0-9\s().\/]/g, "");
}

function findColumn(headers: string[], candidates: string[]): string | null {
  const normalizedHeaders = headers.map(normalizeColumnName);
  for (const candidate of candidates) {
    const idx = normalizedHeaders.findIndex((h) => h.includes(candidate.toLowerCase()));
    if (idx !== -1) return headers[idx];
  }
  return null;
}

function detectBankMap(headers: string[]): typeof BANK_COLUMN_MAPS[0]["map"] {
  const joined = headers.join(" ");
  for (const bank of BANK_COLUMN_MAPS) {
    if (bank.match.test(joined)) return bank.map;
  }
  return BANK_COLUMN_MAPS[BANK_COLUMN_MAPS.length - 1].map;
}

function parseAmount(val: string | undefined | null): number | null {
  if (!val || val.trim() === "" || val.trim() === "-") return null;
  const cleaned = val.replace(/[₹,\s]/g, "").replace(/[()]/g, "");
  const num = parseFloat(cleaned);
  // Treat 0 / 0.00 as null — banks fill the inactive column with zero instead of leaving blank.
  // A genuine zero-amount bank transaction doesn't exist.
  if (isNaN(num) || num === 0) return null;
  return num;
}

const MONTH_MAP: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function parseDate(val: string | undefined | null): string {
  if (!val || val.trim() === "") return new Date().toISOString().slice(0, 10);

  const v = val.trim();

  // ISO format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY (4-digit year)
  const dmy4 = v.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy4) {
    const [, d, m, y] = dmy4;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // DD-Mon-YYYY or DD/Mon/YYYY or DD Mon YYYY (e.g. "15-Jan-2024", "15 Jan 2024")
  const dMonY = v.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/](\d{4})$/);
  if (dMonY) {
    const mm = MONTH_MAP[dMonY[2].slice(0, 3).toLowerCase()];
    if (mm) return `${dMonY[3]}-${mm}-${dMonY[1].padStart(2, "0")}`;
  }

  // DD-Mon-YY or DD/Mon/YY (2-digit year, e.g. "15-Jan-24") — common in HDFC/Axis XLSX
  const dMonYY = v.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/](\d{2})$/);
  if (dMonYY) {
    const mm = MONTH_MAP[dMonYY[2].slice(0, 3).toLowerCase()];
    if (mm) {
      const yr = parseInt(dMonYY[3], 10);
      const fullYear = yr >= 0 && yr <= 30 ? 2000 + yr : 1900 + yr;
      return `${fullYear}-${mm}-${dMonYY[1].padStart(2, "0")}`;
    }
  }

  // DD/MM/YY (2-digit year, e.g. "15/01/24")
  const dmy2 = v.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})$/);
  if (dmy2) {
    const yr = parseInt(dmy2[3], 10);
    const fullYear = yr >= 0 && yr <= 30 ? 2000 + yr : 1900 + yr;
    return `${fullYear}-${dmy2[2].padStart(2, "0")}-${dmy2[1].padStart(2, "0")}`;
  }

  // Fallback: try native Date parse (handles many other formats)
  const d = new Date(v);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return new Date().toISOString().slice(0, 10);
}

function extractUTR(narration: string): string | null {
  // NEFT/RTGS UTR: exactly 22 chars, letter-prefixed (e.g. HDFC0000012345678901)
  const utrMatch = narration.match(/\b([A-Z]{4}\d{18})\b/);
  if (utrMatch) return utrMatch[1];

  // NEFT / RTGS / IMPS reference after slash or space
  const neftMatch = narration.match(/(?:NEFT|RTGS|IMPS)[\/\-\s]([A-Z0-9]{8,22})/i);
  if (neftMatch) return neftMatch[1];

  // UPI transaction reference number (12-digit number in UPI narrations)
  // Pattern: UPI/ref_number/... or UPI-ref_number
  const upiRefMatch = narration.match(/UPI[\/\-\s](?:[A-Z0-9]+[\/\-])?(\d{10,15})/i);
  if (upiRefMatch) return upiRefMatch[1];

  // Standalone 12-digit reference number (common in IMPS)
  const impsMatch = narration.match(/\b(\d{12})\b/);
  if (impsMatch) return impsMatch[1];

  return null;
}

function rowsToTransactions(
  rows: Record<string, string>[],
  headers: string[]
): BankTransaction[] {
  const bankMap = detectBankMap(headers);

  const dateCol = findColumn(headers, bankMap.date);
  const narrationCol = findColumn(headers, bankMap.narration);
  const refCol = findColumn(headers, bankMap.ref);
  const debitCol = findColumn(headers, bankMap.debit);
  const creditCol = findColumn(headers, bankMap.credit);
  const balanceCol = findColumn(headers, bankMap.balance);

  const transactions: BankTransaction[] = [];

  for (const row of rows) {
    const narration = (narrationCol ? row[narrationCol] : "") ?? "";
    const rawRef = refCol ? row[refCol] : null;
    const utrFromNarration = extractUTR(narration);

    const debit = parseAmount(debitCol ? row[debitCol] : null);
    const credit = parseAmount(creditCol ? row[creditCol] : null);

    // Every real bank transaction must have a debit or credit amount.
    // Rows with neither are metadata, summary totals, or repeated header rows — skip them all.
    if (debit === null && credit === null) continue;
    if (narration.toLowerCase().includes("opening balance") || narration.toLowerCase().includes("closing balance")) continue;

    transactions.push({
      date: parseDate(dateCol ? row[dateCol] : null),
      narration: narration.trim(),
      ref_number: rawRef?.trim() || utrFromNarration || null,
      debit: debit,
      credit: credit,
      balance: parseAmount(balanceCol ? row[balanceCol] : null),
      raw_row: row,
    });
  }

  return transactions;
}

// ---- Public API ----

export function parseCSV(content: string): BankTransaction[] {
  // Fix unquoted comma-formatted amounts (e.g. "11,947.00" → "11,947.00" properly quoted)
  // before PapaParse sees the content, preventing column-shift errors.
  const fixed = fixUnquotedAmounts(content);
  const result = Papa.parse<Record<string, string>>(fixed, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  return rowsToTransactions(result.data, result.meta.fields ?? []);
}

export function parseXLSX(buffer: ArrayBuffer): BankTransaction[] {
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(firstSheet, {
    defval: "",
    raw: false,
  });
  if (rows.length === 0) return [];
  const headers = Object.keys(rows[0]);
  return rowsToTransactions(rows, headers);
}

// ---- Matching algorithm ----

export interface InvoiceForMatching {
  id: string;
  doc_type: string | null;           // "purchase_invoice" | "expense" | "sales_invoice"
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_amount: number | null;
  tds_amount: number | null;
  vendor_name: string | null;
  buyer_name: string | null;         // for sales invoices
  payment_reference: string | null;
  suggested_ledger: string | null;   // propagated to bank txn on match
}

export interface MatchResult {
  transaction_id: string;
  invoice_id: string;
  score: number;
  match_reasons: string[];
}

function daysDiff(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / (1000 * 60 * 60 * 24);
}

// Narrations that should NEVER match an invoice — these are salary, tax payments,
// bank charges, internal transfers etc. Amount coincidence must not trigger a match.
const BLOCKED_NARRATION_PATTERNS = [
  /\bsalar(y|ies|ied)\b/i,
  /\bpayroll\b/i,
  /\bwages?\b/i,
  /\bstipend\b/i,
  /\bgst\s*payment\b/i,
  /\bgst\s*paid\b/i,
  /\btds\s*payment\b/i,
  /\btds\s*paid\b/i,
  /\badvance\s*tax\b/i,
  /\bincome\s*tax\b/i,
  /\bself\s*transfer\b/i,
  /\bown\s*transfer\b/i,
  /\binter.?bank\b/i,
  /\bbank\s*charges?\b/i,
  /\bservice\s*charge\b/i,
  /\bcheque\s*(return|bounce)\b/i,
  /\bneft\s*return\b/i,
  /\bloan\s*(emi|repay|instalment)\b/i,
  /\bemi\s*payment\b/i,
  /\bfd\s*(interest|maturity|renewal)\b/i,
  /\binterest\s*(credit|earned|paid)\b/i,
  /\bopening\s*balance\b/i,
  /\bclosing\s*balance\b/i,
  /\bdividend\b/i,
  /\bpf\s*(payment|contribution)\b/i,
  /\besi\s*payment\b/i,
  /\bgratuity\b/i,
];

export function scoreMatch(
  txn: BankTransaction & { id: string },
  invoice: InvoiceForMatching
): { score: number; reasons: string[] } {
  const narr = txn.narration ?? "";

  // Hard block: salary / tax payments / bank charges must never match invoices
  if (BLOCKED_NARRATION_PATTERNS.some((p) => p.test(narr))) {
    return { score: 0, reasons: [] };
  }

  // Direction check: purchase/expense → debit only; sales → credit only
  // Wrong direction = hard zero (a customer receipt cannot match a vendor invoice)
  const isSales = invoice.doc_type === "sales_invoice";
  const isPurchase = invoice.doc_type === "purchase_invoice" || invoice.doc_type === "expense";
  if (isSales && txn.debit && !txn.credit) return { score: 0, reasons: [] };
  if (isPurchase && txn.credit && !txn.debit) return { score: 0, reasons: [] };

  let score = 0;
  const reasons: string[] = [];

  // Use the correct amount side based on direction
  const txnAmount = isSales ? (txn.credit ?? 0) : (txn.debit ?? txn.credit ?? 0);
  const invoiceAmount = invoice.total_amount ?? 0;
  const netAfterTds = invoiceAmount - (invoice.tds_amount ?? 0);

  // Amount match
  if (invoiceAmount > 0 && txnAmount > 0) {
    if (Math.abs(txnAmount - invoiceAmount) <= 1) {
      score += 50; reasons.push("Exact amount match");
    } else if (Math.abs(txnAmount - invoiceAmount) / invoiceAmount <= 0.02) {
      score += 40; reasons.push("Amount within 2%");
    } else if (Math.abs(txnAmount - netAfterTds) <= 1 && invoice.tds_amount && invoice.tds_amount > 0) {
      score += 35; reasons.push("Amount matches invoice minus TDS");
    } else if (Math.abs(txnAmount - invoiceAmount) / invoiceAmount <= 0.10) {
      score += 15; reasons.push("Amount within 10%");
    }
  }

  // Date proximity
  if (invoice.due_date && txn.date) {
    const diff = daysDiff(txn.date, invoice.due_date);
    if (diff <= 3)  { score += 30; reasons.push("Within 3 days of due date"); }
    else if (diff <= 7)  { score += 25; reasons.push("Within 7 days of due date"); }
    else if (diff <= 30) { score += 15; reasons.push("Within 30 days of due date"); }
  } else if (invoice.invoice_date && txn.date) {
    const diff = daysDiff(txn.date, invoice.invoice_date);
    if (diff <= 3)  { score += 20; reasons.push("Within 3 days of invoice date"); }
    else if (diff <= 7)  { score += 15; reasons.push("Within 7 days of invoice date"); }
    else if (diff <= 30) { score += 8;  reasons.push("Within 30 days of invoice date"); }
  }

  // Invoice number in narration (strong signal)
  // Rules to avoid false positives:
  // - Must be >= 6 chars after stripping separators (avoids matching short sequences inside UPI ref numbers)
  // - Must contain at least one digit (pure-word codes like "MISC" shouldn't trigger this)
  // - Must match as a word boundary or segment boundary (not buried inside a longer number)
  if (invoice.invoice_number) {
    const inv = invoice.invoice_number.toLowerCase().replace(/[\s\-\/]/g, "");
    const narrClean = narr.toLowerCase().replace(/[\s\-\/]/g, "");
    const hasDigit = /\d/.test(inv);
    if (inv.length >= 6 && hasDigit) {
      // Word-boundary match: the invoice number should not be surrounded by more digits
      // e.g. inv="12345" should NOT match inside "UPI/4123456/vendor"
      const escaped = inv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const wordBoundaryMatch = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(narrClean);
      if (wordBoundaryMatch) {
        score += 45; reasons.push("Invoice number in narration");
      }
    }
  }

  // UTR / payment reference (strongest possible signal)
  if (invoice.payment_reference && txn.ref_number) {
    const txnRef = txn.ref_number.trim();
    const invRef = invoice.payment_reference.trim();
    if (txnRef === invRef) {
      score += 55; reasons.push("UTR/reference number matches");
    } else if (txnRef.length >= 8 && invRef.length >= 8 && (txnRef.includes(invRef) || invRef.includes(txnRef))) {
      score += 35; reasons.push("Reference number partial match");
    }
  }

  // UPI reference in narration vs invoice payment reference
  if (invoice.payment_reference) {
    const invRef = invoice.payment_reference.replace(/\s/g, "");
    const narrClean = narr.replace(/\s/g, "");
    if (invRef.length >= 8 && narrClean.includes(invRef)) {
      score += 45; reasons.push("Payment reference found in narration");
    }
  }

  // Party name in narration
  const partyName = isSales ? invoice.buyer_name : invoice.vendor_name;
  if (partyName) {
    const partyWords = partyName.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const narrLow = narr.toLowerCase();
    const matchedWords = partyWords.filter((w) => narrLow.includes(w));
    if (matchedWords.length >= 2) { score += 30; reasons.push(`${isSales ? "Customer" : "Vendor"} name in narration`); }
    else if (matchedWords.length === 1) { score += 12; reasons.push(`Partial ${isSales ? "customer" : "vendor"} name match`); }
  }

  return { score, reasons };
}
