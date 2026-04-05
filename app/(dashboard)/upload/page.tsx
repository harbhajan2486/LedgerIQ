"use client";

import { useState, useCallback, useRef, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Upload, FileText, CheckCircle2, AlertCircle, X, Loader2, AlertTriangle, Building2 } from "lucide-react";
import { validateFileSize, validateFileMagicBytes, DOCUMENT_TYPES } from "@/lib/file-validation";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";

interface ClientOption {
  id: string;
  client_name: string;
  industry_name: string | null;
}

type FileStatus = "pending" | "validating" | "uploading" | "processing" | "done" | "error" | "queued";

interface FileItem {
  id: string;
  file: File;
  documentType: string;
  status: FileStatus;
  error?: string;
  documentId?: string;
  progress: number;
}

export default function UploadPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-24"><Loader2 size={24} className="animate-spin text-gray-400" /></div>}>
      <UploadPageInner />
    </Suspense>
  );
}

function UploadPageInner() {
  const searchParams = useSearchParams();
  const preselectedClientId = searchParams.get("client");

  const [files, setFiles] = useState<FileItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [budgetWarning, setBudgetWarning] = useState<string | null>(null);
  const [aiDown, setAiDown] = useState(false);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>(preselectedClientId ?? "");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/v1/clients")
      .then((r) => r.json())
      .then((d) => setClients(d.clients ?? []))
      .catch(() => {});
  }, []);

  function addFiles(newFiles: File[]) {
    const items: FileItem[] = newFiles.map((f) => ({
      id: crypto.randomUUID(),
      file: f,
      documentType: "purchase_invoice",
      status: "pending",
      progress: 0,
    }));
    setFiles((prev) => [...prev, ...items]);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(Array.from(e.target.files));
  }

  function updateFile(id: string, patch: Partial<FileItem>) {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  async function uploadFile(item: FileItem) {
    updateFile(item.id, { status: "validating", progress: 10 });

    const sizeError = validateFileSize(item.file);
    if (sizeError) { updateFile(item.id, { status: "error", error: sizeError }); return; }

    const magicError = await validateFileMagicBytes(item.file);
    if (magicError) { updateFile(item.id, { status: "error", error: magicError }); return; }

    updateFile(item.id, { status: "uploading", progress: 30 });

    const formData = new FormData();
    formData.append("file", item.file);
    formData.append("documentType", item.documentType);
    if (selectedClientId) formData.append("clientId", selectedClientId);

    try {
      const res = await fetch("/api/v1/documents/upload", { method: "POST", body: formData });
      const data = await res.json();

      if (!res.ok) { updateFile(item.id, { status: "error", error: data.error }); return; }
      if (data.budgetWarning) setBudgetWarning(data.budgetWarning);

      if (data.queued) {
        setAiDown(true);
        updateFile(item.id, { status: "queued", progress: 100, documentId: data.documentId });
      } else {
        updateFile(item.id, { status: "processing", progress: 70, documentId: data.documentId });
        pollForCompletion(item.id, data.documentId);
      }
    } catch {
      updateFile(item.id, { status: "error", error: "Upload failed. Please check your connection and try again." });
    }
  }

  function pollForCompletion(itemId: string, documentId: string) {
    let attempts = 0;
    const poll = async () => {
      attempts++;
      try {
        const res = await fetch(`/api/v1/documents/${documentId}/status`);
        const data = await res.json();
        if (data.status === "review_required") {
          updateFile(itemId, { status: "done", progress: 100 });
        } else if (data.status === "failed") {
          updateFile(itemId, { status: "error", error: "AI extraction failed. Please try uploading again." });
        } else if (attempts < 30) {
          setTimeout(poll, 3000);
        } else {
          updateFile(itemId, { status: "done", progress: 100 }); // assume done, check review queue
        }
      } catch {
        if (attempts < 30) setTimeout(poll, 3000);
      }
    };
    setTimeout(poll, 3000);
  }

  async function uploadAll() {
    const pending = files.filter((f) => f.status === "pending");
    await Promise.all(pending.map(uploadFile));
  }

  const pendingCount = files.filter((f) => f.status === "pending").length;
  const doneCount = files.filter((f) => ["done", "processing"].includes(f.status)).length;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Upload Documents</h1>
        <p className="text-sm text-gray-500 mt-1">
          Upload invoices, expense bills, or bank statements. AI reads them automatically.
        </p>
      </div>

      {/* Client selector */}
      <div className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-200 rounded-lg">
        <Building2 size={16} className="text-gray-400 flex-shrink-0" />
        <div className="flex-1">
          <label className="text-xs font-medium text-gray-600 block mb-1">Client (optional)</label>
          <select
            value={selectedClientId}
            onChange={(e) => setSelectedClientId(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 bg-white text-gray-700 outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">— No client / unassigned —</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.client_name}{c.industry_name ? ` (${c.industry_name})` : ""}
              </option>
            ))}
          </select>
        </div>
        {clients.length === 0 && (
          <Link href="/clients" className="text-xs text-blue-600 hover:underline flex-shrink-0">
            Add clients →
          </Link>
        )}
      </div>

      {/* Banners */}
      {aiDown && (
        <div className="flex items-start gap-3 p-4 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
          <span>
            Document processing is paused — AI monthly budget limit reached. Your documents are safely queued and will process automatically when the limit resets.
          </span>
        </div>
      )}
      {budgetWarning && !aiDown && (
        <div className="flex items-start gap-3 p-4 bg-orange-50 border border-orange-200 rounded-lg text-sm text-orange-800">
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
          <span>{budgetWarning}</span>
        </div>
      )}

      {/* Drop zone */}
      <Card
        className={`border-2 border-dashed transition-colors cursor-pointer ${
          dragging ? "border-blue-400 bg-blue-50" : "border-gray-200 hover:border-gray-300"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <div className="w-12 h-12 bg-blue-50 rounded-full flex items-center justify-center mb-4">
            <Upload size={22} className="text-blue-500" />
          </div>
          <p className="text-sm font-medium text-gray-900">Drop files here or click to browse</p>
          <p className="text-xs text-gray-400 mt-1">PDF, JPG, PNG, Excel, CSV — max 50MB per file</p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.jpg,.jpeg,.png,.xlsx,.csv"
            className="hidden"
            onChange={onFileInput}
            onClick={(e) => e.stopPropagation()}
          />
        </CardContent>
      </Card>

      {/* File list */}
      {files.length > 0 && (
        <div className="space-y-3">
          {files.map((item) => (
            <Card key={item.id}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <FileText size={18} className="text-gray-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-gray-900 truncate">{item.file.name}</p>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <StatusBadge status={item.status} />
                        {item.status === "pending" && (
                          <button onClick={() => removeFile(item.id)} className="text-gray-400 hover:text-gray-600">
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{(item.file.size / 1024 / 1024).toFixed(2)} MB</p>

                    {item.status === "pending" && (
                      <select
                        value={item.documentType}
                        onChange={(e) => updateFile(item.id, { documentType: e.target.value })}
                        className="mt-2 text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-700"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {DOCUMENT_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    )}

                    {["validating","uploading","processing"].includes(item.status) && (
                      <Progress value={item.progress} className="mt-2 h-1" />
                    )}

                    {item.status === "error" && item.error && (
                      <p className="text-xs text-red-600 mt-1">{item.error}</p>
                    )}
                    {item.status === "done" && (
                      <p className="text-xs text-green-600 mt-1">
                        Ready for review — <Link href="/review" className="underline">go to review queue</Link>
                      </p>
                    )}
                    {item.status === "queued" && (
                      <p className="text-xs text-yellow-600 mt-1">Queued — will process when AI budget resets</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}

          <div className="flex items-center justify-between pt-2">
            <p className="text-sm text-gray-500">
              {doneCount > 0 && `${doneCount} processing · `}
              {pendingCount > 0 && `${pendingCount} ready to upload`}
            </p>
            <div className="flex gap-3">
              {doneCount > 0 && (
                <Link href="/review" className={buttonVariants({ variant: "outline" })}>View review queue</Link>
              )}
              {pendingCount > 0 && (
                <button onClick={uploadAll} className={buttonVariants()}>
                  Upload {pendingCount} file{pendingCount > 1 ? "s" : ""}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {files.length === 0 && (
        <p className="text-center text-sm text-gray-400 py-4">
          No files added yet — drag and drop above or click to browse.
        </p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: FileStatus }) {
  const map: Record<FileStatus, { label: string; cls: string; icon?: React.ReactNode }> = {
    pending:    { label: "Ready to upload", cls: "bg-gray-100 text-gray-600" },
    validating: { label: "Checking…",       cls: "bg-blue-50 text-blue-600",    icon: <Loader2 size={10} className="animate-spin" /> },
    uploading:  { label: "Uploading…",      cls: "bg-blue-50 text-blue-600",    icon: <Loader2 size={10} className="animate-spin" /> },
    processing: { label: "AI reading…",     cls: "bg-purple-50 text-purple-600", icon: <Loader2 size={10} className="animate-spin" /> },
    done:       { label: "Ready",           cls: "bg-green-50 text-green-600",   icon: <CheckCircle2 size={10} /> },
    error:      { label: "Error",           cls: "bg-red-50 text-red-600",       icon: <AlertCircle size={10} /> },
    queued:     { label: "Queued",          cls: "bg-yellow-50 text-yellow-700", icon: <AlertTriangle size={10} /> },
  };
  const { label, cls, icon } = map[status];
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>
      {icon}{label}
    </span>
  );
}
