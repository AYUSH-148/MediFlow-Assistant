import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { Pinecone } from "@pinecone-database/pinecone";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Upsert vectors into Pinecone
 */
export async function upsertVectors(client: Pinecone, indexName: string, vectors: { id: string; values: number[]; metadata?: Record<string, any> }[]) {
  const index = client.index(indexName);
  await index.upsert(vectors);
}

/**
 * Query Pinecone for similar vectors
 */
export async function queryVectors(client: Pinecone, indexName: string, queryVector: number[], topK: number = 10) {
  const index = client.index(indexName);
  const result = await index.query({
    vector: queryVector,
    topK,
  });
  return result.matches;
}
