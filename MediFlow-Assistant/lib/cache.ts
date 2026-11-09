import { createHash } from "crypto";
import { Redis } from "@upstash/redis";
import { judgeCacheMatch, type CacheJudgeVerdict } from "@/lib/cache-judge";
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
 * Similarity bands for gemini-embedding-001 with the SEMANTIC_SIMILARITY task type, from
 * the 44-pair cache eval. At or above AUTO_HIT the answer is reused outright: no
 * near-miss question reached it. Between JUDGE_FLOOR and AUTO_HIT both kinds land - the
 * loosest paraphrase scored 0.948, the closest near-miss 0.985 - so an LLM judge decides
 * (see @/lib/cache-judge). Below JUDGE_FLOOR is a miss without asking.
 *
 * Tied to the embedding model: changing it means re-running `npm run eval:cache`.
 */
export const CACHE_AUTO_HIT_SIMILARITY = 0.99;
export const CACHE_JUDGE_FLOOR = 0.94;

export interface CacheLookup {
  answer: string | null;
  /**
   * The question's embedding, so a verified fresh answer can be cached without embedding
   * the same text a second time. Null when the embedding call itself failed.
   */
  embedding: number[] | null;
  /** Closest cached question's similarity; 0 with nothing to compare against. */
  bestSimilarity: number;
  /** The judge's verdict when the best match was in the grey band, otherwise null. */
  judge: CacheJudgeVerdict | null;
}

/**
 * Return a cached answer for a question asking the same thing, or a null answer.
 *
 * The question is post-redaction and the cached answer is pre-rehydration, but neither
 * is guaranteed identifier-free - the PII rules only catch labelled shapes - so both
 * sides are PHI-gated.
 *
 * Only the CLOSEST entry is considered. Returning the first entry over the threshold, as
 * this used to, could serve a weaker match while a closer one sat later in the set - and
 * with a judge in the loop, would spend the judge call on the wrong candidate.
 *
 * `bestSimilarity` is recorded on misses too: without it, a threshold that never fires
 * is indistinguishable from a cache that is simply cold.
 */
export async function getCachedResponse(question: string, reportData: string): Promise<CacheLookup> {
  return span(
    "semantic_cache_lookup",
    { question, autoHit: CACHE_AUTO_HIT_SIMILARITY, judgeFloor: CACHE_JUDGE_FLOOR },
    async () => {
      let currentEmbedding: number[] | null = null;
      const miss = (bestSimilarity = 0): CacheLookup => ({
        answer: null,
        embedding: currentEmbedding,
        bestSimilarity,
        judge: null,
      });
      try {
        currentEmbedding = await generateEmbedding(question, "SEMANTIC_SIMILARITY");
        const reportHash = generateReportHash(reportData);

        // Entries written before this index existed are unreachable here and expire with
        // their own 24h TTL; the first question after a deploy re-caches under the index.
        const keys = await redis.smembers(getCacheIndexKey(reportHash));

        if (keys.length === 0) {
          setSpanMetadata({ cacheHit: false, entriesScanned: 0, reason: "empty-namespace" });
          return miss();
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

        let best: CacheEntry | null = null;
        let bestKey: string | null = null;
        let bestSimilarity = 0;
        let comparable = 0;
        for (let i = 0; i < keys.length; i++) {
          const cachedData = cachedEntries[i];

          if (!cachedData || !cachedData.embedding) {
            continue;
          }
          comparable++;

          const similarity = cosineSimilarity(currentEmbedding, cachedData.embedding);
          if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            best = cachedData;
            bestKey = keys[i];
          }
        }

        const scan = {
          bestSimilarity,
          entriesScanned: keys.length,
          comparableEntries: comparable,
          // A gap between these two is the index carrying keys whose entries have expired.
          stalePruned: stale.length,
        };

        if (!best || bestSimilarity < CACHE_JUDGE_FLOOR) {
          setSpanMetadata({ cacheHit: false, ...scan, reason: "below-threshold" });
          return miss(bestSimilarity);
        }

        const judge = bestSimilarity >= CACHE_AUTO_HIT_SIMILARITY ? null : await judgeCacheMatch(best.question, question);
        if (judge !== null && judge !== "same") {
          setSpanMetadata({ cacheHit: false, ...scan, reason: `judge-${judge}` });
          return { ...miss(bestSimilarity), judge };
        }

        setSpanMetadata({ cacheHit: true, ...scan, matchedKey: bestKey, judged: judge !== null });
        return { answer: best.answer, embedding: currentEmbedding, bestSimilarity, judge };
      } catch (error) {
        console.error("Error in getCachedResponse:", error);
        // Swallowed so a Redis outage degrades to a cache miss rather than a failed
        // chat, and recorded so it does not degrade silently forever.
        setSpanMetadata({
          cacheHit: false,
          reason: "error",
          swallowedError: error instanceof Error ? error.message : String(error),
        });
        return miss();
      }
    },
    {
      runType: "retriever",
      tags: ["cache", "redis"],
      safeInputs: {
        autoHit: CACHE_AUTO_HIT_SIMILARITY,
        judgeFloor: CACHE_JUDGE_FLOOR,
        ...textShape("question", question),
      },
      safeOutputs: (lookup) => ({
        cacheHit: lookup.answer !== null,
        bestSimilarity: lookup.bestSimilarity,
        judge: lookup.judge,
        ...textShape("answer", lookup.answer),
      }),
      recordOutputs: (lookup) => ({
        cacheHit: lookup.answer !== null,
        bestSimilarity: lookup.bestSimilarity,
        judge: lookup.judge,
        answer: lookup.answer,
      }),
    }
  );
}

/**
 * Cache a question/answer pair, storing the embedding for future similarity checks.
 *
 * Pass the embedding from this question's own lookup when there is one: it is the same
 * text with the same task type, so embedding it again would spend a call of the
 * embedding quota for an identical vector.
 */
export async function cacheResponse(
  question: string,
  answer: string,
  reportData: string,
  questionEmbedding?: number[] | null,
  ttlSeconds: number = 86400 // 24 hours default
): Promise<void> {
  await span(
    "semantic_cache_write",
    { question, answer, ttlSeconds },
    async () => {
      try {
        const embedding = questionEmbedding ?? (await generateEmbedding(question, "SEMANTIC_SIMILARITY"));
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
