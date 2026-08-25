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
 * A set holding the entry keys for one report.
 *
 * Lookups used to enumerate entries with `redis.keys(prefix:*)`. That reads as one call and
 * is not: KEYS walks the ENTIRE keyspace - every report, every vault, every flag, for every
 * user - and filters by prefix afterwards, blocking the server while it does. It is O(total
 * keys), not O(entries for this report), so its cost grows with traffic that has nothing to
 * do with the request making it. Both Redis and Upstash warn against it in production.
 *
 * SMEMBERS on this set is O(N) in this report's own entries, which is the quantity the
 * lookup actually needs. The similarity scan that follows is also O(N) and was never the
 * problem: measured on 1024-dim vectors it is under 2ms even at 1000 entries, against the
 * ~100-300ms embedding call every lookup makes first.
 */
function getCacheIndexKey(reportHash: string): string {
  return `medic_cache_idx:${reportHash}`;
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

        // Entries written before this index existed are unreachable here and expire with
        // their own 24h TTL; the first question after a deploy re-caches under the index.
        const keys = await redis.smembers(getCacheIndexKey(reportHash));

        if (keys.length === 0) {
          setSpanMetadata({ cacheHit: false, entriesScanned: 0, reason: "empty-namespace" });
          return null;
        }

        // One round trip for every entry under this report.
        const cachedEntries = await redis.mget<CacheEntry[]>(...keys);

        // Entries expire on their own TTL but set members do not, so the index accumulates
        // keys pointing at nothing. mget already returns null for those, making them
        // harmless - but left alone the set grows without bound, so they are dropped as
        // they are noticed. Fire-and-forget: a failed prune costs a few wasted reads next
        // time, and must not turn a usable cache lookup into an error.
        const stale = keys.filter((_, i) => !cachedEntries[i]);
        if (stale.length > 0) {
          void redis
            .srem(getCacheIndexKey(reportHash), ...stale)
            .catch((error) => console.error("Error pruning cache index:", error));
        }

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
          // A gap between these two is the index carrying keys whose entries have expired.
          stalePruned: stale.length,
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

        // The index has to outlive every entry it points at, so its expiry is pushed out on
        // each write rather than set once. An index that expired first would look like an
        // empty namespace and silently strand entries that are still perfectly valid.
        const indexKey = getCacheIndexKey(reportHash);
        await redis.sadd(indexKey, cacheKey);
        await redis.expire(indexKey, ttlSeconds);

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
    const indexKey = getCacheIndexKey(reportHash);
    const keys = await redis.smembers(indexKey);

    if (keys.length > 0) {
      await redis.del(...keys);
    }
    // Dropped last: losing the index while entries survive would leave them unreachable
    // AND undeletable, since the index is now the only record of what they are.
    await redis.del(indexKey);
  } catch (error) {
    console.error("Error clearing cache:", error);
  }
}

export async function getCacheStats(reportData: string) {
  try {
    const reportHash = generateReportHash(reportData);
    const keys = await redis.smembers(getCacheIndexKey(reportHash));

    return {
      entriesForReport: keys.length,
      reportHash,
    };
  } catch (error) {
    console.error("Error getting cache stats:", error);
    return null;
  }
}
