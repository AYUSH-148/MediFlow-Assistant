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
export function generateDocumentId(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// The second group is the wording of a question rather than of a report. A report rarely
// says "how" or "there", so idf rated them as rare, informative terms: "How big are my
// fibroids?" ranked a chunk matching only "how" above the one saying "fibroids", and BM25's
// length normalisation then favoured it further whenever that chunk was short.
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

  "am",
  "any",
  "can",
  "could",
  "did",
  "do",
  "does",
  "how",
  "i",
  "many",
  "me",
  "much",
  "my",
  "our",
  "should",
  "there",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "would",
  "you",
  "your",
]);

function tokenizeText(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => !STOP_WORDS.has(token));
}

// How many chunks the vector arm contributes to RRF.
const VECTOR_TOP_K = 12;

/**
 * The one Pinecone query behind both arms of the hybrid search.
 *
 * There used to be two queries per turn with the same vector and filter: topK 12 for the
 * vector arm, then topK 500 for the keyword corpus. Pinecone returns matches in
 * similarity order, so the first 12 of the 500 are exactly the topK 12 result, and the
 * second round trip bought nothing. The vector arm now takes its prefix of this
 * response, which is why the corpus keeps Pinecone's order and score.
 */
async function getFilteredCorpus(
  client: Pinecone,
  indexName: string,
  namespace: string,
  queryEmbedding: number[],
  filter?: Record<string, any>,
  maxDocuments: number = 500
): Promise<Array<{ id: string; text: string; score?: number }>> {
  return span(
    "pinecone_query",
    { namespace, topK: maxDocuments, filter: filter ?? null },
    async () => {
      const index = client.Index(indexName) as any;
      const namespaceIndex = index.namespace(namespace);

      // The filter (e.g. documentId scoping) keeps both arms inside one report, so RRF
      // cannot blend another document's chunks into the context. Pinecone's list API has
      // no metadata filter, so a filtered query() with a large topK stands in for
      // "everything under this filter" - for any report under 500 chunks the keyword
      // arm therefore sees every chunk, whatever the vector.
      const response = await namespaceIndex.query({
        topK: maxDocuments,
        vector: queryEmbedding,
        includeMetadata: true,
        includeValues: false,
        filter,
      });

      const rawMatches = (response.matches ?? []) as Array<any>;
      const corpus = rawMatches
        .map((match) => ({
          id: String(match.id ?? ""),
          text: String(match.metadata?.chunk ?? ""),
          score: typeof match.score === "number" ? match.score : undefined,
        }))
        .filter((doc) => doc.id && doc.text.trim().length > 0);

      setSpanMetadata({
        matchesReturned: rawMatches.length,
        corpusSize: corpus.length,
        // A gap here means chunks were stored without usable `chunk` metadata.
        droppedEmptyChunks: rawMatches.length - corpus.length,
        topScore: corpus[0]?.score,
      });

      return corpus;
    },
    {
      runType: "retriever",
      tags: ["pinecone", "vector", "keyword"],
      // Up to 500 chunks of report text would dominate the trace payload, so only the
      // vector arm's prefix is listed, by id and score.
      recordOutputs: (corpus) => ({
        corpusSize: corpus.length,
        vectorMatches: corpus
          .slice(0, VECTOR_TOP_K)
          .map(({ id, score }, index) => ({ id, rank: index + 1, score })),
      }),
    }
  );
}

// Okapi BM25 at its textbook defaults. k1 caps how much repeating a term can add - a
// chunk that says "cholesterol" six times scores about 1.8x one that says it once, not
// 6x as raw TF-IDF did, so a chunk that merely repeats a word can no longer outrank the
// one with the answer. b scales term frequency by chunk length relative to the average,
// so a long chunk stops winning on the sheer number of words it contains.
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function rankWithBm25(query: string, documents: { id: string; text: string }[]) {
  const queryTokens = tokenizeText(query);
  const uniqueQueryTerms = Array.from(new Set(queryTokens));

  if (uniqueQueryTerms.length === 0 || documents.length === 0) {
    return [] as Array<{ id: string; text: string; score: number; rank: number }>;
  }

  const documentTokens = documents.map((doc) => tokenizeText(doc.text));
  const averageLength =
    documentTokens.reduce((total, tokens) => total + tokens.length, 0) / documents.length;
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

      // NaN for an empty chunk in an all-empty corpus, but such a chunk matches no term,
      // so it is never read; whenever a term matched, averageLength is non-zero.
      const lengthNorm = 1 - BM25_B + (BM25_B * tokens.length) / averageLength;

      let score = 0;
      uniqueQueryTerms.forEach((term) => {
        const termFrequency = termCounts.get(term) ?? 0;
        if (termFrequency === 0) return;

        const df = documentFrequency.get(term) ?? 0;
        // The "+1" form of BM25 idf stays positive even for a term in every chunk, so a
        // common word can only add a little, never subtract.
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        score += (idf * termFrequency * (BM25_K1 + 1)) / (termFrequency + BM25_K1 * lengthNorm);
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
 * Hybrid retrieval: dense vector search and BM25 keyword search over the same
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
  filter?: Record<string, any>,
  /**
   * Extra words for the keyword arm only - the query guard's `searchTerms`, aliases of
   * the question's clinical terms ("SGPT" -> "ALT alanine aminotransferase"). The
   * tokenizer has no notion of synonyms, so without these a question naming a test by
   * one name scores zero against a report that uses the other. Kept out of the
   * embedding: a wrong alias then misleads only the keyword arm, and the vector arm
   * still ranks on what the user actually asked.
   */
  keywordTerms: string = ""
): Promise<HybridRetrieval> {
  return span(
    "hybrid_retrieve",
    { query, keywordTerms, namespace, index: indexName, filter: filter ?? null },
    async () => {
      // One embedding and one Pinecone query serve both halves of the hybrid search.
      const queryEmbedding = await generateEmbedding(query, "RETRIEVAL_QUERY");

      const corpus = await getFilteredCorpus(client, indexName, namespace, queryEmbedding, filter);

      // The vector arm is the corpus's similarity-ordered prefix. Empty chunks are already
      // gone, so this is VECTOR_TOP_K usable chunks where the old separate query could
      // come back with fewer after dropping them.
      const vectorResults = corpus
        .slice(0, VECTOR_TOP_K)
        .map((doc, index) => ({ ...doc, rank: index + 1 }));

      const keywordQuery = keywordTerms.trim() ? `${query} ${keywordTerms}` : query;

      // Synchronous, but real CPU work over the whole corpus - worth its own timing so a
      // slow retrieval can be blamed on the right half.
      const keywordResults = await span(
        "bm25_rank",
        { query: keywordQuery, corpusSize: corpus.length },
        async () => {
          const ranked = rankWithBm25(keywordQuery, corpus);
          setSpanMetadata({ matched: ranked.length, topScore: ranked[0]?.score });
          return ranked;
        },
        {
          runType: "parser",
          tags: ["keyword"],
          safeInputs: { corpusSize: corpus.length, ...textShape("query", keywordQuery) },
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
        ...textShape("keywordTerms", keywordTerms),
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
