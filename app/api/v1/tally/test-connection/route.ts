import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { endpoint } = await request.json();

  if (!endpoint) {
    return NextResponse.json({ error: "Endpoint is required" }, { status: 400 });
  }

  // Validate it's a safe internal URL (SSRF protection — only localhost and RFC1918 ranges allowed)
  const allowedPatterns = [
    /^http:\/\/localhost(:\d+)?(\/.*)?$/,
    /^http:\/\/127\.0\.0\.1(:\d+)?(\/.*)?$/,
    /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?(\/.*)?$/,
    /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?(\/.*)?$/,
    /^http:\/\/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(:\d+)?(\/.*)?$/,
  ];

  const isAllowed = allowedPatterns.some((p) => p.test(endpoint));
  if (!isAllowed) {
    return NextResponse.json(
      { error: "Only local/LAN Tally endpoints are supported in v1." },
      { status: 400 }
    );
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Companies</REPORTNAME></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.ok) {
      return NextResponse.json({ success: true, message: "Tally is connected." });
    }
    return NextResponse.json({ error: "Tally responded but returned an error." }, { status: 502 });
  } catch (err: unknown) {
    const message = err instanceof Error && err.name === "AbortError"
      ? "Tally did not respond within 5 seconds. Make sure TallyPrime is open."
      : "Could not reach Tally. Make sure it is open and the endpoint is correct.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
