import { InferenceClient } from "@huggingface/inference";
import { span, setSpanMetadata, textShape } from "@/lib/tracing";

// Single source of truth for the embedding model. Ingest and query must embed with the
// SAME model or the vectors live in different spaces, and a mismatch produces
// meaningless similarity scores rather than an error.
//
// The ingest route's chunk sizing is tuned to this model's 512-token limit, so swapping
// models means revisiting CHUNK_SIZE there too.
export const EMBEDDING_MODEL_ID = "mixedbread-ai/mxbai-embed-large-v1";

const hf = new InferenceClient(process.env.HF_TOKEN);

// The HF inference API is the slowest dependency in ingest, so chunks are embedded in
// batches - bounded, to avoid opening unbounded concurrent requests on a large report.
const EMBED_BATCH_SIZE = 8;

// Post-redaction text is not the same as identifier-free: the PII rules are
// label-anchored, so a name in ordinary prose survives into the redacted question and
// reaches this call. The text is PHI-gated for that reason; the vector is dropped either
// way, since 1024 floats per span is noise.
export async function generateEmbedding(text: string): Promise<number[]> {
  return span(
    "embed",
    { text, model: EMBEDDING_MODEL_ID },
    async ({ text: input }) => {
      const apiOutput = await hf.featureExtraction({
        model: EMBEDDING_MODEL_ID,
        inputs: input,
      });
      const vector: number[] = Array.from(apiOutput as any);
      setSpanMetadata({ dimensions: vector.length, chars: input.length });
      return vector;
    },
    {
      runType: "embedding",
      tags: ["huggingface"],
      safeInputs: { model: EMBEDDING_MODEL_ID, ...textShape("text", text) },
      recordOutputs: (vector) => ({ dimensions: vector.length }),
    }
  );
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  return span(
    "embed_batch",
    { count: texts.length, model: EMBEDDING_MODEL_ID, batchSize: EMBED_BATCH_SIZE },
    async () => {
      const embeddings: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
        const batchEmbeddings = await Promise.all(batch.map((text) => generateEmbedding(text)));
        embeddings.push(...batchEmbeddings);
      }
      setSpanMetadata({
        embedded: embeddings.length,
        batches: Math.ceil(texts.length / EMBED_BATCH_SIZE),
        totalChars: texts.reduce((sum, text) => sum + text.length, 0),
      });
      return embeddings;
    },
    {
      runType: "embedding",
      tags: ["huggingface"],
      recordOutputs: (embeddings) => ({ count: embeddings.length }),
    }
  );
}
