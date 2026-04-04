/**
 * Unit tests — lib/tally-xml.ts
 *
 * Tests the Tally XML voucher generator without any network or DB calls.
 * Covers all 5 voucher types, XML escaping, date formatting, and the
 * buildPurchaseVoucher helper that maps extracted invoice fields to Tally entries.
 */

import {
  generateVoucherXml,
  buildPurchaseVoucher,
  formatTallyDate,
  type TallyVoucherParams,
  type InvoiceFields,
  type LedgerMapping,
} from "@/lib/tally-xml";

// ─── formatTallyDate — tested indirectly via generateVoucherXml ──────────────

describe("Date formatting (via generateVoucherXml)", () => {
  test("ISO YYYY-MM-DD is converted to YYYYMMDD in output XML", () => {
    const xml = generateVoucherXml({ ...BASE_PARAMS, date: "2026-03-15" });
    expect(xml).toContain("<DATE>20260315</DATE>");
  });

  test("DD/MM/YYYY format is converted to YYYYMMDD in output XML", () => {
    const xml = generateVoucherXml({ ...BASE_PARAMS, date: "15/03/2026" });
    expect(xml).toContain("<DATE>20260315</DATE>");
  });
});

// ─── generateVoucherXml ───────────────────────────────────────────────────────

const BASE_PARAMS: TallyVoucherParams = {
  voucher_type: "purchase",
  date: "2026-03-15",
  party_ledger: "Tata Steel Ltd",
  amount: 495600,
  narration: "Purchase invoice TSL/2026/03/4821",
  ref_number: "TSL/2026/03/4821",
  company_name: "ABC Traders Pvt Ltd",
  entries: [
    { ledger_name: "Purchase Account", amount: -420000 },
    { ledger_name: "Input CGST 9%", amount: -37800 },
    { ledger_name: "Input SGST 9%", amount: -37800 },
  ],
};

describe("generateVoucherXml — structure", () => {
  let xml: string;
  beforeAll(() => {
    xml = generateVoucherXml(BASE_PARAMS);
  });

  test("starts with XML declaration", () => {
    expect(xml).toMatch(/^<\?xml version="1\.0"/);
  });

  test("contains ENVELOPE > BODY > IMPORTDATA structure", () => {
    expect(xml).toContain("<ENVELOPE>");
    expect(xml).toContain("<BODY>");
    expect(xml).toContain("<IMPORTDATA>");
  });

  test("embeds correct voucher type name", () => {
    expect(xml).toContain('VCHTYPE="Purchase"');
    expect(xml).toContain("<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>");
  });

  test("embeds formatted date", () => {
    expect(xml).toContain("<DATE>20260315</DATE>");
  });

  test("embeds party ledger name", () => {
    expect(xml).toContain("<PARTYLEDGERNAME>Tata Steel Ltd</PARTYLEDGERNAME>");
  });

  test("embeds invoice number as voucher number", () => {
    expect(xml).toContain("<VOUCHERNUMBER>TSL/2026/03/4821</VOUCHERNUMBER>");
  });

  test("embeds narration", () => {
    expect(xml).toContain("<NARRATION>Purchase invoice TSL/2026/03/4821</NARRATION>");
  });

  test("embeds company name", () => {
    expect(xml).toContain("<SVCURRENTCOMPANY>ABC Traders Pvt Ltd</SVCURRENTCOMPANY>");
  });

  test("includes all 3 ledger entries plus party entry (4 total)", () => {
    const matches = xml.match(/<ALLLEDGERENTRIES\.LIST>/g) ?? [];
    expect(matches.length).toBe(4); // 1 party + 3 entries
  });

  test("party entry has ISPARTYLEDGER Yes", () => {
    // The first ALLLEDGERENTRIES.LIST should be the party entry
    const partyBlock = xml.match(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/)?.[0];
    expect(partyBlock).toContain("<ISPARTYLEDGER>Yes</ISPARTYLEDGER>");
    expect(partyBlock).toContain("Tata Steel Ltd");
  });
});

// ─── XML injection / escaping ─────────────────────────────────────────────────

describe("generateVoucherXml — XML escaping", () => {
  test("escapes & in company name", () => {
    const xml = generateVoucherXml({ ...BASE_PARAMS, company_name: "M/s A & B Co" });
    expect(xml).toContain("M/s A &amp; B Co");
    expect(xml).not.toContain("A & B");
  });

  test("escapes < and > in narration", () => {
    const xml = generateVoucherXml({ ...BASE_PARAMS, narration: "Invoice <test> ok" });
    expect(xml).toContain("Invoice &lt;test&gt; ok");
  });

  test("escapes double quotes in ledger name", () => {
    const xml = generateVoucherXml({
      ...BASE_PARAMS,
      entries: [{ ledger_name: 'Input "CGST"', amount: -37800 }],
    });
    expect(xml).toContain("Input &quot;CGST&quot;");
  });

  test("escapes single quotes in party ledger", () => {
    const xml = generateVoucherXml({ ...BASE_PARAMS, party_ledger: "Vendor's Account" });
    expect(xml).toContain("Vendor&apos;s Account");
  });
});

// ─── All 5 voucher types ──────────────────────────────────────────────────────

describe("generateVoucherXml — all 5 voucher types", () => {
  const types: Array<TallyVoucherParams["voucher_type"]> = [
    "purchase", "payment", "journal", "credit_note", "debit_note",
  ];
  const expectedNames: Record<string, string> = {
    purchase: "Purchase",
    payment: "Payment",
    journal: "Journal",
    credit_note: "Credit Note",
    debit_note: "Debit Note",
  };

  for (const vt of types) {
    test(`voucher_type="${vt}" produces VCHTYPE="${expectedNames[vt]}"`, () => {
      const xml = generateVoucherXml({ ...BASE_PARAMS, voucher_type: vt });
      expect(xml).toContain(`VCHTYPE="${expectedNames[vt]}"`);
    });
  }

  test("purchase voucher party entry is debit (ISDEEMEDPOSITIVE=Yes)", () => {
    const xml = generateVoucherXml({ ...BASE_PARAMS, voucher_type: "purchase" });
    const partyBlock = xml.match(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/)?.[0];
    expect(partyBlock).toContain("<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>");
  });

  test("payment voucher party entry is credit (ISDEEMEDPOSITIVE=No)", () => {
    const xml = generateVoucherXml({ ...BASE_PARAMS, voucher_type: "payment" });
    const partyBlock = xml.match(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/)?.[0];
    expect(partyBlock).toContain("<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>");
  });
});

// ─── buildPurchaseVoucher ─────────────────────────────────────────────────────

const LEDGER_MAP: LedgerMapping = {
  purchase_account: "Purchase Account",
  input_igst_18: "Input IGST 18%",
  input_igst_12: "Input IGST 12%",
  input_igst_5: "Input IGST 5%",
  input_cgst: "Input CGST 9%",
  input_sgst: "Input SGST 9%",
  sundry_creditors: "Sundry Creditors",
  tds_payable: "TDS Payable 194C",
};

describe("buildPurchaseVoucher", () => {
  test("CGST + SGST invoice: creates purchase + cgst + sgst entries", () => {
    const invoice: InvoiceFields = {
      vendor_name: "Tata Steel Ltd",
      invoice_number: "TSL/2026/03/4821",
      invoice_date: "2026-03-15",
      taxable_value: 420000,
      cgst_amount: 37800,
      sgst_amount: 37800,
      igst_amount: null,
      tds_amount: null,
      total_amount: 495600,
      tds_section: null,
    };

    const params = buildPurchaseVoucher(invoice, LEDGER_MAP, "My Company");
    expect(params.voucher_type).toBe("purchase");
    expect(params.amount).toBe(495600);
    expect(params.party_ledger).toBe("Tata Steel Ltd");
    expect(params.ref_number).toBe("TSL/2026/03/4821");

    const ledgerNames = params.entries.map((e) => e.ledger_name);
    expect(ledgerNames).toContain("Purchase Account");
    expect(ledgerNames).toContain("Input CGST 9%");
    expect(ledgerNames).toContain("Input SGST 9%");
    expect(ledgerNames).not.toContain("Input IGST 18%");
  });

  test("IGST invoice: creates purchase + igst entry (no cgst/sgst)", () => {
    const invoice: InvoiceFields = {
      vendor_name: "Reliance Industries Ltd",
      invoice_number: "RIL/MUM/2026/8834",
      invoice_date: "2026-03-22",
      taxable_value: 185000,
      cgst_amount: null,
      sgst_amount: null,
      igst_amount: 33300,
      tds_amount: null,
      total_amount: 218300,
      tds_section: null,
    };

    const params = buildPurchaseVoucher(invoice, LEDGER_MAP);
    const ledgerNames = params.entries.map((e) => e.ledger_name);
    expect(ledgerNames).toContain("Input IGST 18%");
    expect(ledgerNames).not.toContain("Input CGST 9%");
    expect(ledgerNames).not.toContain("Input SGST 9%");
  });

  test("invoice with TDS: includes TDS Payable entry as credit", () => {
    const invoice: InvoiceFields = {
      vendor_name: "Vendor Ltd",
      invoice_number: "INV-001",
      invoice_date: "2026-03-10",
      taxable_value: 100000,
      cgst_amount: 9000,
      sgst_amount: 9000,
      igst_amount: null,
      tds_amount: 1000,
      total_amount: 118000,
      tds_section: "194C",
    };

    const params = buildPurchaseVoucher(invoice, LEDGER_MAP);
    const tdsEntry = params.entries.find((e) => e.ledger_name === "TDS Payable 194C");
    expect(tdsEntry).toBeDefined();
    expect(tdsEntry!.amount).toBe(1000); // positive = credit in Tally convention
  });

  test("purchase voucher amounts: purchase entry is debit (negative)", () => {
    const invoice: InvoiceFields = {
      vendor_name: "Test Vendor",
      invoice_number: "INV-002",
      invoice_date: "2026-03-01",
      taxable_value: 50000,
      cgst_amount: 4500,
      sgst_amount: 4500,
      igst_amount: null,
      tds_amount: null,
      total_amount: 59000,
      tds_section: null,
    };

    const params = buildPurchaseVoucher(invoice, LEDGER_MAP);
    const purchaseEntry = params.entries.find((e) => e.ledger_name === "Purchase Account");
    expect(purchaseEntry!.amount).toBe(-50000); // debit = negative
  });

  test("missing invoice number defaults gracefully", () => {
    const invoice: InvoiceFields = {
      vendor_name: "Unknown Vendor",
      invoice_number: null,
      invoice_date: null,
      taxable_value: 10000,
      cgst_amount: 900,
      sgst_amount: 900,
      igst_amount: null,
      tds_amount: null,
      total_amount: 11800,
      tds_section: null,
    };

    const params = buildPurchaseVoucher(invoice, LEDGER_MAP);
    expect(params.ref_number).toBeUndefined();
    // Date should fall back to today
    expect(params.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("full round-trip: buildPurchaseVoucher → generateVoucherXml produces valid XML", () => {
    const invoice: InvoiceFields = {
      vendor_name: "Office Supplies & Co",
      invoice_number: "OS/2026/001",
      invoice_date: "2026-01-15",
      taxable_value: 25000,
      cgst_amount: 2250,
      sgst_amount: 2250,
      igst_amount: null,
      tds_amount: 250,
      total_amount: 29500,
      tds_section: "194C",
    };

    const params = buildPurchaseVoucher(invoice, LEDGER_MAP, "My Firm");
    const xml = generateVoucherXml(params);

    expect(xml).toContain("Office Supplies &amp; Co"); // escaping
    expect(xml).toContain("<DATE>20260115</DATE>");
    expect(xml).toContain("TDS Payable 194C");
    expect(xml).toContain("Purchase Account");
    expect(xml).not.toContain("undefined");
    expect(xml).not.toContain("null");
  });
});
