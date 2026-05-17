# LedgerIQ — Product Requirements Document
**Version:** 1.0  
**Last Updated:** May 2026  
**Status:** Live (deployed on Vercel)

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
- **Senior CA / Partner** — Reviews exception flags, approves rules, oversees GST filing
- **Reviewer / Article** — Processes review queue, corrects AI extractions, matches reconciliation
- **Admin** — Manages team access, billing, client onboarding

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
- AI extracts: vendor name, GSTIN, invoice number/date, taxable value, CGST/SGST/IGST amounts, GST rate, HSN/SAC, TDS section/rate/amount, ITC eligibility, reverse charge flag, place of supply, ledger suggestion
- Confidence scores (0.0–1.0) per field
- Three-tier fallback: Claude Haiku (fast/cheap) → Sonnet (if avg confidence < 70%)
- Monthly AI budget cap with queue-when-over-budget behavior
- Retry with exponential backoff (3 attempts)
- Soft delete (deleted_at timestamp; 6-year retention per CGST Act Section 35)

**Review Queue:**
- Documents with any field < 70% confidence → `review_required`
- CA reviews field-by-field; accepts or corrects each value
- Corrections stored immutably in `corrections` table
- Corrections feed learning system (process-correction edge function)

### 5.2 Four-Layer Ledger Intelligence
**Status: Live**

Rules applied in priority order:

| Layer | Source | Trigger |
|---|---|---|
| 0 | Client confirmed rules (during extraction) | 3+ confirmed assignments for this client |
| 1 | Global keyword rules (45+ patterns) | Every transaction, always |
| 2 | Industry-promoted rules | When 3+ clients in same industry share pattern→ledger |
| 3 | Client confirmed patterns (post-upload) | 3+ manual assignments for this client |

**Key functions (lib/ledger-rules.ts):**
- `extractPattern(narration)` — normalizes narration to stable key (strips UPI/NEFT prefix, 6+ digit refs, takes first 30 chars; returns `"__unknown__"` if empty)
- `suggestLedger(narration)` — Layer 1 global keyword matching
- `ledgerToMeta(ledgerName)` — maps ledger → Tally category + voucher type
- `resolveToMasterLedger()` — maps global suggestion to client's T&B name via substring match

**Rule Learning:**
- Each manual ledger assignment increments `ledger_mapping_rules.match_count`
- At count=3 → `confirmed=true` → becomes Layer 3 rule
- UI shows `● ● ○ Learning (2/3)` progress dots
- Toast on assignment: "Assign 2 more times to auto-confirm"
- Rule confirmed toast: "will now auto-map on all future uploads"

**T&B Name Resolution:**
- If client uploads Trial Balance, ledger names are resolved to their T&B names
- `deriveLedgerSource()` uses fuzzy prefix matching so "Salary" (T&B) correctly identifies as "Layer 1 – global keyword" (global = "Salary Expenses")
- Amber "Not in ledger master" warning when ledger not in client's T&B

### 5.3 Bank Statement Import & Reconciliation
**Status: Live**

**Import:**
- Accepts CSV, Excel (.xlsx/.xls), PDF bank statements
- PDF: multi-pass Claude Haiku extraction (up to 4 passes for long statements)
- Auto-detects date formats (DD/MM/YYYY, YYYY-MM-DD, DD-Mon-YYYY, etc.)
- Clean re-upload: deletes existing rows for same client+bank+period before re-inserting (no duplicates)
- Hash-based dedup for uploads without client context
- Layer 1/2/3 ledger auto-assignment at import time
- Loads up to 2,000 transactions; amber banner shown if DB has more

**BS Tab Filters (Excel-like):**
- Column filters: Ledger, Status, Category (checkbox multi-select with search)
- Date sort toggle (asc/desc)
- Text search across narration
- Narration pattern display (`→ zomato`) with ⓘ tooltip explaining trim logic

**Reconciliation:**
- Auto-match scoring: amount (±0.01, +25pts), date proximity (±5 days, +20pts), invoice number in narration (+15pts), vendor name (+10pts), ref match (+10pts), ledger category match (+10pts), TDS detection (+5pts)
- Thresholds: ≥70 = matched, 40–69 = possible_match, <40 = no match
- Greedy assignment (highest score pairs allocated first)
- Manual match override
- Match approve flow for review manager
- Unmatch/revert supported

### 5.4 GST Filing Preparation
**Status: Live (compliance-fixed)**

Generates GSTR-1 + GSTR-3B data from reviewed invoices:

**GSTR-1:**
- B2B: sales with recipient GSTIN (buyer_gstin only — never falls back to vendor_gstin)
- B2C Large: interstate sales > ₹2.5L
- B2C Small: aggregated by rate + place of supply
- HSN/SAC Summary (Table 12): Total Value = taxable + tax (not just taxable)

**GSTR-3B:**
- 3.1(a): Outward taxable supplies — net of credit notes and debit notes
- 3.1(d): Inward supplies liable to RCM — from purchase invoices with reverse_charge="Yes" (GTA, security, legal)
- 4(A): ITC from eligible purchases — case-insensitive "yes" detection
- ITC set-off per **Rule 88A**: IGST ITC → IGST → CGST → SGST; CGST ITC → CGST → IGST; SGST ITC → SGST → IGST
- Credit notes reduce output tax; debit notes increase it
- Inward RCM card shown dynamically in UI when RCM purchases exist
- Excel export: 6 sheets (GSTR-3B Summary, B2B, B2C Large, B2C Small, HSN, ITC Register)
- Notes in Excel warn CA to verify against GSTR-2B before claiming ITC

**Period presets:**
- Quick buttons: This Month, Q1 (Apr–Jun), Q2 (Jul–Sep), Q3 (Oct–Dec), Q4 (Jan–Mar), Current FY, Last FY

**Known limitations (not yet built):**
- GSTR-3B sections 3.1(b) zero-rated exports and 3.1(c) nil-rated/exempt — show zero, entered manually
- No GSTR-2B import or ITC reconciliation against GST portal
- No GSTR-9 (annual return)
- No GSTIN checksum validation (only length check)
- No Place of Supply cross-validation against client's registered state

### 5.5 TDS Management
**Status: Live (partial)**

- AI extracts TDS section, rate, and amount from invoices
- Deterministic keyword override for low-confidence cases (194J, 194C, 194I, 194A, 194O…)
- TDS summary per section with monthly accrual
- Due date awareness (7th of next month; March = April 30)

**Known limitations:**
- No reconciliation of TDS deducted (from invoices) vs TDS paid (from bank debits)
- No Form 26AS/AIS import or matching

### 5.6 Tally ERP Integration
**Status: Live**

- Generates Tally-compatible XML vouchers (Purchase, Sales, Payment, Receipt, Journal)
- Posting queue with pending/posted/failed status
- Retry on failure
- Test connection endpoint
- `tally_ledger_mappings` table: standard account → client's Tally ledger name (e.g. `input_igst_18` → `"Input IGST @18%"`)

**Known limitations:**
- No push notification to CA when posting fails (requires Tally to be open)
- No exponential backoff retry queue

### 5.7 Trial Balance / Ledger Master
**Status: Live**

- Import T&B from Tally CSV export
- Ledger detail view per account (invoice-by-invoice with payment linkage)
- Trial balance with Dr/Cr columns
- Opening/closing balances by financial year
- Amber indicator when transaction ledger is not in T&B

### 5.8 AI Learning System
**Status: Live**

- Every correction embeds structural pattern (not PII) via Supabase Transformers.js (384-dim vector, free)
- Future uploads retrieve top-5 similar corrections via cosine similarity
- Vendor profile: if 3+ corrections for same vendor+field → `invoice_quirks` updated
- Industry promotion: if 10+ independent tenants agree on pattern+field+value → queued for super-admin review → Layer 2 global rule

### 5.9 Rules Library
**Status: Live**

- View all Layer 1 (global), Layer 2 (industry), Layer 3 (client) rules in one screen
- Edit ledger name and pattern inline
- Search/filter
- Progress dots for unconfirmed client rules

### 5.10 Billing & Plans
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
| `documents` | Invoice/statement uploads (soft delete) |
| `extractions` | AI-extracted field values + confidence |
| `corrections` | Immutable human corrections (append-only) |
| `bank_transactions` | Imported bank statement rows |
| `reconciliations` | Document ↔ bank transaction links |
| `ledger_masters` | Client's chart of accounts (from T&B import) |
| `ledger_mapping_rules` | Pattern → ledger rules (all 3 layers) |
| `tally_postings` | Voucher posting queue |
| `audit_log` | Append-only compliance trail |
| `ai_usage` | Per-doc AI cost tracking |
| `correction_vectors` | 384-dim embeddings for few-shot learning |
| `vendor_profiles` | Learned vendor quirks |

All tables: RLS enabled, `tenant_id`-based isolation.

---

## 7. Known Bugs / Active Backlog

### Must Fix (compliance risk)
| # | Issue | File |
|---|---|---|
| B1 | No GSTR-2B import — ITC claimed without portal verification | Missing feature |
| B2 | GSTIN format not checksum-validated (only length check) | gst-filing/route.ts |
| B3 | Place of Supply not cross-validated against client's state | gst-filing/route.ts |
| B4 | No financial year lock — retroactive edits possible after filing | Missing feature |

### High Priority
| # | Issue | File |
|---|---|---|
| B5 | No TDS paid vs deducted reconciliation | Missing feature |
| B6 | No Form 26AS/AIS import | Missing feature |
| B7 | Tally posting failures are silent (no notification) | tally/route.ts |
| B8 | No document dedup on re-upload for global (no clientId) context | upload-statement |

### Product Gaps
| # | Gap |
|---|---|
| G1 | No client self-upload portal (clients use WhatsApp/email) |
| G2 | No due-date calendar (TDS, advance tax, GSTR-1, GSTR-3B) |
| G3 | No GSTR-9 annual return generation |
| G4 | No audit trail export in statutory auditor format |
| G5 | No bank transaction pagination UI (shows 2000 max with warning) |
| G6 | No workflow "next step" guidance between tabs |
| G7 | No ITR filing integration |
| G8 | No composition scheme support (GSTR-4) |
| G9 | No Vercel region close to India (currently iad1 = Washington DC) — adds ~200ms latency |

---

## 8. Planned Features (Roadmap)

### Near-term (next 4–8 weeks)
1. **GSTIN checksum validation** — reject invalid GSTINs at extraction review
2. **Tax due-date calendar** — per-client filing dashboard with overdue indicators
3. **TDS paid reconciliation** — match bank TDS challan payments to TDS deducted register
4. **Tally failure notifications** — email/in-app alert when voucher posting fails
5. **Workflow next-step banners** — "3 invoices reviewed → ready to reconcile" prompts

### Medium-term (2–3 months)
1. **Client self-upload portal** — shareable link per client; client uploads directly
2. **GSTR-2B import + ITC reconciliation** — paste/upload GSTR-2B JSON; flag mismatches
3. **Financial year lock** — freeze period after GSTR-1/3B filed; block retroactive edits
4. **Form 26AS/AIS import** — reconcile TDS credits with income tax portal data
5. **Mobile-responsive redesign** — current client page unusable on tablet/mobile

### Longer-term
1. GSTR-9 (annual return) generation
2. Advance tax computation and reminders
3. ITR-6/ITR-3 preparation assistance
4. Multi-bank consolidation (single client, multiple bank accounts)
5. Vercel region migration to Mumbai (bom1) for India-latency improvement
6. WhatsApp bot for client document submission

---

## 9. Compliance & Security

- **Data retention:** Soft deletes only; documents retained permanently per CGST Act Section 35
- **Audit trail:** Append-only `audit_log`; no UPDATE/DELETE grants on this table
- **PII in AI:** Never sent to AI or embeddings — only structural patterns (field names, amounts, thresholds)
- **Multi-tenant isolation:** RLS on every table; anon key used (never service role key in client paths)
- **Rate limiting:** Sliding window per user (`rate_limit_log` table)
- **GDPR export:** `/v1/export` returns full firm data as CSV

---

## 10. AI Cost Model

| Model | Input | Output | Used For |
|---|---|---|---|
| Claude Haiku 4.5 | $0.80/MTok | $4.00/MTok | Default extraction, PDF bank parsing |
| Claude Sonnet 4.6 | $3.00/MTok | $15.00/MTok | Re-extraction when confidence < 70% |

- Monthly budget: configurable per tenant (default $50 USD)
- Alert at 80% of budget
- Queue documents when over budget; process when budget resets
- AI usage logged per document in `ai_usage` table

---

## 11. Key API Endpoints Reference

```
POST /api/v1/documents/upload              — upload invoice, trigger extraction
GET  /api/v1/review/queue                  — list pending review queue
GET  /api/v1/review/[docId]                — get extraction for review
POST /api/v1/review/[docId]/correct        — CA corrects a field
POST /api/v1/review/[docId]/complete       — mark extraction reviewed
GET  /api/v1/clients/[id]/bank-transactions — get BS transactions (max 2000)
POST /api/v1/reconciliation/upload-statement — import bank statement
POST /api/v1/reconciliation/auto-match     — run matching algorithm
POST /api/v1/reconciliation/match          — manual match
POST /api/v1/clients/[id]/reapply-ledger-rules — batch re-apply all ledger rules
GET  /api/v1/clients/[id]/gst-filing?from=&to=&format=excel — GSTR-1+3B export
GET  /api/v1/clients/[id]/ledger           — trial balance + ledger detail
POST /api/v1/tally/post                    — post vouchers to Tally
PATCH /api/v1/reconciliation/transactions/[id] — set ledger/category on txn
```

---

## 12. Glossary

| Term | Meaning |
|---|---|
| T&B | Trial Balance — client's Tally chart of accounts |
| RCM | Reverse Charge Mechanism — buyer pays GST instead of seller |
| ITC | Input Tax Credit — GST paid on purchases, offset against output GST |
| GSTR-1 | Monthly/quarterly outward supplies return (due 11th) |
| GSTR-3B | Monthly summary return + tax payment (due 20th) |
| GSTR-2B | Auto-populated ITC register from portal (supplier's GSTR-1 data) |
| TDS | Tax Deducted at Source — deducted on certain payments, deposited by 7th |
| Layer 0/1/2/3 | LedgerIQ's 4-tier ledger rule hierarchy (see Section 5.2) |
| extractPattern | Canonical narration normalization function in lib/ledger-rules.ts |
| Tenant | One CA firm (multi-tenant SaaS isolation unit) |
