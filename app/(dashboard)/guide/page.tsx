"use client";

import { useState } from "react";
import {
  Building2, Upload, ClipboardCheck, Landmark, GitMerge,
  BookOpen, Library, FileText, ChevronDown, ChevronRight,
  CheckCircle2, Sparkles, AlertTriangle, RefreshCw,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface Step {
  number: number;
  title: string;
  icon: React.ElementType;
  colour: string;
  summary: string;
  details: string[];
  tips?: string[];
}

const STEPS: Step[] = [
  {
    number: 1,
    title: "Add a client",
    icon: Building2,
    colour: "bg-blue-100 text-blue-700",
    summary: "Create a client profile for each business you manage.",
    details: [
      'Go to Clients → click "New Client".',
      "Enter the firm name, GSTIN, industry type, and state.",
      "The industry type trains the AI — it affects automatic ledger suggestions.",
      "Each client is fully isolated: documents, rules, and bank data never mix.",
    ],
    tips: [
      "Set the correct industry (e.g. Retail, Construction, IT Services) — this improves AI accuracy from day one.",
    ],
  },
  {
    number: 2,
    title: "Upload invoices & documents",
    icon: Upload,
    colour: "bg-violet-100 text-violet-700",
    summary: "Upload purchase invoices, expense bills, or credit notes for AI extraction.",
    details: [
      "Open a client → Documents tab → Upload.",
      "Supported formats: PDF, JPG, PNG (up to 50 MB).",
      "The AI reads vendor name, GSTIN, invoice number, amounts, GST rates, TDS section, HSN/SAC, and ITC eligibility.",
      "Processing takes 10–60 seconds. The document moves to Inbox once done.",
      "You can upload multiple files at once; each is processed independently.",
    ],
    tips: [
      "Scanned images work — the AI handles both digital and scanned PDFs.",
      "Blurry or skewed scans reduce accuracy. Flat, well-lit photos are fine.",
    ],
  },
  {
    number: 3,
    title: "Review extracted fields in Inbox",
    icon: ClipboardCheck,
    colour: "bg-green-100 text-green-700",
    summary: "Check what the AI extracted and correct anything wrong before posting.",
    details: [
      "Inbox shows all documents waiting for your review.",
      "Each field has a confidence score: green (80%+), amber (50–79%), red (<50%).",
      "Click any field to edit. Press Enter to accept, Tab to move to the next field.",
      "Fields auto-save on blur — no separate Save button.",
      "AI reasons are shown below TDS Section and Suggested Ledger fields (e.g. 'Section 194C — contractor payment based on vendor description').",
      "Once all fields look correct, click Accept All → the document moves to the Reconciliation queue.",
    ],
    tips: [
      "Every correction you make trains the AI — the same vendor's next invoice will be more accurate.",
      "Amber/red fields are highlighted; green fields are usually safe to accept without checking.",
    ],
  },
  {
    number: 4,
    title: "Upload a bank statement",
    icon: Landmark,
    colour: "bg-cyan-100 text-cyan-700",
    summary: "Import your client's bank transactions to match against invoices.",
    details: [
      "Open a client → Bank tab → Upload statement.",
      "Supported formats: CSV, Excel (.xlsx), or PDF (most major Indian banks).",
      "Always upload from inside the client page — this links transactions to that client automatically.",
      "Each transaction row shows date, narration, debit/credit amount, and balance.",
      "Ledger names are auto-assigned using three layers of rules (see Step 6).",
    ],
    tips: [
      "HDFC, ICICI, SBI, Axis, Kotak statements are parsed automatically. For other banks use CSV export.",
    ],
  },
  {
    number: 5,
    title: "Auto-reconcile bank vs invoices",
    icon: GitMerge,
    colour: "bg-orange-100 text-orange-700",
    summary: "LedgerIQ automatically matches bank debits to uploaded invoices.",
    details: [
      "Matching happens by amount, date proximity, vendor name, and invoice number.",
      "Green rows = matched (high confidence). Yellow = possible match (needs your confirmation). Gray = unmatched.",
      "Direct expenses like bank charges, salary, and GST/TDS payments show 'Ledger set' — they don't need an invoice to match.",
      "For unmatched invoices or transactions, use the manual drag-to-link option.",
      "After reconciling, click Post to Tally to push the entries.",
    ],
    tips: [
      "Upload invoices before the bank statement so auto-matching can run immediately.",
      "Run Re-apply ledger rules (button in Bank tab header) after adding new client rules.",
    ],
  },
  {
    number: 6,
    title: "Assign ledger names (rules learn automatically)",
    icon: Library,
    colour: "bg-pink-100 text-pink-700",
    summary: "Map each transaction to the correct Tally ledger. Rules are learned after 3 assignments.",
    details: [
      "In the Bank tab, click the ledger cell on any transaction and type or select a ledger name.",
      "After you assign the same ledger to the same narration pattern 3 times, a rule is created automatically.",
      "Rules work in three layers: (1) global keyword rules, (2) industry-level rules, (3) client-specific rules.",
      "Client rules have the highest priority and override industry and global rules.",
      "The ledger column shows which layer assigned the value: 'Layer 1 – global keyword', 'Layer 2 – industry rule', etc.",
    ],
    tips: [
      "Use AI Suggest (✦ button in Rules tab) to bulk-assign rules for all unrecognized patterns at once.",
    ],
  },
  {
    number: 7,
    title: "Use AI Suggest for bulk rule creation",
    icon: Sparkles,
    colour: "bg-purple-100 text-purple-700",
    summary: "Let AI scan all unrecognized narrations and suggest ledger mappings in one click.",
    details: [
      "Open a client → Rules tab → click ✦ AI Suggest.",
      "The AI scans transactions with no ledger assigned and groups them by pattern.",
      "Each suggestion shows the pattern, an example narration, suggested ledger, confidence %, and the AI's reason.",
      "Edit the ledger name if needed, then click Accept. Skip anything uncertain.",
      "Accepted suggestions create confirmed client rules immediately.",
    ],
    tips: [
      "Run AI Suggest once after uploading your first bank statement — it can map 80–90% of patterns instantly.",
    ],
  },
  {
    number: 8,
    title: "Post to Tally",
    icon: BookOpen,
    colour: "bg-yellow-100 text-yellow-700",
    summary: "Push reviewed and reconciled entries to TallyPrime with one click.",
    details: [
      "Go to Post to Tally from the sidebar.",
      "Tally must be running locally with TallyPrime's HTTP server enabled (port 9000).",
      "Select the entries you want to post — purchase invoices, expenses, bank entries, etc.",
      "LedgerIQ generates the correct XML voucher type (Purchase, Payment, Journal, etc.).",
      "Each entry can only be posted once — duplicate posting is blocked automatically.",
    ],
    tips: [
      "Enable Tally's HTTP server: F12 → Advanced Config → Enable Tally Gateway Server → Port 9000.",
      "If Tally is on a different machine on your LAN, enter its IP address in Settings.",
    ],
  },
  {
    number: 9,
    title: "View Tax Summary",
    icon: FileText,
    colour: "bg-teal-100 text-teal-700",
    summary: "See a GST and TDS summary for any client across any date range.",
    details: [
      "Go to Tax Summary → select a client and financial period.",
      "GST summary shows taxable value, CGST, SGST, IGST, and total GST paid per invoice.",
      "TDS summary shows section-wise deductions with vendor names and amounts.",
      "ITC eligibility is flagged per line — blocked ITC is highlighted separately.",
      "Export to CSV for filing preparation.",
    ],
  },
  {
    number: 10,
    title: "Manage Rules Library",
    icon: Library,
    colour: "bg-gray-100 text-gray-700",
    summary: "View and manage all three layers of ledger mapping rules.",
    details: [
      "Rules Library → Client Rules tab shows confirmed rules for each client.",
      "Industry Rules shows rules shared across all clients in the same industry.",
      "Global Rules shows keyword-based rules that apply to every tenant (e.g. 'ZOMATO → Meals & Entertainment').",
      "HSN, SAC, TDS, RCM, and ITC reference tables are under the Taxation Rules tab.",
      "You can add custom client rules manually using the Add Rule button.",
    ],
    tips: [
      "A rule is confirmed automatically after 3 matching assignments. You can also confirm it manually.",
    ],
  },
];

const QUICK_REF = [
  { q: "Where do I upload invoices?", a: "Client page → Documents tab → Upload button." },
  { q: "Why is a transaction showing 'needs matching'?", a: "It's a purchase or expense that should have an invoice. Upload the invoice and the auto-matcher will link them." },
  { q: "Why is a transaction showing 'Ledger set' instead of 'needs matching'?", a: "Direct expenses (bank charges, salary, GST payments, etc.) don't need an invoice — they're complete once a ledger is assigned." },
  { q: "How do I make the AI smarter for a client?", a: "Correct fields in the Inbox. Every correction trains the AI for that vendor. After 3 corrections for the same vendor field, it's applied automatically on future invoices." },
  { q: "Why are some fields amber / red?", a: "The AI's confidence is below 80% / 50%. These are the fields most likely to need your review." },
  { q: "Bank statement uploaded but no transactions appear in the Bank tab?", a: "Always upload from inside the client page (Bank tab → Upload statement). Uploading from the Reconciliation page without selecting a client won't link them to any client." },
  { q: "How does Tally posting work?", a: "LedgerIQ sends an XML voucher over HTTP to TallyPrime running locally on port 9000. Tally must be open with the HTTP server enabled." },
  { q: "What is the Rules Library?", a: "Three layers of ledger-mapping rules — global (keywords), industry (shared across similar firms), and client-specific. Rules are learned automatically after 3 matching assignments." },
];

export default function GuidePage() {
  const [expanded, setExpanded] = useState<number | null>(1);
  const [faqOpen, setFaqOpen] = useState<number | null>(null);

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">How to use LedgerIQ</h1>
        <p className="text-sm text-gray-500 mt-1">
          A step-by-step guide for accountants managing client accounts, invoices, bank reconciliation, and Tally posting.
        </p>
      </div>

      {/* Workflow overview strip */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {STEPS.map((step, i) => (
          <div key={step.number} className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setExpanded(expanded === step.number ? null : step.number)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium transition-colors ${
                expanded === step.number
                  ? "bg-gray-900 text-white"
                  : "bg-white border border-gray-200 text-gray-600 hover:border-gray-400"
              }`}
            >
              <step.icon size={12} />
              {step.number}. {step.title}
            </button>
            {i < STEPS.length - 1 && <ChevronRight size={12} className="text-gray-300 flex-shrink-0" />}
          </div>
        ))}
      </div>

      {/* Steps */}
      <div className="space-y-2">
        {STEPS.map((step) => {
          const isOpen = expanded === step.number;
          return (
            <Card key={step.number} className={`overflow-hidden transition-shadow ${isOpen ? "shadow-md" : "shadow-none"}`}>
              <button
                onClick={() => setExpanded(isOpen ? null : step.number)}
                className="w-full text-left"
              >
                <div className="flex items-center gap-4 px-5 py-4">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${step.colour}`}>
                    <step.icon size={15} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400 font-medium">Step {step.number}</span>
                    </div>
                    <p className="font-semibold text-gray-900 text-sm">{step.title}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{step.summary}</p>
                  </div>
                  {isOpen ? <ChevronDown size={16} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />}
                </div>
              </button>
              {isOpen && (
                <CardContent className="px-5 pb-5 pt-0">
                  <div className="ml-12 space-y-4">
                    <ul className="space-y-2">
                      {step.details.map((d, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                          <CheckCircle2 size={13} className="text-green-500 flex-shrink-0 mt-0.5" />
                          {d}
                        </li>
                      ))}
                    </ul>
                    {step.tips && step.tips.length > 0 && (
                      <div className="bg-amber-50 border border-amber-100 rounded-lg px-4 py-3 space-y-1">
                        {step.tips.map((tip, i) => (
                          <p key={i} className="text-xs text-amber-800 flex items-start gap-1.5">
                            <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />
                            {tip}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>

      {/* FAQ */}
      <div>
        <h2 className="text-base font-semibold text-gray-800 mb-3">Common questions</h2>
        <div className="space-y-1">
          {QUICK_REF.map((item, i) => (
            <div key={i} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              <button
                onClick={() => setFaqOpen(faqOpen === i ? null : i)}
                className="w-full flex items-center justify-between px-4 py-3 text-left gap-3"
              >
                <span className="text-sm font-medium text-gray-800">{item.q}</span>
                {faqOpen === i ? <ChevronDown size={14} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={14} className="text-gray-400 flex-shrink-0" />}
              </button>
              {faqOpen === i && (
                <div className="px-4 pb-3">
                  <p className="text-sm text-gray-600">{item.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Three-layer rules explainer */}
      <Card>
        <CardContent className="py-5 px-6">
          <div className="flex items-center gap-2 mb-3">
            <RefreshCw size={14} className="text-gray-500" />
            <h2 className="text-sm font-semibold text-gray-800">How the 3-layer AI learns over time</h2>
          </div>
          <div className="space-y-3">
            {[
              { layer: "Layer 1", label: "Global keyword rules", colour: "bg-gray-100 text-gray-700", desc: "Built-in rules that apply to all tenants. Examples: 'ZOMATO' → Meals & Entertainment, 'HDFC CC' → Credit Card Payment. These never change." },
              { layer: "Layer 2", label: "Industry rules", colour: "bg-blue-100 text-blue-700", desc: "Rules shared across all clients in the same industry (e.g. all Construction firms). Promoted automatically when 5+ tenants have the same confirmed rule." },
              { layer: "Layer 3", label: "Client rules", colour: "bg-purple-100 text-purple-700", desc: "Rules specific to one client. Created automatically after you assign the same ledger to the same narration pattern 3 times. Highest priority — overrides everything else." },
            ].map(({ layer, label, colour, desc }) => (
              <div key={layer} className="flex items-start gap-3">
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5 ${colour}`}>{layer}</span>
                <div>
                  <p className="text-sm font-medium text-gray-800">{label}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
