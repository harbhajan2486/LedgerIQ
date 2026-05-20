import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import * as XLSX from "xlsx";

// Tally Group → our ledger_type mapping
const TALLY_GROUP_MAP: Record<string, string> = {
  // Bank / Cash
  "bank accounts":             "bank",
  "bank od accounts":          "bank",
  "bank od account":           "bank",
  "cash-in-hand":              "bank",
  "cash in hand":              "bank",
  // Capital
  "capital account":           "capital",
  "reserves & surplus":        "capital",
  "reserves and surplus":      "capital",
  "drawings":                  "capital",
  // Liability
  "current liabilities":       "liability",
  "loans (liability)":         "liability",
  "sundry creditors":          "liability",
  "provisions":                "liability",
  "secured loans":             "liability",
  "unsecured loans":           "liability",
  "bank od":                   "liability",
  // Tax
  "duties & taxes":            "tax",
  "duties and taxes":          "tax",
  // Income
  "sales accounts":            "income",
  "direct income":             "income",
  "indirect income":           "income",
  "other income":              "income",
  // Expense
  "purchase accounts":         "expense",
  "direct expenses":           "expense",
  "indirect expenses":         "expense",
  "manufacturing expenses":    "expense",
  // Asset
  "current assets":            "asset",
  "sundry debtors":            "asset",
  "loans & advances (asset)":  "asset",
  "loans and advances (asset)":"asset",
  "fixed assets":              "asset",
  "investments":               "asset",
  "stock-in-hand":             "asset",
  "stock in hand":             "asset",
  "deposits (asset)":          "asset",
  "deposits":                  "asset",
  "miscellaneous expenses (asset)": "asset",
};

const VALID_TYPES = new Set(["expense","income","asset","liability","capital","bank","tax"]);

function mapTallyGroup(group: string): string {
  const key = (group ?? "").toLowerCase().trim();
  return TALLY_GROUP_MAP[key] ?? "expense";
}

/** Parse a numeric amount string — strips ₹, commas, whitespace, handles (negative) */
function parseAmt(val: string | number | undefined | null): number | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number") return isNaN(val) ? null : Math.abs(val);
  const s = String(val).replace(/[₹,\s]/g, "").replace(/^\((.+)\)$/, "-$1").trim();
  if (!s || s === "-") return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.abs(n);
}

/**
 * Parse a Tally trial balance Excel in "raw array" mode.
 *
 * Handles three common Tally export layouts:
 *
 * Layout A — 3-col (Name | Dr | Cr):
 *   ["Capital Account",  "",  195313]   ← group row (in TALLY_GROUP_MAP, or both sides non-zero)
 *   ["  Proprietor Capital",  "",  195313]  ← ledger row (leading whitespace on name)
 *
 * Layout B — 4-col (Group/Under | Name | Dr | Cr):
 *   ["Capital Account",  "Proprietor Capital",  "",  195313]
 *   ["Indirect Expenses", "Rent",  120000,  ""]
 *
 * Layout C — 5-col with opening+closing (Name | OpDr | OpCr | ClDr | ClCr):
 *   ["Capital Account",  0,  195313,  0,  195313]  ← both closing sides same
 *   ["  Proprietor Capital",  0,  195313,  0,  195313]
 *
 * Indentation rule (Layout A): group rows have no leading whitespace; ledger rows do.
 * If NO rows are indented, fall back to hasDr&&hasCr / TALLY_GROUP_MAP group detection.
 */
function parseTallyRawArrays(
  rawRows: unknown[][],
  financialYear: string | null
): { ledgers: LedgerRow[]; skipped: string[] } {
  const ledgers: LedgerRow[] = [];
  const skipped: string[] = [];

  function isNumericCell(v: unknown): boolean {
    if (typeof v === "number") return !isNaN(v) && v !== 0;
    if (typeof v === "string") return v.trim() !== "" && !isNaN(parseFloat((v as string).replace(/[₹,\s]/g, "")));
    return false;
  }

  // ── Find data start: first row where at least one column past col[0] is numeric ──
  let dataStart = -1;
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!String(row[0] ?? "").trim()) continue;
    if (row.slice(1).some(isNumericCell)) { dataStart = i; break; }
  }
  if (dataStart === -1) return { ledgers, skipped };

  // ── Detect layout by sampling first 20 data rows ──────────────────────────────
  const sample = rawRows.slice(dataStart, dataStart + 20);

  // Layout B: col[1] is consistently non-numeric text (the real ledger name)
  const col1AsString = sample.filter(r => {
    const v = r[1];
    return typeof v === "string" && v.trim() !== "" && !isNumericCell(v);
  }).length;
  const isLayoutB = col1AsString >= Math.ceil(sample.length * 0.5);

  // Layout C: 5+ numeric columns (opening+closing balances)
  const avgNumericCols = sample.reduce((s, r) => s + r.slice(1).filter(isNumericCell).length, 0) / Math.max(sample.length, 1);
  const isLayoutC = !isLayoutB && avgNumericCols >= 3;

  // Layout A with indentation: any row in col[0] has leading whitespace
  const hasIndentedRows = !isLayoutB && !isLayoutC && rawRows.slice(dataStart).some(r => {
    const raw = String(r[0] ?? "");
    return raw !== raw.trimStart() && raw.trim().length > 0;
  });

  // ── Layout B: Group | LedgerName | Dr | Cr ──────────────────────────────
  if (isLayoutB) {
    let currentGroup = "";
    for (let i = dataStart; i < rawRows.length; i++) {
      const row = rawRows[i];
      const groupRaw = String(row[0] ?? "").trim();
      const ledgerRaw = String(row[1] ?? "").trim();
      if (!ledgerRaw) continue;
      if (/^(particulars|ledger|name|debit|credit|dr|cr|closing|opening|under|group)$/i.test(ledgerRaw)) continue;
      if (ledgerRaw.length > 150) { skipped.push(ledgerRaw.slice(0, 30) + "…"); continue; }

      const drAmt = parseAmt(row[2] as string | number | null);
      const crAmt = parseAmt(row[3] as string | number | null);
      const hasDr = drAmt !== null && drAmt > 0;
      const hasCr = crAmt !== null && crAmt > 0;
      if (groupRaw) currentGroup = groupRaw;

      let closingBalance: number | null = null;
      let balanceType: "Dr" | "Cr" | null = null;
      if (hasDr) { closingBalance = drAmt!; balanceType = "Dr"; }
      else if (hasCr) { closingBalance = crAmt!; balanceType = "Cr"; }

      ledgers.push({
        tenant_id: "", client_id: "",
        ledger_name: ledgerRaw,
        ledger_type: mapTallyGroup(currentGroup || groupRaw),
        tally_group: currentGroup || groupRaw || null,
        financial_year: financialYear,
        closing_balance: closingBalance,
        balance_type: balanceType,
        opening_balance: null,
        source: "trial_balance",
      });
    }
  }

  // ── Layout A with indentation: two-pass to correctly skip group/sub-group rows ──
  // A row is a group/sub-group header (not a ledger) when the NEXT non-empty row
  // has strictly deeper indentation. This handles any number of nesting levels.
  else if (hasIndentedRows) {
    type DataRow = { name: string; indent: number; dr: number | null; cr: number | null };
    const dataRows: DataRow[] = [];

    for (let i = dataStart; i < rawRows.length; i++) {
      const row = rawRows[i];
      const rawStr = String(row[0] ?? "");
      const name = rawStr.trim();
      if (!name) continue;
      if (/^(particulars|ledger|name|debit|credit|dr|cr|closing|opening)$/i.test(name)) continue;
      if (name.length > 150) { skipped.push(name.slice(0, 30) + "…"); continue; }
      dataRows.push({
        name,
        indent: rawStr.length - rawStr.trimStart().length,
        dr: parseAmt(row[1] as string | number | null),
        cr: parseAmt(row[2] as string | number | null),
      });
    }

    let curGroup = "";
    for (let j = 0; j < dataRows.length; j++) {
      const { name, indent, dr, cr } = dataRows[j];
      const nextIndent = j + 1 < dataRows.length ? dataRows[j + 1].indent : -1;

      if (nextIndent > indent) {
        // Header row (group or sub-group) — becomes the tally_group for children
        curGroup = name;
        continue;
      }

      const hasDr = dr !== null && dr > 0;
      const hasCr = cr !== null && cr > 0;
      let closingBalance: number | null = null;
      let balanceType: "Dr" | "Cr" | null = null;
      if (hasDr) { closingBalance = dr!; balanceType = "Dr"; }
      else if (hasCr) { closingBalance = cr!; balanceType = "Cr"; }

      ledgers.push({
        tenant_id: "", client_id: "",
        ledger_name: name,
        ledger_type: curGroup ? mapTallyGroup(curGroup) : "expense",
        tally_group: curGroup || null,
        financial_year: financialYear,
        closing_balance: closingBalance,
        balance_type: balanceType,
        opening_balance: null,
        source: "trial_balance",
      });
    }
  }

  // ── Layout A/C without indentation: heuristic group detection ────────────
  else {
    let currentGroup = "";
    for (let i = dataStart; i < rawRows.length; i++) {
      const row = rawRows[i];
      const name = String(row[0] ?? "").trim();
      if (!name) continue;
      if (/^(particulars|ledger|name|debit|credit|dr|cr|closing|opening)$/i.test(name)) continue;
      if (name.length > 150) { skipped.push(name.slice(0, 30) + "…"); continue; }

      let drAmt: number | null;
      let crAmt: number | null;
      if (isLayoutC) {
        drAmt = parseAmt(row[3] as string | number | null);
        crAmt = parseAmt(row[4] as string | number | null);
      } else {
        drAmt = parseAmt(row[1] as string | number | null);
        crAmt = parseAmt(row[2] as string | number | null);
      }

      const hasDr = drAmt !== null && drAmt > 0;
      const hasCr = crAmt !== null && crAmt > 0;
      const isKnownGroup = TALLY_GROUP_MAP[name.toLowerCase()] !== undefined;

      if (hasDr && hasCr) { currentGroup = name; continue; }
      if (isKnownGroup) { currentGroup = name; continue; }

      let closingBalance: number | null = null;
      let balanceType: "Dr" | "Cr" | null = null;
      if (hasDr) { closingBalance = drAmt!; balanceType = "Dr"; }
      else if (hasCr) { closingBalance = crAmt!; balanceType = "Cr"; }

      ledgers.push({
        tenant_id: "", client_id: "",
        ledger_name: name,
        ledger_type: currentGroup ? mapTallyGroup(currentGroup) : (isKnownGroup ? mapTallyGroup(name) : "expense"),
        tally_group: currentGroup || null,
        financial_year: financialYear,
        closing_balance: closingBalance,
        balance_type: balanceType,
        opening_balance: null,
        source: "trial_balance",
      });
    }
  }

  // Deduplicate by ledger_name — keep last occurrence
  const seen = new Map<string, LedgerRow>();
  for (const l of ledgers) seen.set(l.ledger_name, l);

  return { ledgers: Array.from(seen.values()), skipped };
}

type LedgerRow = {
  tenant_id: string;
  client_id: string;
  ledger_name: string;
  ledger_type: string;
  tally_group: string | null;
  financial_year: string | null;
  closing_balance: number | null;
  balance_type: "Dr" | "Cr" | null;
  opening_balance: number | null;
  source: string;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const { id: clientId } = await params;

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const financialYear = (formData.get("financial_year") as string | null)?.trim() || null;

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  const fileName = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();

  let wb: XLSX.WorkBook;
  try {
    if (fileName.endsWith(".csv")) {
      const text = new TextDecoder().decode(buffer);
      wb = XLSX.read(text, { type: "string" });
    } else if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
      wb = XLSX.read(buffer, { type: "array" });
    } else {
      return NextResponse.json({ error: "Upload CSV or Excel file" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Could not read file" }, { status: 400 });
  }

  const ws = wb.Sheets[wb.SheetNames[0]];

  // ── Try raw array mode first (Tally trial balance format) ─────────────────
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });

  if (rawRows.length === 0) {
    return NextResponse.json({ error: "No rows found in file" }, { status: 400 });
  }

  // Detect if this is a flat structured CSV (row 0 IS the header row with column names)
  // vs a Tally trial balance (row 0 is a company name, headers are buried in rows 4-6)
  // Only check row 0 — Tally files have "Particulars" in row 4, which must NOT trigger this
  const firstRowHasHeaders = /^(name|ledger\s*name|particulars|ledger|type|under|group|closing\s*bal|debit|credit)$/i.test(
    String(rawRows[0]?.[0] ?? "").trim()
  );

  if (!firstRowHasHeaders) {
    // Tally trial balance raw array format
    const { ledgers, skipped } = parseTallyRawArrays(rawRows, financialYear);

    if (ledgers.length === 0) {
      return NextResponse.json({ error: "No valid ledger rows found. Please check the file format." }, { status: 400 });
    }

    const ledgerRows = ledgers.map(l => ({
      ...l,
      tenant_id: profile.tenant_id,
      client_id: clientId,
    }));

    const { error } = await supabase
      .from("ledger_masters")
      .upsert(ledgerRows, { onConflict: "tenant_id,client_id,ledger_name", ignoreDuplicates: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      imported: ledgerRows.length,
      skipped: skipped.length,
      skipped_names: skipped.slice(0, 5),
      has_balance_data: ledgerRows.some(l => l.closing_balance !== null),
      financial_year: financialYear,
    });
  }

  // ── Fallback: structured CSV/Excel with named columns ────────────────────
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });

  if (rows.length === 0) return NextResponse.json({ error: "No rows found in file" }, { status: 400 });

  const firstRow = rows[0];
  const cols = Object.keys(firstRow).map((k) => k.toLowerCase().trim());

  const nameCol  = Object.keys(firstRow).find((k) => /^(name|ledger\s*name|ledger|particulars)$/i.test(k.trim()));
  const groupCol = Object.keys(firstRow).find((k) => /^(under|group|parent\s*group|under\s*group)$/i.test(k.trim()));
  const typeCol  = Object.keys(firstRow).find((k) => /^(type|ledger\s*type)$/i.test(k.trim()));

  if (!nameCol) {
    return NextResponse.json({
      error: `Could not find ledger name column. Found: ${cols.join(", ")}. Expected "Name", "Ledger Name", or "Particulars".`,
    }, { status: 400 });
  }

  const closingCol    = Object.keys(firstRow).find((k) => /closing\s*bal/i.test(k));
  const drCrCol       = Object.keys(firstRow).find((k) => /^(dr\/?cr|type|dr\.?\/cr\.?)$/i.test(k.trim()) && !/ledger/i.test(k));
  const closingDrCol  = Object.keys(firstRow).find((k) => /closing.*dr|debit.*closing/i.test(k));
  const closingCrCol  = Object.keys(firstRow).find((k) => /closing.*cr|credit.*closing/i.test(k));
  const openingCol    = Object.keys(firstRow).find((k) => /opening\s*bal/i.test(k));
  const openingDrCol  = Object.keys(firstRow).find((k) => /opening.*dr|debit.*opening/i.test(k));
  const openingCrCol  = Object.keys(firstRow).find((k) => /opening.*cr|credit.*opening/i.test(k));
  const debitCol  = !closingDrCol ? Object.keys(firstRow).find((k) => /^debit$|^dr$/i.test(k.trim())) : undefined;
  const creditCol = !closingCrCol ? Object.keys(firstRow).find((k) => /^credit$|^cr$/i.test(k.trim())) : undefined;

  const hasBalanceData = !!(closingCol || closingDrCol || closingCrCol || debitCol || creditCol);

  const ledgerRows: LedgerRow[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const name = String(row[nameCol] ?? "").trim();
    if (!name || /^(name|ledger\s*name|particulars)$/i.test(name)) continue;
    if (name.length > 150) { skipped.push(name.slice(0, 30) + "…"); continue; }

    let ledgerType = "expense";
    const rawGroup = groupCol ? String(row[groupCol] ?? "").trim() : null;
    if (typeCol && VALID_TYPES.has(String(row[typeCol]).toLowerCase().trim())) {
      ledgerType = String(row[typeCol]).toLowerCase().trim();
    } else if (rawGroup) {
      ledgerType = mapTallyGroup(rawGroup);
    }

    let closingBalance: number | null = null;
    let balanceType: "Dr" | "Cr" | null = null;
    let openingBalance: number | null = null;

    if (closingDrCol || closingCrCol) {
      const drAmt = parseAmt(closingDrCol ? row[closingDrCol] : null);
      const crAmt = parseAmt(closingCrCol ? row[closingCrCol] : null);
      if (drAmt && drAmt > 0) { closingBalance = drAmt; balanceType = "Dr"; }
      else if (crAmt && crAmt > 0) { closingBalance = crAmt; balanceType = "Cr"; }

      if (openingDrCol || openingCrCol) {
        const oDr = parseAmt(openingDrCol ? row[openingDrCol] : null);
        const oCr = parseAmt(openingCrCol ? row[openingCrCol] : null);
        openingBalance = (oDr && oDr > 0) ? oDr : (oCr && oCr > 0 ? oCr : null);
      }
    } else if (closingCol) {
      closingBalance = parseAmt(row[closingCol]);
      if (drCrCol) {
        const indicator = String(row[drCrCol] ?? "").trim().toUpperCase();
        balanceType = indicator === "CR" || indicator === "C" ? "Cr" : "Dr";
      }
      if (openingCol) openingBalance = parseAmt(row[openingCol]);
    } else if (debitCol || creditCol) {
      const drAmt = parseAmt(debitCol ? row[debitCol] : null);
      const crAmt = parseAmt(creditCol ? row[creditCol] : null);
      if (drAmt && drAmt > 0) { closingBalance = drAmt; balanceType = "Dr"; }
      else if (crAmt && crAmt > 0) { closingBalance = crAmt; balanceType = "Cr"; }
    }

    ledgerRows.push({
      tenant_id: profile.tenant_id,
      client_id: clientId,
      ledger_name: name,
      ledger_type: ledgerType,
      tally_group: rawGroup || null,
      financial_year: financialYear,
      closing_balance: closingBalance,
      balance_type: balanceType,
      opening_balance: openingBalance,
      source: "trial_balance",
    });
  }

  if (ledgerRows.length === 0) {
    return NextResponse.json({ error: "No valid ledger rows found in file" }, { status: 400 });
  }

  const { error } = await supabase
    .from("ledger_masters")
    .upsert(ledgerRows, { onConflict: "tenant_id,client_id,ledger_name", ignoreDuplicates: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    imported: ledgerRows.length,
    skipped: skipped.length,
    skipped_names: skipped.slice(0, 5),
    has_balance_data: hasBalanceData,
    financial_year: financialYear,
  });
}
