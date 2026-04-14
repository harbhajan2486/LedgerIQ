# LedgerIQ — Product Requirements Document v2.0
**Date:** 12 April 2026  
**Status:** Active development — Phase 1 complete, Phase 2 in progress  
**Prepared by:** Engineering + Product

---

## 1. Product Overview

LedgerIQ is a multi-tenant SaaS platform for Indian CA firms that automates invoice reading, GST/TDS mapping, bank reconciliation, and Tally posting using Claude AI. The platform learns from every correction a CA makes, getting more accurate over time for each firm.

**Core value proposition:** A CA firm that uses LedgerIQ for 3 months achieves >90% extraction accuracy with near-zero manual data entry for routine purchase and sales invoices.

---

## 2. Tech Stack (Locked)

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Next.js 16 (App Router) | Server + client components |
| API | Next.js API Routes `/api/v1/` | Same repo, Vercel-deployed |
| Database | Supabase PostgreSQL | RLS on all tables |
| Auth | Supabase Auth | JWT, MFA, Google SSO |
| File storage | Supabase Storage | Tenant-prefixed paths, signed URLs (15-min) |
| AI extraction | Claude Haiku → Sonnet | Haiku default; Sonnet if avg confidence < 70% |
| Background jobs | Supabase Edge Functions (Deno) | extract-document, generate-embedding, send-notification |
| Embeddings | Transformers.js (Edge Function) | Structural patterns only — no PII or financial values |
| Deployment | Vercel (auto on git push) | GitHub → Vercel → live in ~2 min |
| Billing | Stripe | 4 plans |
| Secrets | Supabase Vault + Vercel env vars | ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY |

---

## 3. Architecture

### 3.1 Multi-tenancy
- Every table has `tenant_id`
- PostgreSQL Row Level Security enforces isolation at DB layer
- Application-layer `WHERE tenant_id = ?` as second defence
- Supabase Storage paths: `{tenant_id}/invoices/{file_id}.pdf`

### 3.2 Document Processing Pipeline
```
Upload → Storage → Edge Function trigger → 
  Cost guard check → 
  Few-shot retrieval (correction_vectors) → 
  Layer 1 rules injection → 
  Layer 3 vendor profile injection → 
  Claude Haiku extraction → 
  [Sonnet upgrade if avg confidence < 70%] → 
  Post-processing (TDS rules, GST mutual exclusivity, taxable value back-calc) → 
  Store extractions → 
  Status = review_required
```

### 3.3 Three-Layer Knowledge Architecture
| Layer | What it is | Confidence | Scope |
|---|---|---|---|
| Layer 1 | Global Indian tax rules (GST rates, TDS sections, HSN chapters) | 1.0 | All tenants |
| Layer 2 | Cross-tenant patterns (promoted by super-admin after 5+ tenants agree) | 0.95 | All tenants |
| Layer 3 | Firm-specific vendor profiles (built from corrections) | 0.99 | Single tenant |

### 3.4 AI Cost Controls
- Default: Claude Haiku (~$0.80/1M input tokens)
- Upgrade: Claude Sonnet (~$3.00/1M input tokens) when avg confidence < 70%
- Hard monthly limit: $50 (configurable from super-admin)
- Alert at 80% spend → email notification
- Hard stop at 100% → documents queued, never silently dropped
- Cost tracked per document in `ai_usage` table

---

## 4. Feature Inventory (Current State)

### 4.1 Authentication & Onboarding
- [x] Email/password login with Supabase Auth
- [x] MFA support
- [x] Role-based: `owner`, `admin`, `reviewer`
- [x] Tenant creation on first login
- [ ] Google SSO (configured but not tested end-to-end)
- [ ] Onboarding wizard (Tally config → ledger mapping → first upload)

### 4.2 Document Upload
- [x] Drag-and-drop upload (PDF, JPG, PNG, Excel, CSV)
- [x] 50MB file size limit
- [x] Magic-byte MIME validation (not just extension)
- [x] SHA-256 duplicate detection per tenant
- [x] Client assignment at upload
- [x] Document type selection (purchase_invoice, sales_invoice, expense, credit_note, debit_note)
- [x] Bank statement upload blocked from main upload (routed to reconciliation)
- [x] AI cost guard checked before extraction trigger
- [x] 3-attempt retry with exponential backoff for Edge Function trigger
- [x] Rate limiting (per user)

### 4.3 AI Extraction
- [x] Claude Haiku extraction with JSON output
- [x] Automatic Sonnet upgrade on low confidence
- [x] Few-shot learning from past corrections (correction_vectors)
- [x] Layer 1 global rules injected into prompt (GST/TDS/RCM rules from DB)
- [x] Layer 3 vendor profile injection
- [x] Post-processing TDS rules (keyword → section mapping)
- [x] TDS below-threshold detection (explicit "below ₹30,000" message)
- [x] HSN/SAC → TDS deterministic mapping (confidence 0.85, beats keyword rules at 0.78)
- [x] SAC code inference from vendor name (education, IT, legal, transport, etc.)
- [x] GST mutual exclusivity enforcement (CGST+SGST vs IGST)
- [x] Taxable value 3-tier back-calculation from GST amounts
- [x] ITC eligibility auto-inference (blocked categories under S.17(5))
- [x] Buyer GSTIN auto-filled from client record (confidence 1.0)
- [x] Reverse charge default to "No"
- [x] TDS reasoning and ledger reasoning stored as extraction fields
- [x] Client-level TDS flag (tds_applicable = false overrides all TDS)
- [x] Concurrent run protection (abort if document already review_required)
- [x] Misclassification detection (vendor GSTIN = client GSTIN → wrong folder)
- [x] Duplicate invoice detection (same invoice_number + vendor_name for client)

**Fields extracted:**
`vendor_name, vendor_gstin, buyer_gstin, invoice_number, invoice_date, due_date, taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, total_amount, tds_section, tds_rate, tds_amount, reverse_charge, place_of_supply, suggested_ledger, hsn_sac_code, itc_eligible, tds_section_reasoning, suggested_ledger_reasoning`

### 4.4 Review Queue
- [x] Split-screen: original document (left) + extracted fields (right)
- [x] Confidence colour coding: green ≥80%, amber 50–79%, red <50%
- [x] Field grouping: Invoice Details / Amounts & GST / TDS Deduction / Ledger & Posting
- [x] Keyboard navigation (Tab = next field, Enter = accept)
- [x] Immediate save on blur
- [x] Bulk accept high-confidence fields
- [x] TDS reasoning displayed inline (orange caption)
- [x] Ledger reasoning displayed inline (blue caption)
- [x] Inter-state supply note (IGST only, CGST/SGST hidden)
- [x] CGST/SGST hidden when inter-state (checked by rate OR amount)
- [x] Duplicate invoice warning with specific invoice details (number, vendor, date, filename)
- [x] Misclassification warning with "Move to Sales" button
- [x] Re-run extraction button with last-run timestamp
- [x] Mark as reviewed → moves to reconciliation queue
- [x] Preview & Post to Tally (journal entry preview before posting)
- [x] Readonly mode for already-reviewed documents
- [x] Correction recording → audit log → vector store

### 4.5 Client Management
- [x] Client list with document counts
- [x] Client profile: name, GSTIN, PAN, industry
- [x] TDS applicable toggle (for turnover-below-threshold clients)
- [x] Document folders (Sales / Purchase / Expense / Credit Note / Debit Note)
- [x] Financial year filter
- [x] Confidence breakdown per document (high/medium/low counts)
- [x] Misclassification flag per document in list
- [x] Document retag (change document type)
- [x] Document delete
- [x] Document re-extraction from client list
- [x] TDS Summary download (26Q format Excel)
- [x] Sales Register download
- [x] Purchase Register download
- [x] Expected invoices tracking (vendor, amount, due date)

### 4.6 Bank Reconciliation
- [x] Bank statement upload (CSV, Excel) — major Indian bank formats
- [x] Auto-matching algorithm (amount + date + narration scoring)
- [x] Reconciliation tab: Matched / Possible / Unmatched sub-tabs
- [x] Possible match approval/rejection
- [x] Manual link (invoice → bank transaction)
- [x] Unmatched split: "Needs attention (no category)" vs "Categorised / resolved"
- [x] Category assignment on bank transactions
- [x] Voucher type assignment
- [x] Ledger name assignment on bank transactions
- [x] Bank summary cards (total, matched, unmatched)
- [x] Claim unlinked transactions to client
- [ ] Multi-bank statement merge view
- [ ] Exception report export

### 4.7 Ledger Master
- [x] Per-client ledger list (name + type)
- [x] Seed from standard Indian COA
- [x] Manual add / delete
- [x] CSV import
- [x] Re-apply suggestions (re-run ledger matching for all bank transactions)

### 4.8 GST Filing
- [x] GSTR-1 summary (sales, by rate)
- [x] GSTR-2 summary (purchases, ITC eligible vs blocked)
- [x] Period selector
- [ ] GSTR-2B reconciliation (Phase 2)
- [ ] JSON export for GSTN portal upload (Phase 2)

### 4.9 Accountant Summary Note (NEW)
- [x] AI-generated (Claude Sonnet) comprehensive note per client
- [x] Period selector (optional)
- [x] Sections: Executive Summary, Document Status, GST Analysis, TDS Compliance, Expense Analysis, Reconciliation, Observations & Action Points
- [x] Stored in DB (client_summaries table)
- [x] Refreshable on demand
- [x] Download as Markdown
- [x] Rendered inline with table support

### 4.10 Tally Integration
- [x] Ledger mapping UI
- [x] XML voucher generator (Purchase, Sales, Payment, Receipt, Journal)
- [x] HTTP POST to localhost:9000
- [x] Journal entry preview before posting
- [x] Duplicate posting prevention
- [ ] Tally connection health indicator
- [ ] Cloud/remote Tally bridge (Phase 2)

### 4.11 Super-Admin Portal
- [x] Tenant list + usage metrics
- [x] AI cost dashboard
- [x] AI configurator (model, temperature, max_tokens, budget, prompts)
- [x] Knowledge base (Layer 1 rules management)
- [ ] Layer 2 promotion queue (patterns from 5+ tenants)

### 4.12 Billing
- [ ] Stripe integration (Phase 2)
- [ ] 4 plans: Starter / Pro / Business / Enterprise

---

## 5. Database Schema (Key Tables)

| Table | Purpose |
|---|---|
| `tenants` | Firm accounts |
| `users` | Users with tenant_id + role |
| `clients` | Client companies (with tds_applicable flag) |
| `documents` | Uploaded files with status lifecycle |
| `extractions` | Per-field AI output (one row per field per run) |
| `corrections` | User corrections for learning |
| `correction_vectors` | Embeddings for few-shot retrieval |
| `vendor_profiles` | Layer 3: per-tenant vendor patterns |
| `global_rules` | Layer 1+2: tax rules |
| `bank_transactions` | Imported bank statement rows |
| `reconciliations` | Invoice ↔ bank transaction links |
| `ai_usage` | Cost tracking per document |
| `ai_settings` | Super-admin configurable model params |
| `audit_log` | Append-only action log |
| `client_summaries` | AI-generated accountant notes |
| `ledgers` | Per-client Tally ledger master |
| `expected_invoices` | Tracked upcoming invoices |

---

## 6. TDS Logic (Priority Chain)

1. **Vendor profile** (confidence 0.99) — from past corrections
2. **HSN/SAC code** (confidence 0.85) — deterministic table lookup
3. **NO_TDS_KEYWORDS** (confidence 0.85) — telecom, travel, utilities
4. **Keyword rules** (confidence 0.78) — 194J/194C/194I/194H/194A/194O
   - If keyword matches but amount < threshold → "No TDS: below threshold" message
5. **AI extraction** (variable) — fallback
6. **Client TDS flag** (confidence 1.0, FINAL) — overrides everything if tds_applicable = false

**TDS Thresholds:**
| Section | Service | Threshold |
|---|---|---|
| 194J | Professional/technical | ₹30,000 |
| 194C | Contractors/works | ₹30,000 |
| 194I | Rent | ₹2,40,000 |
| 194H | Commission/brokerage | ₹15,000 |
| 194A | Interest | ₹5,000 |
| 194O | E-commerce | ₹5,00,000 |

---

## 7. Known Gaps & Phase 2 Backlog

| Item | Priority | Notes |
|---|---|---|
| GSTR-2B reconciliation with govt portal | High | Complex govt API, deferred |
| Stripe billing | High | Required for launch |
| Layer 2 promotion queue (super-admin) | Medium | Cross-tenant learning |
| E-invoice IRN/QR extraction | Medium | Mandatory for >₹5Cr B2B |
| HSN mandatory flag | Medium | Flag invoices missing HSN |
| 194Q tracking (₹50L annual per vendor) | Medium | Running total needed |
| TDS 26Q filing format improvements | Medium | Current is basic |
| Multi-bank merge view | Low | UI improvement |
| Tally cloud bridge | Low | Desktop-only for v1 |
| Mobile responsive design | Low | Desktop-only for v1 |
| Google SSO end-to-end test | Low | Configured, not tested |
| Onboarding wizard | Low | Nice to have |
| Export summary as PDF | Low | Currently markdown only |
| Rate limiting per-IP (not just per-user) | Medium | Security hardening |
| CSRF tokens on state-changing routes | High | Security |
| CSP headers | High | Security |
| Prompt injection defence | Medium | Malicious PDF content |
| Summary download as PDF (not just .md) | Low | UX improvement |

---

## 8. Non-Functional Requirements

| Requirement | Target | Current State |
|---|---|---|
| Document extraction latency | < 60s | ~20-40s (Haiku), ~45-70s (Sonnet) |
| Review page load | < 2s | ✅ |
| Monthly AI budget | $50 default | ✅ Enforced |
| Tenant data isolation | Zero cross-tenant leakage | ✅ RLS + app layer |
| File size limit | 50MB | ✅ |
| Uptime | 99.9% | Vercel + Supabase SLAs |
| Audit trail | All actions logged | ✅ |
| Data retention on cancellation | 30 days export + 90 days delete | ⬜ Not implemented |

---

## 9. Build Phases

| Phase | Status | Key deliverables |
|---|---|---|
| Phase 0 — Foundation | ✅ Complete | Auth, DB, RLS, CI/CD |
| Phase 1 — Extraction + Review | ✅ Complete | Upload, AI, review queue, TDS rules, reconciliation, client page, summary note |
| Phase 2 — Intelligence + Billing | 🔧 In progress | Layer 2 promotion, GSTR-2B, Stripe, 194Q tracking |
| Phase 3 — Enterprise | ⬜ Planned | SOC 2, IP allowlisting, Tally cloud bridge, mobile |
