"use client";

import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** If provided, user must type this word exactly (case-insensitive) to enable the confirm button. */
  confirmWord?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  loading?: boolean;
  variant?: "danger" | "warning";
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmWord,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  loading = false,
  variant = "danger",
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");

  const canConfirm = !confirmWord || typed.toUpperCase() === confirmWord.toUpperCase();

  function handleConfirm() {
    if (!canConfirm || loading) return;
    onConfirm();
  }

  function handleOpenChange(v: boolean) {
    if (!v) setTyped("");
    onOpenChange(v);
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-closed:fade-out-0 duration-150" />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Popup className="w-full max-w-md rounded-xl bg-white shadow-2xl data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 duration-150">
            <div className="p-6">
              {/* Header */}
              <div className="flex items-start gap-4 mb-5">
                <div className={cn(
                  "flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center mt-0.5",
                  variant === "danger" ? "bg-red-100" : "bg-amber-100"
                )}>
                  <AlertTriangle size={18} className={variant === "danger" ? "text-red-600" : "text-amber-600"} />
                </div>
                <div className="flex-1 min-w-0">
                  <Dialog.Title className="text-base font-semibold text-gray-900 leading-snug">
                    {title}
                  </Dialog.Title>
                  <Dialog.Description className="text-sm text-gray-500 mt-1 leading-relaxed">
                    {description}
                  </Dialog.Description>
                </div>
                <Dialog.Close className="flex-shrink-0 p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                  <X size={16} />
                </Dialog.Close>
              </div>

              {/* Type-to-confirm field */}
              {confirmWord && (
                <div className="mb-5 p-3 bg-gray-50 rounded-lg border border-gray-200">
                  <p className="text-xs text-gray-500 mb-2">
                    Type{" "}
                    <span className="font-mono font-semibold text-gray-900 bg-gray-200 px-1 py-0.5 rounded">
                      {confirmWord}
                    </span>{" "}
                    to confirm
                  </p>
                  <input
                    type="text"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleConfirm()}
                    placeholder={confirmWord}
                    autoFocus
                    className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-md outline-none focus:ring-2 focus:ring-red-400 focus:border-red-400 transition-colors"
                  />
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-3">
                <Dialog.Close
                  disabled={loading}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  {cancelLabel}
                </Dialog.Close>
                <button
                  onClick={handleConfirm}
                  disabled={!canConfirm || loading}
                  className={cn(
                    "inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                    variant === "danger"
                      ? "bg-red-600 hover:bg-red-700 disabled:hover:bg-red-600"
                      : "bg-amber-600 hover:bg-amber-700 disabled:hover:bg-amber-600"
                  )}
                >
                  {loading && (
                    <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  )}
                  {confirmLabel}
                </button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
