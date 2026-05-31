// Tally Bank Book Parser
// Parses Tally-exported bank ledger Excel/CSV files to extract historical transaction rows.
// Used for creating ledger mapping rules from historical CA-assigned ledger names.

import * as XLSX from "xlsx";
import { extractPattern } from "@/lib/ledger-rules";

// ─── Public interfaces ───────────────────────────────────────────────────────

export interface SubRow {
  particulars: string;    // narration/ledger from accountant explaining the breakup
  debit: number | null;
  credit: number | null;
  voucher_type: string | null;
}

export interface BankBookRow {
  date: string;           // YYYY-MM-DD
  particulars: string;    // ledger/party name the CA assigned
  voucher_type: string | null;
  debit: number | null;
  credit: number | null;
  subRows?: SubRow[];     // Tally breakup rows (no date) that follow this entry
}

export interface ColumnMapping {
  date: string | null;
  particulars: string | null;
  debit: string | null;
  credit: string | null;
  voucher_type: string | null;
}

export interface BankBookParseResult {
  rows: BankBookRow[];
  columnMapping: ColumnMapping;
  preview: Record<string, string>[];  // first 5 raw data rows (for column mapping UI)
  detectionConfident: boolean;        // true if columns were auto-detected confidently
  rawHeaders: string[];               // all detected column headers
}

// ─── Month map for DD-Mon-YY(YY) format ─────────────────────────────────────

const MONTH_MAP: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// ─── Helper: parse date from various formats ─────────────────────────────────

function parseDate(val: unknown): string | null {
  if (val === null || val === undefined || val === "") return null;

  // Excel serial number (numeric type from XLSX when cellDates:false)
  if (typeof val === "number") {
    try {
      const parsed = XLSX.SSF.parse_date_code(val);
      if (parsed && parsed.y && parsed.m && parsed.d) {
        const y = String(parsed.y).padStart(4, "0");
        const m = String(parsed.m).padStart(2, "0");
        const d = String(parsed.d).padStart(2, "0");
        return `${y}-${m}-${d}`;
      }
    } catch {
      // fall through to string parsing
    }
    return null;
  }

  const v = String(val).trim();
  if (!v) return null;

  // ISO: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);

  // DD-Mon-YY or DD-Mon-YYYY (e.g. "01-Apr-23", "01-Apr-2023")
  // Also handles DD/Mon/YY and DD Mon YY
  const dMonY = v.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/](\d{2,4})$/);
  if (dMonY) {
    const mm = MONTH_MAP[dMonY[2].slice(0, 3).toLowerCase()];
    if (mm) {
      const rawYear = parseInt(dMonY[3], 10);
      const yr = dMonY[3].length === 2
        ? (rawYear >= 0 && rawYear <= 30 ? 2000 + rawYear : 1900 + rawYear)
        : rawYear;
      return `${yr}-${mm}-${dMonY[1].padStart(2, "0")}`;
    }
  }

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const dmy4 = v.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy4) {
    return `${dmy4[3]}-${dmy4[2].padStart(2, "0")}-${dmy4[1].padStart(2, "0")}`;
  }

  // DD/MM/YY
  const dmy2 = v.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})$/);
  if (dmy2) {
    const yr = parseInt(dmy2[3], 10);
    const fullYear = yr >= 0 && yr <= 30 ? 2000 + yr : 1900 + yr;
    return `${fullYear}-${dmy2[2].padStart(2, "0")}-${dmy2[1].padStart(2, "0")}`;
  }

  // Native Date parse fallback
  const d = new Date(v);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return null;
}

// ─── Helper: parse amount ────────────────────────────────────────────────────

function parseAmount(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;

  if (typeof val === "number") {
    if (isNaN(val) || val === 0) return null;
    return val;
  }

  const s = String(val)
    .replace(/[₹,\s]/g, "")
    .replace(/^\((.+)\)$/, "-$1")
    .trim();

  if (!s || s === "-") return null;
  const n = parseFloat(s);
  if (isNaN(n) || n === 0) return null;
  return n;
}

// ─── Helper: detect columns from header row ──────────────────────────────────

function detectColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {
    date: null,
    particulars: null,
    debit: null,
    credit: null,
    voucher_type: null,
  };

  for (const h of headers) {
    const norm = h.trim().toLowerCase();

    if (!mapping.date && /^(date|dt|transaction\s*date|txn\s*date|value\s*date)$/.test(norm)) {
      mapping.date = h;
    } else if (!mapping.particulars && /^(particulars|narration|description|ledger|name|account|towards|remarks|account\s*name)$/.test(norm)) {
      mapping.particulars = h;
    } else if (!mapping.debit && /^(debit|dr|withdrawal|paid|debit\s*amount|dr\.?\s*amount|withdrawals|debit\s*\(rs\.\))$/.test(norm)) {
      mapping.debit = h;
    } else if (!mapping.credit && /^(credit|cr|deposit|received|credit\s*amount|cr\.?\s*amount|deposits|credit\s*\(rs\.\))$/.test(norm)) {
      mapping.credit = h;
    } else if (!mapping.voucher_type && /^(vch\s*type|voucher\s*type|type|vch\.?\s*type|transaction\s*type)$/.test(norm)) {
      mapping.voucher_type = h;
    }
  }

  return mapping;
}

// ─── Main export: parseTallyBankBook ────────────────────────────────────────

export function parseTallyBankBook(buffer: ArrayBuffer, fileName: string): BankBookParseResult {
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

  // ── Find header row by scanning first 30 rows ───────────────────────────
  let headerRowIndex = -1;
  let detectedMapping: ColumnMapping = { date: null, particulars: null, debit: null, credit: null, voucher_type: null };
  let rawHeaders: string[] = [];

  for (let i = 0; i < Math.min(30, rawRows.length); i++) {
    const row = rawRows[i];
    const stringVals = (row as unknown[]).map((c) => String(c ?? "").trim());
    const mapping = detectColumns(stringVals);

    if (mapping.date && mapping.particulars && (mapping.debit || mapping.credit)) {
      headerRowIndex = i;
      detectedMapping = mapping;
      rawHeaders = stringVals;
      break;
    }
  }

  // ── Positional fallback ─────────────────────────────────────────────────
  if (headerRowIndex === -1) {
    for (let i = 0; i < Math.min(30, rawRows.length); i++) {
      const row = rawRows[i];
      const firstCell = (row as unknown[])[0];
      if (parseDate(firstCell) !== null) {
        // Found first row that looks like a date — treat as data start with Tally positional order:
        // Date | Particulars | Vch Type | Vch No | Debit | Credit | Balance
        headerRowIndex = i - 1; // "header" is the row before, but we'll set it to i
        // Since there's no actual header row, synthesise column names by index
        const syntheticHeaders = ["Date", "Particulars", "Vch Type", "Vch No", "Debit", "Credit", "Balance"];
        rawHeaders = syntheticHeaders;
        detectedMapping = {
          date: "Date",
          particulars: "Particulars",
          voucher_type: "Vch Type",
          debit: "Debit",
          credit: "Credit",
        };
        // Point headerRowIndex to synthetic header (data starts at i)
        headerRowIndex = i - 1;
        break;
      }
    }
  }

  const detectionConfident =
    detectedMapping.date !== null &&
    detectedMapping.particulars !== null &&
    (detectedMapping.debit !== null || detectedMapping.credit !== null);

  // ── Determine data start row ────────────────────────────────────────────
  // If we found a real header row (not synthetic), data starts at headerRowIndex+1
  // For positional fallback (synthetic), the first date-like row is our data start
  let dataStartIndex: number;
  if (rawHeaders[0] === "Date" && rawHeaders[1] === "Particulars" && headerRowIndex >= 0) {
    // Check if the actual row at headerRowIndex+1 has a date
    const nextRow = rawRows[headerRowIndex + 1] as unknown[];
    if (nextRow && parseDate(nextRow[0]) !== null) {
      dataStartIndex = headerRowIndex + 1;
    } else {
      // Synthetic fallback: find the first row with a parseable date
      dataStartIndex = rawRows.findIndex((r) => parseDate((r as unknown[])[0]) !== null);
      if (dataStartIndex === -1) dataStartIndex = 0;
    }
  } else {
    dataStartIndex = headerRowIndex >= 0 ? headerRowIndex + 1 : 0;
  }

  // Map rawHeaders to column indices for positional fallback case
  // For real header rows, headers are the actual strings; build index map
  const headerIndexMap: Record<string, number> = {};
  if (headerRowIndex >= 0 && rawHeaders.length > 0) {
    const actualHeaderRow = rawRows[headerRowIndex] as unknown[];
    if (actualHeaderRow) {
      actualHeaderRow.forEach((cell, idx) => {
        const key = String(cell ?? "").trim();
        if (key) headerIndexMap[key] = idx;
      });
    } else {
      // Synthetic headers
      rawHeaders.forEach((h, idx) => { headerIndexMap[h] = idx; });
    }
  } else {
    rawHeaders.forEach((h, idx) => { headerIndexMap[h] = idx; });
  }

  // ── Build preview (first 5 data rows) ───────────────────────────────────
  const preview: Record<string, string>[] = [];
  for (let i = dataStartIndex; i < Math.min(dataStartIndex + 5, rawRows.length); i++) {
    const row = rawRows[i] as unknown[];
    const record: Record<string, string> = {};
    rawHeaders.forEach((h, idx) => {
      record[h] = String(row[idx] ?? "").trim();
    });
    preview.push(record);
  }

  // ── Parse data rows ──────────────────────────────────────────────────────
  const rows: BankBookRow[] = [];

  const dateIdx = detectedMapping.date ? headerIndexMap[detectedMapping.date] ?? -1 : -1;
  const particIdx = detectedMapping.particulars ? headerIndexMap[detectedMapping.particulars] ?? -1 : -1;
  const debitIdx = detectedMapping.debit ? headerIndexMap[detectedMapping.debit] ?? -1 : -1;
  const creditIdx = detectedMapping.credit ? headerIndexMap[detectedMapping.credit] ?? -1 : -1;
  const vchTypeIdx = detectedMapping.voucher_type ? headerIndexMap[detectedMapping.voucher_type] ?? -1 : -1;

  const SKIP_PARTICULARS = /^(total|opening|closing|balance|grand\s*total|by\s*balance|to\s*balance)/i;

  for (let i = dataStartIndex; i < rawRows.length; i++) {
    const row = rawRows[i] as unknown[];

    const dateCell = dateIdx >= 0 ? row[dateIdx] : row[0];
    const parsedDate = parseDate(dateCell);

    // No date = Tally breakup sub-row (accountant explanation for the preceding entry)
    if (!parsedDate) {
      if (rows.length === 0) continue;
      const subPartRaw = particIdx >= 0 ? row[particIdx] : row[1];
      let subPart = String(subPartRaw ?? "").trim();
      if (/^(to|by)$/i.test(subPart)) subPart = String(row[particIdx >= 0 ? particIdx + 1 : 2] ?? "").trim();
      else subPart = subPart.replace(/^(to|by)\s+/i, "").trim();
      // Tally "By"/"To" | name format: particulars col is empty in sub-rows; name is in the adjacent col
      if (!subPart && particIdx >= 0) subPart = String(row[particIdx + 1] ?? "").trim();
      if (!subPart || SKIP_PARTICULARS.test(subPart)) continue;
      const subDebit = debitIdx >= 0 ? parseAmount(row[debitIdx]) : null;
      const subCredit = creditIdx >= 0 ? parseAmount(row[creditIdx]) : null;
      if (subDebit === null && subCredit === null) continue;
      const subVch = vchTypeIdx >= 0 ? String(row[vchTypeIdx] ?? "").trim() || null : null;
      const last = rows[rows.length - 1];
      if (!last.subRows) last.subRows = [];
      last.subRows.push({ particulars: subPart, debit: subDebit, credit: subCredit, voucher_type: subVch });
      continue;
    }

    const particularsRaw = particIdx >= 0 ? row[particIdx] : row[1];
    let particulars = String(particularsRaw ?? "").trim();

    // Tally sometimes exports direction ("To"/"By") and ledger name in adjacent columns.
    // If this cell is just the direction marker, grab the actual ledger from the next column.
    if (/^(to|by)$/i.test(particulars)) {
      const nextIdx = particIdx >= 0 ? particIdx + 1 : 2;
      particulars = String(row[nextIdx] ?? "").trim();
    } else {
      // Strip "To "/"By " prefix when bundled in the same cell ("To HDFC Bank" → "HDFC Bank")
      particulars = particulars.replace(/^(to|by)\s+/i, "").trim();
    }

    if (!particulars) continue;
    if (SKIP_PARTICULARS.test(particulars)) continue;

    const debit = debitIdx >= 0 ? parseAmount(row[debitIdx]) : null;
    const credit = creditIdx >= 0 ? parseAmount(row[creditIdx]) : null;
    if (debit === null && credit === null) continue;

    const voucherTypeRaw = vchTypeIdx >= 0 ? row[vchTypeIdx] : null;
    const voucher_type = voucherTypeRaw ? String(voucherTypeRaw).trim() || null : null;

    rows.push({
      date: parsedDate,
      particulars,
      voucher_type,
      debit,
      credit,
    });
  }

  return {
    rows,
    columnMapping: detectedMapping,
    preview,
    detectionConfident,
    rawHeaders,
  };
}

// ─── Helper: group rows by particulars ──────────────────────────────────────

export function groupByParticulars(
  rows: BankBookRow[]
): Map<string, { debit_total: number; credit_total: number; count: number; sample_date: string }> {
  const map = new Map<string, { debit_total: number; credit_total: number; count: number; sample_date: string }>();

  for (const row of rows) {
    const key = row.particulars.trim();
    const existing = map.get(key);
    if (existing) {
      existing.debit_total += row.debit ?? 0;
      existing.credit_total += row.credit ?? 0;
      existing.count += 1;
    } else {
      map.set(key, {
        debit_total: row.debit ?? 0,
        credit_total: row.credit ?? 0,
        count: 1,
        sample_date: row.date,
      });
    }
  }

  return map;
}

// Re-export extractPattern so callers can import from one place if needed
export { extractPattern };
