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
  return TALLY_GROUP_MAP[key] ?? "expense"; // default to expense if unknown group
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

  // Detect columns — Tally export uses various column names
  const firstRow = rows[0];
  const cols = Object.keys(firstRow).map((k) => k.toLowerCase().trim());

  const nameCol  = Object.keys(firstRow).find((k) => /^name$|^ledger\s*name$|^ledger$/i.test(k.trim()));
  const groupCol = Object.keys(firstRow).find((k) => /^under$|^group$|^parent\s*group$|^under\s*group$/i.test(k.trim()));
  const typeCol  = Object.keys(firstRow).find((k) => /^type$|^ledger\s*type$/i.test(k.trim()));

  if (!nameCol) {
    return NextResponse.json({
      error: `Could not find ledger name column. Found columns: ${cols.join(", ")}. Expected "Name" or "Ledger Name".`,
    }, { status: 400 });
  }

  const ledgerRows: { tenant_id: string; client_id: string; ledger_name: string; ledger_type: string }[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const name = String(row[nameCol] ?? "").trim();
    if (!name || name.toLowerCase() === "name" || name.toLowerCase() === "ledger name") continue; // skip header rows

    let ledgerType = "expense";

    if (typeCol && VALID_TYPES.has(String(row[typeCol]).toLowerCase().trim())) {
      // Already in our format
      ledgerType = String(row[typeCol]).toLowerCase().trim();
    } else if (groupCol) {
      // Map from Tally Group name
      ledgerType = mapTallyGroup(String(row[groupCol] ?? ""));
    }

    if (name.length > 100) { skipped.push(name.slice(0, 30) + "…"); continue; }

    ledgerRows.push({
      tenant_id: profile.tenant_id,
      client_id: clientId,
      ledger_name: name,
      ledger_type: ledgerType,
    });
  }

  if (ledgerRows.length === 0) {
    return NextResponse.json({ error: "No valid ledger rows found in file" }, { status: 400 });
  }

  const { error } = await supabase
    .from("ledger_masters")
    .upsert(ledgerRows, { onConflict: "tenant_id,client_id,ledger_name", ignoreDuplicates: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    imported: ledgerRows.length,
    skipped: skipped.length,
    skipped_names: skipped.slice(0, 5),
  });
}
