// Supabase Edge Function: generate-embedding
// Generates a 384-dimensional vector embedding using HuggingFace Transformers v3
// (WASM backend — works natively in Deno/Edge Runtime, no Node.js needed)
// Model: Xenova/all-MiniLM-L6-v2 (free, runs on-device, no API key required)

// @ts-ignore
import { pipeline, env } from "https://esm.sh/@huggingface/transformers@3.3.3";

// Force WASM backend — required for Deno/Edge Runtime
// @ts-ignore
env.backends.onnx.wasm.numThreads = 1;
// @ts-ignore
env.allowLocalModels = false;

let embedder: Awaited<ReturnType<typeof pipeline>> | null = null;

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
