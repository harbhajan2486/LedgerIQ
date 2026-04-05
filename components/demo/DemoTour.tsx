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
        router.refresh();
        toast.success(`Demo loaded — ${data.clientsCreated} clients, ${data.documentsCreated} invoices added.`);
      } else {
        toast.error(data.error ?? "Could not load demo data.");
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
        router.refresh();
        toast.success("Demo data cleared.");
      } else {
        toast.error("Could not clear demo data.");
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
      overlayColor: "rgba(0,0,0,0.6)",
      nextBtnText: "Next →",
      prevBtnText: "← Back",
      doneBtnText: "Done",
      progressText: "__current__ / __total__",
      steps: [
        {
          popover: {
            title: "Welcome to LedgerIQ",
            description:
              "A 2-minute walkthrough of the full workflow — from adding a client to posting in Tally. Demo data is loaded: 2 clients, 2 invoices in the review queue, and 4 bank transactions.",
            align: "center",
          },
        },
        {
          element: 'a[href="/clients"]',
          popover: {
            title: "Clients",
            description:
              "Everything is organised by client — the companies your firm manages. Two demo clients are loaded: <strong>Tata Steel Ltd</strong> (Manufacturing) and <strong>Reliance Industries Ltd</strong> (Retail). Each client stores their GSTIN, PAN, and industry. Industry is set per client because one firm serves companies across all sectors.",
            side: "right",
            align: "start",
          },
        },
        {
          element: 'a[href="/upload"]',
          popover: {
            title: "Upload Documents",
            description:
              "Drop invoices, expense receipts, or bank statements here. Formats: PDF, JPG, PNG, Excel, CSV up to 50MB. You pick the client and document type before uploading — so every file is filed under the right company automatically.",
            side: "right",
            align: "start",
          },
        },
        {
          element: 'a[href="/review"]',
          popover: {
            title: "Review Queue",
            description:
              "After upload, Claude AI reads the document and extracts every field — vendor name, GSTIN, invoice number, amounts, GST rates, TDS section. The two demo invoices are here now, with all 20 fields extracted. Fields with low confidence are highlighted amber or red so you know exactly where to look.",
            side: "right",
            align: "start",
          },
        },
        {
          element: 'a[href="/review"]',
          popover: {
            title: "Split-Screen Reviewer",
            description:
              "Open any invoice to see the original document on the left and extracted fields on the right. <strong>Tab</strong> moves between fields. <strong>Enter</strong> accepts. Just type to correct a value — it saves the moment you move away. Every correction trains the AI so the same mistake never happens again for that vendor.",
            side: "right",
            align: "start",
          },
        },
        {
          element: 'a[href="/reconciliation"]',
          popover: {
            title: "Bank Reconciliation",
            description:
              "Upload your bank statement (CSV or PDF from any Indian bank). LedgerIQ matches invoices to bank payments automatically using amount, date, vendor name, and UTR. Demo has 4 transactions loaded — 2 are already matched to the invoices, 1 is unmatched, 1 has no invoice at all.",
            side: "right",
            align: "start",
          },
        },
        {
          element: 'a[href="/tally"]',
          popover: {
            title: "Post to Tally",
            description:
              "Reconciled invoices post to TallyPrime in one click. LedgerIQ generates the correct XML voucher type (Purchase, Payment, Journal) and sends it to Tally at localhost:9000. Once posted, the button locks — the same invoice can never be posted twice.",
            side: "right",
            align: "start",
          },
        },
        {
          element: 'a[href="/tax-summary"]',
          popover: {
            title: "Tax Summary",
            description:
              "Period-wise view of GST payable, TDS deducted, and ITC eligible — built from all reviewed invoices. Filter by financial year, quarter, or client. Export as PDF or CSV for your auditor.",
            side: "right",
            align: "start",
          },
        },
        {
          element: 'a[href="/settings"]',
          popover: {
            title: "Settings",
            description:
              "Connect your Tally installation, map ledger accounts (e.g. 'Input IGST 18%' → your Tally ledger name), add team members with reviewer or admin roles, and download the full audit log.",
            side: "right",
            align: "start",
          },
        },
        {
          popover: {
            title: "That's the full workflow",
            description:
              "<strong>Add client → Upload invoice → AI extracts → Review & correct → Reconcile with bank → Post to Tally.</strong><br/><br/>The demo data is still loaded. Click any screen in the sidebar to explore. Start with <strong>Review Queue</strong> to see the two demo invoices with all fields extracted.",
            align: "center",
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
          {clearing ? "Clearing…" : "Clear demo"}
        </button>
      ) : (
        <button
          onClick={loadDemoData}
          disabled={seeding}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          {seeding ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {seeding ? "Loading…" : "Load demo"}
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
