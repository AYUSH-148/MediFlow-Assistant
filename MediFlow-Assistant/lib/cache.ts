import { Redis } from "@upstash/redis";
import { InferenceClient } from "@huggingface/inference";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const hf = new InferenceClient(process.env.HF_TOKEN);

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
 * Generate embedding for a given text using HuggingFace
 */
async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const embedding = await hf.featureExtraction({
      model: "mixedbread-ai/mxbai-embed-large-v1",
      inputs: text,
    });
    return Array.from(embedding as any);
  } catch (error) {
    console.error("Error generating embedding:", error);
    throw error;
  }
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
function generateReportHash(reportData: string): string {
  let hash = 0;
  for (let i = 0; i < reportData.length; i++) {
    const char = reportData.charCodeAt(i);
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

    // Check each cached entry for similarity
    for (const key of keys) {
      try {
        const cachedData = await redis.get<CacheEntry>(key);
        
        if (!cachedData || !cachedData.embedding) {
          continue;
        }

        const similarity = cosineSimilarity(
          currentEmbedding,
          cachedData.embedding
        );

        if (similarity >= similarityThreshold) {
          console.log(
            `Cache HIT! Similarity: ${similarity.toFixed(4)}, Key: ${key}`
          );
          return cachedData.answer;
        }
      } catch (error) {
        console.error(`Error checking cache entry ${key}:`, error);
        continue;
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
