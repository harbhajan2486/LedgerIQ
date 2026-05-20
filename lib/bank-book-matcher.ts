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
}

export interface AmbiguousPair {
  bbRow: BankBookRow;
  candidates: StatementRow[];  // 2+ candidates
}

export interface MatchResult {
  matched: MatchedPair[];
  ambiguous: AmbiguousPair[];
  unmatchedBb: BankBookRow[];  // bank book rows with no statement match
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

  for (const bbRow of bbRows) {
    // Determine direction and amount
    const dir = bbRow.debit != null ? "debit" : "credit";
    const amt = bbRow.debit ?? bbRow.credit ?? 0;

    // Filter by direction: matching column must be non-null
    const dirFiltered = stmtRows.filter((s) =>
      dir === "debit" ? s.debit != null : s.credit != null
    );

    // Filter by amount: within ±1 rupee
    const amtFiltered = dirFiltered.filter((s) => {
      const sAmt = dir === "debit" ? (s.debit ?? 0) : (s.credit ?? 0);
      return Math.abs(sAmt - amt) <= 1;
    });

    // Filter by date: within ±2 days
    const candidates = amtFiltered.filter(
      (s) => dateDiffDays(s.date, bbRow.date) <= 2
    );

    if (candidates.length === 0) {
      unmatchedBb.push(bbRow);
    } else if (candidates.length === 1) {
      const stmtRow = candidates[0];
      const sAmt = dir === "debit" ? (stmtRow.debit ?? 0) : (stmtRow.credit ?? 0);
      const exactDate = stmtRow.date === bbRow.date;
      const exactAmt = Math.abs(sAmt - amt) < 0.001;
      const confidence: "exact" | "near" = (exactDate && exactAmt) ? "exact" : "near";
      matched.push({ bbRow, stmtRow, confidence });
    } else {
      ambiguous.push({ bbRow, candidates });
    }
  }

  return { matched, ambiguous, unmatchedBb };
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
