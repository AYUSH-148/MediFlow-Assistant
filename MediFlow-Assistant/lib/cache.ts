import { Redis } from "@upstash/redis";
import { generateEmbedding } from "@/lib/embeddings";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
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

/**
 * Create a cache key from report data and question
 */
function getCacheKeyPrefix(reportHash: string): string {
  return `medic_cache:${reportHash}`;
}

/**
 * Generate a hash for the report data (simple hash)
 */
function generateReportHash(reportData?: string): string {
  // No report uploaded → chats share one namespace instead of crashing on undefined.
  const source = reportData ?? "";
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
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
 * Try to find a cached response for a similar question
 * Returns the cached answer if found with similarity > threshold, null otherwise
 */
export async function getCachedResponse(
  question: string,
  reportData: string,
  similarityThreshold: number = 0.95
): Promise<string | null> {
  try {
    // Generate embedding for the current question
    const currentEmbedding = await generateEmbedding(question);
    
    // Get cache key prefix based on report
    const reportHash = generateReportHash(reportData);
    const cacheKeyPrefix = getCacheKeyPrefix(reportHash);
    
    // Get all cached entries for this report
    const keys = await redis.keys(`${cacheKeyPrefix}:*`);
    
    if (keys.length === 0) {
      return null;
    }

    // Fetch all cached entries for this report in a single round trip
    const cachedEntries = await redis.mget<CacheEntry[]>(...keys);

    // Check each cached entry for similarity
    for (let i = 0; i < keys.length; i++) {
      const cachedData = cachedEntries[i];

      if (!cachedData || !cachedData.embedding) {
        continue;
      }

      const similarity = cosineSimilarity(
        currentEmbedding,
        cachedData.embedding
      );

      if (similarity >= similarityThreshold) {
        console.log(
          `Cache HIT! Similarity: ${similarity.toFixed(4)}, Key: ${keys[i]}`
        );
        return cachedData.answer;
      }
    }

    return null;
  } catch (error) {
    console.error("Error in getCachedResponse:", error);
    return null;
  }
}

/**
 * Cache a question-answer pair
 * Stores the embedding for future similarity checks
 */
export async function cacheResponse(
  question: string,
  answer: string,
  reportData: string,
  ttlSeconds: number = 86400 // 24 hours default
): Promise<void> {
  try {
    // Generate embedding for the question
    const embedding = await generateEmbedding(question);

    // Get cache key based on report and question hash
    const reportHash = generateReportHash(reportData);
    const questionHash = generateReportHash(question);
    const cacheKey = `${getCacheKeyPrefix(reportHash)}:${questionHash}`;

    // Prepare cache entry
    const cacheEntry: CacheEntry = {
      question,
      embedding,
      answer,
      timestamp: Date.now(),
    };

    // Store in Redis with TTL
    await redis.setex(cacheKey, ttlSeconds, JSON.stringify(cacheEntry));
    
    console.log(`Cached response with key: ${cacheKey}`);
  } catch (error) {
    console.error("Error in cacheResponse:", error);
    // Don't throw - caching errors shouldn't break the main flow
  }
}

// ==================== CONVERSATION MEMORY FLAG ====================
//
// Records whether the `conversation-history` Pinecone namespace holds anything for a
// document, so the chat route can decide if that hybrid retrieval is worth running.
// Without this the search ran unconditionally, and on the first turn of a freshly
// ingested report it cost one HuggingFace embedding plus a topK 12 query and a topK 500
// corpus pull to return "<nomatches>" - the namespace is only written to AFTER an answer.
//
// A Redis EXISTS is orders of magnitude cheaper than that, which is the whole point.
//
// Deliberately stored with NO TTL, unlike the vault and the response cache above. The
// Pinecone memory vectors this mirrors are never deleted, so an expiring flag would
// drift out of sync with them and silently switch memory retrieval off for older
// reports - a degradation with no visible symptom. If memory pruning is ever added,
// delete this key in the same place.

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
    // Best-effort: a lost flag costs a skipped retrieval on the next turn, not a
    // broken answer.
    console.error("Error setting conversation memory flag:", error);
  }
}

/**
 * Clear cache for a specific report
 */
export async function clearCacheForReport(reportData: string): Promise<void> {
  try {
    const reportHash = generateReportHash(reportData);
    const cacheKeyPrefix = getCacheKeyPrefix(reportHash);
    const keys = await redis.keys(`${cacheKeyPrefix}:*`);

    if (keys.length > 0) {
      await redis.del(...keys);
      console.log(`Cleared ${keys.length} cache entries for report`);
    }
  } catch (error) {
    console.error("Error clearing cache:", error);
  }
}

/**
 * Get cache stats for monitoring
 */
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
