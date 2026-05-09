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
function parseAmt(val: string | undefined | null): number | null {
  if (!val) return null;
  const s = String(val).replace(/[₹,\s]/g, "").replace(/^\((.+)\)$/, "-$1").trim();
  if (!s || s === "-") return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.abs(n); // always store magnitude; balance_type carries Dr/Cr
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
  const financialYear = (formData.get("financial_year") as string | null)?.trim() || null;

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  const fileName = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();

  let rows: Record<string, string>[] = [];

  try {
    if (fileName.endsWith(".csv")) {
      const text = new TextDecoder().decode(buffer);
      const wb = XLSX.read(text, { type: "string" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });
    } else if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
      const wb = XLSX.read(buffer, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });
    } else {
      return NextResponse.json({ error: "Upload CSV or Excel file" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Could not read file" }, { status: 400 });
  }

  if (rows.length === 0) return NextResponse.json({ error: "No rows found in file" }, { status: 400 });

  const firstRow = rows[0];
  const cols = Object.keys(firstRow).map((k) => k.toLowerCase().trim());

  // ── Column detection ───────────────────────────────────────────────────────
  const nameCol  = Object.keys(firstRow).find((k) => /^(name|ledger\s*name|ledger|particulars)$/i.test(k.trim()));
  const groupCol = Object.keys(firstRow).find((k) => /^(under|group|parent\s*group|under\s*group)$/i.test(k.trim()));
  const typeCol  = Object.keys(firstRow).find((k) => /^(type|ledger\s*type)$/i.test(k.trim()));

  if (!nameCol) {
    return NextResponse.json({
      error: `Could not find ledger name column. Found: ${cols.join(", ")}. Expected "Name", "Ledger Name", or "Particulars".`,
    }, { status: 400 });
  }

  // Balance column detection — Tally exports vary significantly:
  // Format A: single "Closing Balance" col + "Dr/Cr" col
  // Format B: "Closing Balance (Dr)" + "Closing Balance (Cr)" (two cols)
  // Format C: "Debit" + "Credit" (net trial balance style)
  const closingCol    = Object.keys(firstRow).find((k) => /closing\s*bal/i.test(k));
  const drCrCol       = Object.keys(firstRow).find((k) => /^(dr\/?cr|type|dr\.?\/cr\.?)$/i.test(k.trim()) && !/ledger/i.test(k));
  const closingDrCol  = Object.keys(firstRow).find((k) => /closing.*dr|debit.*closing/i.test(k));
  const closingCrCol  = Object.keys(firstRow).find((k) => /closing.*cr|credit.*closing/i.test(k));
  const openingCol    = Object.keys(firstRow).find((k) => /opening\s*bal/i.test(k));
  const openingDrCol  = Object.keys(firstRow).find((k) => /opening.*dr|debit.*opening/i.test(k));
  const openingCrCol  = Object.keys(firstRow).find((k) => /opening.*cr|credit.*opening/i.test(k));
  // Simple debit/credit columns (net trial balance)
  const debitCol  = !closingDrCol ? Object.keys(firstRow).find((k) => /^debit$|^dr$/i.test(k.trim())) : undefined;
  const creditCol = !closingCrCol ? Object.keys(firstRow).find((k) => /^credit$|^cr$/i.test(k.trim())) : undefined;

  const hasBalanceData = !!(closingCol || closingDrCol || closingCrCol || debitCol || creditCol);

  // ── Build rows ─────────────────────────────────────────────────────────────
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
  };

  const ledgerRows: LedgerRow[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const name = String(row[nameCol] ?? "").trim();
    if (!name || /^(name|ledger\s*name|particulars)$/i.test(name)) continue;
    if (name.length > 150) { skipped.push(name.slice(0, 30) + "…"); continue; }

    // Ledger type
    let ledgerType = "expense";
    const rawGroup = groupCol ? String(row[groupCol] ?? "").trim() : null;
    if (typeCol && VALID_TYPES.has(String(row[typeCol]).toLowerCase().trim())) {
      ledgerType = String(row[typeCol]).toLowerCase().trim();
    } else if (rawGroup) {
      ledgerType = mapTallyGroup(rawGroup);
    }

    // Balance resolution — try each format in order of specificity
    let closingBalance: number | null = null;
    let balanceType: "Dr" | "Cr" | null = null;
    let openingBalance: number | null = null;

    if (closingDrCol || closingCrCol) {
      // Format B: separate Dr / Cr closing balance columns
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
      // Format A: single closing balance + Dr/Cr indicator column
      closingBalance = parseAmt(row[closingCol]);
      if (drCrCol) {
        const indicator = String(row[drCrCol] ?? "").trim().toUpperCase();
        balanceType = indicator === "CR" || indicator === "C" ? "Cr" : "Dr";
      }
      if (openingCol) openingBalance = parseAmt(row[openingCol]);
    } else if (debitCol || creditCol) {
      // Format C: simple Debit / Credit columns
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
