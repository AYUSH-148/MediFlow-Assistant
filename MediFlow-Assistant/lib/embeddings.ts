import { InferenceClient } from "@huggingface/inference";
import { span, setSpanMetadata, textShape } from "@/lib/tracing";

// Single source of truth for the embedding model. Ingest and query must embed with the
// SAME model or the vectors live in different spaces, and a mismatch produces
// meaningless similarity scores rather than an error.
//
// The ingest route's chunk sizing is tuned to this model's 512-token limit, so swapping
// models means revisiting CHUNK_SIZE there too.
export const EMBEDDING_MODEL_ID = "mixedbread-ai/mxbai-embed-large-v1";

// mxbai-embed-large-v1 is asymmetric: retrieval queries are embedded with an instruction
// prefix, documents without one. Dropping it costs real accuracy, so the prefix lives here
// beside the model id rather than at the call sites - the two have to change together.
const RETRIEVAL_QUERY_PREFIX = "Represent this for searching relevant passages: ";

/**
 * The single source of truth for a retrieval query.
 *
 * Only the question goes in. The whole report summary used to be prepended, which cost
 * three things at once:
 *
 *   1. The query vector was dominated by the report, so every chunk of it scored highly on
 *      report-to-report similarity no matter what was asked - which is why cosine
 *      similarity was useless as a relevance signal.
 *   2. `rankWithTfIdf` tokenises this same string, so every word of the summary became a
 *      query term and the sparse arm scored chunks against the report rather than the
 *      question.
 *   3. The summary sat ahead of the question in a string with a 512-token ceiling, so a
 *      long report truncated the question away entirely - silently, and with no error.
 *
 * Prepending it was a way to give a context-free follow-up ("is that bad?") something to
 * match on. The query guard now rewrites such questions to stand alone before retrieval
 * runs, so the context is already in the question and the prepend became redundant.
 *
 * Note that broad meta-questions ("summarise the findings") have little clinical content
 * to match on either way; the full summary is in the generation prompt regardless, which
 * is what actually answers them.
 */
export function buildRetrievalQuery(question: string): string {
  return `${RETRIEVAL_QUERY_PREFIX}${question}`;
}

// mxbai-embed-large-v1 truncates at 512 tokens. Clinical text runs denser than prose
// (numbers, units, abbreviations), so this budget assumes ~3.5 chars per token and leaves
// headroom rather than tracking the tokeniser exactly.
//
// The point is not the cap itself - the model already truncated silently. It is that
// exceeding it is now recorded, so a query that lost its tail is visible instead of
// looking like a retrieval that simply performed badly. Ingest chunks are 1200 chars and
// sit under this untouched.
const MAX_EMBED_CHARS = 1600;

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
      // Truncated here rather than left to the model, so the loss is attributable. The
      // caller's own ordering decides what survives - every builder in this codebase puts
      // the question first for that reason.
      const truncated = input.length > MAX_EMBED_CHARS;
      const embedInput = truncated ? input.slice(0, MAX_EMBED_CHARS) : input;

      const apiOutput = await hf.featureExtraction({
        model: EMBEDDING_MODEL_ID,
        inputs: embedInput,
      });
      const vector: number[] = Array.from(apiOutput as any);
      setSpanMetadata({
        dimensions: vector.length,
        chars: embedInput.length,
        truncated,
        ...(truncated ? { droppedChars: input.length - MAX_EMBED_CHARS } : {}),
      });
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
