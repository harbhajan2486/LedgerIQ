"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2, AlertTriangle, Loader2, ChevronLeft,
  RotateCcw, Check, AlertCircle, Eye, Send, Copy
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
  status: string;
  processed_at?: string;
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
  const fromFolder   = searchParams.get("folder");
  const isReadonly   = searchParams.get("readonly") === "1";
  const backHref = fromClientId
    ? `/clients/${fromClientId}${fromFolder ? `?folder=${fromFolder}` : ""}`
    : "/review";

  const [document, setDocument] = useState<DocumentData | null>(null);
  const [extractions, setExtractions] = useState<Extraction[]>([]);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileDataUrl, setFileDataUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState(false);
  const [ledgerOptions, setLedgerOptions] = useState<string[]>([]);
  const [possibleMisclassification, setPossibleMisclassification] = useState(false);
  const [possibleDuplicate, setPossibleDuplicate] = useState(false);
  const [duplicateDocId, setDuplicateDocId] = useState<string | null>(null);
  const [reclassifying, setReclassifying] = useState(false);
  const [showPostPreview, setShowPostPreview] = useState(false);
  const [posting, setPosting] = useState(false);
  const fieldRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    fetch(`/api/v1/review/${documentId}`)
      .then((r) => r.json())
      .then((d) => {
        setDocument(d.document);
        if (d.possibleMisclassification) setPossibleMisclassification(true);
        if (d.possibleDuplicate) { setPossibleDuplicate(true); setDuplicateDocId(d.duplicateDocId ?? null); }
        setExtractions(
          (d.extractions ?? []).map((e: Extraction) => ({
            ...e,
            editingValue: e.extracted_value,
            isEditing: false,
            saving: false,
          }))
        );
        setLoading(false);
        // Fetch file and create a blob: URL — data: URIs are blocked for PDFs in Safari/Chrome
        if (d.document?.id) {
          fetch(`/api/v1/documents/${d.document.id}/file`)
            .then((r) => { if (!r.ok) throw new Error("not_found"); return r.blob(); })
            .then((blob) => URL.createObjectURL(blob))
            .then((blobUrl) => setFileDataUrl(blobUrl))
            .catch(() => setFileError(true));
        }
      })
      .catch(() => { setError("Failed to load document."); setLoading(false); });
  }, [documentId]);


  // Fetch ledger list for dropdown
  useEffect(() => {
    if (!fromClientId) return;
    fetch(`/api/v1/clients/${fromClientId}/ledgers`)
      .then((r) => r.json())
      .then((d) => setLedgerOptions((d.ledgers ?? []).map((l: { ledger_name: string }) => l.ledger_name)))
      .catch(() => {});
  }, [fromClientId]);

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
    if (data.warning) toast.warning(data.warning, { duration: 6000 });
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

  async function reclassifyAsSales() {
    if (!window.confirm("Move this document to Sales Invoice? This will change its type and remove it from the purchase invoice folder.")) return;
    setReclassifying(true);
    try {
      const res = await fetch(`/api/v1/documents/${documentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_type: "sales_invoice" }),
      });
      if (res.ok) {
        toast.success("Reclassified as Sales Invoice.");
        setPossibleMisclassification(false);
        if (backHref) router.push(backHref);
      } else {
        const d = await res.json();
        toast.error(d.error ?? "Reclassification failed.");
      }
    } finally {
      setReclassifying(false);
    }
  }

  async function postToTally() {
    setPosting(true);
    try {
      const res = await fetch("/api/v1/tally/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Tally post failed");
      } else if (data.success) {
        toast.success("Posted to Tally successfully.");
        setShowPostPreview(false);
      } else {
        toast.error(data.error ?? "Tally post failed");
      }
    } finally {
      setPosting(false);
    }
  }

  // GST mutual exclusivity — compute once here so count and render agree
  const cgstAmt = parseFloat(extractions.find(e => e.field_name === "cgst_amount")?.extracted_value ?? "0") || 0;
  const igstAmt = parseFloat(extractions.find(e => e.field_name === "igst_amount")?.extracted_value ?? "0") || 0;
  const hideIgstFields   = cgstAmt > 0;
  const hideCgstSgstFields = igstAmt > 0 && cgstAmt === 0;
  const hiddenGstFields = hideIgstFields
    ? ["igst_rate", "igst_amount"]
    : hideCgstSgstFields ? ["cgst_rate", "cgst_amount", "sgst_rate", "sgst_amount"] : [];

  // Null-value fields have nothing to review; hidden GST fields are not applicable — exclude both from count
  const reviewableExtractions = extractions.filter((e) =>
    e.extracted_value !== null && e.extracted_value !== "" &&
    !hiddenGstFields.includes(e.field_name)
  );
  const pendingCount      = reviewableExtractions.filter((e) => e.status === "pending").length;
  const highConfCount     = reviewableExtractions.filter((e) => e.confidence >= 0.8).length;
  const medConfCount      = reviewableExtractions.filter((e) => e.confidence >= 0.5 && e.confidence < 0.8).length;
  const lowConfCount      = reviewableExtractions.filter((e) => e.confidence < 0.5 && e.extracted_value).length;
  const highConfidenceCount = reviewableExtractions.filter((e) => e.confidence >= 0.8 && e.status === "pending").length;
  const allDone = pendingCount === 0;

  // Journal entry preview — compute Dr/Cr lines from extractions
  function getVal(field: string) { return extractions.find(e => e.field_name === field)?.extracted_value ?? null; }
  function getNum(field: string) { return parseFloat(getVal(field) ?? "0") || 0; }
  const previewVendorLedger = getVal("vendor_name") ?? "Sundry Creditors";
  const previewExpenseLedger = getVal("suggested_ledger") ?? "Purchase Account";
  const previewTaxable  = getNum("taxable_value");
  const previewCgst     = getNum("cgst_amount");
  const previewSgst     = getNum("sgst_amount");
  const previewIgst     = getNum("igst_amount");
  const previewTds      = getNum("tds_amount");
  const previewTdsSection = getVal("tds_section");
  const previewTotal    = getNum("total_amount");
  const previewVendorCredit = previewTotal - previewTds;
  const journalLines: { side: "Dr" | "Cr"; ledger: string; amount: number; note?: string }[] = [
    { side: "Dr", ledger: previewExpenseLedger, amount: previewTaxable },
    ...(previewCgst > 0 ? [{ side: "Dr" as const, ledger: "Input CGST", amount: previewCgst }] : []),
    ...(previewSgst > 0 ? [{ side: "Dr" as const, ledger: "Input SGST", amount: previewSgst }] : []),
    ...(previewIgst > 0 ? [{ side: "Dr" as const, ledger: "Input IGST", amount: previewIgst }] : []),
    { side: "Cr", ledger: previewVendorLedger, amount: previewVendorCredit, note: "Sundry Creditor" },
    ...(previewTds > 0 ? [{ side: "Cr" as const, ledger: `TDS Payable (${previewTdsSection ?? "TDS"})`, amount: previewTds, note: "TDS Payable Liability" }] : []),
  ];

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
              {isReadonly ? (
                <>
                  <span className="text-green-600 font-medium">Reviewed</span>
                  {document?.processed_at && (
                    <span className="ml-2">· {new Date(document.processed_at).toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" })}</span>
                  )}
                </>
              ) : (
                <span className="flex items-center gap-3 mt-0.5">
                  <span className="flex items-center gap-1 text-green-600">
                    <span className="inline-block w-2 h-2 rounded-full bg-green-500"></span>
                    {highConfCount} high ≥80%
                  </span>
                  {medConfCount > 0 && (
                    <span className="flex items-center gap-1 text-amber-600">
                      <span className="inline-block w-2 h-2 rounded-full bg-amber-400"></span>
                      {medConfCount} medium 50–79%
                    </span>
                  )}
                  {lowConfCount > 0 && (
                    <span className="flex items-center gap-1 text-red-500">
                      <span className="inline-block w-2 h-2 rounded-full bg-red-400"></span>
                      {lowConfCount} low &lt;50%
                    </span>
                  )}
                  <span className="text-gray-300">·</span>
                  <span className="text-gray-400">{pendingCount} pending · Tab=next · Enter=accept</span>
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isReadonly && <button
            onClick={rerunExtraction}
            disabled={rerunning}
            title="Re-run AI extraction with latest rules (TDS inference, ledger suggestion)"
            className={buttonVariants({ variant: "outline" }) + " text-amber-600 border-amber-300 hover:bg-amber-50"}
          >
            {rerunning ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RotateCcw size={14} className="mr-2" />}
            Re-run extraction
          </button>}
          {!isReadonly && highConfidenceCount > 0 && (
            <button
              onClick={bulkAcceptHighConfidence}
              className={buttonVariants({ variant: "outline" })}
            >
              Accept {highConfidenceCount} high-confidence fields
            </button>
          )}
          {!isReadonly && (
            <button
              onClick={completeReview}
              disabled={pendingCount > 0 || completing}
              title={pendingCount > 0 ? `${pendingCount} field${pendingCount > 1 ? "s" : ""} still need review — accept or correct before marking done` : ""}
              className={buttonVariants({ variant: pendingCount === 0 ? "default" : "outline" })}
            >
              {completing && <Loader2 size={14} className="mr-2 animate-spin" />}
              {pendingCount > 0 ? `${pendingCount} field${pendingCount > 1 ? "s" : ""} need review` : "Mark as reviewed"}
            </button>
          )}
          {allDone && !isReadonly && (
            <button
              onClick={() => setShowPostPreview(true)}
              className={buttonVariants({ variant: "outline" }) + " text-purple-700 border-purple-300 hover:bg-purple-50"}
            >
              <Eye size={14} className="mr-2" /> Preview & Post to Tally
            </button>
          )}
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
              <div className="flex items-center justify-center h-full text-sm text-center px-6">
                {fileError ? (
                  <div className="text-red-400">
                    <p className="font-medium">File could not be loaded</p>
                    <p className="text-xs mt-1 text-gray-400">The original file may be missing from storage.<br/>Extracted fields are still available on the right.</p>
                  </div>
                ) : document ? (
                  <span className="text-gray-400">Loading preview…</span>
                ) : (
                  <span className="text-gray-400">Preview not available</span>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Right — extracted fields grouped */}
        <div className="overflow-y-auto space-y-3 pr-1">
          {/* Duplicate invoice warning */}
          {possibleDuplicate && (
            <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-red-300 bg-red-50 text-sm">
              <span className="text-red-500 mt-0.5 flex-shrink-0">⚠</span>
              <div className="flex-1">
                <p className="font-medium text-red-800">Possible duplicate invoice</p>
                <p className="text-red-700 text-xs mt-0.5">Same invoice number and vendor already exists for this client. Verify before marking reviewed to avoid double-booking.</p>
              </div>
              {duplicateDocId && (
                <a href={`/review/${duplicateDocId}?readonly=1`} target="_blank"
                  className="flex-shrink-0 text-xs px-2.5 py-1 rounded bg-red-600 text-white hover:bg-red-700">
                  View original →
                </a>
              )}
            </div>
          )}
          {/* Misclassification warning */}
          {possibleMisclassification && (
            <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-amber-300 bg-amber-50 text-sm">
              <span className="text-amber-500 mt-0.5 flex-shrink-0">⚠</span>
              <div className="flex-1">
                <p className="font-medium text-amber-800">Possible wrong folder</p>
                <p className="text-amber-700 text-xs mt-0.5">Vendor name matches this client — this looks like a Sales Invoice uploaded in the Purchase Invoice folder.</p>
              </div>
              <button onClick={reclassifyAsSales} disabled={reclassifying}
                className="flex-shrink-0 text-xs px-2.5 py-1 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
                {reclassifying ? "Moving…" : "Move to Sales →"}
              </button>
            </div>
          )}
          {extractions.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-400">No fields extracted yet.</div>
          ) : (
            FIELD_GROUPS.map((group) => {
              const groupExtractions = group.fields
                .map((f) => extractions.find((e) => e.field_name === f))
                .filter((e): e is Extraction => {
                  if (!e) return false;
                  if (hiddenGstFields.includes(e.field_name)) return false;
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
                            /* Ledger: dropdown from master; everything else: text input */
                            <div className="flex items-center gap-2">
                              {isLedger && ledgerOptions.length > 0 ? (
                                <select
                                  value={extraction.editingValue ?? extraction.extracted_value ?? ""}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setExtractions((prev) => prev.map((ex) =>
                                      ex.id === extraction.id ? { ...ex, editingValue: val, isEditing: true } : ex
                                    ));
                                    saveCorrection(extraction.id, "correct", val);
                                  }}
                                  disabled={extraction.saving}
                                  className={`flex-1 text-sm px-2 py-1.5 rounded border outline-none focus:ring-2 focus:ring-blue-500 ${
                                    extraction.status === "accepted"  ? "bg-green-50 border-green-200 text-green-800" :
                                    extraction.status === "corrected" ? "bg-blue-50 border-blue-200 text-blue-800" : "bg-white border-gray-200 text-gray-900"
                                  }`}>
                                  <option value="">— Select ledger —</option>
                                  {ledgerOptions.map((l) => <option key={l} value={l}>{l}</option>)}
                                </select>
                              ) : (
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
                              )}
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

      {/* Journal Entry Preview Modal */}
      {showPostPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4">
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Journal Entry Preview</h2>
              <button onClick={() => setShowPostPreview(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="px-5 py-4">
              <p className="text-xs text-gray-500 mb-3">This is the double-entry that will be posted to Tally. Verify before confirming.</p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-gray-400 uppercase">
                    <th className="text-left pb-2 font-medium">Dr / Cr</th>
                    <th className="text-left pb-2 font-medium">Ledger</th>
                    <th className="text-right pb-2 font-medium">Amount (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {journalLines.map((line, i) => (
                    <tr key={i} className="border-b border-gray-50">
                      <td className={`py-2 pr-3 font-semibold text-xs ${line.side === "Dr" ? "text-blue-700" : "text-green-700"}`}>
                        {line.side}
                      </td>
                      <td className="py-2 pr-3 text-gray-800">
                        {line.ledger}
                        {line.note && <span className="ml-1 text-xs text-gray-400">({line.note})</span>}
                      </td>
                      <td className="py-2 text-right font-mono text-gray-900">
                        {line.amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="text-xs text-gray-400">
                    <td colSpan={2} className="pt-3 text-right font-medium text-gray-600">Total Dr / Total Cr</td>
                    <td className="pt-3 text-right font-mono font-semibold text-gray-900">
                      {journalLines.filter(l => l.side === "Dr").reduce((s, l) => s + l.amount, 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      {" / "}
                      {journalLines.filter(l => l.side === "Cr").reduce((s, l) => s + l.amount, 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                </tfoot>
              </table>
              <p className="text-xs text-gray-400 mt-3">Ledger names are taken from Tally mapping in Settings if configured, otherwise defaults above are used.</p>
            </div>
            <div className="px-5 py-3 border-t flex items-center justify-end gap-2">
              <button onClick={() => setShowPostPreview(false)}
                className={buttonVariants({ variant: "outline" })}>
                Cancel
              </button>
              <button onClick={postToTally} disabled={posting}
                className={buttonVariants({ variant: "default" }) + " bg-purple-700 hover:bg-purple-800"}>
                {posting ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Send size={14} className="mr-2" />}
                Confirm & Post to Tally
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
