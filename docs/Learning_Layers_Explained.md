# LedgerIQ's Three Learning Layers — Explained Simply

*Written for non-technical readers. No jargon.*

---

## The Problem We're Solving

Every Indian CA firm processes the same types of documents — Ola cab receipts, Tata Steel invoices, office rent bills, Reliance petro purchases. But each firm categorises them differently:

- An **IT company** puts Ola cab receipts under "Employee Expense"
- A **restaurant** puts Ola cab receipts under "Delivery Purchase"
- A **hotel** puts them under "Guest Transport"

Same document. Three correct answers. Any system that tries to give one answer for everyone will always be wrong for someone.

LedgerIQ solves this with three layers of knowledge that work together, each one overriding the one below it.

---

## Layer 1 — The National Rulebook
### "Things that are true for every firm in India, always"

**What it contains:**
- GST rates for every HSN/SAC code (set by law)
- Which TDS section applies to which type of payment (set by Income Tax Act)
- Standard ledger categories for common transactions

**How it's built:**
Pre-loaded by the LedgerIQ team. Never changes automatically — only a super-admin can update Layer 1 rules, and every change is reviewed manually.

**Example:**

You upload an Ola invoice. Before the AI even shows you results, it checks Layer 1:

> "Ola is a cab aggregator. SAC code 9964. GST rate: 5% IGST (this is law). TDS section: 194C (this is law, if annual payment > ₹30,000)."

The AI fills in `GST: 5%` and `TDS: 194C` automatically, with high confidence. You never need to correct these. Layer 1 protects every new firm from making basic tax mistakes on day one — even if they've never used LedgerIQ before.

**Think of it as:** The constitution. Everyone follows it. It doesn't change often, and when it does, it's a deliberate decision.

---

## Layer 2 — The Crowd Rulebook
### "Things that 10+ independent firms independently discovered is the right way"

**What it contains:**
Patterns that enough different firms have all corrected the same way — suggesting the AI's default guess is wrong for most people, and should be changed as the new default.

**How it's built:**
Automatically, but with human approval. When 10 different firms all make the same correction (e.g., "Ola receipt should be Expense, not Purchase Invoice"), the system creates a pending suggestion in the super-admin dashboard. The super-admin reviews it and either approves it (it becomes a new global default) or rejects it.

**Example — step by step:**

Month 1: Sharma & Associates uploads an Ola receipt. AI says "Purchase Invoice". Their staff corrects it to "Expense".

Month 2: Mehta & Co uploads an Ola receipt. Same correction.

Month 3–10: Eight more firms do the same thing.

After firm #10 makes this correction, a notification appears in the super-admin dashboard:

> "10 independent firms classified Ola receipts as 'Expense' rather than the current default of 'Purchase Invoice'. Approve as new global default?"

The super-admin reviews it, agrees it makes sense for most business types, and approves it. From that point on, every new Ola receipt uploaded by any firm gets pre-filled as "Expense" by default.

**The restaurant exception:** A restaurant that uses Ola for delivery will still correct it to "Purchase Invoice" for their firm. That's fine — Layer 3 handles them specifically (see below). One firm's different preference doesn't block the global rule.

**Think of it as:** Crowd-sourced best practices, but with a human reviewer before it goes live. Wikipedia's editorial process, applied to accounting rules.

---

## Layer 3 — Your Firm's Personal Memory
### "Things your specific firm always does a particular way"

**What it contains:**
Vendor-specific rules built from your own corrections. Every time your staff corrects the AI for the same vendor and the same field, the system remembers. After 3 corrections for the same pattern, it starts applying your preference automatically.

**How it's built:**
Entirely automatically, from your own staff's corrections. No manual setup needed.

**Example — your Ola receipt:**

**Upload 1:** AI says "Purchase Invoice". Your staff corrects to "Expense". System notes: 1 correction.

**Upload 2:** Same thing. System notes: 2 corrections.

**Upload 3:** Same thing. **Trigger point.** System now records:

> "For vendor 'Ola', this firm always calls document_type 'Expense'."

This gets saved in your firm's vendor profile table.

**Upload 4 onwards:** AI reads the Ola receipt, checks your firm's memory first, sees the vendor profile, and pre-fills "Expense" before showing you anything. You just press Tab → Enter to confirm. Zero correction needed. The badge shows "Learned from your corrections."

**After 10 uploads**, the confidence on this pre-fill is high enough that it might not even be flagged for review — it goes straight to "accepted" status.

**Think of it as:** A new employee who remembers everything you've ever told them and never makes the same mistake twice.

---

## How the Three Layers Work Together

When you upload any document, this is what happens in order:

```
1. AI reads the document (extracts all fields)
         ↓
2. Layer 1 check: Does law/regulation say what this field should be?
   → If yes: fill it in with high confidence
         ↓
3. Layer 2 check: Do 10+ firms agree on a different default?
   → If yes: override Layer 1's guess with the crowd default
         ↓
4. Layer 3 check: Does YOUR firm have a memory for this vendor+field?
   → If yes: override everything with YOUR firm's preference
         ↓
5. Show results to reviewer — Layer 3 answers in green (high confidence),
   Layer 2 in blue (crowd default), uncertain in amber/red
```

**Layer 3 always wins.** Your firm's specific preferences override the crowd, which overrides the law-based defaults. This means:

- A new firm on day one benefits from Layers 1 and 2 immediately
- An experienced firm that has trained Layer 3 barely needs to review anything
- Firms with unusual setups (the restaurant using Ola for delivery) get their own correct answer without affecting anyone else

---

## Real Numbers: What This Means for Your Workload

| Experience level | Layer active | What happens |
|---|---|---|
| Day 1 (brand new firm) | Layer 1 + Layer 2 | ~75% fields pre-filled correctly |
| After 1 month (3+ corrections per major vendor) | All three layers | ~88% fields pre-filled correctly |
| After 6 months (all major vendors trained) | All three layers | ~95% fields — reviewer mostly just confirms |

The system gets measurably smarter the more you use it. This is the moat: a competitor who starts using LedgerIQ tomorrow starts at 75%. You, after six months, are at 95%. That gap is your firm's intellectual property, stored in Layer 3.

---

## What the AI Learns — and What It Doesn't

**The AI learns:**
- Which document type a vendor's invoices should be (expense vs. purchase vs. sales)
- Which TDS section to apply for a specific vendor
- Which HSN/SAC code is correct for a specific type of item
- Vendor-specific formatting quirks (e.g., Tata Steel always puts the invoice date in a non-standard location)

**The AI does NOT learn:**
- The actual money amounts (these change every invoice)
- Your bank account numbers or any financial values
- Any data from other firms — Layer 3 is completely siloed per firm

**Privacy guarantee:** The correction vectors (the AI's "memory") are computed from structural patterns only — field positions, vendor identifiers, document layouts. No invoice amount, no GSTIN, no actual financial data is ever stored in the learning system. Each firm's Layer 3 data is fully isolated and cannot be seen by other firms.

---

## Summary

| Layer | Built by | Trigger | Scope | Example |
|---|---|---|---|---|
| **1 — National rules** | LedgerIQ team | Pre-loaded, manually updated | All firms | SAC 9964 → GST 5% |
| **2 — Crowd rules** | 10+ firms independently + super-admin approval | 10 matching corrections | All firms (opt-in default) | Ola → Expense (for most firms) |
| **3 — Your memory** | Your staff's corrections | 3 corrections for same vendor+field | Your firm only | Ola → Purchase Invoice (if you're a restaurant) |

The cleverness is that they stack: Layer 3 wins, then Layer 2, then Layer 1. Every firm benefits from the shared knowledge, but every firm also gets personalised behaviour that matches exactly how they work.
