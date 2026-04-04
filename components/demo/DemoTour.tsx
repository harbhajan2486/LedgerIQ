"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import { Play, Sparkles, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DemoTour() {
  const [mounted, setMounted] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const router = useRouter();

  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  async function loadDemoData() {
    setSeeding(true);
    try {
      const res = await fetch("/api/v1/demo/seed", { method: "POST" });
      if (res.ok) {
        setSeeded(true);
        router.refresh();
      }
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
      }
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
      doneBtnText: "Got it!",
      steps: [
        {
          popover: {
            title: "👋 Welcome to LedgerIQ",
            description:
              "This is a 2-minute tour of the full workflow — from uploading an invoice to posting it in Tally. Click Next to begin.",
            side: "bottom",
            align: "center",
          },
        },
        {
          element: 'a[href="/upload"]',
          popover: {
            title: "📤 Step 1 — Upload Documents",
            description:
              "Click Upload to add invoices, bank statements, or expense receipts. LedgerIQ accepts PDF, JPG, PNG, Excel, and CSV files up to 50MB.",
            side: "right",
          },
        },
        {
          element: 'a[href="/review"]',
          popover: {
            title: "🧠 Step 2 — AI Reads the Invoice",
            description:
              "Claude AI extracts every field: vendor name, GST number, invoice amount, TDS, HSN codes. Fields with low confidence are highlighted in amber/red for your review.",
            side: "right",
          },
        },
        {
          element: 'a[href="/review"]',
          popover: {
            title: "✏️ Step 3 — Review & Correct",
            description:
              "Open the split-screen reviewer. The original document is on the left, extracted fields on the right. Tab through fields, fix any mistakes — the system learns from every correction.",
            side: "right",
          },
        },
        {
          element: 'a[href="/reconciliation"]',
          popover: {
            title: "🏦 Step 4 — Bank Reconciliation",
            description:
              "Upload your bank statement. LedgerIQ automatically matches invoices to bank transactions using amount, date, and vendor name. Matches show in green, review-needed in amber, exceptions in red.",
            side: "right",
          },
        },
        {
          element: 'a[href="/tally"]',
          popover: {
            title: "📒 Step 5 — Post to Tally",
            description:
              "One click sends matched invoices to TallyPrime as XML vouchers. LedgerIQ blocks duplicate postings and shows the connection status to your Tally installation.",
            side: "right",
          },
        },
        {
          element: 'a[href="/tax-summary"]',
          popover: {
            title: "📊 Step 6 — Tax Summary",
            description:
              "See your GST payable, TDS deducted, and ITC eligible for any period. Export a report for your CA or auditor.",
            side: "right",
          },
        },
        {
          element: 'a[href="/settings"]',
          popover: {
            title: "⚙️ Settings",
            description:
              "Connect your Tally installation, map ledger accounts, manage team members, and download audit logs.",
            side: "right",
          },
        },
        {
          popover: {
            title: "🚀 You're ready!",
            description:
              "Start by uploading your first invoice — LedgerIQ will read it in seconds. The more you use it, the smarter it gets. Your corrections train the AI for your firm specifically.",
            side: "bottom",
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
        <Button
          variant="outline"
          onClick={clearDemoData}
          disabled={clearing}
          className="gap-2 text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
        >
          {clearing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          {clearing ? "Clearing…" : "Clear demo data"}
        </Button>
      ) : (
        <Button variant="outline" onClick={loadDemoData} disabled={seeding} className="gap-2">
          {seeding ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {seeding ? "Loading…" : "Load demo data"}
        </Button>
      )}
      <Button variant="outline" onClick={startTour} className="gap-2">
        <Play size={14} />
        Watch tour
      </Button>
    </div>
  );
}
