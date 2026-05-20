import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/supabase/server";
import { parseTallyBankBook, groupByParticulars, type ColumnMapping, type BankBookRow } from "@/lib/bank-book-parser";
import { extractPattern } from "@/lib/ledger-rules";
import { fuzzyMatchLedgers } from "@/lib/party-match";

// POST /api/v1/clients/[id]/import-bank-book
//
// Mode A — multipart/form-data: parse a Tally bank book export, fuzzy-match
//   Particulars against client ledger_masters, and return 3 confidence buckets.
//
// Mode B — application/json { confirm: true, rules: [...] }: upsert confirmed
//   ledger_mapping_rules for the client.

type Candidate = {
  particulars: string;
  pattern: string;
  ledger_name: string;
  ledger_type: string | null;
  confidence: "high" | "medium" | "none";
  score: number;
  debit_total: number;
  credit_total: number;
  count: number;
};

// ─── Inline helpers for the override re-parse path ───────────────────────────

const MONTH_MAP_INLINE: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function parseDateInline(val: unknown): string | null {
  if (val === null || val === undefined || val === "") return null;

  if (typeof val === "number") {
    // Excel serial number — convert via XLSX SSF
    try {
      const parsed = XLSX.SSF.parse_date_code(val);
      if (parsed && parsed.y && parsed.m && parsed.d) {
        return `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
      }
    } catch {
      // fall through
    }
    return null;
  }

  const v = String(val).trim();
  if (!v) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);

  const dMonY = v.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/](\d{2,4})$/);
  if (dMonY) {
    const mm = MONTH_MAP_INLINE[dMonY[2].slice(0, 3).toLowerCase()];
    if (mm) {
      const rawYear = parseInt(dMonY[3], 10);
      const yr = dMonY[3].length === 2
        ? (rawYear >= 0 && rawYear <= 30 ? 2000 + rawYear : 1900 + rawYear)
        : rawYear;
      return `${yr}-${mm}-${dMonY[1].padStart(2, "0")}`;
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

function parseAmountInline(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number") return (isNaN(val) || val === 0) ? null : val;
  const s = String(val).replace(/[₹,\s]/g, "").replace(/^\((.+)\)$/, "-$1").trim();
  if (!s || s === "-") return null;
  const n = parseFloat(s);
  return (isNaN(n) || n === 0) ? null : n;
}

/**
 * Re-parse the raw XLSX buffer using an explicit ColumnMapping.
 * Called when the user provides column name overrides via form fields.
 */
function reparseWithOverrides(
  buffer: ArrayBuffer,
  fileName: string,
  overrideMapping: ColumnMapping,
  originalResult: Awaited<ReturnType<typeof parseTallyBankBook>>
): BankBookRow[] {
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

  const { rawHeaders } = originalResult;

  const idxOf = (name: string | null): number =>
    name ? rawHeaders.indexOf(name) : -1;

  const dateIdx = idxOf(overrideMapping.date);
  const particIdx = idxOf(overrideMapping.particulars);
  const debitIdx = idxOf(overrideMapping.debit);
  const creditIdx = idxOf(overrideMapping.credit);
  const vchTypeIdx = idxOf(overrideMapping.voucher_type);

  if (dateIdx < 0 || particIdx < 0) return [];

  // Find data start: first row where the date column parses successfully
  let dataStartIndex = 0;
  for (let i = 0; i < Math.min(20, rawRows.length); i++) {
    const row = rawRows[i] as unknown[];
    if (parseDateInline(row[dateIdx]) !== null) {
      dataStartIndex = i;
      break;
    }
  }

  const SKIP_PARTICULARS = /^(total|opening|closing|balance|grand\s*total|by\s*balance|to\s*balance)/i;
  const rows: BankBookRow[] = [];

  for (let i = dataStartIndex; i < rawRows.length; i++) {
    const row = rawRows[i] as unknown[];

    const parsedDate = parseDateInline(row[dateIdx]);
    if (!parsedDate) continue;

    const particulars = String(row[particIdx] ?? "").trim();
    if (!particulars || SKIP_PARTICULARS.test(particulars)) continue;

    const debit = debitIdx >= 0 ? parseAmountInline(row[debitIdx]) : null;
    const credit = creditIdx >= 0 ? parseAmountInline(row[creditIdx]) : null;
    if (debit === null && credit === null) continue;

    const voucherTypeRaw = vchTypeIdx >= 0 ? row[vchTypeIdx] : null;
    const voucher_type = voucherTypeRaw ? String(voucherTypeRaw).trim() || null : null;

    rows.push({ date: parsedDate, particulars, voucher_type, debit, credit });
  }

  return rows;
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

    const { id: clientId } = await params;
    const tenantId = profile.tenant_id;

    const contentType = request.headers.get("content-type") ?? "";

    // ── Mode B: confirm rules ──────────────────────────────────────────────
    if (contentType.includes("application/json")) {
      const body = await request.json() as {
        confirm?: boolean;
        rules?: Array<{ pattern: string; ledger_name: string; confidence?: string }>;
      };

      if (!body.confirm || !Array.isArray(body.rules) || body.rules.length === 0) {
        return NextResponse.json({ error: "confirm:true and rules[] are required" }, { status: 400 });
      }

      const ruleRows = body.rules.map((r) => ({
        tenant_id: tenantId,
        client_id: clientId,
        pattern: r.pattern,
        ledger_name: r.ledger_name,
        confirmed: true,
        match_count: 3,
        source: "bank_book_import",
      }));

      const { error: upsertErr } = await supabase
        .from("ledger_mapping_rules")
        .upsert(ruleRows, { onConflict: "tenant_id,client_id,pattern" });

      if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 });

      await supabase.from("audit_log").insert({
        tenant_id: tenantId,
        user_id: user.id,
        action: "bank_book_import",
        entity_type: "ledger_mapping_rules",
        entity_id: clientId,
        new_value: { count: body.rules.length },
      });

      return NextResponse.json({ created: body.rules.length });
    }

    // ── Mode A: file upload (multipart/form-data) ──────────────────────────
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const buffer = await file.arrayBuffer();
    let result = parseTallyBankBook(buffer, file.name);

    // Apply column overrides if provided
    const colDate = (formData.get("column_date") as string | null)?.trim() || null;
    const colParticulars = (formData.get("column_particulars") as string | null)?.trim() || null;
    const colDebit = (formData.get("column_debit") as string | null)?.trim() || null;
    const colCredit = (formData.get("column_credit") as string | null)?.trim() || null;

    if (colDate || colParticulars || colDebit || colCredit) {
      const overrideMapping: ColumnMapping = {
        date: colDate ?? result.columnMapping.date,
        particulars: colParticulars ?? result.columnMapping.particulars,
        debit: colDebit ?? result.columnMapping.debit,
        credit: colCredit ?? result.columnMapping.credit,
        voucher_type: result.columnMapping.voucher_type,
      };

      const reRows = reparseWithOverrides(buffer, file.name, overrideMapping, result);

      result = {
        rows: reRows,
        columnMapping: overrideMapping,
        preview: result.preview,
        detectionConfident: true,
        rawHeaders: result.rawHeaders,
      };
    }

    // If columns still not confidently detected, ask caller to map them
    if (!result.detectionConfident) {
      return NextResponse.json({
        needs_column_mapping: true,
        raw_headers: result.rawHeaders,
        preview: result.preview,
      });
    }

    // ── Fetch ledger_masters for this client ──────────────────────────────
    const { data: ledgerMasters } = await supabase
      .from("ledger_masters")
      .select("ledger_name, ledger_type")
      .eq("tenant_id", tenantId)
      .eq("client_id", clientId);

    const ledgers = (ledgerMasters ?? []) as Array<{ ledger_name: string; ledger_type: string }>;

    // ── Group rows by particulars ─────────────────────────────────────────
    const grouped = groupByParticulars(result.rows);

    // ── Build confidence buckets ──────────────────────────────────────────
    const buckets: { high: Candidate[]; medium: Candidate[]; none: Candidate[] } = {
      high: [],
      medium: [],
      none: [],
    };

    for (const [particulars, stats] of grouped.entries()) {
      const pattern = extractPattern(particulars);
      if (!pattern || pattern === "__unknown__" || pattern.length < 3) continue;

      const matches = fuzzyMatchLedgers(particulars, ledgers, 3);
      const best = matches[0] ?? null;

      let confidence: "high" | "medium" | "none";
      if (best && (best.score >= 12 || particulars.toLowerCase() === best.ledger_name.toLowerCase())) {
        confidence = "high";
      } else if (best && best.score >= 4) {
        confidence = "medium";
      } else {
        confidence = "none";
      }

      const candidate: Candidate = {
        particulars,
        pattern,
        ledger_name: best?.ledger_name ?? particulars,
        ledger_type: best?.ledger_type ?? null,
        confidence,
        score: best?.score ?? 0,
        debit_total: stats.debit_total,
        credit_total: stats.credit_total,
        count: stats.count,
      };

      buckets[confidence].push(candidate);
    }

    return NextResponse.json({
      needs_column_mapping: false,
      column_mapping: result.columnMapping,
      raw_headers: result.rawHeaders,
      total_rows: result.rows.length,
      buckets,
      ledger_master_count: ledgers.length,
    });
  } catch (err) {
    console.error("[import-bank-book POST]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
