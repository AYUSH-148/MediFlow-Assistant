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

export async function queryPineconeVectorStore(
  client: Pinecone,
  indexName: string,
  namespace: string,
  query: string
): Promise<string> {
  const apiOutput = await hf.featureExtraction({
    model: "mixedbread-ai/mxbai-embed-large-v1",
    inputs: query,
  });
  console.log(apiOutput);
  
  const queryEmbedding = Array.from(apiOutput);
  // console.log("Querying database vector store...");
  const index = client.Index(indexName);
  const queryResponse = await index.namespace(namespace).query({
    topK: 5,
    vector: queryEmbedding as any,
    includeMetadata: true,
    // includeValues: true,
    includeValues: false
  });

  console.log(queryResponse);
  

  if (queryResponse.matches.length > 0) {
    const concatenatedRetrievals = queryResponse.matches
      .map((match,index) =>`\nClinical Finding ${index+1}: \n ${match.metadata?.chunk}`)
      .join(". \n\n");
    return concatenatedRetrievals;
  } else {
    return "<nomatches>";
  }
  return "";
}
