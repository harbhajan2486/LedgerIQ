import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseCSV, parseXLSX } from "@/lib/bank-statement-parser";

/** Debug endpoint — parses a bank statement file and returns the first 20 rows as JSON.
 *  Does NOT write anything to the database. Used to diagnose parsing issues.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });

  const fileName = file.name.toLowerCase();
  let rows;

  try {
    if (fileName.endsWith(".csv")) {
      const text = await file.text();
      // Also return the raw first 10 lines so we can see what the CSV actually contains
      const rawLines = text.replace(/\r\n/g, "\n").split("\n").slice(0, 10);
      rows = parseCSV(text);
      return NextResponse.json({ raw_lines: rawLines, parsed: rows.slice(0, 20) });
    } else if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
      const buffer = await file.arrayBuffer();
      rows = parseXLSX(buffer);
      return NextResponse.json({ parsed: rows.slice(0, 20) });
    } else {
      return NextResponse.json({ error: "Only CSV and XLSX supported for preview" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
