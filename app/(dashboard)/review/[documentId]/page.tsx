"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
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
  vendor_name: "Vendor / Party Name", vendor_gstin: "Vendor GSTIN",
  buyer_gstin: "Buyer GSTIN", invoice_number: "Invoice Number",
  invoice_date: "Invoice Date", due_date: "Due Date",
  taxable_value: "Taxable Value (₹)", cgst_rate: "CGST Rate (%)",
  cgst_amount: "CGST Amount (₹)", sgst_rate: "SGST Rate (%)",
  sgst_amount: "SGST Amount (₹)", igst_rate: "IGST Rate (%)",
  igst_amount: "IGST Amount (₹)", total_amount: "Total Amount (₹)",
  tds_section: "TDS Section", tds_rate: "TDS Rate (%)",
  tds_amount: "TDS Amount (₹)",
  reverse_charge: "Reverse Charge (RCM)", place_of_supply: "Place of Supply",
  suggested_ledger: "Suggested Tally Ledger",
  hsn_sac_code: "HSN / SAC Code", itc_eligible: "ITC Eligible",
};

// Field grouping for display
const FIELD_GROUPS = [
  { label: "Invoice Details",    fields: ["vendor_name","vendor_gstin","buyer_gstin","invoice_number","invoice_date","due_date","place_of_supply","reverse_charge"] },
  { label: "Amounts & GST",      fields: ["taxable_value","cgst_rate","cgst_amount","sgst_rate","sgst_amount","igst_rate","igst_amount","total_amount"] },
  { label: "TDS Deduction",      fields: ["tds_section","tds_rate","tds_amount"] },
  { label: "Ledger / Posting",   fields: ["suggested_ledger","hsn_sac_code","itc_eligible"] },
];

const TDS_SECTIONS = ["194C","194J","194I","194H","194A","194D","194O","194Q","192","193","194B","194G","195","No TDS"];
const TDS_RATES: Record<string, string> = {
  "194C":"2","194J":"10","194I":"10","194H":"5","194A":"10",
  "194D":"5","194O":"1","194Q":"0.1","192":"slab","193":"10","No TDS":"0",
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
  const searchParams = useSearchParams();
  const documentId = params.documentId as string;
  const fromClientId = searchParams.get("clientId");
  const backHref = fromClientId ? `/clients/${fromClientId}` : "/review";

  const [document, setDocument] = useState<DocumentData | null>(null);
  const [extractions, setExtractions] = useState<Extraction[]>([]);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [rerunning, setRerunning] = useState(false);
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
    router.push(backHref);
  }

  async function rerunExtraction() {
    if (!window.confirm("This will re-run AI extraction and clear all current field values. Any accepted/corrected fields will be reset. Continue?")) return;
    setRerunning(true);
    try {
      const res = await fetch(`/api/v1/documents/${documentId}/reextract`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Re-extraction failed"); return; }
      toast.success("Re-extraction started. This page will refresh in 30 seconds.");
      setTimeout(() => window.location.reload(), 30000);
    } finally {
      setRerunning(false);
    }
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
          <Link href={backHref} className="text-gray-400 hover:text-gray-600">
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
          <button
            onClick={rerunExtraction}
            disabled={rerunning}
            title="Re-run AI extraction with latest rules (TDS inference, ledger suggestion)"
            className={buttonVariants({ variant: "outline" }) + " text-amber-600 border-amber-300 hover:bg-amber-50"}
          >
            {rerunning ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RotateCcw size={14} className="mr-2" />}
            Re-run extraction
          </button>
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
                <iframe
                  src={fileDataUrl}
                  className="w-full h-full border-0"
                  title="Document preview"
                />
              )
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                {document ? "Loading preview…" : "Preview not available"}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Right — extracted fields grouped */}
        <div className="overflow-y-auto space-y-3 pr-1">
          {extractions.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-400">No fields extracted yet.</div>
          ) : (
            FIELD_GROUPS.map((group) => {
              // GST mutual exclusivity: hide IGST rows when CGST is present, and vice versa
              const cgstAmt = parseFloat(extractions.find(e => e.field_name === "cgst_amount")?.extracted_value ?? "0") || 0;
              const igstAmt = parseFloat(extractions.find(e => e.field_name === "igst_amount")?.extracted_value ?? "0") || 0;
              const hideIgst = cgstAmt > 0;
              const hideCgstSgst = igstAmt > 0 && cgstAmt === 0;

              const groupExtractions = group.fields
                .map((f) => extractions.find((e) => e.field_name === f))
                .filter((e): e is Extraction => {
                  if (!e) return false;
                  if (hideIgst    && ["igst_rate","igst_amount"].includes(e.field_name)) return false;
                  if (hideCgstSgst && ["cgst_rate","cgst_amount","sgst_rate","sgst_amount"].includes(e.field_name)) return false;
                  return true;
                });
              if (groupExtractions.length === 0) return null;
              const globalIndex = (fieldName: string) => extractions.findIndex((e) => e.field_name === fieldName);

              return (
                <div key={group.label}>
                  <div className={`text-xs font-semibold uppercase tracking-wider mb-1.5 px-1 ${
                    group.label === "TDS Deduction" ? "text-orange-600" :
                    group.label === "Ledger / Posting" ? "text-blue-600" :
                    "text-gray-400"
                  }`}>{group.label}</div>
                  <div className="space-y-1.5">
                    {groupExtractions.map((extraction) => {
                      const idx = globalIndex(extraction.field_name);
                      const isTdsSection = extraction.field_name === "tds_section";
                      const isLedger = extraction.field_name === "suggested_ledger";
                      const isRuleBased = extraction.confidence === 0.78 || extraction.confidence === 0.75 || extraction.confidence === 0.72;

                      return (
                        <div key={extraction.id}
                          className={`p-3 rounded-lg border bg-white transition-colors ${confidenceBorder(extraction.confidence, extraction.status)}`}>
                          <div className="flex items-start justify-between gap-2 mb-1.5">
                            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                              {FIELD_LABELS[extraction.field_name] ?? extraction.field_name.replace(/_/g, " ")}
                              {isRuleBased && <span className="ml-1 normal-case text-orange-500 font-normal">(auto-inferred)</span>}
                            </label>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${confidenceColour(extraction.confidence)}`}>
                                {Math.round(extraction.confidence * 100)}%
                              </span>
                              {extraction.status === "accepted"  && <CheckCircle2 size={14} className="text-green-500" />}
                              {extraction.status === "corrected" && <CheckCircle2 size={14} className="text-blue-500" />}
                              {extraction.saving && <Loader2 size={14} className="animate-spin text-gray-400" />}
                              {extraction.status !== "pending" && !extraction.saving && (
                                <button onClick={() => startEdit(extraction.id)}
                                  className="text-gray-300 hover:text-gray-500" title="Re-correct">
                                  <RotateCcw size={12} />
                                </button>
                              )}
                            </div>
                          </div>

                          {/* TDS Section: dropdown */}
                          {isTdsSection ? (
                            <div className="flex items-center gap-2">
                              <select
                                value={extraction.editingValue ?? extraction.extracted_value ?? ""}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setExtractions((prev) => prev.map((ex) =>
                                    ex.id === extraction.id ? { ...ex, editingValue: val, isEditing: true } : ex
                                  ));
                                  // Auto-fill TDS rate when section changes
                                  const rate = TDS_RATES[val];
                                  if (rate) {
                                    const rateExt = extractions.find((e) => e.field_name === "tds_rate");
                                    if (rateExt) saveCorrection(rateExt.id, "correct", rate);
                                  }
                                  saveCorrection(extraction.id, "correct", val);
                                }}
                                disabled={extraction.saving}
                                className={`flex-1 text-sm px-2 py-1.5 rounded border outline-none focus:ring-2 focus:ring-blue-500 ${
                                  extraction.status === "accepted" ? "bg-green-50 border-green-200" :
                                  extraction.status === "corrected" ? "bg-blue-50 border-blue-200" : "bg-white border-gray-200"
                                }`}>
                                <option value="">— No TDS —</option>
                                {TDS_SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                              </select>
                              {extraction.status === "pending" && !extraction.saving && (
                                <button onClick={() => acceptField(extraction.id)}
                                  className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded bg-green-50 hover:bg-green-100 text-green-600"
                                  title="Accept">
                                  <Check size={14} />
                                </button>
                              )}
                            </div>
                          ) : (
                            /* Standard text input */
                            <div className="flex items-center gap-2">
                              <input
                                ref={(el) => { fieldRefs.current[extraction.id] = el; }}
                                type="text"
                                value={extraction.editingValue ?? extraction.extracted_value ?? ""}
                                onChange={(e) => setExtractions((prev) => prev.map((ex) =>
                                  ex.id === extraction.id ? { ...ex, editingValue: e.target.value, isEditing: true } : ex
                                ))}
                                onFocus={() => setExtractions((prev) => prev.map((ex) =>
                                  ex.id === extraction.id ? { ...ex, isEditing: true } : ex
                                ))}
                                onBlur={() => onBlur(extraction)}
                                onKeyDown={(e) => handleKeyDown(e, extraction.id, idx)}
                                disabled={extraction.saving}
                                placeholder={isLedger ? "e.g. Professional Fees, Rent…" : ""}
                                className={`flex-1 text-sm px-2 py-1.5 rounded border outline-none focus:ring-2 focus:ring-blue-500 transition-colors
                                  ${extraction.status === "accepted"  ? "bg-green-50 border-green-200 text-green-800" : ""}
                                  ${extraction.status === "corrected" ? "bg-blue-50 border-blue-200 text-blue-800" : ""}
                                  ${extraction.status === "pending"   ? "bg-white border-gray-200 text-gray-900" : ""}
                                  ${extraction.saving ? "opacity-50" : ""}
                                  ${isLedger ? "font-medium" : ""}
                                `}
                              />
                              {extraction.status === "pending" && !extraction.saving && (
                                <button onClick={() => acceptField(extraction.id)}
                                  className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded bg-green-50 hover:bg-green-100 text-green-600"
                                  title="Accept (Enter)">
                                  <Check size={14} />
                                </button>
                              )}
                            </div>
                          )}

                          {extraction.confidence < 0.5 && extraction.status === "pending" && (
                            <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                              <AlertCircle size={10} /> Low confidence — please verify
                            </p>
                          )}
                          {isRuleBased && extraction.status === "pending" && (
                            <p className="text-xs text-orange-500 mt-1">
                              Inferred from vendor name — confirm or correct
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
