import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { data: profile } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).single();
  if (!profile?.tenant_id) return NextResponse.json({ error: "Tenant not found" }, { status: 400 });

  const tenantId = profile.tenant_id;
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") ?? "csv";

  const { data: recons } = await supabase
    .from("reconciliations")
    .select(`
      id, status, match_score, match_reasons, matched_at,
      bank_transactions(transaction_date, narration, ref_number, debit_amount, credit_amount, bank_name),
      documents(original_filename, document_type)
    `)
    .eq("tenant_id", tenantId)
    .order("matched_at", { ascending: false });

  // Build CSV
  const headers = [
    "Status", "Bank Date", "Bank Narration", "Bank Ref", "Debit", "Credit",
    "Bank", "Invoice File", "Doc Type", "Match Score", "Match Reasons", "Matched At"
  ];

  const rows = (recons ?? []).map((r) => {
    const txn = Array.isArray(r.bank_transactions) ? r.bank_transactions[0] : r.bank_transactions;
    const doc = Array.isArray(r.documents) ? r.documents[0] : r.documents;
    return [
      r.status ?? "",
      txn?.transaction_date ?? "",
      txn?.narration ?? "",
      txn?.ref_number ?? "",
      txn?.debit_amount ?? "",
      txn?.credit_amount ?? "",
      txn?.bank_name ?? "",
      doc?.original_filename ?? "",
      doc?.document_type ?? "",
      r.match_score ?? "",
      Array.isArray(r.match_reasons) ? r.match_reasons.join("; ") : "",
      r.matched_at ? new Date(r.matched_at).toISOString().slice(0, 16).replace("T", " ") : "",
    ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",");
  });

  const csv = [headers.map((h) => `"${h}"`).join(","), ...rows].join("\n");

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": format === "csv" ? "text/csv" : "application/octet-stream",
      "Content-Disposition": `attachment; filename="reconciliation-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
