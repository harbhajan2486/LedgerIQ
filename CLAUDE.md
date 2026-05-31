@AGENTS.md

# LedgerIQ — Working Context for Claude Code
*Updated: 2026-05-27*

---

## Rules (always follow these)

1. **Discuss before deploying.** Propose changes and wait for explicit go-ahead before running `vercel deploy` or making code changes.
2. **Read this file at the start of every session** to stay current on pending work and decisions.
3. **Update this file** at the end of each session with what was built and what's newly pending.

---

## What Has Been Built (current production state)

### Core Platform
- Client management (create/view clients with industry)
- Multi-tab client page: Overview, Documents, Bank Statements, Ledgers, Trial Balance, Mapping Rules, Bank Book Import

### Document Processing (Invoices)
- Upload + AI extraction (Claude Haiku → Sonnet fallback)
- Review queue (split-screen, keyboard shortcuts, undo corrections)
- Correction recording + audit log
- AI cost tracking in `ai_usage` table with hard monthly limit

### Bank Statement Processing
- CSV/Excel parser (`lib/bank-statement-parser.ts`) with 30-row header scan
- PDF extraction via Claude Haiku (`lib/pdf-bank-statement.ts`) — multi-pass with retry on 429
- Upload + store in `bank_transactions` table
- Reconciliation engine with 3-tier matching (exact → near → ambiguous)

### Bank Book Import (Historical Mapping)
- Tally bank book + bank statement uploaded together
- **Direction fix (2026-05-27):** BB Debit (money in, asset ↑) matches Stmt Credit; BB Credit (money out) matches Stmt Debit — opposite convention corrected in `lib/bank-book-matcher.ts`
- Matches by date ± 2 days and amount ± ₹1, direction-aware
- **P1:** Row-index proximity tiebreaker — when multiple candidates match date+amount, pick the one closest in row index to the BB row; only still-tied rows go to ambiguous
- Builds `ledger_mapping_rules` from matched pairs
- `parseTallyBankBook` strips "To"/"By" prefixes from Tally particulars; captures no-date rows as `subRows[]` on the preceding `BankBookRow`
- Positional fallback when no headers — handles Tally's standard column order
- Column mapping UI shown when detection is not confident
- **Single-PDF chunking:** client-side pdf-lib splits at 25 pages/chunk; per-chunk localStorage cache (`bb_chunk_${clientId}_${name}_${size}_c${i}`); uses `extract_only` → `match_with_rows` modes
- **Bulk PDF upload:** Statement file input accepts multiple files; cache key `bb_extract_${clientId}_${name}_${size}`
- **Cache persistence (2026-05-27):** Extracted chunks are NOT cleared after matching — survive across sessions and deployments. Stop button (AbortController) pauses extraction mid-run without losing extracted chunks. "Cached ✓ N chunks" badge + "Clear cache" link shown next to file picker.
- **Split-screen review UI (2026-05-27):**
  - All BB + stmt rows side-by-side, `1fr 40px 1fr` grid
  - Match % column (100% = exact, 90% = exact but has sub-rows needing review, computed % for near matches)
  - Colour-coded: green=matched, teal=confirmed suggestion, blue=suggestion, amber=ambiguous, white=unmatched
  - BB side: debit=green(+), credit=red(−); Stmt side: credit=green(+), debit=red(−) — correct conventions
  - Sub-rows (no-date Tally breakup rows) always shown indented under parent with sum validation (Σ matches parent?)
  - Sub-row "Use for rule" button — pick sub-row's ledger name instead of parent's generic name for rule creation
  - Common search bar filters both sides
  - Near-match suggestions for unmatched BB rows: same-date unmatched stmt rows shown in blue with "✓ Use" confirm button; each stmt row shown at most once
  - Per-row confirm tick (✓ checkbox): green=included in bulk confirm, grey=excluded; click to toggle
  - Row count mismatch banner with first-discrepancy row number
- **Editable alignment:** Per-row ✕ (remove) and ⤵ (mark as sub-row) buttons; Re-match (`rematch_json` mode, zero tokens) preserves sub-rows in payload; Reset clears edits
- **Bulk confirm button (2026-05-27):** "Confirm exact (N)" stat card at top — one click saves all 100% auto rules; rows with sub-rows capped at 90% and excluded from this count; per-row tick lets you add/remove before confirming
- Auto rules with 3+ occurrences show "100%" green badge in Rules tab
- AI suggestions (`source='ai_suggest'`) and pending bank book matches (`source='pending_bb'`) saved to DB; "Pending Review" section in Mapping Rules tab; Confirm all + auto-reapply
- `rematch_json` mode: accepts both BB and stmt rows as JSON, re-runs matching server-side — zero AI tokens

### Mapping Rules Engine (3-tier learning)
- **Layer 3 (client):** Every manual ledger assignment → upserts `ledger_mapping_rules` with `match_count`; auto-confirms at 3
- **Layer 2 (industry):** 3+ confirmed clients in same industry on same pattern → promotes to industry rule
- **Layer 1 (global):** Industry rule → nominates for admin approval
- `extractPattern()` in `lib/ledger-rules.ts` is shared between bank book matcher and reconciliation — consistent narration normalisation
- "Learned X/3" progress displayed on Bank Statements tab

### Ledger List Import
- Name-only import (no Dr/Cr/balances — separate from Trial Balance)
- Handles bold cell detection for group headers (Format 1: flat 2-col, Format 2: single-col with bold/indent)
- 30-row header scan
- Batched upsert in 1,000-row chunks (handles 20,000+ ledgers)
- Collapsible grouped display by `tally_group`

### Trial Balance Import
- Separate tab from Ledger List
- Parses Dr/Cr amounts and closing balances
- Multi-layout detection (Layout A/B/C)

### Stats / Mapping Coverage
- Bank tab shows: "Ledger mapping" card with %, `Y/Z txns mapped`, `N rules · M from history`
- Mapping Rules section shows pill badges: "X rules confirmed", "Y from historic import", "Z learned live"
- `bank-transactions` GET returns `rules_confirmed` and `rules_from_history` in summary

### Infrastructure
- Supabase PostgREST 1000-row cap bypassed with server-side pagination loop using `.range()`
- All routes under `/api/v1/`
- RLS on all tables
- `audit_log` table (append-only)
- Vercel production deploys from `main`; preview deploys on every PR

---

## Pending — Discussed but Not Yet Built

| Feature | Status | Notes |
|---|---|---|
| Save manual recon overrides as rules | ✅ Already built | `reconciliation/transactions/[id]/route.ts` already does this |
| Move rows in BB import alignment | Not built | User requested ability to move rows up/down; would require serialising row order client-side |
| Historic FY 2025-26 BB mapping incomplete | In progress | Bank book + bank statement uploaded, exact row-level mapping exists but not all rows confirmed yet as rules |

---

## Key Technical Decisions (do not revisit without reason)

- Ledger list = names only, no balances. Trial Balance is a separate tab.
- `clearAll` ledger delete = single `DELETE WHERE` query (not N concurrent requests)
- PDF extraction model: `claude-haiku-4-5-20251001`
- Header scan limit: 30 rows (was 15, increased 2026-05-22)
- `extractPattern()` is the single shared normalisation function — do not create a parallel version
- Bank book `ambiguous` response: always transform `bbRow` → `bb_row` before sending to client
- Tally "To HDFC Bank" / "To" + "By" prefix stripping is in both `bank-book-parser.ts` and `reparseWithOverrides` in the route
- BB Debit ↔ Stmt Credit (money in); BB Credit ↔ Stmt Debit (money out) — do not revert this direction mapping
- Sub-rows (no-date Tally rows) are parsed into `subRows[]` on preceding `BankBookRow`; must be included in `rematch_json` payload as `subRows` field or they'll be lost after re-match
- Rows with sub-rows are capped at 90% match confidence in split view even if date+amount are exact — forces manual ledger review

---

## Pricing Context (for product decisions)

- Per-client AI cost: ₹30–120/month ongoing (invoices + bank statements)
- Onboarding one-time: ₹7–50 per client (historic bank statement PDFs)
- Recommended SaaS pricing: ₹2,999 / ₹5,999 / ₹9,999 per firm per month (flat, not per-client)
- Bank CSV preferred over PDF for ongoing use — zero AI cost, instant

---

## How to Update This File

At the end of each session, update:
1. Move completed items from "Pending" to "What Has Been Built"
2. Add newly discussed/pending items to the Pending table
3. Update the date at the top
