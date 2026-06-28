import { queryPineconeVectorStore } from "@/utils";
import { getCachedResponse, cacheResponse } from "@/lib/cache";
import { redactUserQuestion, getVault, rehydrateText } from "@/lib/pii-redaction";
import { Pinecone } from "@pinecone-database/pinecone";
// import { Message, OpenAIStream, StreamData, StreamingTextResponse } from "ai";
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, Message, StreamData, streamText } from "ai";

// Allow streaming responses up to 30 seconds
export const maxDuration = 60;
// export const runtime = 'edge';

const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY ?? "",
});

const google = createGoogleGenerativeAI({
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: process.env.GEMINI_API_KEY
});


const model = google('models/gemini-2.5-flash', {
    safetySettings: [
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ],
});

export async function POST(req: Request, res: Response) {
    const reqBody = await req.json();
    console.log(reqBody);

    const messages: Message[] = reqBody.messages;
    const userQuestion = `${messages[messages.length - 1].content}`;

    const reportData: string = reqBody.data.reportData;
    const vaultId: string = reqBody.data.vaultId; // Get vault ID from request

    // ==================== PII REDACTION ====================
    console.log("🔒 Applying PII redaction to user question...");

    // Redact PII from user question using same patterns
    const redactedQuestion = redactUserQuestion(userQuestion);
    console.log(`📝 Original: "${userQuestion}"`);
    console.log(`📝 Redacted: "${redactedQuestion}"`);

    // ==================== SEMANTIC CACHING ====================
    // Step 1: Check if a similar question exists in cache (using redacted question)
    console.log("🔍 Checking semantic cache for similar questions...");
    const cachedAnswer = await getCachedResponse(redactedQuestion, reportData, 0.95);

    const data = new StreamData();

    if (cachedAnswer) {
        // Cache HIT - return cached response (but re-hydrate it first)
        console.log("✅ Cache HIT! Re-hydrating cached response");

        // Get vault for re-hydration
        const vault = await getVault(vaultId);
        const rehydratedAnswer = vault ? rehydrateText(cachedAnswer, vault) : cachedAnswer;

        data.append({
            retrievals: "[CACHED_RESPONSE]",
            cacheHit: true,
        });
        data.close();

        // Return re-hydrated cached response as stream
        const encoder = new TextEncoder();
        return new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(rehydratedAnswer));
                    controller.close();
                },
            }),
            {
                headers: {
                    "Content-Type": "text/plain; charset=utf-8",
                    "X-Cache": "HIT",
                },
            }
        );
    }

    // Cache MISS - run normal flow
    console.log("❌ Cache MISS. Running full inference pipeline...");
    const query = `Represent this for searching relevant passages: patient medical report says: \n${reportData}. \n\n${redactedQuestion}`;

    const retrievals = await queryPineconeVectorStore(pinecone, 'medic',  "diagnosis2", query);

    const finalPrompt = `Here is a summary of a patient's clinical report, and a user query. Some generic clinical findings are also provided that may or may not be relevant for the report.
  Go through the clinical report and answer the user query.
  Ensure the response is factually accurate, and demonstrates a thorough understanding of the query topic and the clinical report.
  Before answering you may enrich your knowledge by going through the provided clinical findings.
  The clinical findings are generic insights and not part of the patient's medical report. Do not include any clinical finding if it is not relevant for the patient's case.

  \n\n**Patient's Clinical report summary:** \n${reportData}.
  \n**end of patient's clinical report**

  \n\n**User Query:**\n${redactedQuestion}?
  \n**end of user query**

  \n\n**Generic Clinical findings:**
  \n\n${retrievals}.
  \n\n**end of generic clinical findings**

  \n\nProvide thorough justification for your answer.
  \n\n**Answer:**
  `;

    data.append({
        retrievals: retrievals,
        cacheHit: false,
    });

    let fullResponse = "";

    const result = await streamText({
        model: model,
        prompt: finalPrompt,
        onFinish() {
            data.close();
            // Cache the response after generation completes (cache redacted version)
            if (fullResponse) {
                cacheResponse(redactedQuestion, fullResponse, reportData);
            }
        }
    });

    // Capture the full response text
    const originalStream = result.toDataStreamResponse({ data });

    // We need to intercept and buffer the response to cache and re-hydrate it
    if (originalStream.body) {
        const reader = originalStream.body.getReader();
        const chunks: Uint8Array[] = [];

        const newStream = new ReadableStream({
            async start(controller) {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        controller.enqueue(value);
                    }
                    // Combine chunks into full response
                    const combined = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
                    let offset = 0;
                    for (const chunk of chunks) {
                        combined.set(chunk, offset);
                        offset += chunk.length;
                    }
                    const responseText = new TextDecoder().decode(combined);

                    // Store full response for caching
                    fullResponse = responseText;

                    // Re-hydrate the response with original PII
                    const vault = await getVault(vaultId);
                    if (vault) {
                        const rehydratedResponse = rehydrateText(responseText, vault);
                        console.log("🔄 Re-hydrated response with original PII");

                        // Replace the streamed content with re-hydrated version
                        // Note: This is a simplified approach - in production you'd want to re-stream
                        controller.enqueue(new TextEncoder().encode(rehydratedResponse));
                    }
                } finally {
                    controller.close();
                }
            },
        });

        return new Response(newStream, {
            headers: originalStream.headers,
        });
    }

    return originalStream;
}

