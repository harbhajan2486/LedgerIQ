# LedgerIQ — Product Specification (Updated)
**Version:** 1.1 | **Last updated:** 2026-04-03 | **Confidential**

> This is the living version of the PRD, updated after the multi-persona review session (Product, UX, Engineering, CISO, Deployment). The original spec (v1.0) is preserved at `/Users/sehaj/Downloads/LedgerIQ_Product_Spec_v1.3.docx`. Changes and additions from the review are marked **[UPDATED]** or **[NEW]**.

---

## Product Overview

| Field | Value |
|---|---|
| Product name | LedgerIQ |
| Version | 1.1 |
| Target users | Accounting firms, CA practices, finance teams |
| Business model | SaaS — monthly subscription per firm |
| Core value proposition | AI reads invoices, maps GST/TDS, reconciles with bank, posts to Tally — learns from every correction |
| Primary market | India (GST, TDS, Tally ecosystem) |
| Seed training source | Internal accounting firm of the product owner |

---

## 1. Confirmed Tech Stack [UPDATED]

| Component | Technology | Notes |
|---|---|---|
| Frontend | Next.js 14 (App Router) | |
| Backend | Next.js API Routes (Node.js) | Same repo as frontend |
| Database | Supabase (PostgreSQL) | pgvector, RLS, Auth, Storage all built-in |
| Vector search | pgvector inside Supabase | No separate vector DB needed |
| File storage | Supabase Storage | Tenant-prefixed paths, signed URLs |
| Auth | Supabase Auth | JWT, MFA, Google SSO |
| Background jobs | Supabase Edge Functions | Async document processing |
| AI extraction | Claude Haiku (default) → Sonnet (fallback) | Haiku when confidence ≥ 70%; Sonnet otherwise |
| Embeddings | Supabase Transformers.js | Free, runs in Edge Functions, 384-dim vectors |
| Code hosting | GitHub | |
| Deployment | Vercel | Auto-deploy on git push — zero manual steps |
| Billing | Stripe | |
| Secrets | Supabase Vault + Vercel env vars | No AWS needed |
| UI components | shadcn/ui | Left sidebar navigation |

---

## 2. AI Cost Controls [NEW]

- Default model: Claude Haiku (~$2 per 1,000 invoices)
- Fallback to Claude Sonnet when field confidence < 70% (~$15 per 1,000 invoices)
- **Hard monthly limit: $50/month** — configurable from super-admin panel
- Alert email sent to super-admin at $40 (80% of limit)
- At $50: new documents are queued (not rejected) — processing resumes when month resets or limit is raised
- Per-tenant cost tracked in `ai_usage` table
- AI cost dashboard visible in super-admin portal

---

## 3. Decisions Made in Review [NEW/UPDATED]

### Product decisions
- **Onboarding wizard:** Step 1 — Tally configuration → Step 2 — Ledger mapping → Step 3 — Upload first document
- **GSTR-2A/2B:** Deferred to Phase 2 (post-launch)
- **Mobile:** Desktop-only for v1. Phase 2 for responsive design.

### UX decisions
- **Navigation:** Left sidebar (standard SaaS layout)
- **Undo corrections:** Yes — reviewer can re-correct any field before document is marked final
- **Undo interaction:** Field becomes editable again; correction is re-recorded; audit trail preserved
- **AI downtime UX:** Show "Processing paused — AI service unavailable. Your documents are queued and will process automatically." Banner dismisses when processing resumes.
- **Empty states:** Defined for dashboard (upload CTA). Still needed for: review queue, reconciliation, tax summary, Tally screen.
- **Loading states:** Skeleton screens on dashboard. Spinner + status text on document processing.

### Engineering decisions
- **Async queue:** Supabase Edge Functions (no separate Redis/BullMQ needed)
- **Embedding model:** Supabase built-in Transformers.js (384-dim, free)
- **API versioning:** All routes prefixed `/api/v1/`
- **Monolith vs microservices:** Modular monolith for v1 (single Next.js app)
- **Environments:** Vercel preview deploys for every PR; `main` branch = production

### Security decisions
- **Password policy:** Minimum 8 characters, bcrypt cost 12, HaveIBeenPwned breach check on signup
- **Embedding scope:** Structural layout patterns only — zero financial values or PII stored in vectors
- **Data retention:** 30-day grace period after cancellation (data exportable), deleted after 90 days
- **Audit log protection:** No UPDATE or DELETE grants for app DB user on audit_log table

### Deployment decisions
- **Platform:** Vercel (frontend + API) + Supabase (database + storage + functions)
- **IaC:** Not needed for v1 — Vercel and Supabase are fully managed
- **SSL + CDN:** Handled automatically by Vercel
- **Disaster recovery:** Supabase daily automated backups, 30-day retention

### Notification triggers [NEW]
Email notifications sent to relevant users when:
1. New reconciliation exceptions are found
2. A firm's review queue exceeds 10 pending documents
3. Monthly AI spend reaches $40 (super-admin only)
4. A new firm signs up (super-admin only)

### Tally integration scope
- **v1:** Desktop/LAN only — HTTP POST to `localhost:9000` (or local network IP)
- **Phase 2:** Cloud/remote Tally bridge agent (requires desktop installer)

---

## 4. System Architecture (unchanged from v1.0)
*See original PRD Section 2*

---

## 5. Knowledge Architecture & Learning Engine (unchanged from v1.0)
*See original PRD Section 3*

### Addition: Embedding details [NEW]
- Embeddings generated by Supabase Transformers.js (`Xenova/all-MiniLM-L6-v2`, 384 dimensions)
- Stored in `correction_vectors` table with `vector(384)` column
- IVFFlat index with 100 lists for fast similarity search
- Scope: document layout fingerprints and field correction patterns only — no financial values embedded

---

## 6. Security Architecture (unchanged from v1.0 with additions)
*See original PRD Section 4*

### Additions [NEW]
- Password breach checking via HaveIBeenPwned API on signup and password change
- Data deletion job: runs daily, deletes tenant data where `delete_after < NOW()`
- WAF: Vercel provides DDoS and bot protection; OWASP rule group to be added before beta launch
- Supabase handles JWT secret rotation automatically

---

## 7. Document Processing Pipeline (unchanged from v1.0)
*See original PRD Section 5*

### Addition: AI model selection logic [NEW]
```
For each document:
  1. Check monthly AI spend vs $50 limit
     → If over limit: set document status = 'queued', notify user, stop
  2. Call Claude Haiku for initial extraction
  3. Calculate average confidence across all fields
     → If average confidence < 70%: re-call with Claude Sonnet
  4. Record model used + tokens + cost in ai_usage table
  5. Set document status = 'review_required'
```

---

## 8. Reconciliation Engine (unchanged from v1.0)
*See original PRD Section 6*

---

## 9. Tally Integration (unchanged from v1.0)
*See original PRD Section 7*

---

## 10. UI Screen Specifications (v1.0 + additions)

### Additions and clarifications [NEW/UPDATED]

**Global layout**
- Left sidebar: 240px wide, dark background (#111827), white text
- Sidebar items: Dashboard, Upload, Review Queue, Reconciliation, Post to Tally, Tax Summary, Settings, Sign Out
- Main content area: light gray background (#F9FAFB), 32px padding

**Onboarding wizard (new users) [NEW]**
- Step 1 — Tally configuration: endpoint URL, company name, test connection
- Step 2 — Ledger mapping: map 8 standard account types to Tally ledger names
- Step 3 — Upload first document: guided drag-and-drop with explainer text
- Progress indicator shows current step (1 of 3)
- Can be skipped and completed later from Settings

**Review queue — undo behaviour [NEW]**
- A reviewed field shows a small "Edit" icon on hover
- Clicking "Edit" re-opens the field for correction
- New correction is recorded in the corrections table; old one preserved (audit trail intact)
- "Mark as reviewed" button only appears when all fields are accepted or corrected

**AI unavailable banner [NEW]**
- Yellow banner at top of screen: "Document processing is paused. AI service is temporarily unavailable. Your documents are safely queued and will process automatically when service resumes."
- Banner disappears automatically when processing resumes
- No action required from the user

**Dashboard — new tenant empty state [NEW]**
- Shown when tenant has 0 documents processed
- CTA: "Upload your first documents" + "Configure Tally" buttons
- Brief explanation of what LedgerIQ does (2 sentences max)

*All other screen specs unchanged — see original PRD Section 8*

---

## 11. Database Schema [UPDATED]

All tables from original PRD Section 9, plus:

**New tables added:**
- `industry_profiles` — Layer 1/2/3 industry classification profiles
- `clients` — end-clients of the CA firm, each with an industry profile
- `ai_usage` — tracks every Claude API call (model, tokens, cost, tenant)
- `tally_ledger_mappings` — tenant's mapping of standard accounts to Tally ledger names
- `notifications` — log of all email notifications sent

**Columns added to existing tables:**
- `documents.client_id` — links document to a client/matter
- `documents.industry_profile_id` — industry context used at extraction time
- `documents.ai_model_used` — which Claude model was used
- `documents.doc_fingerprint` — vendor + template hash for vector lookup
- `corrections.industry_id` — scopes correction to correct industry for Layer 2 promotion

**Migration file:** `supabase/migrations/001_initial_schema.sql`

---

## 12. Test Personas (unchanged from v1.0)
*See original PRD Section 10*

---

## 13. SaaS Launch Plan (unchanged from v1.0)
*See original PRD Section 11*

---

## 14. Build Sequence [NEW]

### Phase 0 — Foundation ✅ COMPLETE
- Next.js app scaffolded, Supabase schema written, login + dashboard built, clean build

### Phase 1 — Document Upload & AI Extraction (next)
- Document upload screen (drag-and-drop, Supabase Storage, ClamAV, magic-byte validation)
- Supabase Edge Function: async extraction (Haiku → Sonnet fallback, cost guard)
- Review queue UI: split-screen, keyboard shortcuts, immediate save, undo
- Correction recording + audit log
- Email notifications (Resend or Supabase built-in email)

### Phase 2 — Intelligence Layer
- Vector embeddings (Transformers.js)
- Few-shot injection at extraction time
- Vendor profile auto-building
- Industry classification at onboarding
- Layer 1 global rules engine (GST/TDS/HSN)
- Layer 2 promotion logic

### Phase 3 — Bank Reconciliation
- Bank statement parser (CSV, Excel, PDF)
- Weighted matching algorithm
- Reconciliation view UI
- Exception management

### Phase 4 — Tally Integration
- Ledger mapping onboarding step
- XML voucher generator (5 voucher types)
- HTTP POST to Tally + idempotency
- Post to Tally screen

### Phase 5 — Billing, Admin & Launch Prep
- Stripe subscription plans
- Firm settings screen
- Super-admin portal
- Tax summary screen
- Security hardening + pen test
- Beta: 5 CA firms

---

## 15. Pending Gaps (to review before each phase)
*Full list in: `/Users/sehaj/.claude/projects/-Users-sehaj-LedgerIQ/memory/pending_gaps.md`*

**Before Phase 1:** Empty states for review queue + reconciliation, onboarding wizard UX, HaveIBeenPwned check, ClamAV wiring
**Before beta launch:** WAF setup, staging environment, disaster recovery test, cost estimate
**Phase 2+:** GSTR-2A/2B, mobile, SOC 2, cloud Tally bridge

---

*LedgerIQ v1.1 | Confidential | Updated 2026-04-03*
