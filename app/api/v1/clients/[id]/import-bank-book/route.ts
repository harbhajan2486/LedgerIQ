import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/supabase/server";
import {
  parseTallyBankBook,
  type ColumnMapping,
  type BankBookRow,
} from "@/lib/bank-book-parser";
import { parseStatementCsv, type StatementColumnMapping, type StatementRow } from "@/lib/bank-statement-parser";
import { matchBankBookToStatement, buildRuleCandidates, type AmbiguousPair } from "@/lib/bank-book-matcher";
import { extractStatementFromPdf } from "@/lib/pdf-bank-statement";
import { extractPattern } from "@/lib/ledger-rules";

// Persist match result to bb_import_sessions (fire-and-forget, never blocks the response)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function saveSessionBg(supabase: any, tenantId: string, clientId: string, financialYear: string, payload: object, bbFilename?: string | null, stmtFilenames?: string[] | null) {
  supabase.from("bb_import_sessions").upsert({
    tenant_id: tenantId,
    client_id: clientId,
    financial_year: financialYear,
    result_json: payload,
    bb_filename: bbFilename ?? null,
    stmt_filenames: stmtFilenames ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id,client_id,financial_year" })
    .then()
    .catch((e: Error) => console.error("[bb-session save]", e));
}

// Save ambiguous bank book matches as pending draft rules so users can action them later
// from the Mapping Rules tab (source='pending_bb', confirmed=false).
// Uses ignoreDuplicates so existing confirmed rules are never overwritten.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function savePendingBbRules(ambiguous: AmbiguousPair[], supabase: any, tenantId: string, clientId: string) {
  if (!ambiguous.length) return;
  const rows = ambiguous
    .map(a => ({
      tenant_id: tenantId,
      client_id: clientId,
      pattern: extractPattern(a.bbRow.particulars),
      ledger_name: a.bbRow.particulars,
      match_count: 0,
      confirmed: false,
      source: "pending_bb",
    }))
    .filter(r => r.pattern.length >= 3 && r.ledger_name.length >= 2);
  if (!rows.length) return;
  await supabase.from("ledger_mapping_rules")
    .upsert(rows, { onConflict: "tenant_id,client_id,pattern", ignoreDuplicates: true });
}

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

    let particulars = String(row[particIdx] ?? "").trim();
    if (/^(to|by)$/i.test(particulars)) {
      particulars = String(row[particIdx + 1] ?? "").trim();
    } else {
      particulars = particulars.replace(/^(to|by)\s+/i, "").trim();
    }
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

// ─── Build the unified match result JSON payload ──────────────────────────────

function buildMatchPayload(
  bbRows: BankBookRow[],
  stmtRows: StatementRow[],
  matchResult: ReturnType<typeof matchBankBookToStatement>,
  ruleCandidates: ReturnType<typeof buildRuleCandidates>,
  extra: Record<string, unknown> = {}
) {
  // Build pairing maps: bbRowIdx ↔ stmtRowIdx for matched pairs
  const bbToStmtIdx = new Map<number, number>();
  const stmtToBbIdx = new Map<number, number>();
  const bbConfidence = new Map<number, "exact" | "near">();
  for (const pair of matchResult.matched) {
    bbToStmtIdx.set(pair.bbRowIdx, pair.stmtRowIdx);
    stmtToBbIdx.set(pair.stmtRowIdx, pair.bbRowIdx);
    bbConfidence.set(pair.bbRowIdx, pair.confidence);
  }

  // Build diag map: bbRowIdx → diag info
  const diagByBbIdx = new Map(matchResult.unmatchDiags.map(d => [d.bbRowIdx, d]));
  // Build ambiguous map: bbRowIdx for ambiguous rows
  const ambiguousBbIdx = new Set(matchResult.ambiguous.map(a => a.bbRowIdx));

  return {
    needs_column_mapping: false,
    total_bb_rows: bbRows.length,
    total_stmt_rows: stmtRows.length,
    matched_count: matchResult.matched.length,
    ambiguous_count: matchResult.ambiguous.length,
    unmatched_count: matchResult.unmatchedBb.length,
    rule_candidates: ruleCandidates,
    ambiguous: matchResult.ambiguous.map(a => ({ bb_row: a.bbRow, bb_row_idx: a.bbRowIdx, candidates: a.candidates })),
    unmatched_bb: matchResult.unmatchedBb.slice(0, 20),
    all_bb_rows: bbRows.map((r, i) => ({
      row_index: i,
      date: r.date,
      particulars: r.particulars,
      debit: r.debit,
      credit: r.credit,
      sub_rows: r.subRows ?? [],
      match_status: matchResult.bbStatuses[i],
      matched_stmt_idx: bbToStmtIdx.get(i),          // undefined if not matched
      match_confidence: bbConfidence.get(i),           // "exact" | "near" | undefined
      no_match_diag: diagByBbIdx.get(i),               // only for unmatched rows
      is_ambiguous: ambiguousBbIdx.has(i),
    })),
    all_stmt_rows: stmtRows.map((r, i) => ({
      row_index: i,
      date: r.date,
      narration: r.narration,
      debit: r.debit,
      credit: r.credit,
      match_status: matchResult.stmtStatuses[i],
      matched_bb_idx: stmtToBbIdx.get(i),             // undefined if not matched
    })),
    ...extra,
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────

// PDF extraction via Claude can take up to 3 minutes for a large statement
export const maxDuration = 300;

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

      // Deduplicate by pattern — same pattern appearing twice in one batch causes
      // "ON CONFLICT DO UPDATE command cannot affect row a second time" in Postgres
      const deduped = new Map<string, { pattern: string; ledger_name: string }>();
      for (const r of body.rules) deduped.set(r.pattern, r);

      const ruleRows = Array.from(deduped.values()).map((r) => ({
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

      // Mark session as confirmed (fire-and-forget)
      void supabase.from("bb_import_sessions").update({ confirmed_at: new Date().toISOString() })
        .eq("tenant_id", tenantId).eq("client_id", clientId).eq("financial_year", financialYear ?? "");

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
    const mode = (formData.get("mode") as string | null) ?? "";

    // ── Mode: rematch_json — both BB rows and stmt rows sent as JSON, re-run matching ──
    // Used after user edits (removes/marks-as-subrow) rows in the split-screen view.
    if (mode === "rematch_json") {
      const bbRowsJson = formData.get("bb_rows_json") as string | null;
      const stmtRowsJson = formData.get("stmt_rows_json") as string | null;
      if (!bbRowsJson || !stmtRowsJson) return NextResponse.json({ error: "bb_rows_json and stmt_rows_json required" }, { status: 400 });
      let bbRows: BankBookRow[], stmtRows: StatementRow[];
      try { bbRows = JSON.parse(bbRowsJson); stmtRows = JSON.parse(stmtRowsJson); }
      catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
      const matchResult = matchBankBookToStatement(bbRows, stmtRows);
      const ruleCandidates = buildRuleCandidates(matchResult.matched);
      savePendingBbRules(matchResult.ambiguous, supabase, tenantId, clientId).catch(() => {});
      const fy = (formData.get("financial_year") as string | null) ?? "";
      const payload = buildMatchPayload(bbRows, stmtRows, matchResult, ruleCandidates);
      saveSessionBg(supabase, tenantId, clientId, fy, payload);
      return NextResponse.json(payload);
    }

    // ── Mode: parse_stmt_only — parse a CSV/Excel statement, return rows ─────
    if (mode === "parse_stmt_only") {
      const stmtFile = formData.get("statement_file") as File | null;
      if (!stmtFile) return NextResponse.json({ error: "statement_file required" }, { status: 400 });
      const buf = await stmtFile.arrayBuffer();
      const result = parseStatementCsv(buf, stmtFile.name);
      if (!result.detectionConfident) {
        return NextResponse.json({ error: "Could not auto-detect columns. Use the main upload flow to map columns manually." }, { status: 422 });
      }
      return NextResponse.json({ rows: result.rows });
    }

    // ── Mode: extract_only — extract a single PDF, return rows (no matching) ──
    // Used by the client when processing split PDF chunks one at a time.
    if (mode === "extract_only") {
      const stmtFile = formData.get("statement_file") as File | null;
      if (!stmtFile) return NextResponse.json({ error: "statement_file required" }, { status: 400 });
      const buf = await stmtFile.arrayBuffer();
      try {
        const pdfResult = await extractStatementFromPdf(buf);
        const costUsd = (pdfResult.tokensIn / 1_000_000) * 0.80 + (pdfResult.tokensOut / 1_000_000) * 4.00;
        supabase.from("ai_usage").insert({ tenant_id: tenantId, model: "claude-haiku-4-5-20251001", tokens_in: pdfResult.tokensIn, tokens_out: pdfResult.tokensOut, cost_usd: costUsd }).then();
        return NextResponse.json({ rows: pdfResult.rows });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: `PDF extraction failed: ${msg}` }, { status: 422 });
      }
    }

    // ── Mode: match_with_rows — accept pre-extracted rows + bank book, return matches ──
    // Used after all PDF chunks have been extracted client-side.
    if (mode === "match_with_rows") {
      const bbFile = formData.get("bankbook_file") as File | null;
      const stmtRowsJson = formData.get("stmt_rows_json") as string | null;
      if (!bbFile) return NextResponse.json({ error: "bankbook_file required" }, { status: 400 });
      if (!stmtRowsJson) return NextResponse.json({ error: "stmt_rows_json required" }, { status: 400 });

      const bbBuffer = await bbFile.arrayBuffer();
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
        bbResult = { rows: reparseWithOverrides(bbBuffer, bbFile.name, overrideMapping, bbResult), columnMapping: overrideMapping, preview: bbResult.preview, detectionConfident: true, rawHeaders: bbResult.rawHeaders };
      }

      if (!bbResult.detectionConfident) {
        return NextResponse.json({
          needs_column_mapping: true,
          bankbook: { raw_headers: bbResult.rawHeaders, preview: bbResult.preview, detection_confident: false },
          statement: { raw_headers: [], preview: [], detection_confident: true },
        });
      }

      let stmtRows: StatementRow[];
      try { stmtRows = JSON.parse(stmtRowsJson); } catch {
        return NextResponse.json({ error: "Invalid stmt_rows_json" }, { status: 400 });
      }

      stmtRows.sort((a, b) => a.date.localeCompare(b.date));
      const matchResult = matchBankBookToStatement(bbResult.rows, stmtRows);
      const ruleCandidates = buildRuleCandidates(matchResult.matched);
      savePendingBbRules(matchResult.ambiguous, supabase, tenantId, clientId).catch(() => {});
      const fy = (formData.get("financial_year") as string | null) ?? "";
      const payload = buildMatchPayload(bbResult.rows, stmtRows, matchResult, ruleCandidates);
      saveSessionBg(supabase, tenantId, clientId, fy, payload, bbFile.name);
      return NextResponse.json(payload);
    }

    const bbFile = formData.get("bankbook_file") as File | null;
    // Accept multiple statement files (for split PDFs) via getAll
    const stmtFiles = formData.getAll("statement_file") as File[];

    if (!bbFile) return NextResponse.json({ error: "bankbook_file is required" }, { status: 400 });
    if (!stmtFiles.length) return NextResponse.json({ error: "statement_file is required" }, { status: 400 });

    const bbBuffer = await bbFile.arrayBuffer();

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

    // ── Parse bank statement(s) ──────────────────────────────────────────
    // If all files are PDFs: extract each via Claude, merge rows, skip column-mapping step.
    // If any file is CSV/Excel: use the first non-PDF file for the column-mapping flow (single file).
    const allPdfs = stmtFiles.every(f => f.name.toLowerCase().endsWith(".pdf"));

    if (allPdfs) {
      // Process each PDF chunk sequentially and merge all extracted rows
      const allPdfRows: StatementRow[] = [];
      let totalTokensIn = 0;
      let totalTokensOut = 0;

      for (let i = 0; i < stmtFiles.length; i++) {
        const file = stmtFiles[i];
        const buf = await file.arrayBuffer();
        try {
          const pdfResult = await extractStatementFromPdf(buf);
          allPdfRows.push(...pdfResult.rows);
          totalTokensIn += pdfResult.tokensIn;
          totalTokensOut += pdfResult.tokensOut;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return NextResponse.json(
            { error: `PDF extraction failed on file ${i + 1} of ${stmtFiles.length} (${file.name}): ${msg}` },
            { status: 422 }
          );
        }
      }

      // Log total AI cost in background
      const costUsd = (totalTokensIn / 1_000_000) * 0.80 + (totalTokensOut / 1_000_000) * 4.00;
      supabase.from("ai_usage").insert({
        tenant_id: tenantId,
        model: "claude-haiku-4-5-20251001",
        tokens_in: totalTokensIn,
        tokens_out: totalTokensOut,
        cost_usd: costUsd,
      }).then();

      if (allPdfRows.length === 0) {
        return NextResponse.json({ error: "Could not extract any transactions from the PDF(s). Try a CSV or Excel export instead." }, { status: 422 });
      }

      // Sort merged rows by date so matching is deterministic
      allPdfRows.sort((a, b) => a.date.localeCompare(b.date));

      const matchResult = matchBankBookToStatement(bbResult.rows, allPdfRows);
      const ruleCandidates = buildRuleCandidates(matchResult.matched);
      savePendingBbRules(matchResult.ambiguous, supabase, tenantId, clientId).catch(() => {});
      const fy = (formData.get("financial_year") as string | null) ?? "";
      const payload = buildMatchPayload(bbResult.rows, allPdfRows, matchResult, ruleCandidates, { pdf_files_processed: stmtFiles.length });
      saveSessionBg(supabase, tenantId, clientId, fy, payload, bbFile.name, stmtFiles.map(f => f.name));
      return NextResponse.json(payload);
    }

    // CSV / Excel path — use first file only (column-mapping flow unchanged)
    const stmtFile = stmtFiles[0];
    const stmtBuffer = await stmtFile.arrayBuffer();
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
    savePendingBbRules(matchResult.ambiguous, supabase, tenantId, clientId).catch(() => {});
    const fy = (formData.get("financial_year") as string | null) ?? "";
    const matchPayload = buildMatchPayload(bbResult.rows, stmtResult.rows, matchResult, ruleCandidates);
    saveSessionBg(supabase, tenantId, clientId, fy, matchPayload, bbFile.name, [stmtFile.name]);
    return NextResponse.json(matchPayload);
  } catch (err) {
    console.error("[import-bank-book POST]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET /api/v1/clients/[id]/import-bank-book?financial_year=2025-26
// Returns the saved match session for a client + FY (if any)
export async function GET(
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
    const fy = request.nextUrl.searchParams.get("financial_year") ?? "";

    const { data: session } = await supabase
      .from("bb_import_sessions")
      .select("result_json, bb_filename, stmt_filenames, confirmed_at, updated_at")
      .eq("tenant_id", profile.tenant_id)
      .eq("client_id", clientId)
      .eq("financial_year", fy)
      .maybeSingle();

    if (!session) return NextResponse.json({ session: null });
    return NextResponse.json({ session });
  } catch (err) {
    console.error("[import-bank-book GET]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
