import { span, setSpanMetadata, textShape } from "@/lib/tracing";

// Single source of truth for the embedding model. Ingest and query must embed with the
// SAME model or the vectors live in different spaces, and a mismatch produces
// meaningless similarity scores rather than an error.
//
// This was mixedbread-ai/mxbai-embed-large-v1 on the HuggingFace Inference API until the
// account ran out of inference credits, which took ingest, retrieval and the semantic
// cache down at once. Gemini reuses the key the app already needs for generation, so the
// embeddings no longer depend on a second paid account.
//
// Changing the model (or EMBEDDING_DIMENSIONS) invalidates every stored vector: clear the
// Pinecone namespaces, re-run `npm run eval:build`, and re-upload reports. The response
// cache holds vectors too, but expires on its own 24h TTL.
export const EMBEDDING_MODEL_ID = "gemini-embedding-001";

// The Pinecone index `medic` is 1024-dim. gemini-embedding-001 natively returns 3072 and
// is trained (Matryoshka) to be truncated, so asking for 1024 keeps the existing index.
// Truncated vectors are not unit length; everything downstream compares by cosine, which
// does not care.
const EMBEDDING_DIMENSIONS = 1024;

// Gemini is asymmetric through a task type rather than a text prefix, so the caller says
// which side of the comparison the text is on:
//   RETRIEVAL_QUERY      - a question searched against report chunks
//   RETRIEVAL_DOCUMENT   - a report chunk being indexed
//   SEMANTIC_SIMILARITY  - question-to-question comparison (the semantic cache)
export type EmbeddingTaskType = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY";

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
 *   3. The summary sat ahead of the question in a string with a token ceiling, so a long
 *      report truncated the question away entirely - silently, and with no error.
 *
 * Prepending it was a way to give a context-free follow-up ("is that bad?") something to
 * match on. The query guard now rewrites such questions to stand alone before retrieval
 * runs, so the context is already in the question and the prepend became redundant.
 *
 * Note that broad meta-questions ("summarise the findings") have little clinical content
 * to match on either way; the full summary is in the generation prompt regardless, which
 * is what actually answers them.
 *
 * mxbai needed an instruction prefix here. Gemini takes the RETRIEVAL_QUERY task type
 * instead, so the question now goes through unchanged - which also keeps the prefix's
 * words out of the TF-IDF query terms.
 */
export function buildRetrievalQuery(question: string): string {
  return question;
}

// gemini-embedding-001 accepts 2048 tokens. Clinical text runs denser than prose
// (numbers, units, abbreviations), so this budget assumes ~3.5 chars per token and leaves
// headroom rather than tracking the tokeniser exactly.
//
// The point is not the cap itself - the model would truncate silently. It is that
// exceeding it is recorded, so a query that lost its tail is visible instead of looking
// like a retrieval that simply performed badly. Ingest chunks are 1200 chars and sit
// under this untouched.
const MAX_EMBED_CHARS = 6000;

// batchEmbedContents takes at most 100 texts per request.
const EMBED_BATCH_SIZE = 100;

const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL_ID}:batchEmbedContents`;

async function embedBatch(texts: string[], taskType: EmbeddingTaskType): Promise<number[][]> {
  const response = await fetch(EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY ?? "",
    },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${EMBEDDING_MODEL_ID}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: EMBEDDING_DIMENSIONS,
      })),
    }),
  });
  if (!response.ok) {
    // Google's error bodies describe the request failure (quota, key, model), never echo
    // the input text, so they are safe to surface.
    throw new Error(`Gemini embedding failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  const { embeddings } = (await response.json()) as { embeddings: { values: number[] }[] };
  return embeddings.map((embedding) => embedding.values);
}

// Post-redaction text is not the same as identifier-free: the PII rules are
// label-anchored, so a name in ordinary prose survives into the redacted question and
// reaches this call. The text is PHI-gated for that reason; the vector is dropped either
// way, since 1024 floats per span is noise.
export async function generateEmbedding(text: string, taskType: EmbeddingTaskType): Promise<number[]> {
  return span(
    "embed",
    { text, model: EMBEDDING_MODEL_ID, taskType },
    async ({ text: input }) => {
      // Truncated here rather than left to the model, so the loss is attributable. The
      // caller's own ordering decides what survives - every builder in this codebase puts
      // the question first for that reason.
      const truncated = input.length > MAX_EMBED_CHARS;
      const embedInput = truncated ? input.slice(0, MAX_EMBED_CHARS) : input;

      const [vector] = await embedBatch([embedInput], taskType);
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
      tags: ["gemini"],
      safeInputs: { model: EMBEDDING_MODEL_ID, taskType, ...textShape("text", text) },
      recordOutputs: (vector) => ({ dimensions: vector.length }),
    }
  );
}

// Report chunks for indexing. One request per 100 chunks rather than one per chunk, which
// matters on the free tier's per-minute request quota.
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  return span(
    "embed_batch",
    { count: texts.length, model: EMBEDDING_MODEL_ID, batchSize: EMBED_BATCH_SIZE },
    async () => {
      const embeddings: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBED_BATCH_SIZE).map((text) => text.slice(0, MAX_EMBED_CHARS));
        embeddings.push(...(await embedBatch(batch, "RETRIEVAL_DOCUMENT")));
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
      tags: ["gemini"],
      recordOutputs: (embeddings) => ({ count: embeddings.length }),
    }
  );
}
