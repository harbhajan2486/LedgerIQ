# LedgerIQ — To-Do List
*Last updated: 2026-04-03*

---

## 🔴 Do Tomorrow (Before We Can Continue Building)

These 3 things must be done by you (non-technical setup steps).
Step-by-step instructions are in the chat history.

- [ ] **Step 1 — Create Supabase project**
  - Go to supabase.com → New project → Singapore region
  - Copy Project URL and anon key

- [ ] **Step 2 — Set up your secrets file and run the database**
  - Duplicate `.env.example` → rename to `.env.local`
  - Fill in Supabase URL and anon key
  - Run `supabase/migrations/001_initial_schema.sql` in Supabase SQL Editor

- [ ] **Step 3 — Put code on GitHub and deploy to Vercel**
  - Create GitHub account + new repo called `ledgeriq`
  - Push code from Terminal (3 commands)
  - Connect to Vercel → add env vars → Deploy
  - Get your live URL (e.g. `ledgeriq-abc.vercel.app`)

---

## 🟡 Phase 1 — Next Building Session

Claude Code will build these (you just review and approve):

- [ ] Document upload screen (drag-and-drop, progress bar, file validation)
- [ ] Supabase Edge Function for AI extraction (Claude Haiku → Sonnet)
- [ ] AI cost guard (check $50 limit before every API call)
- [ ] Review queue screen (split-screen: document on left, fields on right)
- [ ] Keyboard shortcuts in review queue (Tab, Enter)
- [ ] Undo correction (re-open accepted fields)
- [ ] Correction recording → audit log
- [ ] ClamAV virus scan wiring on upload
- [ ] Email notifications (4 triggers)
- [ ] Onboarding wizard (3 steps for new firms)

---

## 🟠 Phase 2 — Intelligence Layer

- [ ] Vector embeddings for corrections (Supabase Transformers.js)
- [ ] Few-shot injection into extraction prompts
- [ ] Vendor profile auto-building (3+ corrections → update profile)
- [ ] Industry classification picker at onboarding
- [ ] Layer 1 rules engine (GST rates, TDS sections, HSN/SAC lookup)
- [ ] Layer 2 promotion logic (5+ tenants → super-admin review queue)

---

## 🟠 Phase 3 — Bank Reconciliation

- [ ] Bank statement parser (CSV, Excel, PDF — major Indian banks)
- [ ] Weighted matching algorithm (scoring per PRD Section 6.1)
- [ ] Reconciliation view (green/amber/red rows)
- [ ] Manual drag-to-link for unmatched items
- [ ] Exception types from PRD Section 6.3
- [ ] Export reconciliation report (CSV + PDF)

---

## 🟠 Phase 4 — Tally Integration

- [ ] Ledger mapping UI (onboarding step 2)
- [ ] XML voucher generator (Purchase, Sales, Payment, Receipt, Journal)
- [ ] HTTP POST to Tally localhost:9000
- [ ] Idempotency check (block duplicate posting)
- [ ] Post to Tally screen with connection health indicator
- [ ] XML preview before posting

---

## 🟠 Phase 5 — Billing, Admin & Launch

- [ ] Stripe integration (4 plans: Starter/Pro/Business/Enterprise)
- [ ] Firm settings screen (Tally config, user management, audit log download)
- [ ] Super-admin portal (tenant list, usage, AI costs, Layer 2 queue)
- [ ] Tax summary screen (GST/TDS by period, ITC summary)
- [ ] Security hardening (WAF, HaveIBeenPwned, rate limiting)
- [ ] Staging environment setup on Vercel
- [ ] Penetration test
- [ ] Beta onboarding: 5 CA firms

---

## 🔵 Pending Gaps (Review Before Each Phase)

Full details in: `.claude/projects/-Users-sehaj-LedgerIQ/memory/pending_gaps.md`

**Before Phase 1:**
- [ ] Design empty states for review queue, reconciliation, tax summary, Tally screen
- [ ] Design AI downtime banner UI
- [ ] Define dashboard accuracy metric baseline for new tenants (0 documents)

**Before beta launch:**
- [ ] Add Vercel WAF / OWASP rule group
- [ ] Create staging environment (separate Vercel project, `staging` branch)
- [ ] Test Supabase backup restore (disaster recovery dry run)
- [ ] Calculate monthly cost estimate (Vercel + Supabase + Claude API at target scale)

**Phase 2+ (deferred features):**
- [ ] GSTR-2A/2B government GST portal integration
- [ ] Mobile / responsive design
- [ ] SOC 2 Type II certification
- [ ] Cloud/remote Tally bridge agent (desktop installer)
- [ ] IP allowlisting for enterprise tenants
- [ ] Formal incident response runbook
