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
  { ledger_name: "Courier & Freight Expenses",    ledger_type: "expense" },
  { ledger_name: "Rates & Taxes",                 ledger_type: "expense" },
  { ledger_name: "PF / ESI Contributions",        ledger_type: "expense" },
  { ledger_name: "Staff Training & Development",  ledger_type: "expense" },
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

  // ── TAX PAYMENTS ─────────────────────────────────────────────────────────────
  { pattern: /\bGSTIN\b|\bGST[\s_-]?PAY|\bGSTP\b|\bCGST\b|\bSGST\b|\bIGST\b/i,
    ledger: "GST Cash Ledger" },
  { pattern: /\bTDS\b|\b26QB\b|\b26QC\b|\b26QD\b|\bINCOME[\s_-]?TAX\b|\bADVANCE[\s_-]?TAX\b/i,
    ledger: "TDS Payable" },

  // ── SALARY & PAYROLL ─────────────────────────────────────────────────────────
  // \bSALAR(?:Y|IES)?\b catches full word (SALARY/SALARIES) AND bank-truncated form (SALAR)
  // e.g. "MB:SENT TO JOHN/JUNE SALAR" → the truncated SALAR is caught
  { pattern: /\bSALAR(?:Y|IES)?\b|\bPAYROLL\b|\bWAGES\b|\bSTIPEND\b/i,
    ledger: "Salary Expenses" },

  // ── PF / ESI ─────────────────────────────────────────────────────────────────
  // EPFO, ESIC are government body codes — very low false-positive risk
  { pattern: /\bEPFO\b|\bPROVIDENT[\s_-]?FUND\b|\bPF[\s_-]?CONT|\bESIC\b|\bESICORP\b|\bESI[\s_-]?CONT/i,
    ledger: "PF / ESI Contributions" },

  // ── RENT ─────────────────────────────────────────────────────────────────────
  { pattern: /\bRENT\b|\bRENTAL\b|\bLEASE\b/i,
    ledger: "Rent" },

  // ── FUEL / VEHICLE ───────────────────────────────────────────────────────────
  { pattern: /\bPETROL\b|\bFUEL\b|\bDIESEL\b|\bCNG\b|\bHPCL\b|\bBPCL\b|\bIOCL\b|\bINDIAN[\s_-]?OIL\b/i,
    ledger: "Petrol / Vehicle Expenses" },
  // Fastag / tolls: "\bTOLL\b" alone is kept as it almost exclusively means toll payment in business accounts
  { pattern: /\bFASTAG\b|\bNHAI\b|\bTOLL[\s_-]?PLAZA\b|\bTOLL[\s_-]?TAX\b/i,
    ledger: "Petrol / Vehicle Expenses" },

  // ── BANK CHARGES ─────────────────────────────────────────────────────────────
  // Existing patterns
  { pattern: /\bBANK\s*CHARGE|\bSERVICE\s*CHARGE|\bSMS\s*CHARGE|\bATM\s*CHARGE|\bANNUAL\s*FEE|\bPROCESSING\s*FEE/i,
    ledger: "Bank Charges" },
  // Abbreviated forms used by all major Indian banks
  // CHRG / CHGS / CHG: bank-statement shorthand, not found in regular business names
  // MIN BAL / DLY BAL: minimum/daily balance alerts — bank-specific strings
  // FOLIO: ledger folio charges — highly specific banking term
  // NACH RTN / ECS RTN / CHQ RTN: return/bounce charges
  // DEMAT / DP CHRG: depository charges
  { pattern: /\bCHRGS?\b|\bMIN[\s_-]?BAL\b|\bDLY[\s_-]?BAL\b|\bDAILY[\s_-]?BAL\b|\bLEDGER[\s_-]?FOLIO\b|\bFOLIO[\s_-]?CHG\b|\bACCT[\s_-]?MAINT\b/i,
    ledger: "Bank Charges" },
  { pattern: /\bNEFT[\s_-]?CH[GR]|\bRTGS[\s_-]?CH[GR]|\bIMPS[\s_-]?CH[GR]|\bCHEQUE[\s_-]?BOOK\b|\bDP[\s_-]?CHRG\b|\bDEMAT[\s_-]?CHRG\b/i,
    ledger: "Bank Charges" },
  { pattern: /\bNACH[\s_-]?RTN\b|\bECS[\s_-]?RTN\b|\bCHQ[\s_-]?RTN\b|\bCHEQUE[\s_-]?RETURN\b|\bBOUNCE[\s_-]?CH/i,
    ledger: "Bank Charges" },

  // ── LOAN / EMI ───────────────────────────────────────────────────────────────
  { pattern: /\bEMI\b|\bLOAN\b|\bREPAYMENT\b|\bINSTAL/i,
    ledger: "Loan Repayment" },
  // Common NBFC/bank EMI narrations: "NACH DR BAJAJ FIN", "ECS DR HDFC HOME LOAN"
  { pattern: /\bBAJAJ\s*FIN|\bHDFC\s*HOME|\bICICI\s*HOME|\bSBI\s*HOME|\bKOTAK\s*LOAN|\bAXIS\s*LOAN\b/i,
    ledger: "Loan Repayment" },

  // ── INSURANCE ────────────────────────────────────────────────────────────────
  { pattern: /\bINSURANCE\b|\bLIC\b|\bPREMIUM\b|\bPOLICY\b|\bSTAR\s*HEALTH|\bHDFC\s*ERGO\b|\bNEW\s*INDIA\b|\bICICI\s*LOMBAR|\bBAJAJ\s*ALLIANZ|\bRELIANCE\s*GENERAL/i,
    ledger: "Insurance Expenses" },

  // ── ELECTRICITY ───────────────────────────────────────────────────────────────
  // Original
  { pattern: /\bELECTRICITY\b|\bELEC\b|\bMSEB\b|\bBEST\b|\bBESST\b|\bTNEB\b/i,
    ledger: "Electricity Expenses" },
  // Additional state electricity boards — all are official abbreviations, no overlap risk
  { pattern: /\bBESCOM\b|\bTORRENT[\s_-]?POWER\b|\bCESC\b|\bTATA[\s_-]?POWER\b|\bADANI[\s_-]?ELEC|\bPSPCL\b|\bUPPCL\b|\bWBSEDCL\b|\bDHBVN\b|\bJVVNL\b|\bAVVNL\b|\bTANGEDCO\b|\bGEDAP\b|\bAPDISCOM\b|\bTPDDL\b|\bBYPL\b/i,
    ledger: "Electricity Expenses" },

  // ── TELEPHONE / INTERNET ──────────────────────────────────────────────────────
  // Original
  { pattern: /\bTELEPHONE\b|\bINTERNET\b|\bBROADBAND\b|\bWIFI\b|\bJIO\b|\bAIRTEL\b|\bBSNL\b/i,
    ledger: "Telephone / Internet Expenses" },
  // Additional telecom operators
  { pattern: /\bVODAFONE\b|\bIDEA\s*CELL|\bMTNL\b|\bACT\s*FIBRE\b|\bACT\s*BROAD|\bTIKONA\b|\bHATHWAY\b|\bEXCITEL\b|\bSPECTRANET\b/i,
    ledger: "Telephone / Internet Expenses" },
  // DTH (not internet, but telecom bucket)
  { pattern: /\bTATASKY\b|\bDISH\s*TV\b|\bSUN\s*DIRECT\b|\bD2H\b|\bVIDEOCON\s*D2H\b/i,
    ledger: "Telephone / Internet Expenses" },

  // ── TRAVEL ───────────────────────────────────────────────────────────────────
  { pattern: /\bTRAVEL\b|\bFLIGHT\b|\bHOTEL\b|\bMOTEL\b|\bMERU\b|\bOLA\b|\bUBER\b|\bGOIBIBO\b|\bMAKEMYTRIP\b/i,
    ledger: "Travelling Expenses" },
  { pattern: /\bIRCTC\b|\bINDIGO\b|\bSPICEJET\b|\bAIR[\s_-]?INDIA\b|\bVISTARA\b|\bGOAIR\b|\bAIR[\s_-]?ASIA\b|\bAKASA\b/i,
    ledger: "Travelling Expenses" },
  { pattern: /\bOYO\b|\bFABHOTEL\b|\bTREBO\b|\bRADISSON\b|\bHILTON\b|\bHYATT\b|\bMAKE[\s_-]?MY[\s_-]?TRIP\b|\bCLEARTRIP\b|\bYATRA\b|\bEASEMYTRIP\b/i,
    ledger: "Travelling Expenses" },
  { pattern: /\bRAPIDAO\b|\bRAPIDAO\b|\bZIPGO\b|\bREDBUS\b|\bABHI[\s_-]?BUS\b/i,
    ledger: "Travelling Expenses" },

  // ── COMPUTER / IT / SAAS ─────────────────────────────────────────────────────
  // Original
  { pattern: /\bSOFTWARE\b|\bCOMPUTER\b|\bIT[\s_-]?SERVICE\b|\bSUBSCRIPTION\b|\bADOBE\b|\bMICROSOFT\b|\bGOOGLE\b/i,
    ledger: "Computer / IT Expenses" },
  // Cloud providers — AWS/AZURE/GCP are highly specific abbreviations
  { pattern: /\bAMAZON[\s_-]?WEB|\bAWS\s*INDIA\b|\bAWS\s*EMEA\b|\bMICROSOFT\s*AZURE\b|\bAZURE\b|\bGOOGLE[\s_-]?CLOUD\b|\bGCP\b|\bDIGITALOCEAN\b/i,
    ledger: "Computer / IT Expenses" },
  // SaaS tools widely used in Indian businesses
  { pattern: /\bGITHUB\b|\bGITLAB\b|\bZOOM\b|\bSLACK\b|\bNOTION\b|\bDROPBOX\b|\bFRESHWORKS\b|\bZOHO\b|\bHUBSPOT\b|\bTALLYSERV\b/i,
    ledger: "Computer / IT Expenses" },
  { pattern: /\bNETLIFY\b|\bVERCEL\b|\bHEROKU\b|\bSHOPIFY\b|\bWIX\b|\bSEMRUSH\b|\bAHREFS\b|\bCANVA\b|\bFIGMA\b/i,
    ledger: "Computer / IT Expenses" },

  // ── ADVERTISING / MARKETING ──────────────────────────────────────────────────
  { pattern: /\bADVERTIS|\bMARKETING\b|\bPROMOTION\b|\bGOOGLE[\s_-]?ADS\b|\bFACEBOOK[\s_-]?ADS\b|\bMETA[\s_-]?ADS\b|\bINSTAGRAM[\s_-]?ADS\b/i,
    ledger: "Advertising & Marketing" },

  // ── INTEREST INCOME ──────────────────────────────────────────────────────────
  // Credits only — but scored as interest income for credit transactions
  { pattern: /\bINTEREST[\s_-]?CREDIT\b|\bINTEREST[\s_-]?EARN|\bFD[\s_-]?INTEREST\b|\bRD[\s_-]?INTEREST\b/i,
    ledger: "Interest Income" },

  // ── COURIER & FREIGHT ────────────────────────────────────────────────────────
  // All major Indian courier companies — very specific brand names
  { pattern: /\bBLUEDART\b|\bDTDC\b|\bDELHIVERY\b|\bEKART\b|\bXPRESSBEES\b|\bSHADOWFAX\b|\bECOM[\s_-]?EXPRESS\b|\bSHIPROCKET\b/i,
    ledger: "Courier & Freight Expenses" },
  { pattern: /\bFEDEX\b|\bDHL\b|\bUPS\b|\bTNT\b|\bGATI\b|\bSTAFFLINE\b|\bSAFEEXPRESS\b|\bSHIPYARI\b/i,
    ledger: "Courier & Freight Expenses" },

  // ── RATES & TAXES ────────────────────────────────────────────────────────────
  // Municipal bodies — all official abbreviations. PMC is Pune Municipal Corp.
  // Risk note: "PMC" occasionally appears in other contexts (e.g. project management).
  // \bPMC\b alone is kept because in Indian bank statements it overwhelmingly means
  // Pune Municipal Corporation. If this fires incorrectly, the CA will correct it
  // and a Layer 3 rule will override it.
  { pattern: /\bMCGM\b|\bBBMP\b|\bPCMC\b|\bBMC\b|\bNMC\b|\bGMC\b/i,
    ledger: "Rates & Taxes" },
  { pattern: /\bPROFESSION[\s_-]?TAX\b|\bPROF[\s_-]?TAX\b|\bPROFTAX\b|\bPT[\s_-]?PAYMENT\b|\bPT[\s_-]?PMT\b/i,
    ledger: "Rates & Taxes" },
  { pattern: /\bPROPERTY[\s_-]?TAX\b|\bMUNICIPAL[\s_-]?TAX\b|\bHOUSE[\s_-]?TAX\b/i,
    ledger: "Rates & Taxes" },

  // ── STAFF WELFARE (food / pantry) ────────────────────────────────────────────
  // Swiggy/Zomato in a business bank account is almost always team lunch/office food
  { pattern: /\bSWIGGY\b|\bZOMATO\b|\bDUNZO\b|\bBLINKIT\b|\bZEPTO\b|\bBIGBASKET\b/i,
    ledger: "Staff Welfare Expenses" },
  // Common food chains / QSR — UPI payments to these are almost always meals
  { pattern: /\bMC\s*DONALDS?\b|\bMCDONALD|\bMCDONALD'?S\b|\bBURGER\s*KING\b|\bKFC\b|\bDOMINOS?\b|\bPIZZA\s*HUT\b|\bSUBWAY\b|\bCAFE\s*COFFEE\b|\bCOFFEE\s*DAY\b|\bCCD\b|\bSTARBUCKS\b|\bCHAI\s*POINT\b/i,
    ledger: "Staff Welfare Expenses" },
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

  // Strip leading payment method tokens including mobile banking (mb) and "sent to" narrations
  n = n
    .replace(/^(neft|rtgs|imps|upi|mmt|neft rtgs|net banking|mb|mobile banking|transfer|payment|credit|debit)\s+/i, "")
    .replace(/^sent\s+to\s+/i, "")   // "MB:SENT TO VENDOR NAME" → strip "sent to"
    .replace(/^\d{10,}\s+/, "")      // strip leading reference numbers (10+ digits)
    .trim();

  // Strip embedded reference numbers: sequences of 6+ digits anywhere in the string.
  // UPI/NEFT reference numbers are 10-12 digits and change every transaction — removing them
  // makes the pattern stable across months for the same vendor.
  // Guard: only strip if surrounded by spaces or string boundary (avoids removing
  // short numbers that are part of a vendor name like "3M" or "B2B").
  n = n
    .replace(/\s\d{6,}\s/g, " ")   // digits in the middle: " 410348559798 " → " "
    .replace(/\s\d{6,}$/g, "")     // digits at the end:    " 410348559798"  → ""
    .replace(/\s+/g, " ")
    .trim();

  // Strip trailing payment method suffixes that re-appear after the vendor name
  // e.g. "zomato technologies upi" → "zomato technologies"
  n = n.replace(/\s+(upi|neft|rtgs|imps|mmt|ref|cr|dr)$/i, "").trim();

  // Take first 30 chars of what remains
  return n.slice(0, 30).trim();
}

// ── Layer 1 display metadata (for Rules Library UI) ──────────────────────────
// Human-readable descriptions — no RegExp objects, safe to import in client components
export const GLOBAL_RULES_DISPLAY: {
  ledger: string;
  label: string;
  examples: string;
}[] = [
  { ledger: "GST Cash Ledger",              label: "GST Payments",                    examples: "GSTIN, GST PMT, CGST, SGST, IGST" },
  { ledger: "TDS Payable",                  label: "TDS / Income Tax",                examples: "TDS, 26QB, 26QC, INCOME TAX, ADVANCE TAX" },
  { ledger: "Salary Expenses",              label: "Salary & Payroll",                examples: "SALARY, SALAR (truncated), PAYROLL, WAGES, STIPEND" },
  { ledger: "PF / ESI Contributions",       label: "PF / ESI",                        examples: "EPFO, PROVIDENT FUND, PF CONT, ESIC" },
  { ledger: "Rent",                         label: "Rent & Lease",                    examples: "RENT, RENTAL, LEASE" },
  { ledger: "Petrol / Vehicle Expenses",    label: "Fuel & Tolls",                    examples: "PETROL, DIESEL, CNG, HPCL, BPCL, IOCL, FASTAG, NHAI" },
  { ledger: "Bank Charges",                 label: "Bank Charges & Fees",             examples: "CHRG, CHGS, MIN BAL, DLY BAL, FOLIO, NACH RTN, ECS RTN, BOUNCE" },
  { ledger: "Loan Repayment",               label: "Loan / EMI",                      examples: "EMI, LOAN, REPAYMENT, BAJAJ FIN, HDFC HOME" },
  { ledger: "Insurance Expenses",           label: "Insurance Premiums",              examples: "INSURANCE, LIC, PREMIUM, STAR HEALTH, HDFC ERGO, BAJAJ ALLIANZ" },
  { ledger: "Electricity Expenses",         label: "Electricity Boards",              examples: "MSEB, BESCOM, TORRENT POWER, CESC, TATA POWER, ADANI ELEC, TNEB" },
  { ledger: "Telephone / Internet Expenses",label: "Telecom & Internet",              examples: "JIO, AIRTEL, BSNL, VODAFONE, MTNL, ACT FIBRE, TATASKY, DISH TV" },
  { ledger: "Travelling Expenses",          label: "Travel (flights, hotels, cabs)",  examples: "IRCTC, INDIGO, SPICEJET, OLA, UBER, OYO, RADISSON, MAKEMYTRIP" },
  { ledger: "Computer / IT Expenses",       label: "Software & Cloud / SaaS",         examples: "AWS, AZURE, GOOGLE CLOUD, GITHUB, ZOOM, SLACK, ZOHO, TALLY" },
  { ledger: "Advertising & Marketing",      label: "Ads & Marketing",                 examples: "GOOGLE ADS, FACEBOOK ADS, META ADS, ADVERTIS, MARKETING" },
  { ledger: "Interest Income",              label: "Interest Credits",                examples: "INTEREST CREDIT, FD INTEREST, RD INTEREST" },
  { ledger: "Courier & Freight Expenses",   label: "Courier & Logistics",             examples: "BLUEDART, DTDC, DELHIVERY, EKART, FEDEX, DHL, XPRESSBEES" },
  { ledger: "Rates & Taxes",                label: "Municipal & Professional Tax",    examples: "MCGM, BBMP, PCMC, BMC, PROFESSION TAX, PROPERTY TAX" },
  { ledger: "Staff Welfare Expenses",       label: "Staff Food & Office Supplies",    examples: "SWIGGY, ZOMATO, BLINKIT, BIGBASKET, DUNZO, ZEPTO" },
];

// ── Ledger → category/voucher_type mapping (single source of truth) ──────────
// Returns null for custom/unknown ledgers — callers should not overwrite category in that case.
export function ledgerToMeta(ledgerName: string): { category: string; voucher_type: string } | null {
  switch (ledgerName) {
    case "GST Cash Ledger":               return { category: "GST Payment",         voucher_type: "Payment" };
    case "TDS Payable":                   return { category: "TDS Payment",          voucher_type: "Journal" };
    case "Salary Expenses":               return { category: "Salary",               voucher_type: "Payment" };
    case "PF / ESI Contributions":        return { category: "Salary",               voucher_type: "Payment" };
    case "Bank Charges":                  return { category: "Bank Charges",         voucher_type: "Journal" };
    case "Loan Repayment":                return { category: "Loan Repayment",       voucher_type: "Payment" };
    case "Rent":                          return { category: "Rent",                 voucher_type: "Payment" };
    case "Insurance Expenses":            return { category: "Insurance",            voucher_type: "Payment" };
    case "Interest Income":               return { category: "Interest Income",      voucher_type: "Journal" };
    case "Interest Expense":              return { category: "Interest Expense",     voucher_type: "Journal" };
    case "Electricity Expenses":          return { category: "Utility",              voucher_type: "Payment" };
    case "Telephone / Internet Expenses": return { category: "Utility",              voucher_type: "Payment" };
    case "Travelling Expenses":           return { category: "Travel",               voucher_type: "Payment" };
    case "Staff Welfare Expenses":        return { category: "Staff Welfare",        voucher_type: "Payment" };
    case "Computer / IT Expenses":        return { category: "Software / IT",        voucher_type: "Payment" };
    case "Advertising & Marketing":       return { category: "Marketing",            voucher_type: "Payment" };
    case "Petrol / Vehicle Expenses":     return { category: "Fuel / Vehicle",       voucher_type: "Payment" };
    case "Courier & Freight Expenses":    return { category: "Courier / Freight",    voucher_type: "Payment" };
    case "Professional Fees":             return { category: "Professional Fees",    voucher_type: "Payment" };
    case "Repair & Maintenance":          return { category: "Repair / Maintenance", voucher_type: "Payment" };
    case "Rates & Taxes":                 return { category: "Rates & Taxes",        voucher_type: "Payment" };
    case "Printing & Stationery":         return { category: "Stationery",           voucher_type: "Payment" };
    case "Staff Training & Development":  return { category: "Training",             voucher_type: "Payment" };
    case "Miscellaneous Expenses":        return { category: "Miscellaneous",        voucher_type: "Payment" };
    default: return null; // custom/client ledger — caller keeps existing category
  }
}

// ── Invoice ledger rules (used during AI extraction post-processing) ──────────
interface LedgerRule { keywords: RegExp; ledger: string }
export const INVOICE_LEDGER_RULES: LedgerRule[] = [
  { keywords: /\b(salary|salaries|payroll|wages|stipend|hr|payslip)\b/i,         ledger: "Salary Expenses" },
  { keywords: /\b(rent|rental|lease.rent|premises|office.rent)\b/i,               ledger: "Rent" },
  { keywords: /\b(advocate|lawyer|legal|ca.firm|chartered|audit|consultant|advisory|architect|doctor|clinic|hospital|it.service|software|technical)\b/i, ledger: "Professional Fees" },
  { keywords: /\b(transport|courier|logistics|freight|cargo|delivery|travel|flight|airline|hotel|accommodation|makemytrip|cleartrip|yatra|goibibo|expedia|booking\.com|airbnb|irctc|indigo|spicejet|air.india|vistara|goair|air.asia|cab|taxi|uber|ola|rapido|train|bus.ticket|boarding.pass)\b/i, ledger: "Travelling Expenses" },
  { keywords: /\b(drone|aerial|videograph|cinematograph|photo.shoot|filming|aerial.survey|content.produc)\b/i, ledger: "Photography / Videography Charges" },
  { keywords: /\b(advertis|marketing|media|promotion|campaign|pr.agency)\b/i,     ledger: "Advertising & Marketing" },
  { keywords: /\b(electricity|power|mseb|bescom|tneb|discom)\b/i,                 ledger: "Electricity Expenses" },
  { keywords: /\b(telephone|internet|broadband|wifi|jio|airtel|bsnl|vodafone|idea|mobile.bill)\b/i, ledger: "Telephone / Internet Expenses" },
  { keywords: /\b(insurance|lic|policy.premium|general.insurance|fire.insurance)\b/i, ledger: "Insurance Expenses" },
  { keywords: /\b(repair|maintenance|service.charge|amc|annual.maintenance)\b/i,  ledger: "Repair & Maintenance" },
  { keywords: /\b(petrol|fuel|diesel|hpcl|bpcl|iocl|vehicle.fuel)\b/i,           ledger: "Petrol / Vehicle Expenses" },
  { keywords: /\b(office.supply|stationery|printing|paper|cartridge|toner)\b/i,  ledger: "Printing & Stationery" },
  { keywords: /\b(staff.welfare|pantry|canteen|food|swiggy|zomato|meal)\b/i,     ledger: "Staff Welfare Expenses" },
  { keywords: /\b(computer|laptop|server|hardware|software.licen|subscription|microsoft|adobe|google.workspace|zoom)\b/i, ledger: "Computer / IT Expenses" },
  { keywords: /\b(bank.charge|service.charge|sms.charge|annual.fee|processing.fee|atm.charge)\b/i, ledger: "Bank Charges" },
  { keywords: /\b(loan|emi|repayment|instalment|principal)\b/i,                   ledger: "Loan Repayment" },
  { keywords: /\b(training|educat|academy|institute|elearning|e.learning|edtech|skill.develop|coaching|tuition|course|learning|upskill|workshop|seminar)\b/i, ledger: "Staff Training & Development" },
  { keywords: /\b(courier|bluedart|dtdc|delhivery|ekart|fedex|dhl|xpressbees)\b/i, ledger: "Courier & Freight Expenses" },
];
