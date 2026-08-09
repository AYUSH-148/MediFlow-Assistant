import { createHash } from "crypto";
import { Pinecone } from "@pinecone-database/pinecone";
import { generateEmbedding } from "@/lib/embeddings";
import { span, setSpanMetadata, textShape } from "@/lib/tracing";

export const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY ?? "",
});

export async function upsertVectors(
  client: Pinecone,
  indexName: string,
  vectors: { id: string; values: number[]; metadata?: Record<string, any> }[],
  namespace?: string
) {
  return span(
    "pinecone_upsert",
    { index: indexName, namespace: namespace ?? "(default)", vectorCount: vectors.length },
    async () => {
      const index = client.Index(indexName) as any;
      const target = namespace ? index.namespace(namespace) : index;
      await target.upsert(vectors);
      return { upserted: vectors.length };
    },
    { runType: "chain", tags: ["pinecone", "write"] }
  );
}

export async function upsertConversationMemory(
  client: Pinecone,
  indexName: string,
  {
    id,
    documentId,
    text,
  }: {
    id: string;
    documentId: string;
    text: string;
  }
) {
  // Failures are swallowed so chat keeps working when a memory write fails, and the
  // span records the outcome so a persistently broken write does not stay invisible.
  // The stored text is post-redaction but PHI-gated anyway - see
  // queryPineconeVectorStore for why that is not the same as identifier-free.
  return span(
    "upsert_conversation_memory",
    { id, documentId, text },
    async () => {
      try {
        const embedding = await generateEmbedding(text);
        await upsertVectors(
          client,
          indexName,
          [
            {
              id,
              values: embedding,
              metadata: {
                documentId,
                chunk: text,
                type: "chat-memory",
                source: "conversation",
              },
            },
          ],
          "conversation-history"
        );
        setSpanMetadata({ stored: true });
        return { stored: true as boolean, error: null as string | null };
      } catch (error) {
        console.error("Failed to upsert conversation memory:", error);
        const message = error instanceof Error ? error.message : String(error);
        setSpanMetadata({ stored: false, swallowedError: message });
        return { stored: false as boolean, error: message };
      }
    },
    {
      runType: "chain",
      tags: ["pinecone", "memory", "write"],
      safeInputs: { id, documentId, ...textShape("text", text) },
    }
  );
}

export function generateDocumentId(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

function tokenizeText(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => !STOP_WORDS.has(token));
}

async function getKeywordCorpus(
  client: Pinecone,
  indexName: string,
  namespace: string,
  queryEmbedding: number[],
  filter?: Record<string, any>,
  maxDocuments: number = 500
): Promise<Array<{ id: string; text: string }>> {
  // The expensive half of the hybrid retrieval - up to `maxDocuments` chunks, against
  // topK 12 for the vector side - so it gets its own span for latency attribution.
  return span(
    "keyword_corpus_fetch",
    { namespace, topK: maxDocuments, filter: filter ?? null },
    async () => {
      const index = client.Index(indexName) as any;
      const namespaceIndex = index.namespace(namespace);

      // Reuses the vector search's filter (e.g. documentId scoping), so the keyword arm
      // cannot pull in another document's chunks for RRF to blend into the context.
      // Pinecone's list API has no metadata filter, so a filtered query() with a large
      // topK stands in for "everything under this filter".
      const response = await namespaceIndex.query({
        topK: maxDocuments,
        vector: queryEmbedding,
        includeMetadata: true,
        includeValues: false,
        filter,
      });

      const rawMatches = (response.matches ?? []) as Array<any>;
      const corpus = rawMatches
        .map((match) => ({ id: String(match.id ?? ""), text: String(match.metadata?.chunk ?? "") }))
        .filter((doc) => doc.id && doc.text.trim().length > 0);

      setSpanMetadata({
        matchesReturned: rawMatches.length,
        corpusSize: corpus.length,
        // A gap here means chunks were stored without usable `chunk` metadata.
        droppedEmptyChunks: rawMatches.length - corpus.length,
      });

      return corpus;
    },
    {
      runType: "retriever",
      tags: ["pinecone", "keyword"],
      // Up to 500 chunks of report text would dominate the trace payload.
      recordOutputs: (corpus) => ({ corpusSize: corpus.length }),
    }
  );
}

function rankWithTfIdf(query: string, documents: { id: string; text: string }[]) {
  const queryTokens = tokenizeText(query);
  const uniqueQueryTerms = Array.from(new Set(queryTokens));

  if (uniqueQueryTerms.length === 0 || documents.length === 0) {
    return [] as Array<{ id: string; text: string; score: number; rank: number }>;
  }

  const documentTokens = documents.map((doc) => tokenizeText(doc.text));
  const documentFrequency = new Map<string, number>();

  uniqueQueryTerms.forEach((term) => {
    const frequency = documentTokens.filter((tokens) => tokens.includes(term)).length;
    if (frequency > 0) {
      documentFrequency.set(term, frequency);
    }
  });

  const scoredDocuments = documents
    .map((doc, index) => {
      const tokens = documentTokens[index];
      const termCounts = new Map<string, number>();

      tokens.forEach((token) => {
        termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
      });

      let score = 0;
      uniqueQueryTerms.forEach((term) => {
        const termFrequency = termCounts.get(term) ?? 0;
        if (termFrequency === 0) return;

        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log((documents.length + 1) / (df + 1)) + 1;
        score += termFrequency * idf;
      });

      return {
        id: doc.id,
        text: doc.text,
        score,
        rank: 0,
      };
    })
    .filter((doc) => doc.score > 0)
    .sort((left, right) => right.score - left.score);

  return scoredDocuments.map((doc, index) => ({
    ...doc,
    rank: index + 1,
  }));
}

function fuseResultsWithRrf(
  vectorResults: Array<{ id: string; text: string; rank: number }>,
  keywordResults: Array<{ id: string; text: string; score: number; rank: number }>,
  topK: number,
  rrfK: number = 60
) {
  const fusedScores = new Map<string, { id: string; text: string; score: number; vectorRank?: number; keywordRank?: number }>();

  vectorResults.forEach((result, index) => {
    const rank = index + 1;
    const candidate = fusedScores.get(result.id) ?? {
      id: result.id,
      text: result.text,
      score: 0,
    };
    candidate.score += 1 / (rrfK + rank);
    candidate.vectorRank = rank;
    fusedScores.set(result.id, candidate);
  });

  keywordResults.forEach((result, index) => {
    const rank = index + 1;
    const candidate = fusedScores.get(result.id) ?? {
      id: result.id,
      text: result.text,
      score: 0,
    };
    candidate.score += 1 / (rrfK + rank);
    candidate.keywordRank = rank;
    fusedScores.set(result.id, candidate);
  });

  return Array.from(fusedScores.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, topK)
    .map((item, index) => ({
      ...item,
      finalRank: index + 1,
    }));
}

/**
 * Hybrid retrieval: dense vector search and TF-IDF keyword search over the same
 * filtered corpus, fused with Reciprocal Rank Fusion.
 *
 * Post-redaction is not the same as identifier-free - the query is built from the user's
 * question, and the label-anchored PII rules do not catch a name written in prose. So
 * the query text and retrieved chunks are PHI-gated, while ids, ranks, scores and counts
 * are always recorded.
 */
export interface RetrievedChunk {
  id: string;
  text: string;
  finalRank: number;
}

export interface HybridRetrieval {
  /** The chunks concatenated and numbered, ready to drop into a prompt. */
  text: string;
  chunks: RetrievedChunk[];
}

/**
 * As `queryPineconeVectorStore`, but also returns the individual chunks.
 *
 * The relevance grader needs to judge and filter chunks one by one, which the flattened
 * string cannot support without re-parsing the "Clinical Finding N:" headings back out.
 */
export async function queryPineconeVectorStoreDetailed(
  client: Pinecone,
  indexName: string,
  namespace: string,
  query: string,
  filter?: Record<string, any>
): Promise<HybridRetrieval> {
  return span(
    "hybrid_retrieve",
    { query, namespace, index: indexName, filter: filter ?? null },
    async () => {
      // One embedding serves both halves of the hybrid search: it is passed into
      // getKeywordCorpus rather than recomputed there.
      const queryEmbedding = await generateEmbedding(query);

      const vectorResults = await span(
        "vector_search",
        { namespace, topK: 12, filter: filter ?? null },
        async () => {
          const index = client.Index(indexName);
          const queryResponse = await index.namespace(namespace).query({
            topK: 12,
            vector: queryEmbedding,
            includeMetadata: true,
            includeValues: false,
            filter,
          });

          const vectorMatches = (queryResponse.matches ?? []) as Array<any>;
          const results = vectorMatches
            .map((match, index) => ({
              id: String(match.id ?? `doc-${index}`),
              text: String(match.metadata?.chunk ?? ""),
              rank: index + 1,
              score: typeof match.score === "number" ? match.score : undefined,
            }))
            .filter((match) => match.text.trim().length > 0);

          setSpanMetadata({
            matchesReturned: vectorMatches.length,
            usableMatches: results.length,
            topScore: results[0]?.score,
          });

          return results;
        },
        {
          runType: "retriever",
          tags: ["pinecone", "vector"],
          // The parent span already reports the chunk text once.
          recordOutputs: (results) => ({
            matches: results.map(({ id, rank, score }) => ({ id, rank, score })),
          }),
        }
      );

      const keywordCorpus = await getKeywordCorpus(
        client,
        indexName,
        namespace,
        queryEmbedding,
        filter
      );

      // Synchronous, but real CPU work over the whole corpus - worth its own timing so a
      // slow retrieval can be blamed on the right half.
      const keywordResults = await span(
        "tfidf_rank",
        { query, corpusSize: keywordCorpus.length },
        async () => {
          const ranked = rankWithTfIdf(query, keywordCorpus);
          setSpanMetadata({ matched: ranked.length, topScore: ranked[0]?.score });
          return ranked;
        },
        {
          runType: "parser",
          tags: ["keyword"],
          safeInputs: { corpusSize: keywordCorpus.length, ...textShape("query", query) },
          recordOutputs: (ranked) => ({
            matched: ranked.length,
            top: ranked.slice(0, 10).map(({ id, score, rank }) => ({ id, score, rank })),
          }),
        }
      );

      const fusedResults = await span(
        "rrf_fuse",
        { vectorCount: vectorResults.length, keywordCount: keywordResults.length, topK: 10 },
        async () => {
          const fused = fuseResultsWithRrf(vectorResults, keywordResults, 10);
          setSpanMetadata({
            fusedCount: fused.length,
            // How much each retrieval arm actually contributed to the final context.
            fromBothArms: fused.filter((r) => r.vectorRank && r.keywordRank).length,
            vectorOnly: fused.filter((r) => r.vectorRank && !r.keywordRank).length,
            keywordOnly: fused.filter((r) => !r.vectorRank && r.keywordRank).length,
          });
          return fused;
        },
        {
          runType: "parser",
          tags: ["rrf"],
          recordOutputs: (fused) => ({
            fused: fused.map(({ id, score, finalRank, vectorRank, keywordRank }) => ({
              id,
              score,
              finalRank,
              vectorRank,
              keywordRank,
            })),
          }),
        }
      );

      if (fusedResults.length === 0) {
        setSpanMetadata({ matched: false });
        return { text: "<nomatches>", chunks: [] };
      }

      const chunks: RetrievedChunk[] = fusedResults.map((result, index) => ({
        id: result.id,
        text: result.text,
        finalRank: index + 1,
      }));

      const concatenatedRetrievals = formatChunks(chunks);

      setSpanMetadata({
        matched: concatenatedRetrievals.length > 0,
        contextChars: concatenatedRetrievals.length,
      });

      return {
        text: concatenatedRetrievals || "<nomatches>",
        chunks: concatenatedRetrievals ? chunks : [],
      };
    },
    {
      runType: "retriever",
      tags: ["pinecone", "hybrid", namespace],
      safeInputs: {
        namespace,
        index: indexName,
        filter: filter ?? null,
        ...textShape("query", query),
      },
      safeOutputs: (retrieval) => ({
        chunkCount: retrieval.chunks.length,
        ...textShape("retrievals", retrieval.text),
      }),
      recordOutputs: (retrieval) => ({ retrievals: retrieval.text }),
    }
  );
}

/**
 * Number and concatenate chunks for a prompt.
 *
 * Exported because the grader can drop chunks, and the surviving ones have to be
 * renumbered contiguously - a prompt listing "Finding 1, Finding 4, Finding 7" invites
 * the model to wonder what it is not being shown.
 */
export function formatChunks(chunks: RetrievedChunk[]): string {
  return chunks
    .map((chunk, index) => `\nClinical Finding ${index + 1}: \n ${chunk.text}`)
    .join(". \n\n");
}

/** Backwards-compatible wrapper: the flattened context string only. */
export async function queryPineconeVectorStore(
  client: Pinecone,
  indexName: string,
  namespace: string,
  query: string,
  filter?: Record<string, any>
): Promise<string> {
  const retrieval = await queryPineconeVectorStoreDetailed(
    client,
    indexName,
    namespace,
    query,
    filter
  );
  return retrieval.text;
}
