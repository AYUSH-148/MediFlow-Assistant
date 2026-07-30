import { InferenceClient } from "@huggingface/inference";

// Single source of truth for the embedding model.
//
// The id used to be written out at three call sites behind two separate
// InferenceClient instances. That is worse than ordinary duplication: ingest and
// query must embed with the SAME model or the vectors live in different spaces, and
// a mismatch produces meaningless similarity scores rather than an error. Keeping
// one constant makes that impossible to get wrong.
//
// Note the ingest route's chunk sizing is tuned to this model's 512-token limit, so
// swapping models means revisiting CHUNK_SIZE there as well.
export const EMBEDDING_MODEL_ID = "mixedbread-ai/mxbai-embed-large-v1";

const hf = new InferenceClient(process.env.HF_TOKEN);

// The HF inference API is the slowest dependency in ingest, so chunks are embedded
// in overlapping batches rather than one at a time - but bounded, to avoid opening
// an unbounded number of concurrent requests on a large report.
const EMBED_BATCH_SIZE = 8;

export async function generateEmbedding(text: string): Promise<number[]> {
  const apiOutput = await hf.featureExtraction({
    model: EMBEDDING_MODEL_ID,
    inputs: text,
  });
  return Array.from(apiOutput as any);
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const batchEmbeddings = await Promise.all(batch.map((text) => generateEmbedding(text)));
    embeddings.push(...batchEmbeddings);
  }
  return embeddings;
}
