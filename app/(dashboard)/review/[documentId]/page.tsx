"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2, AlertTriangle, Loader2, ChevronLeft,
  RotateCcw, Check, AlertCircle
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button-variants";
import Link from "next/link";
import { toast } from "sonner";

interface Extraction {
  id: string;
  field_name: string;
  extracted_value: string;
  confidence: number;
  status: "pending" | "accepted" | "corrected";
  editingValue?: string;
  isEditing?: boolean;
  saving?: boolean;
}

interface DocumentData {
  id: string;
  file_name: string;
  type: string;
  signedUrl?: string;
}

const FIELD_LABELS: Record<string, string> = {
  vendor_name: "Vendor Name", vendor_gstin: "Vendor GSTIN",
  buyer_gstin: "Buyer GSTIN", invoice_number: "Invoice Number",
  invoice_date: "Invoice Date", due_date: "Due Date",
  taxable_value: "Taxable Value", cgst_rate: "CGST Rate",
  cgst_amount: "CGST Amount", sgst_rate: "SGST Rate",
  sgst_amount: "SGST Amount", igst_rate: "IGST Rate",
  igst_amount: "IGST Amount", total_amount: "Total Amount",
  tds_section: "TDS Section", tds_rate: "TDS Rate",
  tds_amount: "TDS Amount", payment_reference: "Payment Reference (UTR)",
  reverse_charge: "Reverse Charge", place_of_supply: "Place of Supply",
};

function confidenceColour(confidence: number) {
  if (confidence >= 0.8) return "text-green-600 bg-green-50";
  if (confidence >= 0.5) return "text-amber-600 bg-amber-50";
  return "text-red-600 bg-red-50";
}

function confidenceBorder(confidence: number, status: string) {
  if (status !== "pending") return "border-gray-200";
  if (confidence >= 0.8) return "border-gray-200";
  if (confidence >= 0.5) return "border-amber-300";
  return "border-red-300";
}

export default function ReviewDetailPage() {
  const params = useParams();
  const router = useRouter();
  const documentId = params.documentId as string;

  const [document, setDocument] = useState<DocumentData | null>(null);
  const [extractions, setExtractions] = useState<Extraction[]>([]);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileDataUrl, setFileDataUrl] = useState<string | null>(null);
  const fieldRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    fetch(`/api/v1/review/${documentId}`)
      .then((r) => r.json())
      .then((d) => {
        setDocument(d.document);
        setExtractions(
          (d.extractions ?? []).map((e: Extraction) => ({
            ...e,
            editingValue: e.extracted_value,
            isEditing: false,
            saving: false,
          }))
        );
        setLoading(false);
        // Fetch file and convert to data URL — works in all browsers, no CSP issues
        if (d.document?.id) {
          fetch(`/api/v1/documents/${d.document.id}/file`)
            .then((r) => r.blob())
            .then((blob) => new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            }))
            .then((dataUrl) => setFileDataUrl(dataUrl))
            .catch(() => {});
        }
      })
      .catch(() => { setError("Failed to load document."); setLoading(false); });
  }, [documentId]);


  // Keyboard navigation: Tab moves to next field, Enter accepts current field
  const handleKeyDown = useCallback((e: React.KeyboardEvent, extractionId: string, index: number) => {
    if (e.key === "Enter") {
      e.preventDefault();
      acceptField(extractionId);
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const next = extractions[index + 1];
      if (next) {
        fieldRefs.current[next.id]?.focus();
        setExtractions((prev) => prev.map((ex) =>
          ex.id === next.id ? { ...ex, isEditing: true } : ex
        ));
      }
    }
  }, [extractions]);

  async function saveCorrection(extractionId: string, action: "accept" | "correct", correctValue?: string) {
    setExtractions((prev) => prev.map((e) =>
      e.id === extractionId ? { ...e, saving: true } : e
    ));

    const res = await fetch(`/api/v1/review/${documentId}/correct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extractionId, action, correctValue }),
    });

    const data = await res.json();

    if (!res.ok) {
      toast.error(data.error ?? "Failed to save");
      setExtractions((prev) => prev.map((e) =>
        e.id === extractionId ? { ...e, saving: false } : e
      ));
      return;
    }

    setExtractions((prev) => prev.map((e) =>
      e.id === extractionId
        ? { ...e, status: action === "accept" ? "accepted" : "corrected",
            extracted_value: action === "correct" ? (correctValue ?? e.extracted_value) : e.extracted_value,
            editingValue: action === "correct" ? (correctValue ?? e.extracted_value) : e.editingValue,
            isEditing: false, saving: false }
        : e
    ));
  }

  function acceptField(extractionId: string) {
    saveCorrection(extractionId, "accept");
  }

  function startEdit(extractionId: string) {
    setExtractions((prev) => prev.map((e) =>
      e.id === extractionId ? { ...e, isEditing: true } : e
    ));
    setTimeout(() => fieldRefs.current[extractionId]?.focus(), 50);
  }

  function onBlur(extraction: Extraction) {
    if (!extraction.isEditing) return;
    const val = extraction.editingValue ?? "";
    if (val !== extraction.extracted_value) {
      saveCorrection(extraction.id, "correct", val);
    } else {
      saveCorrection(extraction.id, "accept");
    }
  }

  async function bulkAcceptHighConfidence() {
    const toAccept = extractions.filter((e) => e.confidence >= 0.8 && e.status === "pending");
    await Promise.all(toAccept.map((e) => saveCorrection(e.id, "accept")));
    toast.success(`Accepted ${toAccept.length} high-confidence fields`);
  }

  async function completeReview() {
    setCompleting(true);
    const res = await fetch(`/api/v1/review/${documentId}/complete`, { method: "POST" });
    const data = await res.json();
    setCompleting(false);
    if (!res.ok) { toast.error(data.error); return; }
    toast.success("Review complete! Document moved to reconciliation queue.");
    router.push("/review");
  }

  const pendingCount = extractions.filter((e) => e.status === "pending").length;
  const highConfidenceCount = extractions.filter((e) => e.confidence >= 0.8 && e.status === "pending").length;
  const allDone = pendingCount === 0;

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <Loader2 size={24} className="animate-spin text-gray-400" />
    </div>
  );

  if (error) return (
    <div className="p-4 bg-red-50 border border-red-200 text-red-700 text-sm rounded-md">
      {error}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/review" className="text-gray-400 hover:text-gray-600">
            <ChevronLeft size={20} />
          </Link>
          <div>
            <h1 className="text-lg font-semibold text-gray-900 truncate max-w-md">
              {document?.file_name}
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">
              {extractions.length} fields · {pendingCount} pending review
              <span className="ml-2 text-gray-300">|</span>
              <span className="ml-2 text-gray-400">Tab = next field · Enter = accept · Type to correct</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {highConfidenceCount > 0 && (
            <button
              onClick={bulkAcceptHighConfidence}
              className={buttonVariants({ variant: "outline" })}
            >
              Accept {highConfidenceCount} high-confidence fields
            </button>
          )}
          <button
            onClick={completeReview}
            disabled={!allDone || completing}
            className={buttonVariants({ variant: allDone ? "default" : "outline" })}
          >
            {completing && <Loader2 size={14} className="mr-2 animate-spin" />}
            {allDone ? "Mark as reviewed" : `${pendingCount} fields left`}
          </button>
        </div>
      </div>

      {/* Split screen */}
      <div className="grid grid-cols-2 gap-4 h-[calc(100vh-180px)]">

        {/* Left — original document */}
        <Card className="overflow-hidden">
          <CardHeader className="py-3 px-4 border-b">
            <CardTitle className="text-sm text-gray-600">Original Document</CardTitle>
          </CardHeader>
          <CardContent className="p-0 h-full">
            {fileDataUrl ? (
              document?.file_name?.match(/\.(jpe?g|png|gif|webp)$/i) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={fileDataUrl} alt="Document" className="w-full h-full object-contain p-4" />
              ) : (
                <object
                  data={fileDataUrl}
                  type="application/pdf"
                  className="w-full h-full"
                >
                  <embed src={fileDataUrl} type="application/pdf" className="w-full h-full" />
                </object>
              )
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                {document ? "Loading preview…" : "Preview not available"}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Right — extracted fields */}
        <div className="overflow-y-auto space-y-2 pr-1">
          {extractions.map((extraction, index) => (
            <div
              key={extraction.id}
              className={`p-3 rounded-lg border bg-white transition-colors ${confidenceBorder(extraction.confidence, extraction.status)}`}
            >
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {FIELD_LABELS[extraction.field_name] ?? extraction.field_name.replace(/_/g, " ")}
                </label>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {/* Confidence badge */}
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${confidenceColour(extraction.confidence)}`}>
                    {Math.round(extraction.confidence * 100)}%
                  </span>
                  {/* Status indicator */}
                  {extraction.status === "accepted" && <CheckCircle2 size={14} className="text-green-500" />}
                  {extraction.status === "corrected" && <CheckCircle2 size={14} className="text-blue-500" />}
                  {extraction.saving && <Loader2 size={14} className="animate-spin text-gray-400" />}
                  {/* Undo — re-open a resolved field */}
                  {extraction.status !== "pending" && !extraction.saving && (
                    <button
                      onClick={() => startEdit(extraction.id)}
                      className="text-gray-300 hover:text-gray-500"
                      title="Re-correct this field"
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                </div>
              </div>

              {/* Editable field */}
              <div className="flex items-center gap-2">
                <input
                  ref={(el) => { fieldRefs.current[extraction.id] = el; }}
                  type="text"
                  value={extraction.editingValue ?? extraction.extracted_value}
                  onChange={(e) =>
                    setExtractions((prev) => prev.map((ex) =>
                      ex.id === extraction.id
                        ? { ...ex, editingValue: e.target.value, isEditing: true }
                        : ex
                    ))
                  }
                  onFocus={() => setExtractions((prev) => prev.map((ex) =>
                    ex.id === extraction.id ? { ...ex, isEditing: true } : ex
                  ))}
                  onBlur={() => onBlur(extraction)}
                  onKeyDown={(e) => handleKeyDown(e, extraction.id, index)}
                  disabled={extraction.saving}
                  className={`flex-1 text-sm px-2 py-1.5 rounded border outline-none focus:ring-2 focus:ring-blue-500 transition-colors
                    ${extraction.status === "accepted" ? "bg-green-50 border-green-200 text-green-800" : ""}
                    ${extraction.status === "corrected" ? "bg-blue-50 border-blue-200 text-blue-800" : ""}
                    ${extraction.status === "pending" ? "bg-white border-gray-200 text-gray-900" : ""}
                    ${extraction.saving ? "opacity-50" : ""}
                  `}
                />
                {extraction.status === "pending" && !extraction.saving && (
                  <button
                    onClick={() => acceptField(extraction.id)}
                    className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded bg-green-50 hover:bg-green-100 text-green-600"
                    title="Accept (Enter)"
                  >
                    <Check size={14} />
                  </button>
                )}
              </div>

              {extraction.confidence < 0.5 && extraction.status === "pending" && (
                <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                  <AlertCircle size={10} /> Low confidence — please verify carefully
                </p>
              )}
            </div>
          ))}

          {extractions.length === 0 && (
            <div className="text-center py-12 text-sm text-gray-400">
              No fields extracted yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
