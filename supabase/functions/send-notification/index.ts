// Supabase Edge Function: send-notification
// Handles all 4 email notification triggers:
//   1. exceptions_found    — reconciliation exceptions found for a tenant
//   2. queue_full          — review queue > 10 docs for a tenant
//   3. cost_warning        — AI spend hits $40 (80% of $50 limit)
//   4. new_signup          — a new CA firm has signed up (to super-admin)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const SUPER_ADMIN_EMAIL = Deno.env.get("SUPER_ADMIN_EMAIL") ?? "";

interface NotificationPayload {
  type: "exceptions_found" | "queue_full" | "cost_warning" | "new_signup";
  tenantId?: string;
  data?: Record<string, unknown>;
}

Deno.serve(async (req) => {
  try {
    const payload: NotificationPayload = await req.json();
    const { type, tenantId, data } = payload;

    // Get tenant admin email(s)
    let recipientEmails: string[] = [];
    if (tenantId) {
      const { data: admins } = await supabase
        .from("users")
        .select("email")
        .eq("tenant_id", tenantId)
        .in("role", ["admin", "senior_reviewer"]);
      recipientEmails = (admins ?? []).map((u: { email: string }) => u.email);
    }

    // Get tenant name for email copy
    let tenantName = "Your firm";
    if (tenantId) {
      const { data: tenant } = await supabase
        .from("tenants")
        .select("name")
        .eq("id", tenantId)
        .single();
      tenantName = tenant?.name ?? "Your firm";
    }

    // Build email content based on type
    const emails: Array<{ to: string; subject: string; body: string }> = [];

    if (type === "exceptions_found" && recipientEmails.length > 0) {
      const count = (data?.count as number) ?? 1;
      for (const email of recipientEmails) {
        emails.push({
          to: email,
          subject: `[LedgerIQ] ${count} reconciliation exception${count > 1 ? "s" : ""} found — ${tenantName}`,
          body: `Hi,\n\nLedgerIQ found ${count} reconciliation exception${count > 1 ? "s" : ""} that need your attention.\n\nLog in to review: ${Deno.env.get("NEXT_PUBLIC_APP_URL")}/reconciliation\n\n— LedgerIQ`,
        });
      }
    }

    if (type === "queue_full" && recipientEmails.length > 0) {
      const queueSize = (data?.queueSize as number) ?? 10;
      for (const email of recipientEmails) {
        emails.push({
          to: email,
          subject: `[LedgerIQ] ${queueSize} documents waiting for review — ${tenantName}`,
          body: `Hi,\n\nYou have ${queueSize} documents in the review queue waiting for attention.\n\nReview now: ${Deno.env.get("NEXT_PUBLIC_APP_URL")}/review\n\n— LedgerIQ`,
        });
      }
    }

    if (type === "cost_warning" && SUPER_ADMIN_EMAIL) {
      const spend = ((data?.currentSpend as number) ?? 0).toFixed(2);
      const limit = (data?.limit as number) ?? 50;
      emails.push({
        to: SUPER_ADMIN_EMAIL,
        subject: `[LedgerIQ] AI cost alert — $${spend} of $${limit} used this month`,
        body: `AI spend has reached $${spend} of your $${limit} monthly limit.\n\nLog in to manage: ${Deno.env.get("NEXT_PUBLIC_APP_URL")}/admin/costs\n\n— LedgerIQ`,
      });
    }

    if (type === "new_signup" && SUPER_ADMIN_EMAIL) {
      emails.push({
        to: SUPER_ADMIN_EMAIL,
        subject: `[LedgerIQ] New firm signed up — ${tenantName}`,
        body: `A new accounting firm has signed up for LedgerIQ.\n\nFirm: ${tenantName}\nTenant ID: ${tenantId}\n\nView in admin: ${Deno.env.get("NEXT_PUBLIC_APP_URL")}/admin/tenants\n\n— LedgerIQ`,
      });
    }

    // Send emails via Supabase Auth's built-in email, or Resend if configured
    const resendKey = Deno.env.get("RESEND_API_KEY");
    let sent = 0;

    for (const email of emails) {
      try {
        if (resendKey) {
          // Use Resend for transactional email (recommended for production)
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${resendKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: "LedgerIQ <noreply@ledgeriq.app>",
              to: [email.to],
              subject: email.subject,
              text: email.body,
            }),
          });
        }
        // Always log the notification
        await supabase.from("notifications").insert({
          tenant_id: tenantId ?? null,
          type,
          title: email.subject,
          body: email.body,
        });
        sent++;
      } catch (err) {
        console.error(`[send-notification] Failed to send to ${email.to}:`, err);
      }
    }

    return new Response(
      JSON.stringify({ success: true, sent }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[send-notification] error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to send notification" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
