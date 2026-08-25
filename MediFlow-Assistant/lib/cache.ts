import { createHash } from "crypto";
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

/**
 * Namespace key for a cache entry.
 *
 * Two things share this function: the report summary, which separates one document's
 * cached answers from another's, and the question, which is the entry's own key. A
 * collision in either mixes answers belonging to different things - one report's answer
 * served under another's namespace, or one question's entry overwritten by another's.
 *
 * It used to be a 32-bit string hash folded through Math.abs(), which halves the space by
 * mapping +n and -n onto the same string. Searching random inputs, a mirror pair turned up
 * after ~19k samples and a true collision after ~119k - far beyond this app's traffic, but
 * the codebase already hashes document identity with SHA-256 and there is no reason for
 * the cache to be the weak link.
 *
 * Truncated to 32 hex characters: 128 bits puts collisions out of reach while keeping keys
 * readable in redis-cli and in a trace. `generateDocumentId` in @/utils is the same
 * algorithm, but importing it here would pull in that module's Pinecone client - and with
 * it a PINECONE_API_KEY requirement - for the sake of one hash.
 */
function generateReportHash(reportData?: string): string {
  // With no report uploaded, chats share one namespace instead of crashing on undefined.
  return createHash("sha256").update(reportData ?? "").digest("hex").slice(0, 32);
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
