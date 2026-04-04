import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createClient as createServiceClient } from "@supabase/supabase-js";

// Stripe sends raw body — must disable body parsing
export const dynamic = "force-dynamic";

const sb = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const sig = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return NextResponse.json({ error: "Missing signature or webhook secret" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const rawBody = await request.text();
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const tenantId = (event.data.object as { metadata?: Record<string, string> }).metadata?.tenant_id;

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "subscription" && tenantId) {
        await sb.from("tenants").update({
          subscription_plan: session.metadata?.plan ?? "starter",
          subscription_status: "active",
          stripe_subscription_id: session.subscription as string,
        }).eq("id", tenantId);
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const tenantIdFromSub = sub.metadata?.tenant_id;
      if (tenantIdFromSub) {
        await sb.from("tenants").update({
          subscription_status: sub.status,
          subscription_period_end: new Date(((sub as unknown as Record<string, number>).current_period_end ?? 0) * 1000).toISOString(),
        }).eq("id", tenantIdFromSub);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const tenantIdFromSub = sub.metadata?.tenant_id;
      if (tenantIdFromSub) {
        await sb.from("tenants").update({
          subscription_status: "canceled",
          subscription_plan: "free",
        }).eq("id", tenantIdFromSub);

        // Send cancellation notification to super admin
        await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/send-notification`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            type: "new_signup", // reuse for cancellation notification
            tenantId: tenantIdFromSub,
            data: { event: "subscription_cancelled" },
          }),
        }).catch(() => {});
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as unknown as Record<string, unknown>;
      const subMeta = (invoice.subscription as Stripe.Subscription)?.metadata;
      const tidFromInvoice = (subMeta?.tenant_id as string | undefined) ?? tenantId;
      if (tidFromInvoice) {
        await sb.from("tenants").update({ subscription_status: "past_due" }).eq("id", tidFromInvoice);
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}
