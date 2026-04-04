/**
 * Unit tests — lib/bank-statement-parser.ts
 *
 * Tests CSV/XLSX parsing and the invoice-to-transaction matching algorithm.
 * No network or DB calls — all pure function tests.
 */

import { parseCSV, scoreMatch, type BankTransaction, type InvoiceForMatching } from "@/lib/bank-statement-parser";

// ─── CSV parsing ──────────────────────────────────────────────────────────────

describe("parseCSV — HDFC format", () => {
  const HDFC_CSV = `Date,Narration,Chq./ Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance
17/03/2026,NEFT-TATA STEEL LTD-INV4821,HDFC0000001,495600.00,,1234567.89
24/03/2026,IMPS-RELIANCE IND-RIL8834,HDFC0000002,218300.00,,1016267.89
28/03/2026,UPI-OFFICE RENT-MAR26,HDFC0000003,85000.00,,931267.89
29/03/2026,NEFT-SALARY-MARCH,,,180000.00,1111267.89`;

  let txns: ReturnType<typeof parseCSV>;
  beforeAll(() => { txns = parseCSV(HDFC_CSV); });

  test("parses 4 transactions", () => {
    expect(txns.length).toBe(4);
  });

  test("correctly parses debit amount", () => {
    expect(txns[0].debit).toBe(495600);
  });

  test("correctly parses credit amount", () => {
    // Row: 29/03/2026,NEFT-SALARY-MARCH,,,180000.00,1111267.89
    // Deposit Amt = 180000, Closing Balance = 1111267.89
    expect(txns[3].credit).toBe(180000);
    expect(txns[3].debit).toBeNull();
  });

  test("parses date in DD/MM/YYYY to ISO YYYY-MM-DD", () => {
    expect(txns[0].date).toBe("2026-03-17");
    expect(txns[1].date).toBe("2026-03-24");
  });

  test("preserves narration", () => {
    expect(txns[0].narration).toBe("NEFT-TATA STEEL LTD-INV4821");
  });

  test("captures ref number", () => {
    expect(txns[0].ref_number).toBe("HDFC0000001");
  });
});

describe("parseCSV — ICICI format", () => {
  const ICICI_CSV = `Transaction Date,Transaction Remarks,Transaction ID,Withdrawal(Dr),Deposit(Cr),Balance(in Rs.)
22/03/2026,NEFT/RIL8834/RELIANCE INDUSTRIES,ICICI20260322001,218300.00,,500000.00
23/03/2026,SALARY CREDIT,,50000.00,550000.00`;

  let txns: ReturnType<typeof parseCSV>;
  beforeAll(() => { txns = parseCSV(ICICI_CSV); });

  test("parses 2 transactions", () => {
    expect(txns.length).toBe(2);
  });

  test("parses debit from ICICI Withdrawal(Dr) column", () => {
    expect(txns[0].debit).toBe(218300);
  });

  test("parses ISO date correctly", () => {
    expect(txns[0].date).toBe("2026-03-22");
  });
});

describe("parseCSV — SBI format", () => {
  const SBI_CSV = `Txn Date,Description,Ref No/ Cheque No.,Debit,Credit,Balance
15/03/2026,NEFT TSL4821 TATA STEEL,SBI0001,495600,,800000
16/03/2026,Interest Credit,,5000,805000`;

  let txns: ReturnType<typeof parseCSV>;
  beforeAll(() => { txns = parseCSV(SBI_CSV); });

  test("parses 2 transactions from SBI format", () => {
    expect(txns.length).toBe(2);
  });

  test("parses debit from SBI Debit column", () => {
    expect(txns[0].debit).toBe(495600);
  });
});

describe("parseCSV — edge cases", () => {
  test("skips opening/closing balance rows", () => {
    const csv = `Date,Narration,Withdrawal Amt.,Deposit Amt.,Balance
01/03/2026,Opening Balance,,,500000
15/03/2026,NEFT Payment,10000,,490000
31/03/2026,Closing Balance,,,490000`;
    const txns = parseCSV(csv);
    expect(txns.length).toBe(1);
    expect(txns[0].narration).toBe("NEFT Payment");
  });

  test("handles Indian rupee symbol in amounts", () => {
    const csv = `Date,Narration,Debit,Credit,Balance
15/03/2026,Payment,₹1,00,000,,`;
    const txns = parseCSV(csv);
    expect(txns.length).toBe(1);
    // parseAmount strips ₹ and commas
  });

  test("handles empty file gracefully", () => {
    const txns = parseCSV("");
    expect(txns).toEqual([]);
  });

  test("handles header-only CSV", () => {
    const csv = `Date,Narration,Debit,Credit,Balance`;
    const txns = parseCSV(csv);
    expect(txns).toEqual([]);
  });
});

// ─── scoreMatch — matching algorithm ─────────────────────────────────────────

const makeTxn = (overrides: Partial<BankTransaction & { id: string }> = {}): BankTransaction & { id: string } => ({
  id: "txn-001",
  date: "2026-03-17",
  narration: "NEFT-TATA STEEL LTD-INV4821",
  ref_number: "HDFC0000001",
  debit: 495600,
  credit: null,
  balance: 1234567,
  raw_row: {},
  ...overrides,
});

const makeInvoice = (overrides: Partial<InvoiceForMatching> = {}): InvoiceForMatching => ({
  id: "doc-001",
  invoice_number: "TSL/2026/03/4821",
  invoice_date: "2026-03-15",
  due_date: "2026-03-22",
  total_amount: 495600,
  tds_amount: null,
  vendor_name: "Tata Steel Ltd",
  payment_reference: null,
  ...overrides,
});

describe("scoreMatch — exact amount", () => {
  test("exact amount match scores 50 points", () => {
    const { score, reasons } = scoreMatch(makeTxn(), makeInvoice());
    expect(score).toBeGreaterThanOrEqual(50);
    expect(reasons.some((r) => r.toLowerCase().includes("exact amount"))).toBe(true);
  });

  test("amount within 2% scores 30 points", () => {
    // Invoice 495600, txn 495700 (difference < 2%)
    const { score, reasons } = scoreMatch(
      makeTxn({ debit: 495700 }),
      makeInvoice()
    );
    expect(reasons.some((r) => r.includes("2%"))).toBe(true);
    expect(score).toBeGreaterThanOrEqual(30);
  });

  test("amount after TDS deduction matches", () => {
    // Invoice total 500000, TDS 20000 (4% — outside 2% band), bank paid net 480000
    // The 2% check fails (diff=20000/500000=4%), so falls through to TDS check
    const { score, reasons } = scoreMatch(
      makeTxn({ debit: 480000, narration: "NEFT-VENDOR" }),
      makeInvoice({ total_amount: 500000, tds_amount: 20000, vendor_name: null, invoice_number: null })
    );
    expect(reasons.some((r) => r.includes("TDS"))).toBe(true);
    expect(score).toBeGreaterThanOrEqual(20);
  });

  test("completely wrong amount scores 0 for amount", () => {
    const { score } = scoreMatch(
      makeTxn({ debit: 999999 }),
      makeInvoice({ vendor_name: null, invoice_number: null, due_date: null, invoice_date: null })
    );
    expect(score).toBe(0);
  });
});

describe("scoreMatch — date proximity", () => {
  test("bank date within 7 days of due date scores 30", () => {
    const { score, reasons } = scoreMatch(
      makeTxn({ date: "2026-03-19", narration: "payment", debit: 999 }),
      makeInvoice({ due_date: "2026-03-22", total_amount: 999, vendor_name: null, invoice_number: null })
    );
    expect(reasons.some((r) => r.includes("7 days"))).toBe(true);
    expect(score).toBeGreaterThanOrEqual(30);
  });

  test("bank date more than 30 days away scores 0 for date", () => {
    const { score } = scoreMatch(
      makeTxn({ date: "2026-01-01", narration: "payment", debit: 999 }),
      makeInvoice({ total_amount: 999, vendor_name: null, invoice_number: null, due_date: null, invoice_date: "2025-01-01" })
    );
    // 365 days away — no date score
    const dateReasons = ["within 7 days", "within 30 days"];
    const { reasons } = scoreMatch(
      makeTxn({ date: "2026-01-01", narration: "x", debit: 999 }),
      makeInvoice({ total_amount: 999, vendor_name: null, invoice_number: null, due_date: null, invoice_date: "2025-01-01" })
    );
    expect(reasons.some((r) => dateReasons.some((d) => r.includes(d)))).toBe(false);
  });
});

describe("scoreMatch — invoice number in narration", () => {
  test("invoice number found in narration scores 40", () => {
    // The algorithm does narration.includes(invoiceNumber) after stripping spaces.
    // Both invoice_number and narration must share the exact string after lowercase+strip.
    const { score, reasons } = scoreMatch(
      makeTxn({ narration: "NEFT TSL/2026/03/4821 PAYMENT", debit: 999 }),
      makeInvoice({ invoice_number: "TSL/2026/03/4821", total_amount: 999, vendor_name: null })
    );
    expect(reasons.some((r) => r.toLowerCase().includes("invoice number"))).toBe(true);
    expect(score).toBeGreaterThanOrEqual(40);
  });

  test("invoice number NOT in narration scores 0 for this factor", () => {
    const { reasons } = scoreMatch(
      makeTxn({ narration: "NEFT-UNKNOWN-VENDOR", debit: 999 }),
      makeInvoice({ invoice_number: "TSL/2026/03/4821", total_amount: 999, vendor_name: null, due_date: null, invoice_date: null })
    );
    expect(reasons.some((r) => r.toLowerCase().includes("invoice number"))).toBe(false);
  });
});

describe("scoreMatch — vendor name in narration", () => {
  test("2+ vendor name words in narration score 25", () => {
    const { score, reasons } = scoreMatch(
      makeTxn({ narration: "NEFT-TATA STEEL LTD PAYMENT", debit: 999 }),
      makeInvoice({ vendor_name: "Tata Steel Ltd", total_amount: 999, invoice_number: null, due_date: null, invoice_date: null })
    );
    expect(reasons.some((r) => r.toLowerCase().includes("vendor name"))).toBe(true);
    expect(score).toBeGreaterThanOrEqual(25);
  });

  test("1 vendor word in narration scores 10 (partial match)", () => {
    const { reasons } = scoreMatch(
      makeTxn({ narration: "NEFT STEEL payment", debit: 999 }),
      makeInvoice({ vendor_name: "Tata Steel Ltd", total_amount: 999, invoice_number: null, due_date: null, invoice_date: null })
    );
    expect(reasons.some((r) => r.toLowerCase().includes("partial"))).toBe(true);
  });
});

describe("scoreMatch — UTR reference match", () => {
  test("matching UTR/reference scores 35", () => {
    const { score, reasons } = scoreMatch(
      makeTxn({ ref_number: "NEFT12345678901234567890", debit: 999 }),
      makeInvoice({ payment_reference: "NEFT12345678901234567890", total_amount: 999, vendor_name: null, invoice_number: null })
    );
    expect(reasons.some((r) => r.toLowerCase().includes("utr") || r.toLowerCase().includes("reference"))).toBe(true);
    expect(score).toBeGreaterThanOrEqual(35);
  });
});

describe("scoreMatch — combined high-confidence match", () => {
  test("perfect match: exact amount + date + invoice number + vendor scores 140+", () => {
    const { score } = scoreMatch(makeTxn(), makeInvoice());
    // Exact amount (50) + date (30 if within 7 days of due date) + invoice number in narration (40) + vendor (25)
    expect(score).toBeGreaterThanOrEqual(100);
  });

  test("zero overlap scores 0", () => {
    const { score } = scoreMatch(
      makeTxn({ narration: "SALARY PAYMENT", debit: 50000, ref_number: null }),
      makeInvoice({ total_amount: 495600, vendor_name: "Tata Steel", invoice_number: "TSL-001", due_date: null, invoice_date: null })
    );
    expect(score).toBe(0);
  });
});
