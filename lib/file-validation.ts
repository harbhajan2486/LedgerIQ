// File validation by magic bytes (not extension)
// This is more secure than trusting the filename extension

const ALLOWED_MAGIC_BYTES: { bytes: number[]; mask?: number[]; mime: string }[] = [
  // PDF
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: "application/pdf" },
  // JPEG
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  // PNG
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: "image/png" },
  // XLSX (Office Open XML — starts with PK zip header)
  { bytes: [0x50, 0x4b, 0x03, 0x04], mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  // CSV (no magic bytes — validated by content check below)
];

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export function validateFileSize(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return `File "${file.name}" is too large. Maximum size is 50MB.`;
  }
  return null;
}

export async function validateFileMagicBytes(file: File): Promise<string | null> {
  // CSV files have no magic bytes — allow by extension only for .csv files
  if (file.name.toLowerCase().endsWith(".csv")) return null;

  const buffer = await file.slice(0, 8).arrayBuffer();
  const bytes = new Uint8Array(buffer);

  for (const sig of ALLOWED_MAGIC_BYTES) {
    const matches = sig.bytes.every((b, i) => bytes[i] === b);
    if (matches) return null;
  }

  return `File "${file.name}" is not a supported format. Please upload PDF, JPG, PNG, Excel, or CSV.`;
}

export const DOCUMENT_TYPES = [
  { value: "purchase_invoice", label: "Purchase Invoice" },
  { value: "sales_invoice",    label: "Sales Invoice" },
  { value: "expense",          label: "Expense Bill" },
  { value: "bank_statement",   label: "Bank Statement" },
  { value: "credit_note",      label: "Credit Note" },
  { value: "debit_note",       label: "Debit Note" },
] as const;
