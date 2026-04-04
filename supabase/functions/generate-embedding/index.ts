// Supabase Edge Function: generate-embedding
// Generates a 384-dimensional vector embedding using Supabase's built-in
// Transformers.js (model: Xenova/all-MiniLM-L6-v2)
// This is FREE — no OpenAI or external API needed.
//
// Used by:
//   - process-correction: to embed each correction for few-shot retrieval
//   - extract-document: to retrieve similar past corrections before extraction

// @ts-ignore — Supabase Edge Runtime provides this
import { pipeline } from "https://esm.sh/@xenova/transformers@2.17.2";

let embedder: ReturnType<typeof pipeline> | null = null;

async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  return embedder;
}

Deno.serve(async (req) => {
  try {
    const { text } = await req.json();
    if (!text) {
      return new Response(JSON.stringify({ error: "text is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const embed = await getEmbedder();
    const output = await embed(text, { pooling: "mean", normalize: true });

    // Convert to plain array
    const embedding: number[] = Array.from(output.data as Float32Array);

    return new Response(
      JSON.stringify({ embedding }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[generate-embedding] error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to generate embedding" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
