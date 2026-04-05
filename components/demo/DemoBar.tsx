"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { ChevronRight, ChevronLeft, X } from "lucide-react";

const DEMO_ACTIVE_KEY = "ledgeriq_demo_active";
const DEMO_STEP_KEY = "ledgeriq_demo_step";
const DEMO_DOC_KEY = "ledgeriq_demo_doc_id";

interface TourStep {
  path: string | null; // null = stay on current page
  title: string;
  description: string;
}

function buildSteps(reviewDocId: string | null): TourStep[] {
  return [
    {
      path: "/dashboard",
      title: "Welcome to LedgerIQ",
      description:
        "This is your dashboard. It shows documents processed today, invoices waiting for review, and bank matches this week. Demo data is loaded — explore each screen using the Next button below.",
    },
    {
      path: "/clients",
      title: "Step 1 — Clients",
      description:
        "Every document belongs to a client — the companies your firm manages. Two demo clients are loaded: Tata Steel Ltd (Manufacturing) and Reliance Industries Ltd (Retail). Industry is set per client, not per firm, because one CA firm works with companies across all sectors.",
    },
    {
      path: "/upload",
      title: "Step 2 — Upload Documents",
      description:
        "This is where you upload invoices, expense receipts, and bank statements. Select the client first, then the document type, then drop the file. Supported: PDF, JPG, PNG, Excel, CSV up to 50MB. For this demo, the Tata Steel and Reliance invoices are already uploaded and processed.",
    },
    {
      path: "/review",
      title: "Step 3 — Review Queue",
      description:
        "After upload, AI reads the document and extracts all fields — vendor name, GSTIN, invoice number, amounts, GST rates, TDS section. Both demo invoices are here. Fields with low confidence show in amber or red. Click the Tata Steel invoice to open the split-screen reviewer.",
    },
    {
      path: reviewDocId ? `/review/${reviewDocId}` : "/review",
      title: "Step 4 — Split-Screen Reviewer",
      description:
        "Original document on the left. Extracted fields on the right — all 20 fields filled in by AI. Green fields are high confidence. Amber and red need a second look. Press Tab to move between fields, Enter to accept, or just type to correct. Every correction teaches the AI for this vendor.",
    },
    {
      path: "/reconciliation",
      title: "Step 5 — Bank Reconciliation",
      description:
        "Upload your bank statement and LedgerIQ matches invoices to payments automatically — using amount, date, vendor name, and UTR. 4 demo transactions are loaded: the Tata Steel payment (₹4,95,600) and Reliance payment (₹2,18,300) are already matched. One transaction has no invoice yet.",
    },
    {
      path: "/tally",
      title: "Step 6 — Post to Tally",
      description:
        "Once an invoice is reviewed and reconciled, post it to TallyPrime in one click. LedgerIQ generates the correct XML voucher type — Purchase, Payment, or Journal — and sends it to Tally at localhost:9000. Once posted, the same invoice cannot be posted again.",
    },
    {
      path: "/tax-summary",
      title: "Step 7 — Tax Summary",
      description:
        "Period-wise view of GST payable, TDS deducted, and ITC eligible — calculated from all reviewed invoices. Filter by financial year, quarter, or client. Export as PDF or CSV for your auditor.",
    },
    {
      path: "/dashboard",
      title: "That's the full workflow",
      description:
        "Add client → Upload invoice → AI extracts → Review & correct → Reconcile with bank → Post to Tally. The demo data is still loaded — click any screen in the sidebar to explore further.",
    },
  ];
}

export function DemoBar() {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const [reviewDocId, setReviewDocId] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const isActive = localStorage.getItem(DEMO_ACTIVE_KEY) === "true";
    const savedStep = parseInt(localStorage.getItem(DEMO_STEP_KEY) ?? "0", 10);
    const docId = localStorage.getItem(DEMO_DOC_KEY);
    setActive(isActive);
    setStep(isNaN(savedStep) ? 0 : savedStep);
    setReviewDocId(docId);
  }, [pathname]);

  const steps = buildSteps(reviewDocId);
  const current = steps[step] ?? steps[0];
  const isLast = step === steps.length - 1;

  const goTo = useCallback((nextStep: number) => {
    const target = steps[nextStep];
    if (!target) return;
    localStorage.setItem(DEMO_STEP_KEY, String(nextStep));
    setStep(nextStep);
    if (target.path && target.path !== pathname) {
      router.push(target.path);
    }
  }, [steps, pathname, router]);

  function exit() {
    localStorage.removeItem(DEMO_ACTIVE_KEY);
    localStorage.removeItem(DEMO_STEP_KEY);
    setActive(false);
    router.push("/dashboard");
  }

  if (!active) return null;

  return (
    <div className="fixed bottom-0 left-60 right-0 z-50 bg-gray-900 border-t border-gray-700 shadow-2xl">
      <div className="max-w-5xl mx-auto px-6 py-4 flex items-start gap-6">
        {/* Step counter */}
        <div className="flex-shrink-0 pt-0.5">
          <span className="text-xs font-mono text-gray-400">{step + 1} / {steps.length}</span>
          <div className="flex gap-1 mt-1.5">
            {steps.map((_, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${i === step ? "bg-blue-400" : i < step ? "bg-gray-500" : "bg-gray-700"}`}
              />
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white">{current.title}</p>
          <p className="text-xs text-gray-300 mt-1 leading-relaxed">{current.description}</p>
        </div>

        {/* Navigation */}
        <div className="flex items-center gap-2 flex-shrink-0 pt-0.5">
          {step > 0 && (
            <button
              onClick={() => goTo(step - 1)}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-gray-700 text-gray-200 hover:bg-gray-600 transition-colors"
            >
              <ChevronLeft size={12} /> Back
            </button>
          )}
          {isLast ? (
            <button
              onClick={exit}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            >
              Finish tour
            </button>
          ) : (
            <button
              onClick={() => goTo(step + 1)}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            >
              Next <ChevronRight size={12} />
            </button>
          )}
          <button
            onClick={exit}
            className="p-1.5 text-gray-500 hover:text-gray-300 transition-colors"
            title="Exit tour"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

// Call this to start the tour (from DemoTour component)
export function startDemoTour(reviewDocId?: string) {
  localStorage.setItem(DEMO_ACTIVE_KEY, "true");
  localStorage.setItem(DEMO_STEP_KEY, "0");
  if (reviewDocId) localStorage.setItem(DEMO_DOC_KEY, reviewDocId);
}
