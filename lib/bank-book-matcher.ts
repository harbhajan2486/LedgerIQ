// Bank Book Matcher
// Matches rows from a CA's Tally bank book export against bank statement rows to
// derive ledger mapping rules: bank_statement.narration → bank_book.particulars.
// Pure logic — no Supabase, no HTTP.

import { type BankBookRow } from "./bank-book-parser";
import { type StatementRow } from "./bank-statement-parser";
import { extractPattern } from "./ledger-rules";

// ─── Public types ─────────────────────────────────────────────────────────────

export type MatchConfidence = "exact" | "near" | "ambiguous" | "unmatched";

export interface MatchedPair {
  bbRow: BankBookRow;
  stmtRow: StatementRow;
  confidence: "exact" | "near";
  bbRowIdx: number;
  stmtRowIdx: number;
}

export interface AmbiguousPair {
  bbRow: BankBookRow;
  bbRowIdx: number;
  candidates: StatementRow[];  // 2+ candidates
}

// Why a BB row didn't match — used for diagnostic tooltips in the UI
export type NoMatchReason = "direction" | "date" | "amount" | "none";
export interface UnmatchDiag {
  bbRowIdx: number;
  reason: NoMatchReason;
  closestAmtDiff?: number;  // smallest amount diff seen (ignoring date)
  closestDateDiff?: number; // smallest date diff seen for amount-passing rows
  dirSwapFound?: boolean;   // true if a match exists when direction constraint is dropped
}

export interface MatchResult {
  matched: MatchedPair[];
  ambiguous: AmbiguousPair[];
  unmatchedBb: BankBookRow[];    // bank book rows with no statement match
  unmatchedStmt: StatementRow[]; // statement rows not matched to any bank book row
  unmatchDiags: UnmatchDiag[];   // one per unmatchedBb entry, same order
  bbStatuses: ("matched" | "ambiguous" | "unmatched")[]; // parallel to bbRows input
  stmtStatuses: ("matched" | "ambiguous" | "unmatched")[]; // parallel to stmtRows input
}

export interface RuleCandidate {
  pattern: string;
  ledger_name: string;
  occurrences: number;
  sample_narration: string;
  sample_date: string;
  amount: number;
  direction: "debit" | "credit";
  status: "auto" | "conflicted";
  conflict_ledgers?: string[];  // only when conflicted
}

// ─── Helper: absolute day difference between two YYYY-MM-DD strings ───────────

function dateDiffDays(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.abs(da - db) / (1000 * 60 * 60 * 24);
}

// ─── matchBankBookToStatement ─────────────────────────────────────────────────

export function matchBankBookToStatement(
  bbRows: BankBookRow[],
  stmtRows: StatementRow[]
): MatchResult {
  const matched: MatchedPair[] = [];
  const ambiguous: AmbiguousPair[] = [];
  const unmatchedBb: BankBookRow[] = [];
  const unmatchDiags: UnmatchDiag[] = [];

  const bbStatuses: ("matched" | "ambiguous" | "unmatched")[] = new Array(bbRows.length).fill("unmatched");
  const stmtStatuses: ("matched" | "ambiguous" | "unmatched")[] = new Array(stmtRows.length).fill("unmatched");

  const consumedStmtIdx = new Set<number>();

  // BB debit = money received (asset ↑) → Stmt credit (bank credits customer's account)
  // BB credit = money paid (asset ↓)   → Stmt debit  (bank debits customer's account)
  function tryMatch(bi: number, bbRow: BankBookRow, dir: "debit" | "credit", amt: number) {
    const candidates: { row: StatementRow; idx: number }[] = [];
    for (let si = 0; si < stmtRows.length; si++) {
      if (consumedStmtIdx.has(si)) continue;
      const s = stmtRows[si];
      const dirOk = dir === "debit" ? s.credit != null : s.debit != null;
      if (!dirOk) continue;
      const sAmt = dir === "debit" ? (s.credit ?? 0) : (s.debit ?? 0);
      if (Math.abs(sAmt - amt) > 1) continue;
      if (dateDiffDays(s.date, bbRow.date) > 2) continue;
      candidates.push({ row: s, idx: si });
    }
    return candidates;
  }

  for (let bi = 0; bi < bbRows.length; bi++) {
    const bbRow = bbRows[bi];
    const dir = bbRow.debit != null ? "debit" : "credit";
    const amt = bbRow.debit ?? bbRow.credit ?? 0;

    const candidates = tryMatch(bi, bbRow, dir, amt);

    if (candidates.length === 0) {
      // Diagnose why: check amount match ignoring date, date match ignoring amount, direction swap
      let closestAmtDiff: number | undefined;
      let closestDateDiff: number | undefined;
      let dirSwapFound = false;
      let amtMatchFound = false;

      for (let si = 0; si < stmtRows.length; si++) {
        const s = stmtRows[si];
        const dirOk = dir === "debit" ? s.credit != null : s.debit != null;
        const sAmt = dirOk ? (dir === "debit" ? (s.credit ?? 0) : (s.debit ?? 0)) : 0;
        const amtDiff = dirOk ? Math.abs(sAmt - amt) : Infinity;
        if (amtDiff <= 1) {
          amtMatchFound = true;
          const dd = dateDiffDays(s.date, bbRow.date);
          if (closestDateDiff === undefined || dd < closestDateDiff) closestDateDiff = dd;
        }
        if (closestAmtDiff === undefined || amtDiff < closestAmtDiff) closestAmtDiff = amtDiff;
      }
      // Check direction swap: try opposite direction
      if (!dirSwapFound) {
        const swapDir = dir === "debit" ? "credit" : "debit";
        const swapCandidates = tryMatch(bi, bbRow, swapDir, amt);
        if (swapCandidates.length > 0) dirSwapFound = true;
      }

      const reason: NoMatchReason =
        dirSwapFound ? "direction"
        : amtMatchFound ? "date"
        : (closestAmtDiff !== undefined && closestAmtDiff <= 100) ? "amount"
        : "none";

      unmatchedBb.push(bbRow);
      unmatchDiags.push({ bbRowIdx: bi, reason, closestAmtDiff, closestDateDiff, dirSwapFound });
      bbStatuses[bi] = "unmatched";
    } else if (candidates.length === 1) {
      const { row: stmtRow, idx: si } = candidates[0];
      const sAmt = dir === "debit" ? (stmtRow.credit ?? 0) : (stmtRow.debit ?? 0);
      const exactDate = stmtRow.date === bbRow.date;
      const exactAmt = Math.abs(sAmt - amt) < 0.001;
      const confidence: "exact" | "near" = (exactDate && exactAmt) ? "exact" : "near";
      matched.push({ bbRow, stmtRow, confidence, bbRowIdx: bi, stmtRowIdx: si });
      bbStatuses[bi] = "matched";
      stmtStatuses[si] = "matched";
      if (confidence === "exact") consumedStmtIdx.add(si);
    } else {
      // P1 tiebreaker: prefer closest by row index
      candidates.sort((a, b) => Math.abs(a.idx - bi) - Math.abs(b.idx - bi));
      const best = candidates[0];
      const second = candidates[1];

      if (Math.abs(best.idx - bi) < Math.abs(second.idx - bi)) {
        const stmtRow = best.row;
        const sAmt = dir === "debit" ? (stmtRow.credit ?? 0) : (stmtRow.debit ?? 0);
        const exactDate = stmtRow.date === bbRow.date;
        const exactAmt = Math.abs(sAmt - amt) < 0.001;
        const confidence: "exact" | "near" = (exactDate && exactAmt) ? "exact" : "near";
        matched.push({ bbRow, stmtRow, confidence, bbRowIdx: bi, stmtRowIdx: best.idx });
        bbStatuses[bi] = "matched";
        stmtStatuses[best.idx] = "matched";
        if (confidence === "exact") consumedStmtIdx.add(best.idx);
      } else {
        ambiguous.push({ bbRow, bbRowIdx: bi, candidates: candidates.map(c => c.row) });
        bbStatuses[bi] = "ambiguous";
        for (const c of candidates) stmtStatuses[c.idx] = "ambiguous";
      }
    }
  }

  const unmatchedStmt = stmtRows.filter((_, i) => stmtStatuses[i] === "unmatched");
  return { matched, ambiguous, unmatchedBb, unmatchedStmt, unmatchDiags, bbStatuses, stmtStatuses };
}

// ─── buildRuleCandidates ──────────────────────────────────────────────────────

export function buildRuleCandidates(matched: MatchedPair[]): RuleCandidate[] {
  // Group by extracted pattern
  const groups = new Map<string, {
    pairs: MatchedPair[];
    particularsSet: Set<string>;
  }>();

  for (const pair of matched) {
    const pattern = extractPattern(pair.stmtRow.narration);
    if (!pattern || pattern === "__unknown__" || pattern.length < 3) continue;

    const existing = groups.get(pattern);
    if (existing) {
      existing.pairs.push(pair);
      existing.particularsSet.add(pair.bbRow.particulars);
    } else {
      groups.set(pattern, {
        pairs: [pair],
        particularsSet: new Set([pair.bbRow.particulars]),
      });
    }
  }

  const auto: RuleCandidate[] = [];
  const conflicted: RuleCandidate[] = [];

  for (const [pattern, { pairs, particularsSet }] of groups.entries()) {
    const sample = pairs[0];
    const dir = sample.bbRow.debit != null ? "debit" : "credit";
    const amount = sample.bbRow.debit ?? sample.bbRow.credit ?? 0;
    const uniqueLedgers = Array.from(particularsSet);

    if (uniqueLedgers.length === 1) {
      auto.push({
        pattern,
        ledger_name: uniqueLedgers[0],
        occurrences: pairs.length,
        sample_narration: sample.stmtRow.narration,
        sample_date: sample.stmtRow.date,
        amount,
        direction: dir,
        status: "auto",
      });
    } else {
      conflicted.push({
        pattern,
        ledger_name: uniqueLedgers[0],  // first as default; CA must resolve
        occurrences: pairs.length,
        sample_narration: sample.stmtRow.narration,
        sample_date: sample.stmtRow.date,
        amount,
        direction: dir,
        status: "conflicted",
        conflict_ledgers: uniqueLedgers,
      });
    }
  }

  return [...auto, ...conflicted];
}
