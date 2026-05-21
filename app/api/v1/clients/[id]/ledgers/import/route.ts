import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import * as XLSX from "xlsx";

// Tally Group → ledger_type mapping
const TALLY_GROUP_MAP: Record<string, string> = {
  "bank accounts":                    "bank",
  "bank od accounts":                 "bank",
  "bank od account":                  "bank",
  "cash-in-hand":                     "bank",
  "cash in hand":                     "bank",
  "capital account":                  "capital",
  "reserves & surplus":               "capital",
  "reserves and surplus":             "capital",
  "drawings":                         "capital",
  "current liabilities":              "liability",
  "loans (liability)":                "liability",
  "sundry creditors":                 "liability",
  "provisions":                       "liability",
  "secured loans":                    "liability",
  "unsecured loans":                  "liability",
  "bank od":                          "liability",
  "duties & taxes":                   "tax",
  "duties and taxes":                 "tax",
  "sales accounts":                   "income",
  "direct income":                    "income",
  "indirect income":                  "income",
  "other income":                     "income",
  "purchase accounts":                "expense",
  "direct expenses":                  "expense",
  "indirect expenses":                "expense",
  "manufacturing expenses":           "expense",
  "current assets":                   "asset",
  "sundry debtors":                   "asset",
  "loans & advances (asset)":         "asset",
  "loans and advances (asset)":       "asset",
  "fixed assets":                     "asset",
  "investments":                      "asset",
  "stock-in-hand":                    "asset",
  "stock in hand":                    "asset",
  "deposits (asset)":                 "asset",
  "deposits":                         "asset",
  "miscellaneous expenses (asset)":   "asset",
};

const VALID_TYPES = new Set(["expense", "income", "asset", "liability", "capital", "bank", "tax"]);

function mapTallyGroup(group: string): string {
  return TALLY_GROUP_MAP[(group ?? "").toLowerCase().trim()] ?? "expense";
}

type LedgerRow = {
  tenant_id: string;
  client_id: string;
  ledger_name: string;
  ledger_type: string;
  tally_group: string | null;
  financial_year: null;
  closing_balance: null;
  balance_type: null;
  opening_balance: null;
  source: "ledger_list";
};

const HEADER_RE = /^(name|ledger\s*name?|particulars|account\s*name?|under|group|type|s\.?n\.?o?\.?|sr\.?)$/i;

/**
 * Parse a Tally "List of Accounts" export.
 * No balance columns — this is a ledger name + group import only.
 *
 * Format 1 — Flat 2-col (Name | Under):
 *   ["HDFC Bank", "Bank Accounts"]
 *   ["Rent",      "Indirect Expenses"]
 *
 * Format 2 — Indented single-col (Tally report view):
 *   ["Capital Account"]     ← group/sub-group header (followed by deeper-indented row)
 *   ["  Partner Capital"]   ← leaf ledger (indented child)
 *
 * Format 3 — Single column, no hierarchy info.
 */
function parseLedgerList(rawRows: unknown[][]): { ledgers: LedgerRow[]; skipped: string[] } {
  const ledgers: LedgerRow[] = [];
  const skipped: string[] = [];

  // Find data start: scan first 15 rows for a "Name" header, start after it.
  // If no header found, start from row 0 (plain export with no title rows).
  let dataStart = 0;
  for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
    const cell = String(rawRows[i][0] ?? "").trim();
    if (/^(name|ledger\s*name?|particulars|account\s*name?)$/i.test(cell)) {
      dataStart = i + 1;
      break;
    }
  }

  const dataRows = rawRows.slice(dataStart);
  if (dataRows.length === 0) return { ledgers, skipped };

  // Sample non-empty rows to detect format
  const sample = dataRows.filter(r => String(r[0] ?? "").trim()).slice(0, 30);

  // Format 1: col[1] is consistently non-empty text (the "Under" group column)
  const col1NonEmpty = sample.filter(r => {
    const v = String(r[1] ?? "").trim();
    return v.length > 0 && isNaN(parseFloat(v));
  }).length;
  const isFlatTwoCols = col1NonEmpty >= Math.ceil(sample.length * 0.4);

  // Format 2: col[0] has indented rows (leading whitespace)
  const hasIndentedRows = !isFlatTwoCols && dataRows.some(r => {
    const raw = String(r[0] ?? "");
    return raw !== raw.trimStart() && raw.trim().length > 0;
  });

  // ── Format 1: Name | Under ──────────────────────────────────────────────
  if (isFlatTwoCols) {
    for (const row of dataRows) {
      const name = String(row[0] ?? "").trim();
      const group = String(row[1] ?? "").trim();
      if (!name || HEADER_RE.test(name)) continue;
      if (name.length > 150) { skipped.push(name.slice(0, 30) + "…"); continue; }
      ledgers.push({
        tenant_id: "", client_id: "",
        ledger_name: name,
        ledger_type: mapTallyGroup(group),
        tally_group: group || null,
        financial_year: null, closing_balance: null, balance_type: null, opening_balance: null,
        source: "ledger_list",
      });
    }
  }

  // ── Format 2: indented hierarchy — two-pass ─────────────────────────────
  else if (hasIndentedRows) {
    type Item = { name: string; indent: number };
    const items: Item[] = [];

    for (const row of dataRows) {
      const rawStr = String(row[0] ?? "");
      const name = rawStr.trim();
      if (!name || HEADER_RE.test(name)) continue;
      if (name.length > 150) { skipped.push(name.slice(0, 30) + "…"); continue; }
      items.push({ name, indent: rawStr.length - rawStr.trimStart().length });
    }

    let curGroup = "";
    for (let j = 0; j < items.length; j++) {
      const { name, indent } = items[j];
      const nextIndent = j + 1 < items.length ? items[j + 1].indent : -1;
      if (nextIndent > indent) { curGroup = name; continue; }
      ledgers.push({
        tenant_id: "", client_id: "",
        ledger_name: name,
        ledger_type: curGroup ? mapTallyGroup(curGroup) : "expense",
        tally_group: curGroup || null,
        financial_year: null, closing_balance: null, balance_type: null, opening_balance: null,
        source: "ledger_list",
      });
    }
  }

  // ── Format 3: single column, no group info ──────────────────────────────
  else {
    for (const row of dataRows) {
      const name = String(row[0] ?? "").trim();
      if (!name || HEADER_RE.test(name)) continue;
      if (TALLY_GROUP_MAP[name.toLowerCase()]) continue; // skip group-only rows
      if (name.length > 150) { skipped.push(name.slice(0, 30) + "…"); continue; }
      ledgers.push({
        tenant_id: "", client_id: "",
        ledger_name: name,
        ledger_type: "expense",
        tally_group: null,
        financial_year: null, closing_balance: null, balance_type: null, opening_balance: null,
        source: "ledger_list",
      });
    }
  }

  const seen = new Map<string, LedgerRow>();
  for (const l of ledgers) seen.set(l.ledger_name, l);
  return { ledgers: Array.from(seen.values()), skipped };
}

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
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  const fileName = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();

  let wb: XLSX.WorkBook;
  try {
    if (fileName.endsWith(".csv")) {
      wb = XLSX.read(new TextDecoder().decode(buffer), { type: "string" });
    } else if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
      wb = XLSX.read(buffer, { type: "array" });
    } else {
      return NextResponse.json({ error: "Upload CSV or Excel file" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Could not read file" }, { status: 400 });
  }

  const ws = wb.Sheets[wb.SheetNames[0]];

  // Check if row 0 is a column-header row (plain CSV with headers)
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });
  if (rawRows.length === 0) return NextResponse.json({ error: "No rows found in file" }, { status: 400 });

  const row0col0 = String(rawRows[0]?.[0] ?? "").trim();
  const firstRowIsHeader = /^(name|ledger\s*name?|particulars|ledger|account)$/i.test(row0col0);

  let ledgerRows: LedgerRow[];
  let skipped: string[];

  if (firstRowIsHeader) {
    // Structured flat CSV with column headers in row 0
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });
    if (rows.length === 0) return NextResponse.json({ error: "No rows found in file" }, { status: 400 });

    const firstRow = rows[0];
    const nameCol  = Object.keys(firstRow).find(k => /^(name|ledger\s*name?|particulars|account\s*name?)$/i.test(k.trim()));
    const groupCol = Object.keys(firstRow).find(k => /^(under|group|parent|parent\s*group)$/i.test(k.trim()));
    const typeCol  = Object.keys(firstRow).find(k => /^(type|ledger\s*type)$/i.test(k.trim()));

    if (!nameCol) {
      return NextResponse.json({
        error: `No ledger name column found. Got: ${Object.keys(firstRow).join(", ")}. Expected "Name", "Ledger Name", or "Particulars".`,
      }, { status: 400 });
    }

    ledgerRows = [];
    skipped = [];
    for (const row of rows) {
      const name = String(row[nameCol] ?? "").trim();
      if (!name || HEADER_RE.test(name)) continue;
      if (name.length > 150) { skipped.push(name.slice(0, 30) + "…"); continue; }

      const rawGroup = groupCol ? String(row[groupCol] ?? "").trim() : null;
      let ledgerType = "expense";
      if (typeCol && VALID_TYPES.has(String(row[typeCol]).toLowerCase().trim())) {
        ledgerType = String(row[typeCol]).toLowerCase().trim();
      } else if (rawGroup) {
        ledgerType = mapTallyGroup(rawGroup);
      }

      ledgerRows.push({
        tenant_id: profile.tenant_id,
        client_id: clientId,
        ledger_name: name,
        ledger_type: ledgerType,
        tally_group: rawGroup || null,
        financial_year: null, closing_balance: null, balance_type: null, opening_balance: null,
        source: "ledger_list",
      });
    }
  } else {
    // Tally report format — company name/title rows at top, then indented or 2-col data
    const result = parseLedgerList(rawRows);
    ledgerRows = result.ledgers.map(l => ({ ...l, tenant_id: profile.tenant_id, client_id: clientId }));
    skipped = result.skipped;
  }

  if (ledgerRows.length === 0) {
    return NextResponse.json({ error: "No valid ledger names found. Check that the file is a Tally ledger list export." }, { status: 400 });
  }

  const { error } = await supabase
    .from("ledger_masters")
    .upsert(ledgerRows, { onConflict: "tenant_id,client_id,ledger_name", ignoreDuplicates: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ imported: ledgerRows.length, skipped: skipped.length, skipped_names: skipped.slice(0, 5) });
}
