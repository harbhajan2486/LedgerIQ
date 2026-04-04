/**
 * Shared helper for integration tests.
 * Skips the test suite if Supabase env vars are not configured locally.
 */
export function requireSupabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  if (
    url.includes("your-project") ||
    !url.startsWith("https://") ||
    serviceKey.length < 10 ||
    anonKey.length < 10
  ) {
    return false;
  }
  return true;
}

/**
 * Call this at the top of each integration test file's beforeAll.
 * Skips all tests in the suite if env is not configured.
 */
export function skipIfNotConfigured() {
  if (!requireSupabaseEnv()) {
    console.warn(
      "\n⚠️  Integration tests skipped — Supabase env vars not set in .env.local\n" +
      "   To run: fill in NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,\n" +
      "   and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local, then run:\n" +
      "   npm run test:integration\n"
    );
    return true;
  }
  return false;
}
