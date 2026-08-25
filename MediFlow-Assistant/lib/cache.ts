import { Redis } from "@upstash/redis";
import { generateEmbedding } from "@/lib/embeddings";
import { span, setSpanMetadata, textShape } from "@/lib/tracing";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Exported for the eval harness, which sweeps candidate similarity thresholds over a
// labelled set of question pairs. Recomputing cosine there would risk measuring a
// slightly different function than the one the cache actually gates on.
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (normA * normB);
}

function getCacheKeyPrefix(reportHash: string): string {
  return `medic_cache:${reportHash}`;
}

function generateReportHash(reportData?: string): string {
  // With no report uploaded, chats share one namespace instead of crashing on undefined.
  const source = reportData ?? "";
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

interface CacheEntry {
  question: string;
  embedding: number[];
  answer: string;
  timestamp: number;
}

/**
 * Return a cached answer for a semantically similar question, or null.
 *
 * The question is post-redaction and the cached answer is pre-rehydration, but neither
 * is guaranteed identifier-free - the PII rules only catch labelled shapes - so both
 * sides are PHI-gated.
 *
 * `bestSimilarity` is recorded on misses too: without it, a threshold that never fires
 * is indistinguishable from a cache that is simply cold.
 */
export async function getCachedResponse(
  question: string,
  reportData: string,
  similarityThreshold: number = 0.95
): Promise<string | null> {
  return span(
    "semantic_cache_lookup",
    { question, threshold: similarityThreshold },
    async () => {
      try {
        const currentEmbedding = await generateEmbedding(question);
        const reportHash = generateReportHash(reportData);
        const cacheKeyPrefix = getCacheKeyPrefix(reportHash);

        const keys = await redis.keys(`${cacheKeyPrefix}:*`);

        if (keys.length === 0) {
          setSpanMetadata({ cacheHit: false, entriesScanned: 0, reason: "empty-namespace" });
          return null;
        }

        // One round trip for every entry under this report.
        const cachedEntries = await redis.mget<CacheEntry[]>(...keys);

        let bestSimilarity = 0;
        let comparable = 0;
        for (let i = 0; i < keys.length; i++) {
          const cachedData = cachedEntries[i];

          if (!cachedData || !cachedData.embedding) {
            continue;
          }
          comparable++;

          const similarity = cosineSimilarity(
            currentEmbedding,
            cachedData.embedding
          );
          if (similarity > bestSimilarity) bestSimilarity = similarity;

          if (similarity >= similarityThreshold) {
            setSpanMetadata({
              cacheHit: true,
              similarity,
              entriesScanned: keys.length,
              comparableEntries: comparable,
              matchedKey: keys[i],
            });
            return cachedData.answer;
          }
        }

        setSpanMetadata({
          cacheHit: false,
          bestSimilarity,
          entriesScanned: keys.length,
          comparableEntries: comparable,
          reason: "below-threshold",
        });
        return null;
      } catch (error) {
        console.error("Error in getCachedResponse:", error);
        // Swallowed so a Redis outage degrades to a cache miss rather than a failed
        // chat, and recorded so it does not degrade silently forever.
        setSpanMetadata({
          cacheHit: false,
          reason: "error",
          swallowedError: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    {
      runType: "retriever",
      tags: ["cache", "redis"],
      safeInputs: { threshold: similarityThreshold, ...textShape("question", question) },
      safeOutputs: (answer) => ({
        cacheHit: answer !== null,
        ...textShape("answer", answer),
      }),
      recordOutputs: (answer) => ({
        cacheHit: answer !== null,
        answer: answer ?? null,
      }),
    }
  );
}

/** Cache a question/answer pair, storing the embedding for future similarity checks. */
export async function cacheResponse(
  question: string,
  answer: string,
  reportData: string,
  ttlSeconds: number = 86400 // 24 hours default
): Promise<void> {
  await span(
    "semantic_cache_write",
    { question, answer, ttlSeconds },
    async () => {
      try {
        const embedding = await generateEmbedding(question);
        const reportHash = generateReportHash(reportData);
        const questionHash = generateReportHash(question);
        const cacheKey = `${getCacheKeyPrefix(reportHash)}:${questionHash}`;

        const cacheEntry: CacheEntry = {
          question,
          embedding,
          answer,
          timestamp: Date.now(),
        };

        await redis.setex(cacheKey, ttlSeconds, JSON.stringify(cacheEntry));

        setSpanMetadata({ cached: true, cacheKey });
        return { cached: true };
      } catch (error) {
        console.error("Error in cacheResponse:", error);
        // Never thrown: a caching failure must not break the chat.
        setSpanMetadata({
          cached: false,
          swallowedError: error instanceof Error ? error.message : String(error),
        });
        return { cached: false };
      }
    },
    {
      runType: "chain",
      tags: ["cache", "redis", "write"],
      safeInputs: {
        ttlSeconds,
        ...textShape("question", question),
        ...textShape("answer", answer),
      },
    }
  );
}

// Records whether the `conversation-history` Pinecone namespace holds anything for a
// document, so the chat route can skip that retrieval when it could only ever miss. A
// Redis EXISTS is orders of magnitude cheaper than an embedding plus two Pinecone
// queries.
//
// Stored with NO TTL, unlike the vault and the response cache above: the Pinecone memory
// vectors this mirrors are never deleted, so an expiring flag would drift out of sync
// and silently switch memory retrieval off for older reports. If memory pruning is ever
// added, delete this key in the same place.

function getMemoryFlagKey(documentId: string): string {
  return `medic_memory:${documentId}`;
}

export async function hasConversationMemory(documentId: string): Promise<boolean> {
  if (!documentId) return false;

  try {
    return (await redis.exists(getMemoryFlagKey(documentId))) === 1;
  } catch (error) {
    // Fail OPEN. Answering "true" wrongly costs one wasted retrieval; answering
    // "false" wrongly would disable conversation memory for every request during a
    // Redis outage, which shows up only as quietly worse answers.
    console.error("Error checking conversation memory flag:", error);
    return true;
  }
}

export async function markConversationMemory(documentId: string): Promise<void> {
  if (!documentId) return;

  try {
    await redis.set(getMemoryFlagKey(documentId), "1");
  } catch (error) {
    // Best-effort, matching storeVault: a lost flag costs a skipped retrieval on the
    // next turn, not a broken answer.
    console.error("Error setting conversation memory flag:", error);
  }
}

/**
 * The parts of an ingest result that cannot be recomputed cheaply.
 *
 * Deliberately not the document text or the vectors: those already live in Pinecone, chunk
 * by chunk, and copying them here would give the same bytes two homes that can drift. The
 * summary is the one output with nowhere else to live - it comes from a Gemini call with no
 * temperature pinned, so re-uploading the same file produced a differently worded summary
 * every time.
 *
 * That mattered beyond the wasted call: the response cache namespaces on a hash of the
 * summary, so a reworded summary orphaned every answer cached under the previous one. The
 * counters ride along so a duplicate upload can return a byte-identical response.
 */
export interface StoredIngestResult {
  redactedSummary: string;
  piiCount: number;
  triplesStored: number;
  chunkCount: number;
  figuresDescribed: number;
  figuresSkipped: number;
  figuresFailed: boolean;
  vectorStoreFailed: boolean;
  graphStoreFailed: boolean;
}

function getIngestKey(documentId: string): string {
  return `medic_ingest:${documentId}`;
}

/**
 * Same 24h TTL as the vault, and written next to it, so the two expire together. A stored
 * result outliving its vault would hand back a summary that rehydrates to nothing; a vault
 * outliving its result just costs one re-ingest.
 */
export async function storeIngestResult(
  documentId: string,
  result: StoredIngestResult,
  ttlSeconds: number = 86400
): Promise<void> {
  if (!documentId) return;
  try {
    await redis.setex(getIngestKey(documentId), ttlSeconds, JSON.stringify(result));
  } catch (error) {
    // Best-effort: losing this costs a re-ingest next time, never a failed upload.
    console.error("Error storing ingest result:", error);
  }
}

export async function getIngestResult(documentId: string): Promise<StoredIngestResult | null> {
  if (!documentId) return null;
  try {
    // Upstash auto-deserializes stored JSON, so a string and an object both arrive here.
    const raw = await redis.get<StoredIngestResult | string>(getIngestKey(documentId));
    if (!raw) return null;
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as StoredIngestResult) : raw;
    // A blank summary would hand the chat route an empty report, so treat it as absent
    // rather than short-circuiting into a worse result than a re-ingest would give.
    return parsed?.redactedSummary ? parsed : null;
  } catch (error) {
    console.error("Error reading ingest result:", error);
    return null;
  }
}

export async function clearCacheForReport(reportData: string): Promise<void> {
  try {
    const reportHash = generateReportHash(reportData);
    const cacheKeyPrefix = getCacheKeyPrefix(reportHash);
    const keys = await redis.keys(`${cacheKeyPrefix}:*`);

    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (error) {
    console.error("Error clearing cache:", error);
  }
}

export async function getCacheStats(reportData: string) {
  try {
    const reportHash = generateReportHash(reportData);
    const cacheKeyPrefix = getCacheKeyPrefix(reportHash);
    const keys = await redis.keys(`${cacheKeyPrefix}:*`);
    
    return {
      entriesForReport: keys.length,
      reportHash,
    };
  } catch (error) {
    console.error("Error getting cache stats:", error);
    return null;
  }
}
