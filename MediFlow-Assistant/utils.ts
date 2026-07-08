import { createHash } from "crypto";
import { Pinecone } from "@pinecone-database/pinecone";
// import { FeatureExtractionPipeline, pipeline } from "@xenova/transformers";
// import { modelname, namespace, topK } from "./app/config";
import { InferenceClient } from '@huggingface/inference';

const hf = new InferenceClient(process.env.HF_TOKEN)

// Centralized Pinecone client
export const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY ?? "",
});

export async function generateEmbedding(text: string): Promise<number[]> {
  const apiOutput = await hf.featureExtraction({
    model: "mixedbread-ai/mxbai-embed-large-v1",
    inputs: text,
  });
  return Array.from(apiOutput as any);
}

export async function upsertVectors(
  client: Pinecone,
  indexName: string,
  vectors: { id: string; values: number[]; metadata?: Record<string, any> }[],
  namespace?: string
) {
  const index = client.Index(indexName) as any;
  await index.upsert({ vectors, namespace });
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
  } catch (error) {
    console.error("Failed to upsert conversation memory:", error);
  }
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
  maxDocuments: number = 500
): Promise<Array<{ id: string; text: string }>> {
  const index = client.Index(indexName) as any;
  const namespaceIndex = index.namespace(namespace);
  const documents: Array<{ id: string; text: string }> = [];
  let paginationToken: string | undefined;

  while (documents.length < maxDocuments) {
    const response = await namespaceIndex.listPaginated({
      limit: 100,
      paginationToken,
    });
    const ids = (response.vectors ?? []).map((item: any) => String(item.id ?? "")).filter(Boolean);

    if (ids.length === 0) {
      break;
    }

    const fetched = await namespaceIndex.fetch(ids as any);
    for (const id of ids) {
      const record = fetched.records?.[id];
      const text = String(record?.metadata?.chunk ?? "");
      if (text.trim()) {
        documents.push({ id, text });
      }
    }

    if (!response.pagination?.next) {
      break;
    }
    paginationToken = response.pagination.next;
  }

  return documents;
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

export async function queryPineconeVectorStore(
  client: Pinecone,
  indexName: string,
  namespace: string,
  query: string,
  filter?: Record<string, any>
): Promise<string> {
  const apiOutput = await hf.featureExtraction({
    model: "mixedbread-ai/mxbai-embed-large-v1",
    inputs: query,
  });

  const queryEmbedding = Array.from(apiOutput as any);
  const index = client.Index(indexName);
  const queryResponse = await index.namespace(namespace).query({
    topK: 12,
    vector: queryEmbedding as any,
    includeMetadata: true,
    includeValues: false,
    filter,
  });

  const vectorMatches = (queryResponse.matches ?? []) as Array<any>;
  const vectorResults = vectorMatches
    .map((match, index) => ({
      id: String(match.id ?? `doc-${index}`),
      text: String(match.metadata?.chunk ?? ""),
      rank: index + 1,
    }))
    .filter((match) => match.text.trim().length > 0);

  const keywordCorpus = await getKeywordCorpus(client, indexName, namespace);
  const keywordResults = rankWithTfIdf(query, keywordCorpus);
  const fusedResults = fuseResultsWithRrf(vectorResults, keywordResults, 10);

  if (fusedResults.length === 0) {
    return "<nomatches>";
  }

  const concatenatedRetrievals = fusedResults
    .map((result, index) => `\nClinical Finding ${index + 1}: \n ${result.text}`)
    .join(". \n\n");

  return concatenatedRetrievals || "<nomatches>";
}
