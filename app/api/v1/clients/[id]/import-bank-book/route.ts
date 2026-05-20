import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/supabase/server";
import {
  parseTallyBankBook,
  type ColumnMapping,
  type BankBookRow,
} from "@/lib/bank-book-parser";
import { parseStatementCsv, type StatementColumnMapping } from "@/lib/bank-statement-parser";
import { matchBankBookToStatement, buildRuleCandidates } from "@/lib/bank-book-matcher";

// POST /api/v1/clients/[id]/import-bank-book
//
// Mode A — multipart/form-data: parse both bank book (Tally export) and bank
//   statement (bank portal CSV/XLSX), match rows, return rule candidates.
//
// Mode B — application/json { confirm: true, rules: [...] }: upsert confirmed
//   ledger_mapping_rules for the client.

// ─── Inline date/amount helpers (copied from bank-book-parser, server-only) ────

const MONTH_MAP_INLINE: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function parseDateInline(val: unknown): string | null {
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

// ─── reparseWithOverrides: re-parse bank book with explicit column mapping ─────

function reparseWithOverrides(
  buffer: ArrayBuffer,
  fileName: string,
  overrideMapping: ColumnMapping,
  originalResult: ReturnType<typeof parseTallyBankBook>
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
  const idxOf = (name: string | null): number => (name ? rawHeaders.indexOf(name) : -1);

  const dateIdx = idxOf(overrideMapping.date);
  const particIdx = idxOf(overrideMapping.particulars);
  const debitIdx = idxOf(overrideMapping.debit);
  const creditIdx = idxOf(overrideMapping.credit);
  const vchTypeIdx = idxOf(overrideMapping.voucher_type);

  if (dateIdx < 0 || particIdx < 0) return [];

  let dataStartIndex = 0;
  for (let i = 0; i < Math.min(20, rawRows.length); i++) {
    if (parseDateInline((rawRows[i] as unknown[])[dateIdx]) !== null) {
      dataStartIndex = i;
      break;
    }
  }

  const SKIP = /^(total|opening|closing|balance|grand\s*total|by\s*balance|to\s*balance)/i;
  const rows: BankBookRow[] = [];

  for (let i = dataStartIndex; i < rawRows.length; i++) {
    const row = rawRows[i] as unknown[];
    const parsedDate = parseDateInline(row[dateIdx]);
    if (!parsedDate) continue;

    const particulars = String(row[particIdx] ?? "").trim();
    if (!particulars || SKIP.test(particulars)) continue;

    const debit = debitIdx >= 0 ? parseAmountInline(row[debitIdx]) : null;
    const credit = creditIdx >= 0 ? parseAmountInline(row[creditIdx]) : null;
    if (debit === null && credit === null) continue;

    const voucherTypeRaw = vchTypeIdx >= 0 ? row[vchTypeIdx] : null;
    const voucher_type = voucherTypeRaw ? String(voucherTypeRaw).trim() || null : null;

    rows.push({ date: parsedDate, particulars, voucher_type, debit, credit });
  }

  return rows;
}

// ─── reparseStatementWithOverrides ───────────────────────────────────────────

function reparseStatementWithOverrides(
  buffer: ArrayBuffer,
  fileName: string,
  overrideMapping: StatementColumnMapping,
  originalRawHeaders: string[]
): ReturnType<typeof parseStatementCsv>["rows"] {
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

  const idxOf = (name: string | null): number => (name ? originalRawHeaders.indexOf(name) : -1);

  const dateIdx = idxOf(overrideMapping.date);
  const narrIdx = idxOf(overrideMapping.narration);
  const debitIdx = idxOf(overrideMapping.debit);
  const creditIdx = idxOf(overrideMapping.credit);

  if (dateIdx < 0 || narrIdx < 0) return [];

  let dataStartIndex = 0;
  for (let i = 0; i < Math.min(20, rawRows.length); i++) {
    if (parseDateInline((rawRows[i] as unknown[])[dateIdx]) !== null) {
      dataStartIndex = i;
      break;
    }
  }

  const SKIP = /^(opening|closing|total|balance|by balance|to balance)/i;
  const rows: ReturnType<typeof parseStatementCsv>["rows"] = [];

  for (let i = dataStartIndex; i < rawRows.length; i++) {
    const row = rawRows[i] as unknown[];
    const parsedDate = parseDateInline(row[dateIdx]);
    if (!parsedDate) continue;

    const narration = String(row[narrIdx] ?? "").trim();
    if (!narration || SKIP.test(narration)) continue;

    const debit = debitIdx >= 0 ? parseAmountInline(row[debitIdx]) : null;
    const credit = creditIdx >= 0 ? parseAmountInline(row[creditIdx]) : null;
    if (debit === null && credit === null) continue;

    rows.push({ date: parsedDate, narration, debit, credit });
  }

  return rows;
}

// ─── Route handler ────────────────────────────────────────────────────────────

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
        financial_year?: string;
        rules?: Array<{ pattern: string; ledger_name: string }>;
      };

      if (!body.confirm || !Array.isArray(body.rules) || body.rules.length === 0) {
        return NextResponse.json(
          { error: "confirm:true and rules[] are required" },
          { status: 400 }
        );
      }

      const financialYear = body.financial_year ?? null;

      // Check for cross-year conflicts: existing rules for the same pattern with a different
      // financial_year AND different ledger → surface as a warning (still upsert, but flag).
      const patterns = body.rules.map((r) => r.pattern);
      const { data: existingRules } = await supabase
        .from("ledger_mapping_rules")
        .select("pattern, ledger_name, financial_year, source")
        .eq("tenant_id", tenantId)
        .eq("client_id", clientId)
        .in("pattern", patterns);

      const crossYearConflicts: Array<{ pattern: string; prev_ledger: string; prev_fy: string | null; new_ledger: string }> = [];
      if (existingRules) {
        for (const r of body.rules) {
          const existing = existingRules.find((e) => e.pattern === r.pattern);
          if (existing && existing.ledger_name !== r.ledger_name && existing.financial_year !== financialYear) {
            crossYearConflicts.push({
              pattern: r.pattern,
              prev_ledger: existing.ledger_name,
              prev_fy: existing.financial_year,
              new_ledger: r.ledger_name,
            });
          }
        }
      }

      const ruleRows = body.rules.map((r) => ({
        tenant_id: tenantId,
        client_id: clientId,
        pattern: r.pattern,
        ledger_name: r.ledger_name,
        confirmed: true,
        match_count: 3,
        source: "bank_book_import",
        financial_year: financialYear,
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
        new_value: { count: body.rules.length, financial_year: financialYear },
      });

      return NextResponse.json({
        created: body.rules.length,
        cross_year_conflicts: crossYearConflicts,
      });
    }

    // ── Mode A: file upload (multipart/form-data) ──────────────────────────
    const formData = await request.formData();

    const bbFile = formData.get("bankbook_file") as File | null;
    const stmtFile = formData.get("statement_file") as File | null;

    if (!bbFile) return NextResponse.json({ error: "bankbook_file is required" }, { status: 400 });
    if (!stmtFile) return NextResponse.json({ error: "statement_file is required" }, { status: 400 });

    const bbBuffer = await bbFile.arrayBuffer();
    const stmtBuffer = await stmtFile.arrayBuffer();

    // ── Parse bank book ──────────────────────────────────────────────────
    let bbResult = parseTallyBankBook(bbBuffer, bbFile.name);

    const bbColDate = (formData.get("bb_column_date") as string | null)?.trim() || null;
    const bbColParticulars = (formData.get("bb_column_particulars") as string | null)?.trim() || null;
    const bbColDebit = (formData.get("bb_column_debit") as string | null)?.trim() || null;
    const bbColCredit = (formData.get("bb_column_credit") as string | null)?.trim() || null;

    if (bbColDate || bbColParticulars || bbColDebit || bbColCredit) {
      const overrideMapping: ColumnMapping = {
        date: bbColDate ?? bbResult.columnMapping.date,
        particulars: bbColParticulars ?? bbResult.columnMapping.particulars,
        debit: bbColDebit ?? bbResult.columnMapping.debit,
        credit: bbColCredit ?? bbResult.columnMapping.credit,
        voucher_type: bbResult.columnMapping.voucher_type,
      };
      const reRows = reparseWithOverrides(bbBuffer, bbFile.name, overrideMapping, bbResult);
      bbResult = {
        rows: reRows,
        columnMapping: overrideMapping,
        preview: bbResult.preview,
        detectionConfident: true,
        rawHeaders: bbResult.rawHeaders,
      };
    }

    // ── Parse bank statement ─────────────────────────────────────────────
    let stmtResult = parseStatementCsv(stmtBuffer, stmtFile.name);

    const stmtColDate = (formData.get("stmt_column_date") as string | null)?.trim() || null;
    const stmtColNarration = (formData.get("stmt_column_narration") as string | null)?.trim() || null;
    const stmtColDebit = (formData.get("stmt_column_debit") as string | null)?.trim() || null;
    const stmtColCredit = (formData.get("stmt_column_credit") as string | null)?.trim() || null;

    if (stmtColDate || stmtColNarration || stmtColDebit || stmtColCredit) {
      const stmtOverride: StatementColumnMapping = {
        date: stmtColDate ?? stmtResult.columnMapping.date,
        narration: stmtColNarration ?? stmtResult.columnMapping.narration,
        debit: stmtColDebit ?? stmtResult.columnMapping.debit,
        credit: stmtColCredit ?? stmtResult.columnMapping.credit,
      };
      const reRows = reparseStatementWithOverrides(
        stmtBuffer, stmtFile.name, stmtOverride, stmtResult.rawHeaders
      );
      stmtResult = {
        rows: reRows,
        columnMapping: stmtOverride,
        preview: stmtResult.preview,
        detectionConfident: true,
        rawHeaders: stmtResult.rawHeaders,
      };
    }

    // ── If either file needs column mapping, ask the caller ───────────────
    if (!bbResult.detectionConfident || !stmtResult.detectionConfident) {
      return NextResponse.json({
        needs_column_mapping: true,
        bankbook: {
          raw_headers: bbResult.rawHeaders,
          preview: bbResult.preview,
          detection_confident: bbResult.detectionConfident,
        },
        statement: {
          raw_headers: stmtResult.rawHeaders,
          preview: stmtResult.preview,
          detection_confident: stmtResult.detectionConfident,
        },
      });
    }

    // ── Match and build rule candidates ───────────────────────────────────
    const matchResult = matchBankBookToStatement(bbResult.rows, stmtResult.rows);
    const ruleCandidates = buildRuleCandidates(matchResult.matched);

    return NextResponse.json({
      needs_column_mapping: false,
      total_bb_rows: bbResult.rows.length,
      total_stmt_rows: stmtResult.rows.length,
      matched_count: matchResult.matched.length,
      ambiguous_count: matchResult.ambiguous.length,
      unmatched_count: matchResult.unmatchedBb.length,
      rule_candidates: ruleCandidates,
      ambiguous: matchResult.ambiguous,
      unmatched_bb: matchResult.unmatchedBb.slice(0, 20),
    });
  } catch (err) {
    console.error("[import-bank-book POST]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
