import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Priority for extraction deduplication: corrected (human-edited) > accepted > pending
const STATUS_PRIORITY: Record<string, number> = { corrected: 3, accepted: 2, pending: 1 };

// Normalise Indian invoice dates (DD/MM/YYYY → YYYY-MM-DD) for comparison
function normaliseDate(d: string | null): string | null {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const parts = d.split("/");
  if (parts.length === 3 && parts[2].length === 4) {
    return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
  }
  return d; // return as-is if unrecognised format
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();
    if (!profile?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

    const { id: clientId } = await params;
    const url = new URL(request.url);
    const fromDate = url.searchParams.get("from"); // YYYY-MM-DD
    const toDate   = url.searchParams.get("to");   // YYYY-MM-DD

    // ── 1. Docs: reviewed/reconciled/posted only (human-verified data) ─────
    // Include purchase, expense, AND sales. No DB date filter — we filter by
    // invoice_date in JS (F3: match Excel's date logic, not uploaded_at).
    const { data: docs } = await supabase
      .from("documents")
      .select("id, document_type, status")
      .eq("client_id", clientId)
      .eq("tenant_id", profile.tenant_id)
      .in("document_type", ["purchase_invoice", "expense", "sales_invoice", "credit_note", "debit_note"])
      .in("status", ["reviewed", "reconciled", "posted"]); // F4: exclude unreviewed

    if (!docs || docs.length === 0) {
      return NextResponse.json({
        purchase: { vendors: [], expense_heads: [], totals: { invoiced: 0, taxable: 0, gst: 0, itc_eligible: 0, itc_blocked: 0, tds: 0, net_payable: 0, paid: 0, outstanding: 0 } },
        sales:    { customers: [], totals: { invoiced: 0, taxable: 0, output_gst: 0, received: 0, outstanding: 0 } },
        gst_position: { output_gst: 0, itc_eligible: 0, net_payable: 0 },
        tds_summary:  { total_deducted: 0, by_section: {}, this_month: 0, due_date: null },
      });
    }
    const docIds = docs.map(d => d.id);

    // ── 2. Extractions — F1: priority deduplication (corrected>accepted>pending) ──
    const { data: exts } = await supabase
      .from("extractions")
      .select("document_id, field_name, extracted_value, status")
      .in("document_id", docIds)
      .in("field_name", [
        "vendor_name", "buyer_name", "buyer_gstin",
        "invoice_number", "invoice_date",
        "taxable_value", "cgst_rate", "cgst_amount", "sgst_rate", "sgst_amount",
        "igst_rate", "igst_amount", "total_amount",
        "tds_section", "tds_rate", "tds_amount", "tds_section_reasoning",
        "reverse_charge", "suggested_ledger", "itc_eligible",
      ])
      .not("status", "eq", "rejected")
      .not("extracted_value", "is", null);

    // Sort by priority descending so highest-priority comes first
    const sorted = (exts ?? []).sort(
      (a, b) => (STATUS_PRIORITY[b.status] ?? 0) - (STATUS_PRIORITY[a.status] ?? 0)
    );
    // Take first seen per (docId, field) key — highest priority wins
    const fieldMap = new Map<string, string>();
    const seenKeys = new Set<string>();
    for (const ext of sorted) {
      const key = `${ext.document_id}__${ext.field_name}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        fieldMap.set(key, ext.extracted_value ?? "");
      }
    }
    const get    = (id: string, f: string) => fieldMap.get(`${id}__${f}`) ?? null;
    const getNum = (id: string, f: string) => parseFloat(get(id, f) ?? "0") || 0;

    // ── 3. Reconciliations — map docId to payment details ─────────────────
    const { data: recons } = await supabase
      .from("reconciliations")
      .select("document_id, status, bank_transactions(transaction_date, debit_amount, credit_amount, ref_number, narration)")
      .in("document_id", docIds)
      .in("status", ["matched", "manual_match"]);

    const paymentMap = new Map<string, { date: string; amount: number; ref: string | null; narration: string }>();
    for (const r of recons ?? []) {
      if (paymentMap.has(r.document_id)) continue;
      const txn = Array.isArray(r.bank_transactions) ? r.bank_transactions[0] : r.bank_transactions;
      if (!txn) continue;
      const t = txn as { transaction_date: string; debit_amount: number | null; credit_amount: number | null; ref_number: string | null; narration: string };
      // Purchases = debit (money out); Sales = credit (money in)
      const amount = Number(t.debit_amount ?? t.credit_amount ?? 0);
      paymentMap.set(r.document_id, { date: t.transaction_date, amount, ref: t.ref_number, narration: t.narration });
    }

    // ── 4. Build invoice lines & F3 date filter by invoice_date ───────────
    interface InvoiceLine {
      doc_id: string; doc_type: string;
      invoice_number: string | null; invoice_date: string | null;
      taxable_value: number;
      cgst_rate: string | null; cgst: number;
      sgst_rate: string | null; sgst: number;
      igst_rate: string | null; igst: number;
      gst_rate_pct: string;  // effective GST rate label e.g. "18%"
      total_gst: number; total_amount: number;
      tds_section: string | null; tds_rate: string | null; tds_amount: number;
      tds_reasoning: string | null;
      reverse_charge: string | null;
      net_payable: number;
      itc_eligible: string | null; suggested_ledger: string | null;
      payment: { date: string; amount: number; ref: string | null; narration: string } | null;
    }

    const allLines: InvoiceLine[] = [];
    for (const doc of docs) {
      const invDate = get(doc.id, "invoice_date");
      // F3: filter by invoice_date (not uploaded_at)
      if (fromDate || toDate) {
        const norm = normaliseDate(invDate);
        if (norm) {
          if (fromDate && norm < fromDate) continue;
          if (toDate   && norm > toDate)   continue;
        }
      }

      const cgst = getNum(doc.id, "cgst_amount");
      const sgst = getNum(doc.id, "sgst_amount");
      const igst = getNum(doc.id, "igst_amount");
      const totalGst = cgst + sgst + igst;
      const taxable  = getNum(doc.id, "taxable_value");
      const total    = getNum(doc.id, "total_amount") || (taxable + totalGst);
      const tds      = getNum(doc.id, "tds_amount");

      // Effective GST rate label
      const cgstRate = get(doc.id, "cgst_rate");
      const igstRate = get(doc.id, "igst_rate");
      let gstRatePct = "";
      if (igstRate && parseFloat(igstRate) > 0) {
        gstRatePct = `${igstRate}% IGST`;
      } else if (cgstRate && parseFloat(cgstRate) > 0) {
        const sgstRate = get(doc.id, "sgst_rate");
        const total_rate = (parseFloat(cgstRate) + parseFloat(sgstRate ?? cgstRate)).toFixed(0);
        gstRatePct = `${total_rate}%`;
      } else if (taxable > 0 && totalGst > 0) {
        gstRatePct = `${((totalGst / taxable) * 100).toFixed(0)}%`;
      }

      allLines.push({
        doc_id: doc.id, doc_type: doc.document_type,
        invoice_number: get(doc.id, "invoice_number"),
        invoice_date: invDate,
        taxable_value: taxable,
        cgst_rate: cgstRate, cgst,
        sgst_rate: get(doc.id, "sgst_rate"), sgst,
        igst_rate: igstRate, igst,
        gst_rate_pct: gstRatePct,
        total_gst: totalGst, total_amount: total,
        tds_section: get(doc.id, "tds_section"),
        tds_rate:    get(doc.id, "tds_rate"),
        tds_amount:  tds,
        tds_reasoning: get(doc.id, "tds_section_reasoning"),
        reverse_charge: get(doc.id, "reverse_charge"),
        net_payable: total - tds,
        itc_eligible:    get(doc.id, "itc_eligible"),
        suggested_ledger: get(doc.id, "suggested_ledger"),
        payment: paymentMap.get(doc.id) ?? null,
      });
    }

    // ── 5. Split into purchase/expense vs sales vs credit/debit notes ────────
    const purchaseLines = allLines.filter(l => l.doc_type === "purchase_invoice" || l.doc_type === "expense");
    const salesLines    = allLines.filter(l => l.doc_type === "sales_invoice");
    // Credit notes reduce output GST; debit notes increase it
    const creditNoteGst = allLines.filter(l => l.doc_type === "credit_note").reduce((s, l) => s + l.total_gst, 0);
    const debitNoteGst  = allLines.filter(l => l.doc_type === "debit_note").reduce((s, l) => s + l.total_gst, 0);

    // ── 6. Purchase: group by vendor ──────────────────────────────────────
    const vendorMap = new Map<string, InvoiceLine[]>();
    for (const line of purchaseLines) {
      const vendor = get(line.doc_id, "vendor_name") || "Unknown Vendor";
      if (!vendorMap.has(vendor)) vendorMap.set(vendor, []);
      vendorMap.get(vendor)!.push(line);
    }
    const vendors = [...vendorMap.entries()].map(([vendor_name, inv]) => ({
      vendor_name,
      invoice_count:   inv.length,
      total_taxable:   inv.reduce((s, i) => s + i.taxable_value, 0),
      total_gst:       inv.reduce((s, i) => s + i.total_gst, 0),
      total_invoiced:  inv.reduce((s, i) => s + i.total_amount, 0),
      total_tds:       inv.reduce((s, i) => s + i.tds_amount, 0),
      net_payable:     inv.reduce((s, i) => s + i.net_payable, 0),
      paid:            inv.filter(i => i.payment).reduce((s, i) => s + (i.payment?.amount ?? 0), 0),
      outstanding:     inv.reduce((s, i) => s + i.net_payable, 0)
                     - inv.filter(i => i.payment).reduce((s, i) => s + (i.payment?.amount ?? 0), 0),
      invoices: inv,
    })).sort((a, b) => b.total_invoiced - a.total_invoiced);

    // ── 7. Purchase: group by expense head ────────────────────────────────
    const headMap = new Map<string, InvoiceLine[]>();
    for (const line of purchaseLines) {
      const head = line.suggested_ledger || "Unclassified";
      if (!headMap.has(head)) headMap.set(head, []);
      headMap.get(head)!.push(line);
    }
    const expense_heads = [...headMap.entries()].map(([ledger_name, inv]) => ({
      ledger_name,
      invoice_count:  inv.length,
      total_taxable:  inv.reduce((s, i) => s + i.taxable_value, 0),
      total_gst:      inv.reduce((s, i) => s + i.total_gst, 0),          // actual cgst+sgst+igst (F2 fixed)
      total_invoiced: inv.reduce((s, i) => s + i.total_amount, 0),
      total_tds:      inv.reduce((s, i) => s + i.tds_amount, 0),
      itc_eligible:   inv.reduce((s, i) => s + (i.itc_eligible === "Yes"     ? i.total_gst : 0), 0),
      itc_blocked:    inv.reduce((s, i) => s + (i.itc_eligible === "Blocked" ? i.total_gst : 0), 0),
    })).sort((a, b) => b.total_invoiced - a.total_invoiced);

    // Purchase totals
    const purchaseTotals = {
      invoiced:     purchaseLines.reduce((s, i) => s + i.total_amount, 0),
      taxable:      purchaseLines.reduce((s, i) => s + i.taxable_value, 0),
      gst:          purchaseLines.reduce((s, i) => s + i.total_gst, 0),
      itc_eligible: purchaseLines.reduce((s, i) => s + (i.itc_eligible === "Yes"     ? i.total_gst : 0), 0),
      itc_blocked:  purchaseLines.reduce((s, i) => s + (i.itc_eligible === "Blocked" ? i.total_gst : 0), 0),
      tds:          purchaseLines.reduce((s, i) => s + i.tds_amount, 0),
      net_payable:  purchaseLines.reduce((s, i) => s + i.net_payable, 0),
      paid:         vendors.reduce((s, v) => s + v.paid, 0),
      outstanding:  vendors.reduce((s, v) => s + v.outstanding, 0),
    };

    // ── 8. Sales: group by customer ───────────────────────────────────────
    const customerMap = new Map<string, InvoiceLine[]>();
    for (const line of salesLines) {
      const buyer = get(line.doc_id, "buyer_name") || get(line.doc_id, "buyer_gstin") || "Unknown Customer";
      if (!customerMap.has(buyer)) customerMap.set(buyer, []);
      customerMap.get(buyer)!.push(line);
    }
    const customers = [...customerMap.entries()].map(([customer_name, inv]) => ({
      customer_name,
      invoice_count:  inv.length,
      total_taxable:  inv.reduce((s, i) => s + i.taxable_value, 0),
      total_gst:      inv.reduce((s, i) => s + i.total_gst, 0),
      total_invoiced: inv.reduce((s, i) => s + i.total_amount, 0),
      received:       inv.filter(i => i.payment).reduce((s, i) => s + (i.payment?.amount ?? 0), 0),
      outstanding:    inv.reduce((s, i) => s + i.total_amount, 0)
                    - inv.filter(i => i.payment).reduce((s, i) => s + (i.payment?.amount ?? 0), 0),
      invoices: inv,
    })).sort((a, b) => b.total_invoiced - a.total_invoiced);

    const salesTotals = {
      invoiced:    salesLines.reduce((s, i) => s + i.total_amount, 0),
      taxable:     salesLines.reduce((s, i) => s + i.taxable_value, 0),
      output_gst:  salesLines.reduce((s, i) => s + i.total_gst, 0),
      received:    customers.reduce((s, c) => s + c.received, 0),
      outstanding: customers.reduce((s, c) => s + c.outstanding, 0),
    };

    // ── 9. F9: GST net position (output net of credit notes, minus ITC) ──────
    const netOutputGst = salesTotals.output_gst - creditNoteGst + debitNoteGst;
    const gst_position = {
      output_gst:   netOutputGst,
      itc_eligible: purchaseTotals.itc_eligible,
      net_payable:  netOutputGst - purchaseTotals.itc_eligible,
    };

    // ── 10. F10: TDS payable summary ──────────────────────────────────────
    const now = new Date();
    const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const nextMonthYear  = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
    const nextMonth      = String(now.getMonth() === 11 ? 1 : now.getMonth() + 2).padStart(2, "0");
    const tds_due_date   = `${nextMonthYear}-${nextMonth}-07`;

    const tdsBySection: Record<string, number> = {};
    let tdsThisMonth = 0;
    for (const line of purchaseLines) {
      if (!line.tds_section || line.tds_section === "No TDS" || line.tds_amount <= 0) continue;
      tdsBySection[line.tds_section] = (tdsBySection[line.tds_section] ?? 0) + line.tds_amount;
      const norm = normaliseDate(line.invoice_date);
      if (norm && norm >= thisMonthStart) tdsThisMonth += line.tds_amount;
    }

    return NextResponse.json({
      purchase: { vendors, expense_heads, totals: purchaseTotals },
      sales:    { customers, totals: salesTotals },
      gst_position,
      tds_summary: {
        total_deducted: purchaseTotals.tds,
        by_section: tdsBySection,
        this_month: tdsThisMonth,
        due_date: tds_due_date,
      },
    });
  } catch (err) {
    console.error("[clients/ledger/GET]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
