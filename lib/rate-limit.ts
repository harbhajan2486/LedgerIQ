// Simple rate limiter: 100 requests per minute per user
// Uses Supabase to track counts — no Redis needed.
// Each user gets a rolling 60-second window.

import { createClient } from "@/lib/supabase/server";

const MAX_REQUESTS = 100;
const WINDOW_SECONDS = 60;

export async function checkRateLimit(userId: string): Promise<{
  allowed: boolean;
  remaining: number;
  resetAt: number; // Unix timestamp seconds
}> {
  const supabase = await createClient();
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - WINDOW_SECONDS;
  const resetAt = now + WINDOW_SECONDS;

  // Count requests in the last 60 seconds for this user
  // We use audit_log as a lightweight request counter — each API call that
  // needs rate limiting calls this function, which increments the count.
  // For real production, swap this for Redis or Upstash.
  const { count } = await supabase
    .from("rate_limit_log")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", new Date(windowStart * 1000).toISOString());

  const currentCount = count ?? 0;
  const remaining = Math.max(0, MAX_REQUESTS - currentCount);

  if (currentCount >= MAX_REQUESTS) {
    return { allowed: false, remaining: 0, resetAt };
  }

  // Record this request
  await supabase.from("rate_limit_log").insert({ user_id: userId });

  // Cleanup old entries (non-blocking)
  void supabase
    .from("rate_limit_log")
    .delete()
    .lt("created_at", new Date((windowStart - WINDOW_SECONDS) * 1000).toISOString())
    .then(() => {});

  return { allowed: true, remaining: remaining - 1, resetAt };
}

export function rateLimitResponse(resetAt: number) {
  return new Response(
    JSON.stringify({ error: "Too many requests. Please slow down.", retry_after: resetAt }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(resetAt - Math.floor(Date.now() / 1000)),
        "X-RateLimit-Limit": String(100),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(resetAt),
      },
    }
  );
}
