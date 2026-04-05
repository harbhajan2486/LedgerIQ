"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import { Play, Sparkles, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

export function DemoTour() {
  const [mounted, setMounted] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const [reviewDocId, setReviewDocId] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    setMounted(true);
    fetch("/api/v1/demo/seed")
      .then((r) => r.json())
      .then((d) => { if (d.hasDemo) setSeeded(true); })
      .catch(() => {});
  }, []);

  if (!mounted) return null;

  async function loadDemoData() {
    setSeeding(true);
    try {
      const res = await fetch("/api/v1/demo/seed", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setSeeded(true);
        setReviewDocId(data.reviewDocumentId ?? null);
        router.refresh();
        toast.success("Demo data loaded — 2 clients, 2 invoices in review queue, bank transactions ready.");
      } else {
        toast.error("Could not load demo data. Please try again.");
      }
    } catch {
      toast.error("Network error loading demo data.");
    } finally {
      setSeeding(false);
    }
  }

  async function clearDemoData() {
    setClearing(true);
    try {
      const res = await fetch("/api/v1/demo/seed", { method: "DELETE" });
      if (res.ok) {
        setSeeded(false);
        setReviewDocId(null);
        router.refresh();
        toast.success("Demo data cleared.");
      } else {
        toast.error("Could not clear demo data. Please try again.");
      }
    } catch {
      toast.error("Network error clearing demo data.");
    } finally {
      setClearing(false);
    }
  }

  function startTour() {
    const driverObj = driver({
      showProgress: true,
      animate: true,
      smoothScroll: true,
      allowClose: true,
      overlayColor: "rgba(0,0,0,0.65)",
      nextBtnText: "Next →",
      prevBtnText: "← Back",
      doneBtnText: "✓ Done",
      progressText: "Step __current__ of __total__",
      steps: [
        // ── 1. Welcome ──────────────────────────────────────────────
        {
          popover: {
            title: "Welcome to LedgerIQ",
            description:
              "This is a guided walkthrough of the full CA firm workflow — from adding a client to posting a voucher in Tally. <br/><br/>Demo data has been loaded: 2 clients (Tata Steel, Reliance), 2 invoices ready for review, and 4 bank transactions. Click <strong>Next</strong> to begin.",
            side: "bottom",
            align: "center",
          },
        },
        // ── 2. Clients in sidebar ────────────────────────────────────
        {
          element: 'a[href="/clients"]',
          popover: {
            title: "Step 1 — Clients",
            description:
              "Every document belongs to a client — the company your firm manages. <br/><br/>Click <strong>Clients</strong> to see the two demo clients that were just created: <strong>Tata Steel Ltd</strong> (Manufacturing) and <strong>Reliance Industries Ltd</strong> (Retail). Industry is set per client, not per firm — because one CA firm serves companies from every industry.",
            side: "right",
            onNextClick: () => {
              router.push("/clients");
              driverObj.moveNext();
            },
          },
        },
        // ── 3. Clients list page ─────────────────────────────────────
        {
          popover: {
            title: "Client List",
            description:
              "Each card shows the client's documents, pending reviews, and industry. Click a client to see all their documents, upload new ones, or go directly to their review queue. <br/><br/>In production you'd add your real clients here — GSTIN, PAN, and industry are all stored per client.",
            side: "bottom",
            align: "center",
          },
        },
        // ── 4. Upload ────────────────────────────────────────────────
        {
          element: 'a[href="/upload"]',
          popover: {
            title: "Step 2 — Upload Documents",
            description:
              "Drop invoices, expense bills, or bank statements here. Supported formats: PDF, JPG, PNG, Excel, CSV up to 50MB. <br/><br/>You select the <strong>client</strong> and <strong>document type</strong> before uploading — so every document is filed under the right company from day one.",
            side: "right",
            onNextClick: () => {
              router.push("/upload");
              driverObj.moveNext();
            },
          },
        },
        // ── 5. Upload page ───────────────────────────────────────────
        {
          popover: {
            title: "Upload Page",
            description:
              "The client selector is at the top — pick the company this invoice belongs to. LedgerIQ then passes the client's industry to the AI so it applies industry-specific defaults automatically. <br/><br/>After upload, the document goes to the AI extraction pipeline. Claude Haiku reads it in ~10–30 seconds. If confidence is below 70%, it escalates to Claude Sonnet automatically.",
            side: "bottom",
            align: "center",
          },
        },
        // ── 6. Review Queue ──────────────────────────────────────────
        {
          element: 'a[href="/review"]',
          popover: {
            title: "Step 3 — Review Queue",
            description:
              "After AI extraction, documents land here. The demo has 2 invoices waiting — Tata Steel and Reliance. <br/><br/>Each card shows: total fields extracted, how many have low confidence (amber/red), and average confidence score.",
            side: "right",
            onNextClick: () => {
              router.push("/review");
              driverObj.moveNext();
            },
          },
        },
        // ── 7. Review queue page ─────────────────────────────────────
        {
          popover: {
            title: "Review Queue",
            description:
              "You can see the 2 demo invoices here with their confidence scores. <br/><br/>Low confidence fields (below 70%) are highlighted so reviewers know exactly where to focus. High-confidence fields can be bulk-accepted in one click. Click an invoice to open the split-screen reviewer.",
            side: "bottom",
            align: "center",
          },
        },
        // ── 8. Split-screen reviewer ─────────────────────────────────
        {
          popover: {
            title: "Step 4 — Split-Screen Review",
            description:
              "The original document is on the left. Extracted fields are on the right. <br/><br/><strong>Keyboard shortcuts:</strong> Tab moves to the next field. Enter accepts the current field. Just start typing to correct a value — it saves automatically when you move away. <br/><br/>Every correction you make is fed back into the AI's learning system. After 3 corrections for the same vendor field, LedgerIQ remembers it forever.",
            side: "bottom",
            align: "center",
          },
        },
        // ── 9. Learning moat ─────────────────────────────────────────
        {
          popover: {
            title: "The Learning Moat",
            description:
              "This is why LedgerIQ gets smarter the more you use it: <br/><br/>🔵 <strong>Layer 1</strong> — Indian tax law (GST rates, TDS sections) — applied from day one for all firms <br/>🟡 <strong>Layer 2</strong> — Crowd patterns from 10+ firms — promoted by super-admin <br/>🟢 <strong>Layer 3</strong> — Your firm's own vendor memory — built from your corrections <br/><br/>A new firm starts at ~75% accuracy. After 6 months of corrections, you're at ~95%. That gap is your firm's intellectual property.",
            side: "bottom",
            align: "center",
          },
        },
        // ── 10. Reconciliation ───────────────────────────────────────
        {
          element: 'a[href="/reconciliation"]',
          popover: {
            title: "Step 5 — Bank Reconciliation",
            description:
              "Upload your bank statement. LedgerIQ automatically matches invoices to bank payments using amount, date, vendor name, and UTR. <br/><br/>The demo has 4 bank transactions — 2 are already auto-matched to the invoices (green). One is unmatched (amber). One is an exception with no corresponding invoice (red).",
            side: "right",
            onNextClick: () => {
              router.push("/reconciliation");
              driverObj.moveNext();
            },
          },
        },
        // ── 11. Reconciliation page ──────────────────────────────────
        {
          popover: {
            title: "Reconciliation View",
            description:
              "Green rows = auto-matched. Amber = possible match needing confirmation. Red = exception (no invoice found, or amount mismatch). <br/><br/>You can drag an invoice row to a bank transaction to manually link them. Every manual match is recorded in the audit log.",
            side: "bottom",
            align: "center",
          },
        },
        // ── 12. Tally ────────────────────────────────────────────────
        {
          element: 'a[href="/tally"]',
          popover: {
            title: "Step 6 — Post to Tally",
            description:
              "Reconciled invoices can be posted to TallyPrime in one click. LedgerIQ generates a TallyXML voucher (purchase, payment, journal etc.) and sends it to Tally's HTTP interface at localhost:9000. <br/><br/>Duplicate posting is blocked — once an invoice is posted, the button is disabled. Idempotency is enforced at the database level.",
            side: "right",
            onNextClick: () => {
              router.push("/tally");
              driverObj.moveNext();
            },
          },
        },
        // ── 13. Tally page ───────────────────────────────────────────
        {
          popover: {
            title: "Post to Tally",
            description:
              "The connection indicator shows whether Tally is reachable at localhost:9000. For remote setups, a Tally bridge is needed. <br/><br/>Each row shows the voucher type (Purchase, Payment, Journal), the mapped ledger accounts, and the posting status.",
            side: "bottom",
            align: "center",
          },
        },
        // ── 14. Tax Summary ──────────────────────────────────────────
        {
          element: 'a[href="/tax-summary"]',
          popover: {
            title: "Step 7 — Tax Summary",
            description:
              "A period-wise summary of GST payable, TDS deducted, ITC eligible, and total tax liability — pulled from all reviewed invoices. <br/><br/>Export as PDF or CSV for your CA or auditor. Filters by financial year, quarter, and client.",
            side: "right",
            onNextClick: () => {
              router.push("/tax-summary");
              driverObj.moveNext();
            },
          },
        },
        // ── 15. Settings ─────────────────────────────────────────────
        {
          element: 'a[href="/settings"]',
          popover: {
            title: "Step 8 — Settings",
            description:
              "Configure your Tally connection, map ledger accounts (e.g. 'Input IGST 18%' → your Tally ledger name), manage team members with roles, and download the full audit log.",
            side: "right",
          },
        },
        // ── 16. Done ─────────────────────────────────────────────────
        {
          popover: {
            title: "You're ready to go",
            description:
              "The full workflow in one sentence: <strong>Add client → Upload invoice → AI extracts → Review & correct → Reconcile with bank → Post to Tally.</strong> <br/><br/>Every correction you make trains the AI for your firm. Start with one real invoice and see the difference yourself. The demo data is still loaded — explore any screen.",
            side: "bottom",
            align: "center",
            onNextClick: () => {
              router.push("/dashboard");
              driverObj.moveNext();
            },
          },
        },
      ],
    });

    driverObj.drive();
  }

  return (
    <div className="flex items-center gap-2">
      {seeded ? (
        <button
          onClick={clearDemoData}
          disabled={clearing}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
        >
          {clearing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          {clearing ? "Clearing…" : "Clear demo data"}
        </button>
      ) : (
        <button
          onClick={loadDemoData}
          disabled={seeding}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          {seeding ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {seeding ? "Loading…" : "Load demo data"}
        </button>
      )}
      <button
        onClick={startTour}
        className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-blue-200 text-blue-600 hover:bg-blue-50 transition-colors"
      >
        <Play size={12} />
        Watch tour
      </button>
    </div>
  );
}
