# LedgerIQ — Product Requirements Document
**Version:** 2.0  
**Last Updated:** 17 May 2026  
**Status:** Live (deployed on Vercel — branch: main)

> **Changelog v2.0 (17 May 2026):** Major update covering all features built and bugs fixed since v1.0. Includes cross-tenant global rule learning, invoice matching improvements, 7 QA bug fixes, GST compliance fixes, dashboard overhaul, and full QA analysis findings.

---

## 1. Product Overview

**LedgerIQ** is an AI-powered accounting verification and reconciliation platform built for Indian Chartered Accountant (CA) firms. It automates the grunt work of invoice processing, bank statement reconciliation, GST filing preparation, and Tally ERP data entry — letting CAs spend time on advisory rather than data entry.

### The Problem
Indian CA firms manage 20–200 clients each. For every client, they manually:
- Key invoice data (vendor, amount, GST, TDS) into Tally from PDFs/images
- Match bank statement entries to invoices
- Classify every bank transaction to a ledger
- Compute GSTR-1, GSTR-3B, and TDS liability from scratch each month
- Export vouchers to Tally

This takes 2–4 hours per client per month. A 50-client firm spends 100–200 hours/month on pure data entry.

### The Solution
LedgerIQ replaces manual data entry with a three-stage AI pipeline:
1. **Extract** — AI reads invoices (PDF/image) and extracts all fields with confidence scores
2. **Verify** — CA reviews low-confidence fields; corrections feed a learning system
3. **Reconcile + Post** — system matches extractions to bank transactions; exports Tally-ready vouchers

---

## 2. Target Users

### Primary: CA Firm Staff
- **Senior CA / Partner** — Reviews exception flags, approves global rules, oversees GST filing
- **Reviewer / Article** — Processes review queue, corrects AI extractions, matches reconciliation
- **Admin** — Manages team access, billing, client onboarding, approves cross-tenant rule nominations

### Secondary: End-Clients (future)
- Business owners who upload invoices and bank statements directly (client portal — not yet built)

### Firm Profile (ICP)
- Indian CA firm
- 10–200 clients under management
- Currently using Tally ERP for books
- Primarily handles GST-registered businesses (B2B and B2C)
- Industries: services, manufacturing, retail, e-commerce, hospitality

---

## 3. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router), React, Tailwind CSS |
| Backend | Next.js API Routes (serverless, Vercel) |
| Database | Supabase (PostgreSQL + Row-Level Security) |
| AI Extraction | Anthropic Claude (Haiku default, Sonnet fallback) |
| File Storage | Supabase Storage |
| Edge Functions | Supabase Deno (extract-document, process-correction) |
| Payments | Stripe (subscription billing) |
| Analytics | Vercel Speed Insights |
| Deployment | Vercel (region: iad1) |

**Key Versions:** Next.js 16.2.2, Supabase JS 2.101.1, Anthropic SDK 0.86.0

---

## 4. Multi-Tenant Architecture

- Every piece of data is isolated by `tenant_id` (CA firm = one tenant)
- Row-Level Security (RLS) enforced on all tables at the database level
- Server client uses anon key — RLS applies to all server-side operations
- Users have roles: `super_admin`, `admin`, `senior_reviewer`, `reviewer`
- Clients (businesses managed by CA) are children of tenants

---

## 5. Core Feature Areas

### 5.1 Document Inbox (Invoice Upload & Extraction)
**Status: Live**

- Upload PDF, JPG, PNG, Excel invoices (max 50MB)
- SHA-256 deduplication — same file rejected with 409 and helpful message
- AI extracts: vendor name, GSTIN, invoice number/date, taxable value, CGST/SGST/IGST amounts, GST rate, HSN/SAC, TDS section/rate/amount, ITC eligibility, reverse charge flag, place of supply, ledger suggestion, **vendor GSTIN** (new — used in reconciliation matching)
- Confidence scores (0.0–1.0) per field
- Three-tier fallback: Claude Haiku (fast/cheap) → Sonnet (if avg confidence < 70%)
- Monthly AI budget cap with queue-when-over-budget behavior
- Retry with exponential backoff (3 attempts)
- Soft delete (deleted_at timestamp; 6-year retention per CGST Act Section 35)
- **All document queries now filter `deleted_at IS NULL`** — soft-deleted docs no longer count toward pending review totals

**Review Queue:**
- Documents with any field < 70% confidence → `review_required`
- CA reviews field-by-field; accepts or corrects each value
- Corrections stored immutably in `corrections` table
- Corrections feed learning system (process-correction edge function)
- **Extraction status priority:** `corrected` > `accepted` > `pending` (fixed ordering bug where accepted was incorrectly winning)

---

### 5.2 Five-Layer Ledger Intelligence
**Status: Live (upgraded from 4-layer to 5-layer)**

Rules applied in priority order (highest to lowest):

| Layer | Source | Trigger | Scope |
|---|---|---|---|
| 3 | Client confirmed patterns | 3+ manual assignments for this client | Per-client |
| 2 | Industry-promoted rules | 3+ clients in same industry share pattern→ledger | Per-tenant, per-industry |
| 1b | **Global approved rules** *(new)* | Admin approves cross-tenant nomination | All tenants |
| 1a | Built-in keyword rules (45+ patterns) | Every transaction, always | All tenants |
| 0 | Manual assignment | CA assigns directly, no rule matched | Per-transaction |

**Key functions (`lib/ledger-rules.ts`):**
- `extractPattern(narration)` — normalizes narration to stable key (strips UPI/NEFT/MB prefix, 6+ digit refs, lowercase, first 30 chars; returns `"__unknown__"` if empty)
- `suggestLedger(narration)` — Layer 1 global keyword matching
- `ledgerToMeta(ledgerName)` — maps ledger → Tally category + voucher type
- `BLOCKED_NARRATION_PATTERNS` *(now exported)* — salary, GST payment, TDS, EMI etc. — these are never matched to invoices

**Rule Learning:**
- Each manual ledger assignment increments `ledger_mapping_rules.match_count`
- At count=3 → `confirmed=true` → becomes Layer 3 rule
- UI shows `● ● ○ Learning (2/3)` progress dots on each transaction row
- Toast on assignment: "Assign 2 more times to auto-confirm"

**T&B Name Resolution:**
- `deriveLedgerSource()` uses fuzzy prefix matching — "Salary" (T&B) correctly identifies as "Layer 1 – global keyword" (global = "Salary Expenses")
- Amber "Not in ledger master" warning when ledger not in client's T&B

**Narration matching explainer note** — static info box at top of Bank Statements tab explains trimming logic, fuzzy matching, and layer priority to CAs.

---

### 5.3 Cross-Tenant Global Rule Learning *(new in v2.0)*
**Status: Live**

The system's core moat: ledger and tax treatment knowledge accumulates across all CA firms using LedgerIQ and is crowd-sourced into global rules — with admin approval and full privacy protection.

**How it works:**
1. CA assigns ledger to transactions (Layer 3 learning starts)
2. After 3 clients in same industry confirm same pattern → Layer 2 (industry rule)
3. At Layer 2 promotion, system checks if 3+ other tenants have confirmed the same pattern → **nominates for admin review**
4. Nomination captures tax metadata from linked invoices: RCM flag, TDS section, GST rate
5. Admin reviews in **Rules Library → Global Learning tab**
6. On approval → rule becomes active Layer 1b for **all tenants immediately** (no code deploy needed)

**Privacy safeguards:**
- Patterns containing 3+ consecutive long words (likely person names e.g. "omkar mangesh kalamkar") are **never nominated** — blocked by `isSafeToNominate()` check
- Only the normalized pattern keyword + ledger name + industry is shared — never client names, amounts, or raw narrations
- Admin approval required before anything goes global

**Tax attributes captured per nomination:**
- `rcm_applicable` — shown as RCM badge in admin queue
- `tds_section` — shown as TDS §194J badge
- `suggested_gst_rate` — shown as GST 18% badge

**DB tables (Migration 002):**
- `global_rule_nominations` — nomination queue (pattern, ledger, industry, tax attrs, tenant_count, status)
- `global_rule_nomination_votes` — dedup: one vote per tenant per nomination

**API:**
- `GET /api/v1/admin/nominations` — list all nominations (admin only)
- `POST /api/v1/admin/nominations` — approve or reject (admin only)

---

### 5.4 Bank Statement Import & Reconciliation
**Status: Live (significantly improved in v2.0)**

**Import:**
- Accepts CSV, Excel (.xlsx/.xls), PDF bank statements
- PDF: multi-pass Claude Haiku extraction (up to 4 passes for long statements)
- Auto-detects date formats (DD/MM/YYYY, YYYY-MM-DD, DD-Mon-YYYY, etc.)
- Clean re-upload: deletes existing rows for same client+bank+period before re-inserting
- Hash-based dedup for uploads without client context
- Layer 1/2/3 ledger auto-assignment at import time
- Loads up to 2,000 transactions; amber truncation banner shown if DB has more

**BS Tab Filters:**
- Column filters: Ledger, Status, Category (checkbox multi-select with search)
- Date sort toggle (asc/desc)
- **Date range picker (new)** — From / To date inputs; filters by `transaction_date` client-side
- Text search across narration, ref, category, ledger, amount
- Narration pattern display (`→ zomato`) below each transaction row
- Static explainer note at top explaining trimming logic and layer system

**Reconciliation scoring (`scoreMatch` in `lib/bank-statement-parser.ts`):**

| Signal | Points | Condition |
|---|---|---|
| Exact amount match | +50 | ±₹1 |
| Amount within 2% | +40 | — |
| Amount = invoice − TDS | +35 | with TDS amount |
| Amount within 10% | +15 | — |
| UTR/ref exact match | +55 | strongest signal |
| Invoice number in narration | +45 | ≥6 chars, has digit, word boundary |
| Payment reference in narration | +45 | — |
| **Vendor GSTIN in narration** *(new)* | **+40** | 15-char GSTIN found in narration |
| Within 3 days of due date | +30 | — |
| Vendor/customer name ≥2 words | +30 | — |
| Within 7 days of due date | +25 | — |
| Within 3 days of invoice date | +20 | — |
| Vendor/customer 1 word | +12 | — |

**Thresholds:** ≥70 = auto-matched, 40–69 = possible_match (needs review), <40 = no match

**Stale match cleanup (new):**
- On every auto-match run, existing reconciliation rows for `BLOCKED_NARRATION_PATTERNS` (salary, GST, EMI etc.) are automatically deleted — prevents phantom 50% matches from old runs
- Only auto-generated matches are cleaned; manual matches (score=100) are preserved

**Ledger overwrite protection (new):**
- Auto-match no longer overwrites a manually-assigned `ledger_name` on a transaction
- Only fills in ledger from invoice's `suggested_ledger` if the transaction has no existing ledger

**Recon tab — invoice summary cards (new):**
- 4 stat cards at top of Recon tab: Invoices matched / Possible matches / Awaiting payment / Unexplained txns

**Recon tab — Invoices sub-tab improvements (new):**
- Invoice Date column added
- Invoice Number shown below filename

**Exception count fix:**
- Exception count in summary was always 0 (bug: enrichedRecons excludes exceptions); now correctly counted from raw reconciliation rows

**Reconciliation data API improvements:**
- Unmatched invoices now include `invoice_date` and `invoice_number` from extractions
- Extraction status ordering fixed: `corrected` now correctly wins over `accepted`

---

### 5.5 GST Filing Preparation
**Status: Live (compliance-fixed in v2.0)**

Generates GSTR-1 + GSTR-3B data from reviewed invoices, filtered by `invoice_date` (not upload date).

**GSTR-1:**
- B2B: sales with recipient GSTIN — `buyer_gstin` only (never falls back to `vendor_gstin`, bug fixed)
- B2C Large: interstate sales > ₹2.5L
- B2C Small: aggregated by rate + place of supply
- HSN/SAC Summary (Table 12): Total Value = taxable + IGST + CGST + SGST (fixed — was taxable-only)
- Credit notes reduce outward supply; debit notes increase it (fixed — debit notes were ignored)

**GSTR-3B:**
- 3.1(a): Outward taxable supplies — net of credit notes and debit notes, consistent taxable + tax
- 3.1(d): Inward supplies liable to RCM — from **purchase invoices** with `reverse_charge="Yes"` (GTA, security agencies, legal advocates) — fixed; was wrongly using outward sales docs
- 4(A): ITC from eligible purchases — case-insensitive `itc_eligible` check ("yes"/"Yes"/"YES" all accepted)
- ITC set-off per **Rule 88A** (7-step algorithm):
  1. IGST ITC → IGST output
  2. Remaining IGST ITC → CGST output
  3. Remaining IGST ITC → SGST output
  4. CGST ITC → remaining CGST payable
  5. CGST ITC → remaining IGST payable
  6. SGST ITC → remaining SGST payable
  7. SGST ITC → remaining IGST payable
- Inward RCM card shown dynamically in UI when RCM purchases exist
- Excel export: 6 sheets (GSTR-3B Summary, B2B, B2C Large, B2C Small, HSN, ITC Register)
- Excel notes warn CA to verify against GSTR-2B before claiming ITC

**Period presets (updated):**
- Quick buttons: This Month, Q1–Q4, + **up to 5 FY years dynamically** (current FY + all prior FYs since 2021; grows automatically each year)

**Known limitations:**
- GSTR-3B sections 3.1(b) zero-rated exports and 3.1(c) nil-rated/exempt — show zero, entered manually
- No GSTR-2B import or ITC reconciliation against GST portal
- No GSTR-9 (annual return)
- No GSTIN checksum validation (only length check)
- No Place of Supply cross-validation against client's registered state

---

### 5.6 TDS Management
**Status: Live (partial)**

- AI extracts TDS section, rate, and amount from invoices
- Deterministic keyword override for low-confidence cases (194J, 194C, 194I, 194A, 194O…)
- TDS summary per section with monthly accrual
- Due date awareness (7th of next month; March = April 30)

**Known limitations:**
- No reconciliation of TDS deducted (from invoices) vs TDS paid (from bank debits)
- No Form 26AS/AIS import or matching

---

### 5.7 Tally ERP Integration
**Status: Live**

- Generates Tally-compatible XML vouchers (Purchase, Sales, Payment, Receipt, Journal)
- Posting queue with pending/posted/failed status
- Retry on failure
- Test connection endpoint
- `tally_ledger_mappings` table: standard account → client's Tally ledger name

**Known limitations:**
- No push notification to CA when posting fails (requires Tally to be open)
- No exponential backoff retry queue

---

### 5.8 Trial Balance / Ledger Master
**Status: Live**

- Import T&B from Tally CSV export
- Ledger detail view per account (invoice-by-invoice with payment linkage)
- Trial balance with Dr/Cr columns
- Opening/closing balances by financial year
- Amber indicator when transaction ledger is not in T&B

---

### 5.9 Rules Library *(upgraded in v2.0)*
**Status: Live**

Three top-level tabs:

**Ledger Rules tab:**
- Layer 3 (client rules) — per-client confirmed and learning patterns, with copy-to-client and promote-to-industry actions
- Layer 2 (industry rules) — rules confirmed by 3+ clients in same industry
- Layer 1 (global rules) — 45+ built-in keyword rules with examples

**Taxation Rules tab:**
- TDS sections reference (Income Tax Act 1961) — section, rate, threshold, notes
- HSN code GST rates — prefix → description → CGST/SGST/IGST rates
- SAC codes for services
- RCM applicability table
- ITC eligibility guide

**Global Learning tab *(new)***:
- Shows cross-tenant nominations queue
- Filter by: Nominated / Approved / Rejected / All
- Per-row: pattern key, ledger name, industry, tax attributes (RCM / TDS section / GST rate badges), tenant vote count
- Admin actions: Approve (promotes to Layer 1b globally) / Reject
- Pending nomination count shown as badge on tab

---

### 5.10 Dashboard *(upgraded in v2.0)*
**Status: Live**

**Row 1 — Client health:**
- Active Clients (total clients in firm)
- Pending Review (documents needing CA attention — now excludes soft-deleted docs)
- Avg. Completion % (% of reviewed/reconciled/posted docs per client, averaged across all clients)

**Row 2 — Activity:**
- Uploaded Today
- Matched This Week (reconciliations confirmed in last 7 days)
- Exceptions (reconciliation exceptions needing resolution)

---

### 5.11 Billing & Plans
**Status: Live**

- Stripe subscription (starter/professional/business/enterprise)
- Monthly document limit enforced
- AI monthly budget cap (default $50) — over-budget docs queued
- Budget alert notification at 80%
- Customer portal for self-serve plan changes

---

## 6. Database Schema (Key Tables)

| Table | Purpose |
|---|---|
| `tenants` | CA firm isolation root |
| `users` | Team members with roles |
| `clients` | End-clients of CA firm |
| `documents` | Invoice/statement uploads (soft delete via `deleted_at`) |
| `extractions` | AI-extracted field values + confidence |
| `corrections` | Immutable human corrections (append-only) |
| `bank_transactions` | Imported bank statement rows |
| `reconciliations` | Document ↔ bank transaction links |
| `ledger_masters` | Client's chart of accounts (from T&B import) |
| `ledger_mapping_rules` | Pattern → ledger rules (Layers 2 and 3) |
| `global_rule_nominations` | **New** — cross-tenant crowd-sourced rule nominations |
| `global_rule_nomination_votes` | **New** — dedup: one vote per tenant per nomination |
| `tally_postings` | Voucher posting queue |
| `audit_log` | Append-only compliance trail |
| `ai_usage` | Per-doc AI cost tracking |
| `correction_vectors` | 384-dim embeddings for few-shot learning |
| `vendor_profiles` | Learned vendor quirks |

All tables: RLS enabled, `tenant_id`-based isolation.

---

## 7. Bug Fix Log (v1.0 → v2.0)

### GST Compliance Fixes
| # | Bug | Fix |
|---|---|---|
| F1 | GSTR-3B 3.1(d) computed from outward docs (wrong direction) | Now uses purchase invoices with reverse_charge="Yes" |
| F2 | B2B GSTIN used client's own GSTIN as recipient | Now uses `buyer_gstin` only |
| F3 | Debit notes not increasing output tax | `debitNoteAddition` now added to outward supplies |
| F4 | HSN Total Value was taxable-only (missing tax component) | Now = taxable + IGST + CGST + SGST |
| F5 | ITC eligibility was case-sensitive ("Yes" vs "yes") | Now case-insensitive |
| F6 | Rule 88A ITC cross-utilization missing | Full 7-step algorithm implemented |
| F7 | Credit note taxable value not tracked in output computation | Fixed — tracks both taxable and tax reduction |

### Reconciliation Fixes
| # | Bug | Fix |
|---|---|---|
| F8 | Salary transactions showing 50% match (stale records) | Auto-match now deletes blocked-narration recon rows before re-scoring |
| F9 | Auto-match overwrote manual ledger assignments silently | Checks for existing ledger before overwriting |
| F10 | Exception count always 0 in summary | Now counted from raw recons (not enriched, which excluded exceptions) |
| F11 | Extraction `corrected` status was losing to `accepted` | Fixed ordering: descending sort so corrected wins |
| F12 | `deriveLedgerSource` showed "Manually assigned" for T&B-shortened names | Fuzzy prefix matching added ("Salary" → "Salary Expenses") |

### UI / Data Fixes
| # | Bug | Fix |
|---|---|---|
| F13 | DronE3E "1 pending review" phantom count | Added `deleted_at IS NULL` filter to all document queries |
| F14 | Bank statement silent truncation at 1000 rows | Lifted to 2000; amber banner shown if DB has more |
| F15 | Empty `extractPattern` producing wildcard `""` key | Returns `"__unknown__"` instead of empty string |
| F16 | Dashboard missing client count and completion % | Added Active Clients + Avg. Completion % stat cards |
| F17 | Invoice date missing in Recon > Unmatched Invoices tab | `invoice_date` and `invoice_number` now fetched and displayed |
| F18 | No invoice-level summary on Recon tab | 4 stat cards added: matched / possible / awaiting / unexplained |
| F19 | No date filter on Bank Statements tab | From/To date pickers added to filter bar |
| F20 | GST period showed only 2 FY years | Now shows up to 5 FY years dynamically, grows each year |

---

## 8. Known Bugs / Active Backlog

### Must Fix (compliance risk)
| # | Issue |
|---|---|
| B1 | No GSTR-2B import — ITC claimed without portal verification |
| B2 | GSTIN format not checksum-validated (only length check) |
| B3 | Place of Supply not cross-validated against client's state |
| B4 | No financial year lock — retroactive edits possible after filing |

### High Priority
| # | Issue |
|---|---|
| B5 | No TDS paid vs deducted reconciliation |
| B6 | No Form 26AS/AIS import |
| B7 | Tally posting failures are silent (no notification) |
| B8 | Partial payment tracking — one invoice paid in two instalments not handled |
| B9 | Bulk payments (one txn pays multiple invoices) not reconcilable |
| B10 | Bank transaction filter state resets on tab switch (not URL-persisted) |
| B11 | Learning rule count can be gamed — same user assigning 3× increments without uniqueness check |

### Product Gaps
| # | Gap |
|---|---|
| G1 | No client self-upload portal (clients use WhatsApp/email) |
| G2 | No due-date calendar (TDS, advance tax, GSTR-1, GSTR-3B) |
| G3 | No GSTR-9 annual return generation |
| G4 | No audit trail export in statutory auditor format |
| G5 | No match approval audit trail (who approved which match and why) |
| G6 | No workflow "next step" guidance between tabs |
| G7 | No ITR filing integration |
| G8 | No composition scheme support (GSTR-4) |
| G9 | No Vercel region close to India (currently iad1 = Washington DC) — adds ~200ms latency |
| G10 | Score breakdown not shown to CA in UI (only total % visible, not signal breakdown) |
| G11 | No multi-bank consolidated view per client |

---

## 9. Planned Features (Roadmap)

### Near-term (next 4–8 weeks)
1. **GSTIN checksum validation** — reject invalid GSTINs at extraction review
2. **Tax due-date calendar** — per-client filing dashboard with overdue indicators
3. **TDS paid reconciliation** — match bank TDS challan payments to TDS deducted register
4. **Tally failure notifications** — email/in-app alert when voucher posting fails
5. **Match score breakdown** — show signal-level points in Possible Matches UI (amount: 50pts, date: 25pts, etc.)
6. **URL-persistent filters** — bank tab and recon tab filter state saved in URL params
7. **Partial payment tracking** — allow multiple bank transactions to link to one invoice with outstanding balance

### Medium-term (2–3 months)
1. **Client self-upload portal** — shareable link per client; client uploads directly
2. **GSTR-2B import + ITC reconciliation** — paste/upload GSTR-2B JSON; flag mismatches
3. **Financial year lock** — freeze period after GSTR-1/3B filed; block retroactive edits
4. **Form 26AS/AIS import** — reconcile TDS credits with income tax portal data
5. **Mobile-responsive redesign** — current client page unusable on tablet/mobile
6. **Bulk payment reconciliation** — one bank txn matched to multiple invoices

### Longer-term
1. GSTR-9 (annual return) generation
2. Advance tax computation and reminders
3. ITR-6/ITR-3 preparation assistance
4. Multi-bank consolidation (single client, multiple bank accounts)
5. Vercel region migration to Mumbai (bom1) for India-latency improvement
6. WhatsApp bot for client document submission
7. Global rule library — as nominations accumulate and get approved, publish industry-specific rule packs (Drone/Aviation, Hospitality, Manufacturing etc.)

---

## 10. Compliance & Security

- **Data retention:** Soft deletes only; documents retained permanently per CGST Act Section 35
- **Audit trail:** Append-only `audit_log`; no UPDATE/DELETE grants on this table; admin nomination approvals logged
- **PII in global learning:** Patterns containing person names blocked by `isSafeToNominate()` — only generic keywords shared cross-tenant
- **PII in AI:** Never sent to AI or embeddings — only structural patterns (field names, amounts, thresholds)
- **Multi-tenant isolation:** RLS on every table; anon key used (never service role key in client paths)
- **Global rule nominations:** RLS — regular users can only read approved rules; admin POST protected by role check
- **Rate limiting:** Sliding window per user (`rate_limit_log` table)
- **GDPR export:** `/v1/export` returns full firm data as CSV

---

## 11. AI Cost Model

| Model | Input | Output | Used For |
|---|---|---|---|
| Claude Haiku 4.5 | $0.80/MTok | $4.00/MTok | Default extraction, PDF bank parsing |
| Claude Sonnet 4.6 | $3.00/MTok | $15.00/MTok | Re-extraction when confidence < 70% |

- Monthly budget: configurable per tenant (default $50 USD)
- Alert at 80% of budget
- Queue documents when over budget; process when budget resets
- AI usage logged per document in `ai_usage` table

---

## 12. Key API Endpoints Reference

```
POST /api/v1/documents/upload                          — upload invoice, trigger extraction
GET  /api/v1/review/queue                              — list pending review queue
GET  /api/v1/review/[docId]                            — get extraction for review
POST /api/v1/review/[docId]/correct                    — CA corrects a field
POST /api/v1/review/[docId]/complete                   — mark extraction reviewed
GET  /api/v1/clients/[id]/bank-transactions            — get BS transactions (max 2000, with approved global rules)
POST /api/v1/reconciliation/upload-statement           — import bank statement
POST /api/v1/reconciliation/auto-match                 — run matching algorithm (with GSTIN scoring + stale cleanup)
POST /api/v1/reconciliation/match                      — manual match
POST /api/v1/reconciliation/match-approve              — approve possible match
POST /api/v1/reconciliation/unmatch                    — remove match, revert statuses
PATCH /api/v1/reconciliation/transactions/[id]         — set ledger/category; triggers learning + nomination
POST /api/v1/clients/[id]/reapply-ledger-rules         — batch re-apply all ledger rules
GET  /api/v1/clients/[id]/gst-filing?from=&to=&format= — GSTR-1+3B export (by invoice_date)
GET  /api/v1/clients/[id]/ledger                       — trial balance + ledger detail
POST /api/v1/tally/post                                — post vouchers to Tally
GET  /api/v1/admin/nominations                         — list cross-tenant rule nominations (admin only)
POST /api/v1/admin/nominations                         — approve or reject a nomination (admin only)
GET  /api/v1/reconciliation/data                       — full recon data with corrected extraction ordering
```

---

## 13. Glossary

| Term | Meaning |
|---|---|
| T&B | Trial Balance — client's Tally chart of accounts |
| RCM | Reverse Charge Mechanism — buyer pays GST instead of seller |
| ITC | Input Tax Credit — GST paid on purchases, offset against output GST |
| GSTR-1 | Monthly/quarterly outward supplies return (due 11th) |
| GSTR-3B | Monthly summary return + tax payment (due 20th) |
| GSTR-2B | Auto-populated ITC register from portal (supplier's GSTR-1 data) |
| TDS | Tax Deducted at Source — deducted on certain payments, deposited by 7th |
| Rule 88A | ITC set-off order under CGST Rules — IGST ITC used first against IGST, then CGST, then SGST |
| Layer 1/2/3 | LedgerIQ's ledger rule tiers (see Section 5.2); now includes Layer 1b (approved global nominations) |
| Global Learning | Cross-tenant rule nomination system — crowd-sources ledger + tax patterns with admin approval |
| extractPattern | Canonical narration normalization function in `lib/ledger-rules.ts` |
| isSafeToNominate | PII safety check in `lib/global-rules.ts` — blocks patterns with 3+ consecutive long words |
| Tenant | One CA firm (multi-tenant SaaS isolation unit) |
| BLOCKED_NARRATION_PATTERNS | Salary/GST/EMI patterns excluded from invoice matching (exported from `lib/bank-statement-parser.ts`) |
