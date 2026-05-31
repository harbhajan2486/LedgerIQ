// Bank Statement Parser
// (1) StatementRow / parseStatementCsv — used by the two-file bank-book import flow
// (2) BankTransaction / parseCSV / parseXLSX / scoreMatch — used by the
//     reconciliation upload-statement and auto-match routes.

import Papa from "papaparse";
import * as XLSX from "xlsx";

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Bank-book import types & parser
// ═══════════════════════════════════════════════════════════════════════════════

export interface StatementRow {
  date: string;            // YYYY-MM-DD
  narration: string;       // raw bank narration text
  debit: number | null;
  credit: number | null;
}

export interface StatementColumnMapping {
  date: string | null;
  narration: string | null;
  debit: string | null;
  credit: string | null;
}

export interface StatementParseResult {
  rows: StatementRow[];
  rawHeaders: string[];
  preview: Record<string, string>[];
  detectionConfident: boolean;
  columnMapping: StatementColumnMapping;
}

// ─── Month map shared by both sections ────────────────────────────────────────

const MONTH_MAP: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// ─── Helper: parse date (returns null on failure) ─────────────────────────────

function parseDateNullable(val: unknown): string | null {
  if (val === null || val === undefined || val === "") return null;

  if (typeof val === "number") {
    try {
      const parsed = XLSX.SSF.parse_date_code(val);
      if (parsed && parsed.y && parsed.m && parsed.d) {
        return `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
      }
    } catch { /* fall through */ }
    return null;
  }

  const v = String(val).trim();
  if (!v) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);

  const dMonY4 = v.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/](\d{4})$/);
  if (dMonY4) {
    const mm = MONTH_MAP[dMonY4[2].slice(0, 3).toLowerCase()];
    if (mm) return `${dMonY4[3]}-${mm}-${dMonY4[1].padStart(2, "0")}`;
  }

  const dMonY2 = v.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/](\d{2})$/);
  if (dMonY2) {
    const mm = MONTH_MAP[dMonY2[2].slice(0, 3).toLowerCase()];
    if (mm) {
      const yr = parseInt(dMonY2[3], 10);
      const fullYear = yr >= 0 && yr <= 30 ? 2000 + yr : 1900 + yr;
      return `${fullYear}-${mm}-${dMonY2[1].padStart(2, "0")}`;
    }
  }

  const dmy4 = v.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy4) return `${dmy4[3]}-${dmy4[2].padStart(2, "0")}-${dmy4[1].padStart(2, "0")}`;

  const dmy2 = v.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})$/);
  if (dmy2) {
    const yr = parseInt(dmy2[3], 10);
    const fullYear = yr >= 0 && yr <= 30 ? 2000 + yr : 1900 + yr;
    return `${fullYear}-${dmy2[2].padStart(2, "0")}-${dmy2[1].padStart(2, "0")}`;
  }

  const d = new Date(v);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

// ─── Helper: parse amount (returns null for zero/empty) ───────────────────────

function parseAmountNullable(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number") return (isNaN(val) || val === 0) ? null : val;
  const s = String(val).replace(/[₹,\s]/g, "").replace(/^\((.+)\)$/, "-$1").trim();
  if (!s || s === "-") return null;
  const n = parseFloat(s);
  return (isNaN(n) || n === 0) ? null : n;
}

// ─── Helper: detect statement columns from header row ─────────────────────────

function detectStatementColumns(headers: string[]): StatementColumnMapping {
  const mapping: StatementColumnMapping = { date: null, narration: null, debit: null, credit: null };

  for (const h of headers) {
    const norm = h.trim().toLowerCase();

    if (!mapping.date &&
      /^(date|dt|transaction\s*date|txn\s*date|value\s*date|posting\s*date)$/.test(norm)) {
      mapping.date = h;
    } else if (!mapping.narration &&
      /^(narration|description|particulars|remarks|transaction\s*details?|details?|transaction\s*narration|chq\.?\s*\/?\s*ref\.?\s*no\.?|narrative)$/.test(norm)) {
      mapping.narration = h;
    } else if (!mapping.debit &&
      /^(debit|dr|withdrawal|paid|debit\s*amount|dr\.?\s*amount|withdrawals|debit\s*\(rs\.\)|debit\s*\(inr\))$/.test(norm)) {
      mapping.debit = h;
    } else if (!mapping.credit &&
      /^(credit|cr|deposit|received|credit\s*amount|cr\.?\s*amount|deposits|credit\s*\(rs\.\)|credit\s*\(inr\))$/.test(norm)) {
      mapping.credit = h;
    }
  }

  return mapping;
}

// ─── parseStatementCsv — main export for bank-book import flow ────────────────

export function parseStatementCsv(
  buffer: ArrayBuffer,
  fileName: string,
  overrideMapping?: Partial<StatementColumnMapping>
): StatementParseResult {
  const nameLower = fileName.toLowerCase();

  let wb: XLSX.WorkBook;
  if (nameLower.endsWith(".csv")) {
    const text = new TextDecoder().decode(buffer);
    wb = XLSX.read(text, { type: "string" });
  } else {
    wb = XLSX.read(buffer, { type: "array", cellDates: false });
  }

  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });

  // Find header row (scan first 30 rows)
  let headerRowIndex = -1;
  let detectedMapping: StatementColumnMapping = { date: null, narration: null, debit: null, credit: null };
  let rawHeaders: string[] = [];

  for (let i = 0; i < Math.min(30, rawRows.length); i++) {
    const row = rawRows[i];
    const stringVals = (row as unknown[]).map((c) => String(c ?? "").trim());
    const mapping = detectStatementColumns(stringVals);

    if (mapping.date && mapping.narration && (mapping.debit || mapping.credit)) {
      headerRowIndex = i;
      detectedMapping = mapping;
      rawHeaders = stringVals;
      break;
    }
  }

  // Apply overrides
  if (overrideMapping) {
    if (overrideMapping.date) detectedMapping.date = overrideMapping.date;
    if (overrideMapping.narration) detectedMapping.narration = overrideMapping.narration;
    if (overrideMapping.debit) detectedMapping.debit = overrideMapping.debit;
    if (overrideMapping.credit) detectedMapping.credit = overrideMapping.credit;
  }

  const detectionConfident =
    detectedMapping.date !== null &&
    detectedMapping.narration !== null &&
    (detectedMapping.debit !== null || detectedMapping.credit !== null);

  const dataStartIndex = headerRowIndex >= 0 ? headerRowIndex + 1 : 0;

  // Build header → column index map
  const headerIndexMap: Record<string, number> = {};
  if (headerRowIndex >= 0 && rawHeaders.length > 0) {
    const actualHeaderRow = rawRows[headerRowIndex] as unknown[];
    if (actualHeaderRow) {
      actualHeaderRow.forEach((cell, idx) => {
        const key = String(cell ?? "").trim();
        if (key) headerIndexMap[key] = idx;
      });
    }
  }

  // Build preview (first 5 data rows)
  const preview: Record<string, string>[] = [];
  for (let i = dataStartIndex; i < Math.min(dataStartIndex + 5, rawRows.length); i++) {
    const row = rawRows[i] as unknown[];
    const record: Record<string, string> = {};
    rawHeaders.forEach((h, idx) => { record[h] = String(row[idx] ?? "").trim(); });
    preview.push(record);
  }

  if (!detectionConfident) {
    return { rows: [], rawHeaders, preview, detectionConfident, columnMapping: detectedMapping };
  }

  const dateIdx = detectedMapping.date ? (headerIndexMap[detectedMapping.date] ?? -1) : -1;
  const narrIdx = detectedMapping.narration ? (headerIndexMap[detectedMapping.narration] ?? -1) : -1;
  const debitIdx = detectedMapping.debit ? (headerIndexMap[detectedMapping.debit] ?? -1) : -1;
  const creditIdx = detectedMapping.credit ? (headerIndexMap[detectedMapping.credit] ?? -1) : -1;

  const SKIP_NARRATION = /^(opening|closing|total|balance|by balance|to balance)/i;
  const rows: StatementRow[] = [];

  for (let i = dataStartIndex; i < rawRows.length; i++) {
    const row = rawRows[i] as unknown[];

    const dateCell = dateIdx >= 0 ? row[dateIdx] : row[0];
    const parsedDate = parseDateNullable(dateCell);
    if (!parsedDate) continue;

    const narrRaw = narrIdx >= 0 ? row[narrIdx] : row[1];
    const narration = String(narrRaw ?? "").trim();
    if (!narration || SKIP_NARRATION.test(narration)) continue;

    const debit = debitIdx >= 0 ? parseAmountNullable(row[debitIdx]) : null;
    const credit = creditIdx >= 0 ? parseAmountNullable(row[creditIdx]) : null;
    if (debit === null && credit === null) continue;

    rows.push({ date: parsedDate, narration, debit, credit });
  }

  return { rows, rawHeaders, preview, detectionConfident, columnMapping: detectedMapping };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — BankTransaction / parseCSV / parseXLSX / scoreMatch
// (used by reconciliation routes — preserved as-is)
// ═══════════════════════════════════════════════════════════════════════════════

export interface BankTransaction {
  date: string;
  narration: string;
  ref_number: string | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  raw_row: Record<string, string>;
}

// ---- CSV pre-processor: fix unquoted comma-formatted numbers ----

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
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

function computeNumericTailCount(headers: string[]): number {
  let count = 0;
  for (let i = headers.length - 1; i >= 0; i--) {
    const n = normalizeColumnName(headers[i]);
    const isNumeric =
      n.includes("balance") ||
      n.includes("debit") || n === "dr" || n.includes("withdrawal") ||
      n.includes("credit") || n === "cr" || n.includes("deposit") ||
      n === "amount" || n.includes("transaction amount") ||
      n.includes("dr/cr") || n.includes("dr./cr");
    if (isNumeric) count++;
    else break;
  }
  return Math.max(count, 2);
}

function reconstructRow(rawFields: string[], rightFixed: number): {
  date: string;
  narration: string;
  tail: string[];
} {
  const tailSize = Math.min(rightFixed, rawFields.length - 1);
  const rawTail = rawFields.slice(rawFields.length - tailSize);
  const mergedTail = mergeNumericFragmentsUnbounded([...rawTail]);
  while (mergedTail.length < tailSize) mergedTail.unshift("");
  const middle = rawFields.slice(1, rawFields.length - tailSize);
  const narration = middle.join(",").trim();
  return { date: rawFields[0]?.trim() ?? "", narration, tail: mergedTail };
}

function mergeNumericFragmentsUnbounded(fields: string[]): string[] {
  const isFragmentA = (s: string) => /^[+\-]?\d{1,3}(,\d{2,3})*$/.test(s);
  const isFragmentB = (s: string) => /^\d{2,3}(?:\.\d{1,2})?$/.test(s);
  const result = [...fields];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < result.length - 1; i++) {
      if (isFragmentA(result[i]) && isFragmentB(result[i + 1])) {
        result.splice(i, 2, `${result[i]},${result[i + 1]}`);
        changed = true;
        break;
      }
    }
  }
  return result;
}

const BANK_COLUMN_MAPS: Array<{
  match: RegExp;
  map: Record<string, string[]>;
}> = [
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
  if (isNaN(num) || num === 0) return null;
  return num;
}

function parseDate(val: string | undefined | null): string {
  if (!val || val.trim() === "") return new Date().toISOString().slice(0, 10);
  const v = val.trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);

  const dmy4 = v.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy4) return `${dmy4[3]}-${dmy4[2].padStart(2, "0")}-${dmy4[1].padStart(2, "0")}`;

  const dMonY = v.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/](\d{4})$/);
  if (dMonY) {
    const mm = MONTH_MAP[dMonY[2].slice(0, 3).toLowerCase()];
    if (mm) return `${dMonY[3]}-${mm}-${dMonY[1].padStart(2, "0")}`;
  }

  const dMonYY = v.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/](\d{2})$/);
  if (dMonYY) {
    const mm = MONTH_MAP[dMonYY[2].slice(0, 3).toLowerCase()];
    if (mm) {
      const yr = parseInt(dMonYY[3], 10);
      const fullYear = yr >= 0 && yr <= 30 ? 2000 + yr : 1900 + yr;
      return `${fullYear}-${mm}-${dMonYY[1].padStart(2, "0")}`;
    }
  }

  const dmy2 = v.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})$/);
  if (dmy2) {
    const yr = parseInt(dmy2[3], 10);
    const fullYear = yr >= 0 && yr <= 30 ? 2000 + yr : 1900 + yr;
    return `${fullYear}-${dmy2[2].padStart(2, "0")}-${dmy2[1].padStart(2, "0")}`;
  }

  const d = new Date(v);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function extractUTR(narration: string): string | null {
  const utrMatch = narration.match(/\b([A-Z]{4}\d{18})\b/);
  if (utrMatch) return utrMatch[1];

  const neftMatch = narration.match(/(?:NEFT|RTGS|IMPS)[\/\-\s]([A-Z0-9]{8,22})/i);
  if (neftMatch) return neftMatch[1];

  const upiRefMatch = narration.match(/UPI[\/\-\s](?:[A-Z0-9]+[\/\-])?(\d{10,15})/i);
  if (upiRefMatch) return upiRefMatch[1];

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

    let debit = parseAmount(debitCol ? row[debitCol] : null);
    let credit = parseAmount(creditCol ? row[creditCol] : null);

    if (debit !== null && debit < 0) { debit = Math.abs(debit); }

    if (debit === null && credit === null) {
      const amountCol = findColumn(headers, [
        "amount", "transaction amount", "dr./cr.", "dr/cr", "debit/credit",
        "withdrawal/deposit", "withdrawals/deposits",
      ]);
      if (amountCol && amountCol !== debitCol && amountCol !== creditCol) {
        const raw = (row[amountCol] ?? "")
          .replace(/[₹,\s]/g, "")
          .replace(/^\((.+)\)$/, "-$1");
        const num = parseFloat(raw);
        if (!isNaN(num) && num !== 0) {
          if (num < 0) debit = Math.abs(num);
          else credit = num;
        }
      }
    }

    if (debit === null && credit === null) continue;
    if (narration.toLowerCase().includes("opening balance") || narration.toLowerCase().includes("closing balance")) continue;

    transactions.push({
      date: parseDate(dateCol ? row[dateCol] : null),
      narration: narration.trim(),
      ref_number: rawRef?.trim() || utrFromNarration || null,
      debit,
      credit,
      balance: parseAmount(balanceCol ? row[balanceCol] : null),
      raw_row: row,
    });
  }

  return transactions;
}

export function parseCSV(content: string): BankTransaction[] {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  const isHeaderLine = (l: string) => {
    const lower = l.toLowerCase();
    const hasDate = /\bdate\b|\btxn\b|\bsl\.?\s*no\b/.test(lower);
    const hasAmount = /balance|withdrawal|deposit|debit|credit|amount/.test(lower);
    return hasDate && hasAmount;
  };
  const headerLineIdx = lines.findIndex((l) => isHeaderLine(l.trim()));
  if (headerLineIdx === -1) return [];

  const rawHeaderFields = splitCsvLine(lines[headerLineIdx]).map((h) => h.replace(/^"|"$/g, "").trim());
  while (rawHeaderFields.length > 0 && rawHeaderFields[rawHeaderFields.length - 1] === "") rawHeaderFields.pop();
  const headers = rawHeaderFields;
  const bankMap = detectBankMap(headers);
  const rightFixed = computeNumericTailCount(headers);
  console.log(`[CSV parser] headers=${JSON.stringify(headers)}, rightFixed=${rightFixed}`);

  const tailHeaders = headers.slice(headers.length - rightFixed);
  const debitTailCol  = findColumn(tailHeaders, bankMap.debit);
  const creditTailCol = findColumn(tailHeaders, bankMap.credit);
  const balanceTailCol = findColumn(tailHeaders, bankMap.balance);

  const transactions: BankTransaction[] = [];

  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const rawFields = splitCsvLine(line);
    while (rawFields.length > 1 && rawFields[rawFields.length - 1] === "") rawFields.pop();
    if (rawFields.length < 2) continue;

    const { date: dateStr, narration, tail } = reconstructRow(rawFields, rightFixed);

    if (!dateStr || !/\d/.test(dateStr)) continue;

    const tailMap: Record<string, string> = {};
    tailHeaders.forEach((h, idx) => { tailMap[h] = tail[idx] ?? ""; });

    let debit  = parseAmount(debitTailCol  ? tailMap[debitTailCol]  : null);
    let credit = parseAmount(creditTailCol ? tailMap[creditTailCol] : null);

    if (debit !== null && debit < 0) { debit = Math.abs(debit); }

    if (debit === null && credit === null) {
      const amountTailCol = findColumn(tailHeaders, [
        "amount", "transaction amount", "dr./cr.", "dr/cr", "debit/credit",
        "withdrawal/deposit", "withdrawals/deposits",
      ]);
      if (amountTailCol) {
        const raw = (tailMap[amountTailCol] ?? "")
          .replace(/[₹,\s]/g, "")
          .replace(/^\((.+)\)$/, "-$1");
        const num = parseFloat(raw);
        if (!isNaN(num) && num !== 0) {
          if (num < 0) debit = Math.abs(num);
          else credit = num;
        }
      }
    }

    if (debit === null && credit === null) continue;
    if (/opening balance|closing balance/i.test(narration)) continue;

    const utrFromNarration = extractUTR(narration);

    transactions.push({
      date: parseDate(dateStr),
      narration: narration,
      ref_number: utrFromNarration,
      debit,
      credit,
      balance: parseAmount(balanceTailCol ? tailMap[balanceTailCol] : null),
      raw_row: tailMap,
    });
  }

  return transactions;
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
  doc_type: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_amount: number | null;
  tds_amount: number | null;
  vendor_name: string | null;
  buyer_name: string | null;
  vendor_gstin?: string | null;
  payment_reference: string | null;
  suggested_ledger: string | null;
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

export const BLOCKED_NARRATION_PATTERNS = [
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

  if (BLOCKED_NARRATION_PATTERNS.some((p) => p.test(narr))) {
    return { score: 0, reasons: [] };
  }

  const isSales = invoice.doc_type === "sales_invoice";
  const isPurchase = invoice.doc_type === "purchase_invoice" || invoice.doc_type === "expense";
  if (isSales && txn.debit && !txn.credit) return { score: 0, reasons: [] };
  if (isPurchase && txn.credit && !txn.debit) return { score: 0, reasons: [] };

  let score = 0;
  const reasons: string[] = [];

  const txnAmount = isSales ? (txn.credit ?? 0) : (txn.debit ?? txn.credit ?? 0);
  const invoiceAmount = invoice.total_amount ?? 0;
  const netAfterTds = invoiceAmount - (invoice.tds_amount ?? 0);

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

  if (invoice.invoice_number) {
    const inv = invoice.invoice_number.toLowerCase().replace(/[\s\-\/]/g, "");
    const narrClean = narr.toLowerCase().replace(/[\s\-\/]/g, "");
    const hasDigit = /\d/.test(inv);
    if (inv.length >= 6 && hasDigit) {
      const escaped = inv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const wordBoundaryMatch = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(narrClean);
      if (wordBoundaryMatch) {
        score += 45; reasons.push("Invoice number in narration");
      }
    }
  }

  if (invoice.payment_reference && txn.ref_number) {
    const txnRef = txn.ref_number.trim();
    const invRef = invoice.payment_reference.trim();
    if (txnRef === invRef) {
      score += 55; reasons.push("UTR/reference number matches");
    } else if (txnRef.length >= 8 && invRef.length >= 8 && (txnRef.includes(invRef) || invRef.includes(txnRef))) {
      score += 35; reasons.push("Reference number partial match");
    }
  }

  if (invoice.payment_reference) {
    const invRef = invoice.payment_reference.replace(/\s/g, "");
    const narrClean = narr.replace(/\s/g, "");
    if (invRef.length >= 8 && narrClean.includes(invRef)) {
      score += 45; reasons.push("Payment reference found in narration");
    }
  }

  if (invoice.vendor_gstin && invoice.vendor_gstin.length >= 15) {
    const gstinClean = invoice.vendor_gstin.replace(/\s/g, "").toUpperCase();
    const narrUp = narr.replace(/\s/g, "").toUpperCase();
    if (narrUp.includes(gstinClean)) {
      score += 40; reasons.push("Vendor GSTIN in narration");
    }
  }

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

// Keep Papa in scope — it's imported above and used indirectly by CSV callers
void Papa;
