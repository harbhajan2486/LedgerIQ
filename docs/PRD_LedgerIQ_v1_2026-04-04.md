# LedgerIQ — Product Requirements Document (PRD)
## Version 1.0 | Last Updated: 2026-04-04

LedgerIQ is a multi-tenant SaaS platform for Indian CA firms that automates invoice reading, GST/TDS mapping, bank reconciliation, and Tally posting using Claude AI.

---

## Tech Stack (Locked In)

| Layer | Tool | Notes |
|---|---|---|
| Frontend | Next.js 16.2.2 (App Router) | Breaking changes vs Next.js 14 — proxy.ts, client component restrictions |
| Backend | Next.js API Routes (Node.js) | Modular monolith, same repo |
| Database | Supabase (PostgreSQL) | RLS, pgvector, Auth, Storage all built-in |
| Vector search | pgvector (inside Supabase) | No separate vector DB |
| File storage | Supabase Storage | Signed URLs, tenant-prefixed paths |
| Auth | Supabase Auth | JWT, MFA, email/password |
| Background jobs | Supabase Edge Functions (Deno) | Async document processing |
| AI extraction | Claude Haiku → Sonnet fallback | Haiku default; auto-upgrade when confidence < 70% |
| Embeddings | HuggingFace Transformers.js (WASM) | Runs in Edge Functions, free, no API key |
| Code hosting | GitHub (harbhajan2486/LedgerIQ) | |
| Deployment | Vercel (auto-deploy on push to main) | ~2 min deploy time |
| Billing | Stripe | Subscription plans |
| Secrets | Vercel env vars + Supabase Vault | Never in code |
| Supabase project | gnhxqbpynbcrwaidzbsp | Region: Mumbai (ap-south-1) |

**Deployment flow:** GitHub push → Vercel auto-builds → live. No servers, no terminal, no manual steps.

---

## AI Cost Controls

| Parameter | Value |
|---|---|
| Default model | Claude Haiku (~$2 / 1,000 invoices) |
| Fallback model | Claude Sonnet (~$15 / 1,000 invoices) |
| Fallback trigger | Confidence < 70% on any field |
| Monthly hard limit | $50/month per platform (configurable) |
| Alert threshold | $40 (80%) — email notification sent |
| Hard stop | $50 — documents queue, never fail silently |
| Cost tracking | `ai_usage` table per tenant |

---

## Scope Decisions

| Feature | v1 Scope | Notes |
|---|---|---|
| GSTR-2A/2B integration | Phase 2 (post-launch) | Complex govt API, deferred |
| Mobile / responsive | Phase 2 | Desktop-only for v1 |
| Tally integration | Desktop/LAN only (localhost:9000) | Cloud Tally = Phase 2 |
| SOC 2 Type II | Post-launch | Enterprise clients will ask |
| IP allowlisting | Post-launch | High-security firms |
| Incident response runbook | Post-launch | |

---

## Feature Checklist

### Phase 0 — Foundation

| # | Feature | Status | Notes |
|---|---|---|---|
| 0.1 | GitHub monorepo (Next.js app + admin routes) | ✅ Done | harbhajan2486/LedgerIQ |
| 0.2 | Supabase project created with pgvector enabled | ✅ Done | gnhxqbpynbcrwaidzbsp |
| 0.3 | RLS policies on all tables | ✅ Done | migrations 001–005 |
| 0.4 | Vercel auto-deploy linked to GitHub main | ✅ Done | ledger-iq-blue.vercel.app |
| 0.5 | Email/password auth (Supabase Auth) | ✅ Done | login/page.tsx |
| 0.6 | MFA (TOTP) for admin roles | ✅ Done | login/page.tsx — challenge/verify flow |
| 0.7 | All database tables from PRD (documents, extractions, reconciliations, bank_transactions, users, tenants, audit_log, ai_usage) | ✅ Done | 001_initial_schema.sql |
| 0.8 | AI cost tracking table (ai_usage) | ✅ Done | 001_initial_schema.sql |
| 0.9 | Left sidebar navigation | ✅ Done | components/layout/sidebar.tsx |
| 0.10 | Password policy (min 8 chars, bcrypt) | ✅ Done | signup route |
| 0.11 | HaveIBeenPwned breach check on signup | ⚠️ Partial | lib/hibp.ts exists but disabled in signup route (was causing hangs — needs 3s timeout + re-enable) |
| 0.12 | Vercel preview deploys per PR | ✅ Done | Auto via Vercel |
| 0.13 | Two user roles: `admin` (firm) and `super_admin` (platform) | ✅ Done | Login auto-routes based on role |
| 0.14 | super_admin login from same login page (auto-redirect to /admin/tenants) | ✅ Done | login/page.tsx checks role after auth |
| 0.15 | Tenant isolation: app-level WHERE + DB-level RLS | ✅ Done | Dual isolation on all queries |

---

### Phase 1 — Document Upload & AI Extraction

| # | Feature | Status | Notes |
|---|---|---|---|
| 1.1 | Document upload screen | ✅ Done | app/(dashboard)/upload/page.tsx |
| 1.2 | Drag-and-drop file upload UI | ✅ Done | upload/page.tsx |
| 1.3 | Supabase Storage with tenant-prefixed paths | ✅ Done | app/api/v1/documents/upload/route.ts |
| 1.4 | Magic-byte file type validation (not extension) | ✅ Done | lib/file-validation.ts |
| 1.5 | 50MB file size limit | ✅ Done | upload route |
| 1.6 | Accepted formats: PDF, JPG, PNG, Excel, CSV | ✅ Done | file-validation.ts |
| 1.7 | Supabase Edge Function: extract-document | ✅ Done | supabase/functions/extract-document/index.ts |
| 1.8 | Claude Haiku default extraction | ✅ Done | extract-document function |
| 1.9 | Auto-upgrade to Sonnet when confidence < 70% | ✅ Done | extract-document function |
| 1.10 | AI cost guard ($50 monthly limit) | ✅ Done | extract-document checks ai_usage before calling Claude |
| 1.11 | Async processing — document status polling | ✅ Done | app/api/v1/documents/[id]/status/route.ts |
| 1.12 | Review queue UI | ✅ Done | app/(dashboard)/review/page.tsx |
| 1.13 | Split-screen reviewer (doc left, fields right) | ✅ Done | app/(dashboard)/review/[documentId]/page.tsx |
| 1.14 | Low-confidence fields highlighted amber/red | ✅ Done | review/[documentId]/page.tsx |
| 1.15 | Keyboard shortcuts (Tab/Enter) in reviewer | ✅ Done | review/[documentId]/page.tsx |
| 1.16 | Immediate save on field blur | ✅ Done | review/[documentId]/page.tsx |
| 1.17 | Undo corrections (re-correct before marking final) | ✅ Done | per user decision |
| 1.18 | Correction recorded to audit_log | ✅ Done | app/api/v1/review/[documentId]/correct/route.ts |
| 1.19 | Mark document complete / approved | ✅ Done | app/api/v1/review/[documentId]/complete/route.ts |
| 1.20 | Loading/skeleton states for async processing | ✅ Done | app/(dashboard)/dashboard/loading.tsx |
| 1.21 | Empty state for review queue | ✅ Done | review/page.tsx |
| 1.22 | Error state for upload failure | ✅ Done | upload/page.tsx |
| 1.23 | AI downtime handling — queue docs, notify reviewer | ✅ Done | extract-document queues when AI unavailable |

---

### Phase 2 — Intelligence Layer (Learning System)

| # | Feature | Status | Notes |
|---|---|---|---|
| 2.1 | Vector embeddings via Transformers.js (WASM) | ✅ Done | supabase/functions/generate-embedding/index.ts — deployed |
| 2.2 | pgvector similarity search table + index | ✅ Done | 002_vector_search.sql |
| 2.3 | process-correction Edge Function | ✅ Done | supabase/functions/process-correction/index.ts — deployed |
| 2.4 | Few-shot injection at extraction time (5 similar past docs) | ✅ Done | extract-document function |
| 2.5 | Vendor profile auto-building (3+ corrections → update profile) | ✅ Done | process-correction function |
| 2.6 | Layer 1 global rules engine (GST/TDS rates, HSN/SAC) | ✅ Done | 003_layer1_seed.sql — seeded |
| 2.7 | Layer 2 pattern promotion (5+ tenants → super-admin review queue) | ✅ Done | process-correction checks promotion threshold |
| 2.8 | Industry classification at firm onboarding | ✅ Done | onboarding/page.tsx |
| 2.9 | Embedding content scope: structural patterns only, zero PII/financials | ✅ Done | Enforced in generate-embedding |
| 2.10 | Phase 2 schema (vendor_profiles, extraction_patterns, layer2_promotions) | ✅ Done | 004_phase2_schema.sql |

---

### Phase 3 — Bank Reconciliation

| # | Feature | Status | Notes |
|---|---|---|---|
| 3.1 | Bank statement upload (CSV, Excel) | ✅ Done | app/api/v1/reconciliation/upload-statement/route.ts |
| 3.2 | Bank statement upload (PDF) | ⚠️ Partial | lib/bank-statement-parser.ts exists — PDF parsing logic needs validation across major Indian bank formats |
| 3.3 | Auto-match algorithm (amount + date + vendor name weighted scoring) | ✅ Done | app/api/v1/reconciliation/auto-match/route.ts |
| 3.4 | Reconciliation view (green=matched, amber=review, red=exception) | ✅ Done | app/(dashboard)/reconciliation/page.tsx |
| 3.5 | Manual match / unlink | ✅ Done | app/api/v1/reconciliation/match/route.ts + unmatch/route.ts |
| 3.6 | Match approve | ✅ Done | app/api/v1/reconciliation/match-approve/route.ts |
| 3.7 | Exception handling (amount mismatch, date gap, unmatched txn) | ✅ Done | reconciliation/page.tsx |
| 3.8 | Export reconciliation report (CSV) | ✅ Done | app/api/v1/reconciliation/export/route.ts |
| 3.9 | Export reconciliation report (PDF) | ❌ Not built | PDF export not yet implemented |
| 3.10 | Reconciliation data API | ✅ Done | app/api/v1/reconciliation/data/route.ts |
| 3.11 | Demo data seed (3 invoices, 4 bank txns, 2 reconciliations) | ✅ Done | app/api/v1/demo/seed/route.ts — fixed 2026-04-04 |

---

### Phase 4 — Tally Integration

| # | Feature | Status | Notes |
|---|---|---|---|
| 4.1 | Ledger mapping UI (onboarding + settings) | ✅ Done | app/api/v1/settings/ledger-mapping/route.ts, settings/page.tsx |
| 4.2 | Tally XML voucher generator | ✅ Done | lib/tally-xml.ts |
| 4.3 | All 5 voucher types (Payment, Receipt, Purchase, Sales, Journal) | ✅ Done | tally-xml.ts |
| 4.4 | HTTP POST to localhost:9000 | ✅ Done | app/api/v1/tally/post/route.ts |
| 4.5 | Tally connection health check | ✅ Done | app/api/v1/tally/test-connection/route.ts |
| 4.6 | Tally status indicator (polling) | ✅ Done | tally/page.tsx |
| 4.7 | Idempotency — block duplicate posting | ✅ Done | tally/post/route.ts |
| 4.8 | Tally posting queue | ✅ Done | app/api/v1/tally/queue/route.ts |
| 4.9 | Tally config save/update | ✅ Done | app/api/v1/settings/tally/route.ts |
| 4.10 | Post to Tally screen | ✅ Done | app/(dashboard)/tally/page.tsx |

---

### Phase 5 — Billing, Admin & Launch Prep

| # | Feature | Status | Notes |
|---|---|---|---|
| 5.1 | Stripe checkout (subscription creation) | ✅ Done | app/api/v1/billing/checkout/route.ts |
| 5.2 | Stripe webhook handler | ✅ Done | app/api/v1/billing/webhook/route.ts |
| 5.3 | Billing portal (manage subscription) | ✅ Done | app/api/v1/billing/portal/route.ts |
| 5.4 | Billing info API | ✅ Done | app/api/v1/billing/info/route.ts |
| 5.5 | 4 subscription plans (Starter/Pro/Business/Enterprise) | ⚠️ Partial | Routes built; Stripe products + price IDs not yet created in Stripe dashboard |
| 5.6 | Firm settings screen (Tally config, users, audit log) | ✅ Done | app/(dashboard)/settings/page.tsx |
| 5.7 | Team management (invite, remove users) | ✅ Done | app/api/v1/settings/team/route.ts + [userId]/route.ts |
| 5.8 | Audit log download | ✅ Done | app/api/v1/settings/audit-log/route.ts |
| 5.9 | Super-admin portal — tenant list | ✅ Done | app/admin/tenants/page.tsx + api/v1/admin/tenants/route.ts |
| 5.10 | Super-admin portal — usage metrics | ✅ Done | app/admin/usage/page.tsx + api/v1/admin/usage/route.ts |
| 5.11 | Super-admin portal — AI cost dashboard | ✅ Done | app/admin/costs/page.tsx + api/v1/admin/costs/route.ts |
| 5.12 | Super-admin portal — Layer 2 knowledge promotion queue | ✅ Done | app/admin/knowledge/page.tsx + approve/reject routes |
| 5.13 | Tax summary screen (GST/TDS by period) | ✅ Done | app/(dashboard)/tax-summary/page.tsx + api/v1/tax-summary/route.ts |
| 5.14 | CSRF protection | ❌ Not built | CSRF tokens not yet wired into API routes |
| 5.15 | CSP headers | ❌ Not built | Content Security Policy headers not configured |
| 5.16 | Rate limiting (100 req/min/user) | ⚠️ Partial | lib/rate-limit.ts built — NOT yet wired into API routes |
| 5.17 | Email notifications (4 triggers) | ✅ Done | supabase/functions/send-notification/index.ts — deployed |
| 5.18 | In-app notification panel | ❌ Not built | Email done; in-app bell/panel not built |
| 5.19 | Onboarding wizard (Tally → Ledger mapping → Upload first doc) | ✅ Done | app/(dashboard)/onboarding/page.tsx |
| 5.20 | Dashboard empty state (new user with no data) | ✅ Done | dashboard/page.tsx shows empty card with CTA |
| 5.21 | Interactive demo tour (driver.js 9-step) | ✅ Done | components/demo/DemoTour.tsx |
| 5.22 | "Load demo data" button (seeds realistic invoices + bank txns) | ✅ Done | DemoTour.tsx + demo/seed/route.ts — fixed 2026-04-04 |
| 5.23 | Stripe webhook URL registered in Stripe dashboard | ❌ Not done | Manual step needed |
| 5.24 | Stripe price IDs added to Vercel env vars | ❌ Not done | Manual step needed |
| 5.25 | HIBP breach check re-enabled with 3s timeout | ❌ Not done | lib/hibp.ts exists — disabled in signup; needs timeout guard |
| 5.26 | Data retention / deletion job (90-day cleanup on cancellation) | ❌ Not built | Policy decided (90 days); automated job not built |
| 5.27 | Staging environment in Vercel | ❌ Not done | Only production exists; no staging branch configured |
| 5.28 | Few-shot token budget / truncation strategy | ❌ Not built | Risk: large prompts if many past docs |

---

### Security

| # | Feature | Status | Notes |
|---|---|---|---|
| S.1 | Append-only audit_log (no UPDATE/DELETE grants) | ✅ Done | RLS policy in migrations |
| S.2 | All secrets in Vercel env vars (never in code) | ✅ Done | |
| S.3 | Dual tenant isolation (app WHERE + DB RLS) | ✅ Done | All queries scoped |
| S.4 | Magic-byte file validation | ✅ Done | lib/file-validation.ts |
| S.5 | Signed URLs with 15-min expiry for file access | ✅ Done | upload route |
| S.6 | MFA (TOTP) for admin accounts | ✅ Done | login/page.tsx |
| S.7 | JWT/session security | ✅ Done | Supabase Auth handles rotation/invalidation |
| S.8 | Embedding scope: structural only, zero PII | ✅ Done | Enforced in generate-embedding |
| S.9 | bcrypt password hashing | ✅ Done | Supabase Auth |
| S.10 | Rate limiting | ⚠️ Partial | lib exists, not wired |
| S.11 | CSRF tokens | ❌ Not built | |
| S.12 | CSP headers | ❌ Not built | |
| S.13 | WAF (Web Application Firewall) | ❌ Not built | Vercel provides basic DDoS protection; no OWASP rule group |
| S.14 | Data retention policy (90-day deletion on cancellation) | ⚠️ Partial | Policy decided; automated job not built |
| S.15 | HIBP breach check on signup | ⚠️ Partial | Code exists, temporarily disabled |
| S.16 | IP allowlisting for enterprise | ❌ Post-launch | |
| S.17 | SOC 2 Type II | ❌ Post-launch | |

---

### Infrastructure & DevOps

| # | Feature | Status | Notes |
|---|---|---|---|
| I.1 | Auto-deploy on GitHub push (Vercel) | ✅ Done | |
| I.2 | Vercel preview deploy per PR | ✅ Done | |
| I.3 | Supabase daily automated backups (30-day retention) | ✅ Done | Supabase built-in |
| I.4 | SSL / HTTPS | ✅ Done | Vercel handles automatically |
| I.5 | CDN for static assets | ✅ Done | Vercel Edge Network |
| I.6 | Structured logging | ✅ Done | Vercel logs + Supabase logs |
| I.7 | Staging environment | ❌ Not done | Only prod; no staging branch |
| I.8 | Blue-green or canary deploys | ❌ Not done | Vercel instant rollback available but no canary config |
| I.9 | API versioning (/api/v1/ prefix) | ✅ Done | All routes prefixed from day one |
| I.10 | Database migrations (versioned SQL files) | ✅ Done | supabase/migrations/ — 001 through 005 |

---

## Edge Functions Deployed

| Function | Status | Purpose |
|---|---|---|
| extract-document | ✅ Live | Async AI extraction pipeline (Claude Haiku → Sonnet) |
| process-correction | ✅ Live | Correction embedding, vendor profile update, Layer 2 promotion |
| generate-embedding | ✅ Live | 384-dim vector via HuggingFace Transformers.js WASM |
| send-notification | ✅ Live | Email notifications for 4 trigger events |

---

## Summary Scorecard (as of 2026-04-04)

| Phase | Total Items | Done | Partial | Not Built |
|---|---|---|---|---|
| Phase 0 — Foundation | 15 | 14 | 1 | 0 |
| Phase 1 — Upload & Extraction | 23 | 23 | 0 | 0 |
| Phase 2 — Intelligence Layer | 10 | 10 | 0 | 0 |
| Phase 3 — Bank Reconciliation | 11 | 9 | 1 | 1 |
| Phase 4 — Tally Integration | 10 | 10 | 0 | 0 |
| Phase 5 — Billing & Launch | 28 | 16 | 3 | 9 |
| Security | 17 | 9 | 4 | 4 |
| Infrastructure | 10 | 8 | 0 | 2 |
| **Total** | **124** | **99** | **9** | **16** |

**Overall: ~80% complete**

---

## Remaining Work (Priority Order)

### Must-do before beta launch
1. **Wire rate limiting** — `lib/rate-limit.ts` built, not applied to any API route yet
2. **Stripe setup** — Create products/prices in Stripe dashboard, add price IDs to Vercel env vars, register webhook URL
3. **Re-enable HIBP check** — Add 3-second timeout to `lib/hibp.ts` and re-enable in signup route
4. **CSRF protection** — Add CSRF tokens to mutating API routes (POST/PUT/DELETE)
5. **CSP headers** — Configure Content-Security-Policy in `next.config.ts`
6. **PDF reconciliation export** — Export as PDF (CSV done)
7. **Bank statement PDF parser validation** — `lib/bank-statement-parser.ts` exists; needs testing across HDFC, SBI, ICICI, Axis PDF formats
8. **Staging environment** — Add `staging` branch in Vercel pointing to `develop` branch

### Nice-to-have before launch
9. **In-app notification panel** — Bell icon in sidebar; email notifications are live
10. **Few-shot token budget** — Cap injected few-shot examples to avoid oversized prompts
11. **Data retention job** — Automated Supabase Edge Function to delete tenant data 90 days after cancellation

### Post-launch (Phase 2)
- GSTR-2A/2B government API integration
- Mobile / responsive design
- Cloud Tally support (beyond localhost:9000)
- SOC 2 Type II certification
- IP allowlisting for enterprise tenants
- Formal incident response runbook
- WAF (Web Application Firewall)

---

## Key Architecture Decisions Made

| Decision | Choice | Reason |
|---|---|---|
| Frontend framework | Next.js 16.2.2 | App Router, Server Components, Vercel-native |
| Backend style | Modular monolith | Safer for v1 solo build vs microservices |
| Auth | Supabase Auth | Built-in JWT, MFA, session management |
| Queue/async | Supabase Edge Functions | Replaces BullMQ/Redis entirely |
| Embedding model | HuggingFace all-MiniLM-L6-v2 (WASM) | Free, runs in Deno, no API key |
| Vector DB | pgvector inside Supabase | No separate vector DB needed |
| File storage | Supabase Storage | Replaces S3 |
| UI components | shadcn/ui | Free, works natively with Next.js |
| Deployment | Vercel + GitHub auto-deploy | Zero manual steps |
| Environments | Vercel preview per PR + production main | Staging still to be configured |

---

## Live URLs

| Environment | URL |
|---|---|
| Production | https://ledger-iq-blue.vercel.app |
| Admin portal | https://ledger-iq-blue.vercel.app/admin/tenants |
| Supabase dashboard | https://supabase.com/dashboard/project/gnhxqbpynbcrwaidzbsp |
| GitHub repo | https://github.com/harbhajan2486/LedgerIQ |

---

## Verification Tests (for QA)

| Test | Expected Result | Status |
|---|---|---|
| Tenant isolation | User A cannot see User B's documents | Not formally tested |
| AI extraction | Upload GST invoice → all fields extracted correctly | Not tested with real invoice |
| Learning | Correct same vendor field 3x → 4th doc auto-correct | Not tested |
| Cost guard | Simulate $50 AI spend → next upload queues | Not tested |
| Tally duplicate block | Post same invoice twice → 2nd blocked | Not tested |
| Demo data load | Click "Load demo data" → 3 invoices + 4 txns appear | ✅ Fixed 2026-04-04 |
| Demo tour | Click "Watch tour" → 9-step driver.js overlay | ✅ Working |
| Auto-deploy | Push to GitHub → Vercel deploys within 2 min | ✅ Verified multiple times |
