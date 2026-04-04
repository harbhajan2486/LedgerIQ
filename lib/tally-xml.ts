// Tally XML Voucher Generator
// Generates TallyPrime-compatible XML for 5 voucher types:
//   1. Purchase voucher (purchase invoice)
//   2. Payment voucher (payment to vendor)
//   3. Journal voucher (adjustments, TDS entries)
//   4. Credit note (vendor returns goods)
//   5. Debit note (we return goods to vendor)
//
// Tally expects HTTP POST to localhost:9000 with XML body.
// Format: TallyPrime Release 2.1 compatible (TallyXML v6.x)

export type VoucherType = "purchase" | "payment" | "journal" | "credit_note" | "debit_note";

export interface LedgerEntry {
  ledger_name: string;  // Must match ledger name exactly as in Tally
  amount: number;       // Positive = credit, negative = debit in Tally convention
  narration?: string;
}

export interface TallyVoucherParams {
  voucher_type: VoucherType;
  date: string;         // DD-MMM-YYYY (Tally format) e.g. "15-Jan-2024"
  party_ledger: string; // Sundry Creditor / Debtor ledger name
  amount: number;       // Total invoice amount (positive)
  narration: string;
  ref_number?: string;  // Invoice number
  entries: LedgerEntry[];
  company_name?: string;
}

const VOUCHER_TYPE_NAMES: Record<VoucherType, string> = {
  purchase:     "Purchase",
  payment:      "Payment",
  journal:      "Journal",
  credit_note:  "Credit Note",
  debit_note:   "Debit Note",
};

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatTallyDate(isoOrDmy: string): string {
  // Accepts DD/MM/YYYY or YYYY-MM-DD, returns YYYYMMDD (Tally internal format)
  if (isoOrDmy.match(/^\d{4}-\d{2}-\d{2}$/)) {
    // ISO format
    return isoOrDmy.replace(/-/g, "");
  }
  if (isoOrDmy.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
    // DD/MM/YYYY
    const [d, m, y] = isoOrDmy.split("/");
    return `${y}${m}${d}`;
  }
  // Already YYYYMMDD
  return isoOrDmy.replace(/-/g, "");
}

// Generate a single ledger entry XML
function ledgerEntryXml(entry: LedgerEntry): string {
  const isDrCr = entry.amount < 0 ? "Dr" : "Cr";
  const absAmount = Math.abs(entry.amount).toFixed(2);
  return `
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${escapeXml(entry.ledger_name)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${entry.amount < 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      <AMOUNT>${entry.amount < 0 ? "" : "-"}${absAmount}</AMOUNT>
      <ISPARTYLEDGER>No</ISPARTYLEDGER>
    </ALLLEDGERENTRIES.LIST>`;
}

// Generate party ledger entry (always first in Tally)
function partyEntryXml(params: TallyVoucherParams): string {
  const isDebit = ["purchase", "debit_note"].includes(params.voucher_type);
  const amount = isDebit ? -params.amount : params.amount;
  return `
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${escapeXml(params.party_ledger)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${isDebit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      <AMOUNT>${amount < 0 ? "" : "-"}${Math.abs(amount).toFixed(2)}</AMOUNT>
      <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    </ALLLEDGERENTRIES.LIST>`;
}

export function generateVoucherXml(params: TallyVoucherParams): string {
  const voucherTypeName = VOUCHER_TYPE_NAMES[params.voucher_type];
  const tallyDate = formatTallyDate(params.date);

  const allEntries = [
    partyEntryXml(params),
    ...params.entries.map(ledgerEntryXml),
  ].join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(params.company_name ?? "")}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${escapeXml(voucherTypeName)}" ACTION="Create">
            <DATE>${tallyDate}</DATE>
            <VOUCHERTYPENAME>${escapeXml(voucherTypeName)}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${escapeXml(params.ref_number ?? "")}</VOUCHERNUMBER>
            <NARRATION>${escapeXml(params.narration)}</NARRATION>
            <PARTYLEDGERNAME>${escapeXml(params.party_ledger)}</PARTYLEDGERNAME>
            ${allEntries}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// ---- Build voucher params from extracted invoice fields ----

export interface InvoiceFields {
  vendor_name: string;
  invoice_number: string | null;
  invoice_date: string | null;
  taxable_value: number;
  cgst_amount: number | null;
  sgst_amount: number | null;
  igst_amount: number | null;
  tds_amount: number | null;
  total_amount: number;
  tds_section: string | null;
}

export interface LedgerMapping {
  purchase_account: string;
  input_igst_18: string;
  input_igst_12: string;
  input_igst_5: string;
  input_cgst: string;
  input_sgst: string;
  sundry_creditors: string;
  tds_payable: string;
}

export function buildPurchaseVoucher(
  invoice: InvoiceFields,
  ledgerMap: LedgerMapping,
  companyName?: string
): TallyVoucherParams {
  const entries: LedgerEntry[] = [];

  // Purchase account (Dr side — positive in our convention)
  entries.push({
    ledger_name: ledgerMap.purchase_account || "Purchase Account",
    amount: -invoice.taxable_value,  // Debit
  });

  // GST entries
  if (invoice.igst_amount && invoice.igst_amount > 0) {
    entries.push({
      ledger_name: ledgerMap.input_igst_18 || "Input IGST",
      amount: -invoice.igst_amount,  // Debit
    });
  } else {
    if (invoice.cgst_amount && invoice.cgst_amount > 0) {
      entries.push({
        ledger_name: ledgerMap.input_cgst || "Input CGST",
        amount: -invoice.cgst_amount,
      });
    }
    if (invoice.sgst_amount && invoice.sgst_amount > 0) {
      entries.push({
        ledger_name: ledgerMap.input_sgst || "Input SGST",
        amount: -invoice.sgst_amount,
      });
    }
  }

  // TDS entry (reduces the payable amount)
  if (invoice.tds_amount && invoice.tds_amount > 0) {
    entries.push({
      ledger_name: ledgerMap.tds_payable || "TDS Payable",
      amount: invoice.tds_amount,  // Credit — TDS payable
    });
  }

  return {
    voucher_type: "purchase",
    date: invoice.invoice_date ?? new Date().toISOString().slice(0, 10),
    party_ledger: invoice.vendor_name || ledgerMap.sundry_creditors || "Sundry Creditors",
    amount: invoice.total_amount,
    narration: `Purchase invoice ${invoice.invoice_number ?? ""} from ${invoice.vendor_name}`,
    ref_number: invoice.invoice_number ?? undefined,
    entries,
    company_name: companyName,
  };
}

// ---- Post to Tally ----

export async function postToTally(
  endpoint: string,
  xml: string,
  timeoutMs = 10000
): Promise<{ success: boolean; response?: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/xml; charset=utf-8" },
      body: xml,
      signal: controller.signal,
    });

    const responseText = await res.text();

    // Tally returns XML with <LINEERROR> if there was an error
    if (responseText.includes("<LINEERROR>") || responseText.includes("Error")) {
      const errMatch = responseText.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/);
      return { success: false, response: responseText, error: errMatch?.[1] ?? "Tally returned an error" };
    }

    return { success: true, response: responseText };
  } catch (err) {
    const message = err instanceof Error
      ? (err.name === "AbortError" ? "Tally connection timed out. Make sure TallyPrime is open." : err.message)
      : "Unknown error";
    return { success: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}
