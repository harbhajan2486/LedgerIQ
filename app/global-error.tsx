"use client";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  return (
    <html>
      <body style={{ fontFamily: "monospace", padding: "2rem", background: "#fff1f2" }}>
        <h2 style={{ color: "#dc2626" }}>Error (debug)</h2>
        <p><strong>Message:</strong> {error.message || "(empty)"}</p>
        <p><strong>Digest:</strong> {error.digest || "(none)"}</p>
        <pre style={{ background: "#fee2e2", padding: "1rem", borderRadius: "4px", fontSize: "12px", overflow: "auto" }}>
          {error.stack || "(no stack)"}
        </pre>
      </body>
    </html>
  );
}
