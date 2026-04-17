// Layer 1: Global keyword rules for common Indian business ledgers
// Applied to every bank transaction at upload time regardless of client

export const COMMON_LEDGERS: { ledger_name: string; ledger_type: string }[] = [
  // Expenses
  { ledger_name: "Salary Expenses",               ledger_type: "expense" },
  { ledger_name: "Petrol / Vehicle Expenses",     ledger_type: "expense" },
  { ledger_name: "Rent",                          ledger_type: "expense" },
  { ledger_name: "Bank Charges",                  ledger_type: "expense" },
  { ledger_name: "Computer / IT Expenses",        ledger_type: "expense" },
  { ledger_name: "Printing & Stationery",         ledger_type: "expense" },
  { ledger_name: "Telephone / Internet Expenses", ledger_type: "expense" },
  { ledger_name: "Electricity Expenses",          ledger_type: "expense" },
  { ledger_name: "Staff Welfare Expenses",        ledger_type: "expense" },
  { ledger_name: "Repair & Maintenance",          ledger_type: "expense" },
  { ledger_name: "Travelling Expenses",           ledger_type: "expense" },
  { ledger_name: "Insurance Expenses",            ledger_type: "expense" },
  { ledger_name: "Professional Fees",             ledger_type: "expense" },
  { ledger_name: "Advertising & Marketing",       ledger_type: "expense" },
  { ledger_name: "Miscellaneous Expenses",        ledger_type: "expense" },
  { ledger_name: "Loan Repayment",                ledger_type: "liability" },
  // Income
  { ledger_name: "Sales Account",                 ledger_type: "income" },
  { ledger_name: "Other Income",                  ledger_type: "income" },
  { ledger_name: "Interest Income",               ledger_type: "income" },
  // Tax
  { ledger_name: "GST Cash Ledger",              ledger_type: "tax" },
  { ledger_name: "TDS Payable",                  ledger_type: "tax" },
  { ledger_name: "Input CGST",                   ledger_type: "tax" },
  { ledger_name: "Input SGST",                   ledger_type: "tax" },
  { ledger_name: "Output CGST",                  ledger_type: "tax" },
  { ledger_name: "Output SGST",                  ledger_type: "tax" },
  // Capital / Bank
  { ledger_name: "Capital Account",              ledger_type: "capital" },
  { ledger_name: "Drawings",                     ledger_type: "capital" },
  { ledger_name: "Cash Account",                 ledger_type: "bank" },
];

interface GlobalRule { pattern: RegExp; ledger: string }

const GLOBAL_RULES: GlobalRule[] = [
  { pattern: /\bGSTIN\b|\bGST[\s_-]?PAY|\bGSTP\b|\bCGST\b|\bSGST\b|\bIGST\b/i, ledger: "GST Cash Ledger" },
  { pattern: /\bTDS\b|\b26QB\b|\b26QC\b|\bINCOME[\s_-]?TAX\b/i,                 ledger: "TDS Payable" },
  { pattern: /\bSALARY\b|\bSALARIES\b|\bPAYROLL\b|\bWAGES\b|\bSTIPEND\b/i,      ledger: "Salary Expenses" },
  { pattern: /\bRENT\b|\bRENTAL\b|\bLEASE\b/i,                                   ledger: "Rent" },
  { pattern: /\bPETROL\b|\bFUEL\b|\bDIESEL\b/i,                                  ledger: "Petrol / Vehicle Expenses" },
  { pattern: /\bBANK CHARGE|\bSERVICE CHARGE|\bSMS CHARGE|\bATM CHARGE|\bANNUAL FEE|\bPROCESSING FEE/i, ledger: "Bank Charges" },
  { pattern: /\bEMI\b|\bLOAN\b|\bREPAYMENT\b|\bINSTAL/i,                         ledger: "Loan Repayment" },
  { pattern: /\bINSURANCE\b|\bLIC\b|\bPREMIUM\b|\bPOLICY\b/i,                    ledger: "Insurance Expenses" },
  { pattern: /\bELECTRICITY\b|\bELEC\b|\bMSEB\b|\bBEST\b|\bBESST\b|\bTNEB\b/i,  ledger: "Electricity Expenses" },
  { pattern: /\bTELEPHONE\b|\bINTERNET\b|\bBROADBAND\b|\bWIFI\b|\bJIO\b|\bAIRTEL\b|\bBSNL\b/i, ledger: "Telephone / Internet Expenses" },
  { pattern: /\bINTEREST\b|\bFD INTEREST\b/i,                                     ledger: "Interest Income" },
  { pattern: /\bADVERTIS|\bMARKETING\b|\bPROMOTION\b/i,                          ledger: "Advertising & Marketing" },
  { pattern: /\bTRAVEL\b|\bFLIGHT\b|\bHOTEL\b|\bMOTEL\b|\bMERU\b|\bOLA\b|\bUBER\b|\bGOIBIBO\b|\bMAKEMYTRIP\b/i, ledger: "Travelling Expenses" },
  { pattern: /\bSOFTWARE\b|\bCOMPUTER\b|\bIT SERVICE\b|\bSUBSCRIPTION\b|\bADOBE\b|\bMICROSOFT\b|\bGOOGLE\b/i, ledger: "Computer / IT Expenses" },
];

/** Suggest a ledger name using global Layer 1 rules. Returns null if no match. */
export function suggestLedger(narration: string): string | null {
  const n = narration.toUpperCase();
  for (const rule of GLOBAL_RULES) {
    if (rule.pattern.test(n)) return rule.ledger;
  }
  return null;
}

/**
 * Extract a normalised pattern key from a narration for rule storage/lookup.
 * Skips common banking prefixes (NEFT/RTGS/IMPS/UPI/MMT) so the meaningful
 * vendor/party name is captured instead of the payment method prefix.
 */
export function extractPattern(narration: string): string {
  let n = narration
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Strip leading payment method tokens: neft, rtgs, imps, upi, mmt, transfer, payment
  n = n
    .replace(/^(neft|rtgs|imps|upi|mmt|neft rtgs|net banking|transfer|payment|credit|debit)\s+/i, "")
    .replace(/^\d{10,}\s+/, "") // strip leading reference numbers (10+ digits)
    .trim();

  // Take first 30 chars of what remains
  return n.slice(0, 30).trim();
}
