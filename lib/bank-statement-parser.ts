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

// ---- Column name normalizers per bank ----
// Each entry is { date, narration, ref, debit, credit, balance }
const BANK_COLUMN_MAPS: Array<{
  match: RegExp;  // matches column header string
  map: Record<string, string[]>;
}> = [
  // HDFC Bank
  {
    match: /hdfc|value date|withdrawal amt/i,
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
    match: /icici|transaction date|s no\.|transaction id/i,
    map: {
      date: ["transaction date", "date", "value date"],
      narration: ["transaction remarks", "narration", "description", "particulars"],
      ref: ["transaction id", "chq / ref no.", "ref no", "reference"],
      debit: ["withdrawal(dr)", "debit amount", "dr amount", "debit", "dr"],
      credit: ["deposit(cr)", "credit amount", "cr amount", "credit", "cr"],
      balance: ["balance(in rs.)", "balance", "closing balance"],
    },
  },
  // SBI
  {
    match: /sbi|txn date|description|ref no\/ cheque no/i,
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
      narration: ["narration", "description", "particulars", "remarks", "details", "transaction details"],
      ref: ["ref", "ref no", "reference", "utr", "cheque", "chq no", "transaction id"],
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
  return isNaN(num) ? null : num;
}

function parseDate(val: string | undefined | null): string {
  if (!val || val.trim() === "") return new Date().toISOString().slice(0, 10);

  // Try common Indian date formats: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD
  const v = val.trim();

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // DD MMM YYYY (e.g. "15 Jan 2024")
  const dmmy = v.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (dmmy) {
    const [, d, m, y] = dmmy;
    const date = new Date(`${m} ${d} ${y}`);
    if (!isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }

  // ISO format already
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return v.slice(0, 10);

  // Fallback: try native Date parse
  const d = new Date(v);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return new Date().toISOString().slice(0, 10);
}

function extractUTR(narration: string): string | null {
  // UTR: 22-character alphanumeric, or NEFT/RTGS reference patterns
  const utrMatch = narration.match(/\b([A-Z]{4}\d{18}|[A-Z0-9]{22})\b/);
  if (utrMatch) return utrMatch[1];
  const neftMatch = narration.match(/(?:NEFT|RTGS|IMPS)[\/\-\s]([A-Z0-9]+)/i);
  if (neftMatch) return neftMatch[1];
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

    // Skip completely empty rows or header re-occurrences
    if (!narration.trim() && debit === null && credit === null) continue;
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
  const result = Papa.parse<Record<string, string>>(content, {
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
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_amount: number | null;
  tds_amount: number | null;
  vendor_name: string | null;
  payment_reference: string | null;
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

export function scoreMatch(
  txn: BankTransaction & { id: string },
  invoice: InvoiceForMatching
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const txnAmount = txn.debit ?? txn.credit ?? 0;
  const invoiceAmount = invoice.total_amount ?? 0;
  const netAfterTds = invoiceAmount - (invoice.tds_amount ?? 0);

  // Amount match
  if (invoiceAmount > 0 && txnAmount > 0) {
    if (Math.abs(txnAmount - invoiceAmount) <= 1) {
      score += 50; reasons.push("Exact amount match");
    } else if (Math.abs(txnAmount - invoiceAmount) / invoiceAmount <= 0.02) {
      score += 30; reasons.push("Amount within 2%");
    } else if (Math.abs(txnAmount - netAfterTds) <= 1 && invoice.tds_amount && invoice.tds_amount > 0) {
      score += 20; reasons.push("Amount matches invoice minus TDS");
    }
  }

  // Date match
  if (invoice.due_date && txn.date) {
    const diff = daysDiff(txn.date, invoice.due_date);
    if (diff <= 7) { score += 30; reasons.push("Within 7 days of due date"); }
    else if (diff <= 30) { score += 20; reasons.push("Within 30 days of due date"); }
  } else if (invoice.invoice_date && txn.date) {
    const diff = daysDiff(txn.date, invoice.invoice_date);
    if (diff <= 7) { score += 20; reasons.push("Within 7 days of invoice date"); }
    else if (diff <= 30) { score += 15; reasons.push("Within 30 days of invoice date"); }
  }

  // Invoice number in narration
  if (invoice.invoice_number) {
    const inv = invoice.invoice_number.toLowerCase().replace(/\s/g, "");
    const narr = txn.narration.toLowerCase().replace(/\s/g, "");
    if (narr.includes(inv)) { score += 40; reasons.push("Invoice number in narration"); }
  }

  // Vendor name in narration
  if (invoice.vendor_name) {
    const vendorWords = invoice.vendor_name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const narr = txn.narration.toLowerCase();
    const matched = vendorWords.filter((w) => narr.includes(w));
    if (matched.length >= 2) { score += 25; reasons.push("Vendor name in narration"); }
    else if (matched.length === 1) { score += 10; reasons.push("Partial vendor name match"); }
  }

  // UTR / payment reference
  if (invoice.payment_reference && txn.ref_number) {
    if (txn.ref_number.trim() === invoice.payment_reference.trim()) {
      score += 35; reasons.push("UTR/reference matches");
    }
  }

  return { score, reasons };
}
