// Proxies the document file through our server so the browser
// loads it from our own domain — avoids CSP iframe restrictions.
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

    const { id } = await params;

    const { data: profile } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).single();

    // Verify document belongs to this tenant
    const { data: doc } = await supabase
      .from("documents")
      .select("storage_path, mime_type, original_filename")
      .eq("id", id)
      .eq("tenant_id", profile?.tenant_id)
      .single();

    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Download from Supabase Storage server-side
    const { data: fileData, error } = await supabase.storage
      .from("documents")
      .download(doc.storage_path);

    if (error || !fileData) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const bytes = await fileData.arrayBuffer();

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": doc.mime_type ?? "application/pdf",
        "Content-Disposition": `inline; filename="${doc.original_filename}"`,
        "Cache-Control": "private, max-age=900",
      },
    });
  } catch (err) {
    console.error("[documents/file] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
