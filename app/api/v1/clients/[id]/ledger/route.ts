import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET /api/v1/clients/[id]/ledger?from=&to=
// Returns per-vendor and per-expense-head ledger with invoice lines and payment status
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
    const fromDate = url.searchParams.get("from");
    const toDate   = url.searchParams.get("to");

    // ── 1. Documents (purchase invoices + expenses only) ───────────────────
    let docQuery = supabase
      .from("documents")
      .select("id, document_type, status")
      .eq("client_id", clientId)
      .eq("tenant_id", profile.tenant_id)
      .in("document_type", ["purchase_invoice", "expense"])
      .not("status", "eq", "failed");
    if (fromDate) docQuery = docQuery.gte("uploaded_at", fromDate);
    if (toDate)   docQuery = docQuery.lte("uploaded_at", toDate + "T23:59:59");
    const { data: docs } = await docQuery;
    if (!docs || docs.length === 0) {
      return NextResponse.json({ vendors: [], expense_heads: [], totals: { invoiced: 0, gst: 0, tds: 0, net_payable: 0, paid: 0, outstanding: 0 } });
    }
    const docIds = docs.map(d => d.id);

    // ── 2. Extractions for those docs ─────────────────────────────────────
    const { data: exts } = await supabase
      .from("extractions")
      .select("document_id, field_name, extracted_value, confidence")
      .in("document_id", docIds)
      .in("field_name", [
        "vendor_name", "invoice_number", "invoice_date",
        "taxable_value", "cgst_amount", "sgst_amount", "igst_amount",
        "total_amount", "tds_section", "tds_rate", "tds_amount",
        "suggested_ledger", "itc_eligible",
      ])
      .not("status", "eq", "rejected")
      .not("extracted_value", "is", null);

    // Deduplicate: latest non-rejected value per doc per field
    const fieldMap = new Map<string, string>(); // `${docId}__${field}` → value
    const seenKeys = new Set<string>();
    for (const ext of exts ?? []) {
      const key = `${ext.document_id}__${ext.field_name}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        fieldMap.set(key, ext.extracted_value ?? "");
      }
    }
    const get = (docId: string, field: string) => fieldMap.get(`${docId}__${field}`) ?? null;
    const getNum = (docId: string, field: string) => parseFloat(get(docId, field) ?? "0") || 0;

    // ── 3. Reconciliations: which docs are paid? ──────────────────────────
    const { data: recons } = await supabase
      .from("reconciliations")
      .select("document_id, status, bank_transaction_id, bank_transactions(transaction_date, debit_amount, ref_number, narration)")
      .in("document_id", docIds)
      .in("status", ["matched", "manual_match"]);

    // Map docId → payment info (take first match)
    const paymentMap = new Map<string, { date: string; amount: number; ref: string | null; narration: string }>();
    for (const r of recons ?? []) {
      if (paymentMap.has(r.document_id)) continue;
      const txn = Array.isArray(r.bank_transactions) ? r.bank_transactions[0] : r.bank_transactions;
      if (txn) {
        paymentMap.set(r.document_id, {
          date: (txn as { transaction_date: string }).transaction_date,
          amount: Number((txn as { debit_amount: number | null }).debit_amount ?? 0),
          ref: (txn as { ref_number: string | null }).ref_number,
          narration: (txn as { narration: string }).narration,
        });
      }
    }

    // ── 4. Build invoice lines ────────────────────────────────────────────
    interface InvoiceLine {
      doc_id: string;
      doc_type: string;
      doc_status: string;
      invoice_number: string | null;
      invoice_date: string | null;
      taxable_value: number;
      cgst: number;
      sgst: number;
      igst: number;
      total_gst: number;
      total_amount: number;
      tds_section: string | null;
      tds_rate: string | null;
      tds_amount: number;
      net_payable: number;
      itc_eligible: string | null;
      suggested_ledger: string | null;
      payment: { date: string; amount: number; ref: string | null; narration: string } | null;
    }

    const lines: InvoiceLine[] = docs.map(doc => {
      const cgst   = getNum(doc.id, "cgst_amount");
      const sgst   = getNum(doc.id, "sgst_amount");
      const igst   = getNum(doc.id, "igst_amount");
      const totalGst = cgst + sgst + igst;
      const taxable  = getNum(doc.id, "taxable_value");
      const total    = getNum(doc.id, "total_amount") || (taxable + totalGst);
      const tds      = getNum(doc.id, "tds_amount");
      const netPayable = total - tds;
      return {
        doc_id: doc.id,
        doc_type: doc.document_type,
        doc_status: doc.status,
        invoice_number: get(doc.id, "invoice_number"),
        invoice_date:   get(doc.id, "invoice_date"),
        taxable_value:  taxable,
        cgst, sgst, igst,
        total_gst: totalGst,
        total_amount:   total,
        tds_section:    get(doc.id, "tds_section"),
        tds_rate:       get(doc.id, "tds_rate"),
        tds_amount:     tds,
        net_payable:    netPayable,
        itc_eligible:   get(doc.id, "itc_eligible"),
        suggested_ledger: get(doc.id, "suggested_ledger"),
        payment: paymentMap.get(doc.id) ?? null,
      };
    });

    // ── 5. Group by vendor ────────────────────────────────────────────────
    const vendorMap = new Map<string, { invoices: InvoiceLine[] }>();
    for (const line of lines) {
      const vendor = get(line.doc_id, "vendor_name") || "Unknown Vendor";
      if (!vendorMap.has(vendor)) vendorMap.set(vendor, { invoices: [] });
      vendorMap.get(vendor)!.invoices.push(line);
    }

    const vendors = [...vendorMap.entries()].map(([vendor_name, { invoices }]) => {
      const total_taxable  = invoices.reduce((s, i) => s + i.taxable_value, 0);
      const total_gst      = invoices.reduce((s, i) => s + i.total_gst, 0);
      const total_invoiced = invoices.reduce((s, i) => s + i.total_amount, 0);
      const total_tds      = invoices.reduce((s, i) => s + i.tds_amount, 0);
      const net_payable    = invoices.reduce((s, i) => s + i.net_payable, 0);
      const paid           = invoices.filter(i => i.payment).reduce((s, i) => s + (i.payment?.amount ?? 0), 0);
      const outstanding    = net_payable - paid;
      return { vendor_name, invoice_count: invoices.length, total_taxable, total_gst, total_invoiced, total_tds, net_payable, paid, outstanding, invoices };
    }).sort((a, b) => b.total_invoiced - a.total_invoiced);

    // ── 6. Group by expense head ──────────────────────────────────────────
    const headMap = new Map<string, { invoices: InvoiceLine[] }>();
    for (const line of lines) {
      const head = line.suggested_ledger || "Unclassified";
      if (!headMap.has(head)) headMap.set(head, { invoices: [] });
      headMap.get(head)!.invoices.push(line);
    }

    const expense_heads = [...headMap.entries()].map(([ledger_name, { invoices }]) => ({
      ledger_name,
      invoice_count:  invoices.length,
      total_taxable:  invoices.reduce((s, i) => s + i.taxable_value, 0),
      total_gst:      invoices.reduce((s, i) => s + i.total_gst, 0),
      total_invoiced: invoices.reduce((s, i) => s + i.total_amount, 0),
      total_tds:      invoices.reduce((s, i) => s + i.tds_amount, 0),
      itc_eligible:   invoices.reduce((s, i) => s + (i.itc_eligible === "Yes" ? i.total_gst : 0), 0),
      itc_blocked:    invoices.reduce((s, i) => s + (i.itc_eligible === "Blocked" ? i.total_gst : 0), 0),
    })).sort((a, b) => b.total_invoiced - a.total_invoiced);

    // ── 7. Totals ─────────────────────────────────────────────────────────
    const totals = {
      invoiced:    lines.reduce((s, i) => s + i.total_amount, 0),
      gst:         lines.reduce((s, i) => s + i.total_gst, 0),
      tds:         lines.reduce((s, i) => s + i.tds_amount, 0),
      net_payable: lines.reduce((s, i) => s + i.net_payable, 0),
      paid:        vendors.reduce((s, v) => s + v.paid, 0),
      outstanding: vendors.reduce((s, v) => s + v.outstanding, 0),
    };

    return NextResponse.json({ vendors, expense_heads, totals });
  } catch (err) {
    console.error("[clients/ledger/GET]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
