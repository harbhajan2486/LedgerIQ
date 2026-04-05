"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2, Trash2, Play } from "lucide-react";
import { startDemoTour } from "./DemoBar";
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

  async function loadAndStartTour() {
    setSeeding(true);
    try {
      // Seed demo data first if not already seeded
      let reviewDocId: string | null = null;
      if (!seeded) {
        const res = await fetch("/api/v1/demo/seed", { method: "POST" });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data.error ?? "Could not load demo data.");
          return;
        }
        reviewDocId = data.reviewDocumentId ?? null;
        setSeeded(true);
      } else {
        // Already seeded — fetch the review doc ID from the queue
        const res = await fetch("/api/v1/review/queue");
        const data = await res.json();
        const demoDoc = (data.queue ?? []).find((d: { fileName: string }) =>
          d.fileName?.includes("Tata_Steel")
        );
        reviewDocId = demoDoc?.id ?? null;
      }
      startDemoTour(reviewDocId ?? undefined);
      router.refresh();
      router.push("/dashboard");
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
        localStorage.removeItem("ledgeriq_demo_active");
        localStorage.removeItem("ledgeriq_demo_step");
        localStorage.removeItem("ledgeriq_demo_doc_id");
        router.refresh();
        toast.success("Demo data cleared.");
      } else {
        toast.error("Could not clear demo data.");
      }
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {seeded && (
        <button
          onClick={clearDemoData}
          disabled={clearing}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
        >
          {clearing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          {clearing ? "Clearing…" : "Clear demo"}
        </button>
      )}
      <button
        onClick={loadAndStartTour}
        disabled={seeding}
        className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-blue-200 text-blue-600 hover:bg-blue-50 disabled:opacity-50 transition-colors"
      >
        {seeding ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
        {seeding ? "Loading…" : seeded ? "Start tour" : "Load demo & tour"}
      </button>
    </div>
  );
}
